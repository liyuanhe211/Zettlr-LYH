/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Copy as Quote of the PDF viewer
 * CVM-Role:        Utility Function
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH R60 (contract C5, section "引用格式"): turns the
 *                  text selected in the PDF viewer into a quote in PDF++'s
 *                  "Quote in callout" format.
 *
 *                  resolvePdfQuoteSelection converts a DOM Range into a page
 *                  and a PdfTextSelection through the text layer's textDivs
 *                  (whose indices are the item numbers of contract C5); the
 *                  viewer hands its pages over through the small
 *                  PdfQuotePageSource interface. Like PDF++ 0.40.28
 *                  (getTextSelectionRange of its main.js), a selection that
 *                  spans pages yields no quote. Unlike PDF++, a boundary that
 *                  lies between text layer elements (in the gap beside a
 *                  line, below the last line, or in pdf.js' endOfContent
 *                  element) moves to the nearest text inside the selection
 *                  instead of discarding the selection.
 *
 *                  buildPdfQuote writes the quote from the page's text items,
 *                  the page label and the color: the link target is the
 *                  absolute path with `/` as separator, encoded like PDF++
 *                  does it; pasting into a note turns it into a relative path
 *                  (markdown-editor/util/pdf-quote-paste.ts).
 *
 *                  The settings of the quote controls (color and Auto-copy)
 *                  are kept in localStorage through readPdfQuoteSettings and
 *                  writePdfQuoteSettings. Imports neither Vue nor pdf.js, so
 *                  mocha tests it directly (with jsdom's DOM).
 *
 * END HEADER
 */

import {
  PDF_QUOTE_COLOR_NAMES,
  type PdfLocation,
  type PdfTextPosition,
  type PdfTextSelection
} from 'source/types/common/pdf-viewer'
import {
  formatPdfDisplayText,
  formatPdfLinkTarget,
  formatPdfQuote,
  selectionText,
  toQuoteText,
  type PdfTextItem
} from 'source/common/modules/pdf-text'

/**
 * localStorage key under which the quote controls keep their settings
 */
export const PDF_QUOTE_SETTINGS_STORAGE_KEY = 'zettlr-lyh-pdf-quote-settings'

/**
 * Name of the window event every PdfQuoteControls dispatches after the user
 * has changed a setting, so that the controls of other viewers in the same
 * window follow. Its detail is the new PdfQuoteSettings.
 */
export const PDF_QUOTE_SETTINGS_EVENT = 'zettlr-lyh-pdf-quote-settings-changed'

/**
 * Node.ELEMENT_NODE
 */
const ELEMENT_NODE = 1

/**
 * The settings of the quote controls
 */
export interface PdfQuoteSettings {
  /**
   * One of PDF_QUOTE_COLOR_NAMES
   */
  color: string
  /**
   * Whether releasing the mouse after selecting text copies it as a quote
   */
  autoCopy: boolean
}

/**
 * The part of the Web Storage interface the settings functions use;
 * localStorage satisfies it, tests pass an in-memory stand-in
 */
export type PdfQuoteSettingsStorage = Pick<Storage, 'getItem'|'setItem'>

/**
 * What resolvePdfQuoteSelection needs to know about the pages of a viewer
 */
export interface PdfQuotePageSource {
  /**
   * The number (from 1) of the page of this viewer that contains the node,
   * or null if the node is in none of its pages (findPageNumberOfNode)
   */
  pageNumberOfNode: (node: Node) => number|null
  /**
   * The text layer elements of a page in item order (getPageTextDivs of
   * location-highlight.ts), or null while the page has no rendered text
   * layer or does not exist
   */
  textDivsOfPage: (pageNumber: number) => readonly Node[]|null
}

/**
 * The outcome of resolvePdfQuoteSelection:
 *
 * - `selected`: the range covers text on one page;
 * - `empty`: there is no range, it is collapsed, or it covers no text;
 * - `outside`: the range lies in none of the viewer's pages;
 * - `multiple-pages`: the range spans pages (PDF++ copies nothing then);
 * - `no-text-layer`: the page's text layer has not been rendered.
 */
export type PdfQuoteSelectionResult =
  { status: 'selected', page: number, selection: PdfTextSelection } |
  { status: 'empty' } |
  { status: 'outside' } |
  { status: 'multiple-pages' } |
  { status: 'no-text-layer', page: number }

/**
 * What buildPdfQuote needs
 */
export interface PdfQuoteInput {
  /**
   * The absolute path of the PDF, with either separator
   */
  filePath: string
  /**
   * The page, from 1
   */
  page: number
  /**
   * The page label pdf.js reports for the page (getPageLabels), or
   * null/undefined if the PDF defines none
   */
  pageLabel?: string|null
  /**
   * The selected range on the page
   */
  selection: PdfTextSelection
  /**
   * The text items of the page (toPdfTextItems of getTextContent)
   */
  items: PdfTextItem[]
  /**
   * The color name; an empty string writes `[!PDF|]` and no `&color=`
   */
  color: string
}

/**
 * A quote and its parts
 */
export interface PdfQuote {
  /**
   * The complete quote in PDF++'s "Quote in callout" format, for text/plain
   */
  quote: string
  /**
   * The selected text as it is in the PDF, line breaks included
   * (selectionText)
   */
  plainText: string
  /**
   * The selected text on one line, as it appears in the quote (toQuoteText)
   */
  quoteText: string
  /**
   * The link text, e.g. 《Ekins 2021, UV-adVISor》P8
   */
  displayText: string
  /**
   * The link target: encoded absolute path, `#` and fragment
   */
  linkTarget: string
  /**
   * The location the link names
   */
  location: PdfLocation
}

/**
 * The document side of quoteFromSelection
 */
export interface PdfQuoteDocument {
  /**
   * The absolute path of the PDF
   */
  filePath: string
  /**
   * Resolves with the text items of a page (toPdfTextItems of
   * getTextContent with PDF_TEXT_CONTENT_OPTIONS)
   */
  textItemsOfPage: (pageNumber: number) => Promise<PdfTextItem[]>
  /**
   * The page label of a page, or null/undefined if the PDF defines none
   */
  pageLabelOfPage: (pageNumber: number) => string|null|undefined
}

/**
 * The outcome of quoteFromSelection: the quote, or why there is none.
 * `no-text` means the range covers only whitespace.
 */
export type PdfQuoteResult =
  { status: 'quoted', quote: PdfQuote } |
  { status: 'no-text' } |
  Exclude<PdfQuoteSelectionResult, { status: 'selected' }>

/**
 * @return  {PdfQuoteSettings}  Yellow and Auto-copy on
 */
export function defaultPdfQuoteSettings (): PdfQuoteSettings {
  return { color: PDF_QUOTE_COLOR_NAMES[0], autoCopy: true }
}

/**
 * Returns the color name if it is one of PDF_QUOTE_COLOR_NAMES (in any case),
 * otherwise the default color
 *
 * @param   {unknown}  value  Any value, e.g. a stored color
 *
 * @return  {string}          A color name of PDF_QUOTE_COLOR_NAMES
 */
export function normalizePdfQuoteColor (value: unknown): string {
  if (typeof value === 'string') {
    const color = value.trim().toLowerCase()
    if (PDF_QUOTE_COLOR_NAMES.includes(color)) {
      return color
    }
  }

  return PDF_QUOTE_COLOR_NAMES[0]
}

/**
 * Reads the settings of the quote controls. Missing, broken or unreadable
 * storage contents never throw; every missing or invalid field takes its
 * default.
 *
 * @param   {PdfQuoteSettingsStorage|null|undefined}  storage  E.g. window.localStorage
 *
 * @return  {PdfQuoteSettings}                                 The settings
 */
export function readPdfQuoteSettings (storage: PdfQuoteSettingsStorage|null|undefined): PdfQuoteSettings {
  const settings = defaultPdfQuoteSettings()
  if (storage === null || storage === undefined) {
    return settings
  }

  let stored: unknown
  try {
    const raw = storage.getItem(PDF_QUOTE_SETTINGS_STORAGE_KEY)
    if (raw === null) {
      return settings
    }
    stored = JSON.parse(raw)
  } catch {
    return settings
  }

  if (typeof stored !== 'object' || stored === null) {
    return settings
  }

  const { color, autoCopy } = stored as Record<string, unknown>
  settings.color = normalizePdfQuoteColor(color)
  if (typeof autoCopy === 'boolean') {
    settings.autoCopy = autoCopy
  }
  return settings
}

/**
 * Stores the settings of the quote controls
 *
 * @param   {PdfQuoteSettingsStorage|null|undefined}  storage   E.g. window.localStorage
 * @param   {PdfQuoteSettings}                        settings  The settings
 *
 * @return  {boolean}                                           False if they could not be stored
 */
export function writePdfQuoteSettings (storage: PdfQuoteSettingsStorage|null|undefined, settings: PdfQuoteSettings): boolean {
  if (storage === null || storage === undefined) {
    return false
  }

  const record: PdfQuoteSettings = {
    color: normalizePdfQuoteColor(settings.color),
    autoCopy: settings.autoCopy
  }

  try {
    storage.setItem(PDF_QUOTE_SETTINGS_STORAGE_KEY, JSON.stringify(record))
    return true
  } catch {
    return false
  }
}

/**
 * Returns the number of the pdf.js page that contains a node: the
 * `data-page-number` of the closest `.page` element, provided that element
 * lies inside the container (the viewer's pages area)
 *
 * @param   {Node}         node       Any node, e.g. a range boundary
 * @param   {Node}         container  The element all pages of the viewer are in
 *
 * @return  {number|null}             The page number, or null
 */
export function findPageNumberOfNode (node: Node, container: Node): number|null {
  if (!container.contains(node)) {
    return null
  }

  const element = node.nodeType === ELEMENT_NODE ? node as Element : node.parentElement
  const pageElement = element?.closest('.page[data-page-number]') ?? null
  if (pageElement === null || !container.contains(pageElement)) {
    return null
  }

  const pageNumber = Number(pageElement.getAttribute('data-page-number'))
  return Number.isInteger(pageNumber) && pageNumber >= 1 ? pageNumber : null
}

/**
 * @return  {number}  Negative if a lies before b, 0 if they are equal, positive otherwise
 */
function comparePositions (a: PdfTextPosition, b: PdfTextPosition): number {
  return a.index !== b.index ? a.index - b.index : a.offset - b.offset
}

/**
 * @return  {Document}  The document a node belongs to
 */
function documentOf (node: Node): Document {
  return node.ownerDocument ?? (node as Document)
}

/**
 * Converts one boundary point of a range into a position on the page.
 *
 * A boundary inside a text layer element yields that element's index and the
 * number of characters of the element before the boundary (the element may
 * contain several text nodes, e.g. after pdf.js' find highlighting). A
 * boundary between elements moves, for the `start` bias, to the start of the
 * first element after it, and, for the `end` bias, to the end of the last
 * element before it. Elements that are not in the page (pdf.js never inserts
 * those of empty items) are skipped.
 *
 * @param   {Node}             node       The boundary's container
 * @param   {number}           offset     The boundary's offset
 * @param   {readonly Node[]}  textDivs   The page's text layer elements in item order
 * @param   {Map<Node, number>} indices   The index of every element of textDivs
 * @param   {'start'|'end'}    bias       `start` for the range's start, `end` for its end
 *
 * @return  {PdfTextPosition|null}        The position, or null if no text lies
 *                                        on the boundary's side
 */
function boundaryToPosition (node: Node, offset: number, textDivs: readonly Node[], indices: Map<Node, number>, bias: 'start'|'end'): PdfTextPosition|null {
  for (let current: Node|null = node; current !== null; current = current.parentNode) {
    const index = indices.get(current)
    if (index !== undefined) {
      const measure = documentOf(current).createRange()
      measure.setStart(current, 0)
      measure.setEnd(node, offset)
      return { index, offset: measure.toString().length }
    }
  }

  const root = node.getRootNode()
  const probe = documentOf(node).createRange()
  probe.setStart(node, offset)

  if (bias === 'start') {
    for (let index = 0; index < textDivs.length; index++) {
      const element = textDivs[index]
      if (element.getRootNode() === root && probe.comparePoint(element, 0) >= 0) {
        return { index, offset: 0 }
      }
    }
    return null
  }

  for (let index = textDivs.length - 1; index >= 0; index--) {
    const element = textDivs[index]
    if (element.getRootNode() === root && probe.comparePoint(element, element.childNodes.length) <= 0) {
      return { index, offset: element.textContent?.length ?? 0 }
    }
  }
  return null
}

/**
 * Whether the range covers text of a page next to the one it was attributed
 * to: the last element of the previous page, or the first element of the
 * next page, that is in the page
 *
 * @param   {Range}               range       The range
 * @param   {PdfQuotePageSource}  pages       The pages of the viewer
 * @param   {number}              pageNumber  The neighboring page
 * @param   {'first'|'last'}      which       Which of its elements to test
 *
 * @return  {boolean}                         True if the range covers it
 */
function rangeReachesPage (range: Range, pages: PdfQuotePageSource, pageNumber: number, which: 'first'|'last'): boolean {
  if (pageNumber < 1) {
    return false
  }

  const textDivs = pages.textDivsOfPage(pageNumber)
  if (textDivs === null) {
    return false
  }

  const root = range.startContainer.getRootNode()
  const elements = which === 'first' ? textDivs : [...textDivs].reverse()
  const element = elements.find(candidate => candidate.getRootNode() === root)
  return element !== undefined && range.intersectsNode(element)
}

/**
 * Converts a DOM Range in the viewer (usually the first range of
 * window.getSelection()) into a page and a PdfTextSelection.
 *
 * The page is the one that contains the range's start or, if the start lies
 * outside every page (e.g. in the gap between two pages), its end. A range
 * whose start and end lie on different pages, or that reaches into the text
 * of the page before or after, spans pages and yields `multiple-pages`, as
 * PDF++ copies nothing then.
 *
 * @param   {Range|null}          range  The range, or null if there is none
 * @param   {PdfQuotePageSource}  pages  The pages of the viewer
 *
 * @return  {PdfQuoteSelectionResult}    The page and selection, or why there is none
 */
export function resolvePdfQuoteSelection (range: Range|null, pages: PdfQuotePageSource): PdfQuoteSelectionResult {
  if (range === null || range.collapsed) {
    return { status: 'empty' }
  }

  const startPage = pages.pageNumberOfNode(range.startContainer)
  const endPage = pages.pageNumberOfNode(range.endContainer)
  if (startPage === null && endPage === null) {
    return { status: 'outside' }
  }

  if (startPage !== null && endPage !== null && startPage !== endPage) {
    return { status: 'multiple-pages' }
  }

  const page = startPage !== null ? startPage : endPage as number
  if (startPage === null && rangeReachesPage(range, pages, page - 1, 'last')) {
    return { status: 'multiple-pages' }
  }

  if (endPage === null && rangeReachesPage(range, pages, page + 1, 'first')) {
    return { status: 'multiple-pages' }
  }

  const textDivs = pages.textDivsOfPage(page)
  if (textDivs === null) {
    return { status: 'no-text-layer', page }
  }

  const indices = new Map<Node, number>()
  textDivs.forEach((element, index) => indices.set(element, index))

  const begin = boundaryToPosition(range.startContainer, range.startOffset, textDivs, indices, 'start')
  const end = boundaryToPosition(range.endContainer, range.endOffset, textDivs, indices, 'end')
  if (begin === null || end === null || comparePositions(begin, end) >= 0) {
    return { status: 'empty' }
  }

  return {
    status: 'selected',
    page,
    selection: {
      beginIndex: begin.index,
      beginOffset: begin.offset,
      endIndex: end.index,
      endOffset: end.offset
    }
  }
}

/**
 * Turns a file path into a link path: every backslash becomes `/`
 *
 * @param   {string}  filePath  An absolute path, e.g. E:\Literature\a b.pdf
 *
 * @return  {string}            The path with `/`, e.g. E:/Literature/a b.pdf
 */
export function toPdfLinkPath (filePath: string): string {
  return filePath.replace(/\\/g, '/')
}

/**
 * Returns the file name of a path without its extension, like Obsidian's
 * `file.basename` that PDF++ writes into the link text
 *
 * @param   {string}  filePath  A path with either separator
 *
 * @return  {string}            The file name without the last extension
 */
export function pdfFileBasename (filePath: string): string {
  const name = filePath.slice(Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/**
 * Returns the page label written into the link text: the label the PDF
 * defines for the page, or the decimal page number if it defines none (or
 * an empty one)
 *
 * @param   {string|null|undefined}  pageLabel  The label pdf.js reports
 * @param   {number}                 page       The page number
 *
 * @return  {string}                            The label to write
 */
export function pdfQuotePageLabel (pageLabel: string|null|undefined, page: number): string {
  return typeof pageLabel === 'string' && pageLabel.trim() !== '' ? pageLabel : String(page)
}

/**
 * Writes the quote of a selection in PDF++'s "Quote in callout" format, with
 * the absolute path of the PDF as link target.
 *
 * @param   {PdfQuoteInput}  input  File, page, label, selection, items and color
 *
 * @return  {PdfQuote|null}         The quote and its parts, or null if the
 *                                  selection covers only whitespace
 */
export function buildPdfQuote (input: PdfQuoteInput): PdfQuote|null {
  const plainText = selectionText(input.items, input.selection)
  const quoteText = toQuoteText(plainText)
  if (quoteText.trim() === '') {
    return null
  }

  const color = input.color.trim().toLowerCase()
  const location: PdfLocation = { page: input.page, selection: { ...input.selection } }
  if (color !== '') {
    location.color = color
  }

  const linkTarget = formatPdfLinkTarget(toPdfLinkPath(input.filePath), location)
  const displayText = formatPdfDisplayText(pdfFileBasename(input.filePath), pdfQuotePageLabel(input.pageLabel, input.page))
  const quote = formatPdfQuote({ linkTarget, displayText, text: quoteText, color })
  return { quote, plainText, quoteText, displayText, linkTarget, location }
}

/**
 * Resolves a range and writes its quote. The range is converted before the
 * first await, so the caller may pass the live selection's range; the
 * page's text items are then read asynchronously.
 *
 * @param   {Range|null}          range        The range, e.g. getSelection().getRangeAt(0)
 * @param   {PdfQuotePageSource}  pages        The pages of the viewer
 * @param   {PdfQuoteDocument}    pdfDocument  Path, text items and page labels of the PDF
 * @param   {string}              color        The color name
 *
 * @return  {Promise<PdfQuoteResult>}          The quote, or why there is none
 */
export async function quoteFromSelection (range: Range|null, pages: PdfQuotePageSource, pdfDocument: PdfQuoteDocument, color: string): Promise<PdfQuoteResult> {
  const resolved = resolvePdfQuoteSelection(range, pages)
  if (resolved.status !== 'selected') {
    return resolved
  }

  const items = await pdfDocument.textItemsOfPage(resolved.page)
  const quote = buildPdfQuote({
    filePath: pdfDocument.filePath,
    page: resolved.page,
    pageLabel: pdfDocument.pageLabelOfPage(resolved.page),
    selection: resolved.selection,
    items,
    color
  })

  return quote === null ? { status: 'no-text' } : { status: 'quoted', quote }
}

/**
 * Writes a quote to the clipboard as text/plain
 *
 * @param   {PdfQuote}                     quote      The quote
 * @param   {Pick<Clipboard, 'writeText'>} clipboard  The clipboard, navigator.clipboard by default
 *
 * @return  {Promise<void>}                           Resolves once written
 */
export async function writePdfQuoteToClipboard (quote: PdfQuote, clipboard: Pick<Clipboard, 'writeText'> = navigator.clipboard): Promise<void> {
  await clipboard.writeText(quote.quote)
}
