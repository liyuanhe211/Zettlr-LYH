<template>
  <WindowChrome
    v-bind:title="windowTitle"
    v-bind:titlebar="shouldShowTitlebar"
    v-bind:menubar="shouldShowMenubar"
    v-bind:menubar-center-title="menubarCenterTitle"
    v-bind:show-toolbar="shouldShowToolbar"
    v-bind:toolbar-labels="false"
    v-bind:toolbar-controls="toolbarControls"
    v-bind:disable-vibrancy="!hasVibrancy"
    v-on:toolbar-toggle="handleToggle($event)"
    v-on:toolbar-click="handleClick($event)"
  >
    <!-- Zettlr-LYH (R174): the formatting bar, a row below the toolbar -->
    <template #toolbar-second-row>
      <FormattingBar
        v-if="shouldShowFormattingBar"
        v-on:command="handleClick($event)"
        v-on:color="handleFormattingColor($event)"
      ></FormattingBar>
    </template>
    <SplitView
      ref="fileManagerSplitComponent"
      v-bind:initial-size-percent="fileManagerSplitComponentInitialSize"
      v-bind:minimum-size-percent="[ 10, 50 ]"
      v-bind:reset-size-percent="[ 20, 80 ]"
      v-bind:split="'horizontal'"
      v-on:views-resized="fileManagerSplitComponentResized($event)"
    >
      <template #view1>
        <!-- File manager in the left side of the split view -->
        <FileManager
          v-show="mainSplitViewVisibleComponent === 'fileManager'"
          ref="file-manager"
          v-bind:window-id="windowId"
        ></FileManager>
        <!-- ... or the global search, if selected -->
        <GlobalSearch
          v-show="mainSplitViewVisibleComponent === 'globalSearch'"
          ref="globalSearchComponent"
          v-bind:window-id="windowId"
          v-on:jtl="(filePath, lineNumber, newTab) => jtl(filePath, lineNumber, newTab)"
        >
        </GlobalSearch>
      </template>
      <template #view2>
        <!-- Another split view in the right side -->
        <SplitView
          ref="editorSidebarSplitComponent"
          v-bind:initial-size-percent="editorSidebarSplitComponentInitialSize"
          v-bind:minimum-size-percent="[ 50, 10 ]"
          v-bind:reset-size-percent="[ 80, 20 ]"
          v-bind:split="'horizontal'"
          v-on:views-resized="editorSidebarSplitComponentResized($event)"
        >
          <template #view1>
            <!-- First side: Editor, with the JEV Search panel (R53) on its
                 right while that is open -->
            <div class="editor-area-with-jev-search">
              <div class="editor-area">
                <EditorPane
                  v-if="paneConfiguration?.type === 'leaf'"
                  v-bind:node="paneConfiguration"
                  v-bind:leaf-id="paneConfiguration.id"
                  v-bind:editor-commands="editorCommands"
                  v-bind:window-id="windowId"
                  v-on:global-search="startGlobalSearch($event)"
                ></EditorPane>
                <EditorBranch
                  v-else-if="paneConfiguration !== undefined"
                  v-bind:node="paneConfiguration"
                  v-bind:window-id="windowId"
                  v-bind:editor-commands="editorCommands"
                  v-bind:is-last="true"
                  v-on:global-search="startGlobalSearch($event)"
                ></EditorBranch>
              </div>
              <JevSearchPanel
                v-if="showJevSearchPanel"
                v-on:highlight="highlightJevSearchHit($event)"
                v-on:pdf-request="relayJevSearchPdfRequest($event)"
              ></JevSearchPanel>
            </div>
          </template>
          <template #view2>
            <!-- Second side: Sidebar -->
            <MainSidebar
              v-on:move-section="moveSection($event)"
              v-on:jump-to-line="genericJtl($event)"
            ></MainSidebar>
          </template>
        </SplitView>
      </template>
    </SplitView>
  </WindowChrome>

  <!-- Window-owned views survive pane replacement and move by Teleport. -->
  <div ref="conflictParkingHost" style="display: none"></div>
  <Teleport
    v-for="session in conflictMergeSessionsWithContents"
    v-bind:key="session.sessionId"
    v-bind:to="conflictPaneHosts.get(session.leafId) ?? conflictParkingHost ?? 'body'"
  >
    <ConflictMergeOverlay
      v-bind:file-path="session.filePath"
      v-bind:session-id="session.sessionId"
      v-bind:editor-contents="session.contents.editorContents"
      v-bind:disk-contents="session.contents.diskContents"
      v-bind:disk-modified-at="session.contents.diskModifiedAt"
      v-bind:disk-size="session.contents.diskSize"
      v-bind:editor-edited-at="session.contents.editorEditedAt"
      v-bind:editor-size="session.contents.editorSize"
      v-bind:active="conflictPaneHosts.has(session.leafId) && documentTreeStore.paneData.some(pane => pane.id === session.leafId && pane.activeFile?.path === session.filePath)"
      v-on:close="finishConflictMerge"
      v-on:refresh="refreshConflictMerge"
    ></ConflictMergeOverlay>
  </Teleport>

  <!-- Popover area: these will be teleported to the body element anyhow -->
  <PopoverExport
    v-if="showExportPopover && exportButton !== null && activeFile !== undefined"
    v-bind:target="exportButton"
    v-bind:file-path="activeFile.path"
    v-on:close="showExportPopover = false"
  ></PopoverExport>
  <PopoverStats
    v-if="showStatsPopover && statsButton !== null"
    v-bind:target="statsButton"
    v-on:close="showStatsPopover = false"
  ></PopoverStats>
  <PopoverTags
    v-if="showTagsPopover && tagsButton !== null"
    v-bind:target="tagsButton"
    v-on:close="showTagsPopover = false"
    v-on:search-tag="startGlobalSearch($event)"
  ></PopoverTags>
  <PopoverTable
    v-if="showTablePopover && tableButton !== null"
    v-bind:target="tableButton"
    v-on:close="showTablePopover = false"
    v-on:insert-table="insertTable($event)"
  ></PopoverTable>
  <PopoverDocInfo
    v-if="showDocInfoPopover && docInfoButton !== null && windowStateStore.activeDocumentInfo != null"
    v-bind:target="docInfoButton"
    v-bind:doc-info="windowStateStore.activeDocumentInfo"
    v-bind:should-count-chars="shouldCountChars"
    v-on:close="showDocInfoPopover = false"
  ></PopoverDocInfo>
  <PopoverPomodoro
    v-if="showPomodoroPopover && pomodoroButton !== null"
    v-bind:target="pomodoroButton"
    v-bind:pomodoro="pomodoro"
    v-bind:sound-effects="SOUND_EFFECTS"
    v-on:close="showPomodoroPopover = false"
    v-on:config="setPomodoroConfig($event)"
    v-on:start="startPomodoro()"
    v-on:stop="stopPomodoro()"
  ></PopoverPomodoro>
  <PopoverLRT
    v-if="showTasksPopover && tasksButton !== null"
    v-bind:target="tasksButton"
    v-on:close="showTasksPopover = false"
  ></PopoverLRT>
  <PopoverPandoc
    v-if="showPandocPopover && pandocButton !== null"
    v-bind:target="pandocButton"
    v-bind:pandoc-type="pandocPopoverType"
    v-on:close="showPandocPopover = false"
    v-on:insert-pandoc="insertPandoc($event)"
  ></PopoverPandoc>
  <!-- Zettlr-LYH Windows dialog (R72): the window manager of the Window menu -->
  <WindowsManagerDialog
    v-if="showWindowsManager"
    v-bind:window-id="windowId"
    v-on:close="showWindowsManager = false"
  ></WindowsManagerDialog>
  <!-- Zettlr-LYH (R84): asks for the revision author before Track Changes
       is turned on for the first time -->
  <RevisionAuthorDialog
    v-if="showRevisionAuthorDialog"
    v-bind:initial-name="configStore.config.editor.revisionAuthor ?? ''"
    v-on:confirm="confirmRevisionAuthor($event)"
    v-on:cancel="showRevisionAuthorDialog = false"
  ></RevisionAuthorDialog>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        App
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This is the entry component for the main window.
 *
 * END HEADER
 */

import WindowChrome from '@common/vue/window/WindowChrome.vue'
import FileManager from './file-manager/FileManager.vue'
import MainSidebar from './sidebar/MainSidebar.vue'
import EditorPane from './EditorPane.vue'
import EditorBranch from './EditorBranch.vue'
import SplitView from '../common/vue/window/SplitView.vue'
import GlobalSearch from './GlobalSearch.vue'
import ConflictMergeOverlay from './ConflictMergeOverlay.vue'
import PopoverExport from './PopoverExport.vue'
import PopoverStats from './PopoverStats.vue'
import PopoverTags from './PopoverTags.vue'
import PopoverPomodoro from './PopoverPomodoro.vue'
import PopoverTable from './PopoverTable.vue'
import PopoverDocInfo from './PopoverDocInfo.vue'
import PopoverPandoc from './PopoverPandoc.vue'
import { trans } from '@common/i18n-renderer'
import generateId from '@common/util/generate-id'
import {
  nextTick,
  provide,
  ref,
  toRaw,
  computed,
  watch,
  onMounted,
  onBeforeMount,
  onBeforeUnmount
} from 'vue'

// Import the sound effects for the pomodoro timer
import glassFile from './assets/glass.wav'
import alarmFile from './assets/digital_alarm.mp3'
import chimeFile from './assets/chime.mp3'
import { DocumentType, DP_EVENTS, type BranchNodeJSON, type LeafNodeJSON } from '@dts/common/documents'
import { buildPipeMarkdownTable } from '@common/util/build-pipe-markdown-table'
import { type UpdateState } from '@providers/updates'
import { type ToolbarControl } from '@common/vue/window/WindowToolbar.vue'
import { type ToolbarDragUpdate } from '@common/vue/window/toolbar-controls/DragAdjustControl.vue'
import {
  isSplitLayout,
  marginConfigKey,
  maxEditorMargin,
  MAXIMUM_STORED_EDITOR_MARGIN,
  storedEditorMargin
} from './util/editor-margin'
import getDocumentTitle from './util/get-document-title'
import { isScratchNoteTabPath } from './file-manager/util/unsaved-tab-paths'
import { hasMarkdownExt } from '@common/util/file-extention-checks'
import { exportToHTMLAndShow } from './util/export-document-to-html'
import { exportDocumentToPptx, pptxExportMessage, pptxExportRunning } from './util/export-document-to-pptx'
import { useConfigStore, useDocumentTreeStore, useLRTStore, useWindowStateStore } from 'source/pinia'
import type { ConfigOptions } from 'source/app/service-providers/config/get-config-template'
import { type AnyDescriptor } from 'source/types/common/fsal'
import type { DocumentManagerIPCAPI, DocumentsUpdateContext } from 'source/app/service-providers/documents'
import { TaskStatus } from 'source/pinia/lrt-store'
import PopoverLRT from './PopoverLRT.vue'
import { pptxSyncScrollEnabled } from '@common/util/pptx-preview-link'
import { createSplitEditorOperation, splitEditorPanes, splitPlacement, type SplitSide } from './util/split-view-target'
import { captureWindowEditorReadingStates, editorPaneReadingStates } from './util/editor-pane-reading-state'
import type { CheckPathKindsResult } from '@providers/commands/path-kinds'
import { forgetDocumentColumnWidths } from '@common/modules/markdown-editor/table-editor/column-resize'
import WindowsManagerDialog from './WindowsManagerDialog.vue' // Zettlr-LYH Windows dialog (R72)
import RevisionAuthorDialog from './RevisionAuthorDialog.vue' // Zettlr-LYH revision author (R84)
import JevSearchPanel from './JevSearchPanel.vue'
import FormattingBar, { type FormattingColorRequest } from './FormattingBar.vue' // Zettlr-LYH formatting bar (R174)
import { type JevSearchHighlightRequest } from '@common/modules/jev-search'
import {
  PDF_BACKLINK_OPEN_EVENT,
  PDF_LINK_LOCATE_EVENT,
  type PdfBacklinkOpenDetail,
  type PdfLinkLocateDetail,
  type PdfViewerRequest
} from '@dts/common/pdf-viewer'
import { isSamePdfFilePath } from './file-viewers/pdf-viewer/viewer-request'
import type { PdfViewerRequestRecord } from './file-viewers/pdf-viewer/viewer-request'
import {
  buildGetConflictMergeContentsCommand,
  CONFLICT_MERGE_REGISTRY_KEY,
  type ConflictMergeContents,
  type ConflictMergePaneSummary,
  type ConflictMergeRegistry,
  type ConflictMergeSession,
  FILE_CONFLICT_DISK_CHANGED_EVENT,
  isConflictMergeContents,
  resolveConflictMergeLeaf,
  shouldHandleConflictMerge
} from './util/conflict-merge'
import { CONFLICT_READ_ONLY_REGISTRY_KEY, ConflictReadOnlyState, isUnsupportedConflictReadOnlyCommand, type ConflictReadOnlyRegistry } from './util/conflict-read-only'

