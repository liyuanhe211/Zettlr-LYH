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
      ref="editorWrapper"
      class="main-editor-wrapper"
      v-bind:style="{ 'font-size': `${fontSize}px` }"
    >
      <!-- The read-only CodeMirror instance is mounted here -->
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
 *                  show up as well.
 *
 * END HEADER
 */
import { computed, onBeforeUnmount, onMounted, ref, toRef, watch } from 'vue'
import { EditorState } from '@codemirror/state'
import { EditorView, type ViewUpdate } from '@codemirror/view'
import { closeSearchPanel, openSearchPanel, searchPanelOpen } from '@codemirror/search'
import { DP_EVENTS, type OpenDocument } from '@dts/common/documents'
import { CITEPROC_MAIN_DB } from '@dts/common/citeproc'
import type { EditorCommands } from '../App.vue'
import { getReadOnlyMarkdownExtensions } from '@common/modules/markdown-editor/editor-extension-sets'
import { getDefaultConfig, type EditorConfiguration } from '@common/modules/markdown-editor/util/configuration'
import { tocField } from '@common/modules/markdown-editor/plugins/toc-field'
import { documentAuthorityIPCAPI } from '@common/modules/markdown-editor/util/ipc-api'
import { convertJSONLinesToMarkdown, convertJSONToMarkdown, rebaseTableOfContents, type JSONMarkdownConversion } from '@common/util/json-to-markdown'
import { hasExt, JSONL_EXT } from '@common/util/file-extention-checks'
import { pathBasename } from '@common/util/renderer-path-polyfill'
import { useConfigStore, useWindowStateStore } from 'source/pinia'
import type { DocumentManagerIPCAPI, DocumentsUpdateContext } from 'source/app/service-providers/documents'

const ipcRenderer = window.ipc

// How long to wait after the last change to the document before regenerating
// the view, so that typing in a raw editor pane does not rebuild it constantly.
const REFRESH_DELAY = 300

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

const editorWrapper = ref<HTMLDivElement|null>(null)
const conversion = ref<JSONMarkdownConversion|undefined>(undefined)
const fontSize = computed<number>(() => configStore.config.editor.fontSize)
const isJSONLines = computed<boolean>(() => hasExt(props.file.path, JSONL_EXT))

const notice = computed<string>(() => {
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
let refreshTimer: ReturnType<typeof setTimeout>|undefined
let latestRefreshRequest = 0
const stopListening: Array<() => void> = []

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

  const result = isJSONLines.value ? convertJSONLinesToMarkdown(content) : convertJSONToMarkdown(content)
  conversion.value = result

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
    .then(() => view?.focus())
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
    if (view === null || !view.dom.contains(document.activeElement)) {
      return // None of our business
    }

    if (command === 'search') {
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
  for (const stop of stopListening) {
    stop()
  }

  if (view !== null) {
    const topLine = topVisibleLine()
    if (topLine !== undefined) {
      props.topLineMap.set(props.file.path, topLine)
    }

    windowStateStore.tableOfContents = undefined
    view.destroy()
    view = null
  }
})

// Jump to headings selected in the table of contents sidebar
watch(toRef(props.editorCommands, 'jumpToLine'), () => {
  const { filePath, lineNumber } = props.editorCommands.data
  if (view !== null && filePath === props.file.path && typeof lineNumber === 'number') {
    scrollToLine(lineNumber, true)
    view.focus()
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

  .main-editor-wrapper {
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
