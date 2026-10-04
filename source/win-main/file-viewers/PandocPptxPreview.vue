<template>
  <div
    ref="rootElement"
    class="pandoc-pptx-preview"
    role="region"
    v-bind:aria-label="`PPTX preview: ${pathBasename(props.filePath)}`"
  >
    <div
      v-bind:class="{
        'pptx-preview-configuration': true,
        'has-error': state !== undefined && state.error !== undefined
      }"
    >
      <label v-bind:for="templateInputId">Template (reference-doc)</label>
      <input
        v-bind:id="templateInputId"
        v-model="templateInput"
        type="text"
        spellcheck="false"
        placeholder="Leave empty to use the default template"
        v-on:input="templateInputTouched = true"
      >
      <span class="pptx-configuration-origin">{{ templateOriginLabel }}</span>
      <button
        v-bind:disabled="writingConfiguration"
        v-bind:title="'Write the template path above into the Pandoc_PPTX_Configuration comment at the top of the document'"
        v-on:click="writeTemplateIntoDocument"
      >
        Write to Document
      </button>
      <span class="pptx-preview-status-text">
        <template v-if="state === undefined">
          Starting preview…
        </template>
        <template v-else-if="state.error !== undefined">
          Conversion failed: {{ state.error }}
        </template>
        <template v-else-if="state.building">
          Updating {{ pageCountLabel(state.pendingCount) }}…
        </template>
        <template v-else>
          {{ pageCountLabel(slides.length) }} in total
        </template>
      </span>
      <span v-if="configurationMessage !== ''" class="pptx-configuration-message">
        {{ configurationMessage }}
      </span>
    </div>
    <div
      ref="scrollContainer"
      class="pptx-preview-scroll-container"
      v-on:scroll="rememberScrollPosition"
    >
      <div
        v-for="(slide, slideIndex) in slides"
        v-bind:key="slide.key"
        class="pptx-slide-card"
      >
        <!-- Page pin: aligns the editor to this page's source (shown on hover) -->
        <button
          type="button"
          class="pptx-slide-pin"
          v-bind:title="'Scroll the editor to the source of this page'"
          v-bind:aria-label="`Scroll the editor to the source of page ${slideIndex + 1}`"
          v-on:click="alignEditorToSlide(slideIndex)"
        >
          <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            aria-hidden="true"
          >
            <path
              fill="currentColor"
              d="M10.1 1.2a.8.8 0 0 1 1.1 0l3.6 3.6a.8.8 0 0 1 0 1.1l-.6.6a.8.8 0 0 1-.9.2l-2.4 2.4.3 2.3a.8.8 0 0 1-.2.7l-.8.8a.5.5 0 0 1-.7 0L6.8 9.2l-4 4a.5.5 0 0 1-.7-.7l4-4-3.7-3.7a.5.5 0 0 1 0-.7l.8-.8a.8.8 0 0 1 .7-.2l2.3.3 2.4-2.4a.8.8 0 0 1 .2-.9z"
            />
          </svg>
        </button>
        <div class="pptx-slide-header">
          {{ pageLabel(slide, slideIndex) }}
        </div>
        <div v-if="slide.status === 'error'" class="pptx-slide-error">
          {{ slide.errorMessage ?? 'This page failed to convert' }}
        </div>
        <div
          v-else-if="slide.status === 'pending' && carriedOverImages[slideIndex] !== undefined"
          class="pptx-slide-carried-over"
        >
          <div
            v-for="imagePath in carriedOverImages[slideIndex] ?? []"
            v-bind:key="imagePath"
            class="pptx-slide-image-frame"
          >
            <img
              v-bind:src="makeValidUri(imagePath)"
              alt=""
            >
          </div>
          <div class="pptx-slide-carried-over-overlay">
            <span>Rendering…</span>
          </div>
        </div>
        <div v-else-if="slide.status === 'pending'" class="pptx-slide-placeholder">
          Generating…
        </div>
        <template v-else>
          <div
            v-for="(imagePath, imageIndex) in slide.images"
            v-bind:key="imagePath"
            class="pptx-slide-image-frame"
          >
            <img
              loading="lazy"
              v-bind:src="makeValidUri(imagePath)"
              v-bind:alt="`Page ${slideIndex + 1}, rendered slide ${imageIndex + 1}`"
            >
          </div>
        </template>
        <div
          v-if="slide.overflow.length > 0 || slide.undersized.length > 0"
          class="pptx-slide-badges"
        >
          <span
            v-for="(entry, entryIndex) in slide.overflow"
            v-bind:key="`overflow-${entryIndex}`"
            class="pptx-badge pptx-badge-overflow"
          >
            Overflows by {{ formatPt(entry.excessPt) }} pt, split this page
          </span>
          <span
            v-for="(entry, entryIndex) in slide.undersized"
            v-bind:key="`undersized-${entryIndex}`"
            class="pptx-badge pptx-badge-undersized"
          >
            Below 22 pt: {{ entry.snippet }} ({{ formatPt(entry.sizePt) }} pt)
          </span>
        </div>
      </div>
      <div
        v-if="state !== undefined && state.error === undefined && !state.building && slides.length === 0"
        class="pptx-preview-empty"
      >
        The document currently contains no pages to preview.
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        PandocPptxPreview
 * CVM-Role:        View
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Displays a live per-slide PNG preview of the pandoc PPTX
 *                  conversion of a Markdown document. The conversion itself
 *                  runs in a resident worker in the main process; this
 *                  component merely opens/closes the preview session, asks for
 *                  refresh cycles (debounced) whenever the document content
 *                  changes, and renders the idempotent state snapshots the
 *                  main process broadcasts. While a page is being rendered
 *                  again, its previous rendering stays visible behind a blurred
 *                  veil instead of being replaced by an empty placeholder.
 *
 *                  The pane links itself to the Markdown editor of the same
 *                  editor pane: synchronized scrolling while the
 *                  toolbar's Sync Scroll switch is on, a pin on every page that
 *                  aligns the editor to the page's source, and a reaction to
 *                  the editor's heading pins that aligns this list to a page.
 *
 * END HEADER
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { DP_EVENTS } from '@dts/common/documents'
import {
  PPTX_PREVIEW_EVENT_CHANNEL,
  type PptxPreviewCommandArg,
  type PptxPreviewSlide,
  type PptxPreviewState
} from '@dts/common/pptx-preview'
import makeValidUri from 'source/common/util/make-valid-uri'
import { pathBasename } from 'source/common/util/renderer-path-polyfill'
import type { DocumentsUpdateContext } from 'source/app/service-providers/documents'
import { ChangeSet } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { documentAuthorityIPCAPI } from '@common/modules/markdown-editor/util/ipc-api'
import { configField } from '@common/modules/markdown-editor/util/configuration'
import { writeReferenceDoc } from '@common/pandoc-util/pptx-preview-configuration'
import {
  buildScrollAnchors,
  findPageIndexForLine,
  invertScrollAnchors,
  mapScrollPosition,
  type ScrollAnchor
} from '@common/util/pptx-scroll-mapping'
import {
  PPTX_EDITOR_PIN_EVENT,
  pptxSyncScrollEnabled,
  type PptxEditorPinDetail
} from '@common/util/pptx-preview-link'

