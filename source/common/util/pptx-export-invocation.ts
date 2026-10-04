/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Pandoc PPTX export invocation builder
 * CVM-Role:        Utility function
 * License:         GNU GPL v3
 *
 * Description:     Pure helpers that locate the maintained conversion script
 *                  Convert_Markdown_Deck.py and assemble the Python command
 *                  line with which the pptx-export command runs it over a
 *                  saved Markdown document. Kept free of Electron and of any
 *                  process spawning, so that it can be unit-tested in
 *                  isolation. Main process only (uses Node's path module).
 *
 * END HEADER
 */

import path from 'path'

/**
 * Location of the conversion script relative to the user's home directory.
 * The home directory itself is only known at runtime (os.homedir()), so no
 * user name or drive letter ever ends up in the code.
 */
export const CONVERSION_SCRIPT_HOME_RELATIVE_SEGMENTS = [
  '.claude', 'skills', 'PPT-Maker-NotesInTheScales-Pandoc', 'scripts', 'Convert_Markdown_Deck.py'
]

/**
 * The flag that makes the script skip its final step (rendering every slide
 * into a PNG for visual spot checks), which an export does not need
 */
export const NO_RENDER_FLAG = '--no-render'

/**
 * The option with which the script takes a template of the document's own
 * choosing instead of its built-in one
 */
export const TEMPLATE_OPTION = '--template'

/**
 * Where the conversion script lives for the given home directory.
 *
 * @param   {string}  homeDirectory  The user's home directory (os.homedir())
 *
 * @return  {string}                 Absolute path of Convert_Markdown_Deck.py
 */
export function resolveConversionScriptPath (homeDirectory: string): string {
  return path.join(homeDirectory, ...CONVERSION_SCRIPT_HOME_RELATIVE_SEGMENTS)
}

/**
 * The .pptx the script writes when given no explicit output path: same
 * directory, same base name (Python's os.path.splitext drops only the last
 * extension, and so does path.parse).
 *
 * @param   {string}  markdownPath  Absolute path of the Markdown document
 *
 * @return  {string}                Absolute path of the resulting .pptx
 */
export function derivePptxOutputPath (markdownPath: string): string {
  const parsed = path.parse(markdownPath)
  return path.join(parsed.dir, `${parsed.name}.pptx`)
}

/**
 * The complete process invocation of one export
 */
export interface PptxExportInvocation {
  /**
   * The executable (the Python interpreter)
   */
  command: string
  /**
   * Its arguments
   */
  args: string[]
  /**
   * The .pptx the run is expected to produce
   */
  outputPath: string
}

/**
 * Assembles the command line of one export.
 *
 * This is exactly the command-line build
 * `python Convert_Markdown_Deck.py <document> --no-render`, followed by
 * `--template <path>` when the document names a template of its own.
 *
 * @param   {object}  options               The invocation inputs
 * @param   {string}  options.pythonPath    The Python interpreter
 * @param   {string}  options.scriptPath    Absolute path of the script
 * @param   {string}  options.markdownPath  Absolute path of the saved document
 * @param   {string}  options.templatePath  Absolute path of the document's own
 *                                          template, or undefined for the
 *                                          script's built-in one
 *
 * @return  {PptxExportInvocation}          The command, arguments and output
 */
export function buildPptxExportInvocation (options: { pythonPath: string, scriptPath: string, markdownPath: string, templatePath?: string }): PptxExportInvocation {
  const args = [ options.scriptPath, options.markdownPath, NO_RENDER_FLAG ]
  if (options.templatePath !== undefined && options.templatePath !== '') {
    args.push(TEMPLATE_OPTION, options.templatePath)
  }

  return {
    command: options.pythonPath,
    args,
    outputPath: derivePptxOutputPath(options.markdownPath)
  }
}
