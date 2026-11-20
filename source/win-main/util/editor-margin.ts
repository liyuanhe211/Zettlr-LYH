/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        maxEditorMargin, effectiveEditorMargin, stepMarginDrag,
 *                  reduceMarginDrag, initialMarginDragState, isSplitLayout,
 *                  marginConfigKey, storedEditorMargin
 * CVM-Role:        Utility function
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH (R81): the arithmetic behind the Margin control
 *                  of the main toolbar, which sets the left and right padding
 *                  of the Markdown editors by dragging. One value is stored
 *                  for a single pane and one for split panes. The padding is
 *                  limited so that the text of every pane stays at least
 *                  MINIMUM_TEXT_WIDTH pixels wide, taking into account how
 *                  R56 balances the white space around the gutters. The drag
 *                  itself is a small state machine, so that it can be tested
 *                  without a DOM.
 *
 * END HEADER
 */

import { computeGutterBalance } from '../../common/modules/markdown-editor/plugins/balance-gutter-whitespace'
import type { BranchNodeJSON, LeafNodeJSON } from '../../types/common/documents'

/**
 * The left and right padding of a Markdown editor, in pixels, unless the
 * configuration says otherwise
 */
export const DEFAULT_EDITOR_MARGIN = 50

/**
 * The largest margin the configuration accepts, in pixels
 */
export const MAXIMUM_STORED_EDITOR_MARGIN = 2000

/**
 * The narrowest the text of a pane may become, in pixels
 */
export const MINIMUM_TEXT_WIDTH = 200

/**
 * The configuration key of the margin for a single pane
 */
export const SINGLE_PANE_MARGIN_KEY = 'display.editorMarginSingle'

/**
 * The configuration key of the margin for split panes
 */
export const SPLIT_PANES_MARGIN_KEY = 'display.editorMarginSplit'

/**
 * Turns a measured length into a usable one: negative values and values that
 * are not finite numbers count as zero.
 *
 * @param   {number}  value  The measured length
 *
 * @return  {number}         The length, or zero if it is unusable
 */
function usableLength (value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * The width of the text in a scroller with the given padding on both sides,
 * after R56 has balanced the white space around the gutters
 *
 * @param   {number}  scrollerWidth  The client width of the scroller
 * @param   {number}  gutterWidth    The width of the gutters before the text
 * @param   {number}  margin         The left and right padding of the scroller
 *
 * @return  {number}                 The width of the text
 */
function textWidth (scrollerWidth: number, gutterWidth: number, margin: number): number {
  const { shift, balance } = computeGutterBalance(gutterWidth, margin, margin)
  return scrollerWidth - 2 * margin - (gutterWidth - shift) - balance
}

/**
 * The largest margin a pane allows: the largest integer p not below zero for
 * which the text stays at least MINIMUM_TEXT_WIDTH pixels wide. If the text
 * is narrower than that even without any margin, the result is zero.
 *
 * @param   {number}  scrollerWidth  The client width of the pane's scroller
 * @param   {number}  gutterWidth    The width of the gutters before the text
 *
 * @return  {number}                 The largest margin, an integer
 */
export function maxEditorMargin (scrollerWidth: number, gutterWidth: number): number {
  const width = usableLength(scrollerWidth)
  const gutters = usableLength(gutterWidth)

  if (textWidth(width, gutters, 0) < MINIMUM_TEXT_WIDTH) {
    return 0
  }

  // With equal padding, compact balancing shifts and adds equal amounts,
  // so the text loses two pixels per pixel of margin even near zero. Check
  // the estimate against the exact computation to rule out rounding errors.
  let margin = Math.max(0, Math.floor((width - gutters - MINIMUM_TEXT_WIDTH) / 2))
  while (margin > 0 && textWidth(width, gutters, margin) < MINIMUM_TEXT_WIDTH) {
    margin--
  }
  while (textWidth(width, gutters, margin + 1) >= MINIMUM_TEXT_WIDTH) {
    margin++
  }
  return margin
}

/**
 * Normalizes a stored margin: values that are not finite numbers become the
 * default, all others are rounded and kept within zero and the largest
 * accepted value.
 *
 * @param   {unknown}  value  The stored value
 *
 * @return  {number}          A usable margin, an integer
 */
function normalizeStoredMargin (value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_EDITOR_MARGIN
  }
  return Math.min(MAXIMUM_STORED_EDITOR_MARGIN, Math.max(0, Math.round(value)))
}

