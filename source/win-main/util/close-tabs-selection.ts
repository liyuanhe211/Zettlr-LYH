/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        selectTabsToClose
 * CVM-Role:        Utility function
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Decides which tabs of an editor pane the Close all tabs and
 *                  the Close All Saved Tabs items of the tab context menu close
 *                  (R144). Neither item ever closes a scratch note (a draft of
 *                  the Unsaved Files folder, R40, R96) or a pinned tab; Close
 *                  All Saved Tabs additionally keeps every tab whose document
 *                  has unsaved modifications. The tab context menu sends one
 *                  close-file request for each path returned here.
 *
 * END HEADER
 */

/**
 * Which items of the tab context menu a selection is made for: 'all' for
 * Close all tabs, 'saved' for Close All Saved Tabs.
 */
export type CloseTabsMode = 'all'|'saved'

/**
 * The part of a tab that decides whether it is closed.
 */
export interface CloseTabsCandidate {
  /** The path of the tab */
  path: string
  /** Whether the tab is pinned */
  pinned: boolean
}

/**
 * Selects the tabs that a bulk close request closes, in tab order. Scratch
 * notes and pinned tabs are never selected. In 'saved' mode, tabs with unsaved
 * modifications are left out as well, so that closing them never asks anything.
 *
 * @param   {CloseTabsCandidate[]}      tabs           The tabs of the editor pane
 * @param   {readonly string[]}         modifiedPaths  The paths of the documents with unsaved modifications
 * @param   {(path: string) => boolean} isScratchNote  Tells whether the path of a tab is a scratch note
 * @param   {CloseTabsMode}             mode           'all' or 'saved'
 *
 * @return  {string[]}                                 The paths of the tabs to close
 */
export function selectTabsToClose (
  tabs: readonly CloseTabsCandidate[],
  modifiedPaths: readonly string[],
  isScratchNote: (path: string) => boolean,
  mode: CloseTabsMode
): string[] {
  const modified = new Set(modifiedPaths)

  return tabs
    .filter(tab => {
      if (tab.pinned || isScratchNote(tab.path)) {
        return false
      }

      return mode === 'all' || !modified.has(tab.path)
    })
    .map(tab => tab.path)
}
