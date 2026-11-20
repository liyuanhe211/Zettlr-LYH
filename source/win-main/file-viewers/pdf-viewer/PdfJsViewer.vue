<template>
  <div
    ref="viewerRoot"
    class="pdfjs-viewer"
    role="region"
    v-bind:aria-label="`PDFViewer: Currently viewing file ${pathBasename(props.file.path)}`"
    v-on:focusin="reportFocus"
    v-on:keydown="handleKeydown"
    v-on:mousedown="handleViewerMouseDown"
    v-on:mouseup="handleViewerMouseUp"
  >
    <div class="pdfjs-viewer-toolbar" role="toolbar" aria-label="PDF viewer toolbar">
      <button
        type="button"
        class="pdfjs-viewer-button"
        title="Toggle Outline"
        aria-label="Toggle outline"
        v-bind:aria-pressed="sidebarVisible ? 'true' : 'false'"
        v-on:click="toggleSidebar"
      >
        <cds-icon shape="indented-view-list" role="presentation"></cds-icon>
      </button>

      <div class="pdfjs-viewer-divider" aria-hidden="true"></div>

      <button
        type="button"
        class="pdfjs-viewer-button"
        title="Previous Page (Page Up)"
        aria-label="Previous page"
        v-bind:disabled="!documentReady || currentPage <= 1"
        v-on:click="goToPreviousPage"
      >
        <cds-icon shape="angle" direction="up" role="presentation"></cds-icon>
      </button>
      <button
        type="button"
        class="pdfjs-viewer-button"
        title="Next Page (Page Down)"
        aria-label="Next page"
        v-bind:disabled="!documentReady || currentPage >= pagesCount"
        v-on:click="goToNextPage"
      >
        <cds-icon shape="angle" direction="down" role="presentation"></cds-icon>
      </button>
      <input
        class="pdfjs-viewer-page-input"
        type="text"
        inputmode="numeric"
        title="Page Number"
        aria-label="Page number"
        spellcheck="false"
        autocomplete="off"
        v-bind:value="pageInputText"
        v-bind:disabled="!documentReady"
        v-on:input="handlePageInput"
        v-on:keydown="handlePageInputKeydown"
        v-on:focus="handlePageInputFocus"
        v-on:blur="handlePageInputBlur"
      >
      <span class="pdfjs-viewer-page-count">/ {{ pagesCount > 0 ? pagesCount : '–' }}</span>

      <div class="pdfjs-viewer-divider" aria-hidden="true"></div>

      <button
        type="button"
        class="pdfjs-viewer-button"
        title="Zoom Out"
        aria-label="Zoom out"
        v-bind:disabled="!documentReady || currentScale <= PDF_VIEWER_MIN_ZOOM"
        v-on:click="zoomOut"
      >
        <cds-icon shape="zoom-out" role="presentation"></cds-icon>
      </button>
      <button
        type="button"
        class="pdfjs-viewer-button"
        title="Zoom In"
        aria-label="Zoom in"
        v-bind:disabled="!documentReady || currentScale >= PDF_VIEWER_MAX_ZOOM"
        v-on:click="zoomIn"
      >
        <cds-icon shape="zoom-in" role="presentation"></cds-icon>
      </button>
      <select
        v-model="zoomSelection"
        class="pdfjs-viewer-zoom-select"
        title="Zoom"
        aria-label="Zoom"
        v-bind:disabled="!documentReady"
      >
        <option
          v-for="option in ZOOM_OPTIONS"
          v-bind:key="option.value"
          v-bind:value="option.value"
        >
          {{ option.label }}
        </option>
        <!-- Shows a zoom that none of the options above stands for, the way
        pdf.js' own viewer does; it can never be picked -->
        <option v-bind:value="CUSTOM_ZOOM_VALUE" disabled hidden>
          {{ customZoomLabel }}
        </option>
      </select>

      <div class="pdfjs-viewer-divider" aria-hidden="true"></div>

      <button
        type="button"
        class="pdfjs-viewer-button"
        title="Find in PDF (Ctrl+F)"
        aria-label="Find in PDF"
        v-bind:disabled="!documentReady"
        v-on:click="openFindBar"
      >
        <cds-icon shape="search" role="presentation"></cds-icon>
      </button>
      <button
        type="button"
        class="pdfjs-viewer-button pdfjs-viewer-backlinks-button"
        v-bind:title="backlinksButtonTitle"
        aria-label="Show highlights for passages quoted in your notes"
        v-bind:aria-pressed="backlinksVisible ? 'true' : 'false'"
        v-on:click="toggleBacklinks"
      >
        <cds-icon shape="highlighter" role="presentation"></cds-icon>
      </button>

      <div class="pdfjs-viewer-divider" aria-hidden="true"></div>

      <PdfQuoteControls
        v-bind:disabled="!documentReady"
        v-on:change="handleQuoteSettingsChange"
      ></PdfQuoteControls>
      <span
        v-if="quoteStatus !== ''"
        class="pdfjs-viewer-page-count pdfjs-viewer-quote-status"
        role="status"
      >{{ quoteStatus }}</span>
      <button
        type="button"
        class="pdfjs-viewer-button pdfjs-viewer-open-button"
        title="Open in Default App"
        v-on:click="openInDefaultApp"
      >
        <cds-icon shape="pop-out" role="presentation"></cds-icon>
        <span>Open in Default App</span>
      </button>
    </div>

    <PdfFindBar
      v-show="findBarVisible"
      ref="findBar"
      v-bind:event-bus="viewerEventBus"
      v-bind:find-controller="viewerFindController"
      v-on:close="closeFindBar"
    ></PdfFindBar>

    <div class="pdfjs-viewer-body">
      <div v-show="sidebarVisible" class="pdfjs-viewer-sidebar">
        <PdfOutline
          v-bind:pdf-document="viewerDocument"
          v-bind:link-service="viewerLinkService"
        ></PdfOutline>
      </div>
      <div class="pdfjs-viewer-main">
        <!-- The scroll container of pdf.js is created by code for every
        document and placed in here; this element must stay empty otherwise -->
        <div
          ref="pagesHost"
          class="pdfjs-viewer-pages"
          v-on:wheel="handleWheel"
          v-on:click.capture="handlePdfLinkClick"
          v-on:contextmenu="handlePagesContextMenu"
          v-on:mousemove="handlePagesMouseMove"
          v-on:mouseleave="handlePagesMouseLeave"
        ></div>
        <div
          v-if="errorMessage !== '' || isLoading"
          class="pdfjs-viewer-message"
          role="status"
        >
          {{ errorMessage !== '' ? errorMessage : 'Loading PDF…' }}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        PdfJsViewer
 * CVM-Role:        View
 * License:         GNU GPL v3
 *
 * Description:     The read-only PDF viewer of Zettlr-LYH (R59, contract C5),
 *                  built on pdf.js' PDFViewer component instead of Chromium's
 *                  built-in viewer. It shows the pages in one continuous
 *                  vertical scroll with selectable text, a toolbar (outline,
 *                  page navigation, zoom, find, Open in Default App), the
 *                  outline sidebar (PdfOutline) and the find bar
 *                  (PdfFindBar). It remembers page and zoom per file in
 *                  localStorage (view-state.ts), and it answers the
 *                  pdfViewerRequest editor command by scrolling to a page and
 *                  highlighting a text range (location-highlight.ts). A
 *                  request that comes with the quoted text below a link has
 *                  its range checked against the page's text first (decision
 *                  071), and a request that arrived before this viewer was
 *                  mounted or had loaded its file is carried out once the
 *                  file is loaded (viewer-request.ts). Page Width, Page Fit
 *                  and Auto are computed again whenever the pages area
 *                  changes its size, and every zoom change keeps the place
 *                  shown (zoom.ts). Outline entries and internal links go to
 *                  their destinations through PdfViewerLinkService
 *                  (pdfjs.ts, go-to-destination.ts). Selected text can be copied as a quote
 *                  in PDF++'s format (R60, copy-quote.ts) through the context
 *                  menu, Ctrl+Shift+C, or Auto-copy when the mouse button is
 *                  released; color and Auto-copy are set in the toolbar
 *                  (PdfQuoteControls). Passages that notes quote with a
 *                  `selection=` link are highlighted (R62, contract C11):
 *                  the backlinks come from the main process' index
 *                  (pdf-backlink-provider) and are drawn, hit-tested and
 *                  listed in a hover popup by backlink-highlight.ts and
 *                  backlink-popup.ts; a double click on one asks App.vue to
 *                  open the note (PDF_BACKLINK_OPEN_EVENT). A toolbar button
 *                  shows or hides them for all PDFs.
 *                  Every document gets its own set of pdf.js objects (event
 *                  bus, link service, find controller, viewer) and its own
 *                  scroll container, which are all discarded when another
 *                  file is shown or the component unmounts.
 *
 * END HEADER
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, toRaw, toRef, watch } from 'vue'
import type { OpenDocument } from 'source/types/common/documents'
import type { EditorCommands } from '../../App.vue'
import type { DocumentManagerIPCAPI } from 'source/app/service-providers/documents'
import type { PdfBacklinkProviderAPI } from 'source/app/service-providers/pdf-backlinks'
import {
  PDF_BACKLINK_OPEN_EVENT,
  PDF_BACKLINKS_VISIBLE_STORAGE_KEY,
  PDF_TEXT_CONTENT_OPTIONS,
  type PdfBacklink,
  type PdfBacklinkOpenDetail,
  type PdfBacklinksUpdatedMessage,
  type PdfLocation,
  type PdfTextSelection
} from 'source/types/common/pdf-viewer'
import { toPdfTextItems, type PdfTextContentItem, type PdfTextItem } from 'source/common/modules/pdf-text'
import showPopupMenu, { type AnyMenuItem } from '@common/modules/window-register/application-menu-helper'
import { useDocumentTreeStore } from 'source/pinia'
import makeValidUri from 'source/common/util/make-valid-uri'
import { pathBasename } from 'source/common/util/renderer-path-polyfill'
import {
  AnnotationEditorType,
  AnnotationMode,
  EventBus,
  LinkTarget,
  PDFFindController,
  PDFJS_IMAGE_RESOURCES_PATH,
  PdfViewerLinkService,
  PDFViewer,
  type PDFDocumentProxy,
  type PDFLinkService
} from './pdfjs'
import {
  changeZoomKeepingPlace,
  FIT_ZOOM_VALUES,
  needsFitZoomUpdate,
  type PagesAreaSize
} from './zoom'
import {
  describePdfLoadError,
  loadPdfDocument,
  PdfLoadCancelledError,
  type PdfLoadHandle
} from './load-document'
import {
  buildSelectionRange,
  firstSelectionElement,
  getPageTextDivs,
  isPageTextLayerShown,
  PdfLocationHighlight
} from './location-highlight'
import { handlePdfLinkClick } from './external-links'
import {
  hasPdfSourceText,
  isPdfViewerRequestHandled,
  isSamePdfFilePath,
  isValidPdfSelection,
  markPdfViewerRequestHandled,
  parsePdfViewerRequest,
  resolveRequestedSelection,
  shouldReplayPdfViewerRequest,
  type PdfViewerRequestRecord
} from './viewer-request'
import {
  PDF_VIEWER_MAX_ZOOM,
  PDF_VIEWER_MIN_ZOOM,
  readPdfViewState,
  writePdfViewState
} from './view-state'
import {
  defaultPdfQuoteSettings,
  findPageNumberOfNode,
  quoteFromSelection,
  resolvePdfQuoteSelection,
  writePdfQuoteToClipboard,
  type PdfQuoteDocument,
  type PdfQuotePageSource,
  type PdfQuoteSettings
} from './copy-quote'
import { PdfBacklinkHighlights, type PdfBacklinkHit } from './backlink-highlight'
import { PdfBacklinkPopup } from './backlink-popup'
import PdfFindBar from './PdfFindBar.vue'
import PdfOutline from './PdfOutline.vue'
import PdfQuoteControls from './PdfQuoteControls.vue'

