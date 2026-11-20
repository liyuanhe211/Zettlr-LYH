<template>
  <div
    id="jev-search-panel"
    class="jev-search-panel"
    role="complementary"
    aria-label="JEV Search"
  >
    <div class="jev-search-settings">
      <h1>JEV Search</h1>
      <textarea
        id="jev-search-description"
        v-model="description"
        class="jev-search-description"
        placeholder="Describe what you are looking for"
        rows="4"
        aria-label="Search description"
        v-on:keydown="onDescriptionKeydown"
      ></textarea>
      <div class="jev-search-options">
        <label for="jev-search-max-characters">Max characters per chunk</label>
        <input
          id="jev-search-max-characters"
          class="jev-search-max-characters"
          type="number"
          step="100"
          v-bind:min="JEV_SEARCH_MIN_MAX_CHUNK_CHARACTERS"
          v-bind:max="JEV_SEARCH_MAX_MAX_CHUNK_CHARACTERS"
          v-bind:value="maxChunkCharacters"
          v-on:change="onMaxChunkCharactersChange"
        >
      </div>
      <div class="jev-search-actions">
        <button
          v-if="!isRunning"
          id="jev-search-start"
          class="jev-search-start"
          type="button"
          title="Search the current document (Ctrl+Enter in the description)"
          v-bind:disabled="!canStartSearch"
          v-on:click="startSearch()"
        >
          Search
        </button>
        <button
          v-else
          id="jev-search-cancel"
          class="jev-search-cancel"
          type="button"
          v-on:click="cancelSearch()"
        >
          Cancel
        </button>
      </div>
      <div
        id="jev-search-status"
        class="jev-search-status"
        role="status"
        aria-live="polite"
        v-bind:class="{ 'jev-search-status-error': statusIsError }"
      >
        {{ statusText }}
      </div>
    </div>

    <div id="jev-search-results" class="jev-search-results">
      <p v-if="emptyStateText !== ''" class="jev-search-empty">
        {{ emptyStateText }}
      </p>
      <template v-else-if="currentState !== undefined">
        <div class="jev-search-results-prompt" v-bind:title="currentState.prompt">
          Results for: {{ currentState.prompt }}
        </div>
        <ul
          class="jev-search-hit-list"
          role="list"
          v-on:mouseleave="onHitListMouseleave()"
        >
          <li
            v-for="hit in currentState.hits"
            v-bind:key="hit.chunkIndex"
            class="jev-search-hit"
            role="button"
            tabindex="0"
            v-bind:class="{
              selected: currentState.selectedChunkIndex === hit.chunkIndex,
              changed: hit.changed
            }"
            v-bind:data-chunk-index="hit.chunkIndex"
            v-bind:aria-pressed="currentState.selectedChunkIndex === hit.chunkIndex"
            v-on:click="revealHit(hit)"
            v-on:mouseenter="onHitMouseenter(hit)"
            v-on:mouseleave="onHitMouseleave()"
            v-on:keydown.enter.prevent="revealHit(hit)"
            v-on:keydown.space.prevent="revealHit(hit)"
          >
            <div class="jev-search-hit-header">
              <span class="jev-search-hit-confidence">{{ formatConfidence(hit.probability) }}</span>
              <span v-if="hit.pageLabel !== undefined" class="jev-search-hit-line">p. {{ hit.pageLabel }}</span>
              <span v-else class="jev-search-hit-line">Line {{ hit.line }}</span>
              <span v-if="hit.changed" class="jev-search-hit-changed">Changed since the search</span>
            </div>
            <div class="jev-search-hit-preview">
              {{ hit.preview }}
            </div>
          </li>
        </ul>
      </template>
    </div>
  </div>
</template>

<script lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        JevSearchPanel (module-level search state)
 * CVM-Role:        Model
 * License:         GNU GPL v3
 *
 * Description:     The searches and their results live at module level, so
 *                  that they survive closing the panel and switching tabs:
 *                  one entry per file path. A search keeps running while the
 *                  panel is closed. All searches of the window share one pool
 *                  of request slots, so that no more than
 *                  JEV_SEARCH_MAX_CONCURRENT_REQUESTS jev-search commands are
 *                  in flight at any time.
 *
 *                  R61: a PDF is searched in the text of its pages (contract
 *                  C5), chunked page by page; its hits carry a page label and
 *                  the location the PDF viewer highlights. Reading the pages
 *                  stops when another tab becomes active.
 *
 * END HEADER
 */

