/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Location highlight of the PDF viewer
 * CVM-Role:        Utility
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH R59 (contract C5, section "定位请求"): turns a
 *                  PdfTextSelection into a DOM Range over the text layer of a
 *                  page and shows it with the CSS Custom Highlight API. The
 *                  text layer's elements are taken from the page view's text
 *                  highlighter, whose `textDivs` is the array pdf.js' TextLayer
 *                  fills in item order (one element per text content item, an
 *                  empty item included); the DOM order cannot be used because
 *                  elements of empty items are never inserted into the page.
 *                  One Highlight object per color is shared by all viewers of
 *                  a window; every viewer adds and removes only its own
 *                  ranges.
 *
 * END HEADER
 */

import {
  PDF_DEFAULT_HIGHLIGHT_COLOR,
  PDF_HIGHLIGHT_COLORS,
  PDF_LOCATION_HIGHLIGHT_NAME,
  type PdfTextSelection
} from 'source/types/common/pdf-viewer'

/**
 * What is added to the item numbers of a PdfTextSelection to obtain indices
 * into the text layer's `textDivs`. Contract C5 leaves open whether item
 * numbers and PDF++'s numbers differ by a constant; until the R60
 * compatibility check settles it, they are taken to be equal.
 */
export const PDF_SELECTION_INDEX_OFFSET = 0

/**
 * Converts an item number of a PdfTextSelection into an index of the text
 * layer's `textDivs`. All conversions go through this function.
 *
 * @param   {number}  index  An item number from a location request
 *
 * @return  {number}         The index into `textDivs`
 */
export function selectionIndexToTextDivIndex (index: number): number {
  return index + PDF_SELECTION_INDEX_OFFSET
}

/**
 * The name under which a location highlight of a color is registered.
 * CSS can give each highlight name only one style, so every known color has
 * a name of its own; unknown colors and requests without a color use the
 * bare name.
 *
 * @param   {string|undefined}  color  The color name of the request
 *
 * @return  {string}                   The highlight name
 */
export function locationHighlightName (color: string|undefined): string {
  const colorName = color?.toLowerCase()
  if (colorName !== undefined && Object.prototype.hasOwnProperty.call(PDF_HIGHLIGHT_COLORS, colorName)) {
    return `${PDF_LOCATION_HIGHLIGHT_NAME}-${colorName}`
  }

  return PDF_LOCATION_HIGHLIGHT_NAME
}

const HIGHLIGHT_STYLE_ELEMENT_ID = 'zettlr-lyh-pdf-location-highlight-styles'

/**
 * Adds the `::highlight()` rules of all location highlight names to a
 * document, once
 *
 * @param   {Document}  ownerDocument  The document of the viewer
 */
function ensureHighlightStyles (ownerDocument: Document): void {
  if (ownerDocument.getElementById(HIGHLIGHT_STYLE_ELEMENT_ID) !== null) {
    return
  }

  const rules = [`::highlight(${PDF_LOCATION_HIGHLIGHT_NAME}) { background-color: ${PDF_DEFAULT_HIGHLIGHT_COLOR}; }`]
  for (const [ colorName, background ] of Object.entries(PDF_HIGHLIGHT_COLORS)) {
    rules.push(`::highlight(${locationHighlightName(colorName)}) { background-color: ${background}; }`)
  }

  const style = ownerDocument.createElement('style')
  style.id = HIGHLIGHT_STYLE_ELEMENT_ID
  style.textContent = rules.join('\n')
  ownerDocument.head.appendChild(style)
}

/**
 * The minimal shape of a pdf.js PDFPageView this module reads. pdf.js 6.3
 * declares `_textHighlighter` as `any`; it is a lazily created
 * TextHighlighter whose `textDivs` is set by TextLayerBuilder.render().
 */
interface PageViewWithTextLayer {
  textLayer?: { div?: HTMLElement }|null
  _textHighlighter?: { textDivs?: unknown }|null
}

/**
 * Returns the text layer elements of a page in item order, or null while the
 * page has no rendered text layer
 *
 * @param   {unknown}             pageView  A PDFPageView (PDFViewer.getPageView)
 *
 * @return  {HTMLElement[]|null}            The elements, indexed by item number
 */
export function getPageTextDivs (pageView: unknown): HTMLElement[]|null {
  if (typeof pageView !== 'object' || pageView === null) {
    return null
  }

  const view = pageView as PageViewWithTextLayer
  const textLayerDiv = view.textLayer?.div
  if (textLayerDiv === undefined || !textLayerDiv.isConnected) {
    return null
  }

  const textDivs = view._textHighlighter?.textDivs
  if (!Array.isArray(textDivs)) {
    return null
  }

  return textDivs as HTMLElement[]
}

/**
 * Whether the text layer of a page is shown. When the zoom changes, pdf.js
 * resets every page it does not draw right away (pages out of view, or all
 * pages while a zoom is still being drawn) but keeps their text layers in the
 * page, hidden, until it draws the page again (PDFPageView.reset with
 * keepTextLayer). getPageTextDivs still returns the elements of such a layer,
 * yet they report empty bounding boxes, so nothing can be scrolled to them;
 * pdf.js shows the layer again and dispatches textlayerrendered once it has
 * drawn the page.
 *
 * @param   {unknown}  pageView  A PDFPageView (PDFViewer.getPageView)
 *
 * @return  {boolean}            True if the page has a text layer that is in
 *                               the page and not hidden
 */
export function isPageTextLayerShown (pageView: unknown): boolean {
  if (typeof pageView !== 'object' || pageView === null) {
    return false
  }

  const textLayerDiv = (pageView as PageViewWithTextLayer).textLayer?.div
  return textLayerDiv !== undefined && textLayerDiv.isConnected && !textLayerDiv.hidden
}

