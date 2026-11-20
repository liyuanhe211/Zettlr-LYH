<template>
  <div
    class="pdf-find-bar"
    role="search"
    v-on:keydown="handleBarKeydown"
  >
    <input
      ref="queryInput"
      class="pdf-find-input"
      type="text"
      placeholder="Find in PDF"
      aria-label="Find in PDF"
      spellcheck="false"
      autocomplete="off"
      v-bind:value="query"
      v-on:input="handleInput"
      v-on:compositionend="handleCompositionEnd"
      v-on:keydown="handleInputKeydown"
    >
    <!-- The buttons must not take the focus away from the input, so that
    Enter keeps working after clicking them -->
    <button
      type="button"
      class="pdf-find-button"
      title="Previous match (Shift+Enter)"
      aria-label="Previous match"
      v-bind:disabled="query === ''"
      v-on:mousedown.prevent
      v-on:click="findAgain(true)"
    >
      <cds-icon shape="angle" direction="up" role="presentation"></cds-icon>
    </button>
    <button
      type="button"
      class="pdf-find-button"
      title="Next match (Enter)"
      aria-label="Next match"
      v-bind:disabled="query === ''"
      v-on:mousedown.prevent
      v-on:click="findAgain(false)"
    >
      <cds-icon shape="angle" direction="down" role="presentation"></cds-icon>
    </button>
    <span class="pdf-find-count" role="status">{{ countLabel }}</span>
    <button
      type="button"
      class="pdf-find-button pdf-find-close"
      title="Close (Esc)"
      aria-label="Close find bar"
      v-on:click="close"
    >
      <cds-icon shape="times" role="presentation"></cds-icon>
    </button>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        PdfFindBar
 * CVM-Role:        View
 * License:         GNU GPL v3
 *
 * Description:     The find bar of the pdf.js-based PDF viewer (Zettlr-LYH
 *                  R59). It drives pdf.js' PDFFindController only through the
 *                  viewer's EventBus, exactly like pdf.js' own find bar does:
 *                  typing dispatches a new query, Enter and Shift+Enter (or
 *                  the arrow buttons) move to the next and previous match, and
 *                  Escape (or the close button) ends the search, which removes
 *                  the highlights. Matching ignores case and diacritics, every
 *                  match is highlighted, and the bar shows "N of M".
 *
 * END HEADER
 */
import { computed, onBeforeUnmount, ref, toRaw, watch } from 'vue'
// Type imports only: pdf_viewer.mjs reads globalThis.pdfjsLib as soon as it is
// loaded, so only the viewer itself may import it, after pdf.mjs.
import type { EventBus, PDFFindController } from 'pdfjs-dist/web/pdf_viewer.mjs'

/**
 * The values of pdf.js' FindState that the bar distinguishes (web/
 * pdf_viewer.mjs: FOUND 0, NOT_FOUND 1, WRAPPED 2, PENDING 3). They are
 * repeated here for the reason given at the import above.
 */
const FIND_STATE_NOT_FOUND = 1
const FIND_STATE_PENDING = 3

/**
 * The `type` of a find event: an empty string starts a new search, `again`
 * moves to the next or previous match, `highlightallchange` only shows the
 * highlights of the current search again.
 */
type FindEventType = ''|'again'|'highlightallchange'

interface MatchesCount {
  current: number
  total: number
}

interface FindMatchesCountEvent {
  source: unknown
  matchesCount: MatchesCount
}

interface FindControlStateEvent {
  source: unknown
  state: number
  previous: boolean
  matchesCount: MatchesCount
}

const props = defineProps<{
  eventBus: EventBus|null
  findController: PDFFindController|null
}>()

const emit = defineEmits<(e: 'close') => void>()

const queryInput = ref<HTMLInputElement|null>(null)
const query = ref<string>('')
const matchesCount = ref<MatchesCount>({ current: 0, total: 0 })
const findState = ref<number|null>(null)