import { reactive, ref, watch } from 'vue'
import {
  jevChunkPreview,
  jevLineNumbers,
  planJevSearchBatches,
  rankJevSearchHits,
  splitIntoJevChunks
} from '@common/modules/jev-search'
import { pdfHasTextLayer, pdfJevChunkLocation, splitPdfIntoJevChunks } from '@common/modules/jev-search/pdf-chunks'
import { toQuoteText } from '@common/modules/pdf-text'
import { hasPDFExt } from '@common/util/file-extention-checks'
import { useDocumentTreeStore } from 'source/pinia'
import {
  JEV_SEARCH_COMMAND,
  JEV_SEARCH_MAX_CONCURRENT_REQUESTS,
  type JevSearchCommandArg,
  type JevSearchResult
} from '@dts/common/jev-search'
import type { PdfLocation, PdfViewerRequest } from '@dts/common/pdf-viewer'
import type { DocumentAuthorityIPCAPI } from 'source/app/service-providers/documents'
import { readJevSearchPdfText, type JevSearchPdfText } from './jev-search-pdf-text'

const ipcRenderer = window.ipc

/**
 * One hit of a finished search. `from`, `to` and `line` follow the chunk when
 * a click or a hover preview finds it at a new place.
 */
export interface JevSearchHit {
  /**
   * Position of the chunk in the document's chunk list at search time
   */
  chunkIndex: number
  from: number
  to: number
  /**
   * The chunk text at search time
   */
  text: string
  probability: number
  /**
   * 1-based line of the chunk's start; on hits in a PDF, the page number
   */
  line: number
  preview: string
  /**
   * True when the last click or hover preview no longer found the chunk text
   * in the document
   */
  changed: boolean
  /**
   * R61: only on hits in a PDF, the label of the hit's page, shown as
   * "p. <label>"; `from` and `to` are then offsets into that page's text
   */
  pageLabel?: string
  /**
   * R61: only on hits in a PDF, the place the PDF viewer scrolls to and
   * highlights. Computed at search time: a PDF does not change while it is
   * open, so clicks and previews neither read nor relocate anything.
   */
  location?: PdfLocation
}

/**
 * The search state and results of one file
 */
export interface JevFileSearchState {
  prompt: string
  running: boolean
  /**
   * True once the search completed and `hits` holds its results
   */
  finished: boolean
  status: string
  statusIsError: boolean
  /**
   * A message about the last click on a hit or hover preview of one; shown
   * instead of the status
   */
  notice: string
  hits: JevSearchHit[]
  selectedChunkIndex: number|undefined
  /**
   * R61: true when the searched PDF has no text layer (a scan without OCR);
   * nothing was sent then
   */
  noTextLayer?: boolean
}

/**
 * Search states by file path
 */
export const jevSearchStates = reactive(new Map<string, JevFileSearchState>())

/**
 * The description typed into the panel; kept while the panel is closed
 */
export const jevSearchDescription = ref('')

let requestsInFlight = 0
const requestSlotWaiters: Array<() => void> = []

async function acquireRequestSlot (): Promise<void> {
  if (requestsInFlight < JEV_SEARCH_MAX_CONCURRENT_REQUESTS) {
    requestsInFlight++
    return
  }
  await new Promise<void>(resolve => { requestSlotWaiters.push(resolve) })
}

function releaseRequestSlot (): void {
  const next = requestSlotWaiters.shift()
  if (next !== undefined) {
    next() // The slot passes straight to the next waiting request
  } else {
    requestsInFlight--
  }
}

