/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ImageRenderer
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This renderer can display and manage images. A single click
 *                  selects a rendered image and shows its resize handles,
 *                  dragging a handle changes the width of the image, and a
 *                  double click reveals the image source for editing.
 *
 * END HEADER
 */

import { type SyntaxNode, type SyntaxNodeRef } from '@lezer/common'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { Prec, type EditorState, type Range } from '@codemirror/state'
import { configField } from '../util/configuration'
import { shouldRevealSource, sourceEditingAllowed, sourceRevealChanged } from '../util/reveal-selection'
import { clearPastedImagePreviewEffect, hasPastedImagePreview, pastedImagePreviewField, pastedImagePreviewLifecycle } from '../util/pasted-image-preview'
import { findImageOnlyLines, isRenderableImageNode } from '../util/image-only-lines'
import {
  buildImageCaptionChanges,
  buildImageWidthChanges,
  computeResizedWidthPercent,
  findHiddenImageAttributeRanges,
  findImageAt,
  imageSourceRange,
  selectImageEffect,
  selectedImageField
} from '../util/image-selection'
import tryMakeValidUri from '@common/util/try-make-valid-uri'
import { linkImageMenu } from '../context-menu/link-image-menu'
import { trans } from '@common/i18n-renderer'
import { pathDirname } from '@common/util/renderer-path-polyfill'
import { syntaxTree } from '@codemirror/language'
import { parsePandocAttributes, type ParsedPandocAttributes } from 'source/common/pandoc-util/parse-pandoc-attributes'

const ipcRenderer = window.ipc

// This variable holds a base64 encoded placeholder image.
const img404 = 'data:image/png;base64,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'

function isDataUrl (url: string): boolean {
  return /^data:[a-zA-Z0-9/;=]+(?:;base64){0,1},.+/.test(url)
}

/**
 * This map is a cache that holds the actual (natural) sizes of the images we
 * have loaded across the app, identified by their absolute paths. These numbers
 * will be updated as images load, and will be used by the image widgets to
 * report a (likely) height which will help CodeMirror render scroll bars etc.
 * much more accurately. NOTE: The image height cache caches the EXACT height of
 * the rendered widget at the time of caching, NOT the natural image's height!
 * Also, this cache will be kept updated whenever an image is reloaded.
 */
const IMAGE_HEIGHT_CACHE = new Map<string, number>()

// Key cleanup by DOM rather than widget instance: updateDOM can reuse a figure
// for a new widget when its selection or attributes change.
const IMAGE_RESIZE_OBSERVERS = new WeakMap<HTMLElement, ResizeObserver>()

/** Fits automatic previews to the viewport and their original device pixels. */
function applyAutomaticSizeLimits (img: HTMLImageElement, visibleHeight: number): boolean {
  // CSS pixels include Windows display scaling and the current browser zoom.
  const pixelRatio = Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0
    ? window.devicePixelRatio : 1
  const availableHeight = visibleHeight > 0 ? Math.floor(visibleHeight * 0.8) : Infinity
  const originalHeight = img.naturalHeight > 0 ? Math.floor(img.naturalHeight * 1000 / pixelRatio) / 1000 : Infinity
  const heightLimit = Math.min(availableHeight, originalHeight)
  const maxHeight = Number.isFinite(heightLimit) ? `${heightLimit}px` : ''
  const maxWidth = img.naturalWidth > 0 ? `min(100%, ${Math.floor(img.naturalWidth * 1000 / pixelRatio) / 1000}px)` : '100%'
  if (img.style.maxHeight === maxHeight && img.style.maxWidth === maxWidth) {
    return false
  }
  img.style.maxHeight = maxHeight
  img.style.maxWidth = maxWidth
  return true
}

/**
 * Resolves the actual image URL to load, provided the current file's location.
 *
 * @param   {string}  filePath  The file path
 * @param   {string}  imageUrl  The image URL
 *
 * @return  {string|null}       The full, absolute path to the image (data URLs
 *                               unchanged), or null if the image URL cannot be
 *                               turned into a valid URI (e.g. `https://`). A
 *                               null result means the image is not rendered.
 */
export function resolveImageUrl (filePath: string, imageUrl: string): string | null {
  const basePath = pathDirname(filePath)
  return isDataUrl(imageUrl) ? imageUrl : tryMakeValidUri(imageUrl, basePath)
}

/**
 * This function checks whether the provided size works with CSS. It returns
 * undefined, if it doesn't recognize the size (e.g., `1\textwidth`), and the
 * size but in lowercase if it does.
 *
 * @param   {string}            size  The arbitrary size argument
 *
 * @return  {string|undefined}        The normalized size if recognized, or undefined.
 */