/**
 * Everything that belongs to the document currently shown. It is not
 * reactive: pdf.js keeps its state in private class fields, which a reactive
 * proxy cannot reach. Callbacks compare their session with the current one
 * to ignore results that arrive after another file has been opened.
 */
interface ViewerSession {
  filePath: string
  loadHandle: PdfLoadHandle
  // Aborting it removes all listeners this component added to the event bus
  listenerAbortController: AbortController
  pdfDocument: PDFDocumentProxy|null
  pdfViewer: PDFViewer|null
  linkService: PDFLinkService|null
  container: HTMLDivElement|null
  // True once the remembered page and zoom have been applied; until then,
  // page and zoom changes are not remembered
  restored: boolean
  // Page labels of the document (getPageLabels), null if it defines none
  pageLabels: string[]|null
  // Text items per page, read once for Copy as Quote and the backlink
  // highlights
  textItems: Map<number, Promise<PdfTextItem[]>>
  // The backlink highlights of the document (R62), once it is shown
  backlinkHighlights: PdfBacklinkHighlights|null
}

/**
 * The location highlight shown at the moment
 */
interface ActiveLocation {
  page: number
  selection: PdfTextSelection|undefined
  color: string|undefined
  // The view still has to scroll to the beginning of the range, which can
  // only happen once the page's text layer exists
  scrollPending: boolean
}

/**
 * A location request that arrived before the document was ready
 */
interface PendingLocation {
  filePath: string
  location: PdfLocation
  scroll: boolean
  // The quoted text below the link, if the request came with one
  sourceText: string|undefined
}

interface ZoomOption {
  value: string
  label: string
  // null for the zoom levels pdf.js computes from the page size
  scale: number|null
}

/**
 * PDFViewer.setDocument accepts null to close the document, although pdf.js
 * declares it for documents only (web/pdf_viewer.mjs, setDocument)
 */
interface ViewerWithNullableDocument {
  setDocument: (pdfDocument: PDFDocumentProxy|null) => void
}

const ZOOM_OPTIONS: ZoomOption[] = [
  { value: 'page-width', label: 'Page Width', scale: null },
  { value: 'page-fit', label: 'Page Fit', scale: null },
  { value: 'auto', label: 'Auto', scale: null },
  { value: '0.5', label: '50%', scale: 0.5 },
  { value: '0.75', label: '75%', scale: 0.75 },
  { value: '1', label: '100%', scale: 1 },
  { value: '1.25', label: '125%', scale: 1.25 },
  { value: '1.5', label: '150%', scale: 1.5 },
  { value: '2', label: '200%', scale: 2 },
  { value: '3', label: '300%', scale: 3 }
]

const CUSTOM_ZOOM_VALUE = 'custom'

// Two scales closer than this count as the same zoom option
const ZOOM_MATCH_TOLERANCE = 0.0005

// Milliseconds after the last page or zoom change before it is remembered
const VIEW_STATE_SAVE_DELAY = 300

// Milliseconds pdf.js waits after a wheel zoom before it redraws the pages
// sharply (in between, it only stretches what it has drawn)
const WHEEL_ZOOM_DRAWING_DELAY = 400

// Pixel deltas below this come from touchpad pinches or smooth-scrolling
// wheels and zoom continuously; larger ones are steps of a notched wheel
const SMOOTH_WHEEL_DELTA_LIMIT = 50

// A continuous zoom changes the scale by the factor exp(-deltaY / this)
const SMOOTH_WHEEL_SCALE_DIVISOR = 100

// Minimum milliseconds between two recomputations of Page Width, Page Fit or
// Auto while the size of the pages area keeps changing; the last change is
// always applied
const FIT_ZOOM_THROTTLE = 100

// Milliseconds between two comparisons of the pages area's size with the size
// Page Width, Page Fit or Auto was last computed for. The resize observer
// reports a new size only when the window draws a frame, which a hidden or
// covered window does not do.
const FIT_ZOOM_CHECK_INTERVAL = 500

// File paths of requests are compared without regard to case where the file
// system ignores it
const PATHS_IGNORE_CASE = process.platform === 'win32' || process.platform === 'darwin'

const props = defineProps<{
  leafId: string
  windowId: string
  activeFile: OpenDocument|null
  editorCommands: EditorCommands
  file: OpenDocument
}>()

const ipcRenderer = window.ipc
const documentTreeStore = useDocumentTreeStore()

const viewerRoot = ref<HTMLDivElement|null>(null)
const pagesHost = ref<HTMLDivElement|null>(null)
const findBar = ref<InstanceType<typeof PdfFindBar>|null>(null)

const errorMessage = ref<string>('')
const isLoading = ref<boolean>(false)
const pagesCount = ref<number>(0)
const currentPage = ref<number>(0)
const pageInputText = ref<string>('')
const currentScale = ref<number>(0)
const zoomSelectionState = ref<string>('')
const customZoomLabel = ref<string>('')
const sidebarVisible = ref<boolean>(false)
const findBarVisible = ref<boolean>(false)
// The settings of the quote controls (PdfQuoteControls emits them once
// mounted) and the message shown for two seconds after Copy as Quote
const quoteSettings = ref<PdfQuoteSettings>(defaultPdfQuoteSettings())
const quoteStatus = ref<string>('')
// Whether backlink highlights are shown (remembered for all PDFs) and how
// many backlinks of the document shown can be highlighted
const backlinksVisible = ref<boolean>(readBacklinksVisible())
const backlinkCount = ref<number>(0)

// The pdf.js objects handed to the outline and the find bar. Shallow refs
// keep Vue from wrapping them in deep reactive proxies.
const viewerDocument = shallowRef<PDFDocumentProxy|null>(null)
const viewerLinkService = shallowRef<PDFLinkService|null>(null)
const viewerEventBus = shallowRef<EventBus|null>(null)
const viewerFindController = shallowRef<PDFFindController|null>(null)

const documentReady = computed<boolean>(() => pagesCount.value > 0 && errorMessage.value === '')

const backlinksButtonTitle = computed<string>(() => {
  const title = 'Show highlights for passages quoted in your notes'
  return backlinkCount.value > 0 ? `${title} (${backlinkCount.value})` : title
})

