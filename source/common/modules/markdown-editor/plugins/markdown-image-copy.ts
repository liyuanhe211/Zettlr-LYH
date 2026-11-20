/** Copy a single rendered Markdown image as PNG, with source text fallback. */
import { type EditorState, Prec } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import makeValidUri from '@common/util/make-valid-uri'
import { pathDirname } from '@common/util/renderer-path-polyfill'
import { configField } from '../util/configuration'
import { findImageAt, imageSourceRange, selectedImageField } from '../util/image-selection'
import { isRenderableImageNode } from '../util/image-only-lines'
import { shouldRevealSource } from '../util/reveal-selection'
import { normalizeCopyVisibleTextCategories } from '../util/visible-copy-policy'

export interface MarkdownImageCopyTarget {
  from: number
  to: number
  source: string
  selectedByClick: boolean
}

const copyOperations = new WeakMap<EditorView, number>()

function beginCopy (view: EditorView): number {
  const operation = (copyOperations.get(view) ?? 0) + 1
  copyOperations.set(view, operation)
  const container = view.dom ?? view.contentDOM
  container.querySelector('.cm-image-copy-notice')?.remove()
  return operation
}

/** Other explicit clipboard commands must supersede pending PNG conversions. */
export function cancelMarkdownImageCopy (view: EditorView): void {
  beginCopy(view)
}

function reportCopyFailure (view: EditorView, message: string): void {
  try {
    if (typeof window.ipc?.send === 'function') {
      window.ipc.send('renderer-runtime-error', { kind: 'error', message, source: 'Markdown image copy', userNotice: true })
      return
    }
  } catch { /* A missing reporting backend must not hide the failure. */ }
  const notice = view.dom.ownerDocument.createElement('div')
  notice.className = 'cm-image-copy-notice'
  notice.setAttribute('role', 'status')
  notice.textContent = message
  notice.style.cssText = 'position:absolute;bottom:1em;right:1em;max-width:32em;padding:0.75em;background:Canvas;color:CanvasText;border:1px solid currentColor;z-index:100'
  notice.title = 'Click to dismiss'
  notice.addEventListener('click', () => notice.remove())
  view.dom.appendChild(notice)
}

/** Accept exactly one image, never an enclosing paragraph or mixed selection. */
export function markdownImageCopyTarget (state: EditorState): MarkdownImageCopyTarget|undefined {
  const configuration = state.field(configField, false)
  if (configuration === undefined || configuration.renderingMode === 'raw' ||
    !configuration.renderImages || state.selection.ranges.length !== 1) {
    return undefined
  }
  const selection = state.selection.main
  const selected = state.field(selectedImageField, false)
  const position = selected ?? (selection.empty ? undefined : selection.from)
  if (position === undefined) {
    return undefined
  }
  const found = findImageAt(state, position)
  const range = imageSourceRange(state, position)
  if (found === undefined || range === undefined || !isRenderableImageNode(state, found.image) ||
    shouldRevealSource(state, 'images', range.from, range.to, configuration.previewModeShowSyntaxWhenCursorIsAdjacent)) {
    return undefined
  }
  if (!selection.empty && (selection.from !== range.from ||
    (selection.to !== found.image.to && selection.to !== range.to))) {
    return undefined
  }
  if (selection.empty && selected === undefined) {
    return undefined
  }
  return { ...range, source: state.sliceDoc(range.from, range.to), selectedByClick: selected !== null && selected !== undefined }
}

function waitForImage (image: HTMLImageElement): Promise<void> {
  if (image.complete) {
    return image.naturalWidth > 0 && image.naturalHeight > 0 ? Promise.resolve()
      : Promise.reject(new Error('The selected image could not be loaded.'))
  }
  return new Promise((resolve, reject) => {
    const finish = (error?: Error): void => {
      clearTimeout(timeout)
      image.removeEventListener('load', loaded)
      image.removeEventListener('error', failed)
      if (error !== undefined) { reject(error) } else { resolve() }
    }
    const loaded = (): void => finish(image.naturalWidth > 0 && image.naturalHeight > 0
      ? undefined : new Error('The selected image has no readable pixels.'))
    const failed = (): void => finish(new Error('The selected image could not be loaded.'))
    const timeout = setTimeout(() => finish(new Error('Loading the selected image timed out.')), 10000)
    image.addEventListener('load', loaded, { once: true })
    image.addEventListener('error', failed, { once: true })
  })
}