const ipcRenderer = window.ipc

const configStore = useConfigStore()
const documentTreeStore = useDocumentTreeStore()
const windowStateStore = useWindowStateStore()
const LRTStore = useLRTStore()

const SOUND_EFFECTS = [
  {
    file: glassFile,
    label: 'Glass'
  },
  {
    file: alarmFile,
    label: 'Digital Alarm'
  },
  {
    file: chimeFile,
    label: 'Chime'
  }
]

const searchParams = new URLSearchParams(window.location.search)
// The window number indicates which main window this one here is. This is only
// necessary for the documents and split views to show up.
const windowId = searchParams.get('window_id')!

const fileManagerVisible = computed<boolean>(() => configStore.config.window.fileManagerVisible)
const mainSplitViewVisibleComponent = ref<'fileManager'|'globalSearch'>('fileManager')
const isUpdateAvailable = ref(false)
const hasVibrancy = computed(() => configStore.config.window.vibrancy && process.platform === 'darwin')

// Ensure the app remembers the previous sidebar sizes
const fileManagerSplitComponentInitialSize = ref<[number, number]>([ 20, 80 ])
const editorSidebarSplitComponentInitialSize = ref<[number, number]>([ 80, 20 ])
onBeforeMount(() => {
  fileManagerSplitComponentInitialSize.value = configStore.config.ui.fileManagerSplitSize
  editorSidebarSplitComponentInitialSize.value = configStore.config.ui.editorSidebarSplitSize
})

// Popover targets
const exportButton = ref<HTMLElement|null>(null)
const showExportPopover = ref<boolean>(false)
const statsButton = ref<HTMLElement|null>(null)
const showStatsPopover = ref<boolean>(false)
const tagsButton = ref<HTMLElement|null>(null)
const showTagsPopover = ref<boolean>(false)
const tableButton = ref<HTMLElement|null>(null)
const showTablePopover = ref<boolean>(false)
const docInfoButton = ref<HTMLElement|null>(null)
const showDocInfoPopover = ref<boolean>(false)
const pomodoroButton = ref<HTMLElement|null>(null)
const showPomodoroPopover = ref<boolean>(false)
const tasksButton = ref<HTMLElement|null>(null)
const showTasksPopover = ref(false)
const pandocButton = ref<HTMLElement|null>(null)
// Which of the two Pandoc inserts the popover is currently configuring
const pandocPopoverType = ref<'div'|'span'>('div')
const showPandocPopover = ref<boolean>(false)

// Zettlr-LYH disk conflicts (R138): the comparisons of this window. Every
// session belongs to one pane. App owns the view and teleports it into that
// pane, so replacing a pane never destroys its edited texts or undo history.
// The independent authority metadata protects original editors in all windows.
// A session holds no contents while they are being fetched.
const conflictMergeSessions = ref<ConflictMergeSession[]>([])
const conflictMergeSessionsWithContents = computed(() => conflictMergeSessions.value.filter(
  (session): session is ConflictMergeSession & { contents: ConflictMergeContents } => session.contents !== undefined
))
const conflictParkingHost = ref<HTMLElement|null>(null)
const conflictPaneHosts = ref(new Map<string, HTMLElement>())
const conflictReadOnlyState = ref(new ConflictReadOnlyState())
const conflictReadOnlyRegistry: ConflictReadOnlyRegistry = {
  get ready () { return conflictReadOnlyState.value.revision >= 0 || conflictReadOnlyState.value.legacy },
  get legacy () { return conflictReadOnlyState.value.legacy },
  get sessions () { return conflictReadOnlyState.value.legacy ? conflictMergeSessions.value : conflictReadOnlyState.value.sessions },
  isReadOnly: filePath => !conflictReadOnlyRegistry.ready || conflictReadOnlyRegistry.sessions.some(session => session.filePath === filePath),
  registerPane: (leafId, host) => {
    if (host === null) { conflictPaneHosts.value.delete(leafId) } else { conflictPaneHosts.value.set(leafId, host) }
  }
}
provide(CONFLICT_READ_ONLY_REGISTRY_KEY, conflictReadOnlyRegistry)
// The newest fetch of the contents per file: a reply of an older fetch is dropped
const conflictMergeFetchCounters = new Map<string, number>()
const conflictMergeRegistry: ConflictMergeRegistry = {
  get sessions (): readonly ConflictMergeSession[] {
    return conflictMergeSessions.value
  },
  hasSession: (filePath: string): boolean => conflictMergeSessions.value.some(session => session.filePath === filePath),
  finish: finishConflictMerge,
  refresh: refreshConflictMerge
}
provide(CONFLICT_MERGE_REGISTRY_KEY, conflictMergeRegistry)

// The pane of a session follows the tab: if the tab moves to another pane of
// this window, the comparison moves with it. Only the main process may end the
// authority session; temporary pane replacement merely parks the view.
watch(
  () => documentTreeStore.paneData
    .map((pane: LeafNodeJSON) => `${pane.id}\n${pane.openFiles.map(file => file.path).join('\n')}`)
    .join('\n\n'),
  () => { followConflictMergePanes() }
)

// Zettlr-LYH Windows dialog (R72): whether the window manager is shown
const showWindowsManager = ref(false)
// Zettlr-LYH (R84): the author name dialog of the Track Changes button
const showRevisionAuthorDialog = ref(false)

export interface PomodoroConfig {
  currentEffectFile: string
  soundEffect: HTMLAudioElement
  intervalHandle: ReturnType<typeof setInterval>|undefined
  popover: any
  durations: {
    task: number
    short: number
    long: number
  }
  phase: {
    type: 'task'|'short'|'long'
    elapsed: number
  }
  counter: {
    task: number
    short: number
    long: number
  }
  colour: {
    task: string
    short: string
    long: string
  }
}

const pomodoro = ref<PomodoroConfig>({
  currentEffectFile: glassFile,
  soundEffect: new Audio(glassFile),
  intervalHandle: undefined,
  popover: undefined,
  durations: { task: 1500, short: 300, long: 1200 },
  phase: { type: 'task', elapsed: 0 },
  counter: { task: 0, short: 0, long: 0 },
  colour: { task: '#ff3366', short: '#ddff00', long: '#33ffcc' }
})

/**
 * Okay, hear me out. We have the following situation: We have a toolbar, and
 * external components that want to tell the main editor to do something. But
 * Vue doesn't have a concept of events being passed down to child components
 * and since editors may now be nested arbitrarily deep, we have no direct way
 * of accessing the editors and tell them to do something. Basically, Vue's data
 * flow goes like this: Events flow up, and props flow down. That's it. So we're
 * using this hacky solution "misusing" props as events. This interface
 * represents all the potential editor commands that can be issued. The last
 * property can contain arbitrary data if required by the command. We'll be
 * passing this struct as a prop down to every EditorBranch and EditorPane into
 * the main editor components. Every editor instance then listens to these
 * events by watching property changes (i.e. when moveSection switches from true
 * to false) and testing if they are the last editor (the only identifying info
 * we can store in the state to not break things due to Vue's aggressive
 * reactivity). Then, the editors can act based on this info.
 *
 * One example:
 * 1. The app receives a jump to line-command. It then writes the necessary info
 *    (in this case, which line to jump to) into the `data` prop. That is not
 *    watched by the editors, but since it's part of the data structure, it will
 *    silently update in the background.
 * 2. Then, the app switches the jumpToLine-property (false->true or otherwise).
 *    Since that sub-property is being watched by the editors, it will trigger
 *    the watcher that then checks the lastLeafId in the state. If that
 *    corresponds to the editor's leaf ID, the editor calls the appropriate
 *    function locally, and executes the command, providing the data.
 */
export interface EditorCommands {
  jumpToLine: boolean
  moveSection: boolean
  addKeywords: boolean
  replaceSelection: boolean
  insertPandoc: boolean
  executeCommand: boolean
  // Zettlr-LYH (R174): the Text Color and Background Color buttons of the
  // formatting bar; data is a FormattingColorRequest
  applyTextColor: boolean
  // Zettlr-LYH JEV Search (R53): data is a JevSearchHighlightRequest
  jevSearchHighlight: boolean
  // Zettlr-LYH PDF viewer (R59, contract C5): data is a PdfViewerRequest
  pdfViewerRequest: boolean
  // Zettlr-LYH PDF viewer: the most recent pdfViewerRequest and when it was
  // sent, so that a viewer that mounts or finishes loading only after the
  // request can still carry it out (not watched; null before the first one)
  lastPdfViewerRequest: PdfViewerRequestRecord|null
  // For jumpToLine: { filePath, lineNumber, cursorOnly?, leafId?, position? };
  // cursorOnly (R62 PDF backlinks) places the cursor at the line start without
  // selecting it; leafId (R113, table of contents) restricts the jump to the
  // editor of that pane; position 'reading-line' (R112) puts the line top at
  // one third of the visible height instead of the middle
  data: any
}

// Editor commands state
const editorCommands = ref<EditorCommands>({
  jumpToLine: false,
  moveSection: false,
  addKeywords: false,
  replaceSelection: false,
  insertPandoc: false,
  executeCommand: false,
  applyTextColor: false,
  jevSearchHighlight: false,
  pdfViewerRequest: false,
  lastPdfViewerRequest: null,
  data: undefined
})

const sidebarsBeforeDistractionfree = ref<{ fileManager: boolean, sidebar: boolean }>({
  fileManager: true,
  sidebar: false
})

const sidebarVisible = computed<boolean>(() => configStore.config.window.sidebarVisible)
const activeFile = computed(() => documentTreeStore.lastLeafActiveFile)
// Whether the currently active document has its pandoc PPTX preview open
// (drives the on/off coloring of the toolbar's Pandoc PPTX text button)
const activeFileHasPptxPreview = computed<boolean>(() => {
  const filePath = activeFile.value?.path
  return filePath !== undefined && windowStateStore.pptxPreviewPaths.has(filePath)
})
const shouldCountChars = computed<boolean>(() => configStore.config.editor.countChars)
const windowTitle = computed<string>(() => {
  if (activeFile.value === undefined) {
    return 'Zettlr'
  }

  return `Zettlr - ${getDocumentTitle(activeFile.value)}`
})
// The configured scratch folder (R40), as the main process reads it
const scratchDirectory = computed<string>(() => {
  const configured: unknown = configStore.config.scratchNotesDirectory
  return typeof configured === 'string' ? configured : ''
})
// Zettlr-LYH (R85): the title in the middle of the menu bar: the full path of
// the active tab, shortened by the menu bar; a scratch note (R40, a .md file
// directly inside the scratch folder, also after it was renamed, R102; see
// isScratchNoteTabPath) shows its tab name instead; nothing when no file is
// open.
const menubarCenterTitle = computed<{ text: string, isPath: boolean }>(() => {
  const file = activeFile.value
  if (file === undefined) {
    return { text: '', isPath: true }
  }

  if (isScratchNoteTabPath(file.path, scratchDirectory.value)) {
    return { text: getDocumentTitle(file), isPath: false }
  }

  return { text: file.path, isPath: true }
})