const zoomSelection = computed<string>({
  get: () => zoomSelectionState.value,
  set: (value: string) => {
    const pdfViewer = currentViewer()
    if (pdfViewer === null || value === CUSTOM_ZOOM_VALUE) {
      return
    }

    // Set first: pdf.js reports no change when the new zoom equals the
    // current scale, and the select must keep showing what was picked
    zoomSelectionState.value = value
    changeZoomKeepingPlace(pdfViewer, () => { pdfViewer.currentScaleValue = value })
  }
})

let session: ViewerSession|null = null
let activeLocation: ActiveLocation|null = null
let pendingLocation: PendingLocation|null = null
let saveTimer: ReturnType<typeof setTimeout>|undefined
let pageInputFocused = false
let resizeObserver: ResizeObserver|null = null
let fitZoomTimer: ReturnType<typeof setTimeout>|undefined
let lastFitZoomUpdate = 0
let fitZoomCheckTimer: ReturnType<typeof setInterval>|undefined
// The size of the pages area when applyContainerSize last ran, null until it
// has run for the document shown
let appliedPagesAreaSize: PagesAreaSize|null = null
// Counts the locations shown and removed, so that a location whose page text
// is still being read is dropped once a newer one has been shown or removed
let locationRequestNumber = 0
let quoteStatusTimer: ReturnType<typeof setTimeout>|undefined
// The link target Auto-copy copied last, so that releasing the mouse again on
// the same selection does not copy it again
let lastAutoCopiedTarget = ''
// Whether the left mouse button went down on the pages; only then does
// releasing it (anywhere in the viewer) count as the end of a selection
let selectionGestureOnPages = false
// Set by a double click that opened a backlink's note, so that releasing the
// mouse button afterwards does not run Auto-copy
let skipNextAutoCopy = false
// Counts the backlink requests sent, so that an answer is dropped once a
// newer request has been sent or the document has been closed
let backlinkRequestNumber = 0
// The hover popup of the backlink highlights, created once mounted
let backlinkPopup: PdfBacklinkPopup|null = null
// The latest mouse move over the pages and the animation frame that handles
// it; the hit test runs at most once per frame
let backlinkHoverEvent: MouseEvent|null = null
let backlinkHoverFrame: number|undefined
const locationHighlight = new PdfLocationHighlight()
const stopListening: Array<() => void> = []

function currentViewer (): PDFViewer|null {
  return session?.pdfViewer ?? null
}

// BEGIN: OPENING AND CLOSING DOCUMENTS

/**
 * Shows the PDF at an absolute path, closing the document shown before
 *
 * @param   {string}  filePath  The absolute path of the PDF
 */
function openFile (filePath: string): void {
  closeSession()
  errorMessage.value = ''
  isLoading.value = true
  findBarVisible.value = false
  if (pendingLocation !== null && pendingLocation.filePath !== filePath) {
    pendingLocation = null
  }

  const loadHandle = loadPdfDocument(filePath)
  const newSession: ViewerSession = {
    filePath,
    loadHandle,
    listenerAbortController: new AbortController(),
    pdfDocument: null,
    pdfViewer: null,
    linkService: null,
    container: null,
    restored: false,
    pageLabels: null,
    textItems: new Map(),
    backlinkHighlights: null
  }
  session = newSession

  loadHandle.promise.then(pdfDocument => {
    if (session !== newSession) {
      // pdf.js 6 destroys a document through its loading task
      newSession.loadHandle.cancel()
      return
    }

    showDocument(newSession, pdfDocument)
  }).catch((error: unknown) => {
    if (error instanceof PdfLoadCancelledError || session !== newSession) {
      return
    }

    console.error(`Could not open the PDF ${filePath}`, error)
    errorMessage.value = describePdfLoadError(error)
    isLoading.value = false
  })
}

/**
 * Sets up a new scroll container and pdf.js viewer for a loaded document
 *
 * @param   {ViewerSession}     current      The session the document belongs to
 * @param   {PDFDocumentProxy}  pdfDocument  The loaded document
 */
function showDocument (current: ViewerSession, pdfDocument: PDFDocumentProxy): void {
  current.pdfDocument = pdfDocument
  // The page labels name the pages in the link text of Copy as Quote
  pdfDocument.getPageLabels().then(labels => {
    current.pageLabels = labels
  }).catch((error: unknown) => console.error(`Could not read the page labels of ${current.filePath}`, error))

  const host = pagesHost.value
  if (host === null) {
    return
  }

  // pdf.js requires an absolutely positioned container whose first child is
  // the element with the class pdfViewer
  const container = document.createElement('div')
  container.className = 'pdfjs-viewer-scroll'
  // Focusable, so that clicks on the pages keep the keyboard in the viewer
  container.tabIndex = -1
  const viewerElement = document.createElement('div')
  viewerElement.className = 'pdfViewer'
  container.appendChild(viewerElement)
  host.appendChild(container)
  current.container = container
  container.addEventListener('scroll', hideBacklinkPopup, { signal: current.listenerAbortController.signal })

  try {
    const eventBus = new EventBus()
    const linkService = new PdfViewerLinkService({ eventBus, externalLinkTarget: LinkTarget.NONE })
    const findController = new PDFFindController({ linkService, eventBus })
    // No abortSignal: pdf.js shares one document-wide selection listener
    // between all viewers, bound to the signal of the first viewer, which
    // would break text selection in every other PDF once that signal fires.
    // setDocument(null) in closeSession() releases everything instead.
    const pdfViewer = new PDFViewer({
      container,
      viewer: viewerElement,
      eventBus,
      linkService,
      findController,
      annotationMode: AnnotationMode.ENABLE,
      annotationEditorMode: AnnotationEditorType.DISABLE,
      imageResourcesPath: PDFJS_IMAGE_RESOURCES_PATH
    })
    linkService.setViewer(pdfViewer)
    current.pdfViewer = pdfViewer
    current.linkService = linkService

    addViewerListeners(current, eventBus)
    pdfViewer.setDocument(pdfDocument)
    linkService.setDocument(pdfDocument, null)

    // Rejects if pdf.js cannot set up the pages (e.g., the first page cannot
    // be read); pagesinit never arrives in that case
    const pagesPromise: unknown = pdfViewer.pagesPromise
    if (pagesPromise instanceof Promise) {
      pagesPromise.catch((error: unknown) => {
        if (session !== current || current.restored) {
          return
        }

        console.error(`Could not show the pages of the PDF ${current.filePath}`, error)
        errorMessage.value = describePdfLoadError(error)
        isLoading.value = false
      })
    }

    viewerDocument.value = pdfDocument
    viewerLinkService.value = linkService
    viewerEventBus.value = eventBus
    viewerFindController.value = findController

    current.backlinkHighlights = new PdfBacklinkHighlights({
      textItemsOfPage: quoteDocument(current, pdfDocument).textItemsOfPage,
      getPageView: (pageNumber: number) => current.pdfViewer?.getPageView(pageNumber - 1)
    })
    // The remembered state first, so that hidden highlights are never drawn
    current.backlinkHighlights.setVisible(backlinksVisible.value).catch((error: unknown) => console.error(error))
    requestBacklinks(current)
  } catch (error: unknown) {
    console.error(`Could not start the PDF viewer for ${current.filePath}`, error)
    const message = error instanceof Error ? error.message : String(error)
    errorMessage.value = `The PDF viewer could not be started: ${message}`
    isLoading.value = false
  }
}

/**
 * Closes the document shown, after remembering its page and zoom, and
 * releases everything pdf.js holds for it
 */
function closeSession (): void {
  saveViewState()

  const current = session
  session = null
  locationHighlight.clear()
  activeLocation = null
  locationRequestNumber++
  clearTimeout(fitZoomTimer)
  fitZoomTimer = undefined
  appliedPagesAreaSize = null

  viewerDocument.value = null
  viewerLinkService.value = null
  viewerEventBus.value = null
  viewerFindController.value = null
  pagesCount.value = 0
  currentPage.value = 0
  pageInputText.value = ''
  currentScale.value = 0
  zoomSelectionState.value = ''
  customZoomLabel.value = ''
  backlinkRequestNumber++
  backlinkCount.value = 0
  hideBacklinkPopup()

  if (current === null) {
    return
  }

  current.backlinkHighlights?.clear()
  current.listenerAbortController.abort()
  try {
    // Cancels all rendering and text layers and removes the listeners pdf.js
    // registered for this document
    if (current.pdfViewer !== null) {
      (current.pdfViewer as unknown as ViewerWithNullableDocument).setDocument(null)
    }
    current.linkService?.setDocument(null)
  } catch (error: unknown) {
    console.error('Could not close the PDF viewer', error)
  }

  // Destroys the document together with its loading task
  current.loadHandle.cancel()
  current.container?.remove()
}

// END: OPENING AND CLOSING DOCUMENTS

// BEGIN: PDF.JS EVENTS

/**
 * Subscribes to the events of a document's event bus
 *
 * @param   {ViewerSession}  current   The session of the document
 * @param   {EventBus}       eventBus  Its event bus
 */
