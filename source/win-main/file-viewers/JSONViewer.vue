<template>
  <div
    class="formatted-json-viewer"
    role="region"
    v-bind:aria-label="`JSONViewer: Currently viewing file ${pathBasename(props.file.path)}`"
  >
    <div v-if="notice !== ''" class="formatted-json-notice">
      {{ notice }}
    </div>
    <div
      v-show="conversationHistory === undefined"
      ref="editorWrapper"
      class="main-editor-wrapper"
      v-bind:style="{ 'font-size': `${fontSize}px`, '--editor-base-font-size': `${fontSize}px` }"
      v-on:wheel="handleZoomWheel"
    >
      <!-- The read-only CodeMirror instance is mounted here -->
    </div>
    <!-- Conversation histories (R79) replace the outline; the CodeMirror
    instance above is only hidden so that switching back is cheap -->
    <div
      v-if="conversationHistory !== undefined"
      ref="conversationWrapper"
      class="conversation-viewer-wrapper"
      v-bind:style="{ 'font-size': `${fontSize}px`, '--editor-base-font-size': `${fontSize}px` }"
      v-on:wheel="handleConversationWheel"
      v-on:keydown="stopReadingPositionRestore"
      v-on:pointerdown="stopReadingPositionRestore"
    >
      <ConversationViewer
        ref="conversationViewer"
        v-bind:history="conversationHistory"
        v-bind:file-path="props.file.path"
        v-on:focus-viewer="handleConversationFocus"
      ></ConversationViewer>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        JSONViewer
 * CVM-Role:        View
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Displays JSON and JSON Lines files as a read-only Markdown
 *                  outline (keys as headings, strings with their escape
 *                  sequences resolved), rendered with the regular Markdown
 *                  editor styles. The content is taken from the document
 *                  authority, so unsaved edits made in the raw text editor
 *                  show up as well. Raw Claude sessions and Compact-LYH
 *                  transcripts are recognised by their content and shown in
 *                  the read-only conversation view instead (R79, contract C8
 *                  section 8); this component stays the only reader of the
 *                  document authority and the only listener to IPC events.
 *
 * END HEADER
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, toRef, watch } from 'vue'
import { EditorState, Text } from '@codemirror/state'
import { EditorView, type ViewUpdate } from '@codemirror/view'
import { closeSearchPanel, openSearchPanel, searchPanelOpen } from '@codemirror/search'
import { DP_EVENTS, type OpenDocument } from '@dts/common/documents'
import { CITEPROC_MAIN_DB } from '@dts/common/citeproc'
import type { EditorCommands } from '../App.vue'
import { getReadOnlyMarkdownExtensions } from '@common/modules/markdown-editor/editor-extension-sets'
import { getDefaultConfig, type EditorConfiguration } from '@common/modules/markdown-editor/util/configuration'
import { tocField } from '@common/modules/markdown-editor/plugins/toc-field'
import { documentAuthorityIPCAPI } from '@common/modules/markdown-editor/util/ipc-api'
import { convertJSONLinesToMarkdown, convertJSONToMarkdown, jsonLinesMarkdownRange, rebaseTableOfContents, type JSONMarkdownConversion } from '@common/util/json-to-markdown'
import { hasExt, JSONL_EXT } from '@common/util/file-extention-checks'
import { pathBasename } from '@common/util/renderer-path-polyfill'
import { type JevSearchHighlightRequest } from '@common/modules/jev-search'
import { clearJevSearchHighlight, jevHighlightLineRange, showJevSearchHighlight } from '@common/modules/markdown-editor/plugins/jev-search-highlight'
import { useConfigStore, useDocumentTreeStore, useWindowStateStore } from 'source/pinia'
import { useEditorFontZoom } from '../util/use-editor-font-zoom'
import type { DocumentManagerIPCAPI, DocumentsUpdateContext } from 'source/app/service-providers/documents'
import type { ConversationHistory, ConversationViewerHandle } from '@dts/common/conversation-history'
import ConversationViewer from './ConversationViewer.vue'
import {
  conversationNotice,
  conversationReadingPositionKey,
  conversationTocEntries,
  routeJSONViewerContent
} from './conversation-viewer/viewer-routing'

const ipcRenderer = window.ipc

// How long to wait after the last change to the document before regenerating
// the view, so that typing in a raw editor pane does not rebuild it constantly.
const REFRESH_DELAY = 300