const ipcRenderer = window.ipc

// How long to wait after the last change to the document before asking the
// main process for a new conversion cycle, so that typing stays free of any
// conversion-triggered work.
const REFRESH_DELAY = 600

// A page aligned "to the top" of the preview keeps this much space above its
// card (the scroll container's own padding), so that the card's border stays
// visible.
const SLIDE_TOP_MARGIN = 10

// Scroll offsets differing by at most this many pixels count as equal: no
// programmatic scroll is issued for smaller corrections, and a scroll event
// landing this close to an offset set programmatically is recognized as the
// echo of that write.
const SCROLL_TOLERANCE = 2

// How long after a programmatic scroll its echo (the resulting scroll event)
// is expected at the latest.
const SCROLL_ECHO_WINDOW_MILLISECONDS = 250

const props = defineProps<{
  /**
   * Absolute path of the previewed Markdown document
   */
  filePath: string
  /**
   * Maps file paths to the last scroll offset of the preview list, so that the
   * reading position survives switching tabs (per pane).
   */
  scrollTopMap: Map<string, number>
}>()

/**
 * Identifies this pane's writes to the document authority. Every preview pane
 * gets its own, so that two panes cannot be mistaken for one another.
 */
const CONFIGURATION_CLIENT_ID = `pptx-preview-configuration-${Math.random().toString(36).slice(2)}`

const rootElement = ref<HTMLDivElement|null>(null)
const scrollContainer = ref<HTMLDivElement|null>(null)
const state = ref<PptxPreviewState|undefined>(undefined)
const slides = computed<PptxPreviewSlide[]>(() => state.value?.slides ?? [])

/**
 * For every page of the current state (same indices as `slides`): the images
 * of an earlier rendering of that page position, shown blurred while the page
 * is pending. Undefined where no earlier rendering could be matched.
 */
const carriedOverImages = ref<Array<string[]|undefined>>([])
/**
 * What was on screen for every page of the previous state: fresh images for
 * ready pages, carried-over images for the others. Kept across states (and
 * across the several publishes of one cycle) so that a page keeps its old
 * rendering until its new one is ready.
 */