function addViewerListeners (current: ViewerSession, eventBus: EventBus): void {
  const options = { signal: current.listenerAbortController.signal }

  eventBus.on('pagesinit', () => {
    handlePagesInit(current)
  }, options)

  eventBus.on('pagechanging', (event: { pageNumber: number }) => {
    if (session !== current) {
      return
    }

    currentPage.value = event.pageNumber
    if (!pageInputFocused) {
      pageInputText.value = String(event.pageNumber)
    }

    if (current.restored) {
      scheduleViewStateSave()
    }
  }, options)

  eventBus.on('scalechanging', (event: { scale: number, presetValue?: string }) => {
    if (session !== current) {
      return
    }

    updateZoomDisplay(event.scale, event.presetValue)
    hideBacklinkPopup()
    if (current.restored) {
      scheduleViewStateSave()
    }
  }, options)

  eventBus.on('textlayerrendered', (event: { pageNumber: number }) => {
    if (session !== current) {
      return
    }

    if (activeLocation !== null && activeLocation.page === event.pageNumber) {
      refreshLocationHighlight()
    }

    const pageView: unknown = current.pdfViewer?.getPageView(event.pageNumber - 1)
    current.backlinkHighlights?.rebuildPage(event.pageNumber, getPageTextDivs(pageView), pageView)
      .catch((error: unknown) => console.error(error))
  }, options)

  // pdf.js' find highlighting replaces the text nodes of the text layer, which
  // invalidates the ranges of the location and backlink highlights; rebuild
  // them afterwards
  eventBus.on('updatetextlayermatches', () => {
    setTimeout(() => {
      if (session === current) {
        refreshLocationHighlight()
        current.backlinkHighlights?.rebuildAllRendered().catch((error: unknown) => console.error(error))
      }
    }, 0)
  }, options)
}

/**
 * The pages have been set up: restore the remembered page and zoom, and show
 * a location that was requested while the document was loading, or else a
 * recent request that arrived before this viewer could take it
 *
 * @param   {ViewerSession}  current  The session of the document
 */
function handlePagesInit (current: ViewerSession): void {
  const pdfViewer = current.pdfViewer
  if (session !== current || pdfViewer === null) {
    return
  }

  const state = readPdfViewState(window.localStorage, current.filePath)
  pagesCount.value = pdfViewer.pagesCount
  pdfViewer.currentScale = state.zoom
  pdfViewer.currentPageNumber = Math.min(state.page, pdfViewer.pagesCount)

  currentPage.value = pdfViewer.currentPageNumber
  if (!pageInputFocused) {
    pageInputText.value = String(pdfViewer.currentPageNumber)
  }
  updateZoomDisplay(pdfViewer.currentScale, undefined)

  current.restored = true
  isLoading.value = false

  const pending = pendingLocation
  pendingLocation = null
  if (pending !== null && pending.filePath === current.filePath) {
    showLocation(pending.location, pending.scroll, pending.sourceText)
  } else {
    replayRecentRequest()
  }
}

/**
 * Shows a scale in the zoom select: one of the options if it stands for the
 * scale, otherwise the scale in percent
 *
 * @param   {number}            scale        The scale pdf.js uses now
 * @param   {string|undefined}  presetValue  The zoom level pdf.js computed the
 *                                           scale from, if any
 */
function updateZoomDisplay (scale: number, presetValue: string|undefined): void {
  currentScale.value = scale
  customZoomLabel.value = `${Math.round(scale * 100)}%`

  if (presetValue !== undefined && FIT_ZOOM_VALUES.includes(presetValue)) {
    zoomSelectionState.value = presetValue
    return
  }

  const match = ZOOM_OPTIONS.find(option => option.scale !== null && Math.abs(option.scale - scale) < ZOOM_MATCH_TOLERANCE)
  zoomSelectionState.value = match !== undefined ? match.value : CUSTOM_ZOOM_VALUE
}

// END: PDF.JS EVENTS

// BEGIN: READING POSITION MEMORY

function scheduleViewStateSave (): void {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(saveViewState, VIEW_STATE_SAVE_DELAY)
}

/**
 * Remembers the page and zoom of the document shown, right away. The zoom is
 * always remembered as a number, also when it was computed from a zoom level
 * such as Page Width.
 */
function saveViewState (): void {
  clearTimeout(saveTimer)
  saveTimer = undefined

  const current = session
  if (current === null || current.pdfViewer === null || !current.restored) {
    return
  }

  const zoom = Math.min(Math.max(current.pdfViewer.currentScale, PDF_VIEWER_MIN_ZOOM), PDF_VIEWER_MAX_ZOOM)
  writePdfViewState(window.localStorage, current.filePath, {
    page: current.pdfViewer.currentPageNumber,
    zoom
  })
}

// END: READING POSITION MEMORY

// BEGIN: TOOLBAR

function toggleSidebar (): void {
  sidebarVisible.value = !sidebarVisible.value
  // The pages area has its new width once Vue has shown or hidden the
  // sidebar; this does not wait for the resize observer, whose callbacks
  // depend on the window drawing frames
  void nextTick(() => { scheduleFitZoomUpdate() })
}

function goToPreviousPage (): void {
  currentViewer()?.previousPage()
}

function goToNextPage (): void {
  currentViewer()?.nextPage()
}

/**
 * Goes to a page; numbers outside the document go to the first or last page
 *
 * @param   {number}  pageNumber  The page number, from 1
 */
function goToPage (pageNumber: number): void {
  const pdfViewer = currentViewer()
  if (pdfViewer === null || pdfViewer.pagesCount === 0) {
    return
  }

  pdfViewer.currentPageNumber = Math.min(Math.max(pageNumber, 1), pdfViewer.pagesCount)
}

function zoomOut (): void {
  const pdfViewer = currentViewer()
  if (pdfViewer !== null) {
    changeZoomKeepingPlace(pdfViewer, () => { pdfViewer.decreaseScale() })
  }
}

function zoomIn (): void {
  const pdfViewer = currentViewer()
  if (pdfViewer !== null) {
    changeZoomKeepingPlace(pdfViewer, () => { pdfViewer.increaseScale() })
  }
}

function handlePageInput (event: Event): void {
  pageInputText.value = (event.target as HTMLInputElement).value
}

function handlePageInputFocus (event: FocusEvent): void {
  pageInputFocused = true
  const input = event.target as HTMLInputElement
  input.select()
}

function handlePageInputBlur (): void {
  pageInputFocused = false
  pageInputText.value = currentPage.value > 0 ? String(currentPage.value) : ''
}

/**
 * Enter goes to the page typed in and keeps the focus in the input, Escape
 * discards the input and returns the focus to the pages
 *
 * @param   {KeyboardEvent}  event  The keydown event of the page input
 */
function handlePageInputKeydown (event: KeyboardEvent): void {
  if (event.isComposing) {
    return
  }

  const input = event.target as HTMLInputElement
  if (event.key === 'Enter') {
    event.preventDefault()
    const pageNumber = Number.parseInt(pageInputText.value.trim(), 10)
    if (Number.isInteger(pageNumber)) {
      goToPage(pageNumber)
    }

    pageInputText.value = String(currentPage.value)
    // Select after Vue has written the new text into the input
    void nextTick(() => { input.select() })
  } else if (event.key === 'Escape') {
    event.preventDefault()
    pageInputText.value = String(currentPage.value)
    focusPages()
  }
}

/**
 * Hands the file to the system's default application. Navigating the window
 * to the file's URL is cancelled by the main process, which opens the file
 * instead (attach-app-navigation-handlers.ts; the same as in ImageViewer).
 */
function openInDefaultApp (): void {
  window.location.href = makeValidUri(props.file.path)
}

function focusPages (): void {
  session?.container?.focus({ preventScroll: true })
}

// END: TOOLBAR

// BEGIN: FIND BAR

function openFindBar (): void {
  if (viewerEventBus.value === null) {
    return
  }

  findBarVisible.value = true
  void nextTick(() => { findBar.value?.focus() })
}

function closeFindBar (): void {
  findBarVisible.value = false
  focusPages()
}

/**
 * Decides whether a Ctrl+F that reached the window through the main menu
 * (IPC `shortcut`, command `search`) is meant for this viewer
 *
 * @return  {boolean}  True if this viewer should open its find bar
 */
function ownsFindShortcut (): boolean {
  const root = viewerRoot.value
  if (root === null || session === null || props.activeFile?.path !== props.file.path) {
    return false
  }

  const activeElement = document.activeElement
  if (activeElement !== null && root.contains(activeElement)) {
    return true
  }

  // An editor, the JSON viewer, or another PDF viewer has the focus and
  // handles the shortcut itself
  if (activeElement !== null && activeElement.closest('.cm-editor, .pdfjs-viewer') !== null) {
    return false
  }

  return documentTreeStore.lastLeafId === props.leafId
}

// END: FIND BAR

// BEGIN: COPY AS QUOTE (R60)

function handleQuoteSettingsChange (settings: PdfQuoteSettings): void {
  quoteSettings.value = settings
}

