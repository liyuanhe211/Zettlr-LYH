/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        UNSAVED_FILES_PATH, isScratchNoteTabPath,
 *                  collectUnsavedTabPaths, filterUnsavedTabPaths,
 *                  parseScratchNotesOnDisk, mergeUnsavedFilePaths,
 *                  selectHistoryPathsWithOpenTab
 * CVM-Role:        Utility function
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Decides which tabs are scratch notes (the Ctrl+N drafts of
 *                  R40, the drafts restored from a backup by R43, and drafts
 *                  the user has renamed, R102) and collects the scratch notes
 *                  open in this window, for the Unsaved Files virtual folder at
 *                  the top of the Files section (R96). The recognition rule is
 *                  the one of the main process function isScratchNotePath in
 *                  scratch-notes.ts, which this renderer module cannot import
 *                  because it depends on Node's path module. Both file name
 *                  rules must stay identical; test/unsaved-tab-paths.spec.ts
 *                  checks the two functions against each other.
 *
 *                  Since R144, Unsaved Files also lists the scratch notes with
 *                  content that lie in the scratch folder on disk without a
 *                  tab (parseScratchNotesOnDisk reads the answer of the
 *                  list-scratch-notes command, mergeUnsavedFilePaths puts the
 *                  two lists together), and the Files section lists only the
 *                  open history files that still have a tab in this window
 *                  (selectHistoryPathsWithOpenTab).
 *
 * END HEADER
 */

import type { LeafNodeJSON } from 'source/types/common/documents'
import { normalizeHistorySelectionPath } from './history-tree-selection'

/**
 * The identity of the Unsaved Files row. It is not a file system path and must
 * never be handed to anything that reads the disk, to the open history, or to
 * the select-file event (specification C1, R96 revision).
 */
export const UNSAVED_FILES_PATH = 'zettlr-lyh:unsaved-files'

const SCRATCH_NOTE_EXTENSION = '.md'

/**
 * Checks whether a file name can be the name of a scratch note. Same rule as
 * isScratchNoteFileName in scratch-notes.ts: the name ends in a lower case .md,
 * has a non-empty name in front of that extension, and does not start with a
 * dot or a tilde. Whether it looks like UNSAVED_<yyyymmdd>-<hhmmss>[_n].md does
 * not matter, since a scratch note can be renamed (R102).
 *
 * @param   {string}   name  The file name
 *
 * @return  {boolean}        True if the name is a valid scratch note file name
 */
function isScratchNoteFileName (name: string): boolean {
  return name.endsWith(SCRATCH_NOTE_EXTENSION) &&
    name.length > SCRATCH_NOTE_EXTENSION.length &&
    !name.startsWith('.') &&
    !name.startsWith('~')
}

/**
 * Splits a path into its parent folder and its file name, accepting both
 * separators.
 *
 * @param   {string}  filePath  The path
 *
 * @return  {{ parent: string, name: string }}  The two parts
 */
function splitParentAndName (filePath: string): { parent: string, name: string } {
  const trimmed = filePath.replace(/[\\/]+$/, '')
  const separatorIndex = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (separatorIndex < 0) {
    return { parent: '', name: trimmed }
  }

  const parent = trimmed.slice(0, separatorIndex)
  // A file directly in a drive root such as C:\ keeps its root separator
  return {
    parent: /^[a-z]:$/i.test(parent) || parent === '' ? trimmed.slice(0, separatorIndex + 1) : parent,
    name: trimmed.slice(separatorIndex + 1)
  }
}

/**
 * Checks whether the path of a tab points to a scratch note: its file name is a
 * valid scratch note file name (see isScratchNoteFileName above), and its parent
 * folder is the scratch folder itself, not a subfolder such as _Discarded. The
 * folders are compared by path identity: on Windows paths without regard to
 * case, with both separators treated alike and trailing separators ignored.
 *
 * @param   {string}   filePath          The path of the tab
 * @param   {string}   scratchDirectory  The configured scratch folder
 *
 * @return  {boolean}                    True if the tab is a scratch note
 */
export function isScratchNoteTabPath (filePath: string, scratchDirectory: string): boolean {
  if (scratchDirectory.trim() === '') {
    return false
  }

  const { parent, name } = splitParentAndName(filePath)
  if (!isScratchNoteFileName(name) || parent === '') {
    return false
  }

  return normalizeHistorySelectionPath(parent) === normalizeHistorySelectionPath(scratchDirectory.trim())
}

/**
 * Collects the scratch notes open as tabs in the editor panes of this window,
 * in pane order and, within each pane, in tab order. A scratch note open in
 * several panes is listed once, under the path of its first tab.
 *
 * @param   {LeafNodeJSON[]}  paneData          Every editor pane of this window
 * @param   {string}          scratchDirectory  The configured scratch folder
 *
 * @return  {string[]}                          The paths of the scratch notes
 */
export function collectUnsavedTabPaths (paneData: LeafNodeJSON[], scratchDirectory: string): string[] {
  const paths: string[] = []
  const seen = new Set<string>()

  for (const pane of paneData) {
    for (const openFile of pane.openFiles) {
      if (!isScratchNoteTabPath(openFile.path, scratchDirectory)) {
        continue
      }

      const identity = normalizeHistorySelectionPath(openFile.path)
      if (!seen.has(identity)) {
        seen.add(identity)
        paths.push(openFile.path)
      }
    }
  }

  return paths
}