function normalizeSize (size?: string): string | undefined {
  if (size === undefined || !/[\d\.]+(?:cm|mm|in|px|pt|pc|em|ex|ch|rem|vw|vh|vmin|vmax|%)/i.test(size)) {
    return undefined
  }

  return size.toLowerCase()
}

/**
 * Applies the styles for an explicit width: the figure takes the given share
 * of the line (enlarging small images as well), and the image fills the
 * figure. The global limits for image previews do not apply.
 *
 * @param   {HTMLElement}       figure  The figure element of the widget
 * @param   {HTMLImageElement}  img     The image element of the widget
 * @param   {string}            width   The CSS width, e.g. `50%`
 * @param   {string|undefined}  height  The CSS height, or undefined to keep
 *                                      the aspect ratio
 */
function applyExplicitWidthStyles (figure: HTMLElement, img: HTMLImageElement, width: string, height: string|undefined): void {
  figure.style.width = width
  figure.style.maxWidth = '100%'
  figure.style.maxHeight = ''
  img.style.width = '100%'
  img.style.maxWidth = '100%'
  img.style.maxHeight = ''
  img.style.height = height ?? 'auto'
}

/**
 * Applies the size styles of an image according to its Pandoc attributes.
 * With a width, the image takes that share of the text column. Without one,
 * the image is shown at its natural size, and an image wider than the text
 * column is scaled down to fit it. Without either size attribute, the image
 * also fits within 80% of the editor's visible height, keeping its aspect
 * ratio and never enlarging small images. The maximum preview sizes from the
 * preferences (`display.imageWidth` and `display.imageHeight`) do not apply to
 * the editor preview. The recognized width is remembered on the figure
 * (`data-image-width`) for the size label.
 *
 * @param   {HTMLElement}       figure      The figure element of the widget
 * @param   {HTMLImageElement}  img         The image element of the widget
 * @param   {Record}            properties  The key-value attributes, if any
 * @param   {EditorView}        view        The editor containing the preview
 */
function applySizeStyles (
  figure: HTMLElement,
  img: HTMLImageElement,
  properties: Record<string, string>|undefined,
  view: EditorView
): void {
  const width = normalizeSize(properties?.width ?? properties?.w)
  const height = normalizeSize(properties?.height ?? properties?.h)
  figure.dataset.imageWidth = width ?? ''

  if (width !== undefined) {
    applyExplicitWidthStyles(figure, img, width, height)
    return
  }

  // Attribute presence matters even when normalizeSize cannot interpret its
  // value: explicit attributes keep their existing preview rules.
  const automaticSize = properties?.width === undefined && properties?.w === undefined &&
    properties?.height === undefined && properties?.h === undefined
  const maxHeight = height ?? ''

  figure.style.width = ''
  figure.style.maxWidth = '100%'
  figure.style.maxHeight = maxHeight
  img.style.width = automaticSize ? 'auto' : ''
  img.style.height = automaticSize ? 'auto' : ''
  img.style.maxWidth = '100%'
  img.style.maxHeight = maxHeight
  if (automaticSize) {
    // Constrain only the replaced element; limiting its figure separately
    // could clip it instead of letting the image preserve its aspect ratio.
    figure.style.maxHeight = ''
    applyAutomaticSizeLimits(img, view.scrollDOM.clientHeight)
  }
}

/**
 * Updates the size label of an image: the natural size once the image has
 * loaded, followed by the width if there is one, separated by a middle dot
 * (e.g. 1200 times 800 pixels, then 50%).
 *
 * @param   {HTMLImageElement}  img    The image element of the widget
 * @param   {HTMLElement}       size   The size label element
 * @param   {string}            width  The width to show, or an empty string
 */
function updateSizeLabel (img: HTMLImageElement, size: HTMLElement, width: string): void {
  const parts: string[] = []
  if (img.naturalWidth > 0 && img.naturalHeight > 0) {
    parts.push(`${img.naturalWidth}\u00D7${img.naturalHeight}`)
  }
  if (width !== '') {
    parts.push(width)
  }
  size.textContent = parts.join(' \u00B7 ')
}

/**
 * Returns the start position of the image a widget displays. Widgets may be
 * reused for other positions, so this is determined from the DOM whenever an
 * event happens.
 *
 * @param   {EditorView}        view    The editor view
 * @param   {HTMLElement}       figure  The figure element of the widget
 *
 * @return  {number|undefined}          The start of the image, or undefined if
 *                                      the widget is no longer in the editor
 */
function imagePositionOf (view: EditorView, figure: HTMLElement): number|undefined {
  try {
    return view.posAtDOM(figure)
  } catch (err) {
    return undefined
  }
}

/**
 * Selects the source of an image including its attributes, which reveals the
 * source in place of the rendered image, and clears the image selection.
 *
 * @param   {EditorView}  view       The editor view
 * @param   {number}      imageFrom  The start of the image
 *
 * @return  {boolean}                Whether there was an image to select
 */
