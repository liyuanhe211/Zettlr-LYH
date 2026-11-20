/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Text positions inside PDF pages
 * CVM-Role:        Utility Function
 * License:         GNU GPL v3
 *
 * Description:     The pure functions of contract C5 (R59 to R62): the text
 *                  of a page as one string, the conversion between offsets
 *                  into that string and positions in the text layer's items
 *                  (the numbers of PDF++'s `selection=` parameter), the text
 *                  covered by a selection, the quote text derived from it,
 *                  link fragments, and the quote format (re-exported from
 *                  quote.ts). Imports neither electron, Vue nor pdf.js, so
 *                  mocha tests it directly.
 *
 *                  Item numbers: the items returned by getTextContent with
 *                  PDF_TEXT_CONTENT_OPTIONS, without the marked content items
 *                  (those whose `str` is undefined), counted from 0. Empty
 *                  strings count. This equals the index into the text layer's
 *                  textDivs in pdf.js 6.3.
 *
 * END HEADER
 */

import {
  PDF_TEXT_CONTENT_OPTIONS,
  type PdfPageText,
  type PdfTextPosition,
  type PdfTextSelection
} from '@dts/common/pdf-viewer'

export { formatPdfLinkFragment, parsePdfLinkFragment } from './link-fragment'
export {
  encodePdfLinkPath,
  formatPdfDisplayText,
  formatPdfLinkTarget,
  formatPdfQuote
} from './quote'
export {
  buildSourceTextMatchKey,
  findSourceTextOnPage,
  normalizeForSourceTextMatch,
  resolveSelectionBySourceText,
  type SourceTextMatchKey,
  type SourceTextResolution,
  type SourceTextResolutionMethod
} from './source-text-match'
export {
  extractQuotedSourceText,
  isPdfPath,
  parsePdfLinkTarget,
  parsePdfWikiLinkContents,
  rankPdfCandidates,
  splitLinkTarget,
  type LineSource,
  type PdfLinkTarget
} from './pdf-link-target'
export {
  pdfBacklinkColorKey,
  resolveBacklinkColor,
  resolvePdfLinkPath,
  scanPdfLinks
} from './pdf-backlinks'

/**
 * A text content item with a string, i.e. not a marked content item. The
 * index of an item in an array of these is its item number.
 */
export interface PdfTextItem {
  str: string
  hasEOL: boolean
}

/**
 * An item as returned by getTextContent: either a text item, or a marked
 * content item without `str` (whose `type` is, e.g., beginMarkedContent).
 */
export interface PdfTextContentItem {
  str?: string
  hasEOL?: boolean
  type?: string
}

/**
 * The part of a pdf.js PDFDocumentProxy that collectPdfPageTexts needs. A
 * PDFDocumentProxy satisfies it; tests use a stand-in object.
 */
export interface PdfTextSource {
  numPages: number
  getPage (pageNumber: number): Promise<{
    getTextContent (options: object): Promise<{ items: PdfTextContentItem[] }>
  }>
}

/**
 * The text of one page together with its items
 */
export interface PdfPageTextWithItems {
  pageText: PdfPageText
  items: PdfTextItem[]
}

/**
 * Options of collectPdfPageTexts
 */
export interface CollectPdfPageTextsOptions {
  /**
   * Called once per page read, with the number of pages read so far and the
   * number of pages of the document
   */
  onProgress?: (done: number, total: number) => void
  /**
   * Stops reading when aborted; the returned promise then rejects with an
   * error whose name is AbortError
   */
  signal?: AbortSignal
}

/**
 * Characters between which PDF++ removes line breaks and single spaces
 * instead of turning them into a space: CJK ideographs (including extension
 * A), kana, half-width katakana, katakana extensions and CJK symbols and
 * punctuation. Korean is excluded, as in PDF++ (`kw({ korean: false })`).
 */
const CHINESE_JAPANESE_RANGES = '\\u4e00-\\u9fff\\u3400-\\u4dbf\\u3040-\\u309F\\u30A0-\\u30FF\\uFF65-\\uFF9F\\u31F0-\\u31FF\\u3000-\\u303F'
const CHINESE_JAPANESE_CHARACTER = new RegExp(`[${CHINESE_JAPANESE_RANGES}]`)
const SPACE_BETWEEN_CHINESE_JAPANESE = new RegExp(`([${CHINESE_JAPANESE_RANGES}]) (?=[${CHINESE_JAPANESE_RANGES}])`, 'g')

/**
 * A run of line breaks together with the character before and after it, as
 * matched by PDF++'s toSingleLine
 */
const LINE_BREAK_WITH_NEIGHBORS = /(.?)([\r\n]+)(.?)/g

/**
 * The characters pdf.js's normalizeUnicode replaces (pdf.js 6.3,
 * build/pdf.mjs): ligatures, compatibility spaces and a few others are
 * NFKC-normalized; U+FB05 becomes "ſt".
 */
const UNICODE_TO_NORMALIZE = /([ µ;ຳ -  Ωﬀ-ﬄﬆﬠ-זּטּ-לּמּנּסּףּפּצּ-ﮡﮤ-ﮩﮮ-ﮱﯓ-ﯜﯞ-ﯧﯪ-ﯸﯼﯽﰀ-ﱝﱤ-ﳱﳵ-ﴽﶈﷴﷺﷻﹱﹷﹹﹻﹽ]+)|(ﬅ+)/gu

/**
 * Removes the marked content items (those without `str`) from the items
 * returned by getTextContent and keeps only `str` and `hasEOL`, so that the
 * index of each remaining item is its item number.
 *
 * @param   {PdfTextContentItem[]}  items  The items as returned by getTextContent
 *
 * @return  {PdfTextItem[]}                The text items
 */
export function toPdfTextItems (items: PdfTextContentItem[]): PdfTextItem[] {
  const textItems: PdfTextItem[] = []
  for (const item of items) {
    if (item.str !== undefined) {
      textItems.push({ str: item.str, hasEOL: item.hasEOL === true })
    }
  }
  return textItems
}

/**
 * Builds the text of a page: the items' strings in order, each followed by
 * `\n` if its `hasEOL` is true, and the offset at which every item starts.
 *
 * @param   {PdfTextItem[]}  items  The text items of the page
 *
 * @return  {PdfPageText}           The page text
 */
export function buildPdfPageText (items: PdfTextItem[]): PdfPageText {
  const parts: string[] = []
  const itemStarts: number[] = []
  let length = 0
  for (const item of items) {
    itemStarts.push(length)
    parts.push(item.str)
    length += item.str.length
    if (item.hasEOL) {
      parts.push('\n')
      length += 1
    }
  }
  return { text: parts.join(''), itemStarts }
}

/**
 * Reads the text of every page, in page order: result k belongs to page
 * k + 1. Calls `onProgress` after every page; rejects with an AbortError as
 * soon as `signal` is aborted.
 *
 * @param   {PdfTextSource}               source   The document, e.g. a pdf.js PDFDocumentProxy
 * @param   {CollectPdfPageTextsOptions}  options  Progress callback and abort signal
 *
 * @return  {Promise<PdfPageTextWithItems[]>}      The text and items of every page
 */
export async function collectPdfPageTexts (source: PdfTextSource, options: CollectPdfPageTextsOptions = {}): Promise<PdfPageTextWithItems[]> {
  const { onProgress, signal } = options
  const total = source.numPages
  const pages: PdfPageTextWithItems[] = []

  for (let pageNumber = 1; pageNumber <= total; pageNumber++) {
    if (signal?.aborted === true) {
      throw createAbortError()
    }

    const page = await unlessAborted(source.getPage(pageNumber), signal)
    const content = await unlessAborted(page.getTextContent(PDF_TEXT_CONTENT_OPTIONS), signal)
    const items = toPdfTextItems(content.items)
    pages.push({ pageText: buildPdfPageText(items), items })
    if (onProgress !== undefined) {
      onProgress(pageNumber, total)
    }
  }

  if (signal?.aborted === true) {
    throw createAbortError()
  }

  return pages
}

/**
 * Resolves like the promise, unless the signal is or becomes aborted first;
 * then rejects with an AbortError.
 *
 * @param   {Promise<T>}             promise  The promise to wait for
 * @param   {AbortSignal|undefined}  signal   The abort signal, if any
 *
 * @return  {Promise<T>}                      The promise's value
 */
async function unlessAborted<T> (promise: Promise<T>, signal: AbortSignal|undefined): Promise<T> {
  if (signal === undefined) {
    return await promise
  }

  if (signal.aborted) {
    // Do not leave a rejection of the abandoned promise unhandled
    void promise.catch(() => {})
    throw createAbortError()
  }

  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(createAbortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(value => {
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }, (error: unknown) => {
      signal.removeEventListener('abort', onAbort)
      reject(error)
    })
  })
}