/** Exported for pixel-level browser verification, without clipboard side effects. */
export async function markdownImagePngBlob (image: HTMLImageElement): Promise<Blob> {
  await waitForImage(image)
  const canvas = image.ownerDocument.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d')
  if (context === null) {
    throw new Error('Canvas image conversion is not available.')
  }
  context.drawImage(image, 0, 0)
  return await new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob === null || blob.size === 0 || blob.type !== 'image/png') {
        reject(new Error('The selected image could not be converted to PNG.'))
      } else {
        resolve(blob)
      }
    }, 'image/png')
  })
}

function renderedImage (view: EditorView, target: MarkdownImageCopyTarget): HTMLImageElement {
  const image = view.contentDOM.querySelector<HTMLImageElement>(`img[data-from="${target.from}"]`)
  if (image === null || image.dataset.to !== String(findImageAt(view.state, target.from)?.image.to)) {
    throw new Error('The selected image is no longer rendered.')
  }
  const original = image.dataset.originalUrl
  if (original === undefined || original === '') {
    throw new Error('The selected image has no original source.')
  }
  const configuration = view.state.field(configField)
  const expected = /^data:/i.test(original) ? original
    : makeValidUri(original, pathDirname(configuration.metadata.path))
  const source = new URL(expected, image.ownerDocument.baseURI).href
  if (image.src !== source || (image.currentSrc !== '' && image.currentSrc !== source)) {
    throw new Error('The selected image is displaying a replacement image.')
  }
  return image
}

/** Native PNG/JPEG decoding handles local images tainted by the custom scheme. */
async function copyLocalImage (image: HTMLImageElement): Promise<boolean> {
  const url = new URL(image.src)
  if ((url.protocol !== 'safe-file:' && url.protocol !== 'file:') ||
    !/\.(png|jpe?g)$/i.test(url.pathname) || !image.complete ||
    image.naturalWidth <= 0 || image.naturalHeight <= 0 || typeof window.ipc?.invoke !== 'function') {
    return false
  }
  // The existing command strips schemes but does not decode URL escapes.
  let filename = decodeURIComponent(url.pathname)
  if (url.hostname !== '') { filename = `//${url.hostname}${filename}` }
  if (/^\/[A-Z]:/i.test(filename)) { filename = filename.slice(1) }
  return await window.ipc.invoke('application', { command: 'copy-img-to-clipboard', payload: filename }) === true
}

/** Decode local resources as image-only Blob URLs owned by this renderer. */
async function localImagePngBlob (image: HTMLImageElement): Promise<Blob|undefined> {
  if (!/^(safe-)?file:/i.test(image.src) || typeof window.ipc?.invoke !== 'function') { return undefined }
  const reply: unknown = await window.ipc.invoke('application', { command: 'get-image-file-bytes', payload: image.src })
  // Only a missing command permits the legacy native path. A new backend's
  // null reply means the resource is invalid or unreadable, not unsupported.
  if (reply === undefined || reply === false) { return undefined }
  if (typeof reply !== 'object' || reply === null) { throw new Error('The selected local image could not be read.') }
  const { bytes, mime } = reply as { bytes?: unknown, mime?: unknown }
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || typeof mime !== 'string' || !mime.startsWith('image/')) { throw new Error('The selected local image returned invalid image data.') }
  const resource = URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer], { type: mime }))
  try {
    const readable = image.ownerDocument.createElement('img')
    readable.src = resource
    return await markdownImagePngBlob(readable)
  } finally {
    URL.revokeObjectURL(resource)
  }
}

