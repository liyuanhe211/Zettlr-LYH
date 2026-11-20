<template>
  <div
    ref="rootElement"
    class="conversation-viewer"
    v-bind:class="{ 'conversation-find-open': findOpen }"
    role="document"
    aria-label="Conversation history"
    tabindex="-1"
    v-on:focusin="emit('focus-viewer')"
    v-on:click="preventLinkActivation"
    v-on:auxclick="preventLinkActivation"
  >
    <div
      v-if="findOpen"
      ref="findBarElement"
      class="conversation-find-bar"
      role="search"
      v-on:keydown="handleFindBarKeydown"
    >
      <input
        ref="findInput"
        class="conversation-find-input"
        type="text"
        placeholder="Find in conversation"
        aria-label="Find in conversation"
        spellcheck="false"
        autocomplete="off"
        v-bind:value="findQuery"
        v-on:input="handleFindInput"
        v-on:compositionend="handleFindCompositionEnd"
        v-on:keydown="handleFindInputKeydown"
      >
      <!-- The buttons must not take the focus away from the input, so that
      Enter keeps working after clicking them -->
      <button
        type="button"
        class="conversation-find-button"
        title="Previous match (Shift+Enter)"
        v-bind:disabled="findMatches.length === 0"
        v-on:mousedown.prevent
        v-on:click="moveFind(-1)"
      >
        Previous
      </button>
      <button
        type="button"
        class="conversation-find-button"
        title="Next match (Enter)"
        v-bind:disabled="findMatches.length === 0"
        v-on:mousedown.prevent
        v-on:click="moveFind(1)"
      >
        Next
      </button>
      <span class="conversation-find-count" role="status">{{ findCountLabel }}</span>
      <button
        type="button"
        class="conversation-find-button conversation-find-close"
        title="Close (Esc)"
        v-on:click="closeFind"
      >
        Close
      </button>
    </div>

    <div class="conversation-column">
      <section
        v-if="history.metadata.length > 0"
        class="conversation-metadata-area"
        v-bind:data-group-id="METADATA_AREA_ID"
      >
        <button
          type="button"
          class="conversation-toggle conversation-metadata-summary"
          v-bind:aria-expanded="isExpanded(METADATA_AREA_ID, true) ? 'true' : 'false'"
          v-bind:aria-label="`${isExpanded(METADATA_AREA_ID, true) ? 'Collapse' : 'Expand'} transcript information`"
          v-on:click="toggleExpanded(METADATA_AREA_ID, true)"
        >
          <span class="conversation-chevron" aria-hidden="true"></span>
          <span class="conversation-node-label">Transcript information</span>
          <span class="conversation-line-label">{{ formatLabel }}</span>
        </button>
        <div v-if="isExpanded(METADATA_AREA_ID, true)" class="conversation-metadata-items">
          <ConversationNodeView
            v-for="node in history.metadata"
            v-bind:key="node.id"
            v-bind:node="node"
          ></ConversationNodeView>
        </div>
      </section>

      <template v-for="item in displayItems" v-bind:key="item.id">
        <div
          v-if="item.type === 'tool-group'"
          class="conversation-tool-group"
          v-bind:class="{ 'conversation-tool-group-has-failure': item.failedCount > 0 }"
          v-bind:data-group-id="item.id"
        >
          <button
            type="button"
            class="conversation-toggle conversation-tool-group-summary"
            v-bind:aria-expanded="isExpanded(item.id, true) ? 'true' : 'false'"
            v-bind:aria-label="`${isExpanded(item.id, true) ? 'Collapse' : 'Expand'} ${item.summary}`"
            v-on:click="toggleExpanded(item.id, true)"
          >
            <span class="conversation-chevron" aria-hidden="true"></span>
            <span class="conversation-tool-group-text">{{ item.summary }}</span>
            <span
              v-if="item.failedCount > 0"
              class="conversation-badge conversation-badge-failed"
            >{{ item.failedCount }} failed</span>
          </button>
          <div v-if="isExpanded(item.id, true)" class="conversation-tool-group-items">
            <ConversationNodeView
              v-for="node in item.nodes"
              v-bind:key="node.id"
              v-bind:node="node"
            ></ConversationNodeView>
          </div>
        </div>
        <ConversationNodeView
          v-else
          v-bind:node="item.node"
        ></ConversationNodeView>
      </template>

      <p
        v-if="history.nodes.length === 0"
        class="conversation-empty"
      >
        This conversation contains no messages.
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ConversationViewer
 * CVM-Role:        View
 * License:         GNU GPL v3
 *
 * Description:     Read-only view of a conversation history parsed from a
 *                  Claude session JSONL or a Compact-LYH transcript
 *                  (Zettlr-LYH R79, contract C8 section 7). It only renders
 *                  the history it is given: it does not read the document
 *                  authority, listen to IPC or publish the table of contents;
 *                  JSONViewer.vue drives it through the methods exposed below.
 *                  Nothing in the history is executed, no external resource
 *                  is loaded, and links cannot be followed.
 *
 * END HEADER
 */
