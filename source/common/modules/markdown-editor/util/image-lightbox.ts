/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        openImageLightbox, closeImageLightbox, isImageLightboxOpen,
 *                  clampScale, computeFitScale, wheelZoomFactor,
 *                  zoomAroundPointer, isLateDoubleClick
 * CVM-Role:        View
 * License:         GNU GPL v3
 *
 * Description:     A full-window overlay that shows a single image on its own.
 *                  The image starts fitted into the window (large images are
 *                  scaled down, small ones keep their natural size), the mouse
 *                  wheel zooms around the pointer, and dragging the image pans
 *                  it. Escape, a click on the background, or the close button
 *                  closes the overlay and returns the focus to where it was.
 *                  While the overlay is open, keyboard, wheel, and mouse
 *                  events do not reach the editor. The geometry is computed by
 *                  pure functions that are exported for testing.
 *
 * END HEADER
 */

import { EditorView } from '@codemirror/view'

/**
 * The space, in pixels, that a fitted image keeps from each edge of the window
 */
export const LIGHTBOX_MARGIN = 32

/**
 * The smallest display scale, relative to the natural size of the image (5%)
 */
export const MINIMUM_SCALE = 0.05

/**
 * The largest display scale, relative to the natural size of the image (2000%)
 */
export const MAXIMUM_SCALE = 20

/**
 * The factor by which one step of the mouse wheel zooms in (zooming out
 * divides by it)
 */
export const WHEEL_ZOOM_STEP = 1.25

/**
 * How long after the overlay has opened, in milliseconds, a button press that
 * the browser counts as the second click of a double click still counts as a
 * double click on the image that opened the overlay
 */
export const LATE_DOUBLE_CLICK_MILLISECONDS = 600

/**
 * How far, in pixels, the mouse may move between pressing and releasing the
 * button on the background for this to still count as a click
 */
const BACKGROUND_CLICK_TOLERANCE = 4

/**
 * The id of the style element that holds the styles of the overlay
 */
const STYLE_ELEMENT_ID = 'zettlr-image-lightbox-style'

/**
 * The styles of the overlay. They are the same for the light and dark themes.
 * The overlay is no drag region: otherwise the window toolbar underneath it
 * would keep moving the window on presses at the top of the overlay, and the
 * close button would never receive a click.
 */
const LIGHTBOX_STYLES = `
.zettlr-image-lightbox {
  position: fixed;
  inset: 0;
  z-index: 100000;
  background-color: rgba(0, 0, 0, 0.85);
  overflow: hidden;
  outline: none;
  user-select: none;
  -webkit-app-region: no-drag;
}

.zettlr-image-lightbox-image {
  position: absolute;
  left: 50%;
  top: 50%;
  max-width: none;
  max-height: none;
  margin: 0;
  padding: 0;
  border: none;
  transform-origin: 50% 50%;
  cursor: grab;
}

.zettlr-image-lightbox.panning,
.zettlr-image-lightbox.panning .zettlr-image-lightbox-image {
  cursor: grabbing;
}

.zettlr-image-lightbox-close {
  position: absolute;
  top: 16px;
  right: 16px;
  width: 36px;
  height: 36px;
  margin: 0;
  padding: 0;
  border: none;
  border-radius: 50%;
  background-color: rgba(255, 255, 255, 0.2);
  color: #ffffff;
  font-size: 24px;
  line-height: 36px;
  text-align: center;
  cursor: pointer;
}

.zettlr-image-lightbox-close:hover {
  background-color: rgba(255, 255, 255, 0.35);
}
`

/**
 * Clamps a display scale to the allowed range.
 *
 * @param   {number}  scale  The scale, relative to the natural size
 *
 * @return  {number}         The scale between MINIMUM_SCALE and MAXIMUM_SCALE
 *                           (1 if the scale is not a number)
 */
export function clampScale (scale: number): number {
  if (Number.isNaN(scale)) {
    return 1
  }

  return Math.min(MAXIMUM_SCALE, Math.max(MINIMUM_SCALE, scale))
}

/**
 * Computes the scale at which an image fits into the available area: images
 * larger than the area are scaled down proportionally until they just fit,
 * smaller images keep their natural size (they are never enlarged).
 *
 * @param   {number}  naturalWidth     The natural width of the image, in pixels
 * @param   {number}  naturalHeight    The natural height of the image, in pixels
 * @param   {number}  availableWidth   The width of the available area
 * @param   {number}  availableHeight  The height of the available area
 *
 * @return  {number}                   The scale, at most 1 and at least
 *                                     MINIMUM_SCALE (1 if the image has no
 *                                     size)
 */
