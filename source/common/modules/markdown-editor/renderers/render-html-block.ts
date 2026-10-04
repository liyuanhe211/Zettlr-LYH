/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Raw HTML block renderer
 * CVM-Role:        View
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     This renderer replaces raw HTML blocks that the in-place
 *                  renderer cannot display (tables, links, images, lists,
 *                  headings, ...) with a sanitized rendering of the whole
 *                  block while the selection is outside of it. Relative image
 *                  sources are resolved against the document's directory, and
 *                  links only open on Ctrl-click (Cmd-click on macOS); any
 *                  other click moves the cursor into the block's source.
 *                  Blocks containing other elements (e.g. `<script>`,
 *                  `<iframe>`) are left as source. Also exports the link and
 *                  image helpers shared with the inline HTML renderer.
 *
 * END HEADER
 */

import { renderBlockWidgets } from './base-renderer'
import { type SyntaxNodeRef } from '@lezer/common'
import { EditorView, WidgetType } from '@codemirror/view'
import { type EditorState } from '@codemirror/state'
import clickAndSelect from './click-and-select'
import { resolveImageUrl } from './render-images'
import { sanitizeHTML } from '@common/util/sanitize-html'
import { isAbsolutePath, pathDirname, resolvePath } from '@common/util/renderer-path-polyfill'
import { configField } from '../util/configuration'
import openMarkdownLink from '../util/open-markdown-link'
import { classifyHtmlBlock } from '../util/html-block-scan'
import { normalizeLinkHref } from '../util/html-span-tags'

/**
 * Returns true if the modifier that opens links is pressed: Cmd on macOS,
 * Ctrl everywhere else (the same convention as the Markdown link listener).
 *
 * @param   {MouseEvent}  event  The mouse event
 *
 * @return  {boolean}            Whether the link should be opened
 */
export function isLinkModifierPressed (event: MouseEvent): boolean {
  return process.platform === 'darwin' ? event.metaKey : event.ctrlKey
}

/**
 * Turns a relative link target into an absolute path, using the document's
 * directory, just like a browser resolves a relative `href`. Anchors
 * (`#heading`), targets with a protocol, network shares and absolute paths
 * are returned as they are.
 *
 * @param   {string}  href          The (normalized) link target
 * @param   {string}  documentPath  The path of the current document
 *
 * @return  {string}                The target to open
 */
function resolveLinkTarget (href: string, documentPath: string): string {
  if (href.startsWith('#') || href.startsWith('//') || isAbsolutePath(href)) {
    return href
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || documentPath === '') {
    return href
  }
  return resolvePath(pathDirname(documentPath), href)
}

/**
 * Opens the target of a rendered HTML link. Targets with a protocol other
 * than http, https, file and mailto are ignored.
 *
 * @param   {string}      href  The link target
 * @param   {EditorView}  view  The editor view
 */
export function openHtmlLink (href: string, view: EditorView): void {
  const target = normalizeLinkHref(href)
  if (target === undefined) {
    return
  }
  const documentPath = view.state.field(configField, false)?.metadata.path ?? ''
  openMarkdownLink(resolveLinkTarget(target, documentPath), view)
}

/**
 * Resolves the source of an HTML image the same way the Markdown image
 * renderer does: relative paths against the document's directory, data URLs
 * and absolute URLs unchanged.
 *
 * @param   {string}  source        The image source
 * @param   {string}  documentPath  The path of the current document
 *
 * @return  {string}                The URL to load
 */
export function resolveHtmlImageSource (source: string, documentPath: string): string {
  try {
    return resolveImageUrl(documentPath, source.trim())
  } catch (error) {
    return '' // A source that cannot be turned into a URL is not loaded
  }
}

/**
 * Remembers what each rendered container currently shows, so that an update
 * only rebuilds the rendering when the block's text or the document changed.
 */
const RENDERED_BLOCKS = new WeakMap<HTMLElement, { source: string, documentPath: string }>()

/**
 * Fills the container with the sanitized rendering of the block. The HTML is
 * first parsed into an inert template, so that images do not start loading
 * before their sources have been resolved.
 *
 * @param   {HTMLElement}  container     The widget's container
 * @param   {string}       source        The block's text
 * @param   {string}       documentPath  The path of the current document
 */
