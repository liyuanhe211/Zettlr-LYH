/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Data exchange functions
 * CVM-Role:        Utility Function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file contains the data exchange functionality to
 *                  exchange transaction data between a subview of the table
 *                  editor, and the main view.
 *
 * END HEADER
 */

import { Annotation, Transaction } from '@codemirror/state'
import { type EditorView } from '@codemirror/view'

/**
 * This syncAnnotation is used to tag all transactions originating from the main
 * EditorView when dispatching them to the subview to ensure they don't get
 * re-emitted.
 */
export const syncAnnotation = Annotation.define<boolean>()

export function dispatchFromSubview (mainView: EditorView): (tr: Transaction, subview: EditorView) => void {
  return (tr: Transaction, subview: EditorView) => {
    subview.update([tr])
    if (tr.annotation(Transaction.userEvent) === undefined) {
      // E.g., the subview's own parser has finished and the cell has been
      // re-highlighted
      restoreDomSelection(subview)
    }
    if (tr.annotation(syncAnnotation) === undefined && (tr.docChanged || tr.effects.length > 0)) {
      const annotations: Annotation<any>[] = [syncAnnotation.of(true)]
      const userEvent = tr.annotation(Transaction.userEvent)
      if (userEvent !== undefined) {
        annotations.push(Transaction.userEvent.of(userEvent))
      }
      // The TransactionSpecs will be merged, with
      // the new annotations being appended to the
      // end of the existing annotations list
      const hadFocus = subview.hasFocus
      mainView.dispatch(tr, { annotations })
      if (hadFocus && !subview.hasFocus) {
        // The end of a pointer selection (`select.pointer`) makes the main
        // view write its own selection into the DOM, which takes the focus
        // and the DOM selection away from the cell's editor. The cursor then
        // shows up at the start of the table instead of where the user
        // clicked.
        subview.focus()
      }
    }
  }
}

/**
* This function takes a transaction coming from the main EditorView (i.e., the
* document itself), and applies that transaction to a subview (i.e., an
* EditorView that only handles editing a single table cell). It does not apply
* transactions marked as syncAnnotation (because those originate from the
* subview and thus cannot be applied again), or which neither change nor add
* effects to the document (effects are only relevant to the main editor).
*
* @param  {EditorView}   subview  The subview to have the transaction applied to
* @param  {Transaction}  tr       The transaction from the main view
*/
export function maybeDispatchToSubview (subview: EditorView, tr: Transaction): void {
  if (tr.annotation(syncAnnotation) === undefined && (tr.docChanged || tr.effects.length > 0)) {
    const annotations: Annotation<any>[] = [syncAnnotation.of(true)]
    const userEvent = tr.annotation(Transaction.userEvent)
    if (userEvent !== undefined) {
      annotations.push(Transaction.userEvent.of(userEvent))
    }
    // The TransactionSpecs will be merged, with
    // the new annotations being appended to the
    // end of the existing annotations list
    subview.dispatch(tr, { annotations })
    restoreDomSelection(subview)
  }
}

/**
 * Puts the DOM selection of a focused subview back onto the subview's own
 * selection if the two disagree. Applying a transaction that the user did not
 * cause can re-render the cell (e.g., re-highlighting it once the parser has
 * finished),
 * which moves the text node holding the cursor into a new element and thereby
 * drops the DOM selection to the start of the line. Shortly after the subview
 * has been focused, CodeMirror takes a DOM selection at the start of the editor
 * for the browser's own focus placement and does not restore it, but reads it
 * back later as if the user had clicked there, so the cursor jumps to the start
 * of the cell.
 *
 * @param  {EditorView}  view  The subview
 */
export function restoreDomSelection (view: EditorView): void {
  if (!view.hasFocus || view.composing) {
    return
  }

  const domSelection = view.contentDOM.ownerDocument.getSelection()
  if (domSelection === null || domSelection.anchorNode === null || domSelection.focusNode === null) {
    return
  }

  if (!view.contentDOM.contains(domSelection.anchorNode) || !view.contentDOM.contains(domSelection.focusNode)) {
    return
  }

  const { anchor, head } = view.state.selection.main
  try {
    const domAnchor = view.posAtDOM(domSelection.anchorNode, domSelection.anchorOffset)
    const domHead = view.posAtDOM(domSelection.focusNode, domSelection.focusOffset)
    if (domAnchor === anchor && domHead === head) {
      return
    }

    const anchorPosition = view.domAtPos(anchor)
    const headPosition = view.domAtPos(head)
    domSelection.setBaseAndExtent(anchorPosition.node, anchorPosition.offset, headPosition.node, headPosition.offset)
  } catch (_error) {
    // The DOM is in flux; CodeMirror will sort out the selection itself.
  }
}