function errorMessage (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Fetches the current text of an open document from the document authority
 * in the main process: the same command the editors load documents with. It
 * holds every edit the editors have pushed, saved or not; the editors push
 * each change right away.
 *
 * @param   {string}           filePath  The document
 *
 * @return  {Promise<string>}            Its current text
 */
export async function fetchJevSearchDocumentText (filePath: string): Promise<string> {
  const document: unknown = await ipcRenderer.invoke('documents-authority', {
    command: 'get-document',
    payload: { filePath }
  } as DocumentAuthorityIPCAPI)

  if (typeof document !== 'object' || document === null || typeof (document as { content?: unknown }).content !== 'string') {
    throw new Error('the document authority returned no text')
  }
  return (document as { content: string }).content
}

async function invokeJevSearchCommand (payload: JevSearchCommandArg): Promise<JevSearchResult> {
  try {
    const result: unknown = await ipcRenderer.invoke('application', { command: JEV_SEARCH_COMMAND, payload })
    if (typeof result !== 'object' || result === null || typeof (result as JevSearchResult).ok !== 'boolean') {
      return { ok: false, error: 'The jev-search command did not answer; see the log.' }
    }
    return result as JevSearchResult
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

function hasProbabilities (result: JevSearchResult, count: number): result is JevSearchResult & { probabilities: number[] } {
  return result.ok &&
    Array.isArray(result.probabilities) &&
    result.probabilities.length === count &&
    result.probabilities.every(probability => typeof probability === 'number' && Number.isFinite(probability))
}

function formatSummary (hitCount: number, chunkCount: number): string {
  return `${hitCount} ${hitCount === 1 ? 'hit' : 'hits'} in ${chunkCount} ${chunkCount === 1 ? 'chunk' : 'chunks'}`
}

/**
 * Has the jev-search command judge every chunk, in batches, sharing the
 * window's request slots, and reports the progress in the state's status.
 * Shared by the searches of documents and of PDFs.
 *
 * @param   {JevFileSearchState}  state       The search state
 * @param   {Function}            isCurrent   False once the search was
 *                                            cancelled or superseded
 * @param   {string}              prompt      The search description
 * @param   {string[]}            chunkTexts  The texts of the chunks
 *
 * @return  {Promise<number[]|undefined>}     The probability of every chunk;
 *                                            undefined when the search is no
 *                                            longer current, or when it failed
 *                                            (the state then holds the error
 *                                            and no longer runs)
 */
async function judgeJevChunks (state: JevFileSearchState, isCurrent: () => boolean, prompt: string, chunkTexts: string[]): Promise<number[]|undefined> {
  const batches = planJevSearchBatches(chunkTexts, prompt)
  const probabilities = new Array<number>(chunkTexts.length).fill(0)
  let nextBatch = 0
  let completedBatches = 0
  let failure: string|undefined
  state.status = `Judging batch 1 of ${batches.length}…`

  const worker = async (): Promise<void> => {
    for (;;) {
      await acquireRequestSlot()
      try {
        if (!isCurrent() || failure !== undefined || nextBatch >= batches.length) {
          return
        }

        const batch = batches[nextBatch]
        nextBatch++
        const result = await invokeJevSearchCommand({ prompt, chunks: batch.map(index => chunkTexts[index]) })

        if (!isCurrent() || failure !== undefined) {
          return
        }
        if (!hasProbabilities(result, batch.length)) {
          failure = result.error ?? 'The jev-search command returned no usable probabilities.'
          return
        }

        batch.forEach((chunkIndex, position) => {
          probabilities[chunkIndex] = result.probabilities[position]
        })
        completedBatches++
        if (completedBatches < batches.length) {
          state.status = `Judging batch ${completedBatches + 1} of ${batches.length}…`
        }
      } finally {
        releaseRequestSlot()
      }
    }
  }

  const workerCount = Math.min(JEV_SEARCH_MAX_CONCURRENT_REQUESTS, batches.length)
  await Promise.all(Array.from({ length: workerCount }, async () => { await worker() }))

  if (!isCurrent()) {
    return undefined
  }

  if (failure !== undefined) {
    // The main process caches every judged chunk, so searching again only
    // sends what is still missing; partial results are not shown.
    state.running = false
    state.status = failure
    state.statusIsError = true
    return undefined
  }

  return probabilities
}

/**
 * Runs a JEV search over the current text of a file and stores the outcome in
 * the file's search state. A running search of the same file is superseded.
 *
 * @param   {string}  filePath            The document to search
 * @param   {string}  prompt              The search description
 * @param   {number}  maxChunkCharacters  Upper bound of a chunk's length
 */
export async function runJevSearch (filePath: string, prompt: string, maxChunkCharacters: number): Promise<void> {
  if (hasPDFExt(filePath)) {
    await runPdfJevSearch(filePath, prompt, maxChunkCharacters)
    return
  }

  const state = reactive<JevFileSearchState>({
    prompt,
    running: true,
    finished: false,
    status: 'Reading the document…',
    statusIsError: false,
    notice: '',
    hits: [],
    selectedChunkIndex: undefined
  })
  jevSearchStates.set(filePath, state)

  // False once the search was cancelled or superseded: its results are dropped
  const isCurrent = (): boolean => jevSearchStates.get(filePath) === state && state.running

  let text: string
  try {
    text = await fetchJevSearchDocumentText(filePath)
  } catch (error) {
    if (isCurrent()) {
      state.running = false
      state.status = `Could not read the document: ${errorMessage(error)}`
      state.statusIsError = true
    }
    return
  }

  if (!isCurrent()) {
    return
  }

  const chunks = splitIntoJevChunks(text, maxChunkCharacters)
  if (chunks.length === 0) {
    state.running = false
    state.finished = true
    state.status = 'The document contains no text to search.'
    return
  }

  const probabilities = await judgeJevChunks(state, isCurrent, prompt, chunks.map(chunk => chunk.text))
  if (probabilities === undefined) {
    return
  }

  state.running = false
  const hitIndices = rankJevSearchHits(probabilities)
  const lineNumbers = jevLineNumbers(text, hitIndices.map(index => chunks[index].from))
  state.hits = hitIndices.map((chunkIndex, position) => ({
    chunkIndex,
    from: chunks[chunkIndex].from,
    to: chunks[chunkIndex].to,
    text: chunks[chunkIndex].text,
    probability: probabilities[chunkIndex],
    line: lineNumbers[position],
    preview: jevChunkPreview(chunks[chunkIndex].text),
    changed: false
  }))
  state.finished = true
  state.status = formatSummary(state.hits.length, chunks.length)
}

/**
 * Abort controllers of the PDF texts being read, by file path. They only
 * abort the reading; the judging of the chunks ends like that of a document.
 */
const pdfReadControllers = new Map<string, AbortController>()

/**
 * Abort reason when another tab became active while the pages were read
 */
const ABORTED_BY_TAB_SWITCH = 'Another tab became active'

/**
 * Runs a JEV search over the text of a PDF (R61, contract C5): reads the text
 * of every page with progress, chunks every page on its own, has the chunks
 * judged like those of a document, and stores hits that carry their page
 * label and viewer location. Reading stops when another tab becomes active;
 * a PDF without a text layer is not sent at all.
 *
 * @param   {string}  filePath            The PDF to search
 * @param   {string}  prompt              The search description
 * @param   {number}  maxChunkCharacters  Upper bound of a chunk's length
 */
async function runPdfJevSearch (filePath: string, prompt: string, maxChunkCharacters: number): Promise<void> {
  const state = reactive<JevFileSearchState>({
    prompt,
    running: true,
    finished: false,
    status: 'Reading the PDF…',
    statusIsError: false,
    notice: '',
    hits: [],
    selectedChunkIndex: undefined,
    noTextLayer: false
  })

  // A new search of the same file supersedes the reading of the previous one
  pdfReadControllers.get(filePath)?.abort()
  const controller = new AbortController()
  pdfReadControllers.set(filePath, controller)
  jevSearchStates.set(filePath, state)

  // False once the search was cancelled or superseded: its results are dropped
  const isCurrent = (): boolean => jevSearchStates.get(filePath) === state && state.running

  // The panel's own watchers do not exist while it is closed, so the search
  // itself watches for another tab becoming active while it reads the pages
  const stopWatching = watch(() => useDocumentTreeStore().lastLeafActiveFile?.path, (activePath) => {
    if (activePath !== filePath) {
      controller.abort(ABORTED_BY_TAB_SWITCH)
    }
  })

  let pdfText: JevSearchPdfText|undefined
  try {
    pdfText = await readJevSearchPdfText(filePath, {
      signal: controller.signal,
      onProgress: (done, total) => {
        if (isCurrent()) {
          state.status = `Reading page ${done} of ${total}…`
        }
      }
    })
  } catch (error) {
    // A cancelled or superseded search has already got its status
    if (isCurrent()) {
      state.running = false
      if (controller.signal.reason === ABORTED_BY_TAB_SWITCH) {
        state.status = 'Stopped reading the PDF because another tab became active. Press Search to start again.'
      } else {
        state.status = `Could not read this PDF: ${errorMessage(error)}`
        state.statusIsError = true
      }
    }
  } finally {
    stopWatching()
    if (pdfReadControllers.get(filePath) === controller) {
      pdfReadControllers.delete(filePath)
    }
  }

  if (pdfText === undefined || !isCurrent()) {
    return
  }

  const text = pdfText
  const pageTexts = text.pages.map(page => page.pageText)
  if (!pdfHasTextLayer(pageTexts)) {
    // The panel shows the explanation in place of the hits
    state.running = false
    state.noTextLayer = true
    state.status = ''
    return
  }

  const chunks = splitPdfIntoJevChunks(pageTexts, maxChunkCharacters)
  if (chunks.length === 0) {
    state.running = false
    state.finished = true
    state.status = 'The document contains no text to search.'
    return
  }

  const probabilities = await judgeJevChunks(state, isCurrent, prompt, chunks.map(chunk => chunk.text))
  if (probabilities === undefined) {
    return
  }

  state.running = false
  state.hits = rankJevSearchHits(probabilities).map(chunkIndex => {
    const chunk = chunks[chunkIndex]
    return {
      chunkIndex,
      from: chunk.from,
      to: chunk.to,
      text: chunk.text,
      probability: probabilities[chunkIndex],
      line: chunk.page,
      // Joins words hyphenated at line ends, like a quote from the PDF
      preview: jevChunkPreview(toQuoteText(chunk.text)),
      changed: false,
      pageLabel: text.pageLabels[chunk.page - 1] ?? String(chunk.page),
      location: pdfJevChunkLocation(text.pages, chunk)
    }
  })
  state.finished = true
  state.status = formatSummary(state.hits.length, chunks.length)
}

/**
 * Cancels the running search of a file: no further batch is sent, and the
 * answers still on their way are dropped. Reading a PDF's pages stops.
 *
 * @param   {string}  filePath  The document
 */
export function cancelJevSearch (filePath: string): void {
  const state = jevSearchStates.get(filePath)
  if (state === undefined || !state.running) {
    return
  }
  state.running = false
  state.status = 'Search cancelled.'
  state.statusIsError = false
  pdfReadControllers.get(filePath)?.abort()
}
</script>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        JevSearchPanel
 * CVM-Role:        View
 * License:         GNU GPL v3
 *
 * Description:     The JEV Search panel (R53): a description, the maximum
 *                  chunk length and a Search button on top, the hits of the
 *                  active document below. Clicking a hit has the editor
 *                  scroll to it and highlight it; App.vue relays the
 *                  highlight request to the editors.
 *
 *                  R57: resting the pointer on a hit previews it the same way
 *                  without pinning it. Leaving the list of hits takes the
 *                  highlight back to the pinned hit (the clicked one, shown
 *                  as selected) without scrolling, or removes it when no hit
 *                  is pinned. Clicking a hit pins it; pressing the mouse in
 *                  an editor unpins it and removes the highlight.
 *
 *                  R61: on a PDF, the same interactions go to the PDF viewer
 *                  as pdfRequest events (contract C5's location request),
 *                  which App.vue relays; pressing the mouse on the viewer's
 *                  pages counts like a press in an editor.
 *
 * END HEADER
 */

// watch, useDocumentTreeStore, hasPDFExt and the PDF types come from the
// plain script block above
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useConfigStore } from 'source/pinia'
import { hasMdOrCodeExt } from '@common/util/file-extention-checks'
// jevLineNumbers comes from the plain script block above; both blocks share one module scope
import {
  clampJevMaxChunkCharacters,
  locateJevChunk,
  type JevSearchHighlightRequest
} from '@common/modules/jev-search'
import {
  JEV_SEARCH_HIT_THRESHOLD,
  JEV_SEARCH_MAX_MAX_CHUNK_CHARACTERS,
  JEV_SEARCH_MIN_MAX_CHUNK_CHARACTERS
} from '@dts/common/jev-search'

const emit = defineEmits<{
  (e: 'highlight', request: JevSearchHighlightRequest): void
  (e: 'pdfRequest', request: PdfViewerRequest): void
}>()

const configStore = useConfigStore()
const documentTreeStore = useDocumentTreeStore()

const description = jevSearchDescription

const activeFilePath = computed<string|undefined>(() => documentTreeStore.lastLeafActiveFile?.path)
const canSearchActiveFile = computed<boolean>(() => {
  const filePath = activeFilePath.value
  return filePath !== undefined && (hasMdOrCodeExt(filePath) || hasPDFExt(filePath))
})

const currentState = computed<JevFileSearchState|undefined>(() => {
  return activeFilePath.value === undefined ? undefined : jevSearchStates.get(activeFilePath.value)
})

const isRunning = computed<boolean>(() => currentState.value?.running === true)
const canStartSearch = computed<boolean>(() => canSearchActiveFile.value && description.value.trim() !== '' && !isRunning.value)

const maxChunkCharacters = computed<number>(() => {
  const configured: unknown = configStore.config.jevSearch?.maxChunkCharacters
  return clampJevMaxChunkCharacters(typeof configured === 'number' ? configured : Number.NaN)
})

const statusText = computed<string>(() => {
  const state = currentState.value
  if (state === undefined) {
    return ''
  }
  return state.notice !== '' ? state.notice : state.status
})

const statusIsError = computed<boolean>(() => {
  const state = currentState.value
  return state !== undefined && state.notice === '' && state.statusIsError
})

const emptyStateText = computed<string>(() => {
  const state = currentState.value
  if (activeFilePath.value === undefined) {
    return 'Open a document to search it.'
  } else if (!canSearchActiveFile.value) {
    return 'JEV Search works on Markdown, code and PDF files.'
  } else if (state === undefined) {
    return 'No results for this document yet. Describe what you are looking for and press Search.'
  } else if (state.noTextLayer === true) {
    return 'This PDF has no text layer. Run OCR first.'
  } else if (state.running) {
    return 'The hits will appear here when the search is done.'
  } else if (!state.finished) {
    return 'No results. Press Search to try again.'
  } else if (state.hits.length === 0) {
    return `No passage reached ${Math.round(JEV_SEARCH_HIT_THRESHOLD * 100)}% confidence.`
  }
  return ''
})

/**
 * How long the pointer has to rest on a hit before the editor previews it
 * (R57). Without the delay, sweeping the pointer across several hits would
 * make the editor jump back and forth.
 */
const HOVER_PREVIEW_DELAY_MS = 120

// The hover preview (R57) is a highlight shown while the pointer rests on a
// hit; it leaves the pinned hit (state.selectedChunkIndex) as it is.
let hoverTimer: ReturnType<typeof setTimeout>|undefined
// True while the editor shows a preview rather than the pinned hit
let previewShown = false
// True while the document read of a preview is on its way
let previewPending = false
// Increased by every action that changes the highlight (preview, going back
// to the pinned hit, pinning, a press in an editor, switching documents, a
// new search, closing the panel): a document read that returns after a newer
// action started is dropped, so that no outdated highlight pops up.
let highlightSequence = 0

/**
 * Starts a new highlight action, which supersedes every earlier one.
 *
 * @return  {number}  The sequence number of the new action
 */
function nextHighlightSequence (): number {
  previewPending = false
  highlightSequence++
  return highlightSequence
}

function cancelHoverTimer (): void {
  if (hoverTimer !== undefined) {
    clearTimeout(hoverTimer)
    hoverTimer = undefined
  }
}

/**
 * Forgets the hover preview: cancels the preview timer and clears the flag
 * that a preview is shown. Tells the editor nothing.
 */
function endPreview (): void {
  cancelHoverTimer()
  previewShown = false
}

/**
 * Removes the highlight of the hits of a file: for a PDF the PDF viewers'
 * location highlight (R61), otherwise the editors' highlight.
 *
 * @param   {string|undefined}  filePath  The file whose hit may be highlighted
 */
function emitClearHighlight (filePath: string|undefined): void {
  if (filePath !== undefined && hasPDFExt(filePath)) {
    emit('pdfRequest', { filePath, location: null })
  } else {
    emit('highlight', null)
  }
}

// The editor drops its highlight when another document becomes active, so the
// previous document's hit is no longer shown as selected either
watch(activeFilePath, (_newPath, oldPath) => {
  const previewWasShown = previewShown
  endPreview()
  nextHighlightSequence()

  const previous = oldPath === undefined ? undefined : jevSearchStates.get(oldPath)
  let pinWasShown = false
  if (previous !== undefined) {
    previous.notice = ''
    if (previous.selectedChunkIndex !== undefined) {
      previous.selectedChunkIndex = undefined
      pinWasShown = true
    }
  }
  if (pinWasShown || previewWasShown) {
    emitClearHighlight(oldPath)
  }
})

// A press in an editor removes the highlight (R57)
onMounted(() => {
  document.addEventListener('mousedown', onDocumentMousedown, true)
})

// Closing the panel removes the highlight (App.vue tells the editors)
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocumentMousedown, true)
  endPreview()
  nextHighlightSequence()
  for (const state of jevSearchStates.values()) {
    state.selectedChunkIndex = undefined
    state.notice = ''
  }
})

