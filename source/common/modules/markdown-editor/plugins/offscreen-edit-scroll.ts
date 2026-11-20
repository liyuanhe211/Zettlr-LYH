/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Offscreen Edit Scroll
 * CVM-Role:        CodeMirror Plugin
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     When the user modifies the document while the primary
 *                  cursor's visual row is entirely outside the visible area
 *                  (e.g., after scrolling away from the cursor and then
 *                  typing), scrolls so that the cursor's row top sits at one
 *                  third of the visible height, instead of CodeMirror's
 *                  default of just revealing it at the nearest edge. Only
 *                  modifications that CodeMirror would scroll into view
 *                  anyway (a document change carrying the `scrollIntoView`
 *                  flag and no explicit scroll effect) are affected; moving
 *                  the cursor without modifying the document, edits whose
 *                  cursor lands inside the previously visible area, the
 *                  typewriter mode and locked table cells keep their
 *                  existing behavior. The judgement uses a snapshot of the
 *                  visible area taken before the modification: on the DOM
 *                  events that start a modification (taken synchronously and
 *                  frozen until the modification has been processed), and
 *                  otherwise from the latest measure cycle. During native
 *                  composition, events reuse the mapped snapshot to avoid
 *                  disturbing the browser's preedit replacement selection.
 *                  Every scroll request answered this way is counted
 *                  (`offscreenEditHandledCount`), so that the scroll
 *                  stabilization (`preserve-scroll-anchor.ts`) can tell that
 *                  this plugin took over the scroll request of a measure
 *                  cycle and must not compensate it back (specification
 *                  C13, section 3, the exception to rule 5).
 *
 * END HEADER
 */