/**
 * The pages of a session as copy-quote.ts sees them
 *
 * @param   {ViewerSession}       current  The session of the document
 *
 * @return  {PdfQuotePageSource}           Page lookup and text layer elements
 */
function quotePageSource (current: ViewerSession): PdfQuotePageSource {
  return {
    pageNumberOfNode: (node: Node) => current.container === null ? null : findPageNumberOfNode(node, current.container),
    textDivsOfPage: (pageNumber: number) => {
      const pdfViewer = current.pdfViewer
      if (pdfViewer === null || pageNumber < 1 || pageNumber > pdfViewer.pagesCount) {
        return null
      }
      return getPageTextDivs(pdfViewer.getPageView(pageNumber - 1))
    }
  }
}

/**
 * The document of a session as copy-quote.ts sees it. The text items of a
 * page are read once and kept for the session; a failed read is not kept.
 *
 * @param   {ViewerSession}     current      The session of the document
 * @param   {PDFDocumentProxy}  pdfDocument  Its document
 *
 * @return  {PdfQuoteDocument}               Path, text items and page labels
 */
function quoteDocument (current: ViewerSession, pdfDocument: PDFDocumentProxy): PdfQuoteDocument {
  return {
    filePath: current.filePath,
    textItemsOfPage: async (pageNumber: number) => {
      let items = current.textItems.get(pageNumber)
      if (items === undefined) {
        const reading = pdfDocument.getPage(pageNumber)
          .then(page => page.getTextContent(PDF_TEXT_CONTENT_OPTIONS))
          .then(content => toPdfTextItems(content.items as PdfTextContentItem[]))
        current.textItems.set(pageNumber, reading)
        reading.catch(() => {
          if (current.textItems.get(pageNumber) === reading) {
            current.textItems.delete(pageNumber)
          }
        })
        items = reading
      }
      return await items
    },
    pageLabelOfPage: (pageNumber: number) => current.pageLabels?.[pageNumber - 1] ?? null
  }
}

/**
 * Copies the selection (or the given range) as a quote in PDF++'s "Quote in
 * callout" format. Explicit requests (shortcut, menu) report why nothing was
 * copied; Auto-copy stays silent unless it copied something.
 *
 * @param   {'shortcut'|'menu'|'auto'}  trigger  What asked for the copy
 * @param   {Range|null}                range    The range to copy; the live
 *                                               selection if not given
 */
async function copySelectionAsQuote (trigger: 'shortcut'|'menu'|'auto', range?: Range|null): Promise<void> {
  const current = session
  if (current === null || current.pdfViewer === null || current.pdfDocument === null) {
    return
  }

  let selectedRange = range ?? null
  if (range === undefined) {
    const selection = window.getSelection()
    selectedRange = selection !== null && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
  }

  // quoteFromSelection converts the range before its first await, so the
  // live selection's range may be passed
  const result = await quoteFromSelection(selectedRange, quotePageSource(current), quoteDocument(current, current.pdfDocument), quoteSettings.value.color)
  if (session !== current) {
    return
  }

  if (result.status === 'quoted') {
    if (trigger === 'auto' && result.quote.linkTarget === lastAutoCopiedTarget) {
      return // The same selection again, e.g. after a click beside the text
    }

    try {
      await writePdfQuoteToClipboard(result.quote)
    } catch (error: unknown) {
      console.error('Could not write the quote to the clipboard', error)
      showQuoteStatus('Could not copy the quote to the clipboard')
      return
    }

    lastAutoCopiedTarget = trigger === 'auto' ? result.quote.linkTarget : ''
    showQuoteStatus('Copied as quote')
    return
  }

  // Auto-copy reports nothing else
  if (trigger === 'auto') {
    return
  }

  if (result.status === 'multiple-pages') {
    showQuoteStatus('Select text on one page to copy it as a quote')
  } else if (result.status === 'no-text-layer') {
    showQuoteStatus('This page has no text to quote')
  } else {
    showQuoteStatus('Select text in the PDF to copy it as a quote')
  }
}

/**
 * Shows a message next to the quote controls for two seconds
 *
 * @param   {string}  message  The message
 */
function showQuoteStatus (message: string): void {
  quoteStatus.value = message
  clearTimeout(quoteStatusTimer)
  quoteStatusTimer = setTimeout(() => {
    quoteStatus.value = ''
    quoteStatusTimer = undefined
  }, 2000)
}

/**
 * Remembers whether the left mouse button went down on the pages, so that
 * Auto-copy only follows a selection made there
 *
 * @param   {MouseEvent}  event  A mousedown event inside the viewer
 */
function handleViewerMouseDown (event: MouseEvent): void {
  // A double click on a backlink highlight opens the note instead of
  // selecting a word (contract C11, section "双击跳回笔记")
  if (event.button === 0 && event.detail === 2) {
    const hits = backlinkHitsAt(event)
    if (hits.length > 0) {
      event.preventDefault()
      skipNextAutoCopy = true
      selectionGestureOnPages = false
      window.getSelection()?.removeAllRanges()
      hideBacklinkPopup()
      openBacklink(hits[0])
      return
    }
  }

  // A release outside the window may have left the flag set
  skipNextAutoCopy = false
  const host = pagesHost.value
  selectionGestureOnPages = event.button === 0 && host !== null && event.target instanceof Node && host.contains(event.target)
}

/**
 * Auto-copy: releasing the left mouse button after selecting text on the
 * pages copies it as a quote. It listens on the whole viewer, so that a drag
 * that ends over the toolbar, the outline or the find bar counts as well.
 *
 * @param   {MouseEvent}  event  A mouseup event inside the viewer
 */
function handleViewerMouseUp (event: MouseEvent): void {
  if (skipNextAutoCopy) {
    skipNextAutoCopy = false
    selectionGestureOnPages = false
    return
  }

  const startedOnPages = selectionGestureOnPages
  selectionGestureOnPages = false
  if (!startedOnPages || !quoteSettings.value.autoCopy || event.button !== 0) {
    return
  }

  // The selection is final only after the mouseup has been processed
  setTimeout(() => {
    const selection = window.getSelection()
    if (selection === null || selection.isCollapsed || selection.rangeCount === 0) {
      return
    }
    copySelectionAsQuote('auto').catch((error: unknown) => console.error(error))
  }, 0)
}

/**
 * Shows the context menu of a selection on the pages: Copy as Quote (grayed
 * out for a selection that spans pages) and Copy. Without a selection on the
 * pages, the event is left alone.
 *
 * @param   {MouseEvent}  event  The contextmenu event of the pages area
 */
function handlePagesContextMenu (event: MouseEvent): void {
  const current = session
  const selection = window.getSelection()
  if (current === null || selection === null || selection.rangeCount === 0 || selection.isCollapsed) {
    return
  }

  // The selection may have changed by the time a menu item is clicked
  const range = selection.getRangeAt(0).cloneRange()
  const resolved = resolvePdfQuoteSelection(range, quotePageSource(current))
  if (resolved.status === 'empty' || resolved.status === 'outside') {
    return
  }

  event.preventDefault()
  const items: AnyMenuItem[] = [
    {
      id: 'copy-as-quote',
      label: 'Copy as Quote',
      accelerator: 'CmdOrCtrl+Shift+C',
      type: 'normal',
      enabled: resolved.status === 'selected'
    },
    {
      id: 'copy',
      label: 'Copy',
      accelerator: 'CmdOrCtrl+C',
      type: 'normal'
    }
  ]

  showPopupMenu({ x: event.clientX, y: event.clientY }, items, (clickedId: string) => {
    if (clickedId === 'copy-as-quote') {
      copySelectionAsQuote('menu', range).catch((error: unknown) => console.error(error))
    } else if (clickedId === 'copy') {
      // Restore the selection and let Chromium copy it, so that pdf.js' own
      // copy handling still applies
      const liveSelection = window.getSelection()
      liveSelection?.removeAllRanges()
      liveSelection?.addRange(range)
      ipcRenderer.send('window-controls', { command: 'copy' })
    }
  })
}

// END: COPY AS QUOTE

// BEGIN: BACKLINK HIGHLIGHTS (R62, contract C11)

/**
 * Reads whether backlink highlights are shown; they are unless switched off
 *
 * @return  {boolean}  The remembered state
 */
function readBacklinksVisible (): boolean {
  try {
    return window.localStorage.getItem(PDF_BACKLINKS_VISIBLE_STORAGE_KEY) !== 'false'
  } catch (error: unknown) {
    console.error('Could not read whether PDF backlink highlights are shown', error)
    return true
  }
}

/**
 * The toolbar button: shows or hides the backlink highlights, for all PDFs
 */
function toggleBacklinks (): void {
  const visible = !backlinksVisible.value
  backlinksVisible.value = visible
  try {
    window.localStorage.setItem(PDF_BACKLINKS_VISIBLE_STORAGE_KEY, String(visible))
  } catch (error: unknown) {
    console.error('Could not remember whether PDF backlink highlights are shown', error)
  }

  if (!visible) {
    hideBacklinkPopup()
  }
  session?.backlinkHighlights?.setVisible(visible).catch((error: unknown) => console.error(error))
}

