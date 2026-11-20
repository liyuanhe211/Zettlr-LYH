/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        pdf.js entry point of the renderer
 * CVM-Role:        Utility
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH R59: the only module that loads pdf.js' runtime
 *                  code; everything else imports pdf.js values from here and
 *                  pdf.js types with `import type`. It loads the library
 *                  before the viewer components (pdfjs-dist/web/pdf_viewer.mjs
 *                  takes the library from globalThis.pdfjsLib, which
 *                  pdfjs-dist/build/pdf.mjs sets when it is evaluated), loads
 *                  the viewer's stylesheet, and points pdf.js to its worker
 *                  script and data files. Those are not bundled by webpack but
 *                  copied by copy-webpack-plugin into the folder `pdfjs/` of
 *                  the renderer output (see webpack.renderer.config.js), which
 *                  lies next to the window folders (`main_window/` etc.).
 *                  It also defines the viewer's link service, which differs
 *                  from pdf.js' own in how it goes to destinations
 *                  (go-to-destination.ts).
 *
 * END HEADER
 */

// NOTE: This import must stay the first one of this module, see above
import { GlobalWorkerOptions } from 'pdfjs-dist'
import 'pdfjs-dist/web/pdf_viewer.css'
import { PDFLinkService as PdfJsLinkService } from 'pdfjs-dist/web/pdf_viewer.mjs'
import { goToPdfDestination } from './go-to-destination'

export {
  AnnotationEditorType,
  AnnotationMode,
  getDocument,
  InvalidPDFException,
  PasswordException,
  ResponseException
} from 'pdfjs-dist'
export {
  EventBus,
  LinkTarget,
  PDFFindController,
  PDFLinkService,
  PDFViewer
} from 'pdfjs-dist/web/pdf_viewer.mjs'
export type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist'

/**
 * URL of the folder `pdfjs/` in the renderer output, with a trailing slash.
 * Every window page lives one level below the output root
 * (`<root>/main_window/index.html` when packaged; `/main_window` or
 * `/main_window/index.html` on the development server), so `../pdfjs/`
 * resolves against all of them to `<root>/pdfjs/`.
 */
export const PDFJS_RESOURCE_BASE_URL = new URL('../pdfjs/', document.baseURI).href

/**
 * The worker is loaded from the same origin as the page, so pdf.js creates it
 * directly from this URL (no blob URL, which the CSP's script-src 'self' would
 * refuse)
 */
GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', PDFJS_RESOURCE_BASE_URL).href

/**
 * Where the worker finds its data files; pass these with every getDocument
 * call. All URLs end with a slash, as pdf.js requires.
 */
export const PDFJS_DOCUMENT_RESOURCE_OPTIONS = {
  cMapUrl: new URL('cmaps/', PDFJS_RESOURCE_BASE_URL).href,
  cMapPacked: true,
  standardFontDataUrl: new URL('standard_fonts/', PDFJS_RESOURCE_BASE_URL).href,
  wasmUrl: new URL('wasm/', PDFJS_RESOURCE_BASE_URL).href,
  iccUrl: new URL('iccs/', PDFJS_RESOURCE_BASE_URL).href
} as const

/**
 * Where the viewer finds the icons of annotations such as notes and
 * attachments (PDFViewer option imageResourcesPath), with a trailing slash
 */
export const PDFJS_IMAGE_RESOURCES_PATH = new URL('images/', PDFJS_RESOURCE_BASE_URL).href

/**
 * pdf.js' link service, except that going to a destination (outline entries,
 * internal links) moves the focus right away instead of focusing the
 * destination's text layer once it has been rendered, which scrolled the view
 * back to the destination later on (see go-to-destination.ts)
 */
export class PdfViewerLinkService extends PdfJsLinkService {
  override async goToDestination (dest: string|unknown[]): Promise<void> {
    await goToPdfDestination(this, dest)
  }
}