/**
 * Applies the quick filter to the scratch notes. A scratch note stays if its
 * displayed text or its file name contains the query, ignoring case. An empty
 * query keeps every scratch note.
 *
 * @param   {string[]}                  paths    The paths of the scratch notes
 * @param   {string}                    query    The quick filter query
 * @param   {(path: string) => string}  labelOf  Returns the text a row shows
 *
 * @return  {string[]}                           The matching paths, in order
 */
export function filterUnsavedTabPaths (paths: string[], query: string, labelOf: (path: string) => string): string[] {
  const normalizedQuery = query.trim().toLowerCase()
  if (normalizedQuery === '') {
    return paths
  }

  return paths.filter(filePath => {
    const { name } = splitParentAndName(filePath)
    return labelOf(filePath).toLowerCase().includes(normalizedQuery) ||
      name.toLowerCase().includes(normalizedQuery)
  })
}

/**
 * A scratch note in the scratch folder on disk, as the list-scratch-notes
 * command of the main process reports it (R144).
 */
export interface ScratchNoteOnDisk {
  /** The absolute path of the file */
  path: string
  /** True if the file contains nothing but whitespace */
  blank: boolean
}

/**
 * Reads the answer of the list-scratch-notes command. Anything that does not
 * have the expected shape yields no scratch notes, and an entry that does not
 * say explicitly that it has content counts as blank, so that it is not listed.
 *
 * @param   {unknown}             result  The answer of the command
 *
 * @return  {ScratchNoteOnDisk[]}         The scratch notes on disk
 */
export function parseScratchNotesOnDisk (result: unknown): ScratchNoteOnDisk[] {
  if (typeof result !== 'object' || result === null) {
    return []
  }

  const notes: unknown = (result as { notes?: unknown }).notes
  if (!Array.isArray(notes)) {
    return []
  }

  const parsed: ScratchNoteOnDisk[] = []
  for (const note of notes as unknown[]) {
    if (typeof note !== 'object' || note === null) {
      continue
    }

    const { path: notePath, blank } = note as { path?: unknown, blank?: unknown }
    if (typeof notePath === 'string' && notePath !== '') {
      parsed.push({ path: notePath, blank: blank !== false })
    }
  }

  return parsed
}

/**
 * Puts together the scratch notes Unsaved Files lists (R144): first the scratch
 * notes open as tabs in this window, in the order given, which includes blank
 * ones because they are being edited; then the scratch notes on disk that have
 * content and no tab in this window, sorted by file name (UTF-16 code unit
 * order, ignoring case, so that the generated names come in creation order).
 * Blank scratch notes on disk are left out. Paths are compared by path identity,
 * so that a note is listed only once however its path is spelled.
 *
 * @param   {string[]}                    openDraftPaths  The scratch notes open as tabs
 * @param   {readonly ScratchNoteOnDisk[]}  notesOnDisk   The scratch notes on disk
 *
 * @return  {string[]}                                    The paths of the notes to list
 */
export function mergeUnsavedFilePaths (openDraftPaths: string[], notesOnDisk: readonly ScratchNoteOnDisk[]): string[] {
  const merged: string[] = []
  const seen = new Set<string>()

  for (const draftPath of openDraftPaths) {
    const identity = normalizeHistorySelectionPath(draftPath)
    if (!seen.has(identity)) {
      seen.add(identity)
      merged.push(draftPath)
    }
  }

  const withoutTab: Array<{ path: string, sortKey: string }> = []
  for (const note of notesOnDisk) {
    const identity = normalizeHistorySelectionPath(note.path)
    if (note.blank || seen.has(identity)) {
      continue
    }

    seen.add(identity)
    withoutTab.push({ path: note.path, sortKey: splitParentAndName(note.path).name.toLowerCase() })
  }

  withoutTab.sort((first, second) => {
    if (first.sortKey !== second.sortKey) {
      return first.sortKey < second.sortKey ? -1 : 1
    }

    return first.path < second.path ? -1 : first.path > second.path ? 1 : 0
  })

  return [ ...merged, ...withoutTab.map(note => note.path) ]
}

/**
 * Reduces the open history to the files that still have a tab in this window
 * (R144): a file leaves the Files section when its last tab is closed. The
 * history itself stays as it is; this only decides what is shown. The order of
 * the history, most recent first, is kept, and paths are compared by path
 * identity.
 *
 * @param   {string[]}  historyPaths  The open history, most recent first
 * @param   {string[]}  openTabPaths  The files open as tabs in this window
 *
 * @return  {string[]}                The history files that have a tab
 */
export function selectHistoryPathsWithOpenTab (historyPaths: string[], openTabPaths: string[]): string[] {
  const openIdentities = new Set(openTabPaths.map(normalizeHistorySelectionPath))
  return historyPaths.filter(historyPath => openIdentities.has(normalizeHistorySelectionPath(historyPath)))
}
