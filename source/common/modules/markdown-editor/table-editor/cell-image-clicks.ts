/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        handleCellImageMousedown, cellImageSourceRanges,
 *                  imageSourceRangeForIndex, advanceImageClick,
 *                  millisecondsUntilTimeout
 * CVM-Role:        Controller
 * License:         GNU GPL v3
 *
 * Description:     Clicks on the images inside a table cell that is not being
 *                  edited. A single click opens the image in the image
 *                  lightbox instead of the cell's editor, a double click opens
 *                  the cell's editor with the complete source of the image
 *                  selected, and a press followed by a drag keeps the cell's
 *                  usual text and cell range selection. The timing of single
 *                  and double clicks and the mapping from a rendered image to
 *                  its source are pure functions that are exported for
 *                  testing.
 *
 * END HEADER
 */

import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { imageSourceRange } from '../util/image-selection'
import { isRenderableImageNode } from '../util/image-only-lines'
import { openImageLightbox } from '../util/image-lightbox'

/**
 * How long, in milliseconds, a released single click waits for a second
 * press before it opens the image lightbox
 */
export const CLICK_WAIT_MILLISECONDS = 300

/**
 * How far, in pixels, the mouse has to move with the button pressed for the
 * press to count as a drag instead of a click (the same distance as the drag
 * tracking of the cell range selection)
 */
export const DRAG_THRESHOLD_PIXELS = 4

/**
 * A range in the document
 */
export interface SourceRange {
  from: number
  to: number
}

/**
 * Nodes whose contents never show up as images in a rendered cell: code is
 * shown verbatim, and comments and footnotes are not rendered in place.
 */
const NODES_WITHOUT_IMAGES = [ 'InlineCode', 'Comment', 'Footnote' ]

/**
 * Returns the source ranges of the images that a table cell renders, in
 * document order, i.e., in the order of the `<img>` elements in the rendered
 * cell. A Markdown image covers everything from `!` to `)` plus the Pandoc
 * attributes (`{…}`) directly following it, an inline HTML `<img>` covers the
 * complete tag. Images that are not rendered as images (e.g., without a
 * source) and anything inside inline code are left out.
 *
 * @param   {EditorState}    state     The editor state
 * @param   {number}         cellFrom  The start of the cell's contents
 * @param   {number}         cellTo    The end of the cell's contents
 *
 * @return  {SourceRange[]}            The source ranges of the images
 */
export function cellImageSourceRanges (state: EditorState, cellFrom: number, cellTo: number): SourceRange[] {
  const ranges: SourceRange[] = []
  if (cellFrom >= cellTo) {
    return ranges
  }

  syntaxTree(state).iterate({
    from: cellFrom,
    to: cellTo,
    enter: (node) => {
      if (node.from < cellFrom || node.to > cellTo) {
        // The nodes around the cell (table, row, the cell node itself) and
        // neighbors that only touch it: only their insides can belong to it
        return true
      }

      if (NODES_WITHOUT_IMAGES.includes(node.name)) {
        return false
      }

      if (node.name === 'Image') {
        if (isRenderableImageNode(state, node)) {
          ranges.push(imageSourceRange(state, node.from) ?? { from: node.from, to: node.to })
        }
        // The label of an image is rendered as its alternative text, so
        // anything inside it is no image of its own.
        return false
      }

      if (node.name === 'HTMLTag' && /^<img\b/i.test(state.sliceDoc(node.from, node.to))) {
        ranges.push({ from: node.from, to: node.to })
      }

      return true
    }
  })

  return ranges
}

/**
 * Maps a rendered image to its source range. The image is identified by its
 * index among the `<img>` elements of the rendered cell. If the number of
 * rendered images differs from the number of source ranges, the mapping is
 * ambiguous and nothing is returned.
 *
 * @param   {SourceRange[]}  ranges              The source ranges of the
 *                                               cell's images, in document
 *                                               order
 * @param   {number}         index               The index of the image among
 *                                               the rendered images
 * @param   {number}         renderedImageCount  How many images the rendered
 *                                               cell contains
 *
 * @return  {SourceRange|undefined}              The source range, or undefined
 */
export function imageSourceRangeForIndex (
  ranges: readonly SourceRange[],
  index: number,
  renderedImageCount: number
): SourceRange|undefined {
  if (ranges.length !== renderedImageCount || !Number.isInteger(index) || index < 0 || index >= ranges.length) {
    return undefined
  }

  return ranges[index]
}