// Passed as the source of every event this bar dispatches, the way pdf.js'
// own find bar passes itself
const findBarSource = { component: 'PdfFindBar' }

// True from the moment the bar has ended a search until a find event shows
// the highlights again
let highlightsHidden = false

// Aborting it removes all listeners from the current event bus
let listenerAbortController: AbortController|null = null

const countLabel = computed<string>(() => {
  if (query.value === '') {
    return ''
  }

  const { current, total } = matchesCount.value
  if (total > 0) {
    return `${current} of ${total}`
  }

  // While pdf.js is still searching, a total of zero does not mean anything yet
  if (findState.value === FIND_STATE_NOT_FOUND) {
    return 'No results'
  }

  return ''
})

/**
 * Returns the event bus as the raw object. pdf.js keeps its listeners in
 * private class fields, which cannot be reached through a reactive proxy, so
 * this guards against a property that was handed down through one.
 */
function rawEventBus (): EventBus|null {
  return props.eventBus === null ? null : toRaw(props.eventBus)
}

/**
 * Dispatches a find event with the current query. Matching always ignores
 * case and diacritics and highlights every match.
 *
 * @param   {FindEventType}  type           What the event asks for
 * @param   {boolean}        findPrevious   Whether to move backwards
 */
function dispatchFind (type: FindEventType, findPrevious = false): void {
  const eventBus = rawEventBus()
  if (eventBus === null) {
    return
  }

  highlightsHidden = false
  eventBus.dispatch('find', {
    source: findBarSource,
    type,
    query: query.value,
    caseSensitive: false,
    entireWord: false,
    highlightAll: true,
    findPrevious,
    matchDiacritics: false
  })
}

/**
 * Moves to the next or previous match of the current query.
 *
 * @param   {boolean}  findPrevious  Whether to move backwards
 */
function findAgain (findPrevious: boolean): void {
  if (query.value === '') {
    return
  }

  dispatchFind('again', findPrevious)
}

/**
 * Ends the search: pdf.js removes the highlights but remembers the query, so
 * that the search can continue where it left off.
 */
function endSearch (): void {
  rawEventBus()?.dispatch('findbarclose', { source: findBarSource })
  highlightsHidden = true
}

function close (): void {
  endSearch()
  emit('close')
}

function handleInput (event: Event): void {
  query.value = (event.target as HTMLInputElement).value
  if ((event as InputEvent).isComposing) {
    // An input method is still composing; searching for half-typed syllables
    // would only flicker. The search starts on compositionend instead.
    return
  }

  findState.value = FIND_STATE_PENDING
  dispatchFind('')
}

function handleCompositionEnd (event: CompositionEvent): void {
  query.value = (event.target as HTMLInputElement).value
  findState.value = FIND_STATE_PENDING
  dispatchFind('')
}

function handleInputKeydown (event: KeyboardEvent): void {
  // The Enter that confirms an input method's candidate is not ours
  if (event.key !== 'Enter' || event.isComposing) {
    return
  }

  event.preventDefault()
  findAgain(event.shiftKey)
}

function handleBarKeydown (event: KeyboardEvent): void {
  // While composing, Escape cancels the composition instead
  if (event.key !== 'Escape' || event.isComposing) {
    return
  }

  event.preventDefault()
  event.stopPropagation()
  close()
}

/**
 * Tells whether an event comes from the find controller this bar belongs to.
 * The controller passes itself as the source; the comparison uses the raw
 * object in case the property was handed down through a reactive proxy.
 *
 * @param   {unknown}  source  The source field of the event
 */
function isFromOwnController (source: unknown): boolean {
  return props.findController === null || source === toRaw(props.findController)
}

function handleMatchesCount (event: FindMatchesCountEvent): void {
  if (!isFromOwnController(event.source)) {
    return
  }

  matchesCount.value = { ...event.matchesCount }
}

