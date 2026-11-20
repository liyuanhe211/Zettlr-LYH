/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        JEV search chunking of PDF page texts
 * CVM-Role:        Utility Function
 * License:         GNU GPL v3
 *
 * Description:     The pure functions behind JEV Search on PDF files (R61,
 *                  contract C5, section on PDF chunking). Every page is split
 *                  on its own with the document chunking of contract C4, so no
 *                  chunk ever spans two pages and each hit maps back to one
 *                  page and a range of offsets into that page's text. Also
 *                  turns a chunk into the location the PDF viewer highlights,
 *                  and fills in missing page labels. Depends on nothing but
 *                  the shared types, the document chunking function and the
 *                  pure text positions of contract C5; it imports neither
 *                  electron, Vue nor pdf.js, so mocha tests it directly.
 *
 * END HEADER
 */

import type { PdfJevSearchChunk, PdfLocation, PdfPageText } from '@dts/common/pdf-viewer'
import { pageRangeToSelection, type PdfPageTextWithItems } from '../pdf-text'
import { splitIntoJevChunks } from './index'

const NON_WHITESPACE = /\S/

/**
 * Splits the page texts of a PDF into the chunks the JEV search judges one by
 * one. Each page is chunked separately with splitIntoJevChunks; pages that
 * hold only whitespace produce no chunk.
 *
 * @param   {PdfPageText[]}        pages               `pages[k]` is the text
 *                                                     of page k + 1
 * @param   {number}               maxChunkCharacters  Upper bound of a chunk's
 *                                                     length
 *
 * @return  {PdfJevSearchChunk[]}                      Chunks ordered by page,
 *                                                     then by offset; `text`
 *                                                     always equals the page's
 *                                                     text sliced from `from`
 *                                                     to `to`
 */
export function splitPdfIntoJevChunks (pages: PdfPageText[], maxChunkCharacters: number): PdfJevSearchChunk[] {
  const chunks: PdfJevSearchChunk[] = []
  pages.forEach((pageText, index) => {
    for (const chunk of splitIntoJevChunks(pageText.text, maxChunkCharacters)) {
      chunks.push({ page: index + 1, from: chunk.from, to: chunk.to, text: chunk.text })
    }
  })
  return chunks
}

/**
 * Tells whether a PDF has a text layer at all. A scanned PDF without OCR
 * yields page texts that hold nothing but whitespace (at most the line feeds
 * of empty items), and the panel then asks the user to run OCR first.
 *
 * @param   {PdfPageText[]}  pages  The page texts of the whole file
 *
 * @return  {boolean}               False when every page's text is empty
 *                                  after removing whitespace, also for a file
 *                                  without pages
 */
export function pdfHasTextLayer (pages: PdfPageText[]): boolean {
  return pages.some(pageText => NON_WHITESPACE.test(pageText.text))
}

/**
 * Turns a chunk into the location the PDF viewer scrolls to and highlights:
 * its page and the selection that covers its range of the page text (begin
 * and end never lie on a line break, see pageRangeToSelection).
 *
 * @param   {PdfPageTextWithItems[]}  pages  The text and items of every page;
 *                                           `pages[k]` belongs to page k + 1
 * @param   {PdfJevSearchChunk}       chunk  A chunk of these pages
 *
 * @return  {PdfLocation}                    The chunk's page and selection;
 *                                           only the page if the chunk names a
 *                                           page that is not in `pages`
 */
export function pdfJevChunkLocation (pages: PdfPageTextWithItems[], chunk: PdfJevSearchChunk): PdfLocation {
  const page = pages[chunk.page - 1]
  if (page === undefined) {
    return { page: chunk.page }
  }
  return {
    page: chunk.page,
    selection: pageRangeToSelection(page.pageText, page.items, chunk.from, chunk.to)
  }
}

/**
 * Returns the label of every page as the hits of the JEV Search panel show
 * it ("p. <label>"): the page label the PDF defines, without surrounding
 * whitespace, or the page number in decimal when the PDF defines no labels
 * or an empty one for that page.
 *
 * @param   {Array|null|undefined}  labels     The labels as returned by
 *                                             pdf.js' getPageLabels (null
 *                                             when the PDF has none)
 * @param   {number}                pageCount  Number of pages of the PDF
 *
 * @return  {string[]}                         One label per page; index k
 *                                             belongs to page k + 1
 */
export function resolvePdfPageLabels (labels: ReadonlyArray<string|null|undefined>|null|undefined, pageCount: number): string[] {
  return Array.from({ length: pageCount }, (_, index) => {
    const label = labels?.[index]
    return typeof label === 'string' && label.trim() !== '' ? label.trim() : String(index + 1)
  })
}