/**
 * The margin a pane actually shows: the stored value, reduced to what the
 * pane allows. The stored value itself stays untouched, so that the margin
 * comes back once the pane is wide enough again.
 *
 * @param   {number}  stored         The stored (or previewed) margin
 * @param   {number}  scrollerWidth  The client width of the pane's scroller
 * @param   {number}  gutterWidth    The width of the gutters before the text
 *
 * @return  {number}                 The margin to show, never negative
 */
export function effectiveEditorMargin (stored: number, scrollerWidth: number, gutterWidth: number): number {
  return Math.max(0, Math.min(normalizeStoredMargin(stored), maxEditorMargin(scrollerWidth, gutterWidth)))
}

/**
 * One step of a drag: adds the horizontal mouse movement to the margin and
 * keeps the result within zero and the upper limit. Since every step is
 * limited on its own, dragging back after hitting a limit takes effect at
 * once.
 *
 * @param   {number}  value      The margin before the step
 * @param   {number}  movementX  The horizontal mouse movement, in pixels
 * @param   {number}  max        The upper limit
 *
 * @return  {number}             The margin after the step, an integer
 */
export function stepMarginDrag (value: number, movementX: number, max: number): number {
  const limit = Math.floor(usableLength(max))
  const start = Number.isFinite(value) ? value : 0
  const movement = Number.isFinite(movementX) ? movementX : 0
  return Math.min(limit, Math.max(0, Math.round(start + movement)))
}

/**
 * The phases of a drag: no drag; a drag with the pointer locked (or the lock
 * requested); a plain drag after the pointer could not be locked.
 */
export type MarginDragPhase = 'idle'|'locked'|'fallback'

/**
 * The state of a drag
 */
export interface MarginDragState {
  phase: MarginDragPhase
  /** The margin when the drag started */
  startValue: number
  /** The current margin */
  value: number
  /** The upper limit of this drag */
  max: number
  /** The part of the mouse movement below one pixel that has not been applied yet */
  fraction: number
}

/**
 * What happens to a drag
 */
export type MarginDragEvent =
  | { type: 'start', startValue: number, max: number }
  | { type: 'move', movementX: number }
  | { type: 'end' }
  | { type: 'lock-lost' }
  | { type: 'lock-error' }

/**
 * What the caller has to do after an event: nothing; show a value without
 * storing it; store the final value; or show the stored value again without
 * storing anything (cancelled, or ended without a change).
 */
export type MarginDragAction =
  | { type: 'none' }
  | { type: 'preview', value: number }
  | { type: 'write', value: number }
  | { type: 'restore', value: number }

/**
 * The state before any drag
 *
 * @return  {MarginDragState}  An idle state
 */
export function initialMarginDragState (): MarginDragState {
  return { phase: 'idle', startValue: 0, value: 0, max: 0, fraction: 0 }
}

/**
 * Applies an event to a drag.
 *
 * - start (only while idle): records the start value and the upper limit and
 *   asks to show the start value; the pointer lock counts as requested.
 * - move: adds the movement, step by step within the limits, and asks to
 *   show the new value. Movements below one pixel accumulate.
 * - end: finishes the drag; asks to store the final value if it differs from
 *   the start value, and to show the stored value again otherwise.
 * - lock-lost: cancels the drag and asks to show the start value again
 *   without storing anything. The caller sends this when the pointer lock is
 *   lost before the button is released, and in a plain drag when the window
 *   loses the focus.
 * - lock-error (only with the lock requested): continues as a plain drag.
 *
 * Any other combination leaves the state alone and asks for nothing.
 *
 * @param   {MarginDragState}  state  The state before the event
 * @param   {MarginDragEvent}  event  The event
 *
 * @return  {{ state: MarginDragState, action: MarginDragAction }}  The state after the event and what to do
 */
