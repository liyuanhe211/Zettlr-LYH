/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Scratch note file operations and path helpers
 * CVM-Role:        Utility
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH scratch notes (R40): the file system side of the
 *                  scratch note feature, used by the DocumentManager. Creates
 *                  new scratch note files, moves closed scratch notes that the
 *                  user did not save into the __Unsaved folder of the undo
 *                  history folder (R135; the move into the _Discarded
 *                  subfolder of earlier versions is still available but no
 *                  longer the intended behavior), deletes blank or saved
 *                  scratch notes, and selects the scratch notes to reopen on
 *                  startup.
 *                  Any file ending in .md inside the scratch folder counts as
 *                  a scratch note, since scratch notes can be renamed (R102).
 *                  It deliberately does not depend on electron, so that it can
 *                  be tested directly.
 *
 * END HEADER
 */

import path from 'path'
import { promises as fs, constants as fsConstants } from 'fs'
import { hasMarkdownExt } from '@common/util/file-extention-checks'
import {
  SCRATCH_DISCARDED_FOLDER,
  SCRATCH_HISTORY_SUBFOLDER,
  closedScratchFileName,
  discardedFileName,
  isScratchNoteFileName,
  scratchNoteFileName
} from './scratch-notes'

/**
 * How often createScratchNoteFile tries to find a free name before giving up.
 */
const MAX_CREATE_ATTEMPTS = 5

/**
 * Returns the error code of a Node.js file system error, if any.
 *
 * @param   {unknown}             error  The caught error
 *
 * @return  {string|undefined}           The error code, e.g. ENOENT
 */
function errorCode (error: unknown): string|undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code: unknown = (error as { code: unknown }).code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}

/**
 * Compares two strings by UTF-16 code units, so that UNSAVED_<time>.md sorts
 * before UNSAVED_<time>_2.md (locale-aware comparison would put "_" before ".").
 *
 * @param   {string}  first   The first string
 * @param   {string}  second  The second string
 *
 * @return  {number}          Negative, zero or positive, as for Array.sort
 */
function compareCodeUnits (first: string, second: string): number {
  if (first < second) {
    return -1
  }
  return first > second ? 1 : 0
}

/**
 * Normalizes a path so that two paths to the same file compare equal: the path
 * is resolved, and lower-cased if comparisons are case-insensitive.
 *
 * @param   {string}   filePath         The path to normalize
 * @param   {boolean}  caseInsensitive  Whether to ignore case (default: on Windows)
 *
 * @return  {string}                    The normalized path
 */
export function normalizePathForComparison (filePath: string, caseInsensitive = process.platform === 'win32'): string {
  const resolved = path.resolve(filePath)
  return caseInsensitive ? resolved.toLowerCase() : resolved
}

/**
 * Checks whether two paths point to the same file.
 *
 * @param   {string}   firstPath        The first path
 * @param   {string}   secondPath       The second path
 * @param   {boolean}  caseInsensitive  Whether to ignore case (default: on Windows)
 *
 * @return  {boolean}                   True if both paths are the same
 */
export function isSamePath (firstPath: string, secondPath: string, caseInsensitive = process.platform === 'win32'): boolean {
  return normalizePathForComparison(firstPath, caseInsensitive) === normalizePathForComparison(secondPath, caseInsensitive)
}

/**
 * Checks whether a path lies strictly inside a directory, at any depth. The
 * directory itself, sibling folders that merely share a name prefix, and paths
 * on another drive are not inside. NOTE: on Windows, path.relative ignores
 * case anyway, so caseInsensitive = false only has an effect elsewhere.
 *
 * @param   {string}   filePath         The path to check
 * @param   {string}   directory        The directory
 * @param   {boolean}  caseInsensitive  Whether to ignore case (default: on Windows)
 *
 * @return  {boolean}                   True if the path lies inside the directory
 */
export function isPathInsideDirectory (filePath: string, directory: string, caseInsensitive = process.platform === 'win32'): boolean {
  const normalizedPath = normalizePathForComparison(filePath, caseInsensitive)
  const normalizedDirectory = normalizePathForComparison(directory, caseInsensitive)
  const relative = path.relative(normalizedDirectory, normalizedPath)

  if (relative === '' || path.isAbsolute(relative)) {
    return false
  }

  return relative.split(path.sep)[0] !== '..'
}

/**
 * Checks whether two paths point to the very same file on disk. This is how a
 * rename that only changes the letter case of a file name looks on a case-
 * insensitive file system: the new name "already exists" because it is the old
 * file. Paths that cannot be read, and file systems that report no usable file
 * identity (an inode number of 0), never count as the same file, so that a
 * caller never mistakes a different file for the one it is about to rename.
 *
 * @param   {string}            firstPath   The first path
 * @param   {string}            secondPath  The second path
 *
 * @return  {Promise<boolean>}              True if both paths are the same file
 */
export async function isSameFileOnDisk (firstPath: string, secondPath: string): Promise<boolean> {
  try {
    const first = await fs.stat(firstPath, { bigint: true })
    const second = await fs.stat(secondPath, { bigint: true })
    return first.ino !== 0n && first.ino === second.ino && first.dev === second.dev
  } catch (error) {
    return false
  }
}

/**
 * Appends .md to a path unless it already has a Markdown extension, so that a
 * Markdown document always ends up in a file that is loaded as Markdown again.
 *
 * @param   {string}  filePath  The path chosen by the user
 *
 * @return  {string}            The path with a Markdown extension
 */
export function ensureMarkdownExtension (filePath: string): string {
  return hasMarkdownExt(filePath) ? filePath : filePath + '.md'
}

