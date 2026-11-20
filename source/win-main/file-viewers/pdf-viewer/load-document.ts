/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Loading a PDF file into pdf.js
 * CVM-Role:        Utility
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH R59: opens a PDF from its absolute path. The
 *                  renderer cannot fetch safe-file:// URLs (fetch does not
 *                  support the scheme, and XMLHttpRequest refuses it as a
 *                  cross-origin request from the page's http origin), so the
 *                  file's bytes are requested from the main process over the
 *                  `application` IPC channel (command `get-file-bytes`) and
 *                  handed to pdf.js as data.
 *
 * END HEADER
 */

import {
  getDocument,
  PDFJS_DOCUMENT_RESOURCE_OPTIONS,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy
} from './pdfjs'

/**
 * Command of the `application` IPC channel that answers with the bytes of the
 * PDF at the absolute path given as payload, or with null if it cannot be read
 */
export const PDF_FILE_BYTES_COMMAND = 'get-file-bytes'

/**
 * A running load; `cancel` stops it and destroys whatever pdf.js has loaded
 * so far. A cancelled load's promise rejects with a PdfLoadCancelledError.
 */
export interface PdfLoadHandle {
  promise: Promise<PDFDocumentProxy>
  cancel: () => void
}

/**
 * Rejection reason of a cancelled load
 */
export class PdfLoadCancelledError extends Error {
  constructor () {
    super('Loading the PDF was cancelled')
    this.name = 'PdfLoadCancelledError'
  }
}

/**
 * Rejection reason when the main process could not deliver the file's bytes
 * (the file is missing, unreadable, or not a PDF)
 */
export class PdfFileReadError extends Error {
  constructor () {
    super('The file could not be read')
    this.name = 'PdfFileReadError'
  }
}

/**
 * Turns the reply of the `get-file-bytes` command into bytes pdf.js accepts.
 * A Node.js Buffer sent over IPC arrives in the renderer as a Uint8Array.
 *
 * @param   {unknown}          reply  What the main process returned
 *
 * @return  {Uint8Array|null}         The bytes, or null if there were none
 */
function toBytes (reply: unknown): Uint8Array|null {
  if (reply instanceof Uint8Array) {
    return reply
  } else if (reply instanceof ArrayBuffer) {
    return new Uint8Array(reply)
  } else {
    return null
  }
}

/**
 * Starts loading the PDF at an absolute path
 *
 * @param   {string}         filePath  The absolute path of the PDF
 *
 * @return  {PdfLoadHandle}            The running load
 */
export function loadPdfDocument (filePath: string): PdfLoadHandle {
  let cancelled = false
  let loadingTask: PDFDocumentLoadingTask|null = null

  const load = async (): Promise<PDFDocumentProxy> => {
    let reply: unknown = null
    try {
      reply = await window.ipc.invoke('application', { command: PDF_FILE_BYTES_COMMAND, payload: filePath })
    } catch (error: unknown) {
      console.error('Could not request the bytes of the PDF from the main process', error)
      reply = null
    }

    if (cancelled) {
      throw new PdfLoadCancelledError()
    }

    const bytes = toBytes(reply)
    if (bytes === null) {
      throw new PdfFileReadError()
    }

    loadingTask = getDocument({ data: bytes, ...PDFJS_DOCUMENT_RESOURCE_OPTIONS })
    return await loadingTask.promise
  }

  const promise = load().catch((error: unknown) => {
    throw cancelled ? new PdfLoadCancelledError() : error
  })

  return {
    promise,
    cancel: () => {
      cancelled = true
      void loadingTask?.destroy()
      loadingTask = null
    }
  }
}

/**
 * The English message the viewer shows in its center when a PDF cannot be
 * opened
 *
 * @param   {unknown}  error  The rejection reason of loadPdfDocument
 *
 * @return  {string}          The message
 */
export function describePdfLoadError (error: unknown): string {
  const name = (error as { name?: unknown }|null)?.name
  if (name === 'PasswordException') {
    return 'This PDF is password-protected and cannot be shown.'
  } else if (name === 'InvalidPDFException') {
    return 'This file is damaged or is not a valid PDF.'
  } else if (name === 'PdfFileReadError') {
    return 'The PDF could not be read. It may have been moved, deleted, or be inaccessible.'
  }

  const message = error instanceof Error ? error.message : String(error)
  return `The PDF could not be opened: ${message}`
}