function renderBlockContents (container: HTMLElement, source: string, documentPath: string): void {
  const template = document.createElement('template')
  template.innerHTML = sanitizeHTML(source)

  for (const image of Array.from(template.content.querySelectorAll('img'))) {
    image.draggable = false
    const imageSource = image.getAttribute('src')
    if (imageSource !== null && imageSource.trim() !== '') {
      image.setAttribute('src', resolveHtmlImageSource(imageSource, documentPath))
    }
  }

  // Move every link target out of the `href` attribute, so that there is no
  // way for the browser to navigate by itself.
  for (const link of Array.from(template.content.querySelectorAll('a'))) {
    const href = link.getAttribute('href')
    link.removeAttribute('href')
    const target = href !== null ? normalizeLinkHref(href) : undefined
    if (target !== undefined) {
      link.dataset.href = target
      link.classList.add('html-block-link')
    }
  }

  container.replaceChildren(template.content)
  RENDERED_BLOCKS.set(container, { source, documentPath })
}

/**
 * Handles a click on a rendered block: Ctrl-click (Cmd-click on macOS) on a
 * link opens it, any other click moves the cursor into the block's source.
 *
 * @param   {MouseEvent}   event      The click event
 * @param   {HTMLElement}  container  The widget's container
 * @param   {EditorView}   view       The editor view
 */
function handleBlockClick (event: MouseEvent, container: HTMLElement, view: EditorView): void {
  const link = event.target instanceof Element ? event.target.closest('a') : null
  if (link !== null && container.contains(link) && isLinkModifierPressed(event)) {
    event.preventDefault()
    event.stopPropagation()
    const href = link.dataset.href
    if (href !== undefined) {
      openHtmlLink(href, view)
    }
    return
  }

  // Determine the block's range before the selection changes, since the
  // widget is removed from the DOM as soon as the selection enters the block.
  const rendered = RENDERED_BLOCKS.get(container)
  const from = view.posAtDOM(container)
  const to = Math.min(from + (rendered?.source.length ?? 0), view.state.doc.length)

  clickAndSelect(view)(event)

  // If clickAndSelect could not determine a selection that reveals the
  // source (e.g., the clicked element has no box, or both corners map onto
  // the same edge of the block), select the whole block instead.
  const main = view.state.selection.main
  if (rendered !== undefined && (main.to <= from || main.from >= to)) {
    view.dispatch({ selection: { anchor: from, head: to } })
  }

  event.preventDefault()
  view.focus()
}

class HtmlBlockWidget extends WidgetType {
  constructor (readonly source: string, readonly documentPath: string) {
    super()
  }

  eq (other: HtmlBlockWidget): boolean {
    return other.source === this.source && other.documentPath === this.documentPath
  }

  toDOM (view: EditorView): HTMLElement {
    const container = document.createElement('div')
    container.classList.add('html-block-preview')
    renderBlockContents(container, this.source, this.documentPath)
    container.addEventListener('click', event => { handleBlockClick(event, container, view) })
    return container
  }

  updateDOM (dom: HTMLElement, _view: EditorView): boolean {
    const rendered = RENDERED_BLOCKS.get(dom)
    if (rendered === undefined) {
      return false // Not one of our containers: rebuild the DOM
    }
    if (rendered.source !== this.source || rendered.documentPath !== this.documentPath) {
      renderBlockContents(dom, this.source, this.documentPath)
    }
    return true
  }

  ignoreEvent (_event: Event): boolean {
    return true // The click listener handles everything
  }
}

function shouldHandleNode (node: SyntaxNodeRef): boolean {
  return node.type.name === 'HTMLBlock'
}

function createWidget (state: EditorState, node: SyntaxNodeRef): HtmlBlockWidget|undefined {
  const source = state.sliceDoc(node.from, node.to)
  if (classifyHtmlBlock(source) !== 'widget') {
    return undefined
  }
  const documentPath = state.field(configField, false)?.metadata.path ?? ''
  return new HtmlBlockWidget(source, documentPath)
}

export const renderHtmlBlocks = [
  renderBlockWidgets(shouldHandleNode, createWidget),
  EditorView.baseTheme({
    '.html-block-preview': {
      display: 'block',
      cursor: 'default',
      // The editor content preserves whitespace, the rendered HTML must not
      whiteSpace: 'normal',
      // If the block is part of a list, reset the indentation CodeMirror applies
      textIndent: '0',
      overflowX: 'auto',
      '& table': {
        borderCollapse: 'collapse',
        margin: '4px 0'
      },
      '& th, & td': {
        border: '1px solid rgba(128, 128, 128, 0.5)',
        padding: '4px 8px'
      },
      '& th': {
        backgroundColor: 'rgba(128, 128, 128, 0.12)'
      },
      '& img': {
        maxWidth: '100%'
      },
      // Keep the aspect ratio when a width is given and the image is shrunk
      '& img[width]': {
        height: 'auto'
      },
      '& .html-block-link': {
        color: 'var(--zettlr-editor-primary-color)',
        textDecoration: 'underline'
      }
    }
  })
]
