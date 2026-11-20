/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Standalone HTML export helpers
 * CVM-Role:        Utility Functions
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Environment-independent parts of the "Export to HTML"
 *                  feature: the stylesheet that imitates the main editor's
 *                  rendered display, the assembly of the complete HTML
 *                  document, and the embedding of local images as data URIs.
 *                  The renderer supplies the converted body and the current
 *                  theme values; the main process embeds the images and, for
 *                  local images that cannot be embedded, supplies the link
 *                  written in their place (via a callback, so that this file
 *                  stays free of Node modules).
 *
 * END HEADER
 */

import { highlightTree } from '@lezer/highlight'
import { EditorState, type ChangeSpec, type Extension } from '@codemirror/state'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import markdownParser, { type MarkdownParserConfig } from '../markdown-editor/parser/markdown-parser'
import { tagHighlight } from '../markdown-editor/theme/syntax'
import {
  acceptAllRevisions,
  findRevisionsInTree,
  type RevisionKind,
  type RevisionRange
} from '../markdown-editor/revisions/revision-model'

/**
 * Written into every exported document; the main process only overwrites an
 * existing HTML file if it carries this marker.
 */
export const EXPORT_HTML_GENERATOR_MARKER = 'Zettlr-LYH Export to HTML'

/**
 * The CSS custom properties of the editor theme (--zettlr-editor-*), plus the
 * resolved --export-* values read from the editor's scroller.
 */
export type EditorThemeVariables = Record<string, string>

export interface StandaloneHTMLOptions {
  /** The document title, shown in the browser's tab */
  title: string
  /** The rendered and sanitized document body */
  bodyHTML: string
  /** The theme variables currently active in the editor */
  themeVariables: EditorThemeVariables
  /** Whether the editor currently displays the dark theme */
  darkMode: boolean
  /** Additional stylesheets, such as the KaTeX rules */
  extraStylesheets: string[]
  /**
   * The width in pixels of the editor's text column at the moment of the
   * export. The exported text column opens at this width, which the reader can
   * then change by dragging its edges. Without a value the column falls back
   * to 47em.
   */
  contentWidthPx?: number
}

const IMAGE_MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  tif: 'image/tiff',
  tiff: 'image/tiff'
}

/**
 * Escapes the characters that are special in HTML text and attribute values.
 */