// Simple state machine to trigger which of the three shows up when. Below's the
// corresponding truth table, which is relatively large, but by spotting some
// patterns, we can see when which of the three Window Chrome elements shall be
// shown.
/*

| Platform | Hide Toolbar in DF? | Is DF? | Is FS? | Titlebar | Menubar | Toolbar |
|----------|---------------------|--------|--------|----------|---------|---------|
| Linux    | False               | False  | False  | False    | !native | True    |
| Linux    | False               | False  | True   | False    | !native | True    |
| Linux    | False               | True   | False  | False    | !native | True    |
| Linux    | False               | True   | True   | False    | !native | True    |
| Linux    | True                | False  | False  | False    | !native | True    |
| Linux    | True                | False  | True   | False    | !native | True    |
| Linux    | True                | True   | False  | False    | !native | False   |
| Linux    | True                | True   | True   | False    | !native | False   |
| macOS    | False               | False  | False  | False    | False   | True    |
| macOS    | False               | False  | True   | False    | False   | True    |
| macOS    | False               | True   | False  | False    | False   | True    |
| macOS    | False               | True   | True   | False    | False   | True    |
| macOS    | True                | False  | False  | False    | False   | True    |
| macOS    | True                | False  | True   | False    | False   | True    |
| macOS    | True                | True   | False  | True     | False   | False   |
| macOS    | True                | True   | True   | False    | False   | False   |
| Windows  | False               | False  | False  | False    | True    | True    |
| Windows  | False               | False  | True   | False    | True    | True    |
| Windows  | False               | True   | False  | False    | True    | True    |
| Windows  | False               | True   | True   | False    | True    | True    |
| Windows  | True                | False  | False  | False    | True    | True    |
| Windows  | True                | False  | True   | False    | True    | True    |
| Windows  | True                | True   | False  | False    | True    | False   |
| Windows  | True                | True   | True   | False    | True    | False   |

*/

// The titlebar shall be shown on the main window in only one single instance
const shouldShowTitlebar = computed<boolean>(() => process.platform === 'darwin' && configStore.config.display.hideToolbarInDistractionFree && distractionFree.value)
// The menubar is independent of other values; always shown on Windows, and on Linux only if native Appearance is off.
const shouldShowMenubar = computed<boolean>(() => process.platform === 'win32' || (process.platform !== 'darwin' && !configStore.config.window.nativeAppearance))

// Finally, the toolbar. That one is a bit more iffy. It is always shown, EXCEPT
// Hide Toolbar is True and DistractionFree is True
const shouldShowToolbar = computed<boolean>(() => !distractionFree.value || !configStore.config.display.hideToolbarInDistractionFree)

// Zettlr-LYH (R174): the formatting bar below the toolbar. It is shown when the
// toolbar is shown and the setting editor.showFormattingToolbar is on.
const shouldShowFormattingBar = computed<boolean>(() => shouldShowToolbar.value && configStore.config.editor.showFormattingToolbar)

// Long-Running-Task setup
// Zettlr-LYH (R58): the toolbar no longer shows the task indicator, so these
// counts have no reader; they stay unchanged to keep this file close to
// upstream for later merges.
/* eslint-disable @typescript-eslint/no-unused-vars */
const hasTasks = computed(() => LRTStore.tasks.length > 0)
const taskSuccess = computed(() => LRTStore.tasks.filter(t => t.status === TaskStatus.finished).length)
const taskAborted = computed(() => LRTStore.tasks.filter(t => t.status === TaskStatus.aborted).length)
const taskError = computed(() => LRTStore.tasks.filter(t => t.status === TaskStatus.error).length)
const taskOngoing = computed(() => LRTStore.tasks.filter(t => t.status === TaskStatus.ongoing).length)
/* eslint-enable @typescript-eslint/no-unused-vars */

// Zettlr-LYH (R81): whether the editor area shows two or more panes, which
// decides which of the two stored margins applies
const editorAreaSplit = computed<boolean>(() => isSplitLayout(documentTreeStore.paneStructure))
let editorMarginDrag: { split: boolean, cancelled: boolean }|null = null
watch(() => documentTreeStore.paneStructure, () => {
  if (editorMarginDrag !== null) {
    editorMarginDrag.cancelled = true
    windowStateStore.editorMarginPreview = null
  }
}, { deep: true, flush: 'sync' })

// Zettlr-LYH (R81): the tooltip of the Margin control
const editorMarginTitle = computed<string>(() => {
  const single = storedEditorMargin(configStore.config.display, false)
  const split = storedEditorMargin(configStore.config.display, true)
  const title = `Drag left or right to change the left and right margins of the editor text. Single pane: ${single} px, split panes: ${split} px`
  return distractionFree.value ? `${title}. Not available in distraction free mode` : title
})

const toolbarControls = computed<ToolbarControl[]>(() => {
  return [
    {
      type: 'three-way-toggle',
      id: 'toggle-file-manager',
      stateOne: {
        id: 'fileManager',
        title: trans('Toggle File Manager'),
        icon: 'hard-disk'
      },
      stateTwo: {
        id: 'globalSearch',
        title: trans('Search across all files'),
        icon: 'search'
      },
      initialState: (fileManagerVisible.value) ? mainSplitViewVisibleComponent.value : undefined
    },
    {
      // Zettlr-LYH (R58): the file manager and search switch, Open workspace,
      // Export to HTML and Split editor right form one strip of touching
      // square buttons at the left end; joinPrevious removes the gap between
      // each of the last three and its predecessor
      type: 'button',
      id: 'root-open-workspaces',
      title: trans('Open workspace…'),
      icon: 'folder-open',
      joinPrevious: true
    },
    {
      type: 'button',
      class: 'share',
      id: 'export',
      title: 'Export to HTML',
      icon: 'export',
      joinPrevious: true
    },
    {
      // Zettlr-LYH split view (R44): a second view of the active file in a
      // new pane to the right of the focused one. R58 made it the last button
      // of the strip and gave it an icon of two equal columns
      type: 'button',
      id: 'split-editor-right',
      title: 'Split editor right',
      icon: 'split-columns',
      joinPrevious: true
    },
    {
      // Zettlr-LYH: vertical separator lines divide the left half of the
      // toolbar into the strip above, the six insert icons, Mark LYH Revise
      // and Auto Show Code
      type: 'separator',
      id: 'separator-after-strip'
    },
    {
      type: 'button',
      id: 'markdownComment',
      title: trans('Insert comment'),
      icon: 'code',
      visible: getToolbarButtonDisplay('showMarkdownCommentButton')
    },
    {
      type: 'button',
      id: 'markdownLink',
      title: trans('Insert link'),
      icon: 'link',
      visible: getToolbarButtonDisplay('showMarkdownLinkButton')
    },
    {
      type: 'button',
      id: 'markdownImage',
      title: trans('Insert image'),
      icon: 'image',
      visible: getToolbarButtonDisplay('showMarkdownImageButton')
    },
    {
      type: 'button',
      id: 'markdownMakeTaskList',
      title: trans('Insert task list'),
      icon: 'checkbox-list',
      visible: getToolbarButtonDisplay('showMarkdownMakeTaskListButton')
    },
    {
      type: 'button',
      id: 'insert-table',
      title: trans('Insert table'),
      icon: 'table',
      visible: getToolbarButtonDisplay('showInsertTableButton')
    },
    {
      type: 'button',
      id: 'insertFootnote',
      title: trans('Insert footnote'),
      icon: 'footnote',
      visible: getToolbarButtonDisplay('showInsertFootnoteButton')
    },
    {
      // Hidden together with the six insert icons, so that two separator lines
      // never meet when all of them are switched off in the preferences
      type: 'separator',
      id: 'separator-after-insert-buttons',
      visible: isAnyInsertButtonShown()
    },
    {
      // Zettlr-LYH: Revise Comment (formerly Mark LYH Revise, R76) marks the
      // selection for revision as [selection{}] with the cursor between the
      // braces; without a selection it inserts [{}] at the cursor (R108). The
      // editor binds the same command to Ctrl+R. The identifiers keep the old
      // name.
      type: 'button',
      id: 'markLyhRevise',
      title: 'Wrap the selection in [ ] with a {comment} slot for revision comments, or insert [{}] without a selection (Ctrl+R)',
      buttonText: 'Revise Comment',
      icon: '',
      class: 'toolbar-text-button mark-lyh-revise-button'
    },
    // Zettlr-LYH (R84, spec C10): the revision mode group directly follows
    // Revise Comment without separators: two switches, then two actions
    {
      type: 'button',
      id: 'toggle-track-changes',
      title: 'Record insertions and deletions as tracked changes with your author name',
      buttonText: 'Track Changes',
      icon: '',
      pressed: configStore.config.editor.trackChanges,
      class: configStore.config.editor.trackChanges ? 'toolbar-text-button track-changes-button active' : 'toolbar-text-button track-changes-button'
    },
    {
      type: 'button',
      id: 'toggle-show-revisions',
      title: 'Show tracked changes; when off, show the text as if all changes were accepted',
      buttonText: 'Show Revisions',
      icon: '',
      pressed: configStore.config.display.showRevisions,
      class: configStore.config.display.showRevisions ? 'toolbar-text-button show-revisions-button active' : 'toolbar-text-button show-revisions-button'
    },
    {
      type: 'button',
      id: 'acceptRevision',
      title: 'Accept the tracked change at the cursor or in the selection, then move to the next one',
      buttonText: 'Accept',
      icon: '',
      class: 'toolbar-text-button revision-action-button'
    },
    {
      type: 'button',
      id: 'rejectRevision',
      title: 'Reject the tracked change at the cursor or in the selection, then move to the next one',
      buttonText: 'Reject',
      icon: '',
      class: 'toolbar-text-button revision-action-button'
    },
    {
      type: 'separator',
      id: 'separator-before-auto-show-code'
    },
    {
      type: 'button',
      id: 'toggle-edit-code-when-clicked',
      title: 'Reveal Markdown source on cursor entry; when off, only the types enabled in Editor preferences reveal source',
      buttonText: 'Auto Show Code',
      icon: '',
      pressed: configStore.config.display.editCodeWhenClicked,
      class: configStore.config.display.editCodeWhenClicked ? 'toolbar-text-button edit-code-when-clicked-button active' : 'toolbar-text-button edit-code-when-clicked-button'
    },
    {
      // Zettlr-LYH (R81): dragged sideways rather than clicked, it sets the
      // left and right margins of the Markdown editors; one value for a
      // single pane, one for split panes. Directly next to Auto Show Code,
      // without a separator in between
      type: 'drag-adjust',
      id: 'editor-margin',
      label: 'Margin',
      title: editorMarginTitle.value,
      value: storedEditorMargin(configStore.config.display, editorAreaSplit.value),
      maximum: editorMarginDragLimit,
      onDrag: handleEditorMarginDrag,
      disabled: distractionFree.value
    },
    {
      // Zettlr-LYH: the only spacer of the toolbar. It takes up all remaining
      // width and pushes MD → PPTX, its Pandoc group, JEV Search and Toggle
      // Sidebar to the right end
      type: 'spacer',
      id: 'spacer-expand',
      size: '1x'
    },
    // Zettlr-LYH (R58): the Pomodoro ring, the background task indicator and
    // the icon toggle of the sidebar are gone from the toolbar; the sidebar
    // switch is the Toggle Sidebar text button at the right end instead
    {
      type: 'button',
      id: 'toggle-pptx-preview',
      title: 'Toggle the PPTX preview of the current Markdown document',
      buttonText: 'MD → PPTX',
      icon: '',
      pressed: activeFileHasPptxPreview.value,
      class: activeFileHasPptxPreview.value ? 'toolbar-text-button pptx-preview-button active' : 'toolbar-text-button pptx-preview-button'
    },
    {
      type: 'button',
      id: 'insertPandocDiv',
      title: 'Wrap the selection in a Pandoc fenced div with an identifier, classes and attributes',
      buttonText: 'Insert Div',
      icon: '',
      class: 'toolbar-text-button pandoc-insert-button',
      visible: activeFileHasPptxPreview.value && getToolbarButtonDisplay('showPandocDivSpanButton')
    },
    {
      type: 'button',
      id: 'insertPandocSpan',
      title: 'Wrap the selection in a Pandoc bracketed span with an identifier, classes and attributes',
      buttonText: 'Insert Span',
      icon: '',
      class: 'toolbar-text-button pandoc-insert-button',
      visible: activeFileHasPptxPreview.value && getToolbarButtonDisplay('showPandocDivSpanButton')
    },
    {
      type: 'button',
      id: 'markdownPandocColumns',
      title: 'Split the selection into a two-column fenced div for slides (text on the left, image lines on the right)',
      buttonText: 'Insert Two Columns',
      icon: '',
      class: 'toolbar-text-button pandoc-columns-button',
      visible: activeFileHasPptxPreview.value
    },
    {
      type: 'button',
      id: 'pandocAttributes',
      title: 'Toggle the panel that edits the Pandoc attributes of the text, image, table, block and page at the cursor',
      buttonText: 'Attributes',
      icon: '',
      pressed: windowStateStore.pandocAttributesPanelOpen,
      class: windowStateStore.pandocAttributesPanelOpen ? 'toolbar-text-button pandoc-columns-button active' : 'toolbar-text-button pandoc-columns-button',
      visible: activeFileHasPptxPreview.value
    },
    {
      type: 'button',
      id: 'toggle-pptx-sync-scroll',
      title: 'Scroll the Markdown editor and its PPTX preview together',
      buttonText: 'Sync Scroll',
      icon: '',
      pressed: pptxSyncScrollEnabled.value,
      class: pptxSyncScrollEnabled.value ? 'toolbar-text-button pptx-sync-scroll-button active' : 'toolbar-text-button pptx-sync-scroll-button',
      visible: activeFileHasPptxPreview.value
    },
    {
      type: 'button',
      id: 'export-pandoc',
      title: pptxExportMessage.value !== ''
        ? pptxExportMessage.value
        : 'Save the document, then convert it with the conversion script into a PPTX next to it',
      buttonText: pptxExportRunning.value ? 'Exporting…' : 'Export to PPTX',
      icon: '',
      class: 'toolbar-text-button pandoc-export-button',
      visible: activeFileHasPptxPreview.value
    },
    {
      // The outcome of the last export; the button's tooltip carries the full
      // text, which is longer than the toolbar can show.
      type: 'text',
      id: 'pandoc-export-status',
      align: 'left',
      content: pptxExportMessage.value,
      visible: activeFileHasPptxPreview.value && pptxExportMessage.value !== ''
    },
    {
      // Sets the JEV Search switch apart from the Pandoc group (R53); a
      // separator line instead of a spacer since Zettlr-LYH moved the whole
      // group to the right end
      type: 'separator',
      id: 'separator-before-jev-search'
    },
    {
      type: 'button',
      id: 'toggle-jev-search',
      title: 'Toggle the JEV Search panel, which finds the passages of the current document that match a description',
      buttonText: 'JEV Search',
      icon: '',
      pressed: windowStateStore.jevSearchPanelOpen,
      class: windowStateStore.jevSearchPanelOpen ? 'toolbar-text-button jev-search-button active' : 'toolbar-text-button jev-search-button'
    },
    {
      // Zettlr-LYH (R58): checkable text button that shows or hides the
      // sidebar, touching the JEV Search switch at the right end
      type: 'button',
      id: 'toggle-sidebar',
      title: trans('Toggle Sidebar'),
      buttonText: 'Toggle Sidebar',
      icon: '',
      pressed: sidebarVisible.value,
      joinPrevious: true,
      class: sidebarVisible.value ? 'toolbar-text-button sidebar-toggle-button active' : 'toolbar-text-button sidebar-toggle-button'
    }
  ] satisfies ToolbarControl[]
})

