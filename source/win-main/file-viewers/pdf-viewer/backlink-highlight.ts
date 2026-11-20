/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Backlink highlights of the PDF viewer
 * CVM-Role:        Utility
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH R62 (contract C11, sections "标色" and "悬停"):
 *                  shows every passage of the open PDF that a note quotes with
 *                  a `selection=` link as a lasting, half-transparent
 *                  highlight, and tells which notes quote the passage under
 *                  the mouse. Each link's range is first checked against its
 *                  quoted text (decision 071, resolveSelectionBySourceText);
 *                  the text of a page is read at most once, when its text
 *                  layer is first drawn. Ranges are built over the text layer
 *                  like the location highlight's (buildSelectionRange) and
 *                  registered per page, so that a page can be rebuilt when
 *                  pdf.js redraws its text layer or replaces its text nodes.
 *                  One Highlight object per color key is shared by all viewers
 *                  of a window, with priority 0, below the location highlight
 *                  (priority 1); every viewer adds and removes only its own
 *                  ranges. The color, hit and ordering rules are exported as
 *                  pure functions so that they can be tested without a window.
 *
 * END HEADER
 */

import {
  PDF_BACKLINK_HIGHLIGHT_ALPHA,
  PDF_BACKLINK_HIGHLIGHT_PREFIX,
  PDF_DEFAULT_HIGHLIGHT_COLOR,
  PDF_HIGHLIGHT_COLORS,
  type PdfBacklink,
  type PdfTextSelection
} from 'source/types/common/pdf-viewer'
import {
  buildPdfPageText,
  pdfBacklinkColorKey,
  resolveSelectionBySourceText,
  type PdfTextItem
} from '@common/modules/pdf-text'
import { buildSelectionRange, getPageTextDivs, isPageTextLayerShown } from './location-highlight'

/**
 * The color keys a backlink highlight can have: the four named colors of
 * PDF_HIGHLIGHT_COLORS, and `default` for every other color name
 */
export type PdfBacklinkColorKey = 'yellow'|'red'|'note'|'important'|'default'

/**
 * Every color key, in the order their style rules are written
 */
export const PDF_BACKLINK_COLOR_KEYS: readonly PdfBacklinkColorKey[] = [ 'yellow', 'red', 'note', 'important', 'default' ]

/**
 * Priority of the backlink Highlight objects; the location highlight has 1
 * and is therefore drawn above them (decision on question 597)
 */
export const PDF_BACKLINK_HIGHLIGHT_PRIORITY = 0

/**
 * How far, in CSS pixels, the mouse may be outside a highlight rectangle and
 * still count as on it
 */
export const PDF_BACKLINK_HIT_TOLERANCE_PX = 1

const BACKLINK_STYLE_ELEMENT_ID = 'zettlr-lyh-pdf-backlink-highlight-styles'

/**
 * The name under which the backlink highlights of a color are registered in
 * CSS.highlights
 *
 * @param   {string}  color  The color name of a backlink (PdfBacklink.color)
 *
 * @return  {string}         `${PDF_BACKLINK_HIGHLIGHT_PREFIX}-${colorKey}`
 */
export function backlinkHighlightName (color: string): string {
  return backlinkHighlightNameOfKey(pdfBacklinkColorKey(color))
}

/**
 * The name under which the backlink highlights of a color key are registered
 *
 * @param   {PdfBacklinkColorKey}  colorKey  The color key
 *
 * @return  {string}                         The highlight name
 */
export function backlinkHighlightNameOfKey (colorKey: PdfBacklinkColorKey): string {
  return `${PDF_BACKLINK_HIGHLIGHT_PREFIX}-${colorKey}`
}

/**
 * Reads the red, green and blue channels of a CSS color written as `#rgb`,
 * `#rrggbb`, `rgb(r, g, b)` or `rgba(r, g, b, a)`
 *
 * @param   {string}                    color  The CSS color
 *
 * @return  {[number, number, number]}         The channels, 0 to 255
 */
export function cssColorChannels (color: string): [number, number, number] {
  const trimmed = color.trim()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(trimmed)
  if (hex !== null) {
    let digits = hex[1]
    if (digits.length === 3) {
      digits = digits.split('').map(digit => digit + digit).join('')
    }
    return [
      parseInt(digits.slice(0, 2), 16),
      parseInt(digits.slice(2, 4), 16),
      parseInt(digits.slice(4, 6), 16)
    ]
  }

  const functional = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*[\d.]+\s*)?\)$/i.exec(trimmed)
  if (functional !== null) {
    return [ Number(functional[1]), Number(functional[2]), Number(functional[3]) ]
  }

  throw new Error(`Unsupported highlight color: ${color}`)
}