let previouslyDisplayedSlides: DisplayedSlide[] = []

const templateInputId = `pptx-preview-template-${Math.random().toString(36).slice(2)}`
const templateInput = ref('')
/**
 * True once the user has typed in the template field: from then on, incoming
 * states must not overwrite what they are in the middle of writing.
 */
const templateInputTouched = ref(false)
const writingConfiguration = ref(false)
const configurationMessage = ref('')

const templateOriginLabel = computed(() => {
  if (state.value === undefined) {
    return ''
  }
  return state.value.referenceDocSource === 'document' ? 'From document comment' : 'Using default template'
})

/**
 * The editor pane (EditorPane.vue) this preview sits in. Its Markdown editor
 * is the one this preview links to for scrolling and pins.
 */
let editorPaneElement: Element|null = null

/**
 * Programmatic scroll writes whose resulting scroll event is still expected,
 * per scrolled element (see applyProgrammaticScroll)
 */
const expectedScrollEchoes = new Map<Element, { scrollTop: number, until: number }>()
let pendingSyncSource: 'editor'|'preview'|undefined
let syncFrame: number|undefined

let refreshTimer: ReturnType<typeof setTimeout>|undefined
const stopListening: Array<() => void> = []

function invokePreviewCommand (action: 'open'|'refresh'|'close', filePath: string): void {
  ipcRenderer.invoke('application', {
    command: 'pptx-preview',
    payload: { action, filePath } satisfies PptxPreviewCommandArg
  }).catch(err => console.error(err))
}

function scheduleRefresh (): void {
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    invokePreviewCommand('refresh', props.filePath)
  }, REFRESH_DELAY)
}

function pageCountLabel (count: number): string {
  return count === 1 ? '1 page' : `${count} pages`
}

function pageLabel (slide: PptxPreviewSlide, slideIndex: number): string {
  if (slide.status === 'ready' && slide.images.length > 1) {
    return `Page ${slideIndex + 1} (split into ${slide.images.length} slides)`
  }

  return `Page ${slideIndex + 1}`
}

