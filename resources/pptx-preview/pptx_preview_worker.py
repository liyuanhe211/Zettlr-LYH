# -*- coding: utf-8 -*-
"""Pandoc PPTX 实时预览的常驻转换工作进程（由 Zettlr 的 Electron 主进程 spawn）。

职责：通过 stdin/stdout 的 JSON Lines 协议接收“页块批次”，把 Markdown 页块经
Convert_Markdown_Deck.convert()（pandoc + 逐格样式后处理 + PowerPoint COM 溢出与
字号检测）转换成 PPTX，再用常驻的无窗口 PowerPoint 实例把每页导出为 PNG，返回
图片文件名与溢出 / 小字号报告。stdout 只输出协议行，所有日志走 stderr。

协议（每行一个 JSON 对象，UTF-8，ensure_ascii=False，每行输出后立即 flush）：

* 启动就绪后先输出一行 {"ready": true}。
* 请求 {"id": <int>, "action": "convert_batch",
        "chunks": [{"key": "<哈希串>", "text": "<页块 Markdown>",
                    "kind": "slide"|"metadata"}, ...],
        "cache_dir": "<绝对路径>", "width_pixels": 1600,
        "template_path": "<.potx 绝对路径，可省略>"}
  - template_path 给出本批渲染所用的 reference-doc 模板（由主进程从文档开头的
    Pandoc_PPTX_Configuration 注释读出，或取应用默认值）；省略或为空时用
    Convert_Markdown_Deck 自带的 TEMPLATE。该文件不存在时本批以失败回复。
  - 各 chunk 的 text 顺序拼接（相邻之间保证有空行分隔）写入
    <cache_dir>\\_work\\batch_<id>.md，转换为同名 .pptx。batch 第一个 chunk 为
    "slide" 类且其首个非空行是水平分割线（仅由 3 个及以上的 -、* 或 _ 构成的行）
    时，删去该行再写入（它只是页间分隔，开头出现会产生空页）；"metadata" 类
    chunk 由主进程保证单独成批，原样写入。
  - 产物页数 N 与 chunk 数 M 一致时一一对应；N != M 且 M == 1 时该 chunk 拥有
    全部 N 页。两种情形都把所属各页导出为 <cache_dir>\\<key>_<两位序号>.png，并
    为每个 chunk 写 sidecar 文件 <cache_dir>\\<key>.json：{"images": [文件名...],
    "overflow": [{"shape", "excess_pt"}...],
    "undersized": [{"shape", "size_pt", "snippet"}...]}，然后回复
    {"id", "ok": true, "ambiguous": false, "results": [{"key", "images",
    "overflow", "undersized"}...]}。
  - N != M 且 M > 1 时不导出，回复 {"id", "ok": true, "ambiguous": true,
    "slide_count": N}（主进程会对半拆批重发）。
  - 处理完删除 _work 下本批临时文件；失败时保留以便排查，路径写进错误信息。
  - 处理抛异常时回复 {"id", "ok": false, "error": "<一行摘要>"}，进程不退出。
* 请求 {"id", "action": "shutdown"}：回复 {"id", "ok": true}，Quit 真实
  PowerPoint 实例后退出；stdin 关闭（EOF）等同 shutdown。

无窗口常驻 PowerPoint：进程启动时给 win32com.client.DispatchEx 打进程内补丁，对
"PowerPoint.Application" 返回代理对象——底层真实例懒创建并缓存复用；代理的
Quit() 是空操作（真实例只在工作进程退出时 Quit）；代理的 Presentations.Open 把
WithWindow 参数强制为 False 再转发（实测 WithWindow=False 下 BoundHeight 溢出
检测结果与带窗口完全一致，且 application.Visible 为 0）；其余属性与方法全部透明
转发。COM 调用抛错时（实例可能已死）丢弃缓存实例、重建一次并把该批整轮重试
一次，仍失败才报错。其他 progid 原样放行。

自测：python pptx_preview_worker.py --self-test <输出目录>
不走 stdin，直接构造四批请求跑完整流程，打印每批耗时、回复与断言结果，并核实
application.Visible 全程为 0、结束后无新增 POWERPNT 进程残留。
"""