/**
 * The background of the backlink highlights of a color key: the color's
 * background from PDF_HIGHLIGHT_COLORS (the amber PDF_DEFAULT_HIGHLIGHT_COLOR
 * for `default`) with the opacity PDF_BACKLINK_HIGHLIGHT_ALPHA
 *
 * @param   {PdfBacklinkColorKey}  colorKey  The color key
 *
 * @return  {string}                         An `rgba(r, g, b, a)` string
 */
export function backlinkHighlightBackground (colorKey: PdfBacklinkColorKey): string {
  const base = colorKey === 'default' ? PDF_DEFAULT_HIGHLIGHT_COLOR : PDF_HIGHLIGHT_COLORS[colorKey]
  const [ red, green, blue ] = cssColorChannels(base)
  return `rgba(${red}, ${green}, ${blue}, ${PDF_BACKLINK_HIGHLIGHT_ALPHA})`
}

/**
 * The `::highlight()` rules of all backlink highlight names
 *
 * @return  {string[]}  One rule per color key
 */
export function backlinkHighlightStyleRules (): string[] {
  return PDF_BACKLINK_COLOR_KEYS.map(colorKey => {
    return `::highlight(${backlinkHighlightNameOfKey(colorKey)}) { background-color: ${backlinkHighlightBackground(colorKey)}; }`
  })
}

/**
 * Adds the backlink highlight rules to a document, once
 *
 * @param   {Document}  ownerDocument  The document of the viewer
 */
function ensureBacklinkHighlightStyles (ownerDocument: Document): void {
  if (ownerDocument.getElementById(BACKLINK_STYLE_ELEMENT_ID) !== null) {
    return
  }

  const style = ownerDocument.createElement('style')
  style.id = BACKLINK_STYLE_ELEMENT_ID
  style.textContent = backlinkHighlightStyleRules().join('\n')
  ownerDocument.head.appendChild(style)
}

/**
 * The part of a DOMRect the hit test reads
 */
