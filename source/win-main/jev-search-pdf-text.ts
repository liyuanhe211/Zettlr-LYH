/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Reading the text of a PDF for JEV Search
 * CVM-Role:        Utility
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH R61: the JEV Search panel searches a PDF in the
 *                  text pdf.js extracts from it. This module opens the file
 *                  on its own, independently of any PDF viewer (which may be
 *                  unmounted, or busy zooming and rendering), reads the text
 *                  of every page as contract C5 defines it, and destroys the
 *                  document right afterwards. It loads the file the same way
 *                  the viewer does (loadPdfDocument, which takes pdf.js and
 *                  its worker from the viewer's pdfjs module), so the panel
 *                  never touches pdf.js itself.
 *
 *                  The texts of the last few files are kept, keyed by path
 *                  and checked against the file's modification time and size,
 *                  so that searching the same PDF again with another
 *                  description does not read every page again.
 *
 * END HEADER
 */

import { collectPdfPageTexts, type PdfPageTextWithItems } from '@common/modules/pdf-text'
import { resolvePdfPageLabels } from '@common/modules/jev-search/pdf-chunks'
import { loadPdfDocument } from './file-viewers/pdf-viewer/load-document'
import type { PDFDocumentProxy } from './file-viewers/pdf-viewer/pdfjs'

/**
 * The text of a whole PDF
 */
export interface JevSearchPdfText {
  /**
   * The text and items of every page; index k belongs to page k + 1
   */
  pages: PdfPageTextWithItems[]
  /**
   * The label of every page, as the hits show it; the page number in decimal
   * where the PDF defines no label
   */
  pageLabels: string[]
}

/**
 * Options of readJevSearchPdfText
 */
export interface ReadJevSearchPdfTextOptions {
  /**
   * Stops reading when aborted; the returned promise then rejects with an
   * error whose name is AbortError
   */
  signal: AbortSignal
  /**
   * Called once per page read, with the number of pages read so far and the
   * number of pages of the document
   */
  onProgress?: (done: number, total: number) => void
}

/**
 * Number of files whose text is kept
 */
const PDF_TEXT_CACHE_MAX_FILES = 3

/**
 * Texts read before, by absolute path, in order of last use (oldest first)
 */
const pdfTextCache = new Map<string, { modtime: number, size: number, text: JevSearchPdfText }>()

/**
 * @return  {Error}  An error whose name is AbortError
 */
function createAbortError (): Error {
  const error = new Error('Reading the PDF was aborted')
  error.name = 'AbortError'
  return error
}

/**
 * Asks the file system abstraction for the modification time and size of a
 * file, which tell whether a kept text is still valid.
 *
 * @param   {string}  filePath  The absolute path of the PDF
 *
 * @return  {Promise}           The modification time and size, or undefined
 *                              when the file has no descriptor
 */
async function getFileStamp (filePath: string): Promise<{ modtime: number, size: number }|undefined> {
  try {
    const descriptor: unknown = await window.ipc.invoke('fsal', { command: 'get-descriptor', payload: filePath })
    if (typeof descriptor !== 'object' || descriptor === null) {
      return undefined
    }
    const { modtime, size } = descriptor as { modtime?: unknown, size?: unknown }
    if (typeof modtime !== 'number' || typeof size !== 'number') {
      return undefined
    }
    return { modtime, size }
  } catch {
    return undefined
  }
}

/**
 * Keeps the text of a file as the most recently used one and forgets the
 * oldest ones beyond PDF_TEXT_CACHE_MAX_FILES.
 */
function rememberPdfText (filePath: string, entry: { modtime: number, size: number, text: JevSearchPdfText }): void {
  pdfTextCache.delete(filePath)
  pdfTextCache.set(filePath, entry)
  while (pdfTextCache.size > PDF_TEXT_CACHE_MAX_FILES) {
    const oldest = pdfTextCache.keys().next().value
    if (oldest === undefined) {
      break
    }
    pdfTextCache.delete(oldest)
  }
}

/**
 * Reads the text of every page of a PDF and the page labels. Opens the file
 * with pdf.js and destroys the document when done, also on failure and on
 * abort. Returns the kept text instead when the file's modification time and
 * size have not changed since it was read.
 *
 * @param   {string}                       filePath  The absolute path of the PDF
 * @param   {ReadJevSearchPdfTextOptions}  options   Abort signal and progress callback
 *
 * @return  {Promise<JevSearchPdfText>}              The text; rejects with an
 *                                                   AbortError when aborted,
 *                                                   with the load error when
 *                                                   the file cannot be opened
 */
export async function readJevSearchPdfText (filePath: string, options: ReadJevSearchPdfTextOptions): Promise<JevSearchPdfText> {
  const { signal, onProgress } = options
  if (signal.aborted) {
    throw createAbortError()
  }

  const stamp = await getFileStamp(filePath)
  if (signal.aborted) {
    throw createAbortError()
  }

  if (stamp !== undefined) {
    const kept = pdfTextCache.get(filePath)
    if (kept !== undefined && kept.modtime === stamp.modtime && kept.size === stamp.size) {
      rememberPdfText(filePath, kept)
      if (onProgress !== undefined) {
        onProgress(kept.text.pages.length, kept.text.pages.length)
      }
      return kept.text
    }
  }

  const load = loadPdfDocument(filePath)
  const onAbort = (): void => { load.cancel() }
  signal.addEventListener('abort', onAbort, { once: true })

  try {
    let pdfDocument: PDFDocumentProxy
    try {
      pdfDocument = await load.promise
    } catch (error: unknown) {
      throw signal.aborted ? createAbortError() : error
    }

    if (signal.aborted) {
      throw createAbortError()
    }

    const pages = await collectPdfPageTexts(pdfDocument, { signal, onProgress })

    let labels: Array<string|null>|null = null
    try {
      labels = await pdfDocument.getPageLabels()
    } catch {
      // A broken page label tree only costs the labels
      labels = null
    }

    if (signal.aborted) {
      throw createAbortError()
    }

    const text: JevSearchPdfText = { pages, pageLabels: resolvePdfPageLabels(labels, pages.length) }
    if (stamp !== undefined) {
      rememberPdfText(filePath, { modtime: stamp.modtime, size: stamp.size, text })
    }
    return text
  } catch (error: unknown) {
    // Destroying the document while a page was being read rejects that read
    // with a pdf.js error; report it as the abort it is
    throw signal.aborted ? createAbortError() : error
  } finally {
    signal.removeEventListener('abort', onAbort)
    // Destroys the loading task and with it the document and its worker
    // transport; does nothing harmful if the load already failed
    load.cancel()
  }
}