function formatConfidence (probability: number): string {
  return `${Math.round(probability * 100)}%`
}

function onDescriptionKeydown (event: KeyboardEvent): void {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    startSearch()
  }
}

function onMaxChunkCharactersChange (event: Event): void {
  const input = event.target as HTMLInputElement
  const clamped = clampJevMaxChunkCharacters(input.value.trim() === '' ? Number.NaN : Number(input.value))
  // Show the clamped value even when it equals the stored one
  input.value = String(clamped)
  if (clamped !== configStore.config.jevSearch?.maxChunkCharacters) {
    configStore.setConfigValue('jevSearch.maxChunkCharacters', clamped)
  }
}

function startSearch (): void {
  const filePath = activeFilePath.value
  if (filePath === undefined || !canStartSearch.value) {
    return
  }
  endPreview()
  nextHighlightSequence()
  emitClearHighlight(filePath)
  runJevSearch(filePath, description.value.trim(), maxChunkCharacters.value)
    .catch(error => console.error('[JEV Search] The search failed', error))
}

function cancelSearch (): void {
  if (activeFilePath.value !== undefined) {
    cancelJevSearch(activeFilePath.value)
  }
}

/**
 * Has the editor show a hit: in place when its text is unchanged, otherwise
 * at the occurrence of its text closest to where it was. When the text no
 * longer occurs, the hit is marked as changed. Shared by pinning, the hover
 * preview and going back to the pinned hit (R57).
 *
 * @param   {JevSearchHit}  hit             The hit to show
 * @param   {boolean}       options.scroll  Whether the editor scrolls the hit
 *                                          into the middle of the view
 * @param   {boolean}       options.pin     True pins the hit (it becomes the
 *                                          selected one); false shows it as a
 *                                          hover preview
 */