import { computed, nextTick, onBeforeUnmount, provide, reactive, ref, toRaw, watch } from 'vue'
import type {
  ConversationHighlightMode,
  ConversationHistory,
  ConversationNode,
  ConversationViewerHandle
} from '@dts/common/conversation-history'
import { conversationNodeIdsForLines, conversationSearchableText } from '@common/util/conversation-history'
import { useConfigStore } from 'source/pinia'
import ConversationNodeView from './conversation-viewer/ConversationNodeView.vue'
import { renderConversationMarkdown } from './conversation-viewer/render-markdown'
import {
  CONVERSATION_VIEWER_CONTEXT,
  loadExpansionState,
  saveExpansionState,
  type ConversationViewerContext
} from './conversation-viewer/viewer-context'
import {
  failedToolCount,
  firstSourceLine,
  intersectsLines,
  isMarkdownKind,
  toolGroupSummary
} from './conversation-viewer/node-display'

const props = defineProps<{
  history: ConversationHistory
  filePath: string
}>()

const emit = defineEmits<(e: 'focus-viewer') => void>()

/**
 * Expansion key of the collapsed area above the conversation that holds the
 * file-level metadata nodes.
 */
const METADATA_AREA_ID = 'metadata-area'

/**
 * Name of the CSS Custom Highlight that marks the find matches.
 */
const FIND_HIGHLIGHT_NAME = 'conversation-find'
const FIND_HIGHLIGHT_STYLE_ID = 'conversation-find-highlight-style'

/**
 * Number of Markdown nodes rendered per step; the steps are spread over
 * timer callbacks so that long sessions do not block the window.
 */
const MARKDOWN_BATCH_SIZE = 25

interface NodeItem {
  type: 'node'
  id: string
  node: ConversationNode
}

interface ToolGroupItem {
  type: 'tool-group'
  id: string
  nodes: ConversationNode[]
  summary: string
  failedCount: number
}

type DisplayItem = NodeItem|ToolGroupItem

interface HistoryIndex {
  nodeById: Map<string, ConversationNode>
  // Parent of each node: a node, a tool group or the metadata area
  parentById: Map<string, string>
  // metadata, then nodes, each tree in pre-order
  preorder: ConversationNode[]
  // Every identifier that can carry an expansion state
  expandableIds: Set<string>
  displayItems: DisplayItem[]
}

interface RenderedHtml {
  text: string
  html: string
}

const configStore = useConfigStore()

const rootElement = ref<HTMLDivElement|null>(null)
const findBarElement = ref<HTMLDivElement|null>(null)
const findInput = ref<HTMLInputElement|null>(null)

// Expansion overrides: identifier to expanded flag, only for entries that
// differ from their initial state or have been toggled
const expansion = ref<Record<string, boolean>>(loadExpansionState(props.filePath))

const selectHighlightIds = ref<ReadonlySet<string>>(new Set())
const jevHighlightIds = ref<ReadonlySet<string>>(new Set())

const htmlCache = reactive(new Map<string, RenderedHtml>())

const findOpen = ref<boolean>(false)
const findQuery = ref<string>('')
const findIndex = ref<number>(-1)

let renderGeneration = 0
let renderTimer: ReturnType<typeof setTimeout>|undefined
let unmounted = false

const historyIndex = computed<HistoryIndex>(() => buildHistoryIndex(props.history))

const displayItems = computed<DisplayItem[]>(() => historyIndex.value.displayItems)

const formatLabel = computed<string>(() => {
  const format = props.history.format === 'claude' ? 'Claude session' : 'Compact-LYH transcript'
  const records = props.history.recordCount === 1 ? '1 record' : `${props.history.recordCount} records`
  return `${format}, ${records}`
})

/**
 * Builds the lookup tables of a history and groups consecutive top-level tool
 * nodes into tool groups.
 *
 * @param   {ConversationHistory}  history  The history
 *
 * @return  {HistoryIndex}                  The lookup tables
 */
function buildHistoryIndex (history: ConversationHistory): HistoryIndex {
  const nodeById = new Map<string, ConversationNode>()
  const parentById = new Map<string, string>()
  const preorder: ConversationNode[] = []
  const expandableIds = new Set<string>([METADATA_AREA_ID])

  const visit = (node: ConversationNode, parentId: string|undefined): void => {
    nodeById.set(node.id, node)
    expandableIds.add(node.id)
    if (parentId !== undefined) {
      parentById.set(node.id, parentId)
    }
    preorder.push(node)
    for (const child of node.children) {
      visit(child, node.id)
    }
  }

  for (const node of history.metadata) {
    visit(node, METADATA_AREA_ID)
  }

  const displayItems: DisplayItem[] = []
  let currentGroup: ToolGroupItem|null = null
  for (const node of history.nodes) {
    if (node.kind === 'tool') {
      if (currentGroup === null) {
        currentGroup = { type: 'tool-group', id: `tool-group:${node.id}`, nodes: [], summary: '', failedCount: 0 }
        displayItems.push(currentGroup)
        expandableIds.add(currentGroup.id)
      }
      currentGroup.nodes.push(node)
      visit(node, currentGroup.id)
    } else {
      currentGroup = null
      displayItems.push({ type: 'node', id: node.id, node })
      visit(node, undefined)
    }
  }

  for (const item of displayItems) {
    if (item.type === 'tool-group') {
      item.summary = toolGroupSummary(item.nodes)
      item.failedCount = failedToolCount(item.nodes)
    }
  }

  return { nodeById, parentById, preorder, expandableIds, displayItems }
}