function formatPt (value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * Writes the template path from the input field into the document's
 * configuration comment. The edit does not go through the main process: the
 * pane acts as an ordinary collaborating client of the document authority, so
 * that an editor showing the same document sees the change immediately and the
 * usual save path takes over from there.
 */
async function writeTemplateIntoDocument (): Promise<void> {
  if (writingConfiguration.value) {
    return
  }
  writingConfiguration.value = true
  configurationMessage.value = ''

  try {
    // A stale version means somebody typed between fetching and pushing; one
    // retry over the fresh content is enough in practice.
    for (let attempt = 0; attempt < 2; attempt++) {
      const { content, startVersion } = await documentAuthorityIPCAPI.fetchDoc(props.filePath)
      const edit = writeReferenceDoc(content, templateInput.value)

      if (edit === undefined) {
        configurationMessage.value = 'The document already uses this template'
        templateInputTouched.value = false
        return
      }

      const changes = ChangeSet.of({ from: edit.from, to: edit.to, insert: edit.insert }, content.length)
      const accepted = await documentAuthorityIPCAPI.pushUpdates(props.filePath, startVersion, [
        { changes: changes.toJSON(), clientID: CONFIGURATION_CLIENT_ID }
      ])

      if (accepted) {
        configurationMessage.value = 'Written to the top of the document'
        templateInputTouched.value = false
        // The document content changed, so the whole deck has to be rendered
        // again against the new template.
        scheduleRefresh()
        return
      }
    }
    configurationMessage.value = 'The document changed in the meantime; please click again'
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    configurationMessage.value = `Writing failed: ${message}`
  } finally {
    writingConfiguration.value = false
  }
}

function rememberScrollPosition (): void {
  // Nothing worth remembering is on screen before the first state arrives (a
  // programmatic reset to scrollTop 0 must not overwrite a saved position).
  if (state.value === undefined || scrollContainer.value === null) {
    return
  }

  props.scrollTopMap.set(props.filePath, scrollContainer.value.scrollTop)
}

function restoreScrollPosition (): void {
  const container = scrollContainer.value
  if (container === null) {
    return
  }

  const savedScrollTop = props.scrollTopMap.get(props.filePath)
  if (savedScrollTop !== undefined) {
    // Registered as a programmatic write, so that it cannot pull the editor
    applyProgrammaticScroll(container, savedScrollTop)
  }

  if (pptxSyncScrollEnabled.value) {
    // While scrolling is synchronized, the editor (which restores its own
    // position) leads, and the list follows it.
    scheduleScrollSync('editor')
  }
}

// ----------------------------------------------------------------------------
// Link to the Markdown editor: synchronized scrolling and pins
//
// Both scroll positions are related through one anchor per page: the editor
// offset at which the page's startLine is at the top of the editor, paired
// with the list offset at which the page's card is at the top of the list.
// Offsets in between are interpolated linearly (pptx-scroll-mapping).
// ----------------------------------------------------------------------------

/**
 * The CodeMirror view of the Markdown editor in the same editor pane, provided
 * it currently shows the previewed document.
 */
function findLinkedEditorView (): EditorView|null {
  if (editorPaneElement === null) {
    return null
  }

  // The first match is the main editor; nested editors (table cells) come
  // later in document order and carry no document path anyway.
  for (const element of editorPaneElement.querySelectorAll('.main-editor-wrapper .cm-editor')) {
    if (!(element instanceof HTMLElement)) {
      continue
    }
    const view = EditorView.findFromDOM(element)
    if (view !== null && view.state.field(configField, false)?.metadata.path === props.filePath) {
      return view
    }
  }
  return null
}

/**
 * The page cards in page order (same indices as `slides`)
 */
function slideCardElements (): HTMLElement[] {
  const container = scrollContainer.value
  if (container === null) {
    return []
  }
  return Array.from(container.querySelectorAll<HTMLElement>(':scope > .pptx-slide-card'))
}

/**
 * The list offset at which a card sits at the top of the list (the container
 * is the cards' offset parent)
 */
function cardScrollOffset (card: HTMLElement): number {
  return Math.max(0, card.offsetTop - SLIDE_TOP_MARGIN)
}

/**
 * The editor offset at which the given 0-based line is at the top of the
 * editor. Lines outside the rendered viewport use CodeMirror's height
 * estimates, which is precise enough for following along.
 */
function editorLineScrollOffset (view: EditorView, line: number): number {
  const scroller = view.scrollDOM
  // Where the document's first line starts within the scrollable content
  // (the editor's own padding lies above it)
  const documentOffset = view.documentTop - scroller.getBoundingClientRect().top + scroller.scrollTop
  const editorDocument = view.state.doc
  const lineNumber = Math.min(Math.max(line + 1, 1), editorDocument.lines)
  return view.lineBlockAt(editorDocument.line(lineNumber).from).top + documentOffset
}

/**
 * The mapping table from editor offsets (source) to list offsets (target)
 */
function buildEditorToPreviewAnchors (view: EditorView, container: HTMLElement): ScrollAnchor[] {
  const cards = slideCardElements()
  const pageCount = Math.min(cards.length, slides.value.length)
  const pagePairs: ScrollAnchor[] = []
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
    pagePairs.push({
      source: editorLineScrollOffset(view, slides.value[pageIndex].startLine),
      target: cardScrollOffset(cards[pageIndex])
    })
  }

  const scroller = view.scrollDOM
  return buildScrollAnchors(
    pagePairs,
    scroller.scrollHeight - scroller.clientHeight,
    container.scrollHeight - container.clientHeight
  )
}

/**
 * Scrolls an element on behalf of the synchronization and remembers the write,
 * so that the scroll event it causes is not mistaken for the user scrolling
 * that side (which would synchronize back and make both sides jitter).
 * Corrections within the tolerance are skipped altogether.
 */
function applyProgrammaticScroll (element: HTMLElement, scrollTop: number): void {
  if (Math.abs(element.scrollTop - scrollTop) <= SCROLL_TOLERANCE) {
    return
  }
  element.scrollTop = Math.round(scrollTop)
  expectedScrollEchoes.set(element, {
    scrollTop: element.scrollTop, // As clamped by the browser
    until: performance.now() + SCROLL_ECHO_WINDOW_MILLISECONDS
  })
}

/**
 * Whether a scroll event of the element is the echo of a programmatic write
 * (consumes the expectation when it is)
 */
function consumeScrollEcho (element: HTMLElement): boolean {
  const echo = expectedScrollEchoes.get(element)
  if (echo === undefined) {
    return false
  }
  if (performance.now() > echo.until) {
    expectedScrollEchoes.delete(element)
    return false
  }
  if (Math.abs(element.scrollTop - echo.scrollTop) <= SCROLL_TOLERANCE) {
    expectedScrollEchoes.delete(element)
    return true
  }
  return false
}

/**
 * Synchronizes the other side once per animation frame, following whichever
 * side scrolled last
 */
function scheduleScrollSync (source: 'editor'|'preview'): void {
  pendingSyncSource = source
  if (syncFrame !== undefined) {
    return
  }
  syncFrame = requestAnimationFrame(() => {
    syncFrame = undefined
    const syncSource = pendingSyncSource
    pendingSyncSource = undefined
    if (syncSource !== undefined) {
      synchronizeScroll(syncSource)
    }
  })
}

