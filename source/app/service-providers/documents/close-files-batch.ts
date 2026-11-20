/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Decisions of the batch close of the Windows dialog
 * CVM-Role:        Utility functions
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH Windows dialog (R72): when the Windows dialog
 *                  closes several files at once, every file with unsaved
 *                  changes is asked about with a five-button question (Save,
 *                  Don't Save, Cancel, Keep All, Discard All Changes). Cancel
 *                  keeps that file and moves on to the next one; Keep All and
 *                  Discard All Changes settle this file and every later file
 *                  with unsaved changes without asking again. This module
 *                  decides, from the question's answer and the current batch
 *                  mode, what happens to one file and what the mode becomes.
 *                  It imports nothing at runtime, so that it stays
 *                  unit-testable outside of Electron.
 *
 * END HEADER
 */

/**
 * The buttons of the batch question, in order (the message box returns the
 * index of the clicked button)
 */
export const BATCH_CLOSE_RESPONSE = {
  save: 0,
  dontSave: 1,
  cancel: 2,
  keepAll: 3,
  discardAll: 4
} as const

/**
 * Whether later files with unsaved changes are still asked about (none), all
 * kept open (keepAll), or all closed without saving (discardAll)
 */
export type BatchCloseMode = 'none'|'keepAll'|'discardAll'

/**
 * What happens to one file of the batch: close it (it has no unsaved changes,
 * or other tabs keep the document open), save and then close it, close it
 * discarding its changes, keep it open, or skip it because all its tabs are
 * pinned (pinned tabs are never closed)
 */
export type BatchCloseAction = 'close'|'save'|'discard'|'keep'|'skip'

/**
 * The part of a file's state the decision needs
 */
export interface BatchCloseFileState {
  /**
   * True if the file has no tab in the window that may be closed, i.e. all of
   * its tabs there are pinned
   */
  allTabsPinned: boolean
  /**
   * True if closing the file's tabs would drop a document with unsaved
   * changes, so that the user would normally be asked
   */
  needsQuestion: boolean
}

/**
 * Whether the batch has to ask the user about this file.
 *
 * @param   {BatchCloseMode}       mode  The current batch mode
 * @param   {BatchCloseFileState}  file  The file
 *
 * @return  {boolean}                    True if the question must be shown
 */
export function batchCloseNeedsQuestion (mode: BatchCloseMode, file: BatchCloseFileState): boolean {
  return !file.allTabsPinned && file.needsQuestion && mode === 'none'
}

/**
 * Decides what happens to one file of the batch, and the batch mode for the
 * files after it. The response is the index of the clicked button of the
 * batch question; it is only used when the question was needed (see
 * batchCloseNeedsQuestion). A missing or unknown response counts as Cancel.
 *
 * @param   {BatchCloseMode}       mode        The current batch mode
 * @param   {BatchCloseFileState}  file        The file
 * @param   {number}               [response]  The clicked button, if asked
 *
 * @return  {{ action: BatchCloseAction, mode: BatchCloseMode }}  The decision
 */
export function decideBatchCloseAction (
  mode: BatchCloseMode,
  file: BatchCloseFileState,
  response?: number
): { action: BatchCloseAction, mode: BatchCloseMode } {
  if (file.allTabsPinned) {
    return { action: 'skip', mode }
  }
  if (!file.needsQuestion) {
    return { action: 'close', mode }
  }
  if (mode === 'keepAll') {
    return { action: 'keep', mode }
  }
  if (mode === 'discardAll') {
    return { action: 'discard', mode }
  }
  switch (response) {
    case BATCH_CLOSE_RESPONSE.save:
      return { action: 'save', mode }
    case BATCH_CLOSE_RESPONSE.dontSave:
      return { action: 'discard', mode }
    case BATCH_CLOSE_RESPONSE.keepAll:
      return { action: 'keep', mode: 'keepAll' }
    case BATCH_CLOSE_RESPONSE.discardAll:
      return { action: 'discard', mode: 'discardAll' }
    default:
      return { action: 'keep', mode }
  }
}