import { Facet, Prec, Transaction, type ChangeDesc, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { configField } from '../util/configuration'

/**
 * How long (in milliseconds) a snapshot taken on a DOM event stays frozen if
 * no modification or other user transaction follows it (e.g., a modifier key
 * alone was pressed). Afterwards, measure cycles update the snapshot again.
 */
const FREEZE_TIMEOUT = 500

/**
 * The DOM events (listened to on the content DOM in the capture phase) that
 * can start a modification. Each takes a fresh snapshot of the visible area
 * before the browser or CodeMirror acts on it, unless native composition is
 * already active; those events reuse the existing snapshot.
 */
const MODIFICATION_START_EVENTS = [ 'keydown', 'beforeinput', 'compositionstart', 'paste', 'cut', 'drop' ]

/**
 * A snapshot of the visible area of an editor, in document positions of the
 * document the snapshot was taken (or last mapped) in.
 */
export interface VisibleRangeSnapshot {
  /**
   * The first document position of the visual row at the top edge of the
   * visible area (a partially visible row counts as visible).
   */
  from: number
  /**
   * The last document position of the visual row at the bottom edge of the
   * visible area (a partially visible row counts as visible).
   */
  to: number
  /**
   * The primary cursor position when the snapshot was taken.
   */
  head: number
  /**
   * True if the primary cursor's visual row was entirely outside the visible
   * area when the snapshot was taken.
   */
  headOutside: boolean
}

/**
 * A function that takes a snapshot of an editor's visible area, or returns
 * null if the editor has no measurable geometry.
 */
export type VisibleRangeMeasurer = (view: EditorView) => VisibleRangeSnapshot|null

/**
 * The conditions that decide whether a transaction scrolls the cursor's row
 * to one third of the visible height (see `shouldScrollToThird`).
 */
export interface OffscreenEditConditions {
  /** The transaction changed the document */
  docChanged: boolean
  /** The transaction carries the `scrollIntoView` flag */
  scrollFlag: boolean
  /** The transaction carries an explicit `EditorView.scrollIntoView` effect */
  hasExplicitScrollEffect: boolean
  /** The typewriter mode is enabled */
  typewriterMode: boolean
  /** The primary cursor's row was entirely outside the visible area before */
  oldHeadOutside: boolean
  /**
   * The new primary cursor position, mapped back into the document before the
   * transaction, lies outside the previously visible area
   */
  newHeadPreimageOutside: boolean
}

/**
 * Determines whether a visual row lies entirely outside the visible area,
 * either completely above or completely below it. A partially visible row
 * counts as visible.
 *
 * @param   {number}   rowTop         Top of the row (client coordinates)
 * @param   {number}   rowBottom      Bottom of the row
 * @param   {number}   visibleTop     Top of the visible area
 * @param   {number}   visibleBottom  Bottom of the visible area
 *
 * @return  {boolean}                 True if the row is entirely outside
 */
export function isRowOutside (rowTop: number, rowBottom: number, visibleTop: number, visibleBottom: number): boolean {
  return rowBottom <= visibleTop || rowTop >= visibleBottom
}

/**
 * Computes the scroll position that places a row top at one third of the
 * visible height, clamped between 0 and the maximum scroll position.
 *
 * @param   {number}  currentScrollTop  The current scroll position
 * @param   {number}  rowTop            Top of the row (client coordinates)
 * @param   {number}  visibleTop        Top of the visible area
 * @param   {number}  clientHeight      The visible height
 * @param   {number}  maxScrollTop      The maximum scroll position
 *
 * @return  {number}                    The new scroll position
 */
export function thirdScrollTop (
  currentScrollTop: number,
  rowTop: number,
  visibleTop: number,
  clientHeight: number,
  maxScrollTop: number
): number {
  const target = currentScrollTop + (rowTop - visibleTop) - clientHeight / 3
  return Math.min(Math.max(target, 0), maxScrollTop)
}

/**
 * Decides whether a transaction scrolls the cursor's row to one third of the
 * visible height: it must be a document change that CodeMirror would scroll
 * into view by itself (flag set, no explicit scroll effect), outside the
 * typewriter mode, with the cursor's row outside the visible area before the
 * change and the new cursor position outside the previously visible area.
 *
 * @param   {OffscreenEditConditions}  conditions  The conditions
 *
 * @return  {boolean}                              True to scroll to one third
 */
export function shouldScrollToThird (conditions: OffscreenEditConditions): boolean {
  return conditions.docChanged &&
    conditions.scrollFlag &&
    !conditions.hasExplicitScrollEffect &&
    !conditions.typewriterMode &&
    conditions.oldHeadOutside &&
    conditions.newHeadPreimageOutside
}

/**
 * Returns the document position at a client y coordinate at the left or right
 * edge of the content, falling back to the line block at that height if
 * CodeMirror's inline coordinate scan fails (see `preserve-scroll-anchor.ts`).
 *
 * @param   {EditorView}       view  The editor view
 * @param   {number}           y     The client y coordinate
 * @param   {'start'|'end'}    edge  Which end of the visual row to return
 *
 * @return  {number}                 The document position
 */
function positionAtHeight (view: EditorView, y: number, edge: 'start'|'end'): number {
  const contentRect = view.contentDOM.getBoundingClientRect()
  const x = edge === 'start' ? contentRect.left + 1 : contentRect.right - 1
  try {
    return view.posAtCoords({ x, y }, false)
  } catch (err) {
    const block = view.lineBlockAtHeight(y - view.documentTop)
    return edge === 'start' ? block.from : block.to
  }
}

/**
 * Takes a snapshot of the editor's visible area from its actual geometry.
 * Must not be called during an editor update.
 *
 * @param   {EditorView}                 view  The editor view
 *
 * @return  {VisibleRangeSnapshot|null}        The snapshot, or null
 */
export function measureVisibleRange (view: EditorView): VisibleRangeSnapshot|null {
  const scroller = view.scrollDOM
  if (scroller.clientHeight <= 0) {
    return null // Not mounted or not visible
  }

  const visibleTop = scroller.getBoundingClientRect().top
  const visibleBottom = visibleTop + scroller.clientHeight
  const head = view.state.selection.main.head
  // A cursor that is not rendered at all lies outside the visible area,
  // since CodeMirror always renders at least the visible part.
  const headRect = view.coordsAtPos(head)
  const headOutside = headRect === null || isRowOutside(headRect.top, headRect.bottom, visibleTop, visibleBottom)

  return {
    from: positionAtHeight(view, visibleTop, 'start'),
    to: positionAtHeight(view, Math.max(visibleTop, visibleBottom - 1), 'end'),
    head,
    headOutside
  }
}

/**
 * The function used to take snapshots of the visible area. Defaults to
 * `measureVisibleRange`; tests provide a stand-in, since jsdom has no layout.
 * The first provided value wins.
 */
export const visibleRangeMeasurer = Facet.define<VisibleRangeMeasurer, VisibleRangeMeasurer>({
  combine: values => values.length > 0 ? values[0] : measureVisibleRange
})

// The type of the effect created by `EditorView.scrollIntoView` (and
// `scrollSnapshot`) is internal to CodeMirror; its values are instances of an
// equally internal class, which identifies the effect.
const scrollTargetClass = (EditorView.scrollIntoView(0).value as object).constructor

/**
 * Determines whether a transaction carries an explicit scroll effect, which
 * overrides the scroll request of the `scrollIntoView` flag.
 *
 * @param   {Transaction}  transaction  The transaction
 *
 * @return  {boolean}                   True if it carries such an effect
 */
function hasExplicitScrollEffect (transaction: Transaction): boolean {
  return transaction.effects.some(effect => effect.value instanceof scrollTargetClass)
}

/**
 * Maps a snapshot through document changes; the visible range is mapped so
 * that text inserted at its edges counts as inside it.
 *
 * @param   {VisibleRangeSnapshot}  snapshot  The snapshot
 * @param   {ChangeDesc}            changes   The changes
 *
 * @return  {VisibleRangeSnapshot}            The mapped snapshot
 */
function mapSnapshot (snapshot: VisibleRangeSnapshot, changes: ChangeDesc): VisibleRangeSnapshot {
  if (changes.empty) {
    return snapshot
  }
  return {
    from: changes.mapPos(snapshot.from, -1),
    to: changes.mapPos(snapshot.to, 1),
    head: changes.mapPos(snapshot.head, -1),
    headOutside: snapshot.headOutside
  }
}

/**
 * Returns the client y coordinate of the top of the visual row containing a
 * document position. `coordsAtPos` cannot be used here, since scroll handlers
 * run while the view is still updating, where reading the layout through the
 * view throws; the already updated DOM is queried directly instead.
 *
 * @param   {EditorView}  view      The editor view
 * @param   {number}      position  The document position
 *
 * @return  {number}                The row top in client coordinates
 */
function rowTopAt (view: EditorView, position: number): number {
  const { node, offset } = view.domAtPos(position)
  if (node.nodeType === node.TEXT_NODE) {
    const range = view.dom.ownerDocument.createRange()
    range.setStart(node, offset)
    range.collapse(true)
    const rects = range.getClientRects()
    if (rects.length > 0) {
      return rects[0].top
    }
  }

  const element = node instanceof Element ? node : node.parentElement
  const line = element?.closest('.cm-line') ?? null
  if (line !== null) {
    return line.getBoundingClientRect().top
  }

  return view.documentTop + view.lineBlockAt(position).top
}

class OffscreenEditScroller {
  /**
   * The latest snapshot of the visible area, mapped to the current document.
   */
  private snapshot: VisibleRangeSnapshot|null = null
  /**
   * True while a snapshot taken on a DOM event waits for its modification;
   * measure cycles (which may run after the browser's own scroll) must not
   * overwrite it meanwhile.
   */
  private frozen = false
  private freezeTimer: ReturnType<typeof setTimeout>|undefined
  /**
   * The primary cursor position of the scroll request to be answered by
   * scrolling to one third of the visible height, if any.
   */
  public pendingHead: number|null = null
  /**
   * How many scroll requests have been answered by scrolling to one third of
   * the visible height. The scroll stabilization compares the count before
   * and after running a measure cycle to tell whether this plugin took over
   * that cycle's scroll request (specification C13, section 3, the exception
   * to rule 5). A count, unlike a flag, cannot carry a takeover of an earlier
   * cycle over into a later one.
   */
  public handledCount = 0
  private destroyed = false
  private readonly handleModificationStart: () => void
  private readonly handleScroll: () => void
  private readonly snapshotRequest = {
    key: this,
    read: (view: EditorView): VisibleRangeSnapshot|null => this.takeSnapshot(view),
    write: (snapshot: VisibleRangeSnapshot|null): void => {
      if (!this.frozen) {
        this.snapshot = snapshot
      }
    }
  }

  constructor (private readonly view: EditorView) {
    this.handleModificationStart = () => {
      // During native composition, beforeinput can carry a temporary DOM
      // selection over the preedit text. Measuring through coordsAtPos may
      // flush a pending view measurement and restore the state's cursor,
      // collapsing that selection before Chromium replaces the preedit.
      // Keep the mapped snapshot and let the normal measure cycle refresh it.
      if (this.view.compositionStarted) {
        return
      }
      this.snapshot = this.takeSnapshot(this.view)
      this.frozen = true
      clearTimeout(this.freezeTimer)
      this.freezeTimer = setTimeout(() => { this.unfreeze() }, FREEZE_TIMEOUT)
    }
    this.handleScroll = () => {
      if (!this.frozen) {
        this.view.requestMeasure(this.snapshotRequest)
      }
    }

    for (const name of MODIFICATION_START_EVENTS) {
      view.contentDOM.addEventListener(name, this.handleModificationStart, { capture: true })
    }
    view.scrollDOM.addEventListener('scroll', this.handleScroll, { passive: true })
    view.requestMeasure(this.snapshotRequest)
  }

  update (viewUpdate: ViewUpdate): void {
    let release = false
    for (const transaction of viewUpdate.transactions) {
      const explicitScroll = hasExplicitScrollEffect(transaction)
      if (this.pendingHead !== null) {
        this.pendingHead = transaction.changes.mapPos(this.pendingHead)
      }

      if (transaction.scrollIntoView || explicitScroll) {
        // This transaction replaces any earlier scroll request.
        const newHead = transaction.state.selection.main.head
        let oldHeadOutside = false
        let newHeadPreimageOutside = false
        if (this.snapshot !== null) {
          const snapshot = this.snapshot
          const oldHead = transaction.startState.selection.main.head
          const outsideRange = (position: number): boolean => position < snapshot.from || position > snapshot.to
          oldHeadOutside = oldHead === snapshot.head ? snapshot.headOutside : outsideRange(oldHead)
          newHeadPreimageOutside = outsideRange(transaction.changes.invertedDesc.mapPos(newHead))
        }
        const scrollToThird = shouldScrollToThird({
          docChanged: transaction.docChanged,
          scrollFlag: transaction.scrollIntoView,
          hasExplicitScrollEffect: explicitScroll,
          typewriterMode: transaction.state.field(configField, false)?.typewriterMode === true,
          oldHeadOutside,
          newHeadPreimageOutside
        })
        this.pendingHead = scrollToThird ? newHead : null
      }

      if (transaction.scrollIntoView || transaction.annotation(Transaction.userEvent) !== undefined) {
        release = true
      }

      if (this.snapshot !== null) {
        this.snapshot = mapSnapshot(this.snapshot, transaction.changes)
      }
    }

    if (release) {
      this.unfreeze()
    } else {
      this.view.requestMeasure(this.snapshotRequest)
    }
  }

  destroy (): void {
    this.destroyed = true
    clearTimeout(this.freezeTimer)
    for (const name of MODIFICATION_START_EVENTS) {
      this.view.contentDOM.removeEventListener(name, this.handleModificationStart, { capture: true })
    }
    this.view.scrollDOM.removeEventListener('scroll', this.handleScroll)
  }

  /**
   * Answers a scroll request: if it targets the pending cursor position,
   * scrolls the cursor's row top to one third of the visible height and
   * reports the request as handled (and counts it in `handledCount`). The
   * pending position is consumed either way.
   *
   * @param   {number}   head  The head of the scroll request's range
   *
   * @return  {boolean}        True if the request was handled
   */
  scrollToThird (head: number): boolean {
    const pendingHead = this.pendingHead
    this.pendingHead = null
    if (pendingHead === null || pendingHead !== head) {
      return false
    }

    const scroller = this.view.scrollDOM
    if (scroller.clientHeight <= 0) {
      return false
    }

    const visibleTop = scroller.getBoundingClientRect().top
    const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    scroller.scrollTop = thirdScrollTop(
      scroller.scrollTop,
      rowTopAt(this.view, head),
      visibleTop,
      scroller.clientHeight,
      maxScrollTop
    )
    this.handledCount++
    return true
  }

  private unfreeze (): void {
    clearTimeout(this.freezeTimer)
    this.freezeTimer = undefined
    this.frozen = false
    if (!this.destroyed) {
      this.view.requestMeasure(this.snapshotRequest)
    }
  }

  private takeSnapshot (view: EditorView): VisibleRangeSnapshot|null {
    try {
      return view.state.facet(visibleRangeMeasurer)(view)
    } catch (err) {
      // The snapshot is best-effort: without one, edits simply keep
      // CodeMirror's default scrolling.
      console.warn('[Offscreen Edit Scroll] Could not measure the visible area:', err)
      return null
    }
  }
}

const offscreenEditScrollPlugin = ViewPlugin.fromClass(OffscreenEditScroller)

/**
 * Returns the cursor position whose next scroll request will be answered by
 * scrolling to one third of the visible height, or null if there is none
 * (also if the extension is not installed).
 *
 * @param   {EditorView}   view  The editor view
 *
 * @return  {number|null}        The pending cursor position, or null
 */
export function pendingOffscreenEditHead (view: EditorView): number|null {
  return view.plugin(offscreenEditScrollPlugin)?.pendingHead ?? null
}

/**
 * Returns how many scroll requests of an editor have so far been answered by
 * scrolling to one third of the visible height, or 0 if the extension is not
 * installed. Comparing the count before and after a measure cycle tells
 * whether this extension took over that cycle's scroll request; the scroll
 * stabilization then re-bases its anchor instead of compensating the scroll
 * (specification C13, section 3, the exception to rule 5).
 *
 * @param   {EditorView}  view  The editor view
 *
 * @return  {number}            The number of answered scroll requests
 */
export function offscreenEditHandledCount (view: EditorView): number {
  return view.plugin(offscreenEditScrollPlugin)?.handledCount ?? 0
}

/**
 * An extension that scrolls the primary cursor's row to one third of the
 * visible height when the user modifies the document while that row is
 * entirely outside the visible area. The scroll handler has a low precedence
 * so that the table editor's handler (which keeps locked tables still) runs
 * first.
 */
export const offscreenEditScroll: Extension = [
  offscreenEditScrollPlugin,
  Prec.low(EditorView.scrollHandler.of((view, range) => {
    return view.plugin(offscreenEditScrollPlugin)?.scrollToThird(range.head) ?? false
  }))
]
