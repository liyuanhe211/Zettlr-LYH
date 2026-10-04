/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Pandoc PPTX export shared types
 * CVM-Role:        Types
 * License:         GNU GPL v3
 *
 * Description:     Types shared between the main-process pptx-export command
 *                  and the renderer preview pane, which offers the Export PPTX
 *                  button. The command runs the maintained conversion script
 *                  over the saved document and reports the outcome.
 *
 * END HEADER
 */

/**
 * Payload of the 'pptx-export' command on the 'application' IPC channel.
 */
export interface PptxExportCommandArg {
  /**
   * Absolute path of the Markdown document to export (already saved to disk)
   */
  filePath: string
}

/**
 * What the pptx-export command returns to the renderer.
 */
export interface PptxExportResult {
  /**
   * True when the conversion script ran to completion
   */
  ok: boolean
  /**
   * Absolute path of the written .pptx (present when ok is true)
   */
  outputPath?: string
  /**
   * Overflow findings the script reported (including authorized ones)
   */
  overflowCount: number
  /**
   * Of these, the findings on pages that declare allow-overflow
   */
  authorizedOverflowCount: number
  /**
   * Undersized-text findings the script reported (explicitly declared
   * deviations are not counted; the script lists them separately)
   */
  undersizedCount: number
  /**
   * One-line description of what went wrong (present when ok is false)
   */
  error?: string
}