/**
 * The parent chain of a node, nearest first (nodes, tool group, metadata
 * area).
 *
 * @param   {string}    id  The node identifier
 *
 * @return  {string[]}      The ancestor identifiers
 */
function ancestorIds (id: string): string[] {
  const ancestors: string[] = []
  const parentById = historyIndex.value.parentById
  let current = parentById.get(id)
  while (current !== undefined) {
    ancestors.push(current)
    current = parentById.get(current)
  }
  return ancestors
}

// EXPANSION STATE

function isExpanded (id: string, initiallyCollapsed: boolean): boolean {
  const override = expansion.value[id]
  return override === undefined ? !initiallyCollapsed : override
}

function setExpanded (id: string, expanded: boolean): void {
  expansion.value[id] = expanded
}

function toggleExpanded (id: string, initiallyCollapsed: boolean): void {
  setExpanded(id, !isExpanded(id, initiallyCollapsed))
}

/**
 * Expands a node, all of its ancestors and the group or area containing it.
 *
 * @param   {string}  id  The node identifier
 */
function expandNodeAndAncestors (id: string): void {
  setExpanded(id, true)
  for (const ancestor of ancestorIds(id)) {
    setExpanded(ancestor, true)
  }
}

/**
 * Drops the expansion state of identifiers that no longer exist.
 */
function pruneExpansion (): void {
  const valid = historyIndex.value.expandableIds
  const pruned: Record<string, boolean> = {}
  for (const [ id, expanded ] of Object.entries(expansion.value)) {
    if (valid.has(id)) {
      pruned[id] = expanded
    }
  }
  expansion.value = pruned
}

watch(() => props.filePath, (newPath, oldPath) => {
  saveExpansionState(oldPath, toRaw(expansion.value))
  expansion.value = loadExpansionState(newPath)
  pruneExpansion()
})

// MARKDOWN RENDERING

function renderedHtml (node: ConversationNode): string|undefined {
  const entry = htmlCache.get(node.id)
  return entry !== undefined && entry.text === node.text ? entry.html : undefined
}

/**
 * Renders the Markdown of all user, assistant and summary nodes that have no
 * up-to-date HTML yet, in batches. A newer call cancels an older one.
 */
function scheduleMarkdownRendering (): void {
  renderGeneration++
  const generation = renderGeneration
  if (renderTimer !== undefined) {
    clearTimeout(renderTimer)
    renderTimer = undefined
  }

  const index = historyIndex.value
  for (const id of Array.from(htmlCache.keys())) {
    if (!index.nodeById.has(id)) {
      htmlCache.delete(id)
    }
  }

  const pending = index.preorder.filter(node => {
    return isMarkdownKind(node.kind) && node.text !== '' && htmlCache.get(node.id)?.text !== node.text
  })
  const linkFormat = configStore.config.zkn.linkFormat
  let position = 0

  const step = async (): Promise<void> => {
    renderTimer = undefined
    const batch = pending.slice(position, position + MARKDOWN_BATCH_SIZE)
    position += MARKDOWN_BATCH_SIZE

    const results = await Promise.all(batch.map(async node => {
      try {
        return { node, html: await renderConversationMarkdown(node.text, linkFormat) }
      } catch (err: any) {
        console.error(err)
        return null
      }
    }))

    if (unmounted || generation !== renderGeneration) {
      return
    }

    for (const result of results) {
      if (result !== null) {
        htmlCache.set(result.node.id, { text: result.node.text, html: result.html })
      }
    }

    if (position < pending.length) {
      renderTimer = setTimeout(() => { void step() }, 0)
    }
  }

  if (pending.length > 0) {
    renderTimer = setTimeout(() => { void step() }, 0)
  }
}

watch(() => configStore.config.zkn.linkFormat, () => {
  htmlCache.clear()
  scheduleMarkdownRendering()
})

// HIGHLIGHTS

function highlightIdsRef (mode: ConversationHighlightMode): typeof selectHighlightIds {
  return mode === 'select' ? selectHighlightIds : jevHighlightIds
}

function highlightClasses (id: string): string[] {
  const classes: string[] = []
  if (selectHighlightIds.value.has(id)) {
    classes.push('conversation-node-selected')
  }
  if (jevHighlightIds.value.has(id)) {
    classes.push('conversation-node-jev')
  }
  return classes
}

const viewerContext: ConversationViewerContext = {
  isExpanded,
  setExpanded,
  renderedHtml,
  highlightClasses
}
provide(CONVERSATION_VIEWER_CONTEXT, viewerContext)

// DOM HELPERS

/**
 * The element of a node, tool group or the metadata area, if it is rendered.
 *
 * @param   {string}            id  The identifier
 *
 * @return  {HTMLElement|null}      The element
 */
function elementFor (id: string): HTMLElement|null {
  const root = rootElement.value
  if (root === null) {
    return null
  }

  const escaped = CSS.escape(id)
  return root.querySelector<HTMLElement>(`[data-node-id="${escaped}"], [data-group-id="${escaped}"]`)
}

