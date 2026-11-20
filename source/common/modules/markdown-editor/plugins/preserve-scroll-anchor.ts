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
 *                  When the mouse button is released after a pointer
 *                  selection, the renderers reveal the source of the selected
 *                  elements; the text that was under the pointer on release
 *                  (not necessarily the selection head) is then kept under
 *                  the pointer. Whether it still is, is judged by its whole
 *                  visual row including the line spacing, not by its glyph
 *                  box, so that a click between two rows never scrolls.
 *                  When a selection change switches a block between its
 *                  rendered display and its source (double-clicking an image,
 *                  moving the cursor into or out of a raw HTML block, ...),
 *                  the line directly above the switched block keeps its
 *                  position on screen (specification C13, section 4); the
 *                  decision compares snapshots of the line boxes of the
 *                  rendered viewport taken before and after the switch. A
 *                  click (a release without dragging) whose selection change
 *                  switches a block is such a display toggle as well: the
 *                  switch only becomes visible on release, but the line above
 *                  the block keeps its position instead of the clicked text
 *                  being brought back under the pointer.
 *                  A document change that carries the scroll flag without
 *                  setting the selection (cutting dispatches such a
 *                  `delete.cut` transaction) is not compensated if the
 *                  offscreen edit scroll took over its scroll request and
 *                  moved the cursor's row to one third of the visible height;
 *                  the anchor is re-based at that position instead
 *                  (specification C13, section 3, the exception to rule 5).
 *
 * END HEADER
 */