function selectImageSource (view: EditorView, imageFrom: number): boolean {
  const range = imageSourceRange(view.state, imageFrom)
  if (range === undefined || !sourceEditingAllowed(view.state, 'images')) {
    return false
  }

  const configuration = view.state.field(configField, false)
  const selection = configuration !== undefined && !configuration.editCodeWhenClicked
    ? { anchor: range.from + 1 }
    : { anchor: range.from, head: range.to }
  view.dispatch({ selection, effects: selectImageEffect.of(null) })
  view.focus()
  return true
}

/**
 * Parses a CSS pixel value, returning 0 for anything unparseable
 */
function pixelsOf (value: string): number {
  const parsed = parseFloat(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

/**
 * Returns the width of the content box of an element, i.e. the width that
 * percentage widths of its children refer to.
 *
 * @param   {Element|null}  element  The element
 *
 * @return  {number}                 The width in pixels, or 0
 */
function contentWidthOf (element: Element|null): number {
  if (!(element instanceof HTMLElement)) {
    return 0
  }

  const style = window.getComputedStyle(element)
  return element.clientWidth - pixelsOf(style.paddingLeft) - pixelsOf(style.paddingRight)
}

/**
 * Creates a resize handle for one side of an image. Dragging it shows the new
 * width live; releasing it writes the width into the attributes of the image
 * as a single undoable step. Escape or a cancelled pointer restores the
 * previous size without changing the document.
 *
 * @param   {EditorView}        view       The editor view
 * @param   {HTMLElement}       figure     The figure element of the widget
 * @param   {HTMLImageElement}  img        The image element of the widget
 * @param   {HTMLElement}       size       The size label element
 * @param   {'left'|'right'}    side       Which side the handle sits on
 * @param   {Function}          onResized  Called after a new width has been
 *                                         written into the document
 *
 * @return  {HTMLElement}                  The handle element
 */
function createResizeHandle (
  view: EditorView,
  figure: HTMLElement,
  img: HTMLImageElement,
  size: HTMLElement,
  side: 'left'|'right',
  onResized: () => void
): HTMLElement {
  const handle = document.createElement('span')
  handle.classList.add('image-resize-handle', side)
  handle.setAttribute('title', trans('Drag to change the width'))

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) {
      return
    }

    // Keep the editor from handling the press, and route all further pointer
    // events to the handle, even if the pointer leaves it.
    event.preventDefault()
    event.stopPropagation()
    handle.setPointerCapture(event.pointerId)

    const line = figure.closest('.cm-line')
    const startX = event.clientX
    const startWidth = figure.getBoundingClientRect().width
    // Percentage widths refer to the content box of the line
    const containerWidth = contentWidthOf(line ?? figure.parentElement)
    // In a centered line, the image grows to both sides at once
    const centered = line !== null && line.classList.contains('cm-image-only-line')
    const figureStyle = figure.style.cssText
    const imageStyle = img.style.cssText
    let widthPercent: number|undefined

    const finish = (): void => {
      handle.removeEventListener('pointermove', onPointerMove)
      handle.removeEventListener('pointerup', onPointerUp)
      handle.removeEventListener('pointercancel', onCancel)
      handle.removeEventListener('lostpointercapture', onCancel)
      window.removeEventListener('keydown', onKeyDown, true)
      if (handle.hasPointerCapture(event.pointerId)) {
        handle.releasePointerCapture(event.pointerId)
      }
    }

    const restore = (): void => {
      figure.style.cssText = figureStyle
      img.style.cssText = imageStyle
      updateSizeLabel(img, size, figure.dataset.imageWidth ?? '')
    }

    const onPointerMove = (moveEvent: PointerEvent): void => {
      widthPercent = computeResizedWidthPercent({
        startWidth,
        deltaX: moveEvent.clientX - startX,
        side,
        centered,
        containerWidth
      })
      applyExplicitWidthStyles(figure, img, `${widthPercent}%`, undefined)
      updateSizeLabel(img, size, `${widthPercent}%`)
    }

    const onPointerUp = (): void => {
      finish()
      const imageFrom = imagePositionOf(view, figure)
      if (widthPercent === undefined || imageFrom === undefined) {
        restore()
        return
      }

      const changes = buildImageWidthChanges(view.state, imageFrom, widthPercent)
      if (changes.length === 0) {
        restore()
        return
      }

      // The attributes follow the image, so its start stays the same
      view.dispatch({ changes, effects: selectImageEffect.of(imageFrom), userEvent: 'input.resize-image' })
      onResized()
    }

    const onCancel = (): void => {
      finish()
      restore()
    }

    const onKeyDown = (keyEvent: KeyboardEvent): void => {
      if (keyEvent.key !== 'Escape') {
        return
      }
      // Cancel the drag only; the image stays selected
      keyEvent.preventDefault()
      keyEvent.stopPropagation()
      onCancel()
    }

    handle.addEventListener('pointermove', onPointerMove)
    handle.addEventListener('pointerup', onPointerUp)
    handle.addEventListener('pointercancel', onCancel)
    handle.addEventListener('lostpointercapture', onCancel)
    window.addEventListener('keydown', onKeyDown, true)
  })

  return handle
}

