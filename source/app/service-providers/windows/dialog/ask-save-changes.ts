/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        promptDialog
 * CVM-Role:        Utility function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Prompts the user with some information
 *
 * END HEADER
 */

import {
  dialog,
  type BrowserWindow,
  type MessageBoxOptions,
  type MessageBoxReturnValue
} from 'electron'
import { trans } from '@common/i18n-main'

/**
 * Displays a prompt to ask the user if they want to save the files first
 *
 * @param   {BrowserWindow|null}  win       The window to attach to
 * @param   {string}              [detail]  An optional string to display in the
 *                                          `detail` section of the dialogue.
 */
export default async function askSaveChanges (win: BrowserWindow|null, detail?: string): Promise<MessageBoxReturnValue> {
  const boxOptions: MessageBoxOptions = {
    type: 'warning',
    buttons: [
      trans('Yes'), // 0: Save all changes
      trans('No'), // 1: Omit all changes
      trans('Cancel') // 2: Abort whatever is happening
    ],
    defaultId: 0,
    cancelId: 2, // If the user cancels, do not omit (the default) but actually cancel
    title: trans('Unsaved changes'),
    message: trans('There are unsaved changes. Do you want to save them first?'),
    detail,
  }

  // DEBUG: Trying to resolve bug #1645, which seems to relate to modal status
  // vs. promise awaits. UPDATE 2024-03-11: In response to #4952, removing the
  // platform check again.
  if (win !== null) {
    return await dialog.showMessageBox(win, boxOptions)
  } else {
    return await dialog.showMessageBox(boxOptions)
  }
}

/**
 * Zettlr-LYH Windows dialog (R72): the question for one file of a batch close
 * of several files. Next to Save, Don't Save and Cancel (which keeps this file
 * and goes on with the next one), Keep All keeps this file and every later
 * file with unsaved changes, and Discard All Changes closes them all without
 * saving. The button order matches BATCH_CLOSE_RESPONSE of
 * documents/close-files-batch.ts.
 *
 * @param   {BrowserWindow|null}  win       The window to attach to
 * @param   {string}              [detail]  An optional string to display in the
 *                                          `detail` section of the dialogue.
 */
export async function askSaveChangesInBatch (win: BrowserWindow|null, detail?: string): Promise<MessageBoxReturnValue> {
  const boxOptions: MessageBoxOptions = {
    type: 'warning',
    buttons: [
      trans('Save'), // 0: Save this file, then close it
      trans('Don\'t Save'), // 1: Close this file without saving
      trans('Cancel'), // 2: Keep this file open, go on with the next one
      trans('Keep All'), // 3: Keep this and every later unsaved file open
      trans('Discard All Changes') // 4: Close this and every later unsaved file without saving
    ],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    title: trans('Unsaved changes'),
    message: trans('There are unsaved changes. Do you want to save them first?'),
    detail
  }

  if (win !== null) {
    return await dialog.showMessageBox(win, boxOptions)
  } else {
    return await dialog.showMessageBox(boxOptions)
  }
}