/**
 * Where a click on a cell image currently stands: nothing is going on, the
 * button is down on an image, or it has been released and the click waits
 * for a second press.
 */
export type ImageClickState =
  | { phase: 'idle' }
  | { phase: 'pressed', image: unknown, x: number, y: number }
  | { phase: 'released', image: unknown, releasedAt: number }

/**
 * The state in which nothing is going on
 */
export const IDLE_IMAGE_CLICK: ImageClickState = { phase: 'idle' }

/**
 * What happens to a click: a button press (on `image`, with the click count
 * `detail`), a mouse movement, the button release, the expiry of the waiting
 * time, or an outside reason to give up. Positions are in pixels, times in
 * milliseconds.
 */
export type ImageClickInput =
  | { type: 'press', image: unknown, x: number, y: number, detail: number }
  | { type: 'move', x: number, y: number }
  | { type: 'release', time: number }
  | { type: 'timeout', time: number }
  | { type: 'cancel' }

/**
 * What to do after an input: keep waiting, open the image lightbox, select
 * the image's source (double click), let the cell's drag selection take over,
 * or nothing (the input does not concern the click).
 */
export type ImageClickDecision = 'wait'|'open-preview'|'double-click'|'drag'|'none'

/**
 * The result of an input: the new state and what to do
 */
export interface ImageClickStep {
  state: ImageClickState
  decision: ImageClickDecision
}

/**
 * Advances the distinction between a single click, a double click, and a
 * drag on a cell image by one input.
 *
 * - A press after a released click on the same image that the browser counts
 *   as a repeated click (`detail >= 2`) is a double click, even if the waiting
 *   time has just expired: the image lightbox recognizes such a late second
 *   click as well, so the result is the same. Any other press starts a new
 *   click and discards the previous one.
 * - Moving the mouse by DRAG_THRESHOLD_PIXELS or more while the button is down
 *   hands the press over to the drag selection.
 * - Releasing the button starts the wait for a second press.
 * - Once CLICK_WAIT_MILLISECONDS have passed since the release without a
 *   second press, the click opens the image lightbox.
 *
 * @param   {ImageClickState}  state  The current state
 * @param   {ImageClickInput}  input  What happened
 *
 * @return  {ImageClickStep}          The new state and what to do
 */
export function advanceImageClick (state: ImageClickState, input: ImageClickInput): ImageClickStep {
  if (input.type === 'press') {
    if (state.phase === 'released' && state.image === input.image && input.detail >= 2) {
      return { state: IDLE_IMAGE_CLICK, decision: 'double-click' }
    }

    return {
      state: { phase: 'pressed', image: input.image, x: input.x, y: input.y },
      decision: 'wait'
    }
  }

  if (input.type === 'move') {
    if (state.phase !== 'pressed') {
      return { state, decision: 'none' }
    }

    if (Math.hypot(input.x - state.x, input.y - state.y) >= DRAG_THRESHOLD_PIXELS) {
      return { state: IDLE_IMAGE_CLICK, decision: 'drag' }
    }

    return { state, decision: 'wait' }
  }

  if (input.type === 'release') {
    if (state.phase !== 'pressed') {
      return { state, decision: 'none' }
    }

    return {
      state: { phase: 'released', image: state.image, releasedAt: input.time },
      decision: 'wait'
    }
  }

  if (input.type === 'timeout') {
    if (state.phase !== 'released') {
      return { state, decision: 'none' }
    }

    if (input.time - state.releasedAt >= CLICK_WAIT_MILLISECONDS) {
      return { state: IDLE_IMAGE_CLICK, decision: 'open-preview' }
    }

    return { state, decision: 'wait' }
  }

  // The click has been cancelled
  return { state: IDLE_IMAGE_CLICK, decision: 'none' }
}

/**
 * Returns how long a released click still has to wait before the waiting
 * time expires.
 *
 * @param   {ImageClickState}     state  The current state
 * @param   {number}              now    The current time, in milliseconds
 *
 * @return  {number|undefined}           The remaining milliseconds (at least
 *                                       0), or undefined if the click is not
 *                                       waiting for a second press
 */