function synchronizeScroll (source: 'editor'|'preview'): void {
  const container = scrollContainer.value
  if (!pptxSyncScrollEnabled.value || container === null || state.value === undefined) {
    return
  }
  const view = findLinkedEditorView()
  if (view === null) {
    return
  }

  const anchors = buildEditorToPreviewAnchors(view, container)
  if (source === 'editor') {
    const target = mapScrollPosition(anchors, view.scrollDOM.scrollTop)
    if (target !== undefined) {
      applyProgrammaticScroll(container, target)
    }
  } else {
    const target = mapScrollPosition(invertScrollAnchors(anchors), container.scrollTop)
    if (target !== undefined) {
      applyProgrammaticScroll(view.scrollDOM, target)
    }
  }
}

/**
 * Listens (capturing, since scroll events do not bubble) to every scroll
 * inside the editor pane and picks out the two that matter: this list and the
 * linked editor's scroller.
 */
function handleEditorPaneScroll (event: Event): void {
  if (!pptxSyncScrollEnabled.value) {
    return
  }
  const target = event.target
  if (!(target instanceof HTMLElement)) {
    return
  }

  if (target === scrollContainer.value) {
    if (!consumeScrollEcho(target)) {
      scheduleScrollSync('preview')
    }
    return
  }

  if (!target.classList.contains('cm-scroller')) {
    return
  }
  const view = findLinkedEditorView()
  if (view !== null && view.scrollDOM === target && !consumeScrollEcho(target)) {
    scheduleScrollSync('editor')
  }
}

/**
 * Page pin: scrolls the editor so that the page's first source line is at the
 * top. A one-off alignment; with Sync Scroll on, the list then follows the
 * editor as usual, which puts this page's card at the top as well.
 */
function alignEditorToSlide (slideIndex: number): void {
  const slide = slides.value[slideIndex]
  const view = findLinkedEditorView()
  if (slide === undefined || view === null) {
    return
  }

  const editorDocument = view.state.doc
  const line = editorDocument.line(Math.min(Math.max(slide.startLine + 1, 1), editorDocument.lines))
  view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 0 }) })
}

/**
 * Editor heading pin: scrolls the list so that the card of the page containing
 * the given 0-based line is at the top.
 */
function alignPreviewToLine (line: number): void {
  const container = scrollContainer.value
  const pageIndex = findPageIndexForLine(slides.value.map(slide => slide.startLine), line)
  if (container === null || pageIndex === undefined) {
    return
  }

  const card = slideCardElements()[pageIndex]
  if (card !== undefined) {
    container.scrollTop = cardScrollOffset(card)
  }
}

function handleEditorPin (event: Event): void {
  // Only pins of the editor in this preview's own editor pane count
  if (!(event instanceof CustomEvent) || editorPaneElement === null) {
    return
  }
  if (!(event.target instanceof Node) || !editorPaneElement.contains(event.target)) {
    return
  }

  const detail = event.detail as PptxEditorPinDetail
  if (detail.filePath === props.filePath) {
    alignPreviewToLine(detail.line)
  }
}

onMounted(() => {
  // Register the state listener before opening the session so that no
  // broadcast can slip through in between.
  stopListening.push(ipcRenderer.on(PPTX_PREVIEW_EVENT_CHANNEL, (_event, payload: { state: PptxPreviewState }) => {
    if (payload.state.filePath === props.filePath) {
      state.value = payload.state
    }
  }))

  stopListening.push(ipcRenderer.on('documents-update', (_event, payload: { event: DP_EVENTS, context: DocumentsUpdateContext }) => {
    const { event, context } = payload
    const contentMayHaveChanged = event === DP_EVENTS.CHANGE_FILE_STATUS ||
      event === DP_EVENTS.FILE_REMOTELY_CHANGED ||
      event === DP_EVENTS.FILE_SAVED

    if (contentMayHaveChanged && context.filePath === props.filePath) {
      scheduleRefresh()
    }
  }))

  invokePreviewCommand('open', props.filePath)

  // Link to the Markdown editor of the same editor pane
  editorPaneElement = rootElement.value?.closest('.editor-pane') ?? null
  editorPaneElement?.addEventListener('scroll', handleEditorPaneScroll, { capture: true, passive: true })
  document.addEventListener(PPTX_EDITOR_PIN_EVENT, handleEditorPin)
})

onBeforeUnmount(() => {
  clearTimeout(refreshTimer)
  for (const stop of stopListening) {
    stop()
  }

  editorPaneElement?.removeEventListener('scroll', handleEditorPaneScroll, { capture: true })
  editorPaneElement = null
  document.removeEventListener(PPTX_EDITOR_PIN_EVENT, handleEditorPin)
  if (syncFrame !== undefined) {
    cancelAnimationFrame(syncFrame)
    syncFrame = undefined
  }

  invokePreviewCommand('close', props.filePath)
})

