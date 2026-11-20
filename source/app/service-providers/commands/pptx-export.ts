/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        PptxExport command
 * CVM-Role:        <none>
 * License:         GNU GPL v3
 *
 * Description:     Exports a pandoc slide Markdown document as a PPTX next to
 *                  the document, by running the maintained conversion script
 *                  Convert_Markdown_Deck.py (with --no-render) as a child
 *                  process over the document on disk. The renderer saves the
 *                  document through the regular save path before invoking
 *                  this command. The script writes <name>.pptx together with
 *                  its <name>.pptx.style_manifest.json and
 *                  <name>.pptx.slide_ids.json companions; the command reports
 *                  the script's overflow and undersized-text findings back.
 *                  Tracked changes (spec C10) are accepted first: a document
 *                  that contains them is converted from a hidden temporary
 *                  copy next to it (so that relative image paths still
 *                  resolve), with the output path given explicitly, and the
 *                  copy is deleted afterwards.
 *
 *                  Design note: the export deliberately does NOT assemble the
 *                  deck from the preview worker's per-page chunks. Running the
 *                  official conversion script over the whole document keeps
 *                  the product identical to a command-line build, and in
 *                  particular keeps the stable slide identities in the
 *                  .slide_ids.json companion, which the DaVinci slide plug-in
 *                  relies on to refresh a deck incrementally.
 *
 * END HEADER
 */

import ZettlrCommand from './zettlr-command'
import { spawn } from 'child_process'
import os from 'os'
import path from 'path'
import { promises as fs } from 'fs'
import isFile from '@common/util/is-file'
import { parsePptxPreviewConfiguration } from '@common/pandoc-util/pptx-preview-configuration'
import { buildPptxExportInvocation, resolveConversionScriptPath } from '@common/util/pptx-export-invocation'
import { parseConversionReport, summarizeConversionFailure } from '@common/util/pptx-export-report'
import type { PptxExportCommandArg, PptxExportResult } from '@dts/common/pptx-export'
import type { AppServiceContainer } from 'source/app/app-service-container'
// The same interpreter the pptx-preview command runs its worker with
import { PYTHON_PATH } from './pptx-preview'
import { prepareMarkdownForPptx } from './pptx-preview/preview-orchestrator'

/**
 * A full conversion drives PowerPoint through COM for its checks, which can
 * take a while for long decks; a run exceeding this is considered stuck.
 */
const EXPORT_TIMEOUT_MILLISECONDS = 10 * 60 * 1000

function failure (error: string): PptxExportResult {
  return { ok: false, overflowCount: 0, authorizedOverflowCount: 0, undersizedCount: 0, error }
}

/**
 * The hidden temporary copy, next to the document, from which a document with
 * tracked changes is exported, e.g. ".Talk.accepted-revisions.md" for
 * "Talk.md" in the same folder.
 *
 * @param   {string}  markdownPath  Absolute path of the document
 *
 * @return  {string}                Absolute path of the temporary copy
 */
export function acceptedRevisionsSourcePath (markdownPath: string): string {
  const parsed = path.parse(markdownPath)
  return path.join(parsed.dir, `.${parsed.name}.accepted-revisions${parsed.ext}`)
}

/**
 * Rewrites the script arguments of an export so that the script reads the
 * temporary copy and still writes the .pptx of the document itself: the
 * document path is replaced by the copy followed by the explicit output path.
 *
 * @param   {string[]}  args          The arguments for the document itself
 * @param   {string}    markdownPath  The document path among them
 * @param   {string}    sourcePath    The temporary copy to convert instead
 * @param   {string}    outputPath    The .pptx the document's export writes
 *
 * @return  {string[]}                The rewritten arguments
 */
export function argumentsForAcceptedSource (args: string[], markdownPath: string, sourcePath: string, outputPath: string): string[] {
  const index = args.indexOf(markdownPath)
  if (index < 0) {
    return args
  }

  return [ ...args.slice(0, index), sourcePath, outputPath, ...args.slice(index + 1) ]
}

export default class PptxExport extends ZettlrCommand {
  /**
   * Documents whose export is currently running (one export per document at
   * a time)
   */
  private readonly runningExports: Set<string>

  constructor (app: AppServiceContainer) {
    super(app, 'pptx-export')
    this.runningExports = new Set()
  }