function showHit (hit: JevSearchHit, options: { scroll: boolean, pin: boolean }): void {
  const filePath = activeFilePath.value
  const state = currentState.value
  if (filePath === undefined || state === undefined) {
    return
  }

  // R61: a hit in a PDF carries its location; the PDF does not change while
  // it is open, so the viewer gets the request right away
  if (hit.location !== undefined) {
    nextHighlightSequence()
    state.notice = ''
    if (options.pin) {
      state.selectedChunkIndex = hit.chunkIndex
    }
    previewShown = !options.pin
    const request: PdfViewerRequest = { filePath, location: hit.location }
    emit('pdfRequest', options.scroll ? request : { ...request, scroll: false })
    return
  }

  const sequence = nextHighlightSequence()
  previewPending = !options.pin
  fetchJevSearchDocumentText(filePath)
    .then(text => {
      // A newer highlight action started meanwhile, or the user switched
      // documents or searched again
      if (sequence !== highlightSequence || activeFilePath.value !== filePath || jevSearchStates.get(filePath) !== state) {
        return
      }
      previewPending = false

      const location = locateJevChunk(text, hit)
      if (location === undefined) {
        hit.changed = true
        state.notice = 'This passage has changed since the search. Search again to update the results.'
        if (state.selectedChunkIndex === hit.chunkIndex) {
          state.selectedChunkIndex = undefined
          previewShown = false
          emit('highlight', null)
        }
        return
      }

      hit.changed = false
      if (location.from !== hit.from) {
        hit.from = location.from
        hit.to = location.to
        hit.line = jevLineNumbers(text, [location.from])[0]
      }
      state.notice = ''
      if (options.pin) {
        state.selectedChunkIndex = hit.chunkIndex
      }
      previewShown = !options.pin
      const request = { filePath, from: location.from, to: location.to }
      emit('highlight', options.scroll ? request : { ...request, scroll: false })
    })
    .catch(error => {
      if (sequence !== highlightSequence) {
        return
      }
      previewPending = false
      state.notice = `Could not read the document: ${error instanceof Error ? error.message : String(error)}`
    })
}