// The Markdown of a conversation is rendered in batches after it is shown, so
// the heights above a restored reading position keep changing for a moment.
// The position is therefore applied again after these delays (milliseconds),
// unless the user has started scrolling or clicking in the meantime.
const READING_POSITION_RESTORE_DELAYS = [ 0, 50, 150, 300, 600, 1000, 1600 ]

const props = defineProps<{
  leafId: string
  windowId: string
  activeFile: OpenDocument|null
  editorCommands: EditorCommands
  file: OpenDocument
  // Maps file paths to the topmost visible line, so that the reading position
  // survives switching tabs or toggling the raw text editor.
  topLineMap: Map<string, number>
}>()

const configStore = useConfigStore()
const windowStateStore = useWindowStateStore()
const documentTreeStore = useDocumentTreeStore()

// Zooms the editor font size with Ctrl plus the mouse wheel (R41)
const { handleZoomWheel } = useEditorFontZoom()

const editorWrapper = ref<HTMLDivElement|null>(null)
const conversationWrapper = ref<HTMLDivElement|null>(null)
const conversationViewer = ref<ConversationViewerHandle|null>(null)
const conversion = ref<JSONMarkdownConversion|undefined>(undefined)
// The parsed conversation while the file is shown as a conversation history
// (R79); undefined while the outline is shown. A shallow reference, because
// a deep reactive proxy of a long session would be expensive.
const conversationHistory = shallowRef<ConversationHistory|undefined>(undefined)
const fontSize = computed<number>(() => configStore.config.editor.fontSize)
const isJSONLines = computed<boolean>(() => hasExt(props.file.path, JSONL_EXT))

const notice = computed<string>(() => {
  if (conversationHistory.value !== undefined) {
    return conversationNotice(conversationHistory.value)
  }

  const result = conversion.value
  if (result === undefined || result.format !== 'jsonl') {
    return ''
  }

  const messages: string[] = []
  if (!isJSONLines.value) {
    messages.push(`The file does not contain a single JSON value and is shown as JSON Lines (one record per line), ${result.recordCount} records in total.`)
  }

  if (result.errors.length > 0) {
    const lineCount = result.errors.length === 1 ? '1 line' : `${result.errors.length} lines`
    messages.push(`${lineCount} could not be parsed (the first at line ${result.errors[0].line}); the raw text is quoted in place.`)
  }

  return messages.join(' ')
})

const viewerConfiguration = computed<EditorConfiguration>(() => {
  const { editor, display, zkn, darkMode, darkModeEditor } = configStore.config
  return {
    ...getDefaultConfig(),
    previewModeShowSyntaxWhenCursorIsAdjacent: display.previewModeShowSyntaxWhenCursorIsAdjacent,
    renderLinks: display.renderLinks,
    renderMath: display.renderMath,
    renderHeadings: display.renderHTags,
    renderEmphasis: display.renderEmphasis,
    renderPandoc: display.renderPandoc,
    renderAdmonitions: display.renderAdmonitions,
    renderHorizontalRules: display.renderHorizontalRules,
    boldFormatting: editor.boldFormatting,
    italicFormatting: editor.italicFormatting,
    highlightFormatting: editor.highlightFormatting,
    zknLinkFormat: zkn.linkFormat,
    darkMode,
    darkModeEditor,
    theme: display.theme,
    // Relative links inside the content resolve against the JSON file
    metadata: { path: props.file.path, id: '', library: CITEPROC_MAIN_DB }
  }
})

let view: EditorView|null = null
let displayedMarkdown: string|undefined
// The raw file text the view was last converted from
let convertedContent: string|undefined
let refreshTimer: ReturnType<typeof setTimeout>|undefined
let latestRefreshRequest = 0
const stopListening: Array<() => void> = []
let readingPositionTimers: Array<ReturnType<typeof setTimeout>> = []

// CONVERSATION VIEW (R79)

/**
 * Shows the user messages of the conversation in the table of contents
 * sidebar, each pointing at its first line in the raw file.
 */
function publishConversationTableOfContents (): void {
  const history = conversationHistory.value
  if (history !== undefined) {
    windowStateStore.tableOfContents = conversationTocEntries(history)
  }
}