/**
 * Asks the main process' index for the backlinks of a session's PDF and
 * highlights them. An answer that arrives after a newer request or after the
 * document was closed is dropped.
 *
 * @param   {ViewerSession}  current  The session of the document
 */
function requestBacklinks (current: ViewerSession): void {
  const highlights = current.backlinkHighlights
  if (highlights === null) {
    return
  }

  backlinkRequestNumber++
  const requestNumber = backlinkRequestNumber
  ipcRenderer.invoke('pdf-backlink-provider', {
    command: 'get-pdf-backlinks',
    payload: { pdfPath: current.filePath }
  } as PdfBacklinkProviderAPI).then(async (backlinks: PdfBacklink[]|undefined) => {
    if (session !== current || requestNumber !== backlinkRequestNumber) {
      return
    }

    const highlighting = highlights.setBacklinks(Array.isArray(backlinks) ? backlinks : [])
    // setBacklinks has sorted the backlinks by page before its first await
    backlinkCount.value = highlights.highlightableCount
    await highlighting
  }).catch((error: unknown) => console.error(`Could not read the backlinks of ${current.filePath}`, error))
}

/**
 * The index reports changed backlinks: request them again if they concern
 * the document shown (null stands for every PDF)
 *
 * @param   {PdfBacklinksUpdatedMessage}  message  The broadcast
 */
function handleBacklinksUpdated (message: PdfBacklinksUpdatedMessage): void {
  const current = session
  if (current === null || current.backlinkHighlights === null) {
    return
  }

  const pdfPaths = message.pdfPaths
  if (pdfPaths === null || pdfPaths.some(pdfPath => isSamePdfFilePath(pdfPath, current.filePath, PATHS_IGNORE_CASE))) {
    requestBacklinks(current)
  }
}

/**
 * The backlinks whose highlights lie under the mouse
 *
 * @param   {MouseEvent}        event  A mouse event over the pages
 *
 * @return  {PdfBacklinkHit[]}         The hits, ordered by note path and line
 */
function backlinkHitsAt (event: MouseEvent): PdfBacklinkHit[] {
  const current = session
  const highlights = current?.backlinkHighlights ?? null
  if (current === null || highlights === null || current.container === null) {
    return []
  }

  const pageNumber = event.target instanceof Node ? findPageNumberOfNode(event.target, current.container) : null
  return highlights.hitTest(event.clientX, event.clientY, pageNumber ?? undefined)
}

/**
 * Reports mouse moves over the pages to the hover popup, at most once per
 * animation frame. While a mouse button is held (e.g. selecting text), no
 * highlight counts as hovered.
 *
 * @param   {MouseEvent}  event  A mousemove event of the pages area
 */
function handlePagesMouseMove (event: MouseEvent): void {
  backlinkHoverEvent = event
  if (backlinkHoverFrame !== undefined) {
    return
  }

  backlinkHoverFrame = requestAnimationFrame(() => {
    backlinkHoverFrame = undefined
    const latest = backlinkHoverEvent
    backlinkHoverEvent = null
    if (latest === null || backlinkPopup === null) {
      return
    }

    const hits = latest.buttons === 0 ? backlinkHitsAt(latest) : []
    backlinkPopup.hover(hits, latest.clientX, latest.clientY)
  })
}

function handlePagesMouseLeave (): void {
  cancelBacklinkHoverFrame()
  backlinkPopup?.leave()
}

function cancelBacklinkHoverFrame (): void {
  if (backlinkHoverFrame !== undefined) {
    cancelAnimationFrame(backlinkHoverFrame)
    backlinkHoverFrame = undefined
  }
  backlinkHoverEvent = null
}

function hideBacklinkPopup (): void {
  backlinkPopup?.hide()
}

/**
 * Asks App.vue to open the note of a backlink beside this viewer and to jump
 * to the link's line
 *
 * @param   {PdfBacklinkHit}  hit  The backlink to open
 */
function openBacklink (hit: PdfBacklinkHit): void {
  const detail: PdfBacklinkOpenDetail = {
    notePath: hit.backlink.notePath,
    lineNumber: hit.backlink.line,
    pdfLeafId: props.leafId
  }
  window.dispatchEvent(new CustomEvent<PdfBacklinkOpenDetail>(PDF_BACKLINK_OPEN_EVENT, { detail }))
}

// END: BACKLINK HIGHLIGHTS

// BEGIN: KEYBOARD, WHEEL AND FOCUS

/**
 * Ctrl+F opens the find bar anywhere in the viewer; Page Up, Page Down, Home
 * and End go to the previous, next, first and last page while the focus is
 * on the pages
 *
 * @param   {KeyboardEvent}  event  A keydown event inside the viewer
 */
function handleKeydown (event: KeyboardEvent): void {
  if (event.isComposing) {
    return
  }

  const hasPrimaryModifier = event.ctrlKey || event.metaKey
  if (hasPrimaryModifier && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
    if (viewerEventBus.value === null) {
      return
    }

    // Handling it here also keeps the menu's Ctrl+F from firing
    event.preventDefault()
    openFindBar()
    return
  }

  // Ctrl+Shift+C copies the selection as a quote; no menu item uses it, and
  // the editors' Mod-Shift-c only applies while an editor has the focus
  if (hasPrimaryModifier && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'c') {
    event.preventDefault()
    copySelectionAsQuote('shortcut').catch((error: unknown) => console.error(error))
    return
  }

  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
    return
  }

  const host = pagesHost.value
  if (host === null || !(event.target instanceof Node) || !host.contains(event.target)) {
    return
  }

  const pdfViewer = currentViewer()
  if (pdfViewer === null || pdfViewer.pagesCount === 0) {
    return
  }

  switch (event.key) {
    case 'PageUp':
      pdfViewer.previousPage()
      break
    case 'PageDown':
      pdfViewer.nextPage()
      break
    case 'Home':
      goToPage(1)
      break
    case 'End':
      goToPage(pdfViewer.pagesCount)
      break
    default:
      return
  }

  event.preventDefault()
}

/**
 * Ctrl plus the mouse wheel zooms around the mouse pointer: one notch of a
 * mouse wheel is one zoom step, touchpad pinches and smooth-scrolling wheels
 * zoom continuously
 *
 * @param   {WheelEvent}  event  A wheel event over the pages
 */
function handleWheel (event: WheelEvent): void {
  // Only plain Ctrl plus wheel zooms; everything else scrolls as usual
  if (!event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) {
    return
  }

  // Also keeps Chromium from zooming the whole window
  event.preventDefault()

  const current = session
  if (current === null || current.pdfViewer === null || current.container === null || !current.restored || event.deltaY === 0) {
    return
  }

  // pdf.js subtracts the container's offset within its offset parent from the
  // origin, so the origin is the pointer position relative to the container
  // plus that offset
  const pdfViewer = current.pdfViewer
  const [ top, left ] = pdfViewer.containerTopLeft
  const rect = current.container.getBoundingClientRect()
  const origin = [ event.clientX - rect.left + left, event.clientY - rect.top + top ]

  if (event.deltaMode === WheelEvent.DOM_DELTA_PIXEL && Math.abs(event.deltaY) < SMOOTH_WHEEL_DELTA_LIMIT) {
    changeZoomKeepingPlace(pdfViewer, () => {
      pdfViewer.updateScale({
        scaleFactor: Math.exp(-event.deltaY / SMOOTH_WHEEL_SCALE_DIVISOR),
        origin,
        drawingDelay: WHEEL_ZOOM_DRAWING_DELAY
      })
    })
  } else {
    changeZoomKeepingPlace(pdfViewer, () => {
      pdfViewer.updateScale({
        steps: event.deltaY < 0 ? 1 : -1,
        origin,
        drawingDelay: WHEEL_ZOOM_DRAWING_DELAY
      })
    })
  }
}

/**
 * Tells the main process that this leaf has the focus, as the editors do, so
 * that the last focused leaf follows clicks into the viewer
 */
function reportFocus (): void {
  if (documentTreeStore.lastLeafId === props.leafId) {
    return
  }

  ipcRenderer.invoke('documents-provider', {
    command: 'focus-leaf',
    payload: { leafId: props.leafId, windowId: props.windowId }
  } as DocumentManagerIPCAPI).catch(error => console.error(error))
}

/**
 * Applies a new size of the pages area right away, or, if it was applied less
 * than FIT_ZOOM_THROTTLE milliseconds ago, once that time has passed. Changes
 * in between (dragging a divider, resizing the window) are merged into the
 * last one. It does not wait for an animation frame.
 */
function scheduleFitZoomUpdate (): void {
  if (fitZoomTimer !== undefined) {
    return
  }

  const wait = Math.min(lastFitZoomUpdate + FIT_ZOOM_THROTTLE - Date.now(), FIT_ZOOM_THROTTLE)
  if (wait <= 0) {
    applyContainerSize()
    return
  }

  fitZoomTimer = setTimeout(() => {
    fitZoomTimer = undefined
    applyContainerSize()
  }, wait)
}