/**
 * @return  {Error}  An error whose name is AbortError
 */
function createAbortError (): Error {
  const error = new Error('Reading the text of the PDF was aborted')
  error.name = 'AbortError'
  return error
}

/**
 * Returns the item that a character of the page text belongs to: the last
 * item starting at or before it (empty items that share their start with a
 * following item own no character).
 *
 * @param   {number[]}  itemStarts      The item starts of the page text
 * @param   {number}    count           Number of items to consider, at least 1
 * @param   {number}    characterIndex  Offset of the character, at least 0
 *
 * @return  {number}                    The item number
 */
function findItemAt (itemStarts: number[], count: number, characterIndex: number): number {
  let low = 0
  let high = count - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (itemStarts[middle] <= characterIndex) {
      low = middle
    } else {
      high = middle - 1
    }
  }
  return low
}

/**
 * Converts a position into an offset into the page text. Item numbers below
 * 0 yield 0, above the last item the end of the text; the offset is kept
 * within the item (and its line break, if any).
 *
 * @param   {PdfPageText}      pageText  The page text
 * @param   {PdfTextPosition}  position  The position
 *
 * @return  {number}                     The offset into pageText.text
 */
export function positionToPageOffset (pageText: PdfPageText, position: PdfTextPosition): number {
  const { itemStarts, text } = pageText
  if (itemStarts.length === 0 || position.index < 0) {
    return 0
  }

  if (position.index >= itemStarts.length) {
    return text.length
  }

  const start = itemStarts[position.index]
  const end = position.index + 1 < itemStarts.length ? itemStarts[position.index + 1] : text.length
  return Math.max(start, Math.min(start + position.offset, end))
}