/**
 * Pins a hit (click, Enter or Space): the editor highlights it and scrolls it
 * into the middle of the view, and the highlight stays on it after the
 * pointer leaves the list of hits.
 *
 * @param   {JevSearchHit}  hit  The clicked hit
 */
function revealHit (hit: JevSearchHit): void {
  // Otherwise a preview timer still running would fire after the click
  endPreview()
  showHit(hit, { scroll: true, pin: true })
}

/**
 * Starts the hover preview of a hit (R57): once the pointer has rested on it
 * for HOVER_PREVIEW_DELAY_MS, the editor highlights the hit and scrolls it
 * into the middle of the view, without pinning it.
 *
 * @param   {JevSearchHit}  hit  The hit under the pointer
 */
function onHitMouseenter (hit: JevSearchHit): void {
  cancelHoverTimer()
  hoverTimer = setTimeout(() => {
    hoverTimer = undefined
    showHit(hit, { scroll: true, pin: false })
  }, HOVER_PREVIEW_DELAY_MS)
}

function onHitMouseleave (): void {
  cancelHoverTimer()
}

/**
 * Ends the hover preview when the pointer leaves the list of hits (moving
 * between hits does not count). After a preview was shown, the editor goes
 * back to the pinned hit without scrolling, since the user often moves on to
 * read the previewed passage and scrolling away would interrupt that; with no
 * hit pinned, the highlight is removed. A preview that never showed sends
 * nothing.
 */
