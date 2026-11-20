/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        defaultContextMenu
 * CVM-Role:        Utility Function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Showws a default context menu that applies for an unspecific
 *                  position within the editor. Widgets may define their own
 *                  context menus as appropriate. Also builds the menu items
 *                  that accept and reject tracked changes (spec C10).
 *
 * END HEADER
 */

import { syntaxTree } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import type { EditorState, SelectionRange, TransactionSpec } from '@codemirror/state'
import { isolateHistory } from '@codemirror/commands'
import { trans } from '@common/i18n-renderer'
import type { AnyMenuItem } from '@common/modules/window-register/application-menu-helper'
import {
  acceptRevision,
  acceptRevisionsInRange,
  findRevisions,
  rejectRevision,
  rejectRevisionsInRange,
  type RevisionRange
} from '../revisions/revision-model'
import { defaultMenu } from '../context-menu/default-menu'
import { linkImageMenu } from '../context-menu/link-image-menu'
import { nodeAtPos } from '../util/node-in-selection'
import { NODES } from '../parser/citation-parser'
import { citationMenu } from '../context-menu/citation-menu'
import { pandocRangeForClick } from '../context-menu/pandoc-attribute-menu'

/**
 * What the revision menu items act on: an editor view, or any object with the
 * same state and dispatch.
 */
export interface RevisionMenuTarget {
  readonly state: EditorState
  dispatch: (transaction: TransactionSpec) => void
}

/**
 * The outer revisions that overlap at least one non-empty selection range.
 */
function revisionsInSelection (state: EditorState, ranges: readonly SelectionRange[]): RevisionRange[] {
  return findRevisions(state).filter(revision => ranges.some(range => {
    return !range.empty && revision.from < range.to && range.from < revision.to
  }))
}

/**
 * Dispatches an accept or reject transaction as an undo step of its own.
 */
function dispatchRevisionAction (target: RevisionMenuTarget, transaction: TransactionSpec|null): void {
  if (transaction === null) {
    return
  }

  target.dispatch({ ...transaction, annotations: isolateHistory.of('full') })
}

/**
 * Builds the context menu items that accept and reject tracked changes (spec
 * C10, accept and reject item 4): Accept Change and Reject Change when the
 * clicked position lies on a revision (both ends of the span included);
 * Accept All Changes and Reject All Changes when there is no selection and the
 * document contains a revision; Accept Changes in Selection and Reject Changes
 * in Selection, acting only on the revisions that overlap the selection, when
 * there is a non-empty selection that overlaps one. Items without a revision
 * to act on are left out. Each action is one undo step.
 *
 * Call this before the menu code changes the selection (e.g., by selecting the
 * word under the cursor): the selection at that time decides between the All
 * and the Selection items, and the Selection items act on it.
 *
 * @param   {RevisionMenuTarget}  target    The editor view
 * @param   {number}              position  The clicked document position
 *
 * @return  {AnyMenuItem[]}                 The items, possibly none
 */
export function buildRevisionMenuItems (target: RevisionMenuTarget, position: number): AnyMenuItem[] {
  const state = target.state
  const items: AnyMenuItem[] = []

  if (acceptRevisionsInRange(state, position, position) !== null) {
    items.push(
      {
        label: trans('Accept Change'),
        type: 'normal',
        action () { dispatchRevisionAction(target, acceptRevisionsInRange(target.state, position, position)) }
      },
      {
        label: trans('Reject Change'),
        type: 'normal',
        action () { dispatchRevisionAction(target, rejectRevisionsInRange(target.state, position, position)) }
      }
    )
  }

  const ranges = state.selection.ranges
  if (ranges.some(range => !range.empty)) {
    if (revisionsInSelection(state, ranges).length > 0) {
      const actOnSelection = (action: 'accept'|'reject'): void => {
        const current = target.state
        const revisions = revisionsInSelection(current, ranges)
        if (revisions.length === 0) {
          return
        }

        const actOnRevision = action === 'accept' ? acceptRevision : rejectRevision
        const changes = current.changes(revisions.map(revision => current.changes(actOnRevision(current, revision).changes)))
        dispatchRevisionAction(target, { changes })
      }

      items.push(
        {
          label: trans('Accept Changes in Selection'),
          type: 'normal',
          action () { actOnSelection('accept') }
        },
        {
          label: trans('Reject Changes in Selection'),
          type: 'normal',
          action () { actOnSelection('reject') }
        }
      )
    }
  } else if (findRevisions(state).length > 0) {
    items.push(
      {
        label: trans('Accept All Changes'),
        type: 'normal',
        action () { dispatchRevisionAction(target, acceptRevisionsInRange(target.state, 0, target.state.doc.length)) }
      },
      {
        label: trans('Reject All Changes'),
        type: 'normal',
        action () { dispatchRevisionAction(target, rejectRevisionsInRange(target.state, 0, target.state.doc.length)) }
      }
    )
  }

  return items
}

/**
 * Builds the revision menu items for the clicked position and only then, when
 * asked to and nothing is selected, selects the word at that position. The
 * items have to be built first because the selection at that time decides
 * between the All and the Selection items (see buildRevisionMenuItems).
 *
 * @param   {RevisionMenuTarget}  target      The editor view
 * @param   {number}              position    The clicked document position
 * @param   {boolean}             selectWord  Whether to select the word at the
 *                                            position if nothing is selected
 *
 * @return  {AnyMenuItem[]}                   The revision items, possibly none
 */
export function buildRevisionItemsThenSelectWord (target: RevisionMenuTarget, position: number, selectWord: boolean): AnyMenuItem[] {
  const revisionItems = buildRevisionMenuItems(target, position)

  if (selectWord) {
    // If there is nothing selected, select the word at the coords
    const nothingSelected = target.state.selection.ranges.every(x => x.empty)
    const wordAt = target.state.wordAt(position)
    if (nothingSelected && wordAt !== null) {
      target.dispatch({ selection: wordAt })
    }
  }

  return revisionItems
}

export const defaultContextMenu = EditorView.domEventHandlers({
  contextmenu (event, view) {
    const coords = { x: event.clientX, y: event.clientY }
    // First, determine where we clicked
    const pos = view.posAtCoords(coords)

    if (pos === null) {
      return false // No context menu to show
    }

    const tree = syntaxTree(view.state)

    // The objects addressed by the Pandoc attribute section; determined before
    // the menus below select the word or misspelling under the cursor.
    const pandocRange = pandocRangeForClick(view.state, pos)

    const maybeLinkNode = nodeAtPos(pos, tree, [ 'URL', 'Link', 'Image', 'LinkReference' ])
    const citationNode = maybeLinkNode === null ? nodeAtPos(pos, tree, [NODES.CITATION]) : null

    // The accept and reject items for tracked changes (spec C10); built before
    // the word under the cursor is selected, which only the default menu does.
    const revisionItems = buildRevisionItemsThenSelectWord(view, pos, maybeLinkNode === null && citationNode === null)

    if (maybeLinkNode !== null) {
      // We can show a Link/Image context menu!
      linkImageMenu(view, maybeLinkNode, coords, pandocRange, revisionItems)
      return true
    }

    if (citationNode !== null) {
      // We can show a citation menu
      citationMenu(view, coords, citationNode, pandocRange, revisionItems)
      return true
    }

    const node = tree.resolveInner(pos)
    defaultMenu(view, node, coords, pandocRange, revisionItems).catch(err => console.error(err))
    return true
  }
})