export function escapeHTML (text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Reverses the entity escaping that the DOM applies to attribute values.
 */
function decodeAttributeValue (value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/**
 * Returns the MIME type for an image path, or undefined for unknown formats.
 */
export function imageMimeType (imagePath: string): string|undefined {
  const match = /\.([a-z0-9]+)$/i.exec(imagePath.replace(/[?#].*$/, ''))
  return match !== null ? IMAGE_MIME_TYPES[match[1].toLowerCase()] : undefined
}

/**
 * Replaces the src attribute of every image that points to a local file by a
 * data URI holding the file's contents. A local image that cannot be embedded
 * (its format is unknown, or the file cannot be read) is reported in
 * failedSources; if linkFailedImage is given and returns a string for it, its
 * src is replaced by that string (HTML-escaped), otherwise it keeps its
 * original source. Images for which resolveSource returns undefined (remote or
 * already embedded sources) are never passed to linkFailedImage and never
 * changed. Each distinct src is resolved, read, and linked only once.
 *
 * @param   {string}    html             The HTML document
 * @param   {Function}  resolveSource    Maps a src value to an absolute local
 *                                       path, or undefined for remote sources
 * @param   {Function}  readFile         Reads a file's bytes
 * @param   {Function}  linkFailedImage  Optional: receives the (entity-decoded)
 *                                       src and the absolute path of a local
 *                                       image that could not be embedded, and
 *                                       returns the src to write instead, or
 *                                       undefined to keep the original one
 *
 * @return  {Promise}                    The new HTML, the number of embedded
 *                                       images, the number of images whose
 *                                       src was replaced by linkFailedImage
 *                                       (both counted per occurrence), and the
 *                                       sources that could not be embedded
 */
export async function inlineLocalImages (
  html: string,
  resolveSource: (source: string) => string|undefined,
  readFile: (absolutePath: string) => Promise<Uint8Array>,
  linkFailedImage?: (source: string, absolutePath: string) => string|undefined
): Promise<{ html: string, inlinedCount: number, linkedCount: number, failedSources: string[] }> {
  const pattern = /(<img\b[^>]*?\ssrc=")([^"]*)(")/gi
  // Per raw src: the new attribute value and whether it is an embedded data
  // URI (rather than a link), or undefined to keep the original src
  const replacements = new Map<string, { value: string, embedded: boolean }|undefined>()
  const failedSources: string[] = []

  for (const match of html.matchAll(pattern)) {
    const rawSource = match[2]
    if (replacements.has(rawSource)) {
      continue
    }

    const source = decodeAttributeValue(rawSource)
    const absolutePath = resolveSource(source)
    if (absolutePath === undefined) {
      replacements.set(rawSource, undefined)
      continue
    }

    const mimeType = imageMimeType(absolutePath)
    if (mimeType !== undefined) {
      try {
        const bytes = await readFile(absolutePath)
        replacements.set(rawSource, {
          value: `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`,
          embedded: true
        })
        continue
      } catch {
        // The image cannot be read; it is handled as not embeddable below
      }
    }

    failedSources.push(source)
    const link = linkFailedImage !== undefined ? linkFailedImage(source, absolutePath) : undefined
    replacements.set(rawSource, typeof link === 'string' ? { value: escapeHTML(link), embedded: false } : undefined)
  }

  let inlinedCount = 0
  let linkedCount = 0
  const result = html.replace(pattern, (whole, before: string, rawSource: string, after: string) => {
    const replacement = replacements.get(rawSource)
    if (replacement === undefined) {
      return whole
    }
    if (replacement.embedded) {
      inlinedCount++
    } else {
      linkedCount++
    }
    return `${before}${replacement.value}${after}`
  })

  return { html: result, inlinedCount, linkedCount, failedSources }
}

/**
 * Normalizes line endings the way an HTML parser does.
 */
function normalizeLineEndings (text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/**
 * Highlights every fenced code block of a Markdown document with the same
 * parser and the same tag-to-class mapping as the editor, so that the editor's
 * code colors can be applied to the exported blocks.
 *
 * @param   {string}  markdown  The Markdown source
 * @param   {MarkdownParserConfig}  config  The parser configuration
 *
 * @return  {Array}             Per code block, in document order: its plain
 *                              text and its highlighted HTML
 */
export function highlightFencedCodeBlocks (markdown: string, config?: MarkdownParserConfig): Array<{ text: string, html: string }> {
  const tree = markdownParser(config).language.parser.parse(markdown)
  const blocks: Array<{ text: string, html: string }> = []

  tree.iterate({
    enter (node) {
      if (node.name !== 'FencedCode') {
        return undefined
      }

      const codeText = node.node.getChild('CodeText')
      if (codeText === null) {
        return false
      }

      let html = ''
      let position = codeText.from
      highlightTree(tree, tagHighlight, (from, to, classes) => {
        if (from > position) {
          html += escapeHTML(markdown.slice(position, from))
        }
        html += `<span class="${classes}">${escapeHTML(markdown.slice(from, to))}</span>`
        position = to
      }, codeText.from, codeText.to)

      if (position < codeText.to) {
        html += escapeHTML(markdown.slice(position, codeText.to))
      }

      blocks.push({
        text: normalizeLineEndings(markdown.slice(codeText.from, codeText.to)),
        html: normalizeLineEndings(html)
      })
      return false
    }
  })

  return blocks
}

/**
 * Replaces the contents of the document's code blocks with their highlighted
 * versions. A block is only replaced if its text matches the next highlighted
 * block, so blocks the converter treated differently are left as they are.
 *
 * @param   {ParentNode}  container  The converted document
 * @param   {Array}       blocks     The result of highlightFencedCodeBlocks
 */
export function applyCodeHighlighting (container: ParentNode, blocks: Array<{ text: string, html: string }>): void {
  let next = 0
  for (const code of Array.from(container.querySelectorAll('pre > code'))) {
    const text = normalizeLineEndings(code.textContent ?? '')
    const index = blocks.findIndex((block, i) => i >= next && block.text === text)
    if (index < 0) {
      continue
    }
    code.innerHTML = blocks[index].html
    next = index + 1
  }
}

const NO_LINE_BREAK_ANCESTORS = 'pre, code, script, style, svg, math, textarea, .katex, .html-block-preview, .mermaid-chart'

// Elements whose children are running text, so that a line break between two
// of their child elements is a line break of the text
const INLINE_CONTENT_PARENTS = 'p, h1, h2, h3, h4, h5, h6, td, th, dt, a, abbr, b, cite, del, em, i, ins, mark, q, s, small, span, strong, sub, sup, u'

// Block children that make a list item a container of blocks rather than a
// line of running text
const BLOCK_CHILDREN = ':scope > :is(p, ul, ol, dl, div, blockquote, pre, table, figure, h1, h2, h3, h4, h5, h6, hr)'

/**
 * Whether a whitespace-only text node with a line break separates two inline
 * elements of the same line of running text, e.g. the line break between an
 * image and a caption line starting with bold text.
 *
 * @param   {Text}     text  The whitespace-only text node
 *
 * @return  {boolean}        True if the line break belongs to running text
 */
function isLineBreakBetweenInlineElements (text: Text): boolean {
  const parent = text.parentElement
  if (parent === null || text.previousSibling === null || text.nextSibling === null) {
    return false
  }

  if (parent.matches(INLINE_CONTENT_PARENTS)) {
    return true
  }

  return parent.nodeName === 'LI' && parent.querySelector(BLOCK_CHILDREN) === null
}

/**
 * The editor shows every line of a paragraph on a line of its own, whereas
 * HTML joins them. This turns the soft line breaks inside running text into
 * <br> elements, including a line break that is the only text between two
 * inline elements (an image line followed by a line starting with bold text).
 * Whitespace between block elements is left alone.
 *
 * @param   {Document}  container  The converted document
 */
export function convertSoftLineBreaks (container: Document): void {
  const walker = container.createTreeWalker(container.body, 0x4 /* NodeFilter.SHOW_TEXT */)
  const textNodes: Text[] = []
  const lineBreaksBetweenElements: Text[] = []
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node as Text
    if (!text.data.includes('\n')) {
      continue
    }
    if (text.parentElement?.closest(NO_LINE_BREAK_ANCESTORS) != null) {
      continue
    }
    if (text.data.trim() !== '') {
      textNodes.push(text)
    } else if (isLineBreakBetweenInlineElements(text)) {
      lineBreaksBetweenElements.push(text)
    }
  }

  for (const text of lineBreaksBetweenElements) {
    text.replaceWith(container.createElement('br'))
  }

  for (const text of textNodes) {
    const parts = text.data.split(/[ \t]*\r?\n\s*/)
    const hasContentBefore = text.previousSibling !== null
    const hasContentAfter = text.nextSibling !== null
    const fragment = container.createDocumentFragment()

    parts.forEach((part, index) => {
      if (index > 0) {
        const before = hasContentBefore || parts.slice(0, index).some(previous => previous.trim() !== '')
        const after = hasContentAfter || parts.slice(index).some(following => following.trim() !== '')
        fragment.appendChild(before && after ? container.createElement('br') : container.createTextNode(' '))
      }
      if (part !== '') {
        fragment.appendChild(container.createTextNode(part))
      }
    })

    text.replaceWith(fragment)
  }
}

/**
 * Bracketed text that is not a link, such as citation numbers like [27,N1],
 * keeps its brackets in the editor, drawn in the code font. This wraps the two
 * brackets so the stylesheet can do the same.
 *
 * @param   {Document}  container  The converted document
 */
export function markBracketLinkMarks (container: Document): void {
  for (const span of Array.from(container.querySelectorAll('span.link'))) {
    const TEXT_NODE = 3
    if (span.firstChild?.nodeType !== TEXT_NODE || span.lastChild?.nodeType !== TEXT_NODE) {
      continue
    }
    const first = span.firstChild as Text
    const last = span.lastChild as Text
    if (!first.data.startsWith('[') || !last.data.endsWith(']')) {
      continue
    }

    const open = container.createElement('span')
    open.className = 'link-mark'
    open.textContent = '['
    const close = container.createElement('span')
    close.className = 'link-mark'
    close.textContent = ']'

    if (first === last) {
      first.data = first.data.slice(1, -1)
    } else {
      first.data = first.data.slice(1)
      last.data = last.data.slice(0, -1)
    }
    span.insertBefore(open, span.firstChild)
    span.appendChild(close)
  }
}

/**
 * The editor centers lines that hold nothing but images. This marks the
 * top-level paragraphs that consist of images and whitespace only, so the
 * stylesheet can center them as well. Paragraphs inside lists, blockquotes,
 * and HTML blocks are left alone, as in the editor.
 *
 * @param   {Document}  container  The converted document
 */
export function markImageOnlyParagraphs (container: Document): void {
  const TEXT_NODE = 3
  for (const paragraph of Array.from(container.body.children)) {
    if (paragraph.nodeName !== 'P') {
      continue
    }

    const children = Array.from(paragraph.childNodes)
    const imagesOnly = children.every(child => child.nodeName === 'IMG' || (child.nodeType === TEXT_NODE && (child.textContent ?? '').trim() === ''))

    if (imagesOnly && children.some(child => child.nodeName === 'IMG')) {
      paragraph.classList.add('image-paragraph')
    }
  }
}

/**
 * Returns the CSS size of a Pandoc size attribute by the rule of the editor
 * (normalizeSize in render-images.ts), or undefined if the editor does not
 * recognize it (e.g. `1\textwidth`).
 *
 * @param   {string|null}       value  The attribute value
 *
 * @return  {string|undefined}         The size in lowercase, or undefined
 */
function cssSizeOf (value: string|null): string|undefined {
  if (value === null || !/[\d.]+(?:cm|mm|in|px|pt|pc|em|ex|ch|rem|vw|vh|vmin|vmax|%)/i.test(value)) {
    return undefined
  }
  return value.toLowerCase()
}

/**
 * Sizes the images with Pandoc size attributes (`{width=50%}`, `{w=8cm}`,
 * `{height=5cm}`) as the editor does (applySizeStyles in render-images.ts),
 * since the HTML width and height attributes accept neither units such as cm
 * nor the short names w and h. With a width, the image takes that width
 * without a height limit, and its height follows the given height or the
 * aspect ratio. With only a height, the height limits the image. Images in
 * HTML blocks keep their own sizes, as in the editor.
 *
 * @param   {ParentNode}  container  The converted document
 */
export function applyImageSizeAttributes (container: ParentNode): void {
  for (const image of Array.from(container.querySelectorAll<HTMLImageElement>('img'))) {
    if (image.closest('.html-block-preview') !== null) {
      continue
    }

    const width = cssSizeOf(image.getAttribute('width') ?? image.getAttribute('w'))
    const height = cssSizeOf(image.getAttribute('height') ?? image.getAttribute('h'))
    if (width !== undefined) {
      image.style.width = width
      image.style.height = height ?? 'auto'
      image.style.maxHeight = 'none'
    } else if (height !== undefined) {
      image.style.maxHeight = height
    }
  }
}

/**
 * Makes the task list checkboxes look like the editor's (enabled rather than
 * greyed out), while keeping them read-only.
 *
 * @param   {ParentNode}  container  The converted document
 */
export function enableTaskCheckboxes (container: ParentNode): void {
  for (const checkbox of Array.from(container.querySelectorAll('li > input[type="checkbox"]'))) {
    checkbox.removeAttribute('disabled')
    checkbox.setAttribute('onclick', 'return false')
  }
}

/**
 * The author and time of one tracked change, as recorded in its attribute
 * block.
 */
export interface ExportedRevision {
  kind: RevisionKind
  author: string|undefined
  date: string|undefined
}

/**
 * The attribute that numbers the revision spans of the Markdown handed to the
 * HTML conversion. DOMPurify keeps data attributes, but would drop the
 * author and date attributes of the original spans.
 */
const REVISION_INDEX_ATTRIBUTE = 'data-revision'

/**
 * Time budget (milliseconds) for parsing the document when its revisions are
 * prepared for the HTML export
 */
const REVISION_PARSE_TIMEOUT = 10000

/**
 * Whether a Markdown text may contain tracked changes at all. Texts without
 * the class names are passed on without parsing them.
 *
 * @param   {string}   markdown  The Markdown text
 *
 * @return  {boolean}            False if the text certainly has no revision
 */
export function mayContainRevisions (markdown: string): boolean {
  return markdown.includes('.insertion') || markdown.includes('.deletion')
}

/**
 * Prepares the Markdown of a document for Export to HTML (spec C10, export
 * item 2). With Show Revisions off, the text with all revisions accepted is
 * returned. With Show Revisions on, the attribute block of every revision
 * (including the inner insertion of a nested deletion) is replaced by its
 * class and a running number, and the author and time of each revision are
 * returned under that number, for convertRevisionSpans.
 *
 * @param   {string}   markdown       The Markdown text of the document
 * @param   {boolean}  showRevisions  The setting display.showRevisions
 *
 * @return  {{ markdown: string, revisions: ExportedRevision[] }}  The text to
 *                                    convert and the numbered revisions
 */
export function prepareRevisionsForHTMLExport (markdown: string, showRevisions: boolean): { markdown: string, revisions: ExportedRevision[] } {
  if (!mayContainRevisions(markdown)) {
    return { markdown, revisions: [] }
  }

  if (!showRevisions) {
    return { markdown: acceptAllRevisions(markdown), revisions: [] }
  }

  const extensions: Extension[] = [markdownParser()]
  if (markdown.includes('\r\n')) {
    extensions.push(EditorState.lineSeparator.of('\r\n'))
  }
  const state = EditorState.create({ doc: markdown, extensions })
  const tree = ensureSyntaxTree(state, state.doc.length, REVISION_PARSE_TIMEOUT) ?? syntaxTree(state)

  const revisions: ExportedRevision[] = []
  const changes: ChangeSpec[] = []
  const numberRevision = (revision: RevisionRange): void => {
    // The attribute block starts at the opening brace after the closing bracket
    const tail = state.sliceDoc(revision.contentTo, revision.to)
    const braceOffset = tail.indexOf('{')
    if (braceOffset < 0) {
      return
    }

    changes.push({
      from: revision.contentTo + braceOffset,
      to: revision.to,
      insert: `{.${revision.kind} ${REVISION_INDEX_ATTRIBUTE}="${revisions.length}"}`
    })
    revisions.push({ kind: revision.kind, author: revision.author, date: revision.date })
  }

  for (const revision of findRevisionsInTree(state, tree, 0, state.doc.length)) {
    if (revision.nested !== undefined) {
      numberRevision(revision.nested)
    }
    numberRevision(revision)
  }

  if (changes.length === 0) {
    return { markdown, revisions: [] }
  }

  return { markdown: state.update({ changes }).state.sliceDoc(), revisions }
}

/**
 * Formats the tooltip of an exported revision: "Inserted by <author> on
 * <local date> <local time>" or "Deleted by …". A missing author is written as
 * "Unknown author"; a missing date is left out, and a date that cannot be read
 * is shown as written.
 *
 * @param   {ExportedRevision}  revision  The revision
 *
 * @return  {string}                      The tooltip text
 */
export function formatRevisionTitle (revision: ExportedRevision): string {
  const action = revision.kind === 'insertion' ? 'Inserted' : 'Deleted'
  const author = revision.author !== undefined && revision.author.trim() !== '' ? revision.author : 'Unknown author'
  const title = `${action} by ${author}`

  if (revision.date === undefined || revision.date.trim() === '') {
    return title
  }

  const time = new Date(revision.date)
  if (Number.isNaN(time.getTime())) {
    return `${title} on ${revision.date}`
  }

  const pad = (value: number): string => String(value).padStart(2, '0')
  const localDate = `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}`
  const localTime = `${pad(time.getHours())}:${pad(time.getMinutes())}`
  return `${title} on ${localDate} ${localTime}`
}

/**
 * Replaces the numbered revision spans produced from prepareRevisionsForHTMLExport
 * by <ins> and <del> elements whose title names the author and time, styled by
 * the classes revision-insertion and revision-deletion.
 *
 * @param   {Document}            container  The converted document
 * @param   {ExportedRevision[]}  revisions  The revisions, by their number
 */
export function convertRevisionSpans (container: Document, revisions: ExportedRevision[]): void {
  for (const span of Array.from(container.querySelectorAll(`span[${REVISION_INDEX_ATTRIBUTE}]`))) {
    const index = Number(span.getAttribute(REVISION_INDEX_ATTRIBUTE))
    const revision = Number.isInteger(index) ? revisions[index] : undefined
    if (revision === undefined || !span.classList.contains(revision.kind)) {
      span.removeAttribute(REVISION_INDEX_ATTRIBUTE)
      continue
    }

    const element = container.createElement(revision.kind === 'insertion' ? 'ins' : 'del')
    element.className = `revision-${revision.kind}`
    element.setAttribute('title', formatRevisionTitle(revision))
    while (span.firstChild !== null) {
      element.appendChild(span.firstChild)
    }
    span.replaceWith(element)
  }
}

/**
 * Renders the theme variables as the declarations of a :root rule. Values
 * that could break out of the style element are dropped.
 */
function renderThemeVariables (variables: EditorThemeVariables): string {
  return Object.entries(variables)
    .filter(([ name, value ]) => /^--[a-z0-9-]+$/i.test(name) && !/[<>{};]/.test(value))
    .map(([ name, value ]) => `  ${name}: ${value};`)
    .join('\n')
}

/**
 * Returns the stylesheet that imitates the main editor's rendered display.
 */
export function getExportStylesheet (): string {
  return EXPORT_STYLESHEET
}

/**
 * Assembles the complete, self-contained HTML document.
 */
export function buildStandaloneHTMLDocument (options: StandaloneHTMLOptions): string {
  const colorScheme = options.darkMode ? 'dark' : 'light'
  const contentWidth = options.contentWidthPx
  const widthDeclaration = contentWidth !== undefined && Number.isFinite(contentWidth) && contentWidth > 0
    ? `\n  --export-content-width: ${Math.round(contentWidth)}px;`
    : ''
  const styles = [
    `:root {\n  color-scheme: ${colorScheme};${widthDeclaration}\n${renderThemeVariables(options.themeVariables)}\n}`,
    getExportStylesheet(),
    ...options.extraStylesheets.filter(sheet => sheet.trim() !== '')
  ].map(sheet => sheet.replace(/<\/style/gi, '<\\/style'))

  return [
    '<!DOCTYPE html>',
    `<html class="${colorScheme}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta name="generator" content="${EXPORT_HTML_GENERATOR_MARKER}">`,
    `<title>${escapeHTML(options.title)}</title>`,
    ...styles.map(sheet => `<style>\n${sheet}\n</style>`),
    '</head>',
    '<body>',
    '<main id="document">',
    options.bodyHTML,
    '</main>',
    `<script>\n${EXPORT_WIDTH_SCRIPT}\n</script>`,
    `<script>\n${EXPORT_IMAGE_SIZE_SCRIPT}\n</script>`,
    '</body>',
    '</html>',
    ''
  ].join('\n')
}

// Lets the reader change the width of the text column by dragging either edge
// of it. The column stays centered, so the width changes by twice the distance
// the pointer moves. A double-click on an edge restores the width the document
// was exported with. The handles are fixed strips appended to the body rather
// than children of #document, so that they neither scroll out of reach nor
// disturb the :last-child rules of the document.
const EXPORT_WIDTH_SCRIPT = `(function () {
  'use strict'
  var root = document.documentElement
  var page = document.getElementById('document')
  if (page === null) {
    return
  }
  var MIN_WIDTH = 160
  var HALF_HANDLE = 6

  function paddingOf (element) {
    var style = getComputedStyle(element)
    return parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
  }

  var handles = [ 'left', 'right' ].map(function (side) {
    var handle = document.createElement('div')
    handle.className = 'export-width-handle export-width-handle-' + side
    handle.title = 'Drag to change the text width. Double-click to restore the exported width.'
    handle.setAttribute('aria-hidden', 'true')
    handle.addEventListener('pointerdown', function (event) { startDrag(event, side, handle) })
    handle.addEventListener('dblclick', function () {
      root.style.removeProperty('--export-content-width')
      place()
    })
    document.body.appendChild(handle)
    return handle
  })

  function place () {
    var rect = page.getBoundingClientRect()
    handles[0].style.left = (rect.left - HALF_HANDLE) + 'px'
    handles[1].style.left = (rect.right - HALF_HANDLE) + 'px'
  }

  function startDrag (event, side, handle) {
    if (event.button !== 0) {
      return
    }
    event.preventDefault()
    var padding = paddingOf(page)
    var startX = event.clientX
    var startWidth = page.clientWidth - padding
    var direction = side === 'right' ? 2 : -2
    handle.setPointerCapture(event.pointerId)
    root.classList.add('export-width-dragging')

    function move (moveEvent) {
      var maxWidth = Math.max(MIN_WIDTH, root.clientWidth - padding)
      var width = Math.min(maxWidth, Math.max(MIN_WIDTH, startWidth + (moveEvent.clientX - startX) * direction))
      root.style.setProperty('--export-content-width', Math.round(width) + 'px')
      place()
    }

    function end () {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', end)
      handle.removeEventListener('pointercancel', end)
      root.classList.remove('export-width-dragging')
    }

    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }

  window.addEventListener('resize', place)
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(place).observe(page)
  }
  place()
})()`

// Sizes the images without a width or height attribute as the editor does
// (applyAutomaticSizeLimits in render-images.ts): at their natural size in
// device pixels, so that the display scaling of the screen does not enlarge
// them, scaled down to the width of the text column and to 80% of the window
// height. Images in HTML blocks keep their own sizes, as in the editor.
const EXPORT_IMAGE_SIZE_SCRIPT = `(function () {
  'use strict'
  var SIZE_ATTRIBUTES = [ 'width', 'height', 'w', 'h' ]

  function isAutomaticallySized (image) {
    if (image.closest('.html-block-preview') !== null) {
      return false
    }
    return SIZE_ATTRIBUTES.every(function (name) { return !image.hasAttribute(name) })
  }

  function limit (image) {
    var pixelRatio = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1
    if (image.naturalWidth > 0) {
      image.style.maxWidth = 'min(100%, ' + Math.floor(image.naturalWidth * 1000 / pixelRatio) / 1000 + 'px)'
    }
    if (image.naturalHeight > 0) {
      image.style.maxHeight = 'min(80vh, ' + Math.floor(image.naturalHeight * 1000 / pixelRatio) / 1000 + 'px)'
    }
  }

  var images = Array.prototype.filter.call(document.querySelectorAll('#document img'), isAutomaticallySized)
  images.forEach(function (image) {
    if (image.complete) {
      limit(image)
    }
    image.addEventListener('load', function () { limit(image) })
  })

  // A different screen or browser zoom changes the device pixel ratio
  window.addEventListener('resize', function () { images.forEach(limit) })
})()`

// The values follow the main editor's rendered display (theme/editor.ts,
// MainEditor.vue, the renderers, and the table editor). Unlike the editor, the
// text column is limited in width, and the blank lines between blocks become
// margins of one line height.
const EXPORT_STYLESHEET = `
:root {
  /* The size the document is actually rendered at. It follows the editor font
  size the export was made with, except on narrow screens, where the media
  query below caps it so that a phone still gets a readable number of
  characters per line. Everything that scales with the text (the line height
  used for block margins, the footnote markers) refers to this value, not to
  --export-font-size, so that the whole document shrinks together. */
  --export-rendered-font-size: var(--export-font-size, 18px);
  --export-line: calc(var(--zettlr-editor-line-height, 1.4) * var(--export-rendered-font-size));
  --export-table-cell-min-width: 96px;
  --export-document-padding: 50px;
  --export-table-color: #3a3a3a;
  --export-table-border: #bdbdbd;
}

html.dark {
  --export-table-color: #d6d6d6;
  --export-table-border: #4a4a4a;
}

* {
  box-sizing: border-box;
}

html {
  background-color: var(--export-background-color, var(--zettlr-editor-scroller-bg));
  /* Mobile browsers otherwise enlarge the text of their own accord when the
  phone is turned to landscape, which breaks the proportions of the export */
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}

body {
  margin: 0;
  background-color: var(--export-background-color, var(--zettlr-editor-scroller-bg));
  color: var(--export-text-color, var(--zettlr-editor-scroller-color));
  font-family: var(--zettlr-editor-font);
  font-size: var(--export-rendered-font-size);
  line-height: var(--zettlr-editor-line-height, 1.4);
}

/* The text column opens at the width of the editor's text column at the moment
of the export (--export-content-width, written into the :root rule), and the
reader can change it by dragging its edges (the script at the end of the body).
It never grows wider than the window. */
#document {
  width: calc(var(--export-content-width, 47em) + 2 * var(--export-document-padding));
  max-width: 100%;
  margin: 0 auto;
  padding: var(--export-document-padding);
  overflow-wrap: break-word;
}

/* The drag handles on both edges of the text column. A thin line in the
primary color appears while the pointer is over a handle or dragging it. */
.export-width-handle {
  position: fixed;
  top: 0;
  bottom: 0;
  width: 12px;
  cursor: ew-resize;
  touch-action: none;
  z-index: 10;
}

.export-width-handle::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 5px;
  width: 2px;
  background-color: var(--zettlr-editor-primary-color);
  opacity: 0;
  transition: opacity 0.15s;
}

.export-width-handle:hover::after, html.export-width-dragging .export-width-handle::after {
  opacity: 0.5;
}

html.export-width-dragging, html.export-width-dragging * {
  cursor: ew-resize !important;
  user-select: none;
}

/* Running text is justified, as in the editor */
#document :is(p:not(.image-paragraph), li, blockquote, dd, #footnote-container) {
  text-align: justify;
}

/* Paragraphs holding nothing but images are centered, as in the editor */
#document p.image-paragraph {
  text-align: center;
}

/* Bracketed text without a link target, e.g. citation numbers like [27,N1] */
#document span.link {
  color: var(--zettlr-editor-primary-color);
  text-decoration: var(--zettlr-editor-line-decoration, none);
}

#document span.link > .link-mark {
  font-family: var(--zettlr-editor-code-font);
  color: var(--export-text-color, var(--zettlr-editor-scroller-color));
}

/* Phones and other narrow screens. The exported document carries the editor
font size of the moment it was made, which may be far larger than a phone can
accommodate (an editor zoomed to 28px leaves eight Chinese characters per line
on a 375px screen), so the rendered size is capped at the 18px default here; a
smaller editor font is kept as it is. Justified text is given up at this width,
because the short lines would be torn apart by the gaps. */
@media (max-width: 700px) {
  :root {
    --export-rendered-font-size: min(var(--export-font-size, 18px), 18px);
    --export-table-cell-min-width: 64px;
    --export-document-padding: 20px;
  }

  #document :is(p:not(.image-paragraph), li, blockquote, dd, #footnote-container) {
    text-align: left;
  }

  /* The column fills a phone's screen anyway; dragging is left out there */
  .export-width-handle {
    display: none;
  }
}

@media (max-width: 480px) {
  :root {
    --export-document-padding: 14px;
  }
}

::selection {
  background: var(--zettlr-editor-selection-color);
}

/* Blocks are separated by one empty line, as in the editor */
#document p, #document ul, #document ol, #document dl, #document blockquote,
#document pre, #document table, #document figure, #document hr,
#document .html-block-preview, #document .mermaid-chart,
#document .katex-display, #document h1, #document h2, #document h3,
#document h4, #document h5, #document h6 {
  margin-top: 0;
  margin-bottom: var(--export-line);
}

#document > :last-child {
  margin-bottom: 0;
}

/* Headings */
#document h1, #document h2, #document h3, #document h4, #document h5, #document h6 {
  font-weight: var(--zettlr-editor-header-style, bold);
  font-family: var(--zettlr-editor-font);
  line-height: normal;
  color: inherit;
  text-decoration: var(--zettlr-editor-line-decoration, none);
}

#document * + h1, #document * + h2, #document * + h3,
#document * + h4, #document * + h5, #document * + h6 {
  margin-top: var(--export-line);
}

#document h1 { font-size: var(--zettlr-editor-header-1-size, 2em); }
#document h2 { font-size: var(--zettlr-editor-header-2-size, 1.8em); }
#document h3 { font-size: var(--zettlr-editor-header-3-size, 1.5em); }
#document h4 { font-size: var(--zettlr-editor-header-4-size, 1.3em); }
#document h5 { font-size: var(--zettlr-editor-header-5-size, 1em); }
#document h6 { font-size: var(--zettlr-editor-header-6-size, 1em); }

#document blockquote :is(h1, h2, h3, h4, h5, h6) {
  font-size: 1em;
}

/* Inline formatting */
#document em {
  font-style: var(--zettlr-editor-emphasis-style, italic);
}

#document strong, #document b {
  font-weight: var(--zettlr-editor-strong-style, bold);
}

#document mark {
  background-color: var(--zettlr-editor-highlight-color);
  color: inherit;
}

#document s, #document del, #document strike {
  text-decoration: line-through;
  text-decoration-thickness: 2px;
}

/* Tracked changes (spec C10): insertions colored and underlined, deletions
colored and struck through, in the colors of the editor's revision renderer
(renderers/render-revisions.ts) for the light and the dark theme */
#document ins.revision-insertion {
  color: #1a7f37;
  text-decoration: underline;
  text-decoration-color: #1a7f37;
}

#document del.revision-deletion {
  color: #cf222e;
  text-decoration: line-through;
  text-decoration-color: #cf222e;
}

html.dark #document ins.revision-insertion {
  color: #56d364;
  text-decoration-color: #56d364;
}

html.dark #document del.revision-deletion {
  color: #ff7b72;
  text-decoration-color: #ff7b72;
}

#document a {
  color: var(--zettlr-editor-primary-color);
  text-decoration: var(--zettlr-editor-line-decoration, none);
}

#document .html-block-preview a {
  text-decoration: underline;
}

#document sup, #document sub {
  line-height: 0;
}

/* The footnote markers follow the font size the document is rendered at, with
the same ratio as in the editor. Not rem, which refers to the root element and
is therefore independent
of that font size, and not em, because a footnote marker can sit inside a
heading, whose own font size is a multiple such as 2em, and an em value would
be multiplied by that again. */
#document sup.footnote-ref-label, #document a.footnote {
  font-size: calc(var(--export-rendered-font-size) * 0.8);
}

#document .citation {
  background-color: var(--zettlr-editor-citation-bg);
}

/* Code */
#document code {
  font-family: var(--zettlr-editor-code-font);
  color: var(--zettlr-editor-code-color);
  font-size: 1em;
}

#document :not(pre) > code {
  background-color: var(--zettlr-editor-code-bg);
  border-radius: 2px;
  padding: 0 2px;
}

/* The editor keeps the backticks of inline code visible */
#document :not(pre) > code::before,
#document :not(pre) > code::after {
  content: "\`";
}

#document pre {
  background-color: var(--zettlr-editor-code-bg);
  border-radius: 4px;
  padding: 0 6px;
  overflow-x: auto;
  line-height: var(--zettlr-editor-line-height, 1.4);
}

#document pre code {
  white-space: pre;
  background: none;
  padding: 0;
}

/* Syntax colors of the editor's code theme (Solarized) */
#document pre code :is(.cm-comment, .cm-line-comment, .cm-block-comment) { color: #657b83; }
#document pre code :is(.cm-keyword, .cm-inserted, .cm-positive) { color: #859900; }
#document pre code .cm-string { color: var(--zettlr-editor-secondary-color); }
#document pre code :is(.cm-control-keyword, .cm-atom, .cm-color, .cm-number, .cm-integer, .cm-bool) { color: #6c71c4; }
#document pre code :is(.cm-property, .cm-operator, .cm-compare-operator, .cm-arithmetic-operator, .cm-self) { color: #d33682; }
#document pre code :is(.cm-operator-keyword, .cm-definition-keyword, .cm-module-keyword, .cm-null, .cm-meta, .cm-unit, .cm-qualifier, .cm-builtin, .cm-property-name) { color: #268bd2; }
#document pre code :is(.cm-tag-name, .cm-modifier, .cm-variable-name, .cm-variable) { color: #2aa198; }
#document pre code :is(.cm-attribute-name, .cm-regexp) { color: #cb4b16; }
#document pre code :is(.cm-name, .cm-class-name, .cm-type-name, .cm-changed) { color: #b58900; }
#document pre code :is(.cm-deleted, .cm-negative, .cm-invalid) { color: #dc322f; }

/* Blockquotes */
#document blockquote {
  border-left: 0.25em solid var(--zettlr-editor-primary-color);
  padding-left: 0.5em;
  margin-left: 0.25em;
  margin-right: 0;
}

#document blockquote > * {
  opacity: 0.7;
}

#document blockquote > blockquote {
  opacity: 1;
}

#document blockquote > :last-child {
  margin-bottom: 0;
}

/* Admonitions (> [!NOTE] etc.), colored like the editor's preview */
#document .admonition {
  border-radius: 8px;
  padding: 0.5em;
  margin: 0 0 1em 0.25em;
  border: 1px solid transparent;
}

#document .admonition > :last-child {
  margin-bottom: 0;
}

#document .admonition-title,
#document .admonition::before {
  display: block;
  font-weight: bold;
}

/* The converter emits a title element only for custom titles; the generic
   keyword titles are restored here */
#document .admonition:has(> .admonition-title)::before { content: none; }
#document .admonition.note::before { content: 'Note'; }
#document .admonition.tip::before { content: 'Tip'; }
#document .admonition.important::before { content: 'Important'; }
#document .admonition.warning::before { content: 'Warning'; }
#document .admonition.caution::before { content: 'Caution'; }

#document .admonition.note { background-color: rgb(220, 220, 220); border-color: rgb(125, 125, 125); color: rgb(125, 125, 125); }
#document .admonition.tip { background-color: rgb(200, 250, 200); border-color: rgb(75, 134, 75); color: rgb(75, 134, 75); }
#document .admonition.important { background-color: rgb(250, 180, 250); border-color: rgb(133, 87, 133); color: rgb(133, 87, 133); }
#document .admonition.warning { background-color: rgb(250, 250, 180); border-color: rgb(130, 130, 48); color: rgb(130, 130, 48); }
#document .admonition.caution { background-color: rgb(250, 210, 210); border-color: rgb(148, 76, 76); color: rgb(148, 76, 76); }

/* Lists: tight like the editor's lines, with the marker in the accent color */
#document ul, #document ol {
  padding-left: 1.3em;
}

#document li > p {
  margin: 0;
}

#document li > ul, #document li > ol {
  margin-bottom: 0;
}

#document ul > li::marker {
  content: "\\2022  ";
}

#document ol > li::marker {
  color: var(--zettlr-editor-primary-color);
}

#document li > input[type="checkbox"] {
  transform: scale(1.2);
  margin: 0.2em 0.3em 0.2em 0.2em;
  vertical-align: middle;
}

/* Horizontal rules */
#document hr {
  border: none;
  border-top: 1px solid var(--zettlr-editor-escape-color);
}

/* Markdown tables, as drawn by the table editor */
#document table {
  border-collapse: collapse;
  display: block;
  width: max-content;
  max-width: 100%;
  overflow-x: auto;
}

/* Blocks too wide for the screen scroll inside their own box. On a touch
screen, keep that scrolling from turning into the browser's back gesture once
the block reaches its end. */
#document table, #document pre, #document .html-block-preview,
#document .katex-display {
  overscroll-behavior-x: contain;
}

#document th, #document td {
  text-align: left;
  color: var(--export-table-color);
  border: 1px solid var(--export-table-border);
  padding: 4px 6px;
  min-width: var(--export-table-cell-min-width);
  vertical-align: top;
}

#document th {
  font-weight: bold;
}

/* Raw HTML blocks, as drawn by the editor's HTML block preview */
#document .html-block-preview {
  overflow-x: auto;
}

#document .html-block-preview :is(h1, h2, h3, h4, h5, h6, p, ul, ol, dl, figure) {
  margin: 0;
}

#document .html-block-preview table {
  display: table;
  width: auto;
  margin: 4px 0;
}

#document .html-block-preview :is(th, td) {
  color: inherit;
  border: 1px solid rgba(128, 128, 128, 0.5);
  padding: 4px 8px;
  min-width: 0;
  text-align: inherit;
}

#document .html-block-preview th {
  background: rgba(128, 128, 128, 0.12);
}

/* Images, sized by the rules of the editor (applySizeStyles in
render-images.ts): an image with a width takes that share of the text column
without a height limit; an image without a size attribute fits the text column
and 80% of the window height, and a script narrows that to its natural size */
#document img {
  max-width: 100%;
  vertical-align: bottom;
}

#document img:not([width], [height], [w], [h]) {
  max-height: 80vh;
}

#document .html-block-preview img {
  max-height: none;
}

#document img[width] {
  height: auto;
}

/* Formulas and charts */
#document .katex {
  font-size: 1.1em;
}

#document .katex-display {
  overflow-x: auto;
  overflow-y: hidden;
}

#document .mermaid-chart {
  display: block;
}

#document .mermaid-chart svg {
  max-width: 100%;
  height: auto;
}

#document .mermaid-chart.error {
  font-family: var(--zettlr-editor-code-font);
  color: var(--zettlr-editor-error-color);
  white-space: pre-wrap;
}

/* Pandoc bracketed spans and fenced divs */
#document .mark {
  background-color: var(--zettlr-editor-highlight-color);
}

#document .underline {
  text-decoration: underline;
}

#document .smallcaps {
  font-variant-caps: small-caps;
}

/* Footnotes */
#footnote-container {
  font-size: 0.9em;
}

#footnote-container .footnote-ref > p:first-of-type {
  display: inline;
}

@media print {
  html, body {
    background: none;
  }

  #document {
    width: auto;
    max-width: none;
    padding: 0;
  }

  .export-width-handle {
    display: none;
  }
}
`