// Switching Sync Scroll on brings the list in line with the editor right away
watch(pptxSyncScrollEnabled, (enabled) => {
  if (enabled) {
    scheduleScrollSync('editor')
  }
})

watch(() => props.filePath, (newFilePath, oldFilePath) => {
  if (newFilePath === oldFilePath) {
    return
  }

  // End the old session and start one for the new document. The scroll
  // position of the old document is already in the map (saved on scroll).
  clearTimeout(refreshTimer)
  invokePreviewCommand('close', oldFilePath)
  state.value = undefined
  templateInput.value = ''
  templateInputTouched.value = false
  configurationMessage.value = ''
  invokePreviewCommand('open', newFilePath)
})

// Keep the template field showing what the preview actually rendered against,
// except while the user is in the middle of typing a new path into it.
watch(() => state.value?.referenceDoc, (referenceDoc) => {
  if (referenceDoc !== undefined && !templateInputTouched.value) {
    templateInput.value = referenceDoc
  }
})

// Match every incoming state against what was on screen before, so that pending
// pages can keep showing their previous rendering. This watcher runs before the
// component re-renders (default "pre" flush), so the list never renders a state
// together with carried-over images computed for another state.
watch(state, (newState) => {
  if (newState === undefined) {
    // A different document (or none): nothing on screen belongs to it.
    previouslyDisplayedSlides = []
    carriedOverImages.value = []
    return
  }

  const matchedImages = matchPreviousImages(newState.slides, previouslyDisplayedSlides)
  carriedOverImages.value = matchedImages
  previouslyDisplayedSlides = newState.slides.map((slide, slideIndex) => {
    return {
      key: slide.key,
      startLine: slide.startLine,
      images: slide.status === 'ready' ? slide.images : matchedImages[slideIndex] ?? []
    }
  })
})

// Restore the scroll position as soon as the first state for the current
// document has rendered; the fixed-aspect-ratio frames keep the list height
// stable from then on, so later updates do not make the list jump.
watch(state, (newState, oldState) => {
  if (oldState === undefined && newState !== undefined) {
    nextTick().then(() => {
      restoreScrollPosition()
    }).catch(err => console.error(err))
  }
})
</script>

<script lang="ts">
/**
 * The position of a page in a preview state, as far as matching earlier
 * renderings is concerned.
 */
export interface SlidePosition {
  /**
   * Content hash of the page; unchanged pages keep their key across cycles
   */
  key: string
  /**
   * 0-based line number where the page starts in the Markdown source
   */
  startLine: number
}

/**
 * A page as it was displayed: its position plus the images shown for it
 * (empty when nothing was shown).
 */
export interface DisplayedSlide extends SlidePosition {
  images: string[]
}

/**
 * Finds, for every page of a new preview state, the images that were displayed
 * at the corresponding position of the previous state, so that a page whose
 * new rendering is still pending can keep showing its old one.
 *
 * Matching works in two steps. First, pages whose content hash did not change
 * serve as anchors: the longest in-order sequence of equal keys between the two
 * lists is determined, and every anchored page matches its own earlier self.
 * Second, the pages between two consecutive anchors (or before the first /
 * after the last one) are paired in order: the first page of a gap in the new
 * list with the first page of the corresponding gap in the old list, and so on.
 * When a gap grew (pages were added), its surplus pages at the end stay
 * unmatched; when it shrank, the surplus old pages are simply dropped. Without
 * any anchor this reduces to matching pages by index.
 *
 * @param   {SlidePosition[]}   currentSlides   The pages of the new state
 * @param   {DisplayedSlide[]}  previousSlides  What was displayed for the pages
 *                                              of the previous state
 *
 * @return  {Array<string[]|undefined>}         Same length and order as
 *                                              currentSlides; undefined where
 *                                              no displayed images could be
 *                                              matched
 */