import ast
import contextlib
import io
import json
import os
import re
import subprocess
import sys
import time
import traceback

import pywintypes
import win32com.client
from pptx import Presentation

CONVERT_SCRIPT_DIRECTORY = os.path.join(
    os.environ["USERPROFILE"],
    r".claude\skills\PPT-Maker-NotesInTheScales-Pandoc\scripts")
sys.path.insert(0, CONVERT_SCRIPT_DIRECTORY)
import Convert_Markdown_Deck  # noqa: E402  (needs the sys.path insertion above)

# convert() reads the module global TEMPLATE at its pandoc step, so a batch can
# pick its own template by assigning to it. The value the script ships with is
# kept here as the fallback for batches that name no template of their own.
DEFAULT_TEMPLATE = Convert_Markdown_Deck.TEMPLATE

DEFAULT_WIDTH_PIXELS = 1600

OVERFLOW_LINE_PATTERN = re.compile(
    r"^\s*slide (\d+), (.*): exceeds the box by ([0-9.]+) pt\s*$")
UNDERSIZED_LINE_PATTERN = re.compile(
    r"^\s*slide (\d+), (.*?): ([0-9.]+) pt (['\"].*)$")
HORIZONTAL_RULE_PATTERN = re.compile(r"^\s*(-{3,}|\*{3,}|_{3,})\s*$")


