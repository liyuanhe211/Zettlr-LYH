/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        collectOpenTabPaths, filterOpenTabPaths,
 *                  findPanesWithOpenFile, selectFilesToReveal
 * CVM-Role:        Utility function
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Relates the Files section to the tabs open in this window:
 *                  the paths shown in the Show Only Folders with Open Tabs
 *                  mode (R87) and the quick filter applied to them, the editor
 *                  panes a middle click on a file row closes (R92), and the
 *                  files whose folder rows the tree unfolds by itself (R93).
 *                  All paths are compared by Windows path identity.
 *
 * END HEADER
 */

import type { LeafNodeJSON } from 'source/types/common/documents'
import { normalizeHistorySelectionPath } from './history-tree-selection'

/**
 * One tab of a file, as findPanesWithOpenFile reports it.
 */
export interface PaneWithOpenFile {
  /** The ID of the editor pane */
  leafId: string
  /** The path exactly as the tab itself spells it */
  tabPath: string
  /** Whether the tab is pinned in that pane */
  pinned: boolean
}

/**
 * The input of selectFilesToReveal.
 */
export interface FilesToRevealInput {
  /** The open history, most recent first */
  historyPaths: string[]
  /** The files open as tabs in this window */
  openTabPaths: string[]
  /** The document the user is looking at, if any */
  activeFile: string|undefined
  /** The active document of the previous computation */
  previousActiveFile: string|undefined
  /** The identities that the previous computation returned as nextRevealed */
  previouslyRevealed: ReadonlySet<string>
  /** How many of the most recent history files to keep on screen */
  recentCount: number
}

/**
 * The result of selectFilesToReveal.
 */
export interface FilesToReveal {
  /** The files whose folder rows to unfold now, spelled as in the history */
  reveal: string[]
  /** The identities to hand in as previouslyRevealed next time */
  nextRevealed: Set<string>
}

/**
 * Collects the files open as tabs in all editor panes of this window. A file
 * that is open in several panes, or under paths that differ only in Windows
 * casing or separators, is listed once, under the path of its first tab.
 * Files that are part of the open history come first, in history order; the
 * remaining ones follow in pane order and tab order.
 *
 * @param   {LeafNodeJSON[]}  paneData      Every editor pane of this window
 * @param   {string[]}        historyPaths  The open history, most recent first
 *
 * @return  {string[]}                      The paths of the open tabs
 */
export function collectOpenTabPaths (paneData: LeafNodeJSON[], historyPaths: string[]): string[] {
  const tabPaths: string[] = []
  const seenTabs = new Set<string>()

  for (const pane of paneData) {
    for (const openFile of pane.openFiles) {
      const identity = normalizeHistorySelectionPath(openFile.path)
      if (!seenTabs.has(identity)) {
        seenTabs.add(identity)
        tabPaths.push(openFile.path)
      }
    }
  }

  const historyIndex = new Map<string, number>()
  historyPaths.forEach((historyPath, index) => {
    const identity = normalizeHistorySelectionPath(historyPath)
    if (!historyIndex.has(identity)) {
      historyIndex.set(identity, index)
    }
  })

  const inHistory: Array<{ path: string, index: number }> = []
  const outsideHistory: string[] = []

  for (const tabPath of tabPaths) {
    const index = historyIndex.get(normalizeHistorySelectionPath(tabPath))
    if (index === undefined) {
      outsideHistory.push(tabPath)
    } else {
      inHistory.push({ path: tabPath, index })
    }
  }

  inHistory.sort((first, second) => first.index - second.index)
  return [ ...inHistory.map(entry => entry.path), ...outsideHistory ]
}

/**
 * Applies the quick filter to the paths of the open tabs. A path stays if the
 * workspace descriptors already matched it, or if its file name contains the
 * query, ignoring case. The latter covers tabs without a descriptor, such as
 * PDF files.
 *
 * @param   {string[]}  paths          The paths of the open tabs
 * @param   {string}    query          The quick filter query
 * @param   {string[]}  filterResults  The paths the descriptor filter matched
 *
 * @return  {string[]}                 The paths that match the filter
 */