export interface PdfClientRect {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * Whether a point lies on a rectangle, its edges widened by a tolerance.
 * Empty rectangles (no width or no height, e.g. those of line breaks) are
 * never hit.
 *
 * @param   {PdfClientRect}  rect       The rectangle, in client coordinates
 * @param   {number}         x          The point's clientX
 * @param   {number}         y          The point's clientY
 * @param   {number}         tolerance  How far outside still counts
 *
 * @return  {boolean}                   True if the point is on the rectangle
 */
export function rectContainsPoint (rect: PdfClientRect, x: number, y: number, tolerance: number = PDF_BACKLINK_HIT_TOLERANCE_PX): boolean {
  if (rect.right <= rect.left || rect.bottom <= rect.top) {
    return false
  }

  return x >= rect.left - tolerance && x <= rect.right + tolerance &&
    y >= rect.top - tolerance && y <= rect.bottom + tolerance
}

/**
 * Whether a point lies on any of the rectangles of a range (one per line or
 * text element, as returned by Range.getClientRects)
 *
 * @param   {ArrayLike<PdfClientRect>}  rects      The rectangles
 * @param   {number}                    x          The point's clientX
 * @param   {number}                    y          The point's clientY
 * @param   {number}                    tolerance  How far outside still counts
 *
 * @return  {boolean}                              True if any rectangle is hit
 */
export function rectsContainPoint (rects: ArrayLike<PdfClientRect>, x: number, y: number, tolerance: number = PDF_BACKLINK_HIT_TOLERANCE_PX): boolean {
  for (let i = 0; i < rects.length; i++) {
    if (rectContainsPoint(rects[i], x, y, tolerance)) {
      return true
    }
  }

  return false
}

/**
 * A backlink under the mouse. `fallback` is true if its quoted text could not
 * be found on the page and the link's own selection is highlighted
 * unverified (decision on question 593).
 */
export interface PdfBacklinkHit {
  backlink: PdfBacklink
  fallback: boolean
}

/**
 * Compares two note paths: ignoring case first, so that the order is the same
 * on every platform and agrees with the index's order on Windows, then
 * exactly, so that the order is total
 */
function compareNotePaths (first: string, second: string): number {
  const firstFolded = first.toLowerCase()
  const secondFolded = second.toLowerCase()
  if (firstFolded !== secondFolded) {
    return firstFolded < secondFolded ? -1 : 1
  }

  if (first !== second) {
    return first < second ? -1 : 1
  }

  return 0
}

/**
 * Orders hits by note path and line and keeps one hit per line of a note:
 * the first one in the given order among those of the same note and line
 *
 * @param   {PdfBacklinkHit[]}  hits  The hits, in any order
 *
 * @return  {PdfBacklinkHit[]}        The ordered hits without duplicates
 */
export function sortAndDeduplicateHits (hits: PdfBacklinkHit[]): PdfBacklinkHit[] {
  const ordered = hits
    .map((hit, position) => ({ hit, position }))
    .sort((first, second) => {
      const byNote = compareNotePaths(first.hit.backlink.notePath, second.hit.backlink.notePath)
      if (byNote !== 0) {
        return byNote
      }

      const byLine = first.hit.backlink.line - second.hit.backlink.line
      if (byLine !== 0) {
        return byLine
      }

      return first.position - second.position
    })

  const result: PdfBacklinkHit[] = []
  for (const { hit } of ordered) {
    const previous = result[result.length - 1]
    if (previous !== undefined && previous.backlink.notePath === hit.backlink.notePath && previous.backlink.line === hit.backlink.line) {
      continue
    }
    result.push(hit)
  }

  return result
}

/**
 * A backlink with the selection to highlight after checking it against its
 * quoted text
 */
export interface PdfResolvedBacklink {
  backlink: PdfBacklink
  selection: PdfTextSelection
  fallback: boolean
  highlightName: string
}

/**
 * Checks the backlinks of one page against their quoted texts (decision 071).
 * Backlinks without a selection are left out: they are never highlighted
 * (decision on question 592).
 *
 * @param   {PdfTextItem[]}  items      The text items of the page
 * @param   {PdfBacklink[]}  backlinks  The page's backlinks
 *
 * @return  {PdfResolvedBacklink[]}     The backlinks to highlight, in the given order
 */
export function resolvePageBacklinks (items: PdfTextItem[], backlinks: PdfBacklink[]): PdfResolvedBacklink[] {
  const pageText = buildPdfPageText(items)
  const resolved: PdfResolvedBacklink[] = []
  for (const backlink of backlinks) {
    const resolution = resolveSelectionBySourceText(pageText, items, backlink.location.selection, backlink.sourceText)
    if (resolution.selection === undefined) {
      continue
    }

    resolved.push({
      backlink,
      selection: resolution.selection,
      fallback: resolution.method === 'fallback',
      highlightName: backlinkHighlightName(backlink.color)
    })
  }

  return resolved
}

/**
 * The CSS highlight registry, or null where the Custom Highlight API is
 * missing (e.g. in tests)
 */
function highlightRegistry (): HighlightRegistry|null {
  if (typeof CSS === 'undefined' || CSS.highlights === undefined) {
    return null
  }

  return CSS.highlights
}

/**
 * What PdfBacklinkHighlights needs from its viewer
 */
export interface PdfBacklinkHighlightsOptions {
  /**
   * Returns the text items of a page (toPdfTextItems of its text content).
   * Called at most once per page while the reading succeeds.
   */
  textItemsOfPage: (pageNumber: number) => Promise<PdfTextItem[]>
  /**
   * Returns the pdf.js PDFPageView of a page (PDFViewer.getPageView with the
   * page index, i.e. pageNumber - 1), or undefined
   */
  getPageView: (pageNumber: number) => unknown
}

interface RegisteredRange {
  range: Range
  resolved: PdfResolvedBacklink
}

/**
 * The backlink highlights of one viewer for one open PDF. Create one per
 * opened document and call clear() when the document is closed.
 */
export class PdfBacklinkHighlights {
  private readonly options: PdfBacklinkHighlightsOptions
  private backlinksByPage = new Map<number, PdfBacklink[]>()
  private readonly textItemsByPage = new Map<number, Promise<PdfTextItem[]>>()
  private resolvedByPage = new Map<number, PdfResolvedBacklink[]>()
  private resolvingByPage = new Map<number, Promise<PdfResolvedBacklink[]>>()
  private rangesByPage = new Map<number, RegisteredRange[]>()
  private visible = true
  /**
   * Increased whenever the backlinks change or everything is cleared, so that
   * a page whose text arrives afterwards is not registered with stale data
   */
  private generation = 0

  constructor (options: PdfBacklinkHighlightsOptions) {
    this.options = options
  }

  /**
   * Number of backlinks that can be highlighted (those with a selection)
   */
  get highlightableCount (): number {
    let count = 0
    for (const backlinks of this.backlinksByPage.values()) {
      count += backlinks.length
    }
    return count
  }