/**
 * Computes the zoom levels Page Width, Page Fit and Auto again for the
 * current size of the pages area, keeping the place shown, and lets pdf.js
 * render pages that have come into view. A hidden viewer (zero size) is left
 * alone; it is updated when it is shown again.
 */
function applyContainerSize (): void {
  lastFitZoomUpdate = Date.now()

  const current = session
  const host = pagesHost.value
  const pdfViewer = current?.pdfViewer ?? null
  if (current === null || pdfViewer === null || !current.restored || pdfViewer.pagesCount === 0) {
    return
  }

  if (host === null || host.clientWidth === 0 || host.clientHeight === 0) {
    return
  }

  appliedPagesAreaSize = { width: host.clientWidth, height: host.clientHeight }

  // Setting the zoom scrolls back to the place pdf.js last recorded, which it
  // otherwise records only in an animation frame after scrolling; recording
  // it now keeps the view from jumping back to an earlier page
  changeZoomKeepingPlace(pdfViewer, () => {
    const scaleValue = pdfViewer.currentScaleValue
    if (FIT_ZOOM_VALUES.includes(scaleValue)) {
      pdfViewer.currentScaleValue = scaleValue
    }
  })
}

/**
 * Called by the resize observer of the pages area (opening or closing the
 * outline, dragging a divider, resizing the window)
 */
function handleResize (): void {
  scheduleFitZoomUpdate()
}

/**
 * Called every FIT_ZOOM_CHECK_INTERVAL milliseconds: applies a size of the
 * pages area that Page Width, Page Fit or Auto has not been computed for yet,
 * in case the resize observer has not reported it (it reports only when the
 * window draws a frame)
 */
function checkPagesAreaSize (): void {
  const host = pagesHost.value
  const pdfViewer = currentViewer()
  if (host === null || pdfViewer === null || session?.restored !== true) {
    return
  }

  const currentSize = { width: host.clientWidth, height: host.clientHeight }
  if (needsFitZoomUpdate(pdfViewer.currentScaleValue, appliedPagesAreaSize, currentSize)) {
    scheduleFitZoomUpdate()
  }
}

// END: KEYBOARD, WHEEL AND FOCUS

// BEGIN: LOCATION REQUESTS (contract C5, section "定位请求")

/**
 * Scrolls to a location and highlights its range. A location without a
 * valid range only scrolls to its page. With a quoted text, the page's text
 * is read first to decide which range to highlight (decision 071); the method
 * used is logged with console.debug.
 *
 * @param   {PdfLocation}       location    The location
 * @param   {boolean}           scroll      False only replaces the highlight
 * @param   {string|undefined}  sourceText  The quoted text below the link, if any
 */
function showLocation (location: PdfLocation, scroll: boolean, sourceText: string|undefined): void {
  locationRequestNumber++
  locationHighlight.clear()
  activeLocation = null

  const current = session
  if (current === null || current.pdfViewer === null || !current.restored || current.filePath !== props.file.path) {
    // Shown as soon as the document is ready (handlePagesInit)
    pendingLocation = { filePath: props.file.path, location, scroll, sourceText }
    return
  }

  pendingLocation = null
  const pageNumber = location.page
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > current.pdfViewer.pagesCount) {
    clearLocation()
    return
  }

  const selection = isValidPdfSelection(location.selection) ? location.selection : undefined
  const color = typeof location.color === 'string' ? location.color : undefined

  // Scrolling to the page right away also lets pdf.js start drawing its text
  // layer while the page's text is being read
  if (scroll) {
    scrollPageToMiddle(current, pageNumber)
  }

  const pdfDocument = current.pdfDocument
  if (selection === undefined || !hasPdfSourceText(sourceText) || pdfDocument === null) {
    if (selection !== undefined) {
      console.debug(`PDF viewer: location on page ${pageNumber} resolved by index (no quoted text)`)
    }
    activateLocation(pageNumber, selection, color, scroll)
    return
  }

  const requestNumber = locationRequestNumber
  void resolveRequestedSelection(pdfDocument, pageNumber, selection, sourceText).then(resolution => {
    if (session !== current || locationRequestNumber !== requestNumber) {
      return
    }

    console.debug(`PDF viewer: location on page ${pageNumber} resolved by ${resolution.method}`)
    activateLocation(pageNumber, resolution.selection ?? selection, color, scroll)
  }, (error: unknown) => {
    if (session !== current || locationRequestNumber !== requestNumber) {
      return
    }

    console.error(`Could not read the text of page ${pageNumber} of ${current.filePath}; highlighting the requested range as it is`, error)
    activateLocation(pageNumber, selection, color, scroll)
  })
}

/**
 * Makes a range the active location and highlights it (or waits for the
 * page's text layer)
 *
 * @param   {number}                      pageNumber  The page, from 1
 * @param   {PdfTextSelection|undefined}  selection   The range, if any
 * @param   {string|undefined}            color       The highlight color, if any
 * @param   {boolean}                     scroll      Whether to scroll to the range
 */
function activateLocation (pageNumber: number, selection: PdfTextSelection|undefined, color: string|undefined, scroll: boolean): void {
  activeLocation = { page: pageNumber, selection, color, scrollPending: scroll }
  refreshLocationHighlight()
}

/**
 * Removes the location highlight and forgets any location still waiting
 */
function clearLocation (): void {
  locationRequestNumber++
  locationHighlight.clear()
  activeLocation = null
  pendingLocation = null
}

/**
 * Whether this viewer follows a request for a file: it shows that file as
 * the active file of the last focused leaf
 *
 * @param   {string}   filePath  The request's file
 *
 * @return  {boolean}            True if this viewer is the request's target
 */
function isRequestTarget (filePath: string): boolean {
  return isSamePdfFilePath(filePath, props.file.path, PATHS_IGNORE_CASE) &&
    props.activeFile?.path === props.file.path &&
    documentTreeStore.lastLeafId === props.leafId
}

/**
 * Carries out the most recent request once, if it is meant for the loaded
 * file, no viewer has carried it out yet and it is recent (it arrived before
 * this viewer was mounted, had loaded the file, or was the target)
 */
function replayRecentRequest (): void {
  const current = session
  if (current === null || current.pdfViewer === null || !current.restored || current.filePath !== props.file.path) {
    return
  }

  if (!isRequestTarget(current.filePath)) {
    return
  }

  // Undefined while an App.vue from before lastPdfViewerRequest is loaded
  const record: PdfViewerRequestRecord|null|undefined = props.editorCommands.lastPdfViewerRequest
  if (record === null || record === undefined) {
    return
  }

  const rawRecord = toRaw(record)
  const now = Date.now()
  const shouldReplay = shouldReplayPdfViewerRequest(rawRecord, {
    filePath: current.filePath,
    now,
    alreadyHandled: isPdfViewerRequestHandled(rawRecord),
    ignoreCase: PATHS_IGNORE_CASE
  })
  const request = parsePdfViewerRequest(rawRecord.request)
  if (!shouldReplay || request === null || request.location === null) {
    return
  }

  markPdfViewerRequestHandled(rawRecord)
  console.debug(`PDF viewer: carrying out location request ${rawRecord.sequence}, sent ${now - rawRecord.time} ms before the document was ready`)
  showLocation(request.location, request.scroll !== false, request.sourceText)
}

/**
 * Builds the highlight of the active location again, from the text layer as
 * it is now, and scrolls to it if that is still due. Without a text layer
 * yet, it waits for textlayerrendered.
 */
function refreshLocationHighlight (): void {
  const location = activeLocation
  const current = session
  if (location === null || location.selection === undefined || current === null || current.pdfViewer === null || current.container === null) {
    locationHighlight.clear()
    if (location !== null) {
      location.scrollPending = false
    }
    return
  }

  // A text layer that pdf.js keeps hidden after a zoom change (the page was
  // out of view) has elements without a position: scrolling to them would
  // move the view to the wrong place. pdf.js shows it again and dispatches
  // textlayerrendered once it draws the page, i.e. when the page comes into
  // view (showLocation has already scrolled there if it scrolls at all).
  const pageView: unknown = current.pdfViewer.getPageView(location.page - 1)
  const textDivs = getPageTextDivs(pageView)
  if (textDivs === null || !isPageTextLayerShown(pageView)) {
    return
  }

  const range = buildSelectionRange(textDivs, location.selection)
  locationHighlight.show(range === null ? [] : [range], location.color)

  if (location.scrollPending) {
    location.scrollPending = false
    const element = firstSelectionElement(textDivs, location.selection)
    if (element !== null) {
      scrollElementToMiddle(current.container, element)
    }
  }
}

/**
 * Scrolls a page into the vertical middle of the view. A page taller than
 * the view is aligned with its top instead, so that the page's beginning
 * stays visible.
 *
 * @param   {ViewerSession}  current     The session of the document
 * @param   {number}         pageNumber  The page, from 1
 */