def log(message):
    print(message, file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# Resident hidden PowerPoint instance and the DispatchEx patch
# ---------------------------------------------------------------------------

_original_dispatch_ex = win32com.client.DispatchEx
_cached_powerpoint_application = None


def get_powerpoint_application():
    """Return the cached real PowerPoint instance, creating it lazily."""
    global _cached_powerpoint_application
    if _cached_powerpoint_application is None:
        log("starting resident hidden PowerPoint instance")
        _cached_powerpoint_application = _original_dispatch_ex("PowerPoint.Application")
    return _cached_powerpoint_application


def quit_powerpoint_application():
    """Quit and drop the cached instance (best effort - it may already be dead)."""
    global _cached_powerpoint_application
    if _cached_powerpoint_application is not None:
        try:
            _cached_powerpoint_application.Quit()
            log("resident PowerPoint instance quit")
        except Exception as error:
            log("quitting resident PowerPoint instance failed (instance dropped anyway): %r" % (error,))
        _cached_powerpoint_application = None


class _PresentationsProxy:
    """Proxy of the Presentations collection: Open() forces WithWindow=False."""

    def __init__(self, real_presentations):
        object.__setattr__(self, "_real_presentations", real_presentations)

    def Open(self, FileName, ReadOnly=True, Untitled=False, WithWindow=True):
        return self._real_presentations.Open(FileName, ReadOnly, Untitled, False)

    def __getattr__(self, name):
        return getattr(self._real_presentations, name)


class _PowerPointApplicationProxy:
    """Proxy of PowerPoint.Application handed to Convert_Markdown_Deck.convert().

    The real instance is created lazily, cached and reused across batches;
    Quit() is a no-op (the real instance quits only when the worker exits);
    everything else is forwarded transparently."""

    def Quit(self):
        log("proxy Quit() ignored - resident PowerPoint instance kept alive")

    @property
    def Presentations(self):
        return _PresentationsProxy(get_powerpoint_application().Presentations)

    def __getattr__(self, name):
        return getattr(get_powerpoint_application(), name)


def _patched_dispatch_ex(program_id, *args, **keyword_arguments):
    if program_id == "PowerPoint.Application":
        return _PowerPointApplicationProxy()
    return _original_dispatch_ex(program_id, *args, **keyword_arguments)


win32com.client.DispatchEx = _patched_dispatch_ex


# ---------------------------------------------------------------------------
# Batch conversion
# ---------------------------------------------------------------------------

class BatchProcessingError(Exception):
    """A batch failed in a way already summarized into a one-line message."""


def condense_to_one_line(text, maximum_length=600):
    condensed = " | ".join(part.strip() for part in str(text).splitlines() if part.strip())
    if len(condensed) > maximum_length:
        condensed = condensed[:maximum_length] + "..."
    return condensed


def strip_leading_horizontal_rule(text):
    """Drop the first non-empty line if it is a Markdown horizontal rule."""
    lines = text.split("\n")
    for index, line in enumerate(lines):
        if not line.strip():
            continue
        if HORIZONTAL_RULE_PATTERN.match(line):
            del lines[index]
            return "\n".join(lines)
        break
    return text


def assemble_batch_markdown(chunks):
    """Concatenate chunk texts in order, guaranteeing a blank line between chunks."""
    assembled = ""
    for chunk_index, chunk in enumerate(chunks):
        text = chunk["text"]
        if chunk_index == 0 and chunk.get("kind") == "slide":
            text = strip_leading_horizontal_rule(text)
        if assembled:
            while not assembled.endswith("\n\n"):
                assembled += "\n"
        assembled += text
    if not assembled.endswith("\n"):
        assembled += "\n"
    return assembled


def run_convert(markdown_path, pptx_path):
    """Run Convert_Markdown_Deck.convert() capturing its report; return the report text."""
    captured_output = io.StringIO()
    try:
        with contextlib.redirect_stdout(captured_output):
            Convert_Markdown_Deck.convert(markdown_path, pptx_path, render=False)
    except SystemExit:
        # convert() sys.exit(1)s only on pandoc failure; the captured text holds pandoc stderr.
        raise BatchProcessingError("pandoc failed: " + condense_to_one_line(captured_output.getvalue()))
    return captured_output.getvalue()


def parse_detection_report(report_text):
    """Parse convert()'s step-4 report into per-slide overflow / undersized entries."""
    overflow_by_slide = {}
    undersized_by_slide = {}
    for line in report_text.splitlines():
        overflow_match = OVERFLOW_LINE_PATTERN.match(line)
        if overflow_match:
            slide_number = int(overflow_match.group(1))
            overflow_by_slide.setdefault(slide_number, []).append({
                "shape": overflow_match.group(2),
                "excess_pt": float(overflow_match.group(3)),
            })
            continue
        undersized_match = UNDERSIZED_LINE_PATTERN.match(line)
        if undersized_match:
            slide_number = int(undersized_match.group(1))
            snippet_representation = undersized_match.group(4)
            try:
                snippet = ast.literal_eval(snippet_representation)
            except (ValueError, SyntaxError):
                snippet = snippet_representation
            undersized_by_slide.setdefault(slide_number, []).append({
                "shape": undersized_match.group(2),
                "size_pt": float(undersized_match.group(3)),
                "snippet": snippet,
            })
    return overflow_by_slide, undersized_by_slide


def export_slides_as_png(pptx_path, export_plan, width_pixels):
    """Export slides listed in export_plan ([(slide_number, png_path), ...]) with the
    resident instance; height keeps the deck's aspect ratio (pages are 960 x 470 pt)."""
    application = get_powerpoint_application()
    presentation = application.Presentations.Open(pptx_path, True, False, False)
    try:
        slide_width = presentation.PageSetup.SlideWidth
        slide_height = presentation.PageSetup.SlideHeight
        height_pixels = int(round(width_pixels * slide_height / slide_width))
        for slide_number, png_path in export_plan:
            presentation.Slides(slide_number).Export(png_path, "PNG", width_pixels, height_pixels)
    finally:
        try:
            presentation.Close()
        except Exception as error:
            log("closing exported presentation failed: %r" % (error,))


def delete_batch_temporary_files(paths):
    for path in paths:
        try:
            if os.path.exists(path):
                os.remove(path)
        except OSError as error:
            log("could not delete temporary file %s: %s" % (path, error))


def process_convert_batch_once(request):
    request_id = request["id"]
    chunks = request["chunks"]
    cache_directory = request["cache_dir"]
    width_pixels = int(request.get("width_pixels", DEFAULT_WIDTH_PIXELS))
    template_path = request.get("template_path") or DEFAULT_TEMPLATE
    if not chunks:
        raise BatchProcessingError("convert_batch received an empty chunk list")
    if not os.path.isfile(template_path):
        raise BatchProcessingError("reference-doc template not found: " + template_path)
    # convert() reads this module global at its pandoc step; setting it per
    # batch is what makes a per-document template possible.
    Convert_Markdown_Deck.TEMPLATE = template_path

    work_directory = os.path.join(cache_directory, "_work")
    os.makedirs(work_directory, exist_ok=True)
    markdown_path = os.path.join(work_directory, "batch_%s.md" % request_id)
    pptx_path = os.path.join(work_directory, "batch_%s.pptx" % request_id)
    with open(markdown_path, "w", encoding="utf-8") as markdown_file:
        markdown_file.write(assemble_batch_markdown(chunks))

    report_text = run_convert(markdown_path, pptx_path)
    slide_count = len(Presentation(pptx_path).slides)
    chunk_count = len(chunks)

    if slide_count != chunk_count and chunk_count > 1:
        delete_batch_temporary_files([markdown_path, pptx_path])
        return {"id": request_id, "ok": True, "ambiguous": True, "slide_count": slide_count}

    if slide_count == chunk_count:
        owned_slide_numbers_per_chunk = [[chunk_index + 1] for chunk_index in range(chunk_count)]
    else:  # chunk_count == 1: the single chunk owns every slide
        owned_slide_numbers_per_chunk = [list(range(1, slide_count + 1))]

    overflow_by_slide, undersized_by_slide = parse_detection_report(report_text)
    export_plan = []
    results = []
    for chunk, owned_slide_numbers in zip(chunks, owned_slide_numbers_per_chunk):
        key = chunk["key"]
        image_file_names = []
        overflow_entries = []
        undersized_entries = []
        for page_offset, slide_number in enumerate(owned_slide_numbers):
            image_file_name = "%s_%02d.png" % (key, page_offset)
            image_file_names.append(image_file_name)
            export_plan.append((slide_number, os.path.join(cache_directory, image_file_name)))
            overflow_entries.extend(overflow_by_slide.get(slide_number, []))
            undersized_entries.extend(undersized_by_slide.get(slide_number, []))
        results.append({"key": key, "images": image_file_names,
                        "overflow": overflow_entries, "undersized": undersized_entries})

    export_slides_as_png(pptx_path, export_plan, width_pixels)

    for result in results:
        sidecar_path = os.path.join(cache_directory, result["key"] + ".json")
        with open(sidecar_path, "w", encoding="utf-8") as sidecar_file:
            json.dump({"images": result["images"], "overflow": result["overflow"],
                       "undersized": result["undersized"]},
                      sidecar_file, ensure_ascii=False)

    delete_batch_temporary_files([markdown_path, pptx_path])
    return {"id": request_id, "ok": True, "ambiguous": False, "results": results}


def process_convert_batch(request):
    """Run one batch; on a COM error discard the cached PowerPoint instance and
    retry the whole batch once (the instance may have died)."""
    try:
        return process_convert_batch_once(request)
    except pywintypes.com_error as error:
        log("COM error in batch %r: %r - discarding resident PowerPoint instance "
            "and retrying the whole batch once" % (request.get("id"), error))
        quit_powerpoint_application()
        return process_convert_batch_once(request)


def kept_temporary_file_paths(request):
    cache_directory = request.get("cache_dir")
    request_id = request.get("id")
    if not cache_directory or request_id is None:
        return []
    work_directory = os.path.join(cache_directory, "_work")
    candidates = [os.path.join(work_directory, "batch_%s%s" % (request_id, extension))
                  for extension in (".md", ".pptx", ".pptx.tmp")]
    return [path for path in candidates if os.path.exists(path)]


def handle_convert_batch(request):
    try:
        return process_convert_batch(request)
    except Exception as error:
        log(traceback.format_exc())
        if isinstance(error, BatchProcessingError):
            error_message = condense_to_one_line(error)
        else:
            error_message = condense_to_one_line("%s: %s" % (type(error).__name__, error))
        kept_paths = kept_temporary_file_paths(request)
        if kept_paths:
            error_message += " (temporary files kept for inspection: %s)" % ", ".join(kept_paths)
        return {"id": request.get("id"), "ok": False, "error": error_message}


# ---------------------------------------------------------------------------
# JSON Lines protocol loop
# ---------------------------------------------------------------------------

def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def serve_stdin():
    emit({"ready": True})
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError as error:
            log("discarding request line that is not valid JSON: %r" % (line[:200],))
            emit({"id": None, "ok": False, "error": "request line is not valid JSON: %s" % error})
            continue
        action = request.get("action")
        if action == "shutdown":
            emit({"id": request.get("id"), "ok": True})
            break
        if action == "convert_batch":
            emit(handle_convert_batch(request))
            continue
        emit({"id": request.get("id"), "ok": False, "error": "unknown action: %r" % (action,)})
    quit_powerpoint_application()


# ---------------------------------------------------------------------------
# Self test (--self-test <output directory>)
#
# The fixture texts and the sample image path live in the sibling module
# self_test_fixtures_Private.py, which is NOT under version control (the
# maintainer's personal material). The self test is a development aid only;
# without that module the worker's serving mode is unaffected.
# ---------------------------------------------------------------------------


def load_self_test_fixtures():
    try:
        import self_test_fixtures_Private
    except ImportError:
        log("self test requires self_test_fixtures_Private.py next to this script "
            "(not under version control); see the module docstring for its contents: "
            "SELF_TEST_IMAGE_PATH, PLAIN_TEXT_PAGE, FIRST_PAGE_WITH_LEADING_RULE, "
            "IMAGE_PAGE, CLOSING_TEXT_PAGE, OVERFLOW_PAGE, MIXED_TABLE_AND_TEXT_PAGE")
        sys.exit(2)
    return self_test_fixtures_Private


def list_powerpoint_process_ids():
    completed = subprocess.run(
        ["tasklist", "/FI", "IMAGENAME eq POWERPNT.EXE", "/FO", "CSV", "/NH"],
        capture_output=True, text=True)
    process_ids = []
    for line in (completed.stdout or "").splitlines():
        parts = [part.strip().strip('"') for part in line.split('","')]
        if len(parts) >= 2 and parts[0].upper() == "POWERPNT.EXE":
            process_ids.append(int(parts[1]))
    return process_ids


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def build_self_test_requests(output_directory):
    fixtures = load_self_test_fixtures()
    plain_text_page = fixtures.PLAIN_TEXT_PAGE
    first_page_with_leading_rule = fixtures.FIRST_PAGE_WITH_LEADING_RULE
    image_page = fixtures.IMAGE_PAGE
    closing_text_page = fixtures.CLOSING_TEXT_PAGE
    overflow_page = fixtures.OVERFLOW_PAGE
    mixed_table_and_text_page = fixtures.MIXED_TABLE_AND_TEXT_PAGE

    def build_request(request_id, chunks):
        return {"id": request_id, "action": "convert_batch", "chunks": chunks,
                "cache_dir": output_directory, "width_pixels": DEFAULT_WIDTH_PIXELS}

    return [
        ("single plain text page",
         build_request(1, [{"key": "selftest_text_page", "text": plain_text_page, "kind": "slide"}])),
        ("three chunks, one with an image, first chunk starts with a horizontal rule",
         build_request(2, [
             {"key": "selftest_batch2_first", "text": first_page_with_leading_rule, "kind": "slide"},
             {"key": "selftest_batch2_image", "text": image_page, "kind": "slide"},
             {"key": "selftest_batch2_last", "text": closing_text_page, "kind": "slide"}])),
        ("deliberately overflowing page",
         build_request(3, [{"key": "selftest_overflow_page", "text": overflow_page, "kind": "slide"}])),
        ("mixed table and text page that pandoc splits into two slides",
         build_request(4, [{"key": "selftest_mixed_split", "text": mixed_table_and_text_page, "kind": "slide"}])),
    ]


def run_self_test(output_directory):
    os.makedirs(output_directory, exist_ok=True)
    pre_existing_process_ids = set(list_powerpoint_process_ids())
    print("pre-existing POWERPNT process ids:", sorted(pre_existing_process_ids) or "none")

    responses = {}
    for description, request in build_self_test_requests(output_directory):
        start_time = time.perf_counter()
        response = process_convert_batch(request)
        elapsed_seconds = time.perf_counter() - start_time
        responses[request["id"]] = response
        print("batch %d (%s): %.2f s" % (request["id"], description, elapsed_seconds))
        print("  response:", json.dumps(response, ensure_ascii=False))
        visible_value = get_powerpoint_application().Visible
        log("after batch %d: application.Visible = %r" % (request["id"], visible_value))
        require(int(visible_value) == 0,
                "application.Visible is %r after batch %d, expected 0" % (visible_value, request["id"]))

    def result_of(batch_id, expected_result_count):
        response = responses[batch_id]
        require(response.get("ok") is True, "batch %d not ok: %r" % (batch_id, response))
        require(response.get("ambiguous") is False, "batch %d unexpectedly ambiguous: %r" % (batch_id, response))
        require(len(response["results"]) == expected_result_count,
                "batch %d expected %d results, got %r" % (batch_id, expected_result_count, response))
        return response["results"]

    def require_output_files(result):
        for image_file_name in result["images"]:
            image_path = os.path.join(output_directory, image_file_name)
            require(os.path.isfile(image_path), "missing exported image %s" % image_path)
        sidecar_path = os.path.join(output_directory, result["key"] + ".json")
        require(os.path.isfile(sidecar_path), "missing sidecar %s" % sidecar_path)

    batch1_results = result_of(1, 1)
    require(batch1_results[0]["images"] == ["selftest_text_page_00.png"],
            "batch 1 images unexpected: %r" % (batch1_results[0]["images"],))
    require_output_files(batch1_results[0])

    batch2_results = result_of(2, 3)  # ambiguous=False also proves the leading rule was stripped
    for result in batch2_results:
        require(len(result["images"]) == 1, "batch 2 chunk %s expected 1 image" % result["key"])
        require_output_files(result)

    batch3_results = result_of(3, 1)
    require(len(batch3_results[0]["overflow"]) > 0, "batch 3 expected a non-empty overflow report")
    require_output_files(batch3_results[0])

    batch4_results = result_of(4, 1)
    require(len(batch4_results[0]["images"]) == 2,
            "batch 4 expected 2 images, got %r" % (batch4_results[0]["images"],))
    require_output_files(batch4_results[0])

    print("all self-test assertions passed")

    quit_powerpoint_application()
    deadline = time.monotonic() + 10
    while True:
        residual_process_ids = set(list_powerpoint_process_ids()) - pre_existing_process_ids
        if not residual_process_ids or time.monotonic() > deadline:
            break
        time.sleep(0.5)
    require(not residual_process_ids,
            "POWERPNT processes left behind: %s" % sorted(residual_process_ids))
    print("no residual POWERPNT process after quit")


if __name__ == "__main__":
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    if len(sys.argv) >= 2 and sys.argv[1] == "--self-test":
        if len(sys.argv) < 3:
            log("usage: python pptx_preview_worker.py --self-test <output directory>")
            sys.exit(2)
        run_self_test(sys.argv[2])
    else:
        serve_stdin()