const editorSidebarSplitComponent = ref<typeof SplitView|null>(null)
const fileManagerSplitComponent = ref<typeof SplitView|null>(null)
const globalSearchComponent = ref<typeof GlobalSearch|null>(null)
const paneConfiguration = computed(() => documentTreeStore.paneStructure)
const lastLeafId = computed(() => documentTreeStore.lastLeafId)
const distractionFree = computed<boolean>(() => windowStateStore.distractionFreeMode !== undefined)
// The JEV Search panel (R53) hides in distraction free mode like the other
// side panels and comes back afterwards, since its open state is kept
const showJevSearchPanel = computed<boolean>(() => windowStateStore.jevSearchPanelOpen && !distractionFree.value)

watch(showJevSearchPanel, (isShown) => {
  if (!isShown) {
    highlightJevSearchHit(null)
    // No viewer shows the empty path, so every viewer removes the highlight
    // (only if the panel placed it, R61)
    relayJevSearchPdfRequest({ filePath: '', location: null })
  }
})

watch(sidebarVisible, (newValue) => {
  if (newValue) {
    if (distractionFree.value) {
      if (windowStateStore.distractionFreeMode !== undefined) {
        windowStateStore.distractionFreeMode = undefined
      }
    }

    editorSidebarSplitComponent.value?.unhide()
  } else {
    editorSidebarSplitComponent.value?.hideView(2)
  }
})

watch(fileManagerVisible, (newValue) => {
  if (newValue) {
    if (distractionFree.value) {
      if (windowStateStore.distractionFreeMode !== undefined) {
        windowStateStore.distractionFreeMode = undefined
      }
    }

    fileManagerSplitComponent.value?.unhide()
  } else {
    fileManagerSplitComponent.value?.hideView(1)
  }
})

watch(mainSplitViewVisibleComponent, (newValue) => {
  if (newValue === 'globalSearch') {
    // The global search just became visible, so focus the query input
    nextTick().then(() => {
      globalSearchComponent.value?.focusQueryInput()
    }).catch(e => console.error(e))
  }
})

watch(distractionFree, (newValue) => {
  if (newValue) {
    // Enter distraction free mode
    sidebarsBeforeDistractionfree.value = {
      fileManager: fileManagerVisible.value,
      sidebar: sidebarVisible.value
    }
    configStore.setConfigValue('window.sidebarVisible', false)
    configStore.setConfigValue('window.fileManagerVisible', false)
  } else {
    // Leave distraction free mode
    configStore.setConfigValue('window.sidebarVisible', sidebarsBeforeDistractionfree.value.sidebar)
    configStore.setConfigValue('window.fileManagerVisible', sidebarsBeforeDistractionfree.value.fileManager)
  }
})

// Zettlr-LYH: The callbacks that stop the listeners which this component
// registers on the main process's channels once it is mounted. They are called
// before the component is unmounted. Without that, every hot module
// replacement during development leaves the listeners of the replaced version
// of this component behind, and those keep answering every event with the code
// of that old version.
let stopShortcutListener: (() => void)|undefined
let stopUpdateProviderListener: (() => void)|undefined
let stopDocumentsUpdateListener: (() => void)|undefined

onMounted(() => {
  exportButton.value = document.querySelector('#toolbar-export')
  statsButton.value = document.querySelector('#toolbar-show-stats')
  tagsButton.value = document.querySelector('#toolbar-show-tag-cloud')
  tableButton.value = document.querySelector('#toolbar-insert-table')
  docInfoButton.value = document.querySelector('#toolbar-document-info')
  pomodoroButton.value = document.querySelector('#toolbar-pomodoro')
  tasksButton.value = document.querySelector('#toolbar-long-running-tasks')

  stopShortcutListener = ipcRenderer.on('shortcut', (event, shortcut) => {
    if (shortcut === 'toggle-sidebar') {
      configStore.setConfigValue('window.sidebarVisible', !sidebarVisible.value)
    } else if (shortcut === 'insert-id') {
      editorCommands.value.data = generateId(configStore.config.zkn.idGen)
      editorCommands.value.replaceSelection = !editorCommands.value.replaceSelection
    } else if (shortcut === 'copy-current-id' && documentTreeStore.lastLeafActiveFile !== undefined) {
      ipcRenderer.invoke('fsal', {
        command: 'get-descriptor',
        payload: documentTreeStore.lastLeafActiveFile.path
      })
        .then((descriptor: AnyDescriptor|undefined) => {
          if (descriptor?.type === 'file' && descriptor?.id !== '') {
            navigator.clipboard.writeText(descriptor.id).catch(err => console.error(err))
          }
        })
        .catch(err => console.error(err))
    } else if (shortcut === 'global-search') {
      configStore.setConfigValue('window.fileManagerVisible', true)
      mainSplitViewVisibleComponent.value = 'globalSearch'
      // Focus input
      nextTick()
        .then(() => { globalSearchComponent.value?.focusQueryInput() })
        .catch(err => console.error(err))
    } else if (shortcut === 'toggle-file-manager') {
      if (fileManagerVisible.value && mainSplitViewVisibleComponent.value === 'fileManager') {
        configStore.setConfigValue('window.fileManagerVisible', false)
      } else if (!fileManagerVisible.value) {
        configStore.setConfigValue('window.fileManagerVisible', true)
        mainSplitViewVisibleComponent.value = 'fileManager'
      } else if (mainSplitViewVisibleComponent.value === 'globalSearch') {
        mainSplitViewVisibleComponent.value = 'fileManager'
      }
    } else if (shortcut === 'filter-files') {
      // We need to immediately make the file manager visible, which will
      // -- in the next tick -- focus its filter input.
      configStore.setConfigValue('window.fileManagerVisible', true)
      mainSplitViewVisibleComponent.value = 'fileManager'
    } else if (shortcut === 'export') {
      showExportPopover.value = true
    } else if (shortcut === 'print') {
      if (activeFile.value !== undefined) {
        ipcRenderer.invoke('application', { command: 'print', payload: activeFile.value.path })
          .catch(err => console.error(err))
      }
    } else if (shortcut === 'export-html') {
      if (activeFile.value !== undefined && hasMarkdownExt(activeFile.value.path)) {
        exportToHTMLAndShow(activeFile.value.path).catch(err => console.error(err))
      }
    } else if (shortcut === 'navigate-back') {
      ipcRenderer.invoke('documents-provider', {
        command: 'navigate-back',
        payload: {
          windowId,
          leafId: lastLeafId.value
        }
      } as DocumentManagerIPCAPI).catch(err => console.error(err))
    } else if (shortcut === 'navigate-forward') {
      ipcRenderer.invoke('documents-provider', {
        command: 'navigate-forward',
        payload: {
          windowId,
          leafId: lastLeafId.value
        }
      } as DocumentManagerIPCAPI).catch(err => console.error(err))
    } else if (shortcut === 'split-editor-right') {
      splitEditor('right')
    } else if (shortcut === 'split-editor-down') {
      splitEditor('down')
    } else if (shortcut === 'windows-manager') {
      // Zettlr-LYH Windows dialog (R72)
      showWindowsManager.value = true
    }
  })

  // Initially, we need to hide the sidebar, since the view will be visible
  // by default.
  if (!sidebarVisible.value) {
    editorSidebarSplitComponent.value?.hideView(2)
  }

  // Similarly, if the file manager is set to hidden, do that, too.
  if (!fileManagerVisible.value) {
    fileManagerSplitComponent.value?.hideView(1)
  }

  // Check if there is an update available.
  ipcRenderer.invoke('update-provider', { command: 'update-status' })
    .then((state: UpdateState) => {
      isUpdateAvailable.value = state.updateAvailable
    })
    .catch(err => console.error(err))

  // Also, listen for any changes in the update available state
  stopUpdateProviderListener = ipcRenderer.on('update-provider', (event, command: string, updateState: UpdateState) => {
    if (command === 'state-changed') {
      isUpdateAvailable.value = updateState.updateAvailable
    }
  })

  // Zettlr-LYH disk conflicts (R138): the main process opens a comparison for
  // a file that changed on disk while the editor holds unsaved changes, tells
  // it when the disk changed again meanwhile, and reloads the editors when a
  // comparison has been committed. The event names are typed as strings
  // because the two newest ones are written as the literal values of the
  // specification.
  stopDocumentsUpdateListener = ipcRenderer.on('documents-update', (event, payload: { event: string, context: DocumentsUpdateContext|undefined }) => {
    handleConflictMergeEvent(payload.event, payload.context)
    forgetColumnWidthsOfClosedFile(payload.event, payload.context)
  })
  // Register the listener first: a slow snapshot must never undo a live event.
  ipcRenderer.invoke('documents-provider', { command: 'get-conflict-read-only-state', payload: undefined } as DocumentManagerIPCAPI)
    .then((snapshot: unknown) => {
      // The running development main process may predate this renderer HMR.
      // Its switch returns undefined for the new command. Preserve the former
      // local protection until the next complete application restart.
      if (snapshot === undefined) { conflictReadOnlyState.value.markUnsupported() } else { applyConflictReadOnlySnapshot(snapshot) }
    })
    .catch(err => {
      if (isUnsupportedConflictReadOnlyCommand(err)) { conflictReadOnlyState.value.markUnsupported() } else { console.error('Could not restore conflict protection', err) }
    })
})

