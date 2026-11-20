/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Mark LYH Revise command
 * CVM-Role:        Command
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH: marks a passage for revision by wrapping every
 *                  non-empty selection range as "[selection{}]" and inserting
 *                  an empty Revise Comment "[{}]" at every plain cursor, in
 *                  both cases leaving a cursor between the curly braces, so
 *                  that the revision comment can be typed right away (R76,
 *                  R108). Bound to Mod-r in the default keymap and to the
 *                  toolbar button Mark LYH Revise.
 *
 * END HEADER
 */

import {
  EditorSelection,
  type EditorState,
  type StateCommand,
  type TransactionSpec
} from '@codemirror/state'

/**
 * Text inserted in front of each wrapped selection range
 */
export const REVISION_MARK_OPEN = '['

/**
 * Text inserted behind each wrapped selection range: the empty comment slot
 * followed by the closing bracket
 */
export const REVISION_MARK_CLOSE = '{}]'

/**
 * Computes the transaction that wraps every non-empty selection range of the
 * state as "[selection{}]" and inserts an empty Revise Comment "[{}]" at every
 * empty range (plain cursor). Every range becomes an empty cursor between its
 * own curly braces; with mixed empty and non-empty ranges each one follows its
 * own rule. The main selection range stays the main one. The selected text
 * itself is never altered, including any brackets or braces it contains, and a
 * range may span several lines.
 *
 * The transaction carries no user event, so that Track Changes does not record
 * the inserted brackets and braces as an insertion (spec C10, rule 9).
 *
 * @param   {EditorState}           state  The state to compute the changes for
 *
 * @return  {TransactionSpec|null}         The transaction, or null if the
 *                                         state is read-only
 */
export function markLyhReviseTransaction (state: EditorState): TransactionSpec|null {
  if (state.readOnly) {
    return null
  }

  const { changes, selection, effects } = state.changeByRange(range => {
    if (range.empty) {
      return {
        changes: { from: range.from, insert: REVISION_MARK_OPEN + REVISION_MARK_CLOSE },
        // The cursor goes right behind the opening brace of the empty comment
        range: EditorSelection.cursor(range.from + REVISION_MARK_OPEN.length + 1)
      }
    }

    return {
      changes: [
        { from: range.from, insert: REVISION_MARK_OPEN },
        { from: range.to, insert: REVISION_MARK_CLOSE }
      ],
      // The returned range lives in the document after this range's own
      // changes: the opening bracket shifts the end of the selected text by
      // its length, and the cursor goes right behind the opening brace.
      range: EditorSelection.cursor(range.to + REVISION_MARK_OPEN.length + 1)
    }
  })

  return { changes, selection, effects, scrollIntoView: true }
}

/**
 * Wraps every non-empty selection range as "[selection{}]", inserts "[{}]" at
 * every plain cursor and places each cursor between the curly braces (see
 * markLyhReviseTransaction). Returns false without dispatching anything only
 * when the state is read-only. Ctrl+R / Cmd+R is bound to nothing else (the
 * Rename file menu item uses F2, R108), so the key does nothing while the
 * focus is outside the editor.
 *
 * @param   {StateCommandTarget}  target  The editor state and dispatcher
 *
 * @return  {boolean}                     Whether the command has been handled
 */
export const markLyhRevise: StateCommand = ({ state, dispatch }) => {
  const transaction = markLyhReviseTransaction(state)
  if (transaction === null) {
    return false
  }

  dispatch(state.update(transaction))
  return true
}
