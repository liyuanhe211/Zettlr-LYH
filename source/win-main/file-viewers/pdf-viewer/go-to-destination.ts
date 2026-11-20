/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Going to a destination of a PDF
 * CVM-Role:        Utility function
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH R59 (contract C5): the link service of the PDF
 *                  viewer (PdfViewerLinkService in pdfjs.ts) goes to the
 *                  destinations of outline entries and internal links with
 *                  goToPdfDestination instead of pdf.js' own
 *                  PDFLinkService.goToDestination. It does the same, except
 *                  for the focus. pdf.js waits until the text layer of the
 *                  destination's page has been rendered and then focuses it,
 *                  which scrolls it into view. That can happen long after the
 *                  jump (the page is drawn only once it is in view, and the
 *                  wait never ends until it is drawn), so the view jumped
 *                  back to the destination after the reader had gone to
 *                  another page, and the focus left the page number box.
 *                  goToPdfDestination moves the focus to the scroll container
 *                  right away instead, without scrolling, so that the
 *                  keyboard still pages through the document. The viewer
 *                  keeps no navigation history, so the history pdf.js would
 *                  update is left out. The module imports nothing from pdf.js
 *                  at runtime, so that mocha can test it.
 *
 * END HEADER
 */

/**
 * The part of pdf.js' PDFDocumentProxy that goToPdfDestination uses
 */
export interface PdfDestinationDocument {
  getDestination: (name: string) => Promise<unknown>
  // The page number of a page reference, if pdf.js has already looked it up
  cachedPageNumber: (reference: object) => number|null|undefined
  // The page index (from 0) of a page reference
  getPageIndex: (reference: object) => Promise<number>
}

/**
 * The part of pdf.js' PDFViewer that goToPdfDestination uses
 */
export interface PdfDestinationViewer {
  container: { focus: (options?: FocusOptions) => void }
  scrollPageIntoView: (parameters: { pageNumber: number, destArray: unknown[], ignoreDestinationZoom: boolean }) => void
}

/**
 * The part of pdf.js' PDFLinkService that goToPdfDestination uses
 */
export interface PdfDestinationLinkService {
  pdfDocument: PdfDestinationDocument|null
  pdfViewer: PdfDestinationViewer|null
  readonly pagesCount: number
  _ignoreDestinationZoom: boolean
}

/**
 * Goes to a named or explicit destination, as pdf.js'
 * PDFLinkService.goToDestination does, and moves the focus to the scroll
 * container without scrolling
 *
 * @param   {PdfDestinationLinkService}  linkService  The link service
 * @param   {string|unknown[]}           destination  A destination name or array
 */
export async function goToPdfDestination (linkService: PdfDestinationLinkService, destination: string|unknown[]): Promise<void> {
  const pdfDocument = linkService.pdfDocument
  if (pdfDocument === null || pdfDocument === undefined) {
    return
  }

  const explicitDestination = typeof destination === 'string' ? await pdfDocument.getDestination(destination) : destination
  if (!Array.isArray(explicitDestination)) {
    console.error(`goToDestination: "${String(explicitDestination)}" is not a valid destination array, for dest="${String(destination)}".`)
    return
  }

  const [reference] = explicitDestination as unknown[]
  let pageNumber: number|null|undefined
  if (typeof reference === 'object' && reference !== null) {
    pageNumber = pdfDocument.cachedPageNumber(reference)
    if (pageNumber === null || pageNumber === undefined || pageNumber === 0) {
      try {
        pageNumber = (await pdfDocument.getPageIndex(reference)) + 1
      } catch {
        console.error(`goToDestination: "${JSON.stringify(reference)}" is not a valid page reference, for dest="${String(destination)}".`)
        return
      }
    }
  } else if (typeof reference === 'number' && Number.isInteger(reference)) {
    pageNumber = reference + 1
  }

  // The document may have been closed while the destination was looked up
  const pdfViewer = linkService.pdfViewer
  if (linkService.pdfDocument !== pdfDocument || pdfViewer === null || pdfViewer === undefined) {
    return
  }

  if (pageNumber === null || pageNumber === undefined || pageNumber < 1 || pageNumber > linkService.pagesCount) {
    console.error(`goToDestination: "${String(pageNumber)}" is not a valid page number, for dest="${String(destination)}".`)
    return
  }

  pdfViewer.scrollPageIntoView({
    pageNumber,
    destArray: explicitDestination,
    ignoreDestinationZoom: linkService._ignoreDestinationZoom
  })
  pdfViewer.container.focus({ preventScroll: true })
}