/**
 * The element of a node, or of its nearest rendered ancestor.
 *
 * @param   {string}            id  The node identifier
 *
 * @return  {HTMLElement|null}      The element
 */
function nearestRenderedElement (id: string): HTMLElement|null {
  for (const candidate of [ id, ...ancestorIds(id) ]) {
    const element = elementFor(candidate)
    if (element !== null) {
      return element
    }
  }
  return null
}

function findBarHeight (): number {
  return findOpen.value ? (findBarElement.value?.offsetHeight ?? 0) : 0
}

function rootScrolls (root: HTMLElement): boolean {
  return root.scrollHeight > root.clientHeight
}

/**
 * Scrolls so that the top of an element is at the top of the visible area
 * (below the find bar).
 *
 * @param   {HTMLElement}  element  The element
 */
function scrollElementToTop (element: HTMLElement): void {
  const root = rootElement.value
  if (root === null) {
    return
  }

  if (rootScrolls(root)) {
    const delta = element.getBoundingClientRect().top - root.getBoundingClientRect().top - findBarHeight()
    root.scrollTop += delta
  } else {
    element.scrollIntoView({ block: 'start' })
  }
}

/**
 * Scrolls an element into the visible area if it is not entirely visible,
 * centering it (or aligning its top when it is taller than the area).
 *
 * @param   {HTMLElement}  element  The element
 */
function scrollElementIntoView (element: HTMLElement): void {
  const root = rootElement.value
  if (root === null) {
    return
  }

  if (!rootScrolls(root)) {
    element.scrollIntoView({ block: 'nearest' })
    return
  }

  const rootRect = root.getBoundingClientRect()
  const rect = element.getBoundingClientRect()
  const visibleTop = rootRect.top + findBarHeight()
  const visibleHeight = rootRect.bottom - visibleTop
  if (rect.top >= visibleTop && rect.bottom <= rootRect.bottom) {
    return
  }

  const offset = rect.height >= visibleHeight ? 0 : (visibleHeight - rect.height) / 2
  root.scrollTop += rect.top - visibleTop - offset
}

function preventLinkActivation (event: MouseEvent): void {
  const target = event.target
  if (target instanceof Element && target.closest('a') !== null) {
    event.preventDefault()
  }
}

// FIND

const searchIndex = computed<Array<{ id: string, text: string }>>(() => {
  return historyIndex.value.preorder.map(node => {
    return { id: node.id, text: conversationSearchableText(node).toLowerCase() }
  })
})

const findMatches = computed<string[]>(() => {
  const needle = findQuery.value.toLowerCase()
  if (needle === '') {
    return []
  }
  return searchIndex.value.filter(entry => entry.text.includes(needle)).map(entry => entry.id)
})

const findCountLabel = computed<string>(() => {
  if (findQuery.value === '') {
    return ''
  }
  const total = findMatches.value.length
  if (total === 0) {
    return 'No results'
  }
  return `${Math.max(findIndex.value, 0) + 1} of ${total}`
})

function ensureFindHighlightStyle (): void {
  if (document.getElementById(FIND_HIGHLIGHT_STYLE_ID) !== null) {
    return
  }
  const style = document.createElement('style')
  style.id = FIND_HIGHLIGHT_STYLE_ID
  style.textContent = `::highlight(${FIND_HIGHLIGHT_NAME}) { background-color: rgba(255, 196, 0, 0.65); color: inherit; }`
  document.head.appendChild(style)
}

function clearFindHighlight (): void {
  if (typeof CSS !== 'undefined' && CSS.highlights !== undefined) {
    CSS.highlights.delete(FIND_HIGHLIGHT_NAME)
  }
}

/**
 * Marks the occurrences of the query in the text that belongs to a node
 * element itself (not to the elements of its child nodes), without changing
 * the DOM.
 *
 * @param   {HTMLElement}  element  The node element
 */
function applyFindHighlight (element: HTMLElement): void {
  clearFindHighlight()
  const needle = findQuery.value.toLowerCase()
  if (needle === '' || typeof CSS === 'undefined' || CSS.highlights === undefined) {
    return
  }

  ensureFindHighlightStyle()
  const ranges: Range[] = []
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  let textNode = walker.nextNode()
  while (textNode !== null) {
    const owner = textNode.parentElement?.closest('[data-node-id]')
    const value = textNode.nodeValue ?? ''
    const haystack = value.toLowerCase()
    // Lowercasing that changes the length would shift the offsets
    if (owner === element && haystack.length === value.length) {
      let offset = haystack.indexOf(needle)
      while (offset >= 0) {
        const range = document.createRange()
        range.setStart(textNode, offset)
        range.setEnd(textNode, offset + needle.length)
        ranges.push(range)
        offset = haystack.indexOf(needle, offset + needle.length)
      }
    }
    textNode = walker.nextNode()
  }

  if (ranges.length > 0) {
    CSS.highlights.set(FIND_HIGHLIGHT_NAME, new Highlight(...ranges))
  }
}

/**
 * Shows the current find match: expands the node and its ancestors, scrolls
 * it into view and highlights the matching text.
 *
 * @param   {boolean}  scroll  Whether to scroll to the match
 */