/**
 * Whether a file is open in any pane of a document tree.
 *
 * @param   {LeafNodeJSON|BranchNodeJSON}  tree      The tab tree of a window
 * @param   {string}                       filePath  The file's path
 *
 * @return  {boolean}                                True if some pane holds a tab of the file
 */
function treeHoldsFile (tree: LeafNodeJSON|BranchNodeJSON, filePath: string): boolean {
  if (tree.type === 'leaf') {
    return tree.openFiles.some(file => file.path === filePath)
  }
  return tree.nodes.some(child => treeHoldsFile(child, filePath))
}

/**
 * Zettlr-LYH table column widths: The widths a user has dragged table columns
 * to are remembered per document until the document's last tab in this window
 * is closed. This is called for every event of the document provider; for the
 * closing of a tab of this window it asks the main process for the window's
 * tabs (the renderer's own copy in documentTreeStore.paneData is only updated
 * after an asynchronous request of its own, so it is not ready when the event
 * arrives) and forgets the widths of the document unless another pane still
 * shows it.
 *
 * @param  {string}                            eventName  The event of the document provider
 * @param  {DocumentsUpdateContext|undefined}  context    Its context
 */
function forgetColumnWidthsOfClosedFile (eventName: string, context: DocumentsUpdateContext|undefined): void {
  if (eventName !== DP_EVENTS.CLOSE_FILE || context?.filePath === undefined || context.windowId !== windowId) {
    return
  }

  const closedPath = context.filePath
  ipcRenderer.invoke('documents-provider', { command: 'retrieve-tab-config', payload: { windowId } } as DocumentManagerIPCAPI)
    .then((tree: LeafNodeJSON|BranchNodeJSON) => {
      if (!treeHoldsFile(tree, closedPath)) {
        forgetDocumentColumnWidths(closedPath)
      }
    })
    .catch(err => console.error(err))
}

/**
 * What this window knows of its panes, for choosing the pane of a comparison.
 *
 * @return  {ConflictMergePaneSummary[]}  The panes with their open and active files
 */
function conflictMergePaneSummaries (): ConflictMergePaneSummary[] {
  return documentTreeStore.paneData.map((pane: LeafNodeJSON) => ({
    id: pane.id,
    openFiles: pane.openFiles.map(file => file.path),
    activeFile: pane.activeFile?.path
  }))
}

/**
 * Dispatches an event of the document provider that concerns the comparisons
 * (Zettlr-LYH disk conflicts, R138): a new comparison, a disk that changed
 * again during a comparison, or the reload of the editors that follows a
 * committed comparison.
 *
 * @param  {string}                          eventName  The event of the document provider
 * @param  {DocumentsUpdateContext|undefined} context   Its context
 */
function handleConflictMergeEvent (eventName: string, context: DocumentsUpdateContext|undefined): void {
  if (context?.conflictState !== undefined) {
    applyConflictReadOnlySnapshot(context.conflictState)
    return
  }
  if (context?.filePath === undefined) {
    return
  }

  if (eventName === DP_EVENTS.FILE_CONFLICT_MERGE) {
    startConflictMerge(context)
  } else if (eventName === FILE_CONFLICT_DISK_CHANGED_EVENT) {
    if (context.sessionId !== undefined) {
      refreshConflictMerge(context.filePath, context.sessionId)
    }
  } else if (eventName === DP_EVENTS.FILE_REMOTELY_CHANGED && conflictReadOnlyState.value.legacy) {
    for (const session of [ ...conflictMergeSessions.value ]) {
      if (session.filePath === context.filePath) { finishConflictMerge(session.filePath, session.sessionId) }
    }
  }
}

function applyConflictReadOnlySnapshot (snapshot: unknown): void {
  if (!conflictReadOnlyState.value.applySnapshot(snapshot)) { return }
  for (const session of [ ...conflictMergeSessions.value ]) {
    if (!conflictReadOnlyState.value.sessions.some(current => current.filePath === session.filePath && current.sessionId === session.sessionId && current.windowId === windowId)) {
      finishConflictMerge(session.filePath, session.sessionId)
    }
  }
  for (const session of conflictReadOnlyState.value.sessions) {
    startConflictMerge(session)
  }
}

/**
 * Registers the comparison of a file that was modified on disk while the
 * editor holds unsaved changes (Zettlr-LYH disk conflicts, R138) and fetches
 * its contents. The comparison view then appears in the pane the main process
 * named (or, if that pane does not hold the file, in another pane of this
 * window that does). A request that names another window is ignored.
 *
 * @param  {DocumentsUpdateContext}  context  The event context: file, window, pane and session
 */
function startConflictMerge (context: DocumentsUpdateContext): void {
  const filePath = context.filePath
  const sessionId = context.sessionId
  if (filePath === undefined || sessionId === undefined) {
    return
  }

  const panes = conflictMergePaneSummaries()
  const openFilePaths = panes.flatMap(pane => pane.openFiles)
  if (!shouldHandleConflictMerge(context.windowId, windowId, filePath, openFilePaths)) {
    return
  }

  const leafId = resolveConflictMergeLeaf(context.leafId, panes, filePath)
  if (leafId === undefined) {
    return
  }

  if (conflictMergeSessions.value.some(session => session.filePath === filePath && session.sessionId === sessionId)) {
    followConflictMergePanes()
    return
  }

  // A file has at most one comparison: a new session replaces an older one
  conflictMergeSessions.value = [
    ...conflictMergeSessions.value.filter(session => session.filePath !== filePath),
    { filePath, sessionId, windowId, leafId, contents: undefined }
  ]
  loadConflictMergeContents(filePath, sessionId)
}

/**
 * Fetches both versions of a compared file from the main process (Zettlr-LYH
 * disk conflicts, R138). The first fetch of a session creates the comparison
 * view; a later fetch hands the newest disk version to the view that already
 * exists. A reply that a newer fetch has overtaken, or that belongs to a
 * session that is over, is dropped.
 *
 * @param  {string}  filePath   The compared file
 * @param  {string}  sessionId  The session whose contents are wanted
 */
function loadConflictMergeContents (filePath: string, sessionId: string): void {
  const fetchNumber = (conflictMergeFetchCounters.get(filePath) ?? 0) + 1
  conflictMergeFetchCounters.set(filePath, fetchNumber)
  const findSession = (): ConflictMergeSession|undefined => {
    if (conflictMergeFetchCounters.get(filePath) !== fetchNumber) {
      return undefined
    }
    return conflictMergeSessions.value.find(session => session.filePath === filePath && session.sessionId === sessionId)
  }

  ipcRenderer.invoke('documents-provider', buildGetConflictMergeContentsCommand(filePath, sessionId))
    .then((contents: unknown) => {
      if (findSession() === undefined) {
        return
      }
      if (!isConflictMergeContents(contents) || contents.sessionId !== sessionId) {
        console.warn(`Conflict merge: received no contents for ${filePath}, not showing the comparison view`)
        if (conflictReadOnlyState.value.legacy) { finishConflictMerge(filePath, sessionId) }
        return
      }
      storeConflictMergeContents(filePath, sessionId, contents)
    })
    .catch(err => {
      console.error(err)
      // An unavailable view cannot release the main process's read-only guard.
    })
}

/**
 * Puts the fetched contents into the session.
 *
 * @param  {string}                filePath   The compared file
 * @param  {string}                sessionId  The session
 * @param  {ConflictMergeContents} contents   The versions the main process returned
 */
function storeConflictMergeContents (filePath: string, sessionId: string, contents: ConflictMergeContents): void {
  conflictMergeSessions.value = conflictMergeSessions.value.map(session => {
    return session.filePath === filePath && session.sessionId === sessionId ? { ...session, contents } : session
  })
}

/**
 * Fetches the contents of a running comparison again, because the disk
 * changed again (Zettlr-LYH disk conflicts, R138) or because the view asked
 * for them. Does nothing for a session that this window does not hold.
 *
 * @param  {string}  filePath   The compared file
 * @param  {string}  sessionId  The session
 */
function refreshConflictMerge (filePath: string, sessionId: string): void {
  if (conflictMergeSessions.value.some(session => session.filePath === filePath && session.sessionId === sessionId)) {
    loadConflictMergeContents(filePath, sessionId)
  }
}

/**
 * Removes the local comparison view. Original editors remain protected until
 * the authority snapshot ends the session. Does nothing if this is not the one
 * that this window holds for the file, so that a late message of an old
 * session cannot end a newer one.
 *
 * @param  {string}  filePath   The compared file
 * @param  {string}  sessionId  The session that is over
 */
function finishConflictMerge (filePath: string, sessionId: string): void {
  if (!conflictMergeSessions.value.some(session => session.filePath === filePath && session.sessionId === sessionId)) {
    return
  }
  conflictMergeSessions.value = conflictMergeSessions.value.filter(session => session.filePath !== filePath)
  conflictMergeFetchCounters.delete(filePath)
}

/**
 * Keeps every comparison in a pane that holds its file: a tab that moved to
 * another pane takes the comparison along. A missing pane parks the view until
 * a replacement pane appears or the authority ends the session.
 */
function followConflictMergePanes (): void {
  if (documentTreeStore.paneData.length === 0) {
    return
  }

  for (const session of conflictReadOnlyState.value.sessions) {
    if (session.windowId === windowId && !conflictMergeSessions.value.some(current => current.sessionId === session.sessionId)) {
      startConflictMerge(session)
    }
  }

  const panes = conflictMergePaneSummaries()
  for (const session of [ ...conflictMergeSessions.value ]) {
    const leafId = resolveConflictMergeLeaf(session.leafId, panes, session.filePath)
    if (leafId === undefined && conflictReadOnlyState.value.legacy) {
      finishConflictMerge(session.filePath, session.sessionId)
    } else if (leafId !== undefined && leafId !== session.leafId) {
      conflictMergeSessions.value = conflictMergeSessions.value.map(other => {
        return other.filePath === session.filePath && other.sessionId === session.sessionId ? { ...other, leafId } : other
      })
    }
  }
}

function fileManagerSplitComponentResized (sizes: [number, number]): void {
  configStore.setConfigValue('ui.fileManagerSplitSize', sizes)
}

function editorSidebarSplitComponentResized (sizes: [number, number]): void {
  configStore.setConfigValue('ui.editorSidebarSplitSize', sizes)
}

function insertTable (spec: { rows: number, cols: number }): void {
  // Generate a simple table based on the info, and insert it.
  const align: Array<'center'|'left'|'right'|null> = Array(spec.cols).fill(null)
  const row = (): string[] => Array(spec.cols).fill('')
  const ast: string[][] = Array.from({ length: spec.rows }, row)

  editorCommands.value.data = buildPipeMarkdownTable(ast, align)
  editorCommands.value.replaceSelection = !editorCommands.value.replaceSelection
}