import { Facet, Prec, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { configField } from '../util/configuration'
import { pointerSelectionEndEffect, type PointerRelease } from '../util/reveal-selection'
import { offscreenEditHandledCount } from './offscreen-edit-scroll'
import {
  findToggleAnchor,
  isRowFullyVisible,
  toggleCompensationScrollTop,
  type LineBox
} from '../util/display-toggle-anchor'

/**
 * Scroll deviations (in pixels) larger than this are treated as an actual
 * scroll (by the user or another feature such as a "jump to line" command), in
 * which case the anchor is re-based instead of the previous position being
 * restored.
 */
const SCROLL_EPSILON = 2

/**
 * Matches a table whose cell is being edited (its column widths are locked;
 * the attribute is `LOCKED_WIDTHS_ATTRIBUTE` in `table-editor/widget.ts`).
 * The display toggle anchor does not act while a table cell is edited.
 */
const LOCKED_TABLE_SELECTOR = 'table[data-locked-col-widths="true"]'

/**
 * A snapshot of the line boxes of the rendered viewport (specification C13,
 * section 4.1).
 */
export interface LineBoxSnapshot {
  /**
   * One box per line block of the rendered viewport, sorted by line number;
   * coordinates are relative to the top of the scroller's visible area.
   */
  boxes: LineBox[]
  /**
   * The height of the scroller's visible area.
   */
  visibleHeight: number
  /**
   * The scroller's scrollTop when the snapshot was taken.
   */
  scrollTop: number
}

/**
 * A function that takes a snapshot of the line boxes of an editor's rendered
 * viewport, or returns null if the editor has no measurable geometry.
 */
export type LineBoxMeasurer = (view: EditorView) => LineBoxSnapshot|null

/**
 * Takes a snapshot of the line boxes of the rendered viewport from the height
 * map and the scroller's position. It neither triggers nor requires a measure
 * cycle, so it may also run inside a scroll handler during an update.
 *
 * @param   {EditorView}            view  The editor view
 *
 * @return  {LineBoxSnapshot|null}        The snapshot, or null
 */
export function measureLineBoxes (view: EditorView): LineBoxSnapshot|null {
  const scroller = view.scrollDOM
  if (scroller.clientHeight <= 0) {
    return null // Not mounted or not visible
  }

  const offset = view.documentTop - scroller.getBoundingClientRect().top
  const doc = view.state.doc
  const boxes = view.viewportLineBlocks.map(block => ({
    line: doc.lineAt(block.from).number,
    top: block.top + offset,
    bottom: block.bottom + offset
  }))
  return { boxes, visibleHeight: scroller.clientHeight, scrollTop: scroller.scrollTop }
}

/**
 * The function used to take snapshots of the line boxes. Defaults to
 * `measureLineBoxes`; tests provide a stand-in, since jsdom has no layout.
 * The first provided value wins.
 */
export const lineBoxMeasurer = Facet.define<LineBoxMeasurer, LineBoxMeasurer>({
  combine: values => values.length > 0 ? values[0] : measureLineBoxes
})

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
 * Rounds a scroll position to the nearest device pixel. Line boxes have
 * fractional coordinates, but the browser stores the scroll position in whole
 * device pixels and truncates a fractional assignment. Without rounding,
 * toggling a block back and forth would lose up to one pixel in the same
 * direction every time, so that the anchor line would creep by about a pixel
 * per round trip.
 *
 * @param   {number}  scrollTop   The scroll position in CSS pixels
 * @param   {number}  pixelRatio  Device pixels per CSS pixel
 *                                (`window.devicePixelRatio`); values that are
 *                                not finite and positive count as 1
 *
 * @return  {number}              The rounded scroll position in CSS pixels
 */
export function roundToDevicePixel (scrollTop: number, pixelRatio: number): number {
  const ratio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1
  return Math.round(scrollTop * ratio) / ratio
}

/**
 * Determines whether a visual row contains the given client y coordinate. The
 * row is the glyph box of a position (as returned by `coordsAtPos`), extended
 * above and below by half the line spacing, i.e. half of the line height
 * minus the glyph box height (never negative). Without the extension, the
 * gaps between the glyph boxes of adjacent rows would belong to no row.
 *
 * @param   {number}   glyphTop     Top of the glyph box
 * @param   {number}   glyphBottom  Bottom of the glyph box
 * @param   {number}   lineHeight   The line height of the row
 * @param   {number}   y            The client y coordinate to test
 *
 * @return  {boolean}               True if the row contains the coordinate
 */
export function rowBoxContains (glyphTop: number, glyphBottom: number, lineHeight: number, y: number): boolean {
  const halfSpacing = Math.max(0, lineHeight - (glyphBottom - glyphTop)) / 2
  return glyphTop - halfSpacing <= y && y <= glyphBottom + halfSpacing
}

/**
 * Returns the computed line height of the line element containing a document
 * position, or the editor's default line height if there is no such element
 * or its line height is no finite pixel value (such as `normal`).
 *
 * @param   {EditorView}  view      The editor view
 * @param   {number}      position  The document position
 *
 * @return  {number}                The line height in pixels
 */
function lineHeightAt (view: EditorView, position: number): number {
  const { node } = view.domAtPos(position)
  const element = node instanceof Element ? node : node.parentElement
  const line = element?.closest('.cm-line') ?? null
  if (line === null) {
    return view.defaultLineHeight
  }

  const lineHeight = parseFloat(window.getComputedStyle(line).lineHeight)
  return Number.isFinite(lineHeight) ? lineHeight : view.defaultLineHeight
}

/**
 * The deferred work the plugin may have scheduled for the end of the current
 * update cycle: re-basing the anchor to the current viewport, compensating
 * the scroll position so the anchor keeps its previous height, or keeping the
 * line above a display toggle in place (and then re-basing).
 */
export type PendingTask = 'none'|'compensate'|'toggle'|'rebase'

/**
 * The precedence of the pending tasks: when several updates of one cycle
 * request different tasks, the one ranked highest is performed.
 */
const TASK_RANK: Record<PendingTask, number> = { none: 0, compensate: 1, toggle: 2, rebase: 3 }

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
  /**
   * Where the mouse was released after a pointer selection, until the pending
   * task has brought the text that was under the pointer back under it.
   */
  private release: PointerRelease|null = null
  /**
   * The latest snapshot of the line boxes of the rendered viewport, taken in
   * the read phase of a measure cycle or after a scroll event.
   */
  private lineBoxes: LineBoxSnapshot|null = null
  /**
   * A display toggle waiting for its compensation: the line box snapshot from
   * before the update that set the selection.
   */
  private toggle: { before: LineBoxSnapshot }|null = null
  /**
   * Whether a display toggle has been compensated since the pending task was
   * scheduled (by the scroll handler or by the pending task itself).
   */
  private toggleCompensated = false
  private destroyed = false
  private readonly handleScroll: () => void
  private readonly lineBoxRequest = {
    key: this,
    read: (view: EditorView): LineBoxSnapshot|null => this.takeLineBoxes(view),
    write: (snapshot: LineBoxSnapshot|null): void => {
      this.lineBoxes = snapshot
    }
  }

  constructor (private readonly view: EditorView) {
    this.handleScroll = () => {
      // Scroll events are dispatched outside of editor updates, so the
      // snapshot can be taken right away.
      this.lineBoxes = this.takeLineBoxes(this.view)
      if (Math.abs(this.view.scrollDOM.scrollTop - this.baselineScrollTop) > SCROLL_EPSILON) {
        this.schedule('rebase')
      }
    }
    view.scrollDOM.addEventListener('scroll', this.handleScroll, { passive: true })
    view.requestMeasure(this.lineBoxRequest)
    this.schedule('rebase')
  }

  /**
   * The task currently scheduled for the end of the update cycle.
   */
  get scheduledTask (): PendingTask {
    return this.pendingTask
  }

  update (viewUpdate: ViewUpdate): void {
    if (this.anchor !== null && viewUpdate.docChanged) {
      this.anchor.position = viewUpdate.changes.mapPos(this.anchor.position, -1)
    }
    if (this.release !== null && this.release.position !== null && viewUpdate.docChanged) {
      this.release = { ...this.release, position: viewUpdate.changes.mapPos(this.release.position) }
    }

    const configuration = viewUpdate.state.field(configField, false)
    let release: PointerRelease|null|undefined
    for (const transaction of viewUpdate.transactions) {
      for (const effect of transaction.effects) {
        if (effect.is(pointerSelectionEndEffect)) {
          release = effect.value
        }
      }
    }

    const typewriterMode = configuration?.typewriterMode === true
    if (release !== undefined && !typewriterMode) {
      // Releasing the mouse after a pointer selection reveals the source of
      // the selected elements, which can shrink tall widgets such as images
      // to one line; the text that was under the released pointer is brought
      // back under it. Without a release (a cancelled pointer, a drop, a
      // focus loss) the anchor simply keeps its height. Although the ending
      // transaction sets the selection, it must not re-base: the anchor taken
      // before the reveal is what keeps the view still.
      // A click (no drag) whose selection change switches a block between
      // its rendered display and its source is a display toggle that only
      // becomes visible now, since the reveal was frozen while the button was
      // held: the snapshot from before this update is kept, and if a block
      // did switch, the line above it keeps its position (specification
      // C13, section 3, rule 3) instead of the clicked text being brought
      // back under the pointer, which would push everything above it away.
      this.release = release
      if (release !== null && release.click === true && this.isToggleCandidate(viewUpdate, false)) {
        if (this.toggle === null && this.lineBoxes !== null) {
          this.toggle = { before: this.lineBoxes }
        }
      }
      this.schedule('compensate')
    } else if (this.isToggleCandidate(viewUpdate, typewriterMode)) {
      // The selection moved without modifying the document, which may switch
      // a block between its rendered display and its source. Whether it did
      // can only be told from the layout after this update, so the decision
      // is deferred; the snapshot from before this update is kept for it.
      // The height map flag of this update is not required, since it only
      // reflects estimated heights at this point.
      if (this.toggle === null && this.lineBoxes !== null) {
        this.toggle = { before: this.lineBoxes }
      }
      this.schedule('toggle')
    } else if (viewUpdate.selectionSet || typewriterMode) {
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

    // Refresh the line box snapshot once the layout reflects this update.
    this.view.requestMeasure(this.lineBoxRequest)
  }

  /**
   * Answers a scroll request of CodeMirror's measure cycle. While a display
   * toggle waits for its compensation, the compensation is performed here
   * (the DOM already reflects the toggle), and the request is reported as
   * handled if the primary cursor's row is then entirely visible, so that
   * the cursor margin scrolling does not move the view again. Otherwise the
   * request is left to CodeMirror.
   *
   * @return  {boolean}  True if the request was handled
   */
  handleScrollRequest (): boolean {
    if (this.toggle === null) {
      return false
    }

    try {
      if (!this.applyToggle()) {
        return false
      }
      const cursorRow = this.cursorRow()
      return cursorRow !== null && isRowFullyVisible(cursorRow.top, cursorRow.bottom, this.view.scrollDOM.clientHeight)
    } catch (err) {
      console.warn('[Preserve Scroll Anchor] Could not keep the line above a display toggle in place:', err)
      this.toggle = null
      return false
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
   * so the two mechanisms never both compensate for the same shift. If that
   * measure cycle is still pending when the compensation runs, the
   * compensation runs it first; should the offscreen edit scroll answer the
   * cycle's scroll request (by scrolling the cursor's row to one third of the
   * visible height), the compensation yields to it and only re-bases
   * (specification C13, section 3, the exception to rule 5).
   */
  private schedule (task: 'compensate'|'toggle'|'rebase'): void {
    const escalated = TASK_RANK[task] > TASK_RANK[this.pendingTask] ? task : this.pendingTask
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
      this.toggle = null
      this.toggleCompensated = false
      return
    }

    const release = this.release
    this.release = null
    // A released click may be a display toggle (see `update`)
    const clickToggle = release !== null && release.click === true &&
      (this.toggle !== null || this.toggleCompensated)
    if (!clickToggle && (release !== null || task !== 'toggle')) {
      this.toggle = null
    }

    try {
      if (release !== null) {
        // Rule 3 of specification C13, section 3, takes precedence over rule
        // 2 for a click that switched a block's display; otherwise (a drag,
        // or a click that switched nothing) the released text is brought
        // back under the pointer.
        if (!(clickToggle && this.runToggle())) {
          this.placeReleasedPosition(release)
        }
        this.rebase()
      } else if (task === 'rebase') {
        this.rebase()
      } else if (task === 'toggle') {
        this.runToggle()
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
    } finally {
      this.toggle = null
      this.toggleCompensated = false
    }
  }

  /**
   * Determines whether an update may switch a block between its rendered
   * display and its source: it sets the selection without modifying the
   * document, outside the typewriter mode and table cell editing, and nobody
   * scrolled since the latest line box snapshot.
   *
   * @param   {ViewUpdate}  viewUpdate      The update
   * @param   {boolean}     typewriterMode  Whether the typewriter mode is on
   *
   * @return  {boolean}                     True if the update is a candidate
   */
  private isToggleCandidate (viewUpdate: ViewUpdate, typewriterMode: boolean): boolean {
    if (!viewUpdate.selectionSet || viewUpdate.docChanged || typewriterMode) {
      return false
    }
    if (this.toggle !== null) {
      return true // An earlier update of this cycle already is a candidate
    }

    const snapshot = this.lineBoxes
    if (snapshot === null) {
      return false
    }
    if (Math.abs(this.view.scrollDOM.scrollTop - snapshot.scrollTop) > SCROLL_EPSILON) {
      return false // Scrolled since the snapshot: it no longer describes the view
    }

    return this.view.dom.querySelector(LOCKED_TABLE_SELECTOR) === null
  }

  /**
   * Performs a pending display toggle compensation. Any layout query through
   * the view first runs CodeMirror's pending measure cycle, during which a
   * scroll request of the toggling transaction reaches `handleScrollRequest`
   * (which then already performs the compensation); without such a request,
   * the compensation is performed afterwards.
   *
   * @return  {boolean}  True if a display toggle has been compensated since
   *                     the pending task was scheduled
   */
  private runToggle (): boolean {
    try {
      this.view.coordsAtPos(this.view.state.selection.main.head)
    } catch (err) {
      // The measure cycle is best-effort here; the compensation below uses
      // the height map, which is current enough without it.
    }

    if (this.toggle !== null) {
      this.applyToggle()
    }
    return this.toggleCompensated
  }

  /**
   * Compensates a display toggle: determines the anchor line from the line
   * boxes before and after the toggle and scrolls so that the anchor line's
   * top is where it was before. Consumes the pending toggle.
   *
   * @return  {boolean}  True if a display toggle was found and compensated
   */
  private applyToggle (): boolean {
    const toggle = this.toggle
    this.toggle = null
    if (toggle === null) {
      return false
    }

    const after = this.takeLineBoxes(this.view)
    if (after === null) {
      return false
    }

    const anchor = findToggleAnchor(toggle.before.boxes, after.boxes, toggle.before.visibleHeight)
    if (anchor === null) {
      return false // No visible block switched its display
    }

    const anchorAfter = after.boxes.find(box => box.line === anchor.line)
    if (anchorAfter === undefined) {
      return false
    }

    const scroller = this.view.scrollDOM
    const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    const target = toggleCompensationScrollTop(scroller.scrollTop, anchorAfter.top, anchor.top, maxScrollTop)
    scroller.scrollTop = Math.min(roundToDevicePixel(target, window.devicePixelRatio), maxScrollTop)
    this.baselineScrollTop = scroller.scrollTop
    this.toggleCompensated = true
    return true
  }

  /**
   * Returns the visual row of the primary cursor relative to the top of the
   * scroller's visible area. Since this may run inside a scroll handler while
   * the view is still updating (where reading the layout through the view
   * throws), the DOM is queried directly; if that yields no row, the line box
   * containing the cursor stands in for it.
   *
   * @return  {{ top: number, bottom: number }|null}  The row, or null
   */
  private cursorRow (): { top: number, bottom: number }|null {
    const view = this.view
    const head = view.state.selection.main.head
    const visibleTop = view.scrollDOM.getBoundingClientRect().top
    const { node, offset } = view.domAtPos(head)
    if (node.nodeType === node.TEXT_NODE) {
      const range = view.dom.ownerDocument.createRange()
      range.setStart(node, offset)
      range.collapse(true)
      const rects = range.getClientRects()
      if (rects.length > 0) {
        return { top: rects[0].top - visibleTop, bottom: rects[0].bottom - visibleTop }
      }
    }

    const snapshot = this.takeLineBoxes(view)
    if (snapshot === null) {
      return null
    }
    const cursorLine = view.state.doc.lineAt(head).number
    let row: LineBox|null = null
    for (const box of snapshot.boxes) {
      if (box.line > cursorLine) {
        break
      }
      row = box
    }
    return row
  }

  private takeLineBoxes (view: EditorView): LineBoxSnapshot|null {
    try {
      return view.state.facet(lineBoxMeasurer)(view)
    } catch (err) {
      // The snapshot is best-effort: without one, display toggles are simply
      // treated like any other cursor movement.
      console.warn('[Preserve Scroll Anchor] Could not measure the line boxes:', err)
      return null
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

  /**
   * Scrolls so that the visual row of the text that was under the released
   * pointer contains the pointer's client y coordinate (clamped into the
   * visible area) again. If the position under the pointer is unknown, the
   * primary selection head stands in for it. The row is the whole row box
   * including the line spacing (see `rowBoxContains`). Does nothing if the
   * row already contains the coordinate or the position is not rendered.
   *
   * @param  {PointerRelease}  release  Where the mouse was released
   */
  private placeReleasedPosition (release: PointerRelease): void {
    const view = this.view
    const scroller = view.scrollDOM
    const scrollerTop = scroller.getBoundingClientRect().top
    const targetY = Math.min(Math.max(release.clientY, scrollerTop), scrollerTop + scroller.clientHeight)
    const position = Math.min(release.position ?? view.state.selection.main.head, view.state.doc.length)
    // At a soft line break, one position both ends a visual row and starts
    // the next one; the pointer may have been over either of them.
    const rowEnd = view.coordsAtPos(position, -1)
    const rowStart = view.coordsAtPos(position, 1)
    const rowRect = rowStart ?? rowEnd
    if (rowRect === null) {
      return
    }

    const lineHeight = lineHeightAt(view, position)
    for (const rect of [ rowEnd, rowStart ]) {
      if (rect !== null && rowBoxContains(rect.top, rect.bottom, lineHeight, targetY)) {
        return
      }
    }

    scroller.scrollTop += (rowRect.top + rowRect.bottom) / 2 - targetY
  }

  private compensate (): void {
    if (this.anchor === null) {
      this.rebase()
      return
    }

    const scroller = this.view.scrollDOM
    // Run CodeMirror's pending measure cycle now (any layout query through
    // the view does), noting the scroll position before it: the cycle's own
    // top-line anchoring may move the view, which is no actual scroll and is
    // compensated below like any other shift.
    const scrollTopBeforeMeasure = scroller.scrollTop
    const handledBefore = offscreenEditHandledCount(this.view)
    try {
      this.view.coordsAtPos(this.view.state.selection.main.head)
    } catch (err) {
      // The measure cycle is best-effort here; the layout query below runs
      // it again if it is still pending.
    }
    if (offscreenEditHandledCount(this.view) > handledBefore) {
      // The offscreen edit scroll answered the cycle's scroll request and
      // moved the cursor's row to one third of the visible height (e.g.,
      // after cutting, whose transaction does not set the selection). That
      // position wins and becomes the new baseline (specification C13,
      // section 3, the exception to rule 5). Only the count's increase during
      // this very cycle counts, so earlier takeovers never suppress a later
      // compensation.
      this.rebase()
      return
    }

    if (Math.abs(scrollTopBeforeMeasure - this.baselineScrollTop) > SCROLL_EPSILON) {
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

const scrollAnchorPlugin = ViewPlugin.fromClass(ScrollAnchorKeeper)

/**
 * Returns the task the scroll stabilization has scheduled for the end of the
 * current update cycle, or null if the extension is not installed.
 *
 * @param   {EditorView}          view  The editor view
 *
 * @return  {PendingTask|null}          The scheduled task, or null
 */
export function pendingScrollAnchorTask (view: EditorView): PendingTask|null {
  return view.plugin(scrollAnchorPlugin)?.scheduledTask ?? null
}

/**
 * An extension that keeps the viewport visually stable when the document's
 * total display height changes without the user scrolling: if the primary
 * cursor is visible, its height on screen is kept unchanged; otherwise, the
 * line at one third of the viewport height is kept stationary. When a
 * selection change switches a block between its rendered display and its
 * source, the line above the block keeps its position instead. The scroll
 * handler has the lowest precedence so that the table editor's handler and
 * the offscreen edit scroll's handler run first (specification C13, section
 * 3). A document change whose scroll request the offscreen edit scroll
 * answered is not compensated; the anchor is re-based at the new position
 * instead (the exception to rule 5 of that section).
 */
export const preserveScrollAnchor: Extension = [
  scrollAnchorPlugin,
  Prec.lowest(EditorView.scrollHandler.of(view => {
    return view.plugin(scrollAnchorPlugin)?.handleScrollRequest() ?? false
  }))
]