function handleConversationFocus (): void {
  ipcRenderer.invoke('documents-provider', {
    command: 'focus-leaf',
    payload: { leafId: props.leafId, windowId: props.windowId }
  } as DocumentManagerIPCAPI).catch(err => console.error(err))

  publishConversationTableOfContents()
}

/**
 * Moves the keyboard focus into the conversation view without scrolling it.
 */
function focusConversation (): void {
  conversationWrapper.value?.querySelector<HTMLElement>('.conversation-viewer')?.focus({ preventScroll: true })
}

function stopReadingPositionRestore (): void {
  for (const timer of readingPositionTimers) {
    clearTimeout(timer)
  }
  readingPositionTimers = []
}

function handleConversationWheel (event: WheelEvent): void {
  stopReadingPositionRestore()
  handleZoomWheel(event)
}

/**
 * Scrolls the conversation view back to its saved reading position. The
 * position is applied several times while the Markdown above it is rendered,
 * and no longer once the user starts navigating.
 */
function restoreConversationReadingPosition (): void {
  stopReadingPositionRestore()
  const line = props.topLineMap.get(conversationReadingPositionKey(props.file.path))
  if (line === undefined) {
    return
  }

  for (const delay of READING_POSITION_RESTORE_DELAYS) {
    readingPositionTimers.push(setTimeout(() => {
      conversationViewer.value?.scrollToSourceLine(line)
    }, delay))
  }
}

/**
 * Remembers the reading position of the conversation view.
 */
function saveConversationReadingPosition (): void {
  const line = conversationViewer.value?.topVisibleSourceLine()
  if (line !== undefined) {
    props.topLineMap.set(conversationReadingPositionKey(props.file.path), line)
  }
}

/**
 * Shows a parsed conversation instead of the outline, or replaces the
 * conversation that is shown.
 *
 * @param   {ConversationHistory}  history  The parsed conversation
 * @param   {string}               content  The raw text it was parsed from
 */
async function showConversation (history: ConversationHistory, content: string): Promise<void> {
  const entering = conversationHistory.value === undefined
  if (entering && displayedMarkdown !== undefined) {
    // Keep the outline's reading position in case the file stops being a
    // conversation; the outline is rebuilt when it is shown again
    const topLine = topVisibleLine()
    if (topLine !== undefined) {
      props.topLineMap.set(props.file.path, topLine)
    }
  }

  displayedMarkdown = undefined
  conversion.value = undefined
  convertedContent = content
  conversationHistory.value = history

  if (entering) {
    await nextTick()
    restoreConversationReadingPosition()
  }

  publishConversationTableOfContents()
}

/**
 * Removes the conversation view so that the outline can be shown again.
 */
function leaveConversation (): void {
  stopReadingPositionRestore()
  saveConversationReadingPosition()
  conversationHistory.value = undefined
}

function handleUpdate (update: ViewUpdate): void {
  if (update.focusChanged && update.view.hasFocus) {
    ipcRenderer.invoke('documents-provider', {
      command: 'focus-leaf',
      payload: { leafId: props.leafId, windowId: props.windowId }
    } as DocumentManagerIPCAPI).catch(err => console.error(err))

    publishTableOfContents(update.state)
  }
}

/**
 * Shows the headings of the viewer in the table of contents sidebar, numbered
 * from the top-level keys rather than from Markdown heading level one.
 */
function publishTableOfContents (state: EditorState): void {
  const tableOfContents = state.field(tocField, false)
  windowStateStore.tableOfContents = tableOfContents === undefined ? undefined : rebaseTableOfContents(tableOfContents)
}

/**
 * Returns the number of the topmost line visible in the viewer, regardless of
 * whether the wrapper or CodeMirror's own scroller is the scrolling element.
 */
function topVisibleLine (): number|undefined {
  if (view === null || editorWrapper.value === null) {
    return undefined
  }

  const visibleTop = Math.max(
    editorWrapper.value.getBoundingClientRect().top,
    view.scrollDOM.getBoundingClientRect().top
  )
  const position = view.posAtCoords({ x: view.contentDOM.getBoundingClientRect().left + 1, y: visibleTop + 1 }, false)
  return view.state.doc.lineAt(position).number
}

function scrollToLine (lineNumber: number, selectLine: boolean): void {
  if (view === null) {
    return
  }

  const line = view.state.doc.line(Math.min(Math.max(lineNumber, 1), view.state.doc.lines))
  view.dispatch({
    selection: selectLine ? { anchor: line.from, head: line.to } : undefined,
    effects: EditorView.scrollIntoView(line.from, { y: 'start' })
  })
}