function onHitListMouseleave (): void {
  cancelHoverTimer()
  if (previewPending) {
    nextHighlightSequence() // Drops the preview still on its way
  }
  if (!previewShown) {
    return
  }
  previewShown = false

  const state = currentState.value
  const pinnedIndex = state?.selectedChunkIndex
  const pinnedHit = pinnedIndex === undefined ? undefined : state?.hits.find(hit => hit.chunkIndex === pinnedIndex)
  if (pinnedHit !== undefined) {
    showHit(pinnedHit, { scroll: false, pin: true })
  } else {
    nextHighlightSequence()
    emitClearHighlight(activeFilePath.value)
  }
}

/**
 * Removes the highlight when the user presses the mouse in an editor (R57)
 * or on the pages of a PDF viewer (R61): the pinned hit is unpinned and a
 * hover preview ends. A press on a scrollbar or on the viewer's toolbar does
 * not count. Listens on the document in the capture phase, so that no editor
 * can swallow the event first.
 *
 * @param   {MouseEvent}  event  The mousedown event
 */
function onDocumentMousedown (event: MouseEvent): void {
  const target = event.target
  if (!(target instanceof Element) || target.closest('.main-editor-wrapper, .pdfjs-viewer .pdfjs-viewer-pages .pdfViewer') === null) {
    return
  }
  // A press on a scrollbar lands on the scrolling element itself, beyond its
  // client area. Inline elements have a client size of zero, so only an
  // element that actually scrolls is checked; otherwise every press on an
  // inline element would look like one on a scrollbar.
  const isScrollable = target.scrollHeight > target.clientHeight || target.scrollWidth > target.clientWidth
  if (isScrollable && (event.offsetX >= target.clientWidth || event.offsetY >= target.clientHeight)) {
    return
  }

  const state = currentState.value
  const isPinned = state !== undefined && state.selectedChunkIndex !== undefined
  const showsHighlight = isPinned || previewShown
  if (!showsHighlight && !previewPending && hoverTimer === undefined) {
    return
  }

  endPreview()
  nextHighlightSequence()
  if (state !== undefined) {
    state.selectedChunkIndex = undefined
  }
  if (showsHighlight) {
    emitClearHighlight(activeFilePath.value)
  }
}
</script>

