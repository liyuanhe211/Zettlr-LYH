/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Location requests of the PDF viewer
 * CVM-Role:        Utility function
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH R59 / R60 (contract C5, section "定位请求"):
 *                  the parts of answering a pdfViewerRequest that need
 *                  neither Vue nor pdf.js, so that mocha tests them directly.
 *
 *                  - Checking the shape of a request (parsePdfViewerRequest)
 *                    and of its selection (isValidPdfSelection).
 *                  - Requests that arrive too early: the editor opens the PDF
 *                    of a clicked link and sends the request right away, often
 *                    before the viewer of the new tab is mounted or has loaded
 *                    the document. App.vue therefore also keeps the most recent
 *                    request as a PdfViewerRequestRecord; a viewer that has
 *                    finished loading carries it out once if it is meant for
 *                    its file, at most PDF_VIEWER_REQUEST_REPLAY_WINDOW
 *                    milliseconds old and not carried out by any viewer yet
 *                    (shouldReplayPdfViewerRequest). Which records have been
 *                    carried out is kept per window in a WeakSet, so that a
 *                    viewer mounted later does not repeat them.
 *                  - Decision 071: before highlighting a selection that comes
 *                    with the quoted text below the link, the page's text is
 *                    read and resolveSelectionBySourceText decides whether the
 *                    selection or a single occurrence of the quoted text on the
 *                    page is highlighted (resolveRequestedSelection).
 *
 * END HEADER
 */

import {
  PDF_TEXT_CONTENT_OPTIONS,
  type PdfLocation,
  type PdfTextSelection,
  type PdfViewerRequest
} from 'source/types/common/pdf-viewer'
import {
  buildPdfPageText,
  resolveSelectionBySourceText,
  toPdfTextItems,
  type PdfTextContentItem,
  type SourceTextResolution
} from 'source/common/modules/pdf-text'

/**
 * Milliseconds after it was sent during which a request that no viewer has
 * carried out yet is still carried out by a viewer that finishes loading its
 * file. Generous enough for large PDFs, short enough that opening the file
 * again later does not jump to an old location.
 */
export const PDF_VIEWER_REQUEST_REPLAY_WINDOW = 10000

/**
 * The most recent location request, as App.vue keeps it in the editor
 * commands (`lastPdfViewerRequest`)
 */
export interface PdfViewerRequestRecord {
  request: PdfViewerRequest
  // Counts the requests sent since the window was loaded, from 1
  sequence: number
  // Date.now() at the time the request was sent
  time: number
}

/**
 * What shouldReplayPdfViewerRequest compares a record with
 */
export interface PdfViewerReplayCheck {
  // The file the viewer has just loaded
  filePath: string
  // Date.now() at the time of the check
  now: number
  // Whether a viewer has already carried out the record
  alreadyHandled: boolean
  // Compare paths without regard to case (Windows and macOS)
  ignoreCase?: boolean
  // Defaults to PDF_VIEWER_REQUEST_REPLAY_WINDOW
  maximumAge?: number
}

/**
 * The part of a pdf.js PDFDocumentProxy that resolveRequestedSelection needs;
 * tests use a stand-in object
 */
export interface PdfPageTextReader {
  getPage (pageNumber: number): Promise<{
    getTextContent (options: object): Promise<{ items: PdfTextContentItem[] }>
  }>
}

/**
 * Checks the shape of the data of a pdfViewerRequest editor command. A
 * `scroll` other than false counts as true (left out); a `sourceText` that is
 * not a string is left out.
 *
 * @param   {unknown}                  data  The editor commands' data
 *
 * @return  {PdfViewerRequest|null}          The request, or null if the data
 *                                           is not a request
 */
export function parsePdfViewerRequest (data: unknown): PdfViewerRequest|null {
  if (typeof data !== 'object' || data === null) {
    return null
  }

  const { filePath, location, scroll, sourceText } = data as Record<string, unknown>
  if (typeof filePath !== 'string') {
    return null
  }

  if (location !== null && (typeof location !== 'object' || typeof (location as Record<string, unknown>).page !== 'number')) {
    return null
  }

  const request: PdfViewerRequest = {
    filePath,
    location: location as PdfLocation|null,
    scroll: scroll === false ? false : undefined
  }

  if (typeof sourceText === 'string') {
    request.sourceText = sourceText
  }

  return request
}

/**
 * Whether a value is a selection of four non-negative integers
 *
 * @param   {unknown}  selection  The selection of a location
 *
 * @return  {boolean}             True if it can be highlighted
 */