function showCurrentMatch (scroll: boolean): void {
  const id = findMatches.value[findIndex.value]
  if (id === undefined) {
    clearFindHighlight()
    return
  }

  expandNodeAndAncestors(id)
  void nextTick(() => {
    if (unmounted || findMatches.value[findIndex.value] !== id) {
      return
    }
    const element = elementFor(id)
    if (element === null) {
      clearFindHighlight()
      return
    }
    if (scroll) {
      scrollElementIntoView(element)
    }
    applyFindHighlight(element)
  })
}

function startFind (): void {
  findIndex.value = findMatches.value.length > 0 ? 0 : -1
  showCurrentMatch(true)
}

function moveFind (step: number): void {
  const total = findMatches.value.length
  if (total === 0) {
    return
  }
  const current = findIndex.value < 0 ? (step > 0 ? -1 : 0) : findIndex.value
  findIndex.value = (current + step + total) % total
  showCurrentMatch(true)
}

function handleFindInput (event: Event): void {
  findQuery.value = (event.target as HTMLInputElement).value
  if ((event as InputEvent).isComposing) {
    // Searching for half-typed syllables of an input method would only
    // flicker; the search starts on compositionend instead
    return
  }
  startFind()
}

function handleFindCompositionEnd (event: CompositionEvent): void {
  findQuery.value = (event.target as HTMLInputElement).value
  startFind()
}

function handleFindInputKeydown (event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.isComposing) {
    return
  }
  event.preventDefault()
  moveFind(event.shiftKey ? -1 : 1)
}

function handleFindBarKeydown (event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.isComposing) {
    return
  }
  event.preventDefault()
  event.stopPropagation()
  closeFind()
}

function openFind (): void {
  findOpen.value = true
  void nextTick(() => {
    const input = findInput.value
    if (input === null) {
      return
    }
    input.focus()
    input.select()
    if (findIndex.value >= 0) {
      showCurrentMatch(false)
    }
  })
}

function closeFind (): void {
  findOpen.value = false
  clearFindHighlight()
  rootElement.value?.focus({ preventScroll: true })
}

// When the history changes, keep the query but drop a stale current match
watch(findMatches, (matches) => {
  if (findIndex.value >= matches.length) {
    findIndex.value = matches.length > 0 ? matches.length - 1 : -1
  }
  clearFindHighlight()
})

// HISTORY CHANGES

watch(() => props.history, () => {
  pruneExpansion()
  const ids = historyIndex.value.nodeById
  selectHighlightIds.value = new Set(Array.from(selectHighlightIds.value).filter(id => ids.has(id)))
  jevHighlightIds.value = new Set(Array.from(jevHighlightIds.value).filter(id => ids.has(id)))
  scheduleMarkdownRendering()
}, { immediate: true })

// EXPOSED METHODS

function revealSourceLines (firstLine: number, lastLine: number, mode: ConversationHighlightMode, scroll: boolean): boolean {
  clearHighlight(mode)
  const ids = conversationNodeIdsForLines(props.history, firstLine, lastLine)
  if (ids.length === 0) {
    return false
  }

  const nodeById = historyIndex.value.nodeById
  const hits = ids.filter(id => {
    const node = nodeById.get(id)
    return node !== undefined && intersectsLines(node, firstLine, lastLine)
  })
  const targets = hits.length > 0 ? hits : ids

  for (const id of targets) {
    expandNodeAndAncestors(id)
  }
  highlightIdsRef(mode).value = new Set(targets)

  if (scroll) {
    const firstTarget = targets[0]
    void nextTick(() => {
      if (unmounted) {
        return
      }
      const element = nearestRenderedElement(firstTarget)
      if (element !== null) {
        scrollElementToTop(element)
      }
    })
  }

  return true
}

function clearHighlight (mode: ConversationHighlightMode): void {
  const ids = highlightIdsRef(mode)
  if (ids.value.size > 0) {
    ids.value = new Set()
  }
}

function toggleFind (): void {
  if (!findOpen.value) {
    openFind()
    return
  }

  // An open bar whose input does not have the focus gets it back first
  if (findInput.value !== null && document.activeElement !== findInput.value) {
    findInput.value.focus()
    findInput.value.select()
    return
  }

  closeFind()
}

function topVisibleSourceLine (): number|undefined {
  const root = rootElement.value
  if (root === null) {
    return undefined
  }

  const topEdge = Math.max(root.getBoundingClientRect().top, 0) + findBarHeight()
  // The deepest node that crosses the top edge, or else the first node below it
  let best: HTMLElement|null = null
  for (const element of Array.from(root.querySelectorAll<HTMLElement>('[data-node-id]'))) {
    const rect = element.getBoundingClientRect()
    if (rect.height === 0 || rect.bottom <= topEdge + 1) {
      continue
    }
    if (rect.top <= topEdge + 2) {
      best = element
      continue
    }
    if (best === null) {
      best = element
    }
    break
  }

  const id = best?.dataset.nodeId
  if (id === undefined) {
    return undefined
  }

  const node = historyIndex.value.nodeById.get(id)
  return node !== undefined ? firstSourceLine(node) : undefined
}