function scrollPageToMiddle (current: ViewerSession, pageNumber: number): void {
  const container = current.container
  const pageElement: unknown = current.pdfViewer?.getPageView(pageNumber - 1)?.div
  if (container === null || !(pageElement instanceof HTMLElement)) {
    return
  }

  const containerRect = container.getBoundingClientRect()
  const pageRect = pageElement.getBoundingClientRect()
  if (pageRect.height <= container.clientHeight) {
    container.scrollTop += pageRect.top + pageRect.height / 2 - (containerRect.top + container.clientHeight / 2)
  } else {
    container.scrollTop += pageRect.top - containerRect.top
  }
}

/**
 * Scrolls an element of the text layer into the middle of the view. Only the
 * scroll container moves (scrollIntoView would also scroll Zettlr's own
 * containers).
 *
 * @param   {HTMLElement}  container  The scroll container
 * @param   {HTMLElement}  element    The element
 */
function scrollElementToMiddle (container: HTMLElement, element: HTMLElement): void {
  const containerRect = container.getBoundingClientRect()
  const elementRect = element.getBoundingClientRect()
  container.scrollTop += elementRect.top + elementRect.height / 2 - (containerRect.top + container.clientHeight / 2)

  if (elementRect.left < containerRect.left || elementRect.right > containerRect.left + container.clientWidth) {
    container.scrollLeft += elementRect.left + elementRect.width / 2 - (containerRect.left + container.clientWidth / 2)
  }
}

// Only the viewer that shows the request's file as the active file of the
// last focused leaf follows the request; every other viewer removes its
// highlight, so that at most one location is highlighted at a time
watch(toRef(props.editorCommands, 'pdfViewerRequest'), () => {
  const request = parsePdfViewerRequest(props.editorCommands.data)
  if (request === null || request.location === null || !isRequestTarget(request.filePath)) {
    clearLocation()
    return
  }

  // Marks the record of this request as carried out, so that no viewer
  // carries it out again after loading (replayRecentRequest)
  const record: PdfViewerRequestRecord|null|undefined = props.editorCommands.lastPdfViewerRequest
  if (record !== null && record !== undefined && toRaw(record.request) === toRaw(props.editorCommands.data)) {
    markPdfViewerRequestHandled(toRaw(record))
  }

  showLocation(request.location, request.scroll !== false, request.sourceText)
})

// The file may become the active file of the last focused leaf only after it
// has been loaded; a recent request for it is carried out then
watch(() => [ props.activeFile?.path, documentTreeStore.lastLeafId ], () => {
  replayRecentRequest()
})

// END: LOCATION REQUESTS

// The editor pane reuses this component when it switches between two PDFs
watch(() => props.file.path, (filePath) => {
  openFile(filePath)
})

onMounted(() => {
  openFile(props.file.path)

  // Ctrl+F reaches the window through the main menu when no element in the
  // page has handled it (e.g., the focus is in the file manager)
  stopListening.push(ipcRenderer.on('shortcut', (_event, command: string) => {
    if (command === 'search' && ownsFindShortcut()) {
      openFindBar()
    }
  }))

  stopListening.push(ipcRenderer.on('pdf-backlinks-updated', (_event, message: PdfBacklinksUpdatedMessage) => {
    handleBacklinksUpdated(message)
  }))

  window.addEventListener('pagehide', saveViewState)

  if (pagesHost.value !== null) {
    resizeObserver = new ResizeObserver(handleResize)
    resizeObserver.observe(pagesHost.value)
    backlinkPopup = new PdfBacklinkPopup({
      reference: pagesHost.value,
      onOpen: hit => { openBacklink(hit) }
    })
  }
  fitZoomCheckTimer = setInterval(checkPagesAreaSize, FIT_ZOOM_CHECK_INTERVAL)
})

onBeforeUnmount(() => {
  for (const stop of stopListening) {
    stop()
  }
  stopListening.length = 0

  window.removeEventListener('pagehide', saveViewState)
  closeSession()
  clearLocation()
  cancelBacklinkHoverFrame()
  backlinkPopup?.destroy()
  backlinkPopup = null

  resizeObserver?.disconnect()
  resizeObserver = null
  clearTimeout(fitZoomTimer)
  fitZoomTimer = undefined
  clearInterval(fitZoomCheckTimer)
  fitZoomCheckTimer = undefined
  clearTimeout(quoteStatusTimer)
  quoteStatusTimer = undefined
})
</script>

<style lang="less">
// pdf_viewer.css gives :root `color-scheme: light dark`, which would switch
// all of Zettlr's native controls to dark ones whenever the system uses a
// dark theme. This selector is more specific and restores the default.
html:root {
  color-scheme: normal;
}

body {
  div.pdfjs-viewer {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    overflow: hidden;

    div.pdfjs-viewer-toolbar {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
      box-sizing: border-box;
      padding: 4px 8px;
      overflow-x: auto;
      font-size: 13px;
      // Same colors as the find bar
      color: black;
      background-color: #f5f5f5;
      border-bottom: 1px solid var(--grey-1);
      user-select: none;

      > * {
        flex-shrink: 0;
      }

      div.pdfjs-viewer-divider {
        width: 1px;
        height: 18px;
        margin: 0 4px;
        background-color: var(--grey-2);
      }

      button.pdfjs-viewer-button {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        box-sizing: border-box;
        min-width: 24px;
        height: 24px;
        padding: 0;
        font-family: inherit;
        font-size: inherit;
        color: inherit;
        background-color: transparent;
        border: 1px solid transparent;
        border-radius: 3px;
        cursor: pointer;

        cds-icon {
          width: 16px;
          height: 16px;
        }

        &:hover:not(:disabled),
        &[aria-pressed="true"] {
          border-color: var(--grey-2);
          background-color: var(--grey-1);
        }

        &:disabled {
          opacity: 0.4;
          cursor: default;
        }

        &:focus-visible {
          outline: 2px solid var(--system-accent-color, rgb(40, 100, 255));
          outline-offset: -1px;
        }

        // Open in Default App sits at the far end of the toolbar
        &.pdfjs-viewer-open-button {
          margin-left: auto;
          padding: 0 6px;
          white-space: nowrap;
        }
      }

      input.pdfjs-viewer-page-input,
      select.pdfjs-viewer-zoom-select {
        box-sizing: border-box;
        height: 22px;
        font-family: inherit;
        font-size: inherit;
        color: inherit;
        background-color: white;
        border: 1px solid var(--grey-2);
        border-radius: 3px;

        &:focus {
          outline: 2px solid var(--system-accent-color, rgb(40, 100, 255));
          outline-offset: -1px;
        }

        &:disabled {
          opacity: 0.5;
        }
      }

      input.pdfjs-viewer-page-input {
        width: 3.5em;
        padding: 0 4px;
        text-align: right;
        user-select: text;
      }

      span.pdfjs-viewer-page-count {
        padding-right: 2px;
        white-space: nowrap;
        color: rgb(100, 100, 100);
        font-variant-numeric: tabular-nums;
      }

      select.pdfjs-viewer-zoom-select {
        padding: 0 2px;
      }
    }

    div.pdfjs-viewer-body {
      display: flex;
      flex: 1;
      min-height: 0;
    }

    div.pdfjs-viewer-sidebar {
      flex: 0 0 240px;
      width: 240px;
      min-height: 0;
      overflow: hidden;
      border-right: 1px solid var(--grey-1);
    }

    div.pdfjs-viewer-main {
      position: relative;
      flex: 1;
      min-width: 0;
      // Only the surroundings of the pages follow the theme; the pages keep
      // their own colors
      background-color: rgb(212, 212, 215);
    }

    div.pdfjs-viewer-pages {
      position: absolute;
      inset: 0;
    }

    div.pdfjs-viewer-scroll {
      position: absolute;
      inset: 0;
      overflow: auto;
      outline: none;
    }

    div.pdfjs-viewer-message {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      padding: 20px;
      text-align: center;
      font-size: 14px;
      color: rgb(80, 80, 80);
    }

    // The location highlight's colors are opaque, and ::highlight() cannot
    // set a blend mode of its own; multiplying the text layer with the page
    // below keeps the text on the canvas readable through the highlight.
    // pdf.js' own translucent find highlights are not affected visibly.
    .textLayer {
      mix-blend-mode: multiply;
    }
  }

  &.dark div.pdfjs-viewer {
    div.pdfjs-viewer-toolbar {
      color: white;
      background-color: #333333;
      border-bottom-color: var(--grey-6);

      div.pdfjs-viewer-divider {
        background-color: var(--grey-5);
      }

      button.pdfjs-viewer-button:hover:not(:disabled),
      button.pdfjs-viewer-button[aria-pressed="true"] {
        border-color: var(--grey-4);
        background-color: var(--grey-6);
      }

      input.pdfjs-viewer-page-input,
      select.pdfjs-viewer-zoom-select {
        background-color: var(--grey-7);
        border-color: var(--grey-5);
      }

      span.pdfjs-viewer-page-count {
        color: rgb(170, 170, 170);
      }
    }

    div.pdfjs-viewer-sidebar {
      border-right-color: var(--grey-6);
    }

    div.pdfjs-viewer-main {
      background-color: rgb(42, 42, 46);
    }

    div.pdfjs-viewer-message {
      color: rgb(190, 190, 190);
    }
  }
}
</style>
