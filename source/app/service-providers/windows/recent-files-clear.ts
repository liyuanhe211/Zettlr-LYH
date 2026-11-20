/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        clearRecentFilesHistory, confirmClearRecentFiles
 * CVM-Role:        Controller
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH (R97): clears the recent files history on
 *                  request of the Recent Files window after the user confirms
 *                  in a dialog parented to that window.
 *
 * END HEADER
 */

import { dialog, type BrowserWindow } from 'electron'
import type RecentDocumentsProvider from '@providers/recent-docs'
import type { RecentFilesClearResult } from '@dts/common/recent-files'

/**
 * Asks the user whether to clear the history; resolves to true only when the
 * user chose Clear.
 */
export type RecentFilesClearConfirmation = (parent: BrowserWindow, fileCount: number) => Promise<boolean>

/**
 * The production confirmation dialog: Clear and Cancel, Cancel is the default
 * and the cancel button.
 */
export async function confirmClearRecentFiles (parent: BrowserWindow, fileCount: number): Promise<boolean> {
  const result = await dialog.showMessageBox(parent, {
    type: 'question',
    title: 'Clear Recent Files',
    message: fileCount === 1
      ? 'Remove the 1 file from the recent files history?'
      : `Remove all ${fileCount} files from the recent files history?`,
    detail: 'The files themselves are not changed.',
    buttons: [ 'Clear', 'Cancel' ],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  })
  return result.response === 0
}

/**
 * Clears the complete recent files history after confirmation. An empty
 * history returns without showing the dialog; Cancel leaves the history
 * untouched. The caller must already have verified that the request came from
 * the Recent Files window itself.
 */
export async function clearRecentFilesHistory (
  historyWindow: BrowserWindow,
  recentDocs: Pick<RecentDocumentsProvider, 'getAll'|'clear'>,
  confirm: RecentFilesClearConfirmation = confirmClearRecentFiles
): Promise<RecentFilesClearResult> {
  const fileCount = recentDocs.getAll().length
  if (fileCount === 0) {
    return { cleared: false }
  }
  const confirmed = await confirm(historyWindow, fileCount)
  if (!confirmed || historyWindow.isDestroyed()) {
    return { cleared: false }
  }
  recentDocs.clear()
  return { cleared: true }
}