function scrollToSourceLine (line: number): void {
  const target = historyIndex.value.preorder.find(node => {
    const range = node.sourceRanges[0]
    return range !== undefined && ((range.firstLine <= line && line <= range.lastLine) || range.firstLine > line)
  })
  if (target === undefined) {
    return
  }

  void nextTick(() => {
    if (unmounted) {
      return
    }
    const element = nearestRenderedElement(target.id)
    if (element !== null) {
      scrollElementToTop(element)
    }
  })
}

function containsFocus (): boolean {
  const root = rootElement.value
  return root !== null && document.activeElement !== null && root.contains(document.activeElement)
}

const handle: ConversationViewerHandle = {
  revealSourceLines,
  clearHighlight,
  toggleFind,
  topVisibleSourceLine,
  scrollToSourceLine,
  containsFocus
}

defineExpose(handle)

onBeforeUnmount(() => {
  unmounted = true
  saveExpansionState(props.filePath, toRaw(expansion.value))
  renderGeneration++
  if (renderTimer !== undefined) {
    clearTimeout(renderTimer)
    renderTimer = undefined
  }
  clearFindHighlight()
})
</script>

<style lang="less">
.conversation-viewer {
  position: relative;
  box-sizing: border-box;
  height: 100%;
  overflow: auto;
  line-height: 1.55;
  outline: none;
  // The window sets user-select: none on the body, which every element would
  // inherit; the displayed text must be selectable and copyable (R123,
  // contract C8 section 7). The controls opt out again below.
  user-select: text;

  &.conversation-find-open {
    [data-node-id],
    [data-group-id] {
      scroll-margin-top: 3em;
    }
  }

  // FIND BAR (colors as in the PDF viewer and the editor's search panel)

  div.conversation-find-bar {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 4px;
    box-sizing: border-box;
    width: 100%;
    padding: 4px 6px;
    font-size: 13px;
    line-height: normal;
    color: black;
    background-color: #f5f5f5;
    border-bottom: 1px solid var(--grey-1);
    user-select: none;

    input.conversation-find-input {
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

    button.conversation-find-button {
      flex-shrink: 0;
      padding: 1px 8px;
      font-family: inherit;
      font-size: inherit;
      color: inherit;
      background-color: transparent;
      border: 1px solid var(--grey-2);
      border-radius: 3px;
      cursor: pointer;
      user-select: none;

      &:hover:not(:disabled) {
        background-color: var(--grey-1);
      }

      &:focus-visible {
        outline: 2px solid var(--system-accent-color, rgb(40, 100, 255));
        outline-offset: 1px;
      }

      &:disabled {
        opacity: 0.4;
        cursor: default;
      }

      &.conversation-find-close {
        margin-left: auto;
      }
    }

    span.conversation-find-count {
      padding: 0 4px;
      white-space: nowrap;
      color: rgb(100, 100, 100);
      font-variant-numeric: tabular-nums;

      &:empty {
        display: none;
      }
    }
  }

  // COLUMN

  .conversation-column {
    box-sizing: border-box;
    max-width: 46em;
    margin: 0 auto;
    padding: 1.25em 1.5em 4em;
  }

  .conversation-column > .conversation-node,
  .conversation-column > .conversation-tool-group,
  .conversation-column > .conversation-metadata-area {
    margin: 0.9em 0;
  }

  .conversation-empty {
    color: rgb(120, 120, 120);
    font-style: italic;
    text-align: center;
  }

  // TEXT

  .conversation-plain-text {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .conversation-code {
    font-family: monospace;
    font-size: 0.88em;
    background-color: rgba(0, 0, 0, 0.04);
    border-radius: 6px;
    padding: 0.5em 0.7em;
    margin: 0.3em 0;
  }

  .conversation-markdown {
    overflow-wrap: anywhere;

    > :first-child { margin-top: 0; }
    > :last-child { margin-bottom: 0; }

    p { margin: 0.5em 0; }
    ul, ol { margin: 0.4em 0; padding-left: 1.6em; }
    h1, h2, h3, h4, h5, h6 { margin: 0.8em 0 0.4em; line-height: 1.3; }
    h1 { font-size: 1.4em; }
    h2 { font-size: 1.25em; }
    h3 { font-size: 1.1em; }
    h4, h5, h6 { font-size: 1em; }

    code {
      font-family: monospace;
      font-size: 0.9em;
      background-color: rgba(0, 0, 0, 0.06);
      padding: 0 0.25em;
      border-radius: 3px;
    }

    pre {
      overflow: auto;
      background-color: rgba(0, 0, 0, 0.05);
      padding: 0.6em 0.8em;
      border-radius: 6px;

      code {
        background-color: transparent;
        padding: 0;
      }
    }

    blockquote {
      margin: 0.5em 0;
      padding-left: 0.8em;
      border-left: 3px solid rgba(0, 0, 0, 0.2);
      color: rgb(85, 85, 85);
    }

    table {
      border-collapse: collapse;
      margin: 0.5em 0;

      th, td {
        border: 1px solid rgba(0, 0, 0, 0.18);
        padding: 0.2em 0.5em;
      }
    }

    hr {
      border: none;
      border-top: 1px solid rgba(0, 0, 0, 0.15);
    }
  }

  // Links are shown, not followed; the title shows the address
  .conversation-link {
    color: rgb(37, 99, 201);
    text-decoration: underline dotted;
    cursor: help;
  }

  // CAPTIONS AND BADGES

  .conversation-caption {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5em;
    font-size: 0.8em;
    color: rgb(115, 115, 115);
    margin-bottom: 0.25em;
  }

  .conversation-attribute-line,
  .conversation-line-label {
    font-size: 0.85em;
    color: rgb(130, 130, 130);
    font-weight: normal;
    white-space: nowrap;
  }

  .conversation-badge {
    display: inline-block;
    font-size: 0.8em;
    font-weight: normal;
    font-style: normal;
    line-height: 1.4;
    padding: 0 0.5em;
    border: 1px solid currentColor;
    border-radius: 1em;
    white-space: nowrap;
  }

  .conversation-badge-failed { color: rgb(198, 40, 40); }
  .conversation-badge-omitted,
  .conversation-badge-partial { color: rgb(138, 100, 0); }
  .conversation-badge-empty,
  .conversation-badge-unknown { color: rgb(120, 120, 120); }
  .conversation-sidechain-badge { color: rgb(106, 79, 179); }

  .conversation-summary-badge {
    color: rgb(31, 95, 191);
    font-weight: 600;
  }

  .conversation-repeat {
    font-variant-numeric: tabular-nums;
    color: rgb(110, 110, 110);
  }

  // USER BUBBLES

  .conversation-user-row {
    display: flex;
    justify-content: flex-end;
  }

  .conversation-user-bubble {
    box-sizing: border-box;
    max-width: 85%;
    padding: 0.6em 1em;
    border-radius: 1.1em;
    background-color: rgb(237, 234, 226);
    overflow-wrap: anywhere;
  }

  // EXTRACTED FINDINGS

  .conversation-summary {
    padding: 0.6em 0.9em;
    border-left: 4px solid rgb(59, 125, 221);
    border-radius: 6px;
    background-color: rgb(234, 242, 253);
  }

  // OMISSIONS

  .conversation-omission {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5em;
    width: fit-content;
    max-width: 100%;
    box-sizing: border-box;
    margin: 0.35em 0;
    padding: 0.1em 0.6em;
    font-size: 0.88em;
    font-style: italic;
    color: rgb(125, 125, 125);
    border: 1px dashed rgba(0, 0, 0, 0.25);
    border-radius: 4px;

    &::before {
      content: '…';
      font-style: normal;
    }
  }

  .conversation-omit-marker {
    font-style: italic;
    color: rgb(125, 125, 125);
    background-color: rgba(0, 0, 0, 0.08);
    border-radius: 3px;
    padding: 0 0.2em;
  }

  // EXPANDABLE ROWS

  .conversation-toggle {
    display: flex;
    align-items: baseline;
    gap: 0.45em;
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    margin: 0;
    padding: 0.3em 0.45em;
    font: inherit;
    text-align: left;
    color: inherit;
    background-color: transparent;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    user-select: none;

    &:hover {
      background-color: rgba(0, 0, 0, 0.05);
    }

    &:focus-visible {
      outline: 2px solid var(--system-accent-color, rgb(40, 100, 255));
      outline-offset: 1px;
    }

    .conversation-chevron {
      flex-shrink: 0;
      display: inline-block;
      width: 0.4em;
      height: 0.4em;
      margin: 0 0.15em 0.1em 0.05em;
      border-right: 1.5px solid currentColor;
      border-bottom: 1.5px solid currentColor;
      transform: rotate(-45deg);
      transition: transform 0.1s;
    }

    &[aria-expanded="true"] .conversation-chevron {
      transform: rotate(45deg);
    }
  }

  .conversation-node-header {
    font-size: 0.92em;
    color: rgb(100, 100, 100);

    .conversation-node-label {
      font-weight: 600;
      white-space: nowrap;
    }

    .conversation-preview {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      opacity: 0.8;
    }
  }

  .conversation-static-header {
    display: flex;
    align-items: baseline;
    gap: 0.45em;
    padding: 0.3em 0.45em 0.3em 1.3em;
  }

  .conversation-node-body {
    margin-left: 0.6em;
    padding: 0.2em 0 0.4em 1.1em;
    border-left: 2px solid rgba(0, 0, 0, 0.08);
  }

  .conversation-section-caption {
    font-size: 0.8em;
    font-weight: 600;
    color: rgb(120, 120, 120);
    margin-top: 0.3em;
  }

  .conversation-attributes {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.1em 0.8em;
    margin: 0.3em 0;
    font-size: 0.88em;

    dt { font-weight: 600; }
    dd { margin: 0; overflow-wrap: anywhere; }
  }

  // THINKING

  .conversation-thinking > .conversation-node-body {
    color: rgb(110, 110, 110);
    font-style: italic;
  }

  // TOOLS

  .conversation-tool-group,
  .conversation-metadata-area {
    border: 1px solid rgba(0, 0, 0, 0.12);
    border-radius: 8px;
    background-color: rgba(0, 0, 0, 0.02);
  }

  .conversation-metadata-area {
    border-style: dashed;
    font-size: 0.92em;
  }

  .conversation-tool-group-summary,
  .conversation-metadata-summary {
    color: rgb(90, 90, 90);
  }

  .conversation-tool-group-text {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .conversation-tool-group-items,
  .conversation-metadata-items {
    padding: 0 0.5em 0.4em;
  }

  .conversation-tool-failed > .conversation-node-header .conversation-node-label {
    color: rgb(198, 40, 40);
  }

  .conversation-kind-error > .conversation-node-header {
    color: rgb(179, 38, 30);
  }

  .conversation-kind-error > .conversation-node-body > .conversation-code,
  .conversation-segment.conversation-kind-error > .conversation-code {
    background-color: rgba(198, 40, 40, 0.07);
  }

  // UNKNOWN AND MALFORMED DATA

  .conversation-kind-unknown > .conversation-node-header,
  .conversation-kind-parse-error > .conversation-node-header {
    color: rgb(150, 95, 0);
  }

  // SUBAGENT (sidechain) MESSAGES

  .conversation-assistant.conversation-sidechain,
  .conversation-user-row.conversation-sidechain .conversation-user-bubble {
    border-left: 3px solid rgba(106, 79, 179, 0.5);
    padding-left: 0.7em;
  }

  // SOURCE LINE HIGHLIGHTS

  .conversation-node-selected {
    outline: 2px solid var(--system-accent-color, rgb(40, 100, 255));
    outline-offset: 3px;
    border-radius: 4px;
  }

  .conversation-node-jev {
    background-color: rgba(255, 213, 0, 0.18);
    box-shadow: -4px 0 0 rgb(230, 180, 0);
    border-radius: 2px;
  }
}

body.dark .conversation-viewer {
  div.conversation-find-bar {
    color: white;
    background-color: #333333;
    border-bottom-color: var(--grey-6);

    input.conversation-find-input {
      background-color: var(--grey-7);
      border-color: var(--grey-5);
    }

    button.conversation-find-button {
      border-color: var(--grey-5);

      &:hover:not(:disabled) {
        background-color: var(--grey-6);
      }
    }

    span.conversation-find-count {
      color: rgb(170, 170, 170);
    }
  }

  .conversation-empty { color: rgb(150, 150, 150); }

  .conversation-code { background-color: rgba(255, 255, 255, 0.06); }

  .conversation-markdown {
    code { background-color: rgba(255, 255, 255, 0.1); }
    pre { background-color: rgba(255, 255, 255, 0.07); }
    blockquote { border-left-color: rgba(255, 255, 255, 0.25); color: rgb(185, 185, 185); }
    table th, table td { border-color: rgba(255, 255, 255, 0.2); }
    hr { border-top-color: rgba(255, 255, 255, 0.2); }
  }

  .conversation-link { color: rgb(125, 175, 255); }

  .conversation-caption { color: rgb(160, 160, 160); }

  .conversation-attribute-line,
  .conversation-line-label,
  .conversation-repeat { color: rgb(150, 150, 150); }

  .conversation-badge-failed { color: rgb(255, 120, 115); }
  .conversation-badge-omitted,
  .conversation-badge-partial { color: rgb(230, 190, 90); }
  .conversation-badge-empty,
  .conversation-badge-unknown { color: rgb(160, 160, 160); }
  .conversation-sidechain-badge { color: rgb(180, 160, 245); }
  .conversation-summary-badge { color: rgb(130, 180, 255); }

  .conversation-user-bubble { background-color: rgb(58, 58, 64); }

  .conversation-summary {
    border-left-color: rgb(91, 156, 240);
    background-color: rgb(29, 43, 61);
  }

  .conversation-omission {
    color: rgb(150, 150, 150);
    border-color: rgba(255, 255, 255, 0.25);
  }

  .conversation-omit-marker {
    color: rgb(160, 160, 160);
    background-color: rgba(255, 255, 255, 0.1);
  }

  .conversation-toggle:hover { background-color: rgba(255, 255, 255, 0.06); }

  .conversation-node-header { color: rgb(165, 165, 165); }

  .conversation-node-body { border-left-color: rgba(255, 255, 255, 0.1); }

  .conversation-section-caption { color: rgb(150, 150, 150); }

  .conversation-thinking > .conversation-node-body { color: rgb(150, 150, 150); }

  .conversation-tool-group,
  .conversation-metadata-area {
    border-color: rgba(255, 255, 255, 0.14);
    background-color: rgba(255, 255, 255, 0.03);
  }

  .conversation-tool-group-summary,
  .conversation-metadata-summary { color: rgb(175, 175, 175); }

  .conversation-tool-failed > .conversation-node-header .conversation-node-label { color: rgb(255, 120, 115); }

  .conversation-kind-error > .conversation-node-header { color: rgb(255, 130, 120); }

  .conversation-kind-error > .conversation-node-body > .conversation-code,
  .conversation-segment.conversation-kind-error > .conversation-code {
    background-color: rgba(255, 90, 80, 0.1);
  }

  .conversation-kind-unknown > .conversation-node-header,
  .conversation-kind-parse-error > .conversation-node-header { color: rgb(230, 175, 80); }

  .conversation-node-jev {
    background-color: rgba(255, 213, 0, 0.12);
    box-shadow: -4px 0 0 rgb(200, 160, 0);
  }
}
</style>