  /**
   * Whether the highlights are shown
   */
  get isVisible (): boolean {
    return this.visible
  }

  /**
   * Number of ranges currently registered, over all pages
   */
  get registeredRangeCount (): number {
    let count = 0
    for (const ranges of this.rangesByPage.values()) {
      count += ranges.length
    }
    return count
  }

  /**
   * Replaces the backlinks of the PDF (the answer of get-pdf-backlinks) and
   * rebuilds every page whose text layer is shown. Backlinks without a
   * selection are dropped. Text items read before are kept.
   *
   * @param   {PdfBacklink[]}  backlinks  All backlinks of the PDF
   *
   * @return  {Promise<void>}             Settles when the shown pages are done
   */
  async setBacklinks (backlinks: PdfBacklink[]): Promise<void> {
    this.removeAllRanges()
    this.generation++
    this.resolvedByPage = new Map()
    this.resolvingByPage = new Map()
    this.backlinksByPage = new Map()

    for (const backlink of backlinks) {
      if (backlink.location.selection === undefined) {
        continue
      }

      const page = backlink.location.page
      const pageBacklinks = this.backlinksByPage.get(page)
      if (pageBacklinks === undefined) {
        this.backlinksByPage.set(page, [backlink])
      } else {
        pageBacklinks.push(backlink)
      }
    }

    await this.rebuildAllRendered()
  }

  /**
   * Rebuilds the ranges of one page, e.g. after textlayerrendered. A page
   * whose text layer is missing or hidden gets no ranges until it is drawn
   * again. If the page's text has not been read yet, it is read first and
   * the ranges are built over the text layer the page has by then.
   *
   * @param   {number}              pageNumber  The page, from 1
   * @param   {HTMLElement[]|null}  textDivs    Its text layer elements in item
   *                                            order (getPageTextDivs)
   * @param   {unknown}             pageView    Its PDFPageView
   *
   * @return  {Promise<void>}                   Settles when the page is done
   */
  async rebuildPage (pageNumber: number, textDivs: HTMLElement[]|null, pageView: unknown): Promise<void> {
    this.removePageRanges(pageNumber)
    if (!this.visible || !this.backlinksByPage.has(pageNumber)) {
      return
    }

    if (textDivs === null || !isPageTextLayerShown(pageView)) {
      return
    }

    const resolved = this.resolvedByPage.get(pageNumber)
    if (resolved !== undefined) {
      this.registerPage(pageNumber, textDivs, resolved)
      return
    }

    const generation = this.generation
    let resolvedNow: PdfResolvedBacklink[]
    try {
      resolvedNow = await this.resolvePage(pageNumber)
    } catch (error: unknown) {
      console.error(`Could not read the text of page ${pageNumber} for the backlink highlights`, error)
      return
    }

    if (generation !== this.generation || !this.visible) {
      return
    }

    // The text layer may have been redrawn while the text was read
    const currentView = this.options.getPageView(pageNumber)
    const currentDivs = getPageTextDivs(currentView)
    this.removePageRanges(pageNumber)
    if (currentDivs === null || !isPageTextLayerShown(currentView)) {
      return
    }

    this.registerPage(pageNumber, currentDivs, resolvedNow)
  }

  /**
   * Rebuilds every page that has backlinks and a shown text layer, e.g. after
   * updatetextlayermatches or when the highlights are switched on
   *
   * @return  {Promise<void>}  Settles when all those pages are done
   */
  async rebuildAllRendered (): Promise<void> {
    const rebuilds: Array<Promise<void>> = []
    for (const pageNumber of this.backlinksByPage.keys()) {
      const pageView = this.options.getPageView(pageNumber)
      rebuilds.push(this.rebuildPage(pageNumber, getPageTextDivs(pageView), pageView))
    }
    await Promise.all(rebuilds)
  }

  /**
   * Shows or hides all backlink highlights. While hidden, nothing is
   * registered and hitTest finds nothing; the backlinks are kept.
   *
   * @param   {boolean}  visible  Whether to show them
   *
   * @return  {Promise<void>}     Settles when the shown pages are done
   */
  async setVisible (visible: boolean): Promise<void> {
    if (visible === this.visible) {
      return
    }

    this.visible = visible
    if (!visible) {
      this.removeAllRanges()
      return
    }

    await this.rebuildAllRendered()
  }

  /**
   * Removes all ranges and forgets the backlinks and the text read, e.g. when
   * the viewer switches to another file or is unmounted
   */
  clear (): void {
    this.removeAllRanges()
    this.generation++
    this.backlinksByPage = new Map()
    this.resolvedByPage = new Map()
    this.resolvingByPage = new Map()
    this.textItemsByPage.clear()
  }

