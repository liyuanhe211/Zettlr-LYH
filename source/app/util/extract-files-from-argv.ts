/**
 * BEGIN HEADER
 *
 * Contains:        Utility function
 * CVM-Role:        <none>
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Extracts valid files to be opened with Zettlr
 *                  from the given argv string.
 *
 * END HEADER
 */

import path from 'path'
// Helpers to determine what files from argv we can open
import { hasMdOrCodeExt, hasPDFExt } from '@common/util/file-extention-checks'

/**
 * Extracts files from argv.
 *
 * @param   {string[]}  [argv=process.argv]  The array to search for files
 *
 * @returns {string[]}                       The filtered out files
 */
export default function extractFilesFromArgv (argv = process.argv): string[] {
  if (!Array.isArray(argv)) {
    return []
  }

  return argv.filter((arg) => {
    // Filter out CLI arguments, non-files, and non-supported files
    return !arg.startsWith('--') && (hasMdOrCodeExt(arg) || hasPDFExt(arg))
  })
}

/**
 * The command line argument with which another program asks the running
 * instance to close the tabs of a file, given by its absolute path:
 * `--close-file=<absolute path>`. It may be repeated for several files.
 */
export const CLOSE_FILE_ARGUMENT = '--close-file='

/**
 * Zettlr-LYH close tab from the command line: extracts the files whose tabs
 * another program asks to close (`--close-file=<absolute path>`). Surrounding
 * quotes are removed; empty and relative paths are dropped, since the calling
 * program's working directory is unknown to the running instance.
 *
 * @param   {string[]}  argv  The command line to search
 *
 * @returns {string[]}        The absolute paths of the files to close
 */
export function extractFilesToCloseFromArgv (argv: string[]): string[] {
  if (!Array.isArray(argv)) {
    return []
  }

  const files: string[] = []
  for (const arg of argv) {
    if (!arg.startsWith(CLOSE_FILE_ARGUMENT)) {
      continue
    }
    const filePath = arg.slice(CLOSE_FILE_ARGUMENT.length).trim().replace(/^"(.*)"$/, '$1')
    if (filePath !== '' && path.isAbsolute(filePath)) {
      files.push(filePath)
    }
  }
  return files
}