/**
 * Converts an offset into the page text into a position. An offset on the
 * `\n` after an item moves, if `bias` is `start`, to the start of the next
 * item that has text, and, if `bias` is `end`, an offset right after such a
 * `\n` moves to the end of the last item before it that has text; so a range
 * begin never lies on, and a range end never right after, a line break (this
 * also skips the `\n` of empty hasEOL items). At the boundary between two
 * items, `start` picks the later and `end` the earlier item. Offsets outside
 * the text are clamped; at the end of the text both biases yield the end of
 * the last item.
 *
 * @param   {PdfPageText}      pageText  The page text
 * @param   {PdfTextItem[]}    items     The items the page text was built from
 * @param   {number}           offset    The offset into pageText.text
 * @param   {'start'|'end'}    bias      `start` for the begin of a range, `end` for its end
 *
 * @return  {PdfTextPosition}            The position
 */
export function pageOffsetToPosition (pageText: PdfPageText, items: PdfTextItem[], offset: number, bias: 'start'|'end'): PdfTextPosition {
  const count = Math.min(items.length, pageText.itemStarts.length)
  if (count === 0) {
    return { index: 0, offset: 0 }
  }

  const itemStarts = pageText.itemStarts
  const textLength = pageText.text.length
  const clamped = Number.isNaN(offset) ? 0 : Math.max(0, Math.min(offset, textLength))

  if (bias === 'start') {
    if (clamped >= textLength) {
      return { index: count - 1, offset: items[count - 1].str.length }
    }

    const index = findItemAt(itemStarts, count, clamped)
    const local = clamped - itemStarts[index]
    if (local < items[index].str.length) {
      return { index, offset: local }
    }

    // The offset is on the line break after the item: go to the next item
    // that has text, or to the end of the last item if there is none
    for (let next = index + 1; next < count; next++) {
      if (items[next].str.length > 0) {
        return { index: next, offset: 0 }
      }
    }
    return { index: count - 1, offset: items[count - 1].str.length }
  }

  if (clamped <= 0) {
    return { index: 0, offset: 0 }
  }

  const index = findItemAt(itemStarts, count, clamped - 1)
  const local = clamped - 1 - itemStarts[index]
  if (local < items[index].str.length) {
    return { index, offset: local + 1 }
  }

  // The character before the offset is the line break after the item: go to
  // the end of the last item up to this one that has text, or to the start
  for (let previous = index; previous >= 0; previous--) {
    if (items[previous].str.length > 0) {
      return { index: previous, offset: items[previous].str.length }
    }
  }
  return { index: 0, offset: 0 }
}

/**
 * Converts a selection into a range of the page text.
 *
 * @param   {PdfPageText}       pageText   The page text
 * @param   {PdfTextSelection}  selection  The selection
 *
 * @return  {{ from: number, to: number }}  The range, from <= to
 */
export function selectionToPageRange (pageText: PdfPageText, selection: PdfTextSelection): { from: number, to: number } {
  const begin = positionToPageOffset(pageText, { index: selection.beginIndex, offset: selection.beginOffset })
  const end = positionToPageOffset(pageText, { index: selection.endIndex, offset: selection.endOffset })
  return { from: Math.min(begin, end), to: Math.max(begin, end) }
}

/**
 * Converts a range of the page text into a selection. The begin uses the
 * `start` bias and the end the `end` bias of pageOffsetToPosition; an empty
 * range, or one that covers nothing but line breaks, yields a collapsed
 * selection at its begin.
 *
 * @param   {PdfPageText}    pageText  The page text
 * @param   {PdfTextItem[]}  items     The items the page text was built from
 * @param   {number}         from      Start of the range (included)
 * @param   {number}         to        End of the range (excluded)
 *
 * @return  {PdfTextSelection}         The selection
 */