/**
 * Selects the scratch notes in the scratch folder that should be reopened on
 * startup: entries with a valid scratch note file name (any name ending in .md,
 * see isScratchNoteFileName, since a scratch note can be renamed) that are not
 * open already, sorted by file name in UTF-16 code unit order. The generated
 * names UNSAVED_<time>[_n].md therefore come in creation order.
 *
 * @param   {string[]}  entryNames        The names of the entries in the scratch folder
 * @param   {string[]}  openFilePaths     The paths of all files that are open already
 * @param   {string}    scratchDirectory  The scratch folder
 * @param   {boolean}   caseInsensitive   Whether to ignore case (default: on Windows)
 *
 * @return  {string[]}                    The absolute paths to reopen
 */
export function selectScratchNotesToReopen (
  entryNames: string[],
  openFilePaths: string[],
  scratchDirectory: string,
  caseInsensitive = process.platform === 'win32'
): string[] {
  const openPaths = new Set(openFilePaths.map(filePath => normalizePathForComparison(filePath, caseInsensitive)))

  return entryNames
    .filter(name => isScratchNoteFileName(name))
    .sort(compareCodeUnits)
    .map(name => path.join(scratchDirectory, name))
    .filter(filePath => !openPaths.has(normalizePathForComparison(filePath, caseInsensitive)))
}

/**
 * Creates a new, empty scratch note file in the scratch folder, creating the
 * folder if necessary.
 *
 * @param   {string}           scratchDirectory  The scratch folder
 * @param   {Date}             date              The creation time
 *
 * @return  {Promise<string>}                    The absolute path of the new file
 */
export async function createScratchNoteFile (scratchDirectory: string, date: Date): Promise<string> {
  await fs.mkdir(scratchDirectory, { recursive: true })

  for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt++) {
    const existingNames = await fs.readdir(scratchDirectory)
    const scratchPath = path.join(scratchDirectory, scratchNoteFileName(date, existingNames))
    try {
      // The wx flag fails instead of overwriting a file created in the meantime
      await fs.writeFile(scratchPath, '', { encoding: 'utf-8', flag: 'wx' })
      return scratchPath
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        throw error
      }
    }
  }

  throw new Error(`Could not find a free scratch note name in ${scratchDirectory}`)
}

/**
 * Writes the latest content to a scratch note and moves it into the _Discarded
 * subfolder of its folder, with the discard time appended to its name.
 *
 * @param   {string}           scratchPath    The scratch note to discard
 * @param   {string}           latestContent  The latest content of the scratch note
 * @param   {Date}             discardDate    The discard time
 *
 * @return  {Promise<string>}                 The new path of the discarded note
 */
export async function moveScratchNoteToDiscarded (scratchPath: string, latestContent: string, discardDate: Date): Promise<string> {
  await fs.writeFile(scratchPath, latestContent, 'utf-8')

  const discardedDirectory = path.join(path.dirname(scratchPath), SCRATCH_DISCARDED_FOLDER)
  await fs.mkdir(discardedDirectory, { recursive: true })

  const existingNames = await fs.readdir(discardedDirectory)
  const discardedPath = path.join(discardedDirectory, discardedFileName(path.basename(scratchPath), discardDate, existingNames))
  await fs.rename(scratchPath, discardedPath)
  return discardedPath
}

/**
 * Writes the latest content to a closed scratch note that the user did not
 * save, and moves it into the __Unsaved folder of the undo history folder
 * (R135), with the close time appended to its name (see closedScratchFileName).
 * The __Unsaved folder is created if necessary. If the undo history folder is
 * on another drive, so that renaming fails with EXDEV, the note is copied
 * (never over an existing file), the copy's size is checked, and only then is
 * the scratch note deleted.
 *
 * @param   {string}           scratchPath    The scratch note to move
 * @param   {string}           latestContent  The latest content of the scratch note
 * @param   {Date}             closeDate      The close time
 * @param   {string}           historyRoot    The undo history folder
 *
 * @return  {Promise<string>}                 The new path of the closed note
 */
export async function moveScratchNoteToHistory (scratchPath: string, latestContent: string, closeDate: Date, historyRoot: string): Promise<string> {
  await fs.writeFile(scratchPath, latestContent, 'utf-8')

  const historyDirectory = path.join(historyRoot, SCRATCH_HISTORY_SUBFOLDER)
  await fs.mkdir(historyDirectory, { recursive: true })

  const existingNames = await fs.readdir(historyDirectory)
  const closedPath = path.join(historyDirectory, closedScratchFileName(path.basename(scratchPath), closeDate, existingNames))

  try {
    await fs.rename(scratchPath, closedPath)
  } catch (error) {
    if (errorCode(error) !== 'EXDEV') {
      throw error
    }

    // Another drive: copy, check the copy, and only then remove the original
    await fs.copyFile(scratchPath, closedPath, fsConstants.COPYFILE_EXCL)
    const sourceStats = await fs.stat(scratchPath)
    const copyStats = await fs.stat(closedPath)
    if (sourceStats.size !== copyStats.size) {
      await fs.unlink(closedPath)
      throw new Error(`Could not copy ${scratchPath} to ${closedPath}: the sizes differ`)
    }
    await fs.unlink(scratchPath)
  }

  return closedPath
}

/**
 * Deletes a scratch note file. A file that does not exist (anymore) is not an
 * error.
 *
 * @param   {string}         filePath  The scratch note to delete
 */
export async function deleteScratchNoteFile (filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath)
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      throw error
    }
  }
}
