/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Table cell contents
 * CVM-Role:        View
 * License:         GNU GPL v3
 *
 * Description:     Fills the content wrapper of a table cell that is not
 *                  currently being edited with the sanitized HTML rendered from
 *                  the cell's Markdown. Image sources are resolved against the
 *                  document's directory, just like images outside of tables.
 *                  Each wrapper remembers the HTML and the document path it has
 *                  been rendered from, so that the table widget only re-renders
 *                  a cell when one of them changed (re-rendering reloads every
 *                  image in the cell and restarts animated GIFs).
 *
 * END HEADER
 */

import { sanitizeHTML } from 'source/common/util/sanitize-html'
import { resolveHtmlImageSource } from '../renderers/render-html-block'

/**
 * What a content wrapper has last been rendered from.
 */
interface RenderedCellContents {
  /**
   * The HTML rendered from the cell's Markdown (before sanitizing).
   */
  html: string
  /**
   * The path of the document against which the image sources were resolved.
   */
  documentPath: string
}

/**
 * For each rendered content wrapper, this holds what it has last been rendered
 * from. Comparing freshly rendered HTML against the wrapper's inner HTML does
 * not work, since resolving the image sources and inserting task checkboxes
 * both alter the inner HTML.
 */
const renderedCellContents = new WeakMap<HTMLElement, RenderedCellContents>()

/**
 * Fills a cell's content wrapper with the sanitized HTML, resolving relative
 * image sources against the document's directory, and remembers the HTML and
 * the document path for `cellContentsChanged`. An empty HTML string renders as
 * a non-breaking space so that the cell keeps its height.
 *
 * NOTE: The image sources are resolved only after sanitizing, since DOMPurify
 * removes `safe-file://` URLs. The sanitized HTML is parsed into an inert
 * template first, so that no image starts loading from an unresolved source.
 *
 * @param   {HTMLElement}  contentWrapper  The cell's content wrapper
 * @param   {string}       html            The HTML rendered from the cell's
 *                                         Markdown (before sanitizing)
 * @param   {string}       documentPath    The path of the current document
 */
export function renderCellContents (contentWrapper: HTMLElement, html: string, documentPath: string): void {
  renderedCellContents.set(contentWrapper, { html, documentPath })

  if (html.length === 0) {
    contentWrapper.innerHTML = '&nbsp;'
    return
  }

  const template = document.createElement('template')
  template.innerHTML = sanitizeHTML(html)

  for (const image of Array.from(template.content.querySelectorAll('img'))) {
    const source = image.getAttribute('src')
    if (source !== null && source.trim() !== '') {
      image.setAttribute('src', resolveHtmlImageSource(source, documentPath))
    }
  }

  contentWrapper.replaceChildren(template.content)
}

/**
 * Determines whether a cell's content wrapper has to be re-rendered: This is
 * the case if it has never been rendered by `renderCellContents` (or its
 * record has been forgotten), or if the HTML or the document path differ from
 * those it has last been rendered from.
 *
 * @param   {HTMLElement}  contentWrapper  The cell's content wrapper
 * @param   {string}       html            The freshly rendered HTML
 * @param   {string}       documentPath    The path of the current document
 *
 * @return  {boolean}                      Whether the cell must be re-rendered
 */
export function cellContentsChanged (contentWrapper: HTMLElement, html: string, documentPath: string): boolean {
  const rendered = renderedCellContents.get(contentWrapper)
  return rendered === undefined || rendered.html !== html || rendered.documentPath !== documentPath
}

/**
 * Forgets what a cell's content wrapper has been rendered from, so that the
 * next call to `cellContentsChanged` reports a change. Must be called whenever
 * the wrapper's contents are replaced by something else (e.g., a subview).
 *
 * @param   {HTMLElement}  contentWrapper  The cell's content wrapper
 */
export function forgetCellContents (contentWrapper: HTMLElement): void {
  renderedCellContents.delete(contentWrapper)
}