export function reduceMarginDrag (
  state: MarginDragState,
  event: MarginDragEvent
): { state: MarginDragState, action: MarginDragAction } {
  const nothing = { state, action: { type: 'none' } as MarginDragAction }

  if (event.type === 'start') {
    if (state.phase !== 'idle') {
      return nothing
    }
    const max = Math.floor(usableLength(event.max))
    const startValue = Number.isFinite(event.startValue) ? Math.max(0, Math.round(event.startValue)) : DEFAULT_EDITOR_MARGIN
    return {
      state: { phase: 'locked', startValue, value: startValue, max, fraction: 0 },
      action: { type: 'preview', value: startValue }
    }
  }

  if (state.phase === 'idle') {
    return nothing
  }

  switch (event.type) {
    case 'move': {
      const total = state.fraction + (Number.isFinite(event.movementX) ? event.movementX : 0)
      const whole = Math.trunc(total)
      const value = stepMarginDrag(state.value, whole, state.max)
      return {
        state: { ...state, value, fraction: total - whole },
        action: { type: 'preview', value }
      }
    }
    case 'end': {
      const idle = { ...state, phase: 'idle' as const, fraction: 0 }
      if (state.value === state.startValue) {
        return { state: idle, action: { type: 'restore', value: state.startValue } }
      }
      return { state: idle, action: { type: 'write', value: state.value } }
    }
    case 'lock-lost':
      return {
        state: { ...state, phase: 'idle', value: state.startValue, fraction: 0 },
        action: { type: 'restore', value: state.startValue }
      }
    case 'lock-error':
      if (state.phase !== 'locked') {
        return nothing
      }
      return { state: { ...state, phase: 'fallback' }, action: { type: 'none' } }
  }
}

/**
 * Whether the editor area of a window is split, i.e. shows two or more panes
 * (side by side or on top of each other, nested or not)
 *
 * @param   {BranchNodeJSON|LeafNodeJSON|undefined}  paneStructure  The pane tree of the window
 *
 * @return  {boolean}                                               True for two or more panes
 */
export function isSplitLayout (paneStructure: BranchNodeJSON|LeafNodeJSON|undefined): boolean {
  if (paneStructure === undefined) {
    return false
  }

  let leafCount = 0
  const pending: Array<BranchNodeJSON|LeafNodeJSON> = [paneStructure]
  let node = pending.pop()
  while (node !== undefined) {
    if (node.type === 'leaf') {
      leafCount++
      if (leafCount >= 2) {
        return true
      }
    } else {
      pending.push(...node.nodes)
    }
    node = pending.pop()
  }
  return false
}

/**
 * The configuration key that stores the margin of a layout
 *
 * @param   {boolean}  split  Whether the editor area is split
 *
 * @return  {string}          The configuration key
 */
export function marginConfigKey (split: boolean): typeof SINGLE_PANE_MARGIN_KEY|typeof SPLIT_PANES_MARGIN_KEY {
  return split ? SPLIT_PANES_MARGIN_KEY : SINGLE_PANE_MARGIN_KEY
}

/**
 * Reads the stored margin of a layout from the display settings. A missing
 * value, or one that is not a finite number, counts as the default, so the
 * editors keep their usual look while the setting is unknown.
 *
 * @param   {unknown}  displaySettings  The `display` section of the configuration
 * @param   {boolean}  split            Whether the editor area is split
 *
 * @return  {number}                    The stored margin, an integer
 */
export function storedEditorMargin (displaySettings: unknown, split: boolean): number {
  if (displaySettings === null || typeof displaySettings !== 'object') {
    return DEFAULT_EDITOR_MARGIN
  }
  const property = marginConfigKey(split).split('.')[1]
  return normalizeStoredMargin((displaySettings as Record<string, unknown>)[property])
}