function insertPandoc (spec: { type: string, attributes: string }): void {
  editorCommands.value.data = spec
  editorCommands.value.insertPandoc = !editorCommands.value.insertPandoc
}

function genericJtl (lineNumber: number): void {
  // This function is called from the sidebar where we already know the file
  // is open (because its editor component has provided the table of
  // contents in the first place).
  const doc = documentTreeStore.lastLeafActiveFile
  if (doc !== undefined) {
    // Zettlr-LYH: only the active pane jumps, even if other panes show the
    // same file (R113), and the heading goes to the reading line at one third
    // of the visible height, so that it is the highlighted entry (R112)
    editorCommands.value.data = {
      filePath: doc.path,
      lineNumber,
      leafId: documentTreeStore.lastLeafId,
      position: 'reading-line'
    }
    editorCommands.value.jumpToLine = !editorCommands.value.jumpToLine
  }
}

function jtl (filePath: string, lineNumber: number, newTab: boolean): void {
  // We need to make sure the given file is (a) open somewhere and (b) the
  // active file.

  // Simplest case: The file is already active somewhere
  const activeFileLeaf = documentTreeStore.paneData
    .find((pane: LeafNodeJSON) => pane.activeFile?.path === filePath)
  if (activeFileLeaf !== undefined) {
    // There is at least one leaf with the given file being active, so we
    // can simply emit the event
    editorCommands.value.data = { filePath, lineNumber }
    editorCommands.value.jumpToLine = !editorCommands.value.jumpToLine
    return
  }

  const WAIT_TIME = 100 // How long to wait before re-executing the jtl()

  // Next, let's see if the file is at least open somewhere
  const containingLeaf = documentTreeStore.paneData
    .find((pane: LeafNodeJSON) => {
      return pane.openFiles.find(doc => doc.path === filePath) !== undefined
    })
  if (containingLeaf !== undefined) {
    // Let's first make it the active file and then execute the command
    ipcRenderer.invoke('documents-provider', {
      command: 'open-file',
      payload: { path: filePath, windowId, leafId: containingLeaf.id }
    } as DocumentManagerIPCAPI)
      .then(() => {
        // Re-execute the jtl command
        setTimeout(() => jtl(filePath, lineNumber, newTab), WAIT_TIME)
      })
      .catch(e => console.error(e))
    return
  }

  // If we're here, the file was not open, so we have to do that first. At
  // least this both makes it an open file AND an active file somewhere in
  // the window.
  ipcRenderer.invoke('documents-provider', {
    command: 'open-file',
    payload: {
      path: filePath,
      windowId,
      leafId: lastLeafId.value,
      newTab
    }
  } as DocumentManagerIPCAPI)
    .then(() => {
      // Re-execute the jtl command
      setTimeout(() => jtl(filePath, lineNumber, newTab), WAIT_TIME)
    })
    .catch(e => console.error(e))
}

/**
 * Has the editors show the hit picked in the JEV Search panel, or remove the
 * highlight (Zettlr-LYH JEV Search, R53).
 *
 * @param   {JevSearchHighlightRequest}  request  The hit's range, or null
 */
function highlightJevSearchHit (request: JevSearchHighlightRequest): void {
  editorCommands.value.data = request
  editorCommands.value.jevSearchHighlight = !editorCommands.value.jevSearchHighlight
}

// True while the PDF viewers' location highlight comes from the JEV Search
// panel (R61); any other sender of a location request sets it to false, so
// that the panel never removes a highlight it did not place
let pdfHighlightFromJevSearch = false

// Counts the PDF location requests sent, for lastPdfViewerRequest
let pdfViewerRequestSequence = 0

/**
 * Sends a location request to the PDF viewers (contract C5): the viewer that
 * shows the request's file as the active file of the last focused leaf
 * scrolls to the location and highlights it, every other viewer removes its
 * highlight; a null location only removes it. The sender of every location
 * request, e.g. following a link into a PDF (R60) or a JEV Search hit (R61).
 * The request is also kept as lastPdfViewerRequest, which a viewer that
 * finishes loading the file only afterwards carries out (viewer-request.ts).
 *
 * @param   {PdfViewerRequest}  request        The request
 * @param   {boolean}           fromJevSearch  True when the JEV Search panel
 *                                             sends it; leave out otherwise
 */
function requestPdfViewer (request: PdfViewerRequest, fromJevSearch = false): void {
  pdfHighlightFromJevSearch = fromJevSearch && request.location !== null
  pdfViewerRequestSequence++
  editorCommands.value.lastPdfViewerRequest = { request, sequence: pdfViewerRequestSequence, time: Date.now() }
  editorCommands.value.data = request
  editorCommands.value.pdfViewerRequest = !editorCommands.value.pdfViewerRequest
}

/**
 * Relays the location requests of the JEV Search panel (R61) to the PDF
 * viewers. A request to remove the highlight is dropped when the current
 * highlight was placed by someone else.
 *
 * @param   {PdfViewerRequest}  request  The panel's request
 */
function relayJevSearchPdfRequest (request: PdfViewerRequest): void {
  if (request.location === null && !pdfHighlightFromJevSearch) {
    return
  }
  requestPdfViewer(request, true)
}

/**
 * Relays the location requests that the editor sends after it opened a PDF
 * from a link (R60) to the PDF viewers.
 *
 * @param   {Event}  event  The PDF_LINK_LOCATE_EVENT
 */
function relayPdfLinkLocateRequest (event: Event): void {
  const { filePath, location, sourceText } = (event as CustomEvent<PdfLinkLocateDetail>).detail
  requestPdfViewer({ filePath, location, sourceText })
}

// File paths of notes are compared without regard to case where the file
// system ignores it
const NOTE_PATHS_IGNORE_CASE = process.platform === 'win32' || process.platform === 'darwin'

// How long to wait for the panes to show a change made through the documents
// provider, and when to send the jump to the note's line once it is shown:
// a freshly mounted editor loads its contents asynchronously and ignores a
// line beyond its (still empty) document, so the jump is sent once more
const PDF_BACKLINK_LAYOUT_TIMEOUT = 5000
const PDF_BACKLINK_JUMP_DELAYS = [ 100, 600 ]

// True while a note is being opened from a backlink, so that a second double
// click cannot split the PDF's pane twice
let pdfBacklinkOpening = false

/**
 * Waits until the panes of the window, as the renderer knows them, fulfil a
 * condition
 *
 * @param   {Function}  condition  Checked against documentTreeStore.paneData
 *
 * @return  {Promise<void>}        Rejects after PDF_BACKLINK_LAYOUT_TIMEOUT
 */
async function waitForPanes (condition: (panes: LeafNodeJSON[]) => boolean): Promise<void> {
  if (condition(documentTreeStore.paneData)) {
    return
  }

  await new Promise<void>((resolve, reject) => {
    const stopWatching = watch(() => documentTreeStore.paneData, (panes: LeafNodeJSON[]) => {
      if (condition(panes)) {
        clearTimeout(timeout)
        stopWatching()
        resolve()
      }
    }, { deep: true })
    const timeout = setTimeout(() => {
      stopWatching()
      reject(new Error('Timed out waiting for the editor panes to update.'))
    }, PDF_BACKLINK_LAYOUT_TIMEOUT)
  })
}

/**
 * Opens the note of a backlink the PDF viewer reports (contract C11, section
 * "双击跳回笔记") and jumps to the link's line. The note goes into the pane
 * other than the PDF's that already holds it, or else into the first pane
 * other than the PDF's; with the PDF's pane alone, a new pane is split off to
 * its right (as Split Editor Right does). The PDF is never replaced.
 *
 * @param   {PdfBacklinkOpenDetail}  detail  The note, its line and the PDF's pane
 */
async function openPdfBacklinkNote (detail: PdfBacklinkOpenDetail): Promise<void> {
  const { notePath, lineNumber, pdfLeafId } = detail
  const isNote = (path: string): boolean => isSamePdfFilePath(path, notePath, NOTE_PATHS_IGNORE_CASE)

  const otherPanes = documentTreeStore.paneData.filter((pane: LeafNodeJSON) => pane.id !== pdfLeafId)
  const holdingPane = otherPanes.find((pane: LeafNodeJSON) => pane.openFiles.some(file => isNote(file.path)))
  // The path as the pane holds it, so that it is not opened a second time
  // under another spelling
  const openPath = holdingPane?.openFiles.find(file => isNote(file.path))?.path ?? notePath
  let targetLeafId: string|undefined = holdingPane?.id ?? otherPanes[0]?.id

  if (targetLeafId === undefined) {
    const readPanes = async (): Promise<LeafNodeJSON[]> => splitEditorPanes(await ipcRenderer.invoke('documents-provider', {
      command: 'retrieve-tab-config', payload: { windowId }
    } as DocumentManagerIPCAPI) as BranchNodeJSON|LeafNodeJSON)

    const leafIdsBefore = new Set((await readPanes()).map(pane => pane.id))
    const { direction, insertion } = splitPlacement('right')
    await ipcRenderer.invoke('documents-provider', {
      command: 'split-leaf',
      payload: { originWindow: windowId, originLeaf: pdfLeafId, direction, insertion }
    } as DocumentManagerIPCAPI)

    targetLeafId = (await readPanes()).find(pane => !leafIdsBefore.has(pane.id))?.id
    if (targetLeafId === undefined) {
      throw new Error(`Could not split the pane of the PDF to open ${notePath}.`)
    }
    const newLeafId = targetLeafId
    await waitForPanes(panes => panes.some(pane => pane.id === newLeafId))
  }

  const leafId = targetLeafId
  const opened = await ipcRenderer.invoke('documents-provider', {
    command: 'open-file',
    payload: { windowId, leafId, path: openPath, newTab: true }
  } as DocumentManagerIPCAPI)
  if (opened !== true) {
    throw new Error(`Could not open ${openPath} next to the PDF.`)
  }

  await waitForPanes(panes => panes.some(pane => pane.id === leafId && pane.activeFile !== null && isNote(pane.activeFile.path)))
  const activePath = documentTreeStore.paneData.find((pane: LeafNodeJSON) => pane.id === leafId)?.activeFile?.path ?? openPath

  for (const delay of PDF_BACKLINK_JUMP_DELAYS) {
    setTimeout(() => {
      // Only while the note is still shown in that pane
      const pane = documentTreeStore.paneData.find((leaf: LeafNodeJSON) => leaf.id === leafId)
      if (pane?.activeFile?.path === activePath) {
        // Spec C11: jump to the start of the line without selecting it
        editorCommands.value.data = { filePath: activePath, lineNumber, cursorOnly: true }
        editorCommands.value.jumpToLine = !editorCommands.value.jumpToLine
      }
    }, delay)
  }
}

/**
 * Handles the PDF viewers' PDF_BACKLINK_OPEN_EVENT
 *
 * @param   {Event}  event  The event, with a PdfBacklinkOpenDetail
 */
function handlePdfBacklinkOpen (event: Event): void {
  if (pdfBacklinkOpening) {
    return
  }

  pdfBacklinkOpening = true
  openPdfBacklinkNote((event as CustomEvent<PdfBacklinkOpenDetail>).detail)
    .catch((error: unknown) => console.error('Could not open the note of a PDF backlink', error))
    .finally(() => { pdfBacklinkOpening = false })
}

onMounted(() => {
  window.addEventListener(PDF_LINK_LOCATE_EVENT, relayPdfLinkLocateRequest)
  window.addEventListener(PDF_BACKLINK_OPEN_EVENT, handlePdfBacklinkOpen)
})

onBeforeUnmount(() => {
  window.removeEventListener(PDF_LINK_LOCATE_EVENT, relayPdfLinkLocateRequest)
  window.removeEventListener(PDF_BACKLINK_OPEN_EVENT, handlePdfBacklinkOpen)
  stopShortcutListener?.()
  stopUpdateProviderListener?.()
  stopDocumentsUpdateListener?.()
})

function moveSection (data: { from: number, to: number }): void {
  editorCommands.value.data = { from: data.from, to: data.to }
  editorCommands.value.moveSection = !editorCommands.value.moveSection
}

