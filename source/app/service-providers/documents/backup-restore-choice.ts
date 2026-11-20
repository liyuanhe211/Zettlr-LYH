/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Backup restore choice
 * CVM-Role:        Utility
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH backup restore choice (R50): Builds the dialog
 *                  that asks the user which version of a file to open when the
 *                  backup cache holds unsaved changes that differ from the
 *                  file on disk, and maps the clicked button to an action.
 *                  This module is pure (no Electron imports) so it can be
 *                  tested in isolation.
 *
 * END HEADER
 */

/**
 * Why the backup cache holds unsaved changes for the file being opened:
 * 'session-restore' if the document still counted as open (it is part of the
 * session being restored after a restart), 'reopened-after-close' if it had
 * been closed without saving and is now opened again.
 */
import { formatVersionSize, formatVersionTimestamp } from './remote-change-dialog'

export type BackupRestoreSituation = 'session-restore'|'reopened-after-close'

/**
 * What to do after the dialog: open the version with unsaved changes from the
 * backup, or discard the backup and open the file as it is on disk.
 */
export type BackupRestoreAction = 'restore'|'load-disk'

export interface BackupRestoreChoiceInput {
  situation: BackupRestoreSituation
  /** The file name (without directory) shown in the dialog */
  fileName: string
  /** Timestamp (ms since epoch) of the last edit stored in the backup */
  backupEditedAt: number|undefined
  /** UTF-8 bytes after applying the serialization used on restoration */
  backupSize?: number
  /** Timestamp (ms since epoch) of the last modification of the file on disk */
  diskModifiedAt: number|undefined
  diskSize?: number
  /** Formats a timestamp for display; passed in to keep this module pure */
  formatTime: (timestamp: number) => string
  formatSize?: (bytes: number) => string
}

/**
 * The subset of Electron's MessageBoxOptions this dialog uses. Structurally
 * compatible with MessageBoxOptions, so it can be passed to
 * dialog.showMessageBox directly.
 */
export interface BackupRestoreDialogOptions {
  type: 'question'
  title: string
  message: string
  detail: string
  buttons: string[]
  defaultId: number
  cancelId: number
  noLink: boolean
}

/** Button index of "Open the Version With Unsaved Changes" (the default) */
export const RESTORE_BUTTON_INDEX = 0
/** Button index of "Open the File From Disk" (discards the backup) */
export const LOAD_DISK_BUTTON_INDEX = 1

/**
 * Builds the options of the dialog asking which version of a file to open.
 * Both situations share the same structure; only the first sentence of the
 * detail text differs. Escape (cancelId) keeps the unsaved changes, so that
 * dismissing the dialog never loses data.
 *
 * @param   {BackupRestoreChoiceInput}    input  The file and its two versions
 *
 * @return  {BackupRestoreDialogOptions}         The dialog options
 */
export function buildBackupRestoreDialogOptions (input: BackupRestoreChoiceInput): BackupRestoreDialogOptions {
  const formatSize = input.formatSize ?? ((bytes: number) => `${bytes} bytes`)
  const explanation = input.situation === 'session-restore'
    ? 'Zettlr is about to open a version of this file that contains unsaved changes from your last session, which differs from the file on disk. Choose which version to open.'
    : 'This file was closed without saving, but Zettlr has retained the unsaved changes, which differ from the file on disk. Choose which version to open.'

  const buttons: string[] = []
  buttons[RESTORE_BUTTON_INDEX] = 'Open the Version With Unsaved Changes'
  buttons[LOAD_DISK_BUTTON_INDEX] = 'Open the File From Disk'

  return {
    type: 'question',
    title: 'Unsaved Changes Found',
    message: `"${input.fileName}" has unsaved changes`,
    detail: explanation + '\n\n' +
      `Cached unsaved version: last edited ${formatVersionTimestamp(input.backupEditedAt, input.formatTime)}, size ${formatVersionSize(input.backupSize, formatSize)}\n` +
      `Disk version: modified ${formatVersionTimestamp(input.diskModifiedAt, input.formatTime)}, size ${formatVersionSize(input.diskSize, formatSize)}`,
    buttons,
    defaultId: RESTORE_BUTTON_INDEX,
    cancelId: RESTORE_BUTTON_INDEX,
    noLink: true
  }
}

/**
 * Maps the index of the clicked dialog button to the action to perform. Only
 * the "Open the File From Disk" button discards the backup; any other
 * response (including an unexpected one) keeps the unsaved changes.
 *
 * @param   {number}               response  The button index from the dialog
 *
 * @return  {BackupRestoreAction}            The action to perform
 */
export function backupRestoreActionForResponse (response: number): BackupRestoreAction {
  return response === LOAD_DISK_BUTTON_INDEX ? 'load-disk' : 'restore'
}