export function matchPreviousImages (
  currentSlides: SlidePosition[],
  previousSlides: DisplayedSlide[]
): Array<string[]|undefined> {
  const currentCount = currentSlides.length
  const previousCount = previousSlides.length
  const matches: Array<string[]|undefined> = new Array(currentCount).fill(undefined)

  if (currentCount === 0 || previousCount === 0) {
    return matches
  }

  // Longest common subsequence of the key lists. commonLength[i * rowLength + j]
  // holds the length of the longest common subsequence of the suffixes
  // currentSlides[i..] and previousSlides[j..].
  const rowLength = previousCount + 1
  const commonLength = new Int32Array((currentCount + 1) * rowLength)
  for (let i = currentCount - 1; i >= 0; i--) {
    for (let j = previousCount - 1; j >= 0; j--) {
      commonLength[i * rowLength + j] = currentSlides[i].key === previousSlides[j].key
        ? commonLength[(i + 1) * rowLength + j + 1] + 1
        : Math.max(commonLength[(i + 1) * rowLength + j], commonLength[i * rowLength + j + 1])
    }
  }

  // Walk the table to collect the anchor pairs [currentIndex, previousIndex].
  const anchors: Array<[number, number]> = []
  let i = 0
  let j = 0
  while (i < currentCount && j < previousCount) {
    if (currentSlides[i].key === previousSlides[j].key) {
      anchors.push([ i, j ])
      i++
      j++
    } else if (commonLength[(i + 1) * rowLength + j] >= commonLength[i * rowLength + j + 1]) {
      i++
    } else {
      j++
    }
  }
  // A sentinel anchor past both ends closes the last gap.
  anchors.push([ currentCount, previousCount ])

  const displayedImages = (slide: DisplayedSlide): string[]|undefined => {
    return slide.images.length > 0 ? slide.images : undefined
  }

  let currentGapStart = 0
  let previousGapStart = 0
  for (const [ currentAnchor, previousAnchor ] of anchors) {
    const pairedLength = Math.min(currentAnchor - currentGapStart, previousAnchor - previousGapStart)
    for (let offset = 0; offset < pairedLength; offset++) {
      matches[currentGapStart + offset] = displayedImages(previousSlides[previousGapStart + offset])
    }

    if (currentAnchor < currentCount) {
      matches[currentAnchor] = displayedImages(previousSlides[previousAnchor])
    }

    currentGapStart = currentAnchor + 1
    previousGapStart = previousAnchor + 1
  }

  return matches
}
</script>