function startGlobalSearch (terms: string): void {
  mainSplitViewVisibleComponent.value = 'globalSearch'
  configStore.setConfigValue('window.fileManagerVisible', true)
  nextTick()
    .then(() => {
      globalSearchComponent.value?.startSearch(terms)
    })
    .catch(err => console.error(err))
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function toggleFileList (): void {
  // This event can be used by various components to ask the file manager to
  // toggle its file list visibility
  fileManagerSplitComponent.value?.toggleFileList()
}

const runSplitEditorOperation = createSplitEditorOperation({
  windowId,
  readPanes: async () => splitEditorPanes(await ipcRenderer.invoke('documents-provider', {
    command: 'retrieve-tab-config', payload: { windowId }
  }) as BranchNodeJSON|LeafNodeJSON),
  focusedLeafId: () => lastLeafId.value,
  invoke: async command => await ipcRenderer.invoke('documents-provider', command),
  fileExists: async path => {
    const result = await ipcRenderer.invoke('application', {
      command: 'check-path-kinds', payload: { paths: [path] }
    }) as CheckPathKindsResult
    if ('error' in result || result.kinds[path] === undefined || result.kinds[path] === 'unknown') {
      throw new Error(`Could not check whether a saved split editor file still exists: ${path}`)
    }
    return result.kinds[path] === 'file'
  },
  capturePaneState: pane => {
    captureWindowEditorReadingStates(windowId)
    return new Map([...editorPaneReadingStates(windowId, pane.id)].map(([ path, state ]) => [ path, { ...state }]))
  },
  restorePaneState: (states, leafId) => {
    const destination = editorPaneReadingStates(windowId, leafId)
    destination.clear()
    for (const [ path, state ] of states) {
      destination.set(path, { ...state })
    }
  },
  confirmLayout: async leafIds => {
    const matches = (): boolean => {
      const currentIds = documentTreeStore.paneData.map((pane: LeafNodeJSON) => pane.id)
      return currentIds.length === leafIds.length && currentIds.every((id: string, index: number) => id === leafIds[index])
    }
    if (matches()) {
      await nextTick()
      return
    }
    await new Promise<void>((resolve, reject) => {
      const stopWatching = watch(() => documentTreeStore.paneData.map((pane: LeafNodeJSON) => pane.id), () => {
        if (matches()) {
          clearTimeout(timeout)
          stopWatching()
          resolve()
        }
      })
      const timeout = setTimeout(() => {
        stopWatching()
        reject(new Error('Timed out waiting for the split editor layout.'))
      }, 5000)
    })
    await nextTick()
  }
})

/** Right toggles one/two panes; Down retains its existing split behavior. */
function splitEditor (side: SplitSide): void {
  runSplitEditorOperation(side).catch(err => console.error(err))
}

/**
 * Zettlr-LYH (R174, R131): a color was chosen in a panel of the formatting bar.
 * The request goes to the last focused editor (MainEditor.vue), which colors its
 * selection and takes the focus back, like the markdown commands of handleClick.
 *
 * @param  {FormattingColorRequest}  request  The property to color and the color
 *                                            (null removes the color)
 */
function handleFormattingColor (request: FormattingColorRequest): void {
  editorCommands.value.data = request
  editorCommands.value.applyTextColor = !editorCommands.value.applyTextColor
}

function handleClick (clickedID?: string): void {
  if (clickedID === 'root-open-workspaces') {
    ipcRenderer.invoke('application', { command: 'root-open-workspaces' })
      .catch(e => console.error(e))
  } else if (clickedID === 'split-editor-right') {
    splitEditor('right')
  } else if (clickedID === 'open-preferences') {
    ipcRenderer.invoke('application', { command: 'open-preferences' })
      .catch(e => console.error(e))
  } else if (clickedID === 'new-file') {
    ipcRenderer.invoke('application', { command: 'file-new', payload: { type: DocumentType.Markdown } })
      .catch(e => console.error(e))
  } else if (clickedID === 'previous-file') {
    ipcRenderer.invoke('documents-provider', {
      command: 'navigate-back',
      payload: {
        windowId,
        leafId: lastLeafId.value
      }
    } as DocumentManagerIPCAPI).catch(err => console.error(err))
  } else if (clickedID === 'next-file') {
    ipcRenderer.invoke('documents-provider', {
      command: 'navigate-forward',
      payload: {
        windowId,
        leafId: lastLeafId.value
      }
    } as DocumentManagerIPCAPI).catch(err => console.error(err))
  } else if (clickedID === 'export') {
    if (activeFile.value !== undefined && hasMarkdownExt(activeFile.value.path)) {
      exportToHTMLAndShow(activeFile.value.path).catch(err => console.error(err))
    } else {
      showExportPopover.value = !showExportPopover.value
    }
  } else if (clickedID === 'toggle-pptx-preview') {
    // Only Markdown files can be previewed; ignore the click otherwise
    const filePath = activeFile.value?.path
    if (filePath !== undefined && hasMarkdownExt(filePath)) {
      windowStateStore.togglePptxPreview(filePath)
    }
  } else if (clickedID === 'toggle-pptx-sync-scroll') {
    // Read by every PPTX preview pane of this window (see pptx-preview-link)
    pptxSyncScrollEnabled.value = !pptxSyncScrollEnabled.value
  } else if (clickedID === 'toggle-edit-code-when-clicked') {
    if (!configStore.setConfigValue('display.editCodeWhenClicked', !configStore.config.display.editCodeWhenClicked)) {
      ipcRenderer.send('renderer-runtime-error', {
        kind: 'error',
        message: 'Could not save Auto Show Code. The setting was not changed.',
        source: 'Main toolbar',
        userNotice: true
      })
    }
  } else if (clickedID === 'toggle-track-changes') {
    // Zettlr-LYH (R84): turning Track Changes on requires an author name; if
    // none is set yet, ask for it first (confirmRevisionAuthor turns it on)
    const enable = !configStore.config.editor.trackChanges
    if (enable && (configStore.config.editor.revisionAuthor ?? '').trim() === '') {
      showRevisionAuthorDialog.value = true
    } else if (!configStore.setConfigValue('editor.trackChanges', enable)) {
      ipcRenderer.send('renderer-runtime-error', {
        kind: 'error',
        message: 'Could not save Track Changes. The setting was not changed.',
        source: 'Main toolbar',
        userNotice: true
      })
    }
  } else if (clickedID === 'toggle-show-revisions') {
    if (!configStore.setConfigValue('display.showRevisions', !configStore.config.display.showRevisions)) {
      ipcRenderer.send('renderer-runtime-error', {
        kind: 'error',
        message: 'Could not save Show Revisions. The setting was not changed.',
        source: 'Main toolbar',
        userNotice: true
      })
    }
  } else if (clickedID === 'show-stats') {
    // The user wants to display the stats
    showStatsPopover.value = !showStatsPopover.value
  } else if (clickedID === 'show-tag-cloud') {
    showTagsPopover.value = !showTagsPopover.value
    // TODO startGlobalSearch('#' + data.searchForTag)
    // editorCommands.value.data = data.suggestions
    // editorCommands.value.addKeywords = !editorCommands.value.addKeywords
  } else if (clickedID === 'pomodoro') {
    showPomodoroPopover.value = !showPomodoroPopover.value
  } else if (clickedID === 'insert-table') {
    // Display the insertion popover
    showTablePopover.value = !showTablePopover.value
  } else if (clickedID === 'long-running-tasks') {
    // The tasks button is only mounted conditionally
    tasksButton.value = document.querySelector('#toolbar-long-running-tasks')
    showTasksPopover.value = !showTasksPopover.value
  } else if (clickedID === 'document-info') {
    showDocInfoPopover.value = !showDocInfoPopover.value
  } else if (clickedID === 'insertPandocDiv' || clickedID === 'insertPandocSpan') {
    pandocPopoverType.value = clickedID === 'insertPandocDiv' ? 'div' : 'span'
    pandocButton.value = document.querySelector(`#toolbar-${clickedID}`)
    showPandocPopover.value = !showPandocPopover.value
  } else if (clickedID === 'pandocAttributes') {
    // Checkable button: toggles the persistent attribute panel (R22), which
    // the last focused Markdown editor renders while the state is on
    windowStateStore.pandocAttributesPanelOpen = !windowStateStore.pandocAttributesPanelOpen
  } else if (clickedID === 'toggle-jev-search') {
    // Checkable button: shows or hides the JEV Search panel (R53) to the
    // right of the editor area
    windowStateStore.jevSearchPanelOpen = !windowStateStore.jevSearchPanelOpen
  } else if (clickedID === 'toggle-sidebar') {
    // Checkable button (R58): shows or hides the sidebar, like the shortcut
    configStore.setConfigValue('window.sidebarVisible', !sidebarVisible.value)
  } else if (clickedID === 'export-pandoc') {
    if (activeFile.value !== undefined && hasMarkdownExt(activeFile.value.path)) {
      exportDocumentToPptx(activeFile.value.path).catch(err => console.error(err))
    }
  } else if (clickedID !== undefined && clickedID.startsWith('markdown') && clickedID.length > 8) {
    // The user clicked a command button, so we just have to run that.
    editorCommands.value.data = clickedID
    editorCommands.value.executeCommand = !editorCommands.value.executeCommand
  } else if (clickedID === 'insertFootnote') {
    editorCommands.value.data = clickedID
    editorCommands.value.executeCommand = !editorCommands.value.executeCommand
  } else if (clickedID === 'markLyhRevise' || clickedID === 'acceptRevision' || clickedID === 'rejectRevision') {
    // Zettlr-LYH: the last focused editor wraps its non-empty selection as
    // [selection{}] and takes the focus back (MarkdownEditor.runCommand).
    // Accept and Reject (R84) take the same route to the active editor.
    editorCommands.value.data = clickedID
    editorCommands.value.executeCommand = !editorCommands.value.executeCommand
  } else if (clickedID === 'open-updater') {
    ipcRenderer.invoke('application', {
      command: 'open-update-window'
    })
      .catch(err => console.error(err))
  }
}

/**
 * Zettlr-LYH (R84): Saves the author name entered in the revision author
 * dialog, then turns Track Changes on. If either setting cannot be saved,
 * Track Changes stays off and the error is reported.
 *
 * @param   {string}  name  The author name; the dialog only confirms non-empty names
 */
function confirmRevisionAuthor (name: string): void {
  showRevisionAuthorDialog.value = false
  const author = name.trim()
  if (author === '') {
    return
  }
  if (!configStore.setConfigValue('editor.revisionAuthor', author) || !configStore.setConfigValue('editor.trackChanges', true)) {
    ipcRenderer.send('renderer-runtime-error', {
      kind: 'error',
      message: 'Could not save the revision author or Track Changes. Track Changes was not turned on.',
      source: 'Main toolbar',
      userNotice: true
    })
  }
}

function setPomodoroConfig (config: PomodoroConfig): void {
  // Update the durations as necessary
  pomodoro.value.durations.task = config.durations.task
  pomodoro.value.durations.short = config.durations.short
  pomodoro.value.durations.long = config.durations.long

  const effectChanged = config.currentEffectFile !== pomodoro.value.currentEffectFile
  const volumeChanged = config.soundEffect.volume !== pomodoro.value.soundEffect.volume
  if (effectChanged) {
    pomodoro.value.currentEffectFile = config.currentEffectFile
    pomodoro.value.soundEffect = new Audio(config.currentEffectFile)
    pomodoro.value.soundEffect.volume = config.soundEffect.volume
  }
  if (!effectChanged && volumeChanged) {
    pomodoro.value.soundEffect.volume = config.soundEffect.volume
  }

  if (effectChanged || volumeChanged) {
    pomodoro.value.soundEffect.pause()
    pomodoro.value.soundEffect.currentTime = 0
    pomodoro.value.soundEffect.play().catch(_e => {
      /* We will be getting errors when pausing quickly */
    })
  }
}

function handleToggle (controlState: { id?: string, state?: string | boolean }): void {
  const { id, state } = controlState
  if (id === 'toggle-file-manager') {
    // Since this is a three-way-toggle, we have to inspect the state.
    configStore.setConfigValue('window.fileManagerVisible', state !== undefined)
    if (typeof state === 'string' && (state === 'fileManager' || state === 'globalSearch')) {
      // Set the shown component to the correct one
      mainSplitViewVisibleComponent.value = state
    } else {
      console.warn(`Could not toggle main split component; expected state to be 'fileManager' or 'globalSearch', received ${state}`)
    }
  }
}

function startPomodoro (): void {
  pomodoro.value.soundEffect.pause()
  pomodoro.value.soundEffect.currentTime = 0
  // Starts a new pomodoro timer
  pomodoro.value.phase.type = 'task'
  pomodoro.value.phase.elapsed = 0

  pomodoro.value.intervalHandle = setInterval(() => {
    pomodoroTick()
  }, 1000)
}

function pomodoroTick (): void {
  // Progresses the pomodoro counter by one second
  pomodoro.value.phase.elapsed += 1

  const currentPhaseDur = pomodoro.value.durations[pomodoro.value.phase.type]
  const phaseIsFinished = pomodoro.value.phase.elapsed === currentPhaseDur

  if (phaseIsFinished) {
    pomodoro.value.phase.elapsed = 0
    pomodoro.value.counter[pomodoro.value.phase.type] += 1

    if (pomodoro.value.phase.type === 'task' && pomodoro.value.counter.task % 4 === 0) {
      pomodoro.value.phase.type = 'long'
    } else if (pomodoro.value.phase.type === 'task') {
      pomodoro.value.phase.type = 'short'
    } else {
      // Both breaks lead to a new task
      pomodoro.value.phase.type = 'task'
    }

    pomodoro.value.soundEffect.play().catch(_e => { /* We will be getting errors when pausing quickly */ })
  }

  // Finally handle the popover logic
  if (pomodoro.value.popover !== undefined && pomodoro.value.popover.isClosed() === false) {
    // The popover is visible, so let's update the data. Good thing is, we
    // only really need to update two things: The current task, and the
    // elapsed time.
    pomodoro.value.popover.updateData({
      internalCurrentPhase: pomodoro.value.phase.type,
      internalElapsed: pomodoro.value.phase.elapsed
    })
  } else if (pomodoro.value.popover !== undefined && pomodoro.value.popover.isClosed() === true) {
    pomodoro.value.popover = undefined // Cleanup
  }
}

function stopPomodoro (): void {
  pomodoro.value.soundEffect.pause()
  pomodoro.value.soundEffect.currentTime = 0
  // Stops the pomodoro timer
  pomodoro.value.phase.type = 'task'
  pomodoro.value.phase.elapsed = 0
  pomodoro.value.counter.task = 0
  pomodoro.value.counter.short = 0
  pomodoro.value.counter.long = 0

  if (pomodoro.value.intervalHandle !== undefined) {
    clearInterval(pomodoro.value.intervalHandle)
    pomodoro.value.intervalHandle = undefined
  }
}

function getToolbarButtonDisplay (configName: keyof ConfigOptions['displayToolbarButtons']): boolean {
  return configStore.config.displayToolbarButtons[configName]
}

/**
 * Zettlr-LYH: whether the preferences show at least one of the six insert icon
 * buttons of the toolbar (comment, link, image, task list, table, footnote).
 * The separator line behind them hides when none is shown.
 *
 * @return  {boolean}  True if at least one insert icon button is shown
 */
function isAnyInsertButtonShown (): boolean {
  const insertButtonSettings: Array<keyof ConfigOptions['displayToolbarButtons']> = [
    'showMarkdownCommentButton',
    'showMarkdownLinkButton',
    'showMarkdownImageButton',
    'showMarkdownMakeTaskListButton',
    'showInsertTableButton',
    'showInsertFootnoteButton'
  ]
  return insertButtonSettings.some(settingName => getToolbarButtonDisplay(settingName))
}

/**
 * Zettlr-LYH (R81): the upper limit of a drag of the Margin control. Every
 * visible Markdown editor of this window allows a largest margin that keeps
 * its text at least 200 px wide; the limit is the smallest of these, and at
 * most the largest value the configuration accepts. Editors of hidden tabs
 * have no width and are left out; they limit their margin themselves once
 * shown.
 *
 * @return  {number}  The upper limit, in pixels
 */
function editorMarginDragLimit (): number {
  const scrollers = document.querySelectorAll<HTMLElement>(
    '.main-editor-wrapper:not(.code-file):not(.fullscreen) > .cm-editor > .cm-scroller'
  )
  let limit = MAXIMUM_STORED_EDITOR_MARGIN
  for (const scroller of Array.from(scrollers)) {
    if (scroller.clientWidth <= 0) {
      continue
    }
    const gutters = scroller.querySelector<HTMLElement>(':scope > .cm-gutters.cm-gutters-before')
    limit = Math.min(limit, maxEditorMargin(scroller.clientWidth, gutters?.offsetWidth ?? 0))
  }
  return limit
}

/**
 * Zettlr-LYH (R81): carries out a drag update of the Margin control. While
 * dragging, only the preview of this window changes; the end of a drag
 * writes the configuration once, and a cancelled drag writes nothing.
 *
 * @param   {ToolbarDragUpdate}  update  The drag update
 */
function handleEditorMarginDrag (update: ToolbarDragUpdate): void {
  if (update.kind === 'preview') {
    // The control emits the first preview synchronously on mousedown. Keep
    // this layout until the same drag ends, even if panes change meanwhile.
    editorMarginDrag ??= { split: editorAreaSplit.value, cancelled: false }
    if (!editorMarginDrag.cancelled) {
      windowStateStore.editorMarginPreview = { split: editorMarginDrag.split, value: update.value }
    }
    return
  }

  const drag = editorMarginDrag
  editorMarginDrag = null
  if (update.kind === 'restore' || drag === null || drag.cancelled || drag.split !== editorAreaSplit.value) {
    windowStateStore.editorMarginPreview = null
    return
  }

  const split = drag.split
  const preview = { split, value: update.value }
  windowStateStore.editorMarginPreview = preview
  if (!configStore.setConfigValue(marginConfigKey(split), update.value)) {
    windowStateStore.editorMarginPreview = null
    ipcRenderer.send('renderer-runtime-error', {
      kind: 'error',
      message: 'Could not save the margin. The setting was not changed.',
      source: 'Main toolbar',
      userNotice: true
    })
    return
  }
  keepEditorMarginPreviewUntilStored(preview)
}

/**
 * Zettlr-LYH (R81): keeps showing the final value of a drag until the
 * configuration store has received it, so that the editors do not jump back
 * to the old value in between. Gives up after two seconds. A newer drag that
 * has replaced the preview in the meantime is left alone.
 *
 * @param   {{ split: boolean, value: number }}  preview  The preview written at the end of the drag
 */
function keepEditorMarginPreviewUntilStored (preview: { split: boolean, value: number }): void {
  const currentStoredValue = (): number => storedEditorMargin(configStore.config.display, preview.split)
  const release = (): void => {
    stopWatching()
    clearTimeout(timeout)
    if (toRaw(windowStateStore.editorMarginPreview) === preview) {
      windowStateStore.editorMarginPreview = null
    }
  }
  const stopWatching = watch(currentStoredValue, (storedValue) => {
    if (storedValue === preview.value) {
      release()
    }
  })
  const timeout = setTimeout(release, 2000)
  if (currentStoredValue() === preview.value) {
    release()
  }
}
</script>

<style lang="css" scoped>
</style>

<style lang="less">
// The pandoc PPTX preview toggle is a checkable text push button following the
// flat light design language of the PyQt6-GUI-Design-Rules-LYH skill: neutral fill
// with a 1 px border and bold label while off, hover signalled by the
// accent-blue border, pressed one shade darker, and checked (= the active
// document's preview is open) held down in running green. The #toolbar
// ancestor is part of the selector because the toolbar's own
// "#toolbar button" rules outrank a lone id selector. The Sync Scroll switch
// (editor and preview scroll together), the JEV Search switch (R53, its
// panel is open) and the Toggle Sidebar switch (R58, the sidebar is shown)
// are the same kind of checkable button, as are Track Changes and Show
// Revisions (R84).
#toolbar #toolbar-toggle-pptx-preview,
#toolbar #toolbar-toggle-pptx-sync-scroll,
#toolbar #toolbar-toggle-edit-code-when-clicked,
#toolbar #toolbar-toggle-track-changes,
#toolbar #toolbar-toggle-show-revisions,
#toolbar #toolbar-toggle-jev-search,
#toolbar #toolbar-toggle-sidebar {
  background-color: #eceef2;
  color: #374151;
  border: 1px solid #c0c4cc;
  border-radius: 0;
  padding: 2px 10px;
  font-weight: bold;

  &:hover {
    border-color: #3b78d1;
    color: #111827;
  }

  &:active {
    background-color: #dcdfe5;
  }

  &.active {
    background-color: #3e8a72;
    color: #ffffff;
    border-color: #2f6b57;

    &:hover {
      background-color: #4c9d84;
    }

    &:active {
      background-color: #2f6b57;
    }
  }
}