  /**
   * Finds the backlinks whose registered ranges lie under a point
   *
   * @param   {number}            clientX     The point's clientX
   * @param   {number}            clientY     The point's clientY
   * @param   {number|undefined}  pageNumber  Only look at this page, if given
   *                                          (the page under the mouse)
   *
   * @return  {PdfBacklinkHit[]}              The hits, ordered by note path
   *                                          and line, one per line of a note
   */
  hitTest (clientX: number, clientY: number, pageNumber?: number): PdfBacklinkHit[] {
    if (!this.visible) {
      return []
    }

    const hits: PdfBacklinkHit[] = []
    for (const [ page, ranges ] of this.rangesByPage) {
      if (pageNumber !== undefined && page !== pageNumber) {
        continue
      }

      for (const { range, resolved } of ranges) {
        if (rectsContainPoint(range.getClientRects(), clientX, clientY)) {
          hits.push({ backlink: resolved.backlink, fallback: resolved.fallback })
        }
      }
    }

    return sortAndDeduplicateHits(hits)
  }

  /**
   * Reads the text items of a page once; a failed reading is forgotten, so
   * that the next rebuild tries again
   */
  private async readTextItems (pageNumber: number): Promise<PdfTextItem[]> {
    let reading = this.textItemsByPage.get(pageNumber)
    if (reading === undefined) {
      const started = this.options.textItemsOfPage(pageNumber)
      this.textItemsByPage.set(pageNumber, started)
      started.catch(() => {
        if (this.textItemsByPage.get(pageNumber) === started) {
          this.textItemsByPage.delete(pageNumber)
        }
      })
      reading = started
    }

    return await reading
  }

  /**
   * Checks the backlinks of a page against their quoted texts, once per
   * generation
   */
  private async resolvePage (pageNumber: number): Promise<PdfResolvedBacklink[]> {
    let resolving = this.resolvingByPage.get(pageNumber)
    if (resolving === undefined) {
      const backlinks = this.backlinksByPage.get(pageNumber) ?? []
      const generation = this.generation
      const resolvingMap = this.resolvingByPage
      const started = this.readTextItems(pageNumber).then(items => resolvePageBacklinks(items, backlinks))
      resolvingMap.set(pageNumber, started)
      started.then(resolved => {
        if (generation === this.generation) {
          this.resolvedByPage.set(pageNumber, resolved)
        }
      }, () => {
        if (resolvingMap.get(pageNumber) === started) {
          resolvingMap.delete(pageNumber)
        }
      })
      resolving = started
    }

    return await resolving
  }

  /**
   * Builds and registers the ranges of a page
   */
  private registerPage (pageNumber: number, textDivs: HTMLElement[], resolved: PdfResolvedBacklink[]): void {
    const registry = highlightRegistry()
    const registered: RegisteredRange[] = []

    for (const entry of resolved) {
      const range = buildSelectionRange(textDivs, entry.selection)
      if (range === null) {
        continue
      }

      if (registry !== null) {
        ensureBacklinkHighlightStyles(range.startContainer.ownerDocument ?? document)
        let highlight = registry.get(entry.highlightName)
        if (highlight === undefined) {
          highlight = new Highlight()
          highlight.priority = PDF_BACKLINK_HIGHLIGHT_PRIORITY
          registry.set(entry.highlightName, highlight)
        }
        highlight.add(range)
      }

      registered.push({ range, resolved: entry })
    }

    if (registered.length > 0) {
      this.rangesByPage.set(pageNumber, registered)
    }
  }

  /**
   * Removes the ranges of a page from the highlights; a highlight left
   * without ranges is removed from the registry
   */
  private removePageRanges (pageNumber: number): void {
    const ranges = this.rangesByPage.get(pageNumber)
    if (ranges === undefined) {
      return
    }

    this.rangesByPage.delete(pageNumber)
    const registry = highlightRegistry()
    if (registry === null) {
      return
    }

    for (const { range, resolved } of ranges) {
      const highlight = registry.get(resolved.highlightName)
      if (highlight === undefined) {
        continue
      }

      highlight.delete(range)
      if (highlight.size === 0) {
        registry.delete(resolved.highlightName)
      }
    }
  }

  /**
   * Removes the ranges of every page
   */
  private removeAllRanges (): void {
    for (const pageNumber of [...this.rangesByPage.keys()]) {
      this.removePageRanges(pageNumber)
    }
  }
}