/**
 * Fetches the current document contents, converts them, and replaces the view
 * contents if the resulting Markdown differs from what is displayed.
 *
 * @param   {boolean}  force  Rebuild the view even if the Markdown is unchanged
 *                            (needed after configuration changes)
 */
async function refresh (force: boolean): Promise<void> {
  const request = ++latestRefreshRequest
  const { content } = await documentAuthorityIPCAPI.fetchDoc(props.file.path)
  if (view === null || request !== latestRefreshRequest) {
    return // Unmounted or superseded in the meantime
  }

  if (!force && conversationHistory.value !== undefined && content === convertedContent) {
    return // The same content is still the same conversation
  }

  // Every refresh decides anew from the content whether it is a conversation
  const route = routeJSONViewerContent(content)
  if (route.mode === 'conversation') {
    await showConversation(route.history, content)
    return
  }

  if (conversationHistory.value !== undefined) {
    leaveConversation()
    // The displayed Markdown is not to be trusted after a mode change, and
    // the outline must be visible again before it is rebuilt and scrolled
    force = true
    await nextTick()
    if (view === null || request !== latestRefreshRequest) {
      return
    }
  }

  const result = isJSONLines.value ? convertJSONLinesToMarkdown(content) : convertJSONToMarkdown(content)
  conversion.value = result
  convertedContent = content

  if (!force && result.markdown === displayedMarkdown) {
    return
  }

  const topLine = displayedMarkdown === undefined ? props.topLineMap.get(props.file.path) : topVisibleLine()
  displayedMarkdown = result.markdown

  view.setState(EditorState.create({
    doc: result.markdown,
    extensions: getReadOnlyMarkdownExtensions(viewerConfiguration.value, handleUpdate)
  }))

  if (topLine !== undefined && topLine > 1) {
    scrollToLine(topLine, false)
  }

  publishTableOfContents(view.state)
}

function scheduleRefresh (): void {
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    refresh(false).catch(err => console.error('Could not refresh the formatted JSON view', err))
  }, REFRESH_DELAY)
}

onMounted(() => {
  if (editorWrapper.value === null) {
    return
  }

  view = new EditorView({ parent: editorWrapper.value })
  // A read-only viewer has no word count or cursor information to offer
  windowStateStore.activeDocumentInfo = undefined

  refresh(true)
    .then(() => {
      if (conversationHistory.value !== undefined) {
        focusConversation()
      } else {
        view?.focus()
      }
    })
    .catch(err => console.error('Could not load the formatted JSON view', err))

  stopListening.push(ipcRenderer.on('documents-update', (_event, payload: { event: DP_EVENTS, context: DocumentsUpdateContext }) => {
    const { event, context } = payload
    const contentMayHaveChanged = event === DP_EVENTS.CHANGE_FILE_STATUS ||
      event === DP_EVENTS.FILE_REMOTELY_CHANGED ||
      event === DP_EVENTS.FILE_SAVED

    if (contentMayHaveChanged && context.filePath === props.file.path) {
      scheduleRefresh()
    }
  }))

  stopListening.push(ipcRenderer.on('reload-editors', () => {
    refresh(true).catch(err => console.error('Could not reload the formatted JSON view', err))
  }))

  stopListening.push(ipcRenderer.on('shortcut', (_event, command: string) => {
    if (view === null) {
      return
    }

    const inConversation = conversationHistory.value !== undefined
    const hasFocus = inConversation
      ? conversationViewer.value?.containsFocus() === true
      : view.dom.contains(document.activeElement)
    if (!hasFocus) {
      return // None of our business
    }

    if (command === 'search' && inConversation) {
      conversationViewer.value?.toggleFind()
    } else if (command === 'search') {
      if (searchPanelOpen(view.state)) {
        closeSearchPanel(view)
      } else {
        openSearchPanel(view)
      }
    } else if (command === 'save-file') {
      // Saves edits that have been made in the raw text editor
      ipcRenderer.invoke('documents-provider', {
        command: 'save-file',
        payload: { path: props.file.path }
      } as DocumentManagerIPCAPI).catch(err => console.error(err))
    }
  }))
})