// Zettlr-LYH (R81): the Margin control looks like the checkable text buttons
// above while unchecked, but has no pressed state since it is dragged rather
// than clicked; its ew-resize cursor comes from DragAdjustControl.vue. In
// distraction free mode it is greyed out.
#toolbar #toolbar-editor-margin {
  background-color: #eceef2;
  color: #374151;
  border: 1px solid #c0c4cc;
  border-radius: 0;
  padding: 2px 10px;
  font-weight: bold;

  &:hover:not(:disabled) {
    border-color: #3b78d1;
    color: #111827;
  }

  &:disabled {
    opacity: 0.5;
  }
}

// The file manager and search switch holds the first two of the five touching
// square buttons at the left end of the toolbar (R58). The 10 px outer margin
// and the transparent border the win32 and darwin styles give it would leave
// gaps around it, so both are removed here.
#toolbar #toolbar-toggle-file-manager {
  margin: 0;
  border: none;
}

// The three inserts, Attributes, the export, Revise Comment and the revision
// Accept and Reject (R84) are momentary action buttons: light action-blue
// fill with dark blue text per the design language, accent-blue hover
// border, one shade darker when pressed.
#toolbar #toolbar-markLyhRevise,
#toolbar #toolbar-acceptRevision,
#toolbar #toolbar-rejectRevision,
#toolbar #toolbar-insertPandocDiv,
#toolbar #toolbar-insertPandocSpan,
#toolbar #toolbar-markdownPandocColumns,
#toolbar #toolbar-pandocAttributes,
#toolbar #toolbar-export-pandoc {
  background-color: #d6e8fa;
  color: #1a3d6b;
  border: 1px solid #b8d2ec;
  border-radius: 0;
  padding: 2px 10px;
  font-weight: bold;

  &:hover {
    border-color: #3b78d1;
    background-color: #e6f2ff;
  }

  &:active {
    background-color: #b8d2ec;
  }
}

// Attributes is checkable (its panel stays open, R22): while checked it is
// held down in the same running green as the other checked Pandoc switches.
#toolbar #toolbar-pandocAttributes.active {
  background-color: #3e8a72;
  color: #ffffff;
  border-color: #2f6b57;

  &:hover {
    background-color: #4c9d84;
  }

  &:active {
    background-color: #2f6b57;
  }
}

// The export reports its outcome to the right of its button. A long summary
// must not push the rest of the toolbar out of view, so the line is cut off
// with an ellipsis; the button's tooltip carries the full text.
#toolbar #toolbar-pandoc-export-status {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
}

// The editor area and, while it is open, the JEV Search panel (R53) share the
// editor side of the editor/sidebar split: the panel keeps its fixed width
// and the editor area takes the rest.
div.editor-area-with-jev-search {
  display: flex;
  height: 100%;
  width: 100%;

  div.editor-area {
    flex: 1 1 auto;
    min-width: 0;
    height: 100%;
  }
}
</style>