export function millisecondsUntilTimeout (state: ImageClickState, now: number): number|undefined {
  if (state.phase !== 'released') {
    return undefined
  }

  return Math.max(0, state.releasedAt + CLICK_WAIT_MILLISECONDS - now)
}

/**
 * The cell's usual handling of a button press, which a click on an image
 * falls back to
 */
export interface CellClickFallback {
  /**
   * Places the cursor at the pressed position (which opens the cell's editor)
   * and follows a drag from there
   */
  placeCursorAndTrackDrag: (event: MouseEvent) => void
  /** Only places the cursor at the pressed position */
  placeCursor: (event: MouseEvent) => void
}

/**
 * A click on a cell image that has not been decided yet
 */
interface PendingClick {
  /** Where the click stands */
  state: ImageClickState
  /** The main view */
  view: EditorView
  /** The table cell that contains the image */
  cell: HTMLElement
  /** The clicked image */
  image: HTMLImageElement
  /** The first button press */
  pressEvent: MouseEvent
  /** The cell's usual handling of a button press */
  fallback: CellClickFallback
  /** The timer that waits for a second press */
  timer: ReturnType<typeof setTimeout>|undefined
}

let pending: PendingClick|null = null

/**
 * Gives up the pending click: stops its timer and removes the listeners.
 */
function endPendingClick (): void {
  const click = pending
  if (click === null) {
    return
  }

  if (click.timer !== undefined) {
    clearTimeout(click.timer)
    click.timer = undefined
  }

  pending = null
  window.removeEventListener('mousedown', onWindowMousedown, true)
  window.removeEventListener('mousemove', onWindowMousemove, true)
  window.removeEventListener('mouseup', onWindowMouseup, true)
}

/**
 * Opens the cell's editor with the complete source of the clicked image
 * selected. If the image cannot be mapped to its source unambiguously, only
 * the cursor is placed at the pressed position instead.
 *
 * @param   {PendingClick}  click  The click on the image
 */
function editImageSource (click: PendingClick): void {
  const { view, cell, image, pressEvent, fallback } = click
  if (!cell.isConnected) {
    return
  }

  // The cell's range is read now, since the document may have changed since
  // the press.
  const content = cell.querySelector<HTMLElement>('div.content')
  const cellFrom = parseInt(cell.dataset.cellFrom ?? '', 10)
  const cellTo = parseInt(cell.dataset.cellTo ?? '', 10)
  let range: SourceRange|undefined
  if (content !== null && !Number.isNaN(cellFrom) && !Number.isNaN(cellTo)) {
    const images = Array.from(content.querySelectorAll('img'))
    const ranges = cellImageSourceRanges(view.state, cellFrom, cellTo)
    range = imageSourceRangeForIndex(ranges, images.indexOf(image), images.length)
  }

  if (range === undefined) {
    fallback.placeCursor(pressEvent)
    return
  }

  // The selection in the cell makes the table mount the cell's editor, which
  // takes over the selection and receives the focus.
  view.dispatch({ selection: { anchor: range.from, head: range.to } })
}

/**
 * Waits for the given time and then checks whether the click has to open the
 * image lightbox.
 *
 * @param   {PendingClick}  click  The pending click
 * @param   {number}        delay  The time to wait, in milliseconds
 */
function scheduleTimeout (click: PendingClick, delay: number): void {
  if (click.timer !== undefined) {
    clearTimeout(click.timer)
  }

  click.timer = setTimeout(() => {
    onClickTimeout(click)
  }, delay)
}

/**
 * Called when the waiting time of a released click may have expired.
 *
 * @param   {PendingClick}  click  The pending click
 */
function onClickTimeout (click: PendingClick): void {
  if (pending !== click) {
    return
  }

  click.timer = undefined
  const now = performance.now()
  const step = advanceImageClick(click.state, { type: 'timeout', time: now })
  click.state = step.state

  if (step.decision === 'open-preview') {
    endPendingClick()
    const { image } = click
    if (!image.isConnected) {
      return
    }

    openImageLightbox({
      source: image.currentSrc !== '' ? image.currentSrc : image.src,
      alternativeText: image.alt,
      onLateDoubleClick: () => {
        editImageSource(click)
      }
    })
  } else if (step.decision === 'wait') {
    const remaining = millisecondsUntilTimeout(click.state, now)
    if (remaining !== undefined) {
      scheduleTimeout(click, remaining)
    }
  }
}