export function computeFitScale (
  naturalWidth: number,
  naturalHeight: number,
  availableWidth: number,
  availableHeight: number
): number {
  const hasSize = naturalWidth > 0 && naturalHeight > 0
  if (!hasSize) {
    return 1
  }

  return clampScale(Math.min(
    1,
    Math.max(0, availableWidth) / naturalWidth,
    Math.max(0, availableHeight) / naturalHeight
  ))
}

/**
 * Returns the factor by which one wheel event zooms the image.
 *
 * @param   {number}  deltaY  The vertical delta of the wheel event
 *
 * @return  {number}          WHEEL_ZOOM_STEP when the wheel moves up (zoom
 *                            in), its inverse when it moves down (zoom out),
 *                            and 1 otherwise
 */
export function wheelZoomFactor (deltaY: number): number {
  if (deltaY < 0) {
    return WHEEL_ZOOM_STEP
  }

  if (deltaY > 0) {
    return 1 / WHEEL_ZOOM_STEP
  }

  return 1
}

/**
 * How the image is displayed: its center is shown at the center of the
 * overlay shifted by the pan, and it is scaled around its center.
 */
export interface LightboxView {
  /** The display scale, relative to the natural size of the image */
  scale: number
  /** The horizontal offset of the image center from the overlay center */
  panX: number
  /** The vertical offset of the image center from the overlay center */
  panY: number
}

/**
 * Zooms the image around the pointer: the point of the image under the
 * pointer stays at the same position on the screen. The new scale is clamped
 * to the allowed range; the pan then follows the factor that was actually
 * applied.
 *
 * @param   {LightboxView}  view      The current view
 * @param   {number}        factor    The requested zoom factor
 * @param   {number}        pointerX  The horizontal position of the pointer
 *                                    relative to the displayed center of the
 *                                    image, in pixels
 * @param   {number}        pointerY  The vertical position of the pointer
 *                                    relative to the displayed center of the
 *                                    image, in pixels
 *
 * @return  {LightboxView}            The new view
 */
export function zoomAroundPointer (view: LightboxView, factor: number, pointerX: number, pointerY: number): LightboxView {
  const scale = clampScale(view.scale * factor)
  const applied = scale / view.scale
  return {
    scale,
    panX: view.panX + pointerX * (1 - applied),
    panY: view.panY + pointerY * (1 - applied)
  }
}

/**
 * Checks whether a button press on the overlay is the late second click of a
 * double click on the image that opened it: the browser counts the press as
 * a repeated click, and it arrives shortly after the overlay has opened.
 *
 * @param   {number}   openedAt   When the overlay opened, in milliseconds
 * @param   {number}   pressedAt  When the button was pressed, in milliseconds
 * @param   {number}   detail     The click count of the press (`event.detail`)
 *
 * @return  {boolean}             True if the press is a late double click
 */
export function isLateDoubleClick (openedAt: number, pressedAt: number, detail: number): boolean {
  return detail >= 2 && pressedAt >= openedAt && pressedAt - openedAt <= LATE_DOUBLE_CLICK_MILLISECONDS
}

/**
 * The options for opening the overlay
 */
export interface ImageLightboxOptions {
  /** The address of the image, as the browser resolved it */
  source: string
  /** The alternative text of the image; it labels the overlay */
  alternativeText?: string
  /**
   * Called (after the overlay has closed) when a press that the browser counts
   * as a double click arrives within LATE_DOUBLE_CLICK_MILLISECONDS after
   * opening, i.e., the user double-clicked the image, but the second click
   * came too late to keep the overlay from opening.
   */
  onLateDoubleClick?: () => void
}

/**
 * The overlay that is currently open
 */
interface OpenLightbox {
  /** Closes the overlay and removes all of its listeners */
  close: () => void
}

let current: OpenLightbox|null = null

/**
 * Adds the styles of the overlay to the document, unless they are there
 * already.
 */
function injectStyles (): void {
  if (document.getElementById(STYLE_ELEMENT_ID) !== null) {
    return
  }

  const style = document.createElement('style')
  style.id = STYLE_ELEMENT_ID
  style.textContent = LIGHTBOX_STYLES
  document.head.appendChild(style)
}