<style lang="less">
body {
  // The editor's heading pins (pptx-preview-pins.ts) are hidden by default and
  // appear only in an editor pane that currently shows a PPTX preview. Both
  // declarations need !important to beat CodeMirror's own gutter rule.
  .editor-pane:has(.pandoc-pptx-preview) .cm-editor .cm-gutter.cm-pptx-pin-gutter {
    display: flex !important;
  }

  .pandoc-pptx-preview {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    background-color: rgb(245, 245, 245);

    // One combined top row: the conversion inputs that are worth deciding per
    // document (only the reference-doc template for now) plus the conversion
    // status ("N pages in total" / "Updating…" / the error text) at its right
    // end. Everything wraps when the pane gets narrow.
    .pptx-preview-configuration {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      padding: 6px 12px;
      font-size: 12px;
      background-color: rgb(248, 248, 248);
      border-bottom: 1px solid rgb(220, 220, 220);

      &.has-error {
        color: rgb(180, 30, 30);
        background-color: rgb(253, 236, 236);
        border-bottom-color: rgb(230, 180, 180);
      }

      .pptx-preview-status-text {
        flex: 0 1 auto;
        min-width: 0;
        margin-left: auto;
        text-align: right;
        overflow-wrap: anywhere;
      }

      label {
        flex-shrink: 0;
      }

      input[type="text"] {
        flex: 1 1 220px;
        min-width: 140px;
        font-size: 12px;
        font-family: inherit;
        padding: 2px 4px;
      }

      button {
        flex-shrink: 0;
        font-size: 12px;
        min-width: 0;
        padding: 2px 8px;
      }

      .pptx-configuration-origin {
        flex-shrink: 0;
        color: rgb(120, 120, 120);
      }

      .pptx-configuration-message {
        flex-basis: 100%;
        color: rgb(90, 110, 90);
      }
    }

    .pptx-preview-scroll-container {
      // Positioned, so that it is the offset parent of the cards: the scroll
      // synchronization reads the cards' offsetTop relative to it.
      position: relative;
      flex: 1 1 0;
      min-height: 0;
      overflow-y: auto;
      padding: 10px;
    }

    .pptx-slide-card {
      position: relative;
      margin-bottom: 14px;
      padding: 8px;
      border: 1px solid rgb(220, 220, 220);
      border-radius: 6px;
      background-color: white;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);

      &:hover .pptx-slide-pin,
      .pptx-slide-pin:focus-visible {
        opacity: 1;
      }
    }

    // The page pin floats over the card's top right corner, above the veil of
    // a page that is being rendered again.
    .pptx-slide-pin {
      position: absolute;
      top: 6px;
      right: 6px;
      z-index: 2;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      min-width: 0;
      padding: 0;
      color: #3b78d1;
      background-color: rgba(255, 255, 255, 0.92);
      border: 1px solid rgb(200, 200, 200);
      border-radius: 13px;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.15s ease;

      &:hover {
        border-color: #3b78d1;
      }
    }

    .pptx-slide-header {
      font-size: 12px;
      color: rgb(90, 90, 90);
      margin-bottom: 6px;
    }

    .pptx-slide-image-frame {
      aspect-ratio: 960 / 470;
      width: 100%;
      margin-bottom: 6px;
      background-color: rgb(250, 250, 250);

      &:last-child { margin-bottom: 0; }

      img {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: contain;
      }
    }

    // A pending page that still shows its previous rendering: the old images
    // sit blurred behind a translucent veil ("in the fog") until the new
    // rendering arrives. Every frame clips its image and the image is scaled up
    // slightly, so that the blur does not bleed a light halo along the edges.
    .pptx-slide-carried-over {
      position: relative;
      overflow: hidden;
      border-radius: 4px;

      .pptx-slide-image-frame {
        overflow: hidden;

        img {
          filter: blur(6px);
          transform: scale(1.04);
        }
      }
    }

    .pptx-slide-carried-over-overlay {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background-color: rgba(255, 255, 255, 0.45);

      span {
        padding: 4px 12px;
        font-size: 13px;
        color: rgb(70, 70, 70);
        background-color: rgba(255, 255, 255, 0.8);
        border-radius: 10px;
      }
    }

    .pptx-slide-placeholder {
      aspect-ratio: 960 / 470;
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      color: rgb(130, 130, 130);
      border: 1px dashed rgb(200, 200, 200);
      border-radius: 4px;
      background-color: rgb(250, 250, 250);
    }

    .pptx-slide-error {
      padding: 10px;
      font-size: 13px;
      color: rgb(180, 30, 30);
      border: 1px solid rgb(220, 130, 130);
      border-radius: 4px;
      background-color: rgb(253, 236, 236);
      overflow-wrap: anywhere;
    }

    .pptx-slide-badges {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 4px;
      margin-top: 6px;
    }

    .pptx-badge {
      display: inline-block;
      padding: 2px 8px;
      font-size: 12px;
      border-radius: 10px;
      overflow-wrap: anywhere;

      &.pptx-badge-overflow {
        color: rgb(160, 20, 20);
        background-color: rgb(252, 228, 228);
        border: 1px solid rgb(230, 170, 170);
      }

      &.pptx-badge-undersized {
        color: rgb(130, 90, 0);
        background-color: rgb(252, 240, 212);
        border: 1px solid rgb(230, 200, 140);
      }
    }

    .pptx-preview-empty {
      padding: 20px;
      font-size: 13px;
      color: rgb(130, 130, 130);
      text-align: center;
    }
  }

  &.dark .pandoc-pptx-preview {
    background-color: rgb(30, 30, 30);

    .pptx-slide-pin {
      color: #7fb0ff;
      background-color: rgba(45, 45, 45, 0.92);
      border-color: rgb(90, 90, 90);
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);

      &:hover {
        border-color: #7fb0ff;
      }
    }

    .pptx-preview-configuration {
      background-color: rgb(40, 40, 40);
      border-bottom-color: rgb(70, 70, 70);
      color: rgb(220, 220, 220);

      &.has-error {
        color: rgb(255, 150, 150);
        background-color: rgb(70, 35, 35);
        border-bottom-color: rgb(120, 60, 60);
      }

      .pptx-configuration-origin {
        color: rgb(160, 160, 160);
      }

      .pptx-configuration-message {
        color: rgb(170, 200, 170);
      }
    }

    .pptx-slide-card {
      background-color: rgb(45, 45, 45);
      border-color: rgb(70, 70, 70);
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
    }

    .pptx-slide-header { color: rgb(180, 180, 180); }

    .pptx-slide-image-frame { background-color: rgb(55, 55, 55); }

    .pptx-slide-carried-over-overlay {
      background-color: rgba(30, 30, 30, 0.5);

      span {
        color: rgb(220, 220, 220);
        background-color: rgba(45, 45, 45, 0.85);
      }
    }

    .pptx-slide-placeholder {
      color: rgb(160, 160, 160);
      border-color: rgb(90, 90, 90);
      background-color: rgb(55, 55, 55);
    }

    .pptx-slide-error {
      color: rgb(255, 150, 150);
      border-color: rgb(120, 60, 60);
      background-color: rgb(70, 35, 35);
    }

    .pptx-badge {
      &.pptx-badge-overflow {
        color: rgb(255, 160, 160);
        background-color: rgb(80, 40, 40);
        border-color: rgb(130, 70, 70);
      }

      &.pptx-badge-undersized {
        color: rgb(240, 200, 120);
        background-color: rgb(75, 60, 25);
        border-color: rgb(130, 105, 50);
      }
    }

    .pptx-preview-empty { color: rgb(160, 160, 160); }
  }
}
</style>