class ImageWidget extends WidgetType {
  constructor (
    readonly node: SyntaxNode,
    readonly imageTitle: string,
    readonly imageUrl: string,
    readonly resolvedImageUrl: string,
    readonly altText: string,
    readonly data: ParsedPandocAttributes,
    readonly selected: boolean
  ) {
    super()
  }

  eq (other: ImageWidget) {
    const properties = this.data.properties
    const otherProperties = other.data.properties
    return this.imageTitle === other.imageTitle &&
      this.imageUrl === other.imageUrl &&
      this.altText === other.altText &&
      this.selected === other.selected &&
      (properties?.width ?? properties?.w) === (otherProperties?.width ?? otherProperties?.w) &&
      (properties?.height ?? properties?.h) === (otherProperties?.height ?? otherProperties?.h)
  }

  get estimatedHeight (): number {
    return IMAGE_HEIGHT_CACHE.get(this.resolvedImageUrl) ?? -1
  }

  toDOM (view: EditorView): HTMLElement {
    //////////////////////////////////////////
    // FIGURE
    //////////////////////////////////////////
    const figure = document.createElement('figure')
    figure.classList.add('image-preview')
    figure.classList.toggle('selected', this.selected)

    // Display a context menu with the current image node
    figure.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const imageFrom = parseInt(img.dataset.from ?? '-1', 10)
      const node = syntaxTree(view.state).resolve(imageFrom, 1)
      // The Pandoc attribute section addresses the image: a cursor just
      // inside it (after the exclamation mark)
      const insideImage = Math.min(imageFrom + 1, view.state.doc.length)
      linkImageMenu(view, node, { x: event.clientX, y: event.clientY }, { from: insideImage, to: insideImage })
    })

    //////////////////////////////////////////
    // IMG
    //////////////////////////////////////////
    const img = document.createElement('img')
    img.alt = this.altText
    img.title = this.imageTitle
    // Dragging the image itself would start the browser's native image drag
    img.draggable = false

    // Retrieve and apply the size constraints
    applySizeStyles(figure, img, this.data.properties, view)

    // Store some crucial information on the node itself
    img.dataset.from = String(this.node.from)
    img.dataset.to = String(this.node.to)
    img.dataset.originalUrl = this.imageUrl
    img.dataset.title = this.imageTitle

    // A single click selects the image (showing its resize handles) without
    // revealing the source. The editor selection stays as it is, so the image
    // remains rendered.
    img.addEventListener('mousedown', (event) => {
      if (event.button !== 0) {
        return
      }

      // Prevent the browser from placing the cursor next to the image
      event.preventDefault()
      view.focus()
      const imageFrom = imagePositionOf(view, figure)
      if (imageFrom === undefined || view.state.field(selectedImageField, false) === imageFrom) {
        return
      }

      if (findImageAt(view.state, imageFrom) !== undefined) {
        view.dispatch({ effects: selectImageEffect.of(imageFrom) })
      }
    })

    // A double click reveals the source for editing
    img.addEventListener('dblclick', (event) => {
      event.preventDefault()
      const imageFrom = imagePositionOf(view, figure)
      if (imageFrom !== undefined) {
        selectImageSource(view, imageFrom)
      }
    })

    // Display a replacement image in case the correct one is not found
    img.onerror = () => {
      img.src = img404
      caption.textContent = trans('Image not found: %s', img.dataset.originalUrl)
      caption.contentEditable = 'false'
    }

    // Shows or hides the surrounding elements depending on the rendered size,
    // and caches the rendered height
    const refreshOverlays = (): void => {
      const { width, height } = figure.getBoundingClientRect()

      // Determine if the image is wide enough to display the surrounding elements
      if (width >= 256 && height >= 128) {
        size.style.display = ''
        caption.style.display = ''
        openExternally.style.display = ''
      } else {
        size.style.display = 'none'
        caption.style.display = 'none'
        openExternally.style.display = 'none'
      }

      // Lastly, cache the image's resolved height. This can quickly become
      // inaccurate, but can be solved by the user with a simple Ctrl+A, which
      // will force-reload everything.
      IMAGE_HEIGHT_CACHE.set(this.resolvedImageUrl, height)
    }

    // Update the image title on load to retrieve the real image size.
    img.onload = () => {
      if (img.style.width === 'auto' && img.style.height === 'auto') {
        applyAutomaticSizeLimits(img, view.scrollDOM.clientHeight)
      }
      img.title = `${img.dataset.title!.replace(/\\"/g, '"')} (${img.naturalWidth}x${img.naturalHeight}px)`
      updateSizeLabel(img, size, figure.dataset.imageWidth ?? '')

      // Determine if the image can be opened externally
      if (isDataUrl(img.dataset.originalUrl!) && figure.contains(openExternally)) {
        figure.removeChild(openExternally)
      } else if (!figure.contains(openExternally)) {
        figure.appendChild(openExternally)
      }

      refreshOverlays()
    }

    //////////////////////////////////////////
    // CAPTION
    //////////////////////////////////////////
    const caption = document.createElement('figcaption')
    caption.textContent = this.imageTitle.replace(/\\"/g, '"') // Un-escape title
    caption.contentEditable = 'true'

    // Applies an edited caption on Enter and when the caption loses focus. The
    // image is located in the current document at the time of the event (the
    // positions stored on the element can be outdated, since the widget may be
    // reused without an update), and an unchanged caption changes nothing.
    // Only the image source itself is rewritten; the attributes after it stay.
    // A second event after the change (e.g. focusout after Enter) finds the
    // new caption in the document and does nothing either.
    const updateCaptionFunction = function (event: KeyboardEvent | FocusEvent): void {
      if (event instanceof KeyboardEvent && event.key !== 'Enter') {
        // If this is a KeyboardEvent, only perform the action on Enter
        return
      }

      // Enter must not insert a line break into the caption
      event.preventDefault()
      event.stopPropagation()

      const imageFrom = imagePositionOf(view, figure)
      if (imageFrom === undefined) {
        return
      }

      const changes = buildImageCaptionChanges(view.state, imageFrom, caption.textContent ?? '')
      if (changes.length === 0) {
        return
      }

      view.dispatch({ changes })
    }

    // Should work on these events
    caption.addEventListener('keydown', updateCaptionFunction)
    caption.addEventListener('focusout', updateCaptionFunction)

    //////////////////////////////////////////
    // OPEN EXTERNALLY
    //////////////////////////////////////////
    const openExternally = document.createElement('span')
    openExternally.classList.add('open-externally-button')
    openExternally.setAttribute('title', trans('Open image externally'))
    openExternally.onclick = function (event) {
      event.stopPropagation()
      const url = resolveImageUrl(
        view.state.field(configField).metadata.path,
        img.dataset.originalUrl ?? ''
      )
      if (url === null) {
        return // An image URL that cannot be resolved opens nothing
      }

      // Open in Zettlr if wanted. TODO: Maybe move this into the editor config?
      if (window.config.get('files.images.openWith') === 'zettlr') {
        const unencoded = decodeURIComponent(url).substring(12)
        // On Windows, it likes to add a third slash at the beginning (because
        // unlike UNIX, absolute paths start with a letter, not a slash)
        const leadingSlash = unencoded.startsWith('/') && process.platform === 'win32'
        const realPath = leadingSlash ? unencoded.substring(1) : unencoded
        ipcRenderer
          .invoke('documents-provider', { command: 'open-file', payload: { path: realPath } })
          .catch(e => console.error(e))
      } else {
        // NOTE: We can only do this because the main process prevents any
        // navigation, and will open the "URL" using the shell.
        window.location.assign(url)
      }
    }

    const openIcon = document.createElement('cds-icon')
    openIcon.setAttribute('shape', 'pop-out')
    openExternally.appendChild(openIcon)

    //////////////////////////////////////////
    // SIZE
    //////////////////////////////////////////
    const size = document.createElement('span')
    size.classList.add('image-size-info')

    //////////////////////////////////////////
    // RESIZE HANDLES
    //////////////////////////////////////////
    // Only visible while the image is selected
    const leftHandle = createResizeHandle(view, figure, img, size, 'left', refreshOverlays)
    const rightHandle = createResizeHandle(view, figure, img, size, 'right', refreshOverlays)

    // Finally, construct the DOM tree, start loading the image, and return
    figure.appendChild(img)
    figure.appendChild(caption)
    figure.appendChild(size)
    figure.appendChild(leftHandle)
    figure.appendChild(rightHandle)

    const resizeObserver = new ResizeObserver(() => {
      // Explicit sizing (including a live handle drag) replaces these auto
      // styles. Inspect the reused DOM, not this widget's original attributes.
      if (img.style.width === 'auto' && img.style.height === 'auto' &&
        applyAutomaticSizeLimits(img, view.scrollDOM.clientHeight)) {
        refreshOverlays()
        view.requestMeasure()
      }
    })
    // Observe only the viewport, never the image whose size we change. Width
    // constraints respond through CSS; unchanged size limits do no work.
    resizeObserver.observe(view.scrollDOM)
    IMAGE_RESIZE_OBSERVERS.set(figure, resizeObserver)

    const resolvedSource = resolveImageUrl(view.state.field(configField).metadata.path, this.imageUrl)
    if (resolvedSource !== null) {
      img.src = resolvedSource
    }

    return figure
  }

  updateDOM (dom: HTMLElement, view: EditorView): boolean {
    // We assume a given structure, and if there's something wrong, we just
    // capture the error and return false, indicating that the entire dom has to
    // be rebuilt.
    try {
      // First, update the image itself
      const img = dom.querySelector('img')
      const size = dom.querySelector<HTMLElement>('.image-size-info')
      if (img === null || size === null) {
        return false
      }

      img.dataset.from = String(this.node.from)
      img.dataset.to = String(this.node.to)
      img.dataset.originalUrl = this.imageUrl

      if (img.dataset.title !== this.imageTitle) {
        img.dataset.title = this.imageTitle
        const caption = dom.querySelector('figcaption')! as HTMLElement
        caption.textContent = this.imageTitle.replace(/\\"/g, '"') // Un-escape title
      }

      // Then, the selection state and the size
      dom.classList.toggle('selected', this.selected)
      applySizeStyles(dom, img, this.data.properties, view)
      updateSizeLabel(img, size, dom.dataset.imageWidth ?? '')

      const resolvedURL = resolveImageUrl(view.state.field(configField).metadata.path, this.imageUrl)

      if (resolvedURL !== null && resolvedURL !== img.src) {
        // The load and onerror handlers will handle this accordingly (and also
        // update the size and title)
        img.src = resolvedURL
      }

      return true
    } catch (err) {
      return false
    }
  }

  ignoreEvent (event: Event): boolean { return true }

  destroy (dom: HTMLElement): void {
    IMAGE_RESIZE_OBSERVERS.get(dom)?.disconnect()
    IMAGE_RESIZE_OBSERVERS.delete(dom)
    const img = dom.querySelector('img')
    if (img !== null) {
      img.onload = null
      img.onerror = null
    }
  }
}