async function writeImage (view: EditorView, target: MarkdownImageCopyTarget, operation: number): Promise<void> {
  const originalState = view.state
  const current = (): boolean => copyOperations.get(view) === operation &&
    view.state.doc === originalState.doc && view.state.selection.eq(originalState.selection) &&
    view.state.field(selectedImageField, false) === originalState.field(selectedImageField, false) &&
    normalizeCopyVisibleTextCategories(view.state.field(configField).copyVisibleTextCategories).images
  try {
    if (typeof ClipboardItem === 'undefined' || typeof navigator.clipboard?.write !== 'function') {
      throw new Error('Writing image data to the clipboard is not available.')
    }
    const image = renderedImage(view, target)
    let blob: Blob
    try {
      blob = await markdownImagePngBlob(image)
    } catch (error) {
      const local = await localImagePngBlob(image)
      if (local !== undefined) {
        blob = local
      } else {
        if (current() && await copyLocalImage(image)) { return }
        // Network images initially loaded without CORS may taint a canvas.
        // Retry with a fresh CORS-enabled image; unreadable sources still fail.
        if (!/^https?:/i.test(image.src)) { throw error }
        const readable = image.ownerDocument.createElement('img')
        readable.crossOrigin = 'anonymous'
        readable.src = image.src
        blob = await markdownImagePngBlob(readable)
      }
    }
    if (!current()) { return }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
  } catch (error) {
    if (!current()) { return }
    console.error('Could not copy image data; copying Markdown source instead.', error)
    try {
      await navigator.clipboard.writeText(target.source)
      reportCopyFailure(view, 'Could not copy image data. Copied Markdown source instead.')
    } catch (fallbackError) {
      console.error('Could not copy the Markdown image source.', fallbackError)
      reportCopyFailure(view, 'Could not copy image data or the Markdown image source.')
    }
  }
}

/** Returns true when this module owns the copy; completion remains asynchronous. */
export function copyMarkdownImage (view: EditorView): boolean {
  const operation = beginCopy(view)
  const target = markdownImageCopyTarget(view.state)
  if (target === undefined) { return false }
  const enabled = normalizeCopyVisibleTextCategories(view.state.field(configField).copyVisibleTextCategories).images
  if (!enabled) {
    if (!target.selectedByClick) { return false }
    try {
      Promise.resolve(navigator.clipboard.writeText(target.source)).catch(error => {
        console.error(error)
        reportCopyFailure(view, 'Could not copy the Markdown image source.')
      })
    } catch (error) {
      console.error(error)
      reportCopyFailure(view, 'Could not copy the Markdown image source.')
      return false
    }
    return true
  }
  void writeImage(view, target, operation)
  return true
}

/** The synchronous native event always receives source text as a safe fallback. */
export function handleMarkdownImageCopy (event: ClipboardEvent, view: EditorView): boolean {
  const operation = beginCopy(view)
  if (event.clipboardData === null) { return false }
  const selection = view.contentDOM.ownerDocument.getSelection()
  if (selection !== null && !selection.isCollapsed &&
    (selection.anchorNode === null || selection.focusNode === null ||
      !view.contentDOM.contains(selection.anchorNode) || !view.contentDOM.contains(selection.focusNode))) {
    return false
  }
  const target = markdownImageCopyTarget(view.state)
  if (target === undefined) { return false }
  const enabled = normalizeCopyVisibleTextCategories(view.state.field(configField).copyVisibleTextCategories).images
  if (!enabled && !target.selectedByClick) { return false }
  event.clipboardData.clearData()
  event.clipboardData.setData('text/plain', target.source)
  event.preventDefault()
  if (enabled) { void writeImage(view, target, operation) }
  return true
}

/** Optional standalone registration; integrations may call the handler first. */
export const markdownImageCopy = Prec.highest(EditorView.domEventHandlers({ copy: handleMarkdownImageCopy }))
