/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        updateOpenHistory
 * CVM-Role:        Utility Function
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Maintains the "recently opened files" history that backs the
 *                  Files section of the file manager. The history is a plain
 *                  array of absolute paths, most recently opened first, capped
 *                  at OPEN_HISTORY_LIMIT entries. This module deliberately has
 *                  no Electron or filesystem dependencies so that it can be
 *                  unit-tested directly.
 *
 * END HEADER
 */

/**
 * The maximum amount of files the open history retains. Older entries are
 * dropped from the end of the history.
 *
 * @var {number}
 */
export const OPEN_HISTORY_LIMIT = 200

/**
 * Merges a single open event into the open history. The most recently opened
 * file resides at index 0. If openedPath is already part of the history, it is
 * moved to the front; otherwise it is inserted at the front. Afterwards the
 * result is truncated to at most limit entries. The passed array is never
 * modified; a new array is returned instead.
 *
 * @param   {string[]}  history     The current open history, newest first
 * @param   {string}    openedPath  The absolute path that has just been opened
 * @param   {number}    limit       The maximum history length
 *
 * @return  {string[]}              The updated open history, newest first
 */
export function updateOpenHistory (
  history: string[],
  openedPath: string,
  limit: number = OPEN_HISTORY_LIMIT
): string[] {
  const updatedHistory = [ openedPath, ...history.filter(entry => entry !== openedPath) ]

  if (limit < 0) {
    return updatedHistory
  }

  return updatedHistory.slice(0, limit)
}