function shouldHandleNode (node: SyntaxNodeRef): boolean {
  return node.type.name === 'Image'
}

function createWidget (state: EditorState, node: SyntaxNodeRef): ImageWidget | undefined {
  if (!isRenderableImageNode(state, node)) {
    return undefined
  }

  // Get the actual link contents, extract title and URL and create a
  // replacement widget
  const marks = node.node.getChildren('LinkMark')
  const titleNode = node.node.getChild('LinkTitle')
  // Since alt-text can potentially contain multiple URLs, the last one is the
  // image source; isRenderableImageNode() guarantees it exists and sits
  // outside the alt-text.
  const urlNode = node.node.getChildren('URL').pop()!

  const alt = state.sliceDoc(marks[0].to, marks[1].from)
  const title = titleNode === null ? alt : state.sliceDoc(titleNode.from, titleNode.to)
  const url = state.sliceDoc(urlNode.from, urlNode.to)

  let data: ParsedPandocAttributes = {}
  const nextSibling = node.node.nextSibling
  if (nextSibling !== null && nextSibling.name === 'PandocAttribute') {
    try {
      const text = state.sliceDoc(nextSibling.from, nextSibling.to)
      data = parsePandocAttributes(text)
    } catch (err) {
      // Silently ignore error
    }
  }

  const resolvedImageSrc = resolveImageUrl(state.field(configField).metadata.path, url)
  if (resolvedImageSrc === null) {
    return undefined // Leave an image whose URL cannot be resolved as text
  }
  const selected = state.field(selectedImageField, false) === node.from
  return new ImageWidget(node.node, title, url, resolvedImageSrc, alt, data, selected)
}