<style lang="less">
body {
  div.jev-search-panel {
    flex: 0 0 340px;
    width: 340px;
    height: 100%;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background-color: rgb(230, 230, 230);
    border-left: 1px solid rgb(213, 213, 213);
    font-size: 13px;

    h1 {
      font-size: 16px;
      margin: 0 0 10px 0;
    }

    div.jev-search-settings {
      flex-shrink: 0;
      padding: 10px;
      border-bottom: 1px solid rgb(213, 213, 213);
    }

    textarea.jev-search-description {
      width: 100%;
      box-sizing: border-box;
      resize: vertical;
      min-height: 60px;
      font-family: inherit;
      font-size: 13px;
      padding: 4px 6px;
      border: 1px solid #c0c4cc;
      border-radius: 0;
      background-color: #ffffff;
      color: #111827;

      &:focus {
        outline: none;
        border-color: #3b78d1;
      }
    }

    div.jev-search-options {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-top: 8px;

      input.jev-search-max-characters {
        width: 80px;
        padding: 2px 4px;
        border: 1px solid #c0c4cc;
        border-radius: 0;
        background-color: #ffffff;
        color: #111827;
      }
    }

    div.jev-search-actions {
      margin-top: 8px;

      button {
        border-radius: 0;
        padding: 3px 14px;
        font-weight: bold;
        cursor: pointer;
      }

      // Action button of the design language: light action-blue fill
      button.jev-search-start {
        background-color: #d6e8fa;
        color: #1a3d6b;
        border: 1px solid #b8d2ec;

        &:hover:not(:disabled) {
          border-color: #3b78d1;
          background-color: #e6f2ff;
        }

        &:active:not(:disabled) {
          background-color: #b8d2ec;
        }

        &:disabled {
          opacity: 0.5;
          cursor: default;
        }
      }

      button.jev-search-cancel {
        background-color: #eceef2;
        color: #374151;
        border: 1px solid #c0c4cc;

        &:hover {
          border-color: #3b78d1;
        }

        &:active {
          background-color: #dcdfe5;
        }
      }
    }

    div.jev-search-status {
      margin-top: 8px;
      min-height: 1.3em;
      font-size: 12px;
      color: #374151;
      overflow-wrap: anywhere;

      &.jev-search-status-error {
        color: #b42318;
      }
    }

    div.jev-search-results {
      flex: 1 1 auto;
      overflow-y: auto;
      padding: 10px;
    }

    p.jev-search-empty {
      margin: 0;
      font-size: 12px;
      color: #6b7280;
    }

    div.jev-search-results-prompt {
      font-size: 12px;
      color: #6b7280;
      margin-bottom: 8px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    ul.jev-search-hit-list {
      list-style: none;
      margin: 0;
      padding: 0;
    }

    li.jev-search-hit {
      padding: 6px 8px;
      margin-bottom: 6px;
      background-color: rgba(255, 255, 255, 0.7);
      border: 1px solid transparent;
      border-left: 3px solid transparent;
      cursor: pointer;

      &:hover,
      &:focus {
        outline: none;
        border-color: #3b78d1;
      }

      // The same amber as the bar on the left edge of the editor's highlight
      &.selected {
        background-color: rgba(255, 196, 0, 0.25);
        border-left-color: rgb(224, 160, 0);
      }

      &.changed {
        opacity: 0.5;
      }

      div.jev-search-hit-header {
        display: flex;
        align-items: baseline;
        gap: 8px;
        margin-bottom: 3px;
        font-size: 12px;
      }

      span.jev-search-hit-confidence {
        font-weight: bold;
        color: #1a3d6b;
      }

      span.jev-search-hit-line {
        color: #6b7280;
      }

      span.jev-search-hit-changed {
        font-style: italic;
        color: #6b7280;
      }

      div.jev-search-hit-preview {
        font-size: 12px;
        line-height: 1.4;
        overflow-wrap: anywhere;
      }
    }
  }

  &.dark div.jev-search-panel {
    background-color: rgba(30, 30, 30, 1);
    border-left-color: rgb(80, 80, 80);
    color: rgb(230, 230, 230);

    div.jev-search-settings {
      border-bottom-color: rgb(80, 80, 80);
    }

    textarea.jev-search-description,
    input.jev-search-max-characters {
      background-color: rgb(45, 45, 45);
      color: rgb(230, 230, 230);
      border-color: rgb(90, 90, 90);
    }

    div.jev-search-status {
      color: rgb(200, 200, 200);

      &.jev-search-status-error {
        color: #f97066;
      }
    }

    p.jev-search-empty,
    div.jev-search-results-prompt,
    li.jev-search-hit span.jev-search-hit-line,
    li.jev-search-hit span.jev-search-hit-changed {
      color: rgb(160, 160, 160);
    }

    li.jev-search-hit {
      background-color: rgba(255, 255, 255, 0.06);

      &.selected {
        background-color: rgba(255, 196, 0, 0.2);
      }

      span.jev-search-hit-confidence {
        color: #9cc4f0;
      }
    }
  }
}
</style>
