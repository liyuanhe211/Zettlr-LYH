/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Pandoc PPTX export report utilities
 * CVM-Role:        Utility function
 * License:         GNU GPL v3
 *
 * Description:     Pure helpers around the report the maintained conversion
 *                  script Convert_Markdown_Deck.py prints while exporting a
 *                  deck: counting its overflow and undersized-text findings,
 *                  condensing a failed run into one line, and phrasing the
 *                  outcome for the preview pane's status area. The module has
 *                  no Node or Electron dependencies, so that both the main
 *                  process and the renderer can use it, and so that it can be
 *                  unit-tested in isolation.
 *
 * END HEADER
 */

import type { PptxExportResult } from '@dts/common/pptx-export'

// NOTE: The first two patterns are the same ones the preview worker
// (resources/pptx-preview/pptx_preview_worker.py) applies to the same report;
// the script keeps these two line formats stable for exactly that reason.
const OVERFLOW_LINE_PATTERN = /^\s*slide (\d+), (.*): exceeds the box by ([0-9.]+) pt\s*$/
const UNDERSIZED_LINE_PATTERN = /^\s*slide (\d+), (.*?): ([0-9.]+) pt (['"].*)$/
/**
 * Printed directly below an overflow line whose page declares allow-overflow
 */
const AUTHORIZED_LINE_PATTERN = /^\s*authorized: page (\d+) declares allow-overflow/
/**
 * The script's last line on success
 */
const DONE_LINE_PATTERN = /^done -> (.+?)\s*$/
/**
 * The first report line; a nonzero exit code is followed by pandoc's stderr
 */
const PANDOC_EXIT_LINE_PATTERN = /^\[1\/5\] pandoc exit: (-?\d+)/

/**
 * What the conversion script reported on its standard output
 */
export interface ConversionReport {
  /**
   * Number of overflow lines (authorized ones included)
   */
  overflowCount: number
  /**
   * Number of overflow lines followed by an allow-overflow authorization
   */
  authorizedOverflowCount: number
  /**
   * Number of undersized-text lines
   */
  undersizedCount: number
  /**
   * The output path from the final `done -> <path>` line, if the script got
   * that far
   */
  outputPath?: string
  /**
   * pandoc's exit code, if the report contains the pandoc step's line
   */
  pandocExitCode?: number
  /**
   * The first non-empty line following a nonzero pandoc exit line (pandoc's
   * own error message), if any
   */
  pandocMessage?: string
}

/**
 * Splits text into lines, accepting both LF and CRLF line endings
 */
function splitLines (text: string): string[] {
  return text.split(/\r?\n/)
}

/**
 * Reads the standard output of a Convert_Markdown_Deck.py run.
 *
 * @param   {string}            standardOutput  Everything the script printed
 *
 * @return  {ConversionReport}                  The counted findings
 */
export function parseConversionReport (standardOutput: string): ConversionReport {
  const report: ConversionReport = {
    overflowCount: 0,
    authorizedOverflowCount: 0,
    undersizedCount: 0
  }

  const lines = splitLines(standardOutput)
  let expectingPandocMessage = false
  for (const line of lines) {
    if (expectingPandocMessage && line.trim() !== '') {
      report.pandocMessage = line.trim()
      expectingPandocMessage = false
      continue
    }

    const pandocMatch = PANDOC_EXIT_LINE_PATTERN.exec(line)
    if (pandocMatch !== null) {
      report.pandocExitCode = parseInt(pandocMatch[1], 10)
      expectingPandocMessage = report.pandocExitCode !== 0
      continue
    }

    // Overflow lines are tested first: an undersized line needs a number
    // directly after the colon, which an overflow line never has, but testing
    // in this order keeps the two classifications independent of that detail.
    if (OVERFLOW_LINE_PATTERN.test(line)) {
      report.overflowCount++
    } else if (UNDERSIZED_LINE_PATTERN.test(line)) {
      report.undersizedCount++
    } else if (AUTHORIZED_LINE_PATTERN.test(line)) {
      report.authorizedOverflowCount++
    } else {
      const doneMatch = DONE_LINE_PATTERN.exec(line)
      if (doneMatch !== null) {
        report.outputPath = doneMatch[1]
      }
    }
  }

  return report
}

/**
 * Condenses a failed conversion run into a single line for the status area.
 *
 * Preference order: a timeout; a pandoc failure (with pandoc's first error
 * line); the last non-empty line of the standard error output (for a Python
 * exception this is the "SomeError: message" line closing the traceback);
 * finally the bare exit code.
 *
 * @param   {object}   run                 The finished run
 * @param   {number}   run.exitCode        The process exit code (null when the
 *                                         process was killed by a signal)
 * @param   {string}   run.standardOutput  Everything printed on stdout
 * @param   {string}   run.standardError   Everything printed on stderr
 * @param   {boolean}  run.timedOut        Whether the run was killed for
 *                                         taking too long
 *
 * @return  {string}                       The one-line description
 */
export function summarizeConversionFailure (run: { exitCode: number|null, standardOutput: string, standardError: string, timedOut: boolean }): string {
  if (run.timedOut) {
    return 'The conversion script took too long and was stopped'
  }

  const report = parseConversionReport(run.standardOutput)
  if (report.pandocExitCode !== undefined && report.pandocExitCode !== 0) {
    const detail = report.pandocMessage !== undefined ? `: ${report.pandocMessage}` : ''
    return `pandoc failed (exit code ${report.pandocExitCode})${detail}`
  }

  const errorLines = splitLines(run.standardError).map(line => line.trim()).filter(line => line !== '')
  if (errorLines.length > 0) {
    return `The conversion script failed: ${errorLines[errorLines.length - 1]}`
  }

  return `The conversion script exited with code ${String(run.exitCode)}`
}

function countLabel (count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`
}

/**
 * Phrases an export result for the preview pane's status area.
 *
 * @param   {PptxExportResult}  result  What the pptx-export command returned
 *
 * @return  {string}                    The status text
 */
export function formatPptxExportSummary (result: PptxExportResult): string {
  if (!result.ok) {
    return `Export failed: ${result.error ?? 'unknown error'}`
  }

  const outputPath = result.outputPath ?? ''
  const fileName = outputPath.split(/[\\/]/).pop() ?? outputPath
  const exported = fileName === '' ? 'Exported the PPTX' : `Exported ${fileName}`

  if (result.overflowCount === 0 && result.undersizedCount === 0) {
    return `${exported}: no overflow, no undersized text`
  }

  const findings: string[] = []
  if (result.overflowCount > 0) {
    let overflow = countLabel(result.overflowCount, 'overflow finding', 'overflow findings')
    if (result.authorizedOverflowCount > 0) {
      overflow += ` (${result.authorizedOverflowCount} authorized)`
    }
    findings.push(overflow)
  }
  if (result.undersizedCount > 0) {
    findings.push(countLabel(result.undersizedCount, 'undersized text run', 'undersized text runs'))
  }

  return `${exported}: ${findings.join(', ')}`
}