/**
 * Rebuild the image widgets whenever the selected image changes
 *
 * @param   {ViewUpdate}  update  The view update
 *
 * @return  {boolean}             True if the selected image changed
 */
function selectedImageChanged (update: ViewUpdate): boolean {
  return update.startState.field(selectedImageField, false) !== update.state.field(selectedImageField, false) ||
    update.startState.field(pastedImagePreviewField, false) !== update.state.field(pastedImagePreviewField, false)
}

/** Keep the one-paste exception local to images; all other nodes use the shared policy. */
function decorateImages (view: EditorView): DecorationSet {
  const widgets: Array<Range<Decoration>> = []
  const includeAdjacent = view.state.field(configField, false)?.previewModeShowSyntaxWhenCursorIsAdjacent ?? true
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({ from, to, enter (node) {
      if (!shouldHandleNode(node)) return
      const attribute = node.node.nextSibling
      const sourceTo = attribute?.name === 'PandocAttribute' && attribute.from === node.to ? attribute.to : node.to
      if (!hasPastedImagePreview(view.state, node.from, sourceTo) &&
        shouldRevealSource(view.state, 'images', node.from, sourceTo, includeAdjacent)) return
      const widget = createWidget(view.state, node)
      if (widget !== undefined) {
        widgets.push(Decoration.replace({ widget, inclusive: false }).range(node.from, node.to))
      }
    } })
  }
  return Decoration.set(widgets, true)
}

