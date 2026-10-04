/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Preserve Scroll Anchor
 * CVM-Role:        CodeMirror Plugin
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Keeps the viewport visually stable whenever the total
 *                  display height of the document changes without the user
 *                  scrolling: remote edits arriving from the document
 *                  authority, widgets (re)rendering, images loading, etc.
 *                  The policy is: if the primary cursor is currently visible,
 *                  keep the cursor at the same height on screen; otherwise,
 *                  keep the line at one third of the viewport height
 *                  stationary. CodeMirror's built-in scroll anchoring always
 *                  anchors the line at the very top of the viewport, which
 *                  lets the cursor (or the text being read) drift whenever
 *                  heights change between the top line and the cursor.
 *
 * END HEADER
 */

import { type Extension } from '@codemirror/state'
import { type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { configField } from '../util/configuration'

/**
 * Scroll deviations (in pixels) larger than this are treated as an actual
 * scroll (by the user or another feature such as a "jump to line" command), in
 * which case the anchor is re-based instead of the previous position being
 * restored.
 */
const SCROLL_EPSILON = 2

/**
 * An anchor point within the currently visible viewport: a document position
 * together with the vertical offset of its visual row, measured from the top
 * of the visible part of the scroller.
 */
export interface ViewportAnchor {
  /**
   * The anchored document position.
   */
  position: number
  /**
   * The offset (in pixels) of the anchored position's visual row top from the
   * top of the scroller's visible area.
   */
  rowTop: number
  /**
   * True if the anchor is the primary cursor (which was visible when the
   * anchor was taken); false if it is the line at one third of the viewport
   * height.
   */
  cursorVisible: boolean
}

/**
 * Determines the anchor point of the current viewport according to the
 * stabilization policy: the primary cursor if it is visible, otherwise the
 * position at one third of the viewport height. Returns null if the editor
 * has no measurable geometry (e.g., it is not mounted yet).
 *
 * @param   {EditorView}           view  The editor view
 *
 * @return  {ViewportAnchor|null}        The anchor, or null
 */
export function findViewportAnchor (view: EditorView): ViewportAnchor|null {
  const scroller = view.scrollDOM
  const scrollerRect = scroller.getBoundingClientRect()
  if (scroller.clientHeight <= 0) {
    return null // Not mounted or not visible
  }

  const visibleTop = scrollerRect.top
  const visibleBottom = scrollerRect.top + scroller.clientHeight

  // First preference: the primary cursor, if it is within the visible area.
  const head = view.state.selection.main.head
  const cursorRect = view.coordsAtPos(head)
  if (cursorRect !== null && cursorRect.bottom > visibleTop && cursorRect.top < visibleBottom) {
    return { position: head, rowTop: cursorRect.top - visibleTop, cursorVisible: true }
  }

  // Otherwise: the position at one third of the viewport height.
  const contentRect = view.contentDOM.getBoundingClientRect()
  const anchorY = visibleTop + scroller.clientHeight / 3
  let position: number
  try {
    position = view.posAtCoords({ x: contentRect.left + 1, y: anchorY }, false)
  } catch (err) {
    // CodeMirror's inline coordinate scan can throw when its height map and
    // its rendered line tiles are momentarily out of sync (observed with very
    // long wrapped lines). Fall back to the start of the line block at that
    // height, which only needs the height map.
    position = view.lineBlockAtHeight(anchorY - view.documentTop).from
  }
  const rowRect = view.coordsAtPos(position)
  if (rowRect === null) {
    return null // The area is not rendered (e.g., during fast scrolling)
  }

  return { position, rowTop: rowRect.top - visibleTop, cursorVisible: false }
}

/**
 * The deferred work the plugin may have scheduled for the end of the current
 * update cycle: re-basing the anchor to the current viewport, or compensating
 * the scroll position so the anchor keeps its previous height.
 */
type PendingTask = 'none'|'compensate'|'rebase'

class ScrollAnchorKeeper {
  /**
   * The current anchor, together with a secondary baseline in height-map
   * coordinates (used when the anchored position is not rendered).
   */
  private anchor: ViewportAnchor & { blockTop: number }|null = null
  /**
   * The scroller's scrollTop at the time the baselines were taken. Deviations
   * from this value indicate an actual scroll.
   */
  private baselineScrollTop = 0
  private pendingTask: PendingTask = 'none'
  private destroyed = false
  private readonly handleScroll: () => void

  constructor (private readonly view: EditorView) {
    this.handleScroll = () => {
      if (Math.abs(this.view.scrollDOM.scrollTop - this.baselineScrollTop) > SCROLL_EPSILON) {
        this.schedule('rebase')
      }
    }
    view.scrollDOM.addEventListener('scroll', this.handleScroll, { passive: true })
    this.schedule('rebase')
  }

  update (viewUpdate: ViewUpdate): void {
    if (this.anchor !== null && viewUpdate.docChanged) {
      this.anchor.position = viewUpdate.changes.mapPos(this.anchor.position, -1)
    }

    const configuration = viewUpdate.state.field(configField, false)
    if (viewUpdate.selectionSet || configuration?.typewriterMode === true) {
      // The user moved the cursor (or the typewriter mode owns the vertical
      // scroll policy): take a fresh anchor instead of restoring the old one.
      this.schedule('rebase')
    } else if (viewUpdate.docChanged || viewUpdate.heightChanged) {
      // The display height changed without the user moving the cursor: keep
      // the anchor at its previous height.
      this.schedule('compensate')
    } else if (viewUpdate.geometryChanged) {
      // The editor itself was resized: the anchor offsets are void.
      this.schedule('rebase')
    }
  }

  destroy (): void {
    this.destroyed = true
    this.view.scrollDOM.removeEventListener('scroll', this.handleScroll)
  }

  /**
   * Schedules deferred work for the end of the current task. A requested
   * re-base always wins over a pending compensation, since it invalidates the
   * baselines the compensation would use. Scheduling as a microtask ensures
   * that, for dispatched transactions, the compensation runs after the DOM
   * has been updated but before the frame is painted, so the user never sees
   * the intermediate shift. It also ensures the compensation runs after
   * CodeMirror's own measure cycle (and its top-line anchoring) has finished,
   * so the two mechanisms never both compensate for the same shift.
   */
  private schedule (task: 'compensate'|'rebase'): void {
    const escalated = task === 'rebase' || this.pendingTask === 'rebase' ? 'rebase' : 'compensate'
    const mustQueue = this.pendingTask === 'none'
    this.pendingTask = escalated
    if (mustQueue) {
      queueMicrotask(() => { this.runPendingTask() })
    }
  }

  private runPendingTask (): void {
    const task = this.pendingTask
    this.pendingTask = 'none'
    if (this.destroyed || task === 'none') {
      return
    }

    try {
      if (task === 'rebase') {
        this.rebase()
      } else {
        this.compensate()
      }
    } catch (err) {
      // Scroll stabilization is best-effort: a failed geometry query must
      // never surface as an uncaught error. Drop the anchor so the next
      // update takes a fresh one.
      console.warn('[Preserve Scroll Anchor] Could not update the scroll anchor:', err)
      this.anchor = null
    }
  }

  private rebase (): void {
    const anchor = findViewportAnchor(this.view)
    if (anchor === null) {
      this.anchor = null
      return
    }

    this.anchor = {
      ...anchor,
      blockTop: this.view.lineBlockAt(anchor.position).top - this.view.scrollDOM.scrollTop
    }
    this.baselineScrollTop = this.view.scrollDOM.scrollTop
  }

  private compensate (): void {
    if (this.anchor === null) {
      this.rebase()
      return
    }

    const scroller = this.view.scrollDOM
    if (Math.abs(scroller.scrollTop - this.baselineScrollTop) > SCROLL_EPSILON) {
      // Something else (the user, a jump command, ...) scrolled since the
      // baseline was taken; that scroll wins and becomes the new baseline.
      this.rebase()
      return
    }

    const position = Math.min(this.anchor.position, this.view.state.doc.length)
    const rowRect = this.view.coordsAtPos(position)
    let delta = 0
    if (rowRect !== null) {
      delta = rowRect.top - scroller.getBoundingClientRect().top - this.anchor.rowTop
    } else {
      // The anchor is (temporarily) outside the rendered viewport; fall back
      // to the height-map estimate.
      delta = this.view.lineBlockAt(position).top - scroller.scrollTop - this.anchor.blockTop
    }

    if (Math.abs(delta) > 1) {
      scroller.scrollTop += delta
      this.baselineScrollTop = scroller.scrollTop
    }
  }
}

/**
 * An extension that keeps the viewport visually stable when the document's
 * total display height changes without the user scrolling: if the primary
 * cursor is visible, its height on screen is kept unchanged; otherwise, the
 * line at one third of the viewport height is kept stationary.
 */
export const preserveScrollAnchor: Extension = ViewPlugin.fromClass(ScrollAnchorKeeper)