  /**
   * Exports the given (already saved) document as a PPTX.
   *
   * @param   {string}                evt  The event name
   * @param   {PptxExportCommandArg}  arg  The document to export
   *
   * @return  {Promise<PptxExportResult>}  The outcome, never rejects
   */
  async run (evt: string, arg: PptxExportCommandArg): Promise<PptxExportResult> {
    const filePath = arg?.filePath
    if (typeof filePath !== 'string' || filePath === '') {
      return failure('No document was given')
    }

    if (this.runningExports.has(filePath)) {
      return failure('An export of this document is already running')
    }

    const scriptPath = resolveConversionScriptPath(os.homedir())
    if (!isFile(scriptPath)) {
      return failure(`The conversion script was not found at ${scriptPath}`)
    }

    if (this._app.documents.isModified(filePath)) {
      // The renderer saves right before invoking this command, so this only
      // happens when the user typed in between; the saved state is exported.
      this._app.log.warning(`[PptxExport] ${filePath} has unsaved changes; exporting the version on disk`)
    }

    this.runningExports.add(filePath)
    let temporarySourcePath: string|undefined
    try {
      // The same per-document template the preview renders against: the one
      // named in the document's configuration comment (relative paths resolve
      // against the document's directory), otherwise the script's own.
      const content = await this._app.fsal.loadAnySupportedFile(filePath)
      const configuredTemplate = parsePptxPreviewConfiguration(content).configuration.referenceDoc
      let templatePath: string|undefined
      if (configuredTemplate !== undefined && configuredTemplate !== '') {
        templatePath = path.isAbsolute(configuredTemplate)
          ? configuredTemplate
          : path.resolve(path.dirname(filePath), configuredTemplate)
        if (!isFile(templatePath)) {
          return failure(`The template named in the document was not found: ${templatePath}`)
        }
      }

      const invocation = buildPptxExportInvocation({
        pythonPath: PYTHON_PATH,
        scriptPath,
        markdownPath: filePath,
        templatePath
      })

      // Deleted text must not reach the slides (spec C10, export item 3)
      let args = invocation.args
      const exportedContent = prepareMarkdownForPptx(content)
      if (exportedContent !== content) {
        temporarySourcePath = acceptedRevisionsSourcePath(filePath)
        await fs.writeFile(temporarySourcePath, exportedContent, 'utf-8')
        args = argumentsForAcceptedSource(invocation.args, filePath, temporarySourcePath, invocation.outputPath)
        this._app.log.info(`[PptxExport] ${filePath} contains tracked changes; exporting it with all of them accepted`)
      }

      this._app.log.info(`[PptxExport] Exporting ${filePath} to ${invocation.outputPath}`)
      const run = await this.runProcess(invocation.command, args, path.dirname(filePath))

      if (run.spawnError !== undefined) {
        return failure(`Could not start Python: ${run.spawnError}`)
      }

      if (run.exitCode !== 0 || run.timedOut) {
        const error = summarizeConversionFailure(run)
        this._app.log.error(`[PptxExport] Export of ${filePath} failed: ${error}`)
        if (run.standardError.trim() !== '') {
          this._app.log.error(`[PptxExport] Script error output:\n${run.standardError}`)
        }
        return failure(error)
      }

      const report = parseConversionReport(run.standardOutput)
      const result: PptxExportResult = {
        ok: true,
        outputPath: report.outputPath ?? invocation.outputPath,
        overflowCount: report.overflowCount,
        authorizedOverflowCount: report.authorizedOverflowCount,
        undersizedCount: report.undersizedCount
      }
      this._app.log.info(`[PptxExport] Exported ${result.outputPath ?? ''}: ${result.overflowCount} overflow finding(s), ${result.undersizedCount} undersized text run(s)`)
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this._app.log.error(`[PptxExport] Export of ${filePath} failed: ${message}`)
      return failure(message)
    } finally {
      if (temporarySourcePath !== undefined) {
        const copyPath = temporarySourcePath
        await fs.rm(copyPath, { force: true }).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          this._app.log.warning(`[PptxExport] Could not delete the temporary copy ${copyPath}: ${message}`)
        })
      }
      this.runningExports.delete(filePath)
    }
  }

  /**
   * Runs the conversion process to completion, collecting its output. Never
   * rejects: start failures and timeouts are reported in the resolved value.
   */
  private async runProcess (command: string, args: string[], workingDirectory: string): Promise<{
    exitCode: number|null
    standardOutput: string
    standardError: string
    timedOut: boolean
    spawnError?: string
  }> {
    return await new Promise((resolve) => {
      let standardOutput = ''
      let standardError = ''
      let timedOut = false
      let settled = false

      const child = spawn(command, args, {
        cwd: workingDirectory,
        windowsHide: true,
        stdio: [ 'ignore', 'pipe', 'pipe' ],
        // The report contains shape names and text snippets in any language;
        // without this, Python would encode a piped stdout with the ANSI code
        // page and garble (or fail on) them.
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
      })

      const timer = setTimeout(() => {
        timedOut = true
        this._app.log.error('[PptxExport] The conversion script did not finish in time -- killing it')
        try { child.kill() } catch (error) { /* already gone */ }
      }, EXPORT_TIMEOUT_MILLISECONDS)

      const settle = (exitCode: number|null, spawnError?: string): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        resolve({ exitCode, standardOutput, standardError, timedOut, spawnError })
      }

      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => { standardOutput += chunk })
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => { standardError += chunk })

      child.on('error', (error) => { settle(null, error.message) })
      child.on('close', (exitCode) => { settle(exitCode) })
    })
  }
}