/**
 * Returns the focus to the element that had it before the overlay opened.
 * The content element of an editor gets the focus through its view, so that
 * the editor restores its selection.
 *
 * @param   {Element|null}  element  The previously focused element
 */
function restoreFocus (element: Element|null): void {
  if (!(element instanceof HTMLElement) || !element.isConnected) {
    return
  }

  // The view is looked up from the editor element, because the content
  // element of the main editor may contain the editors of table cells.
  const editorElement = element.closest('.cm-editor')
  if (editorElement instanceof HTMLElement) {
    const view = EditorView.findFromDOM(editorElement)
    if (view !== null && view.contentDOM === element) {
      view.focus()
      return
    }
  }

  element.focus({ preventScroll: true })
}

/**
 * Opens the overlay with the given image. An overlay that is already open
 * gets closed first.
 *
 * @param   {ImageLightboxOptions}  options  The image to show
 */
export function openImageLightbox (options: ImageLightboxOptions): void {
  closeImageLightbox()
  injectStyles()

  const openedAt = performance.now()
  const previousFocus = document.activeElement
  const alternativeText = options.alternativeText ?? ''

  const root = document.createElement('div')
  root.className = 'zettlr-image-lightbox'
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-modal', 'true')
  root.setAttribute('aria-label', alternativeText.trim() !== '' ? alternativeText : 'Image preview')
  root.tabIndex = -1

  const image = document.createElement('img')
  image.className = 'zettlr-image-lightbox-image'
  image.alt = alternativeText
  image.draggable = false
  // Hidden until the image has loaded and has been fitted into the window
  image.style.visibility = 'hidden'

  const closeButton = document.createElement('button')
  closeButton.type = 'button'
  closeButton.className = 'zettlr-image-lightbox-close'
  closeButton.textContent = '×'
  closeButton.title = 'Close image preview'
  closeButton.setAttribute('aria-label', 'Close image preview')

  root.appendChild(image)
  root.appendChild(closeButton)

  let view: LightboxView = { scale: 1, panX: 0, panY: 0 }
  let fitted = false
  let closed = false
  let pan: { pointerId: number, startX: number, startY: number, panX: number, panY: number }|null = null
  let backgroundPress: { x: number, y: number }|null = null

  const applyTransform = (): void => {
    image.style.transform = `translate(-50%, -50%) translate(${view.panX}px, ${view.panY}px) scale(${view.scale})`
  }

  const fitToWindow = (): void => {
    if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
      return
    }

    const area = root.getBoundingClientRect()
    view = {
      scale: computeFitScale(
        image.naturalWidth,
        image.naturalHeight,
        area.width - 2 * LIGHTBOX_MARGIN,
        area.height - 2 * LIGHTBOX_MARGIN
      ),
      panX: 0,
      panY: 0
    }
    image.style.width = `${image.naturalWidth}px`
    image.style.height = `${image.naturalHeight}px`
    applyTransform()
    image.style.visibility = 'visible'
    fitted = true
  }

  const onLoad = (): void => {
    if (!fitted) {
      fitToWindow()
    }
  }

  const onError = (): void => {
    close()
  }

  const onResize = (): void => {
    // Simply start over with the image fitted into the new window size
    if (fitted) {
      fitToWindow()
    }
  }

  const onWheel = (event: WheelEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    if (!fitted) {
      return
    }

    const area = root.getBoundingClientRect()
    const pointerX = event.clientX - (area.left + area.width / 2 + view.panX)
    const pointerY = event.clientY - (area.top + area.height / 2 + view.panY)
    view = zoomAroundPointer(view, wheelZoomFactor(event.deltaY), pointerX, pointerY)
    applyTransform()
  }

  // NOTE: The pointer handlers must not call preventDefault() on pointerdown,
  // since that would suppress the mousedown that the root needs to recognize
  // a late double click.
  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || !fitted) {
      return
    }

    pan = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, panX: view.panX, panY: view.panY }
    try {
      image.setPointerCapture(event.pointerId)
    } catch {
      // Without the capture, panning still works while the pointer stays
      // over the image
    }
    root.classList.add('panning')
  }

  const onPointerMove = (event: PointerEvent): void => {
    if (pan === null || event.pointerId !== pan.pointerId) {
      return
    }

    view = {
      scale: view.scale,
      panX: pan.panX + event.clientX - pan.startX,
      panY: pan.panY + event.clientY - pan.startY
    }
    applyTransform()
  }

  const onPointerEnd = (event: PointerEvent): void => {
    if (pan === null || event.pointerId !== pan.pointerId) {
      return
    }

    pan = null
    root.classList.remove('panning')
  }

  const onMouseDown = (event: MouseEvent): void => {
    // Neither the editor nor the browser (focus, text selection, autoscroll)
    // gets to handle presses on the overlay.
    event.stopPropagation()
    event.preventDefault()
    if (event.button !== 0) {
      backgroundPress = null
      return
    }

    const onLateDoubleClick = options.onLateDoubleClick
    if (onLateDoubleClick !== undefined && isLateDoubleClick(openedAt, performance.now(), event.detail)) {
      close()
      onLateDoubleClick()
      return
    }

    backgroundPress = event.target === root ? { x: event.clientX, y: event.clientY } : null
  }

  const onMouseUp = (event: MouseEvent): void => {
    event.stopPropagation()
    const press = backgroundPress
    backgroundPress = null
    if (event.button !== 0 || press === null || event.target !== root) {
      return
    }

    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < BACKGROUND_CLICK_TOLERANCE) {
      close()
    }
  }

  const onClick = (event: MouseEvent): void => {
    event.stopPropagation()
  }

  const onContextMenu = (event: MouseEvent): void => {
    event.stopPropagation()
    event.preventDefault()
  }

  const onCloseButtonClick = (): void => {
    close()
  }

  // While the overlay is open, no key reaches the editor or any other part
  // of the window; Escape closes the overlay.
  const onKeyDown = (event: KeyboardEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') {
      close()
    }
  }

  const onOtherKeyEvent = (event: KeyboardEvent): void => {
    event.preventDefault()
    event.stopPropagation()
  }

  const close = (): void => {
    if (closed) {
      return
    }

    closed = true
    window.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('keyup', onOtherKeyEvent, true)
    window.removeEventListener('keypress', onOtherKeyEvent, true)
    window.removeEventListener('resize', onResize)
    root.removeEventListener('wheel', onWheel)
    root.removeEventListener('mousedown', onMouseDown)
    root.removeEventListener('mouseup', onMouseUp)
    root.removeEventListener('click', onClick)
    root.removeEventListener('contextmenu', onContextMenu)
    image.removeEventListener('load', onLoad)
    image.removeEventListener('error', onError)
    image.removeEventListener('pointerdown', onPointerDown)
    image.removeEventListener('pointermove', onPointerMove)
    image.removeEventListener('pointerup', onPointerEnd)
    image.removeEventListener('pointercancel', onPointerEnd)
    image.removeEventListener('lostpointercapture', onPointerEnd)
    closeButton.removeEventListener('click', onCloseButtonClick)
    root.remove()

    if (current === handle) {
      current = null
    }

    restoreFocus(previousFocus)
  }

  const handle: OpenLightbox = { close }
  current = handle

  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('keyup', onOtherKeyEvent, true)
  window.addEventListener('keypress', onOtherKeyEvent, true)
  window.addEventListener('resize', onResize)
  root.addEventListener('wheel', onWheel, { passive: false })
  root.addEventListener('mousedown', onMouseDown)
  root.addEventListener('mouseup', onMouseUp)
  root.addEventListener('click', onClick)
  root.addEventListener('contextmenu', onContextMenu)
  image.addEventListener('load', onLoad)
  image.addEventListener('error', onError)
  image.addEventListener('pointerdown', onPointerDown)
  image.addEventListener('pointermove', onPointerMove)
  image.addEventListener('pointerup', onPointerEnd)
  image.addEventListener('pointercancel', onPointerEnd)
  image.addEventListener('lostpointercapture', onPointerEnd)
  closeButton.addEventListener('click', onCloseButtonClick)

  // The root has to be in the document before the image loads, so that its
  // size is known when the image gets fitted into it.
  document.body.appendChild(root)
  // Moving the focus into the (non-editable) overlay also keeps an input
  // method from writing into the editor while the overlay is open.
  root.focus({ preventScroll: true })

  image.src = options.source
  if (image.complete && image.naturalWidth > 0) {
    // A cached image may be available right away
    fitToWindow()
  }
}

/**
 * Closes the overlay, if one is open.
 */
export function closeImageLightbox (): void {
  current?.close()
}

/**
 * Checks whether the overlay is open.
 *
 * @return  {boolean}  True if the overlay is open
 */
export function isImageLightboxOpen (): boolean {
  return current !== null
}