export function isValidPdfSelection (selection: unknown): selection is PdfTextSelection {
  if (typeof selection !== 'object' || selection === null) {
    return false
  }

  const { beginIndex, beginOffset, endIndex, endOffset } = selection as Record<string, unknown>
  return [ beginIndex, beginOffset, endIndex, endOffset ].every(value => {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0
  })
}

/**
 * Whether a source text contains anything to look for
 *
 * @param   {string|undefined}  sourceText  The quoted text of a request
 *
 * @return  {boolean}                       True unless it is missing or blank
 */
export function hasPdfSourceText (sourceText: string|undefined): sourceText is string {
  return typeof sourceText === 'string' && sourceText.trim() !== ''
}

/**
 * Whether two paths name the same file: backslashes count as slashes, and
 * with `ignoreCase` the case of letters does not matter.
 *
 * @param   {string}   first       A path
 * @param   {string}   second      Another path
 * @param   {boolean}  ignoreCase  True on case-insensitive file systems
 *
 * @return  {boolean}              True if they are the same
 */
export function isSamePdfFilePath (first: string, second: string, ignoreCase: boolean): boolean {
  const normalize = (path: string): string => {
    const forward = path.replace(/\\/g, '/')
    return ignoreCase ? forward.toLowerCase() : forward
  }
  return normalize(first) === normalize(second)
}

/**
 * Decides whether a viewer that has just loaded a file carries out the most
 * recent request: only if no viewer has carried it out yet, it names a
 * location (a request that only removes the highlight is never repeated), it
 * is meant for this file, and it was sent at most `maximumAge` milliseconds
 * ago (and not in the future, should the clock have been set back).
 *
 * @param   {PdfViewerRequestRecord|null|undefined}  record  The most recent request, if any
 * @param   {PdfViewerReplayCheck}                   check   The viewer's file, the time and whether it was carried out
 *
 * @return  {boolean}                                        True if the viewer should carry it out now
 */
export function shouldReplayPdfViewerRequest (record: PdfViewerRequestRecord|null|undefined, check: PdfViewerReplayCheck): boolean {
  if (record === null || record === undefined || check.alreadyHandled) {
    return false
  }

  const request = parsePdfViewerRequest(record.request)
  if (request === null || request.location === null) {
    return false
  }

  if (!isSamePdfFilePath(request.filePath, check.filePath, check.ignoreCase === true)) {
    return false
  }

  const age = check.now - record.time
  const maximumAge = check.maximumAge ?? PDF_VIEWER_REQUEST_REPLAY_WINDOW
  return Number.isFinite(age) && age >= 0 && age <= maximumAge
}

// The records some viewer of this window has carried out. A WeakSet keyed by
// the record object (not its sequence number) stays correct when App.vue is
// reloaded and starts counting from 1 again.
const handledRecords = new WeakSet<object>()

/**
 * Remembers that a viewer has carried out a record (pass the raw object, not
 * a Vue proxy of it)
 *
 * @param   {object}  record  The record
 */
export function markPdfViewerRequestHandled (record: object): void {
  handledRecords.add(record)
}

/**
 * Whether a viewer has carried out a record (pass the raw object)
 *
 * @param   {object}   record  The record
 *
 * @return  {boolean}          True if it has been carried out
 */
export function isPdfViewerRequestHandled (record: object): boolean {
  return handledRecords.has(record)
}

/**
 * Decides which range of a page to highlight for a request (decision 071).
 * Without a selection or without a source text, the page's text is not read
 * and the selection is used as it is (method `index`). Otherwise the page's
 * text content is read the way the text layer reads it and handed to
 * resolveSelectionBySourceText. Errors while reading reject the promise.
 *
 * @param   {PdfPageTextReader}           reader      The document, e.g. a pdf.js PDFDocumentProxy
 * @param   {number}                      pageNumber  The page, from 1
 * @param   {PdfTextSelection|undefined}  selection   The request's selection, if any
 * @param   {string|undefined}            sourceText  The request's quoted text, if any
 *
 * @return  {Promise<SourceTextResolution>}           The selection to highlight and how it was found
 */
export async function resolveRequestedSelection (
  reader: PdfPageTextReader,
  pageNumber: number,
  selection: PdfTextSelection|undefined,
  sourceText: string|undefined
): Promise<SourceTextResolution> {
  if (selection === undefined || !hasPdfSourceText(sourceText)) {
    return { selection, method: 'index' }
  }

  const page = await reader.getPage(pageNumber)
  const content = await page.getTextContent(PDF_TEXT_CONTENT_OPTIONS)
  const items = toPdfTextItems(content.items)
  return resolveSelectionBySourceText(buildPdfPageText(items), items, selection, sourceText)
}