const imageWidgets = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor (view: EditorView) { this.decorations = decorateImages(view) }
  update (update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged || update.selectionSet || sourceRevealChanged(update) || selectedImageChanged(update)) {
      this.decorations = decorateImages(update.view)
    }
  }
}, { decorations: plugin => plugin.decorations })

const imageOnlyLineDecoration = Decoration.line({ class: 'cm-image-only-line' })

/**
 * Marks the visible lines that hold nothing but rendered images.
 *
 * @param   {EditorView}     view  The editor view
 *
 * @return  {DecorationSet}        The line decorations
 */
function decorateImageOnlyLines (view: EditorView): DecorationSet {
  const includeAdjacent = view.state.field(configField, false)?.previewModeShowSyntaxWhenCursorIsAdjacent ?? true
  const lineStarts = findImageOnlyLines(view.state, view.visibleRanges, includeAdjacent)
  // The shared utility follows normal source policy. Include freshly pasted
  // image-only lines while their local preview exception is active as well.
  for (const range of view.state.field(pastedImagePreviewField, false) ?? []) {
    for (let position = range.from; position <= range.to;) {
      const line = view.state.doc.lineAt(position)
      if (line.text.trim() !== '') {
        let covered = line.from
        let imageCount = 0
        syntaxTree(view.state).iterate({ from: line.from, to: line.to, enter (node) {
          if (!shouldHandleNode(node) || !isRenderableImageNode(view.state, node) ||
            !hasPastedImagePreview(view.state, node.from, node.to)) return
          if (view.state.sliceDoc(covered, node.from).trim() === '') {
            covered = node.to
            imageCount++
          }
        } })
        if (imageCount > 0 && view.state.sliceDoc(covered, line.to).trim() === '' && !lineStarts.includes(line.from)) {
          lineStarts.push(line.from)
        }
      }
      if (line.to >= range.to) break
      position = line.to + 1
    }
  }
  lineStarts.sort((first, second) => first - second)
  return Decoration.set(lineStarts.map(lineStart => imageOnlyLineDecoration.range(lineStart)))
}

const imageOnlyLines = ViewPlugin.fromClass(class {
  decorations: DecorationSet

  constructor (view: EditorView) {
    this.decorations = decorateImageOnlyLines(view)
  }

  update (update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged || update.selectionSet || sourceRevealChanged(update) || selectedImageChanged(update)) {
      this.decorations = decorateImageOnlyLines(update.view)
    }
  }
}, {
  decorations: plugin => plugin.decorations
})

const hiddenAttributeDecoration = Decoration.replace({})

/**
 * Hides the Pandoc attributes (`{width=50%}`) directly following the visible
 * rendered images, so that they do not show up next to the image.
 *
 * @param   {EditorView}     view  The editor view
 *
 * @return  {DecorationSet}        The replace decorations
 */
function hideImageAttributes (view: EditorView): DecorationSet {
  const includeAdjacent = view.state.field(configField, false)?.previewModeShowSyntaxWhenCursorIsAdjacent ?? true
  const ranges = findHiddenImageAttributeRanges(view.state, view.visibleRanges, includeAdjacent)
  return Decoration.set(ranges.map(range => hiddenAttributeDecoration.range(range.from, range.to)))
}

const hiddenImageAttributes = ViewPlugin.fromClass(class {
  decorations: DecorationSet

  constructor (view: EditorView) {
    this.decorations = hideImageAttributes(view)
  }

  update (update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged || update.selectionSet || sourceRevealChanged(update)) {
      this.decorations = hideImageAttributes(update.view)
    }
  }
}, {
  decorations: plugin => plugin.decorations
})

/**
 * Clears the image selection
 */
function clearImageSelection (view: EditorView): void {
  view.dispatch({ effects: selectImageEffect.of(null) })
}

/**
 * Editor-level handling of the image selection. Events inside the image
 * widgets never reach these handlers, since the widgets ignore all events.
 */