export function filterOpenTabPaths (paths: string[], query: string, filterResults: string[]): string[] {
  const normalizedQuery = query.trim().toLowerCase()
  if (normalizedQuery === '') {
    return paths
  }

  const matchedIdentities = new Set(filterResults.map(normalizeHistorySelectionPath))

  return paths.filter(tabPath => {
    if (matchedIdentities.has(normalizeHistorySelectionPath(tabPath))) {
      return true
    }

    const segments = tabPath.split(/[\\/]/)
    const fileName = segments[segments.length - 1] ?? ''
    return fileName.toLowerCase().includes(normalizedQuery)
  })
}

/**
 * Finds every editor pane of this window that has the given file open as a
 * tab (R92). The tab path is returned as the tab spells it, because the main
 * process matches tabs by exact string.
 *
 * @param   {LeafNodeJSON[]}      paneData  Every editor pane of this window
 * @param   {string}              filePath  The file to look for
 *
 * @return  {PaneWithOpenFile[]}            One entry per pane, in pane order
 */
export function findPanesWithOpenFile (paneData: LeafNodeJSON[], filePath: string): PaneWithOpenFile[] {
  const identity = normalizeHistorySelectionPath(filePath)
  const panes: PaneWithOpenFile[] = []

  for (const pane of paneData) {
    const tab = pane.openFiles.find(openFile => normalizeHistorySelectionPath(openFile.path) === identity)
    if (tab !== undefined) {
      panes.push({ leafId: pane.id, tabPath: tab.path, pinned: tab.pinned })
    }
  }

  return panes
}

/**
 * Decides which files the Files section unfolds the folder rows for (R93).
 * The files worth keeping on screen are the most recent history files, the
 * active document and every file open as a tab. Of these, a file is revealed
 * when it newly joins that group, and the active document whenever it changes;
 * a file that stays in the group is not revealed again, so that a row the user
 * has folded up stays folded.
 *
 * Only files that are part of the open history count: the others have no row
 * in the tree. A tab file that is not yet in the history (the history may be
 * updated a moment after the tabs) is therefore revealed once it arrives.
 *
 * @param   {FilesToRevealInput}  input  The current state and the records
 *                                       of the previous computation
 *
 * @return  {FilesToReveal}              The files to reveal, spelled as in
 *                                       the history, and the new record
 */
export function selectFilesToReveal (input: FilesToRevealInput): FilesToReveal {
  const historyByIdentity = new Map<string, string>()
  for (const historyPath of input.historyPaths) {
    const identity = normalizeHistorySelectionPath(historyPath)
    if (!historyByIdentity.has(identity)) {
      historyByIdentity.set(identity, historyPath)
    }
  }

  const candidates = [
    ...input.historyPaths.slice(0, Math.max(0, input.recentCount)),
    ...(input.activeFile !== undefined ? [input.activeFile] : []),
    ...input.openTabPaths
  ]

  const reveal: string[] = []
  const nextRevealed = new Set<string>()

  for (const candidate of candidates) {
    const identity = normalizeHistorySelectionPath(candidate)
    const historyPath = historyByIdentity.get(identity)
    if (historyPath === undefined || nextRevealed.has(identity)) {
      continue
    }

    nextRevealed.add(identity)
    if (!input.previouslyRevealed.has(identity)) {
      reveal.push(historyPath)
    }
  }

  if (input.activeFile !== undefined) {
    const activeIdentity = normalizeHistorySelectionPath(input.activeFile)
    const previousIdentity = input.previousActiveFile === undefined
      ? undefined
      : normalizeHistorySelectionPath(input.previousActiveFile)
    const historyPath = historyByIdentity.get(activeIdentity)

    if (activeIdentity !== previousIdentity && historyPath !== undefined && !reveal.includes(historyPath)) {
      reveal.push(historyPath)
    }
  }

  return { reveal, nextRevealed }
}
