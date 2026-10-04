/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        getPandocAttributeSection, applyPandocAttributeUpdates,
 *                  findPandocAttributeTargetsNear, pandocRangeForClick,
 *                  requestPandocAttributePopover
 *
 * Description:     View-bound glue of the Pandoc attribute editor (requirement
 *                  R21). Finds the editable objects through the logic layer
 *                  (pandoc-attribute-targets.ts), builds the Pandoc section of
 *                  the context menus (only in Pandoc mode, i.e. when the
 *                  editor option pandocAttributeEditing is on), writes updates
 *                  back as a single transaction, and asks the hosting Vue
 *                  component to open the attribute popover by dispatching a
 *                  DOM event on the editor element.
 *
 * END HEADER
 */

import type { EditorView } from '@codemirror/view'
import type { ChangeSet, EditorState } from '@codemirror/state'
import { ensureSyntaxTree } from '@codemirror/language'
import type { AnyMenuItem } from '@common/modules/window-register/application-menu-helper'
import type { PandocAttributeTarget, PandocAttributeTargetKind, PandocAttributeUpdate } from '@common/pandoc-util/pandoc-attribute-schema'
import { buildPandocAttributeChanges, findPandocAttributeTargets } from '@common/pandoc-util/pandoc-attribute-targets'
import { buildPandocAttributeSectionItems } from './pandoc-attribute-section'
import { configField } from '../util/configuration'

/** Name of the DOM event that asks the host to open the attribute popover */
export const PANDOC_ATTRIBUTES_EVENT = 'zettlr-pandoc-attributes'

export interface PandocAttributeRange {
  from: number
  to: number
}

/** Payload of the PANDOC_ATTRIBUTES_EVENT */
export interface PandocAttributesEventDetail extends PandocAttributeRange {
  /** The object the popover should scroll to and highlight */
  focusKind?: PandocAttributeTargetKind
  /** Screen coordinates to anchor the popover at */
  x: number
  y: number
}

export interface PandocAttributeKindUpdate {
  kind: PandocAttributeTargetKind
  update: PandocAttributeUpdate
}

/**
 * Updates are written outermost object first, so that directive comments that
 * end up in front of the same block keep the order page, style, table.
 */
const APPLY_ORDER: PandocAttributeTargetKind[] = [ 'page', 'block', 'table', 'column', 'image', 'span' ]

/**
 * How far past the range the syntax tree must be parsed so that the objects
 * around it (a whole table, the rest of a slide) are complete.
 */
const PARSE_AHEAD = 20000

/**
 * Returns the range whose objects a right-click at pos addresses: the main
 * selection if it is not empty and contains pos, otherwise pos itself.
 *
 * @param   {EditorState}           state  The state before the menu altered it
 * @param   {number}                pos    The clicked document position
 *
 * @return  {PandocAttributeRange}         The range
 */
export function pandocRangeForClick (state: EditorState, pos: number): PandocAttributeRange {
  const main = state.selection.main
  if (!main.empty && pos >= main.from && pos <= main.to) {
    return { from: main.from, to: main.to }
  }
  return { from: pos, to: pos }
}

/**
 * Finds the editable objects around the range after making sure the syntax
 * tree covers them.
 *
 * @param   {EditorState}              state  The state
 * @param   {number}                   from   Range start
 * @param   {number}                   to     Range end
 *
 * @return  {PandocAttributeTarget[]}         The objects, innermost first
 */
export function findPandocAttributeTargetsNear (state: EditorState, from: number, to: number): PandocAttributeTarget[] {
  ensureSyntaxTree(state, Math.min(state.doc.length, to + PARSE_AHEAD), 500)
  return findPandocAttributeTargets(state, from, to)
}

/**
 * Writes attribute updates for several objects around the range in one
 * transaction. Each object is located anew in the state that already contains
 * the previous objects' changes, so neighbouring changes (two directive
 * comments in front of the same block) can never overlap; the per-object
 * change sets are composed into one.
 *
 * @param   {EditorView}                   view     The view
 * @param   {number}                       from     Range start in the current document
 * @param   {number}                       to       Range end in the current document
 * @param   {PandocAttributeKindUpdate[]}  updates  At most one update per kind
 *
 * @return  {boolean}                               Whether anything changed
 */
export function applyPandocAttributeUpdates (view: EditorView, from: number, to: number, updates: PandocAttributeKindUpdate[]): boolean {
  let state = view.state
  let rangeFrom = from
  let rangeTo = to
  let total: ChangeSet|undefined

  const ordered = [...updates].sort((a, b) => APPLY_ORDER.indexOf(a.kind) - APPLY_ORDER.indexOf(b.kind))

  for (const { kind, update } of ordered) {
    if (Object.keys(update).length === 0) {
      continue
    }

    const target = findPandocAttributeTargetsNear(state, rangeFrom, rangeTo).find(t => t.kind === kind)
    if (target === undefined) {
      console.warn(`Pandoc attributes: no ${kind} found at ${rangeFrom}-${rangeTo} anymore; update skipped.`)
      continue
    }

    const changes = state.changes(buildPandocAttributeChanges(state, target, update))
    if (changes.empty) {
      continue
    }

    total = total === undefined ? changes : total.compose(changes)
    rangeFrom = changes.mapPos(rangeFrom, 1)
    rangeTo = Math.max(rangeFrom, changes.mapPos(rangeTo, -1))
    state = state.update({ changes }).state
  }

  if (total === undefined) {
    return false
  }

  view.dispatch({ changes: total, userEvent: 'input.pandoc-attributes' })
  return true
}

/**
 * Asks the component hosting the editor to open the attribute popover.
 *
 * @param   {EditorView}                   view    The (main) view
 * @param   {PandocAttributesEventDetail}  detail  Range, focus and anchor
 */
export function requestPandocAttributePopover (view: EditorView, detail: PandocAttributesEventDetail): void {
  view.dom.dispatchEvent(new CustomEvent<PandocAttributesEventDetail>(PANDOC_ATTRIBUTES_EVENT, { bubbles: true, detail }))
}

/**
 * Returns the Pandoc section for a context menu, or an empty array outside
 * Pandoc mode or when nothing around the range is editable.
 *
 * @param   {EditorView}                view    The main view (not a table cell subview)
 * @param   {PandocAttributeRange}      range   The addressed range
 * @param   {{ x: number, y: number }}  coords  The click coordinates
 *
 * @return  {AnyMenuItem[]}                     Items starting with a separator
 */
export function getPandocAttributeSection (view: EditorView, range: PandocAttributeRange, coords: { x: number, y: number }): AnyMenuItem[] {
  if (view.state.field(configField, false)?.pandocAttributeEditing !== true) {
    return []
  }

  try {
    const targets = findPandocAttributeTargetsNear(view.state, range.from, range.to)
    return buildPandocAttributeSectionItems(targets, {
      apply (target, update) {
        applyPandocAttributeUpdates(view, range.from, range.to, [{ kind: target.kind, update }])
        view.focus()
      },
      editAll (target) {
        requestPandocAttributePopover(view, { ...range, focusKind: target.kind, x: coords.x, y: coords.y })
      }
    })
  } catch (err: unknown) {
    // Never let the attribute section break the rest of the context menu
    console.error('Pandoc attributes: could not build the context menu section', err)
    return []
  }
}