/**
 * Any button press while a click is pending (capture phase on the window, so
 * that it runs before the cell and the editor see the press). A second press
 * on the same image is a double click; any other press ends the pending click
 * and is handled as usual (a press on a cell image starts a new click).
 *
 * @param   {MouseEvent}  event  The button press
 */
function onWindowMousedown (event: MouseEvent): void {
  const click = pending
  if (click === null) {
    return
  }

  const step = advanceImageClick(click.state, {
    type: 'press',
    image: event.button === 0 ? event.target : null,
    x: event.clientX,
    y: event.clientY,
    detail: event.detail
  })
  endPendingClick()

  if (step.decision === 'double-click') {
    event.preventDefault()
    event.stopPropagation()
    editImageSource(click)
  }
}

/**
 * Mouse movements while a click is pending (capture phase on the window). A
 * movement beyond the drag threshold with the button down hands the press over
 * to the cell's usual handling, which selects text or a range of cells.
 *
 * @param   {MouseEvent}  event  The mouse movement
 */
function onWindowMousemove (event: MouseEvent): void {
  const click = pending
  if (click === null) {
    return
  }

  if (click.state.phase === 'pressed' && (event.buttons & 1) === 0) {
    // The button was released outside the window, where no mouseup arrives
    endPendingClick()
    return
  }

  const step = advanceImageClick(click.state, { type: 'move', x: event.clientX, y: event.clientY })
  click.state = step.state
  if (step.decision !== 'drag') {
    return
  }

  endPendingClick()
  // The drag tracking starts only now, with the original press. It attaches
  // its listeners to the document. Since this listener runs in the capture
  // phase on the window, the movement handled right now has not reached the
  // document yet and will still be delivered to those listeners when it
  // bubbles up, so the tracking sees the mouse beyond its threshold at once.
  click.fallback.placeCursorAndTrackDrag(click.pressEvent)
}

/**
 * The button release while a click is pending (capture phase on the window):
 * the click starts waiting for a second press.
 *
 * @param   {MouseEvent}  event  The button release
 */
function onWindowMouseup (event: MouseEvent): void {
  const click = pending
  if (click === null || event.button !== 0) {
    return
  }

  const step = advanceImageClick(click.state, { type: 'release', time: performance.now() })
  click.state = step.state
  if (step.decision === 'wait') {
    scheduleTimeout(click, CLICK_WAIT_MILLISECONDS)
  }
}

/**
 * Handles a button press in a table cell if it is a plain left click on a
 * loaded image in a cell that is not being edited. The press then neither
 * places the cursor nor opens the cell's editor; what follows decides between
 * the image lightbox (single click), selecting the image's source (double
 * click), and the cell's usual handling (drag). Any other press is left to
 * the caller.
 *
 * @param   {EditorView}         view      The main view
 * @param   {HTMLElement}        cell      The table cell
 * @param   {MouseEvent}         event     The button press
 * @param   {CellClickFallback}  fallback  The cell's usual handling of a press
 *
 * @return  {boolean}                      True if the press has been handled
 */
export function handleCellImageMousedown (
  view: EditorView,
  cell: HTMLElement,
  event: MouseEvent,
  fallback: CellClickFallback
): boolean {
  // Clicks with modifier keys keep their usual meaning
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
    return false
  }

  const content = cell.querySelector<HTMLElement>('div.content')
  if (content === null || content.classList.contains('editing')) {
    return false
  }

  const image = event.target
  if (!(image instanceof HTMLImageElement) || !content.contains(image)) {
    return false
  }

  // An image that failed to load has nothing to show
  if (!image.complete || image.naturalWidth <= 0) {
    return false
  }

  event.preventDefault()
  event.stopPropagation()

  endPendingClick()
  const step = advanceImageClick(IDLE_IMAGE_CLICK, {
    type: 'press',
    image,
    x: event.clientX,
    y: event.clientY,
    detail: event.detail
  })
  pending = { state: step.state, view, cell, image, pressEvent: event, fallback, timer: undefined }
  window.addEventListener('mousedown', onWindowMousedown, true)
  window.addEventListener('mousemove', onWindowMousemove, true)
  window.addEventListener('mouseup', onWindowMouseup, true)
  return true
}