const imageSelectionHandlers = Prec.highest(EditorView.domEventHandlers({
  mousedown (event, view) {
    if ((view.state.field(pastedImagePreviewField, false)?.length ?? 0) > 0) {
      view.dispatch({ effects: clearPastedImagePreviewEffect.of(null) })
    }
    // A click anywhere else in the editor ends the selection; the click itself
    // proceeds as usual
    const selected = view.state.field(selectedImageField, false)
    if (selected !== null && selected !== undefined) {
      clearImageSelection(view)
    }
    return false
  },
  keydown (event, view) {
    const selected = view.state.field(selectedImageField, false)
    if (selected === null || selected === undefined) {
      return false
    }

    if (findImageAt(view.state, selected) === undefined) {
      clearImageSelection(view)
      return false
    }

    switch (event.key) {
      case 'Escape':
        clearImageSelection(view)
        return true
      case 'Delete':
      case 'Backspace': {
        const range = imageSourceRange(view.state, selected)
        if (range === undefined) {
          clearImageSelection(view)
          return false
        }
        view.dispatch({
          changes: { from: range.from, to: range.to },
          selection: { anchor: range.from },
          effects: selectImageEffect.of(null),
          userEvent: 'delete'
        })
        return true
      }
      case 'Enter':
        // Same as a double click: reveal the source for editing
        return selectImageSource(view, selected)
      case 'Shift':
      case 'Control':
      case 'Alt':
      case 'Meta':
        // Modifiers alone keep the selection
        return false
      default:
        // Any other key ends the selection and is handled as usual
        clearImageSelection(view)
        return false
    }
  }
}))

export const renderImages = [
  EditorView.baseTheme({
    // Must be !important: the justification rule in MainEditor.vue is more specific
    '.cm-line.cm-image-only-line': { textAlign: 'center !important' },
    'figure.image-preview': {
      position: 'relative',
      display: 'inline-block',
      textAlign: 'center',
      cursor: 'default',
      textIndent: '0', // Reset the text indent
      // Ensure that very un-proportional images do not overflow (see #5465)
      overflow: 'hidden',
      '& img': {
        display: 'block',
        position: 'relative',
        // The figure will squeeze it if necessary to the user-specified width
        maxWidth: '100%'
      },
      '& :not(img)': { opacity: '0' },
      '&:hover :not(img), &:focus-within :not(img), &.selected :not(img)': { opacity: '1' },
      '&.selected': {
        outline: '2px solid var(--system-accent-color, #1e88e5)'
      },
      '& .image-size-info, & figcaption, & .open-externally-button': {
        position: 'absolute',
        transition: '0.2s opacity ease',
        backgroundColor: 'rgba(0, 0, 0, .7)',
        color: 'white',
        // The size follows the editor's base font size (a custom property set
        // on the editor wrapper) instead of `em`: an image can sit on a
        // heading line, whose own font-size is a multiple such as 2em, and an
        // `em` value would be multiplied by that again. The fallback equals
        // the previous fixed size of 12px.
        fontSize: 'calc(var(--editor-base-font-size, 18px) * 0.667)',
        borderRadius: '6px',
        padding: '10px',
        // If we have images in a list, they will inherit the textIndent applied
        // by CodeMirror, so we have to set it explicitly
        textIndent: '0'
      },
      '& .image-size-info': {
        top: '10px',
        left: '10px'
      },
      '& .open-externally-button': {
        top: '10px',
        right: '10px',
        cursor: 'pointer'
      },
      '& figcaption': {
        bottom: '10px',
        left: '10px',
        right: '10px',
        cursor: 'text', // Captions can be edited
        // Codemirror 6's drawCursor plugin makes the actual cursor transparent,
        // so we have to reset it here for the contenteditables. Same for
        // selection backgrounds.
        caretColor: 'rgb(255, 255, 255)',
        '&::selection': {
          color: 'black',
          // Overwrite the important by the plugin
          backgroundColor: 'rgba(255, 255, 255, 0.8) !important'
        }
      },
      // The resize handles sit inside the figure (which clips its content) at
      // the vertical middle of the left and right edges. They are only shown
      // while the image is selected; these selectors are more specific than
      // the opacity rules above.
      '& .image-resize-handle': {
        display: 'none',
        position: 'absolute',
        top: '50%',
        width: '8px',
        height: '32px',
        marginTop: '-16px',
        boxSizing: 'border-box',
        backgroundColor: 'white',
        border: '1px solid rgba(0, 0, 0, .6)',
        borderRadius: '3px',
        cursor: 'ew-resize',
        touchAction: 'none',
        zIndex: '1'
      },
      '& .image-resize-handle.left': { left: '3px' },
      '& .image-resize-handle.right': { right: '3px' },
      '&.selected .image-resize-handle': {
        display: 'block',
        opacity: '1'
      }
    }
  }),
  selectedImageField,
  pastedImagePreviewField,
  pastedImagePreviewLifecycle,
  imageWidgets,
  imageOnlyLines,
  hiddenImageAttributes,
  imageSelectionHandlers
]
