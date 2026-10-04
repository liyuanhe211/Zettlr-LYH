/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Toggle Comment with Cursor Placement
 * CVM-Role:        Command
 * License:         GNU GPL v3
 *
 * Description:     A thin wrapper around CodeMirror's toggleComment command.
 *                  Markdown only defines block comment tokens (<!-- and -->),
 *                  so toggleComment falls back to commenting whole lines with
 *                  block comments. On an empty (or whitespace-only) line this
 *                  inserts the empty comment "<!--  -->", but the default
 *                  selection mapping leaves the cursor in front of "<!--".
 *                  This wrapper detects such freshly inserted empty comments
 *                  and places the cursor between the two spaces, so the user
 *                  can immediately start typing the comment's content. All
 *                  other cases keep toggleComment's original behavior.
 *
 * END HEADER
 */

import {
  EditorSelection,
  type StateCommand,
  type Transaction
} from '@codemirror/state'
import { toggleComment, type CommentTokens } from '@codemirror/commands'

/**
 * Collects the positions (in the new document of the transaction) that lie
 * exactly between the two spaces of every empty block comment the transaction
 * has inserted.
 *
 * An empty block comment is recognized when all of the following hold:
 *
 * 1. The change is a pure insertion (nothing was deleted at that spot).
 * 2. The inserted text is exactly `open + "  " + close`, using the block
 *    comment tokens that the language data provides at the insertion point in
 *    the start state (the same lookup toggleComment itself performs). For
 *    Markdown this is "<!--  -->". toggleComment inserts the opening and the
 *    closing token as two separate changes at the start and end of the
 *    commented range; they only merge into this one insertion when that range
 *    is empty, i.e. when the line contained nothing but whitespace.
 * 3. In the new document, the line holding the insertion consists of nothing
 *    but whitespace and this empty comment. This double-checks that no
 *    existing content was wrapped.
 *
 * Uncommenting only deletes text, and commenting a non-empty range produces
 * two separate insertions, so neither can match.
 *
 * @param   {Transaction}  transaction  The transaction to inspect
 *
 * @return  {number[]}                  Target cursor positions, one per
 *                                      inserted empty comment
 */
export function findEmptyCommentCursorPositions (transaction: Transaction): number[] {
  const positions: number[] = []
  const startState = transaction.startState
  const newDocument = transaction.newDoc

  transaction.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    if (fromA !== toA) {
      return // Not a pure insertion
    }

    const tokenData = startState.languageDataAt<CommentTokens>('commentTokens', fromA, 1)
    const blockTokens = tokenData.length > 0 ? tokenData[0].block : undefined
    if (blockTokens === undefined) {
      return
    }

    const emptyComment = blockTokens.open + '  ' + blockTokens.close
    if (inserted.toString() !== emptyComment) {
      return
    }

    const line = newDocument.lineAt(fromB)
    if (line.text.trim() !== emptyComment) {
      return
    }

    positions.push(fromB + blockTokens.open.length + 1)
  })

  return positions
}

/**
 * Computes the selection that should result from the given toggle comment
 * transaction: every selection range that sits on a line where an empty
 * comment has just been inserted is collapsed to a cursor between the two
 * spaces of that comment. Ranges on other lines (e.g., on lines whose existing
 * content has just been wrapped in a comment) keep their mapped position.
 * This handles every selection range, so multiple cursors are supported.
 *
 * A range is only moved if both of its ends lie on the comment's line; a
 * selection that spans several lines is left as toggleComment mapped it.
 *
 * @param   {Transaction}            transaction  The transaction produced by
 *                                                toggleComment
 *
 * @return  {EditorSelection|null}                The adjusted selection, or
 *                                                null if nothing needs to move
 */
export function selectionInsideEmptyComments (transaction: Transaction): EditorSelection|null {
  const positions = findEmptyCommentCursorPositions(transaction)
  if (positions.length === 0) {
    return null
  }

  const newDocument = transaction.newDoc
  const mappedSelection = transaction.newSelection
  let hasMovedRange = false

  const ranges = mappedSelection.ranges.map(range => {
    const anchorLine = newDocument.lineAt(range.anchor)
    const headLine = newDocument.lineAt(range.head)
    if (anchorLine.number !== headLine.number) {
      return range
    }

    const target = positions.find(position => position >= headLine.from && position <= headLine.to)
    if (target === undefined) {
      return range
    }

    hasMovedRange = true
    return EditorSelection.cursor(target)
  })

  if (!hasMovedRange) {
    return null
  }

  return EditorSelection.create(ranges, mappedSelection.mainIndex)
}

/**
 * Toggles comments exactly like CodeMirror's toggleComment, but when this
 * inserts an empty comment (e.g., "<!--  -->" on an empty line), the cursor is
 * placed between the two spaces instead of in front of the comment.
 *
 * @param   {StateCommandTarget}  target  The editor state and dispatcher
 *
 * @return  {boolean}                     Whether the command has been handled
 */
export const toggleCommentWithCursorInside: StateCommand = ({ state, dispatch }) => {
  const transactions: Transaction[] = []
  const handled = toggleComment({
    state,
    dispatch: (transaction: Transaction) => { transactions.push(transaction) }
  })

  if (!handled) {
    return false
  }

  for (const transaction of transactions) {
    const selection = transaction.docChanged ? selectionInsideEmptyComments(transaction) : null
    if (selection === null) {
      dispatch(transaction)
      continue
    }

    // Rebuild the same transaction with the adjusted selection. toggleComment
    // itself only provides changes (and, for line comments, a selection), so
    // nothing else needs to be carried over besides effects and scrolling.
    dispatch(transaction.startState.update({
      changes: transaction.changes,
      selection,
      effects: transaction.effects,
      scrollIntoView: transaction.scrollIntoView
    }))
  }

  return true
}