onBeforeUnmount(() => {
  clearTimeout(refreshTimer)
  stopReadingPositionRestore()
  for (const stop of stopListening) {
    stop()
  }

  if (conversationHistory.value !== undefined) {
    // The hidden outline has no meaningful position; its key stays untouched
    saveConversationReadingPosition()
  }

  if (view !== null) {
    if (conversationHistory.value === undefined) {
      const topLine = topVisibleLine()
      if (topLine !== undefined) {
        props.topLineMap.set(props.file.path, topLine)
      }
    }

    windowStateStore.tableOfContents = undefined
    view.destroy()
    view = null
  }
})

// Jump to headings selected in the table of contents sidebar
watch(toRef(props.editorCommands, 'jumpToLine'), () => {
  const { filePath, lineNumber } = props.editorCommands.data
  if (view === null || filePath !== props.file.path || typeof lineNumber !== 'number') {
    return
  }

  if (conversationHistory.value !== undefined) {
    // The entries of the conversation point at lines of the raw file
    stopReadingPositionRestore()
    conversationViewer.value?.revealSourceLines(lineNumber, lineNumber, 'select', true)
    focusConversation()
  } else {
    scrollToLine(lineNumber, true)
    view.focus()
  }
})

// JEV Search (R53, R57): the panel's hit is a range of the raw text. In a JSON
// Lines view each line is a record of its own, so the records on the hit's
// lines are highlighted. The outline of a JSON document does not follow the
// file's lines and has no such mapping; its highlight is only removed.
watch(toRef(props.editorCommands, 'jevSearchHighlight'), () => {
  if (view === null) {
    return
  }

  const request = props.editorCommands.data as JevSearchHighlightRequest
  const isTarget = request !== null && typeof request === 'object' &&
    request.filePath === props.file.path &&
    props.activeFile?.path === props.file.path &&
    documentTreeStore.lastLeafId === props.leafId

  // A conversation keeps the raw file's lines on its nodes, so the hit's
  // lines map to the nodes they came from
  if (conversationHistory.value !== undefined) {
    const conversationView = conversationViewer.value
    if (conversationView === null) {
      return
    }

    if (!isTarget || typeof request.from !== 'number' || typeof request.to !== 'number' || convertedContent === undefined) {
      conversationView.clearHighlight('jev')
      return
    }

    const lines = jevHighlightLineRange(Text.of(convertedContent.split('\n')), request.from, request.to)
    if (lines === undefined) {
      conversationView.clearHighlight('jev')
    } else {
      const scroll = request.scroll !== false
      if (scroll) {
        stopReadingPositionRestore()
      }
      conversationView.revealSourceLines(lines.firstLine, lines.lastLine, 'jev', scroll)
    }
    return
  }

  const records = conversion.value?.records ?? []
  if (!isTarget || typeof request.from !== 'number' || typeof request.to !== 'number' || convertedContent === undefined || records.length === 0) {
    clearJevSearchHighlight(view)
    return
  }

  const lines = jevHighlightLineRange(Text.of(convertedContent.split('\n')), request.from, request.to)
  const range = lines === undefined ? undefined : jsonLinesMarkdownRange(records, lines.firstLine, lines.lastLine)
  if (range === undefined) {
    clearJevSearchHighlight(view)
  } else {
    showJevSearchHighlight(view, range.from, range.to, request.scroll !== false)
  }
})

watch(viewerConfiguration, (newValue, oldValue) => {
  // The computed property yields a new object on any configuration change, so
  // only rebuild the view if a value relevant to the viewer has changed.
  if (JSON.stringify(newValue) !== JSON.stringify(oldValue)) {
    refresh(true).catch(err => console.error('Could not apply the configuration to the formatted JSON view', err))
  }
})
</script>

<style lang="less">
.formatted-json-viewer {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;

  .formatted-json-notice {
    flex-shrink: 0;
    padding: 6px 12px;
    font-size: 13px;
    background-color: #fff4d6;
    color: #5c4400;
    border-bottom: 1px solid #f0d890;
  }

  .main-editor-wrapper,
  .conversation-viewer-wrapper {
    flex: 1 1 0;
    min-height: 0;
  }
}

body.dark .formatted-json-viewer .formatted-json-notice {
  background-color: #4a3d1a;
  color: #f3e2b0;
  border-bottom-color: #6b5a2a;
}
</style>