/**
 * Finds the text node and offset inside one text layer element. The element's
 * children may have been split by pdf.js' find highlighting, so its text
 * nodes are walked in order.
 *
 * @param   {HTMLElement}  element  A text layer element
 * @param   {number}       offset   A UTF-16 offset into the element's text
 * @param   {string}       side     'begin' prefers the start of the following
 *                                  text node at a node boundary, 'end' the end
 *                                  of the preceding one
 *
 * @return  {{ node: Node, offset: number }}  The boundary point
 */
function boundaryInElement (element: HTMLElement, offset: number, side: 'begin'|'end'): { node: Node, offset: number } {
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  let remaining = Math.max(0, offset)
  let lastTextNode: Text|null = null

  for (let node = walker.nextNode() as Text|null; node !== null; node = walker.nextNode() as Text|null) {
    const length = node.data.length
    if (remaining < length || (remaining === length && side === 'end')) {
      return { node, offset: remaining }
    }

    remaining -= length
    lastTextNode = node
  }

  if (lastTextNode !== null) {
    return { node: lastTextNode, offset: lastTextNode.data.length }
  }

  // No text node at all: place the boundary around the element's children
  return { node: element, offset: side === 'begin' ? 0 : element.childNodes.length }
}

/**
 * Builds the DOM Range of a selection on one page. Boundaries that fall on an
 * element that is not in the page (an empty item) move inwards to the nearest
 * element that is: the begin forwards to the start of the next one, the end
 * backwards to the end of the previous one.
 *
 * @param   {HTMLElement[]}     textDivs   The page's text layer elements in
 *                                         item order (getPageTextDivs)
 * @param   {PdfTextSelection}  selection  The range, in item numbers
 *
 * @return  {Range|null}                   The range, or null if it covers no
 *                                         element that is in the page
 */
export function buildSelectionRange (textDivs: HTMLElement[], selection: PdfTextSelection): Range|null {
  if (textDivs.length === 0) {
    return null
  }

  let beginIndex = selectionIndexToTextDivIndex(selection.beginIndex)
  let beginOffset = selection.beginOffset
  let endIndex = selectionIndexToTextDivIndex(selection.endIndex)
  let endOffset = selection.endOffset

  if (beginIndex < 0) {
    beginIndex = 0
    beginOffset = 0
  }

  if (endIndex >= textDivs.length) {
    endIndex = textDivs.length - 1
    endOffset = Number.MAX_SAFE_INTEGER
  }

  while (beginIndex <= endIndex && !textDivs[beginIndex].isConnected) {
    beginIndex++
    beginOffset = 0
  }

  while (endIndex >= beginIndex && !textDivs[endIndex].isConnected) {
    endIndex--
    endOffset = Number.MAX_SAFE_INTEGER
  }

  if (beginIndex > endIndex) {
    return null
  }

  const begin = boundaryInElement(textDivs[beginIndex], beginOffset, 'begin')
  const end = boundaryInElement(textDivs[endIndex], endOffset, 'end')

  const range = textDivs[beginIndex].ownerDocument.createRange()
  range.setStart(begin.node, begin.offset)
  range.setEnd(end.node, end.offset)
  return range.collapsed ? null : range
}

/**
 * The first text layer element of a selection that is in the page, used to
 * scroll the beginning of the range into view
 *
 * @param   {HTMLElement[]}     textDivs   The page's text layer elements
 * @param   {PdfTextSelection}  selection  The range, in item numbers
 *
 * @return  {HTMLElement|null}             The element, or null
 */
export function firstSelectionElement (textDivs: HTMLElement[], selection: PdfTextSelection): HTMLElement|null {
  const endIndex = Math.min(selectionIndexToTextDivIndex(selection.endIndex), textDivs.length - 1)
  for (let i = Math.max(0, selectionIndexToTextDivIndex(selection.beginIndex)); i <= endIndex; i++) {
    if (textDivs[i].isConnected) {
      return textDivs[i]
    }
  }

  return null
}

/**
 * The location highlight of one viewer. It keeps track of its own ranges, so
 * that clearing it leaves the highlights of other viewers in the same window
 * untouched.
 */
export class PdfLocationHighlight {
  private ranges: Range[] = []
  private highlightName: string|null = null

  /**
   * Shows the given ranges in the given color, replacing what this viewer
   * showed before
   *
   * @param   {Range[]}           ranges  The ranges to highlight
   * @param   {string|undefined}  color   The color name of the request
   */
  show (ranges: Range[], color: string|undefined): void {
    this.clear()
    if (ranges.length === 0 || typeof CSS === 'undefined' || CSS.highlights === undefined) {
      return
    }

    ensureHighlightStyles(ranges[0].startContainer.ownerDocument ?? document)

    const name = locationHighlightName(color)
    let highlight = CSS.highlights.get(name)
    if (highlight === undefined) {
      highlight = new Highlight()
      // Drawn above the backlink highlights, whose priority is 0 (R62)
      highlight.priority = 1
      CSS.highlights.set(name, highlight)
    }

    for (const range of ranges) {
      highlight.add(range)
    }

    this.ranges = ranges
    this.highlightName = name
  }

  /**
   * Removes this viewer's ranges; a highlight left without ranges is removed
   * from the registry
   */
  clear (): void {
    if (this.highlightName !== null && typeof CSS !== 'undefined' && CSS.highlights !== undefined) {
      const highlight = CSS.highlights.get(this.highlightName)
      if (highlight !== undefined) {
        for (const range of this.ranges) {
          highlight.delete(range)
        }

        if (highlight.size === 0) {
          CSS.highlights.delete(this.highlightName)
        }
      }
    }

    this.ranges = []
    this.highlightName = null
  }
}