function handleControlState (event: FindControlStateEvent): void {
  if (!isFromOwnController(event.source)) {
    return
  }

  findState.value = event.state
  matchesCount.value = { ...event.matchesCount }
}

/**
 * Forgets the results shown, e.g., because the viewer has been given another
 * document (pdf.js then resets its find controller as well).
 */
function resetResults (): void {
  matchesCount.value = { current: 0, total: 0 }
  findState.value = null
  highlightsHidden = false
}

watch(() => props.eventBus, () => {
  listenerAbortController?.abort()
  listenerAbortController = null
  resetResults()

  const eventBus = rawEventBus()
  if (eventBus === null) {
    return
  }

  const abortController = new AbortController()
  const options = { signal: abortController.signal }
  eventBus.on('updatefindmatchescount', handleMatchesCount, options)
  eventBus.on('updatefindcontrolstate', handleControlState, options)
  eventBus.on('pagesdestroy', resetResults, options)
  listenerAbortController = abortController
}, { immediate: true })

watch(() => props.findController, () => {
  resetResults()
})

onBeforeUnmount(() => {
  // A bar that disappears without being closed must not leave highlights behind
  if (!highlightsHidden && query.value !== '') {
    endSearch()
  }

  listenerAbortController?.abort()
  listenerAbortController = null
})

/**
 * Focuses the query input and selects its text. When the bar had ended a
 * search before, the highlights of that search are shown again.
 */
function focus (): void {
  const input = queryInput.value
  if (input === null) {
    return
  }

  input.focus()
  input.select()

  if (highlightsHidden && query.value !== '') {
    dispatchFind('highlightallchange')
  }
}

defineExpose({ focus })
</script>

<style lang="less">
body {
  div.pdf-find-bar {
    display: flex;
    align-items: center;
    gap: 4px;
    box-sizing: border-box;
    width: 100%;
    padding: 4px 6px;
    font-size: 13px;
    // Same colors as the search panel of the Markdown editor (editor.css)
    color: black;
    background-color: #f5f5f5;
    border-bottom: 1px solid var(--grey-1);
    user-select: none;

    input.pdf-find-input {
      flex: 0 1 240px;
      min-width: 80px;
      box-sizing: border-box;
      padding: 2px 6px;
      font-family: inherit;
      font-size: inherit;
      color: inherit;
      background-color: white;
      border: 1px solid var(--grey-2);
      border-radius: 3px;
      user-select: text;

      &:focus {
        outline: 2px solid var(--system-accent-color, rgb(40, 100, 255));
        outline-offset: -1px;
      }
    }

    button.pdf-find-button {
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      box-sizing: border-box;
      width: 22px;
      height: 22px;
      padding: 0;
      color: inherit;
      background-color: transparent;
      border: 1px solid transparent;
      border-radius: 3px;
      cursor: pointer;

      cds-icon {
        width: 14px;
        height: 14px;
      }

      &:hover:not(:disabled) {
        border-color: var(--grey-2);
        background-color: var(--grey-1);
      }

      &:disabled {
        opacity: 0.4;
        cursor: default;
      }

      // The close button sits at the far end of the bar
      &.pdf-find-close {
        margin-left: auto;
      }
    }

    span.pdf-find-count {
      padding: 0 4px;
      white-space: nowrap;
      color: rgb(100, 100, 100);
      font-variant-numeric: tabular-nums;

      &:empty {
        display: none;
      }
    }
  }

  &.dark div.pdf-find-bar {
    color: white;
    background-color: #333333;
    border-bottom-color: var(--grey-6);

    input.pdf-find-input {
      background-color: var(--grey-7);
      border-color: var(--grey-5);
    }

    button.pdf-find-button:hover:not(:disabled) {
      border-color: var(--grey-4);
      background-color: var(--grey-6);
    }

    span.pdf-find-count {
      color: rgb(170, 170, 170);
    }
  }
}
</style>
