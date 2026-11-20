/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        readScratchNotes, ScratchNoteOnDiskEntry
 * CVM-Role:        Utility function
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Reads the scratch notes (R40, R102) that lie directly in the
 *                  scratch folder on disk and tells which of them are blank. The
 *                  list-scratch-notes command (R144) answers with this. The
 *                  function depends on neither electron nor the application
 *                  services, so that it can be tested directly.
 *
 * END HEADER
 */

import { promises as fs } from 'fs'
import path from 'path'
import { isBlankScratchContent, isScratchNotePath } from '../documents/scratch-notes'

/**
 * One scratch note in the scratch folder.
 */
export interface ScratchNoteOnDiskEntry {
  /** The absolute path of the file */
  path: string
  /** True if the file contains nothing but whitespace */
  blank: boolean
}

/**
 * Compares two strings by their UTF-16 code units, which puts the generated
 * names UNSAVED_<time>[_n].md in creation order.
 *
 * @param   {string}  first   The first string
 * @param   {string}  second  The second string
 *
 * @return  {number}          Negative, zero or positive, as for sort
 */
function compareCodeUnits (first: string, second: string): number {
  if (first < second) {
    return -1
  }

  return first > second ? 1 : 0
}

/**
 * Reads the scratch notes directly in a scratch folder. Subfolders are not
 * entered, so the discarded notes in _Discarded are never found. A folder that
 * does not exist has no scratch notes. A file that cannot be read is skipped and
 * reported through onFailure, and so is a folder that cannot be listed.
 *
 * @param   {string}                                     directory  The absolute scratch folder
 * @param   {(message: string, error: unknown) => void}  onFailure  Called for every failure
 *
 * @return  {Promise<ScratchNoteOnDiskEntry[]>}                     The scratch notes, sorted by file name
 */
export async function readScratchNotes (
  directory: string,
  onFailure: (message: string, error: unknown) => void
): Promise<ScratchNoteOnDiskEntry[]> {
  let names: string[]
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    names = entries
      .filter(entry => entry.isFile())
      .map(entry => entry.name)
      .filter(name => isScratchNotePath(path.join(directory, name), directory))
      .sort(compareCodeUnits)
  } catch (error) {
    const code = (error as { code?: unknown }).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      onFailure(`Could not list the scratch notes in ${directory}`, error)
    }
    return []
  }

  const notes = await Promise.all(names.map(async (name): Promise<ScratchNoteOnDiskEntry|undefined> => {
    const filePath = path.join(directory, name)
    try {
      const content = await fs.readFile(filePath, 'utf-8')
      return { path: filePath, blank: isBlankScratchContent(content) }
    } catch (error) {
      onFailure(`Could not read the scratch note ${filePath}`, error)
      return undefined
    }
  }))

  return notes.filter((note): note is ScratchNoteOnDiskEntry => note !== undefined)
}