export function pageRangeToSelection (pageText: PdfPageText, items: PdfTextItem[], from: number, to: number): PdfTextSelection {
  const rangeFrom = Math.min(from, to)
  const rangeTo = Math.max(from, to)
  const begin = pageOffsetToPosition(pageText, items, rangeFrom, 'start')
  let end = rangeTo > rangeFrom ? pageOffsetToPosition(pageText, items, rangeTo, 'end') : begin
  if (comparePositions(end, begin) < 0) {
    end = begin
  }

  return {
    beginIndex: begin.index,
    beginOffset: begin.offset,
    endIndex: end.index,
    endOffset: end.offset
  }
}

/**
 * @return  {number}  Negative if a lies before b, 0 if they are equal, positive otherwise
 */
function comparePositions (a: PdfTextPosition, b: PdfTextPosition): number {
  return a.index !== b.index ? a.index - b.index : a.offset - b.offset
}

/**
 * Keeps a position within the items: before the first item it becomes the
 * first item's start, after the last item the last item's end, and the
 * offset stays within the item's string.
 */
function clampPosition (items: PdfTextItem[], position: PdfTextPosition): PdfTextPosition {
  if (position.index < 0) {
    return { index: 0, offset: 0 }
  }

  if (position.index >= items.length) {
    const last = items.length - 1
    return { index: last, offset: items[last].str.length }
  }

  const length = items[position.index].str.length
  return { index: position.index, offset: Math.max(0, Math.min(position.offset, length)) }
}

/**
 * Returns the original text a selection covers: the covered parts of the
 * items' strings, with a `\n` after every covered item whose `hasEOL` is
 * true (the line breaks the text layer renders as <br>). Positions outside
 * the items are clamped; a selection whose end does not lie after its begin
 * covers nothing.
 *
 * @param   {PdfTextItem[]}     items      The text items of the page
 * @param   {PdfTextSelection}  selection  The selection
 *
 * @return  {string}                       The covered text
 */
export function selectionText (items: PdfTextItem[], selection: PdfTextSelection): string {
  if (items.length === 0) {
    return ''
  }

  const begin = clampPosition(items, { index: selection.beginIndex, offset: selection.beginOffset })
  const end = clampPosition(items, { index: selection.endIndex, offset: selection.endOffset })
  if (comparePositions(end, begin) <= 0) {
    return ''
  }

  if (begin.index === end.index) {
    return items[begin.index].str.slice(begin.offset, end.offset)
  }

  const parts: string[] = [items[begin.index].str.slice(begin.offset)]
  if (items[begin.index].hasEOL) {
    parts.push('\n')
  }

  for (let index = begin.index + 1; index < end.index; index++) {
    parts.push(items[index].str)
    if (items[index].hasEOL) {
      parts.push('\n')
    }
  }

  parts.push(items[end.index].str.slice(0, end.offset))
  return parts.join('')
}

/**
 * Turns the text of a selection into the text of a quote, the way PDF++
 * (function `toSingleLine` of its main.js, with the setting
 * `removeWhitespaceBetweenCJChars` on) does it:
 *
 * - a run of line breaks between two Chinese or Japanese characters is
 *   removed;
 * - a run of line breaks after a hyphen and before a Latin letter is removed
 *   together with the hyphen (end-of-line hyphenation);
 * - every other run of line breaks becomes one space, or disappears at the
 *   end of the text;
 * - a single space between two Chinese or Japanese characters is removed;
 * - ligatures and compatibility characters are normalized like pdf.js's
 *   normalizeUnicode does, and NUL characters are removed.
 *
 * Like PDF++, it does not trim: a selection starting or ending with a space
 * keeps it, a line break at the start becomes a space, and only line breaks
 * at the very end disappear.
 *
 * @param   {string}  raw  The text, e.g. as returned by selectionText
 *
 * @return  {string}       The quote text, on one line
 */
export function toQuoteText (raw: string): string {
  let text = raw.replace(LINE_BREAK_WITH_NEIGHBORS, (match: string, before: string, lineBreaks: string, after: string) => {
    if (CHINESE_JAPANESE_CHARACTER.test(before) && CHINESE_JAPANESE_CHARACTER.test(after)) {
      return before + after
    }
    if (before === '-' && /[a-zA-Z]/.test(after)) {
      return after
    }
    return after !== '' ? `${before} ${after}` : before
  })

  text = text.replace(SPACE_BETWEEN_CHINESE_JAPANESE, '$1')

  text = text.replace(UNICODE_TO_NORMALIZE, (match: string, normalizable: string|undefined, longStLigatures: string|undefined) => {
    if (normalizable !== undefined) {
      return normalizable.normalize('NFKC')
    }
    return 'ſt'.repeat(longStLigatures?.length ?? 0)
  })

  return text.replaceAll('\u0000', '')
}
