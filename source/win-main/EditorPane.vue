<template>
  <div
    ref="paneElement"
    v-bind:class="{
      'editor-pane': true,
      'distraction-free': distractionFree
    }"
    v-bind:style="elementStyles"
    v-on:dragenter="handleDragEnter($event, 'editor')"
    v-on:dragleave="handleDragLeave($event)"
  >
    <!-- We have a leaf: Default DocumentTabs/Editor combo -->
    <DocumentTabs
      v-show="!distractionFree"
      v-bind:leaf-id="leafId"
      v-bind:window-id="windowId"
    ></DocumentTabs>
    <!--
      JSON and JSON Lines files can be shown formatted (read-only viewer) or as
      raw text; TOML files can be shown formatted or as raw text, and both TOML
      modes edit the file in the same MainEditor (R124)
    -->
    <div
      v-if="(activeFileIsJSON || activeFileIsTOML) && !distractionFree"
      class="json-view-mode-bar"
      role="radiogroup"
      v-bind:aria-label="activeFileIsTOML ? 'TOML view mode' : 'JSON view mode'"
    >
      <button
        type="button"
        role="radio"
        class="json-view-mode-segment"
        v-bind:aria-checked="!showRawStructuredText"
        v-bind:class="{ active: !showRawStructuredText }"
        v-on:click="setRawStructuredText(false)"
      >
        {{ activeFileIsTOML ? 'Formatted' : 'Formatted (Read-Only)' }}
      </button>
      <button
        type="button"
        role="radio"
        class="json-view-mode-segment json-view-mode-segment-following"
        v-bind:aria-checked="showRawStructuredText"
        v-bind:class="{ active: showRawStructuredText }"
        v-on:click="setRawStructuredText(true)"
      >
        {{ activeFileIsTOML ? 'Raw Text' : 'Raw Text (Editable)' }}
      </button>
      <!--
        R128: the Show Tables switch of the TOML Formatted mode. It is one
        global setting for all TOML files, windows and panes (styled below).
      -->
      <button
        v-if="tomlViewMode === 'formatted'"
        type="button"
        role="switch"
        class="json-view-mode-toggle"
        title="Show table sections of TOML files as tables (applies to all TOML files)"
        v-bind:aria-checked="tomlShowTables"
        v-on:click="toggleTOMLShowTables()"
      >
        Show Tables
      </button>
    </div>
    <!--
      Zettlr-LYH disk conflicts (R138): the file of this pane's active tab is
      being compared in another pane of this window, so this editor is
      read-only until the comparison ends
    -->
    <Teleport v-bind:to="conflictComparisonHost ?? 'div#window-content'" v-bind:disabled="!distractionFree">
      <div
        v-if="conflictInOtherPane !== undefined"
        class="conflict-in-other-pane-bar"
        v-bind:class="{ 'distraction-free': distractionFree }"
        role="status"
      >
        <span class="conflict-in-other-pane-text">This file is read-only while its conflict comparison is open.</span>
        <button
          type="button"
          class="conflict-in-other-pane-button"
          v-on:click="goToComparison()"
        >
          {{ conflictText.goToComparison }}
        </button>
      </div>
    </Teleport>
    <!--
      Zettlr-LYH data loss prevention (R173): failed saves, undo history that
      could not be recorded, undelivered input and recoverable input of files
      that are not open. Every pane shows the same notices.
    -->
    <DataSafetyBanner
      v-bind:leaf-id="leafId"
      v-bind:window-id="windowId"
    ></DataSafetyBanner>
    <div
      class="editor-container"
      v-on:drop="handleDrop($event, 'editor')"
    >
      <SplitView
        ref="pptxPreviewSplitComponent"
        v-bind:split="'horizontal'"
        v-bind:minimum-size-percent="[ 20, 20 ]"
        v-bind:initial-size-percent="[ 55, 45 ]"
        v-bind:reset-size-percent="[ 55, 45 ]"
      >
        <template #view1>
          <template v-if="activeFileDescriptor !== undefined">
            <!--
              Teleport the correct editor that needs to be in distraction free
              outside the DOM structure to have it render on top of everything else.
            -->
            <Teleport to="div#window-content" v-bind:disabled="!distractionFree">
              <ImageViewer
                v-if="hasImageExt(activeFileDescriptor.path)"
                v-bind:file="activeFileDescriptor"
                v-bind:leaf-id="leafId"
                v-bind:active-file="activeFile"
                v-bind:window-id="windowId"
                v-bind:editor-commands="editorCommands"
              ></ImageViewer>
              <PDFViewer
                v-else-if="hasPDFExt(activeFileDescriptor.path)"
                v-bind:file="activeFileDescriptor"
                v-bind:leaf-id="leafId"
                v-bind:active-file="activeFile"
                v-bind:window-id="windowId"
                v-bind:editor-commands="editorCommands"
              ></PDFViewer>
              <JSONViewer
                v-else-if="activeFileIsJSON && !showRawJSON"
                v-bind:key="activeFileDescriptor.path"
                v-bind:file="activeFileDescriptor"
                v-bind:leaf-id="leafId"
                v-bind:active-file="activeFile"
                v-bind:window-id="windowId"
                v-bind:editor-commands="editorCommands"
                v-bind:top-line-map="jsonViewerTopLineMap"
              ></JSONViewer>
              <MainEditor
                v-else
                v-bind:key="activeFileDescriptor.path"
                v-bind:file="activeFileDescriptor"
                v-bind:distraction-free="distractionFree"
                v-bind:leaf-id="leafId"
                v-bind:active-file="activeFile"
                v-bind:window-id="windowId"
                v-bind:editor-commands="editorCommands"
                v-bind:persistent-state-map="persistentStateMap"
                v-bind:toml-view-mode="tomlViewMode"
                v-on:global-search="emit('globalSearch', $event)"
                v-on:undid-reload-from-disk="showUndidReloadHint()"
              ></MainEditor>
            </Teleport>
          </template>

          <!-- Show empty pane if there are no files -->
          <div v-if="hasNoOpenFiles" class="empty-pane"></div>
        </template>
        <template #view2>
          <PandocPptxPreview
            v-if="showPptxPreview && activeFileDescriptor !== undefined"
            v-bind:file-path="activeFileDescriptor.path"
            v-bind:scroll-top-map="pptxPreviewScrollTopMap"
          ></PandocPptxPreview>
        </template>
      </SplitView>
      <template v-for="file in openFiles" v-bind:key="file.path">
      </template>

      <!--
        Zettlr-LYH disk conflicts (R138): the comparison views of the sessions
        this pane is the target of. They cover only this editor area, stay
        mounted (hidden) while another tab of the pane is active, and come back
        with their text, undo history and scroll positions.
      -->
      <Teleport to="div#window-content" v-bind:disabled="!distractionFree">
        <div
          ref="conflictComparisonHost"
          class="conflict-comparison-host"
          v-bind:class="{
            'distraction-free': distractionFree,
            'obscured-by-distraction-free': windowStateStore.distractionFreeMode !== undefined && !distractionFree
          }"
        ></div>
      </Teleport>

      <!--
        Zettlr-LYH disk conflicts (R138): the notice that the document of this
        pane has just been reloaded from disk. It takes no focus and no mouse
        input and has no button.
      -->
      <div
        v-if="reloadedHintVisible"
        class="reloaded-from-disk-hint"
        v-bind:class="{ fading: reloadedHintFading }"
        role="status"
        aria-live="polite"
      >
        {{ conflictText.reloadedFromDisk }}
      </div>

      <!--
        Zettlr-LYH undo history (R135): the notice that the user has just undone
        the reload of the document from disk. It looks and behaves like the
        notice above, and the two never show together.
      -->
      <div
        v-if="undidHintVisible"
        class="reloaded-from-disk-hint undid-reload-from-disk-hint"
        v-bind:class="{ fading: undidHintFading }"
        role="status"
        aria-live="polite"
      >
        {{ UNDID_RELOAD_HINT_TEXT }}
      </div>

      <!-- Implement dropzones for editor pane splitting -->
      <div
        v-if="documentTabDrag"
        v-bind:class="{
          dropzone: true,
          top: true,
          dragover: documentTabDragWhere === 'top'
        }"
        v-on:drop="handleDrop($event, 'top')"
        v-on:dragenter="handleDragEnter($event, 'top')"
        v-on:dragleave="handleDragLeave($event)"
      >
        <cds-icon
          v-if="documentTabDragWhere === 'top'"
          shape="angle" size="xl" direction="up"
        ></cds-icon>
      </div>
      <div
        v-if="documentTabDrag"
        v-bind:class="{
          dropzone: true,
          left: true,
          dragover: documentTabDragWhere === 'left'
        }"
        v-on:drop="handleDrop($event, 'left')"
        v-on:dragenter="handleDragEnter($event, 'left')"
        v-on:dragleave="handleDragLeave($event)"
      >
        <cds-icon
          v-if="documentTabDragWhere === 'left'"
          shape="angle" size="xl" direction="left"
        ></cds-icon>
      </div>
      <div
        v-if="documentTabDrag"
        v-bind:class="{
          dropzone: true,
          bottom: true,
          dragover: documentTabDragWhere === 'bottom'
        }"
        v-on:drop="handleDrop($event, 'bottom')"
        v-on:dragenter="handleDragEnter($event, 'bottom')"
        v-on:dragleave="handleDragLeave($event)"
      >
        <cds-icon
          v-if="documentTabDragWhere === 'bottom'"
          shape="angle" size="xl" direction="down"
        ></cds-icon>
      </div>
      <div
        v-if="documentTabDrag"
        v-bind:class="{
          dropzone: true,
          right: true,
          dragover: documentTabDragWhere === 'right'
        }"
        v-on:drop="handleDrop($event, 'right')"
        v-on:dragenter="handleDragEnter($event, 'right')"
        v-on:dragleave="handleDragLeave($event)"
      >
        <cds-icon
          v-if="documentTabDragWhere === 'right'"
          shape="angle" size="xl" direction="right"
        ></cds-icon>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { type LeafNodeJSON, type OpenDocument, type ConflictReadOnlySession } from '@dts/common/documents'
import { type EditorCommands } from './App.vue'
import { ref, computed, inject, onMounted, onBeforeUnmount, watch } from 'vue'
import DocumentTabs from './DocumentTabs.vue'
import MainEditor from './MainEditor.vue'
import DataSafetyBanner from './DataSafetyBanner.vue'
import { useConfigStore, useDocumentTreeStore, useWindowStateStore } from 'source/pinia'
import { setTOMLShowTables } from '@common/modules/markdown-editor/plugins/toml-table-render'
import ImageViewer from './file-viewers/ImageViewer.vue'
import { hasImageExt, hasJSONOrJSONLinesExt, hasMarkdownExt, hasPDFExt, hasTOMLExt } from '@common/util/file-extention-checks'
import PDFViewer from './file-viewers/PDFViewer.vue'
import JSONViewer from './file-viewers/JSONViewer.vue'
import PandocPptxPreview from './file-viewers/PandocPptxPreview.vue'
import SplitView from '@common/vue/window/SplitView.vue'
import type { DocumentManagerIPCAPI, DocumentsUpdateContext } from 'source/app/service-providers/documents'
import { editorPaneReadingStates } from './util/editor-pane-reading-state'
import {
  CONFLICT_MERGE_TEXT,
  FILE_RELOADED_FROM_DISK_EVENT
} from './util/conflict-merge'
import { CONFLICT_READ_ONLY_REGISTRY_KEY, type ConflictReadOnlyRegistry } from './util/conflict-read-only'

const ipcRenderer = window.ipc

const windowStateStore = useWindowStateStore()
const documentTreeStore = useDocumentTreeStore()
const configStore = useConfigStore()

const props = defineProps<{
  leafId: string
  windowId: string
  availableWidth?: number
  availableHeight?: number
  editorCommands: EditorCommands
}>()

type DragTargetAreas = 'editor'|'top'|'left'|'right'|'bottom'

const emit = defineEmits<(e: 'globalSearch', query: string) => void>()

// UNREFFED SCROLL MAP
// Each individual editor pane has its own persistent state map so that the
// editors can save their scroll positions, selections, etc. This enables us to
// only display a single document, thus saving lots of memory, but at the same
// time keep the feeling of a tabbed interface. The map is unique for each pane,
// since users may have the same document open in two panes, and want one file
// to be scrolled differently than the same file in a different pane.
const persistentStateMap = editorPaneReadingStates(props.windowId, props.leafId)
// The same for the reading position of the formatted JSON viewer
const jsonViewerTopLineMap = new Map<string, number>()

// JSON and JSON Lines files open in the formatted, read-only viewer by default,
// TOML files in the Formatted mode of the MainEditor (R124). These sets hold
// the files for which the user has switched to the raw text editor in this
// pane.
const rawJSONPaths = ref(new Set<string>())
const rawTOMLPaths = ref(new Set<string>())

// The scroll positions of the pandoc PPTX preview lists, per file (per pane),
// so that the reading position survives switching tabs.
const pptxPreviewScrollTopMap = new Map<string, number>()
const pptxPreviewSplitComponent = ref<typeof SplitView|null>(null)

const documentTabDrag = ref<boolean>(false)
const documentTabDragWhere = ref<DragTargetAreas|undefined>(undefined)

const elementStyles = computed<string>(() => {
  if (distractionFree.value) {
    return ''
  } else {
    return `width: ${props.availableWidth ?? 100}%; height: ${props.availableHeight ?? 100}%`
  }
})

const paneElement = ref<HTMLDivElement|null>(null)
const distractionFree = computed<boolean>(() => windowStateStore.distractionFreeMode === props.leafId)
const node = computed<LeafNodeJSON|undefined>(() => documentTreeStore.paneData.find((leaf: LeafNodeJSON) => leaf.id === props.leafId))
const activeFile = computed<OpenDocument|null>(() => node.value?.activeFile ?? null)
const openFiles = computed<OpenDocument[]>(() => node.value?.openFiles ?? [])
const activeFileDescriptor = computed(() => {
  const af = activeFile.value
  if (af === null) {
    return undefined
  }

  return openFiles.value.find(d => d.path === af.path)
})
const hasNoOpenFiles = computed<boolean>(() => openFiles.value.length === 0)
const activeFileIsJSON = computed<boolean>(() => {
  return activeFileDescriptor.value !== undefined && hasJSONOrJSONLinesExt(activeFileDescriptor.value.path)
})
const showRawJSON = computed<boolean>(() => {
  return activeFileDescriptor.value !== undefined && rawJSONPaths.value.has(activeFileDescriptor.value.path)
})
const activeFileIsTOML = computed(() => activeFileDescriptor.value !== undefined && hasTOMLExt(activeFileDescriptor.value.path))
const showRawTOML = computed(() => activeFileDescriptor.value !== undefined && rawTOMLPaths.value.has(activeFileDescriptor.value.path))
const showRawStructuredText = computed(() => activeFileIsTOML.value ? showRawTOML.value : showRawJSON.value)
// Zettlr-LYH (R124): the view mode handed to the MainEditor of a TOML file;
// undefined for every other file. TOML files use the MainEditor in both modes,
// and its key is the path alone, so that switching modes keeps the editor
// with its undo history and unsaved changes.
const tomlViewMode = computed<'formatted'|'raw'|undefined>(() => {
  if (!activeFileIsTOML.value) {
    return undefined
  }
  return showRawTOML.value ? 'raw' : 'formatted'
})

function setRawStructuredText (raw: boolean): void {
  if (!activeFileIsTOML.value) {
    setRawJSON(raw)
    return
  }
  const filePath = activeFileDescriptor.value?.path
  if (filePath === undefined) {return}
  if (raw) {rawTOMLPaths.value.add(filePath)} else {rawTOMLPaths.value.delete(filePath)}
}

// Zettlr-LYH (R128): the Show Tables switch of the TOML Formatted mode is one
// global setting of the main configuration (tomlShowTables), not a state of
// this pane. Every pane of every window follows the configuration: the
// editors of the TOML files get the value through setTOMLShowTables(), which
// also makes editors that open later start with it. The immediate watcher runs
// during setup, before the editor of this pane exists.
const tomlShowTables = computed<boolean>(() => configStore.config.tomlShowTables)
watch(tomlShowTables, show => { setTOMLShowTables(show) }, { immediate: true })

function toggleTOMLShowTables (): void {
  const next = !tomlShowTables.value
  if (configStore.setConfigValue('tomlShowTables', next)) {
    // The configuration reaches all panes in a moment; do not wait for it here
    setTOMLShowTables(next)
  }
}
// The pandoc PPTX preview only applies to Markdown files (which are exactly
// the files of the MainEditor branch of the viewer chain above, since the
// image/PDF/JSON extension lists are disjoint from the Markdown ones), and it
// is force-hidden in distraction-free mode.
const showPptxPreview = computed<boolean>(() => {
  const descriptor = activeFileDescriptor.value
  if (descriptor === undefined || distractionFree.value) {
    return false
  }

  return hasMarkdownExt(descriptor.path) && windowStateStore.pptxPreviewPaths.has(descriptor.path)
})

watch(showPptxPreview, (newValue) => {
  if (newValue) {
    pptxPreviewSplitComponent.value?.unhide()
  } else {
    pptxPreviewSplitComponent.value?.hideView(2)
  }
})

function setRawJSON (raw: boolean): void {
  const filePath = activeFileDescriptor.value?.path
  if (filePath === undefined) {
    return
  }

  if (raw) {
    rawJSONPaths.value.add(filePath)
  } else {
    rawJSONPaths.value.delete(filePath)
  }
}

// ---------------------------------------------------------------------------
// Zettlr-LYH disk conflicts (R138)
// ---------------------------------------------------------------------------

const conflictText = CONFLICT_MERGE_TEXT
// The comparisons of this window (provided by App.vue)
const conflictReadOnlyRegistry = inject<ConflictReadOnlyRegistry|undefined>(CONFLICT_READ_ONLY_REGISTRY_KEY, undefined)
const conflictComparisonHost = ref<HTMLElement|null>(null)
onMounted(() => { conflictReadOnlyRegistry?.registerPane(props.leafId, conflictComparisonHost.value) })
onBeforeUnmount(() => { conflictReadOnlyRegistry?.registerPane(props.leafId, null) })

// The comparison of the active tab's file, if another pane shows it
const conflictInOtherPane = computed<ConflictReadOnlySession|undefined>(() => {
  const path = activeFile.value?.path
  if (path === undefined) {
    return undefined
  }
  return conflictReadOnlyRegistry?.sessions.find(session => session.filePath === path)
})

/**
 * Activates the tab of the compared file in the pane that shows the
 * comparison (the file is open there, so the command only activates the tab
 * and focuses the pane). Explicit local navigation also follows the target
 * pane in distraction free mode if neither the mode nor the target changed.
 */
function goToComparison (): void {
  const session = conflictInOtherPane.value
  if (session === undefined) {
    return
  }
  const targetWindowId = session.windowId
  const targetLeafId = session.leafId
  let modeChanged = false
  const stopWatchingMode = watch(() => windowStateStore.distractionFreeMode, () => { modeChanged = true }, { flush: 'sync' })
  ipcRenderer.invoke('documents-provider', {
    ...(conflictReadOnlyRegistry?.legacy === true
      ? { command: 'open-file', payload: { windowId: session.windowId, leafId: session.leafId, path: session.filePath, newTab: false } }
      : { command: 'focus-conflict-merge', payload: { path: session.filePath, sessionId: session.sessionId } })
  } as DocumentManagerIPCAPI)
    .then((result: unknown) => {
      if (result !== true || modeChanged || !distractionFree.value) { return }
      const target = conflictReadOnlyRegistry?.sessions.find(current => current.filePath === session.filePath && current.sessionId === session.sessionId)
      if (target?.windowId === props.windowId && target.windowId === targetWindowId && target.leafId === targetLeafId && documentTreeStore.paneData.some(pane => pane.id === targetLeafId)) {
        // Explicit navigation follows a local comparison without ending the
        // user's distraction free mode. Passive conflict events never do this.
        windowStateStore.distractionFreeMode = target.leafId
      }
    })
    .catch(err => console.error(err))
    .finally(stopWatchingMode)
}

// The "Reloaded from disk" notice in the lower right corner of the editor
// area. It shows for 4 seconds (counted from the moment the window has the
// focus, if it has not) and fades out within 0.3 seconds; a further reload
// before it is gone keeps a single notice and restarts the count.
const RELOADED_HINT_SHOWN_MILLISECONDS = 4000
const RELOADED_HINT_FADE_MILLISECONDS = 300
const reloadedHintVisible = ref(false)
const reloadedHintFading = ref(false)
let reloadedHintTimer: ReturnType<typeof setTimeout>|undefined
let reloadedHintWaitsForFocus = false

function clearReloadedHintTimer (): void {
  if (reloadedHintTimer !== undefined) {
    clearTimeout(reloadedHintTimer)
    reloadedHintTimer = undefined
  }
  if (reloadedHintWaitsForFocus) {
    window.removeEventListener('focus', startReloadedHintCountdown)
    reloadedHintWaitsForFocus = false
  }
}

function startReloadedHintCountdown (): void {
  clearReloadedHintTimer()
  reloadedHintTimer = setTimeout(() => {
    reloadedHintFading.value = true
    reloadedHintTimer = setTimeout(() => {
      reloadedHintVisible.value = false
      reloadedHintFading.value = false
      reloadedHintTimer = undefined
    }, RELOADED_HINT_FADE_MILLISECONDS)
  }, RELOADED_HINT_SHOWN_MILLISECONDS)
}

function showReloadedHint (): void {
  clearReloadedHintTimer()
  reloadedHintVisible.value = true
  reloadedHintFading.value = false
  if (document.hasFocus()) {
    startReloadedHintCountdown()
  } else {
    reloadedHintWaitsForFocus = true
    window.addEventListener('focus', startReloadedHintCountdown, { once: true })
  }
}

// The main process announces every pane whose active tab has been reloaded
// from disk; the notice only concerns the pane it names
const stopReloadedFromDiskNotices = ipcRenderer.on('documents-update', (_event, payload: { event: string, context: DocumentsUpdateContext|undefined }) => {
  if (payload.event === FILE_RELOADED_FROM_DISK_EVENT && payload.context?.windowId === props.windowId && payload.context.leafId === props.leafId) {
    showReloadedHint()
  }
})

// Zettlr-LYH undo history (R135): the "Undid reload from disk" notice in the
// lower right corner of the editor area, shown when an undo took back the
// reload of an external modification (a reload from disk or the result of a
// comparison). It is the notice above in everything but its text and its
// trigger: 4 seconds (counted from the moment the window has the focus, if it
// has not), 0.3 seconds of fading, no focus and no mouse input. The one that
// appears last replaces the other.
const UNDID_RELOAD_HINT_TEXT = 'Undid reload from disk'
const undidHintVisible = ref(false)
const undidHintFading = ref(false)
let undidHintTimer: ReturnType<typeof setTimeout>|undefined
let undidHintWaitsForFocus = false

function clearUndidHintTimer (): void {
  if (undidHintTimer !== undefined) {
    clearTimeout(undidHintTimer)
    undidHintTimer = undefined
  }
  if (undidHintWaitsForFocus) {
    window.removeEventListener('focus', startUndidHintCountdown)
    undidHintWaitsForFocus = false
  }
}

function startUndidHintCountdown (): void {
  clearUndidHintTimer()
  undidHintTimer = setTimeout(() => {
    undidHintFading.value = true
    undidHintTimer = setTimeout(() => {
      undidHintVisible.value = false
      undidHintFading.value = false
      undidHintTimer = undefined
    }, RELOADED_HINT_FADE_MILLISECONDS)
  }, RELOADED_HINT_SHOWN_MILLISECONDS)
}

function showUndidReloadHint (): void {
  // The notice that appears last replaces the other one
  clearReloadedHintTimer()
  reloadedHintVisible.value = false
  reloadedHintFading.value = false
  clearUndidHintTimer()
  undidHintVisible.value = true
  undidHintFading.value = false
  if (document.hasFocus()) {
    startUndidHintCountdown()
  } else {
    undidHintWaitsForFocus = true
    window.addEventListener('focus', startUndidHintCountdown, { once: true })
  }
}

// ... and "Reloaded from disk" replaces this notice when it appears
watch(reloadedHintVisible, visible => {
  if (visible) {
    clearUndidHintTimer()
    undidHintVisible.value = false
    undidHintFading.value = false
  }
}, { flush: 'sync' })

onBeforeUnmount(() => {
  clearUndidHintTimer()
})

onMounted(() => {
  // Global drag end listener to ensure the split-view indicators always disappear
  document.addEventListener('dragend', finishDrag, true)

  // The split view shows both views by default, so initially hide the preview
  // column unless the active file already has the preview toggled on.
  if (!showPptxPreview.value) {
    pptxPreviewSplitComponent.value?.hideView(2)
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('dragend', finishDrag)
  stopReloadedFromDiskNotices()
  clearReloadedHintTimer()
})

function handleDrop (event: DragEvent, where: 'editor'|'top'|'left'|'right'|'bottom'): boolean|undefined {
  const DELIM = (process.platform === 'win32') ? ';' : ':'
  const documentTab = event.dataTransfer?.getData('zettlr/document-tab')
  if (documentTab?.includes(DELIM) === true) {
    documentTabDrag.value = false
    event.stopPropagation()
    event.preventDefault()
    // At this point, we have received a drop we need to handle it. There
    // are two possibilities: Either the user has dropped the file onto the
    // editor, which means the file should be moved from its origin here.
    // Or, the user has dropped the file onto one of the four edges. In that
    // case, we need to first split this specific leaf, and then move the
    // dropped file there. The drag data contains both the origin and the
    // path, separated by the $PATH delimiter -> window:leaf:absPath
    const [ originWindow, originLeaf, ...filePath ] = documentTab.split(DELIM)
    if (where === 'editor' && props.leafId === originLeaf) {
      // Nothing to do, the user dropped the file on the origin
      return false
    }

    // Now actually perform the act
    if (where === 'editor') {
      ipcRenderer.invoke('documents-provider', {
        command: 'move-file',
        payload: {
          originWindow,
          targetWindow: props.windowId,
          originLeaf,
          targetLeaf: props.leafId,
          path: filePath.join(DELIM)
        }
      } as DocumentManagerIPCAPI)
        .catch(err => console.error(err))
    } else {
      const dir = ([ 'left', 'right' ].includes(where)) ? 'horizontal' : 'vertical'
      const ins = ([ 'top', 'left' ].includes(where)) ? 'before' : 'after'
      ipcRenderer.invoke('documents-provider', {
        command: 'split-leaf',
        payload: {
          originWindow: props.windowId,
          originLeaf: props.leafId,
          direction: dir,
          insertion: ins,
          path: filePath.join(DELIM),
          fromWindow: originWindow,
          fromLeaf: originLeaf
        }
      } as DocumentManagerIPCAPI)
        .catch(err => console.error(err))
    }
  }
}

function handleDragEnter (event: DragEvent, where: 'editor'|'top'|'left'|'right'|'bottom'): void {
  const hasDocumentTab = event.dataTransfer?.types.includes('zettlr/document-tab') ?? false
  if (hasDocumentTab) {
    event.stopPropagation()
    documentTabDrag.value = true
    documentTabDragWhere.value = where
  }
}

function handleDragLeave (event: DragEvent): void {
  if (paneElement.value === null) {
    return
  }

  const bounds = paneElement.value.getBoundingClientRect()
  const outX = event.clientX < bounds.left || event.clientX > bounds.right
  const outY = event.clientY < bounds.top || event.clientY > bounds.bottom
  if (outX || outY) {
    finishDrag()
  }
}

function finishDrag (): void {
  documentTabDrag.value = false
  documentTabDragWhere.value = undefined
}
</script>

<style lang="less">

@dropzone-size: 120px;

@keyframes caretup {
  from { margin-bottom: 0; opacity: 1; }
  50% { opacity: 0; }
  75% { margin-bottom: @dropzone-size; opacity: 0; }
  to { margin-bottom: @dropzone-size; opacity: 0; }
}
@keyframes caretdown {
  from { margin-top: 0; opacity: 1; }
  50% { opacity: 0; }
  75% { margin-top: @dropzone-size; opacity: 0; }
  to { margin-top: @dropzone-size; opacity: 0; }
}
@keyframes caretleft {
  from { margin-right: 0; opacity: 1; }
  50% { opacity: 0; }
  75% { margin-right: @dropzone-size; opacity: 0; }
  to { margin-right: @dropzone-size; opacity: 0; }
}
@keyframes caretright {
  from { margin-left: 0; opacity: 1; }
  50% { opacity: 0; }
  75% { margin-left: @dropzone-size; opacity: 0; }
  to { margin-left: @dropzone-size; opacity: 0; }
}

body {
  .editor-pane {
    // Styles for the editor pane
    height: 100%;
    display: flex;
    flex-direction: column;
    // The full-width strip behind the JSON view mode bar (see below) reaches
    // past the right edge of the bar; clip it horizontally to this pane so it
    // never paints over a neighbouring pane.
    overflow-x: clip;

    // Zettlr-LYH (R88, restyled by R129): the two view mode buttons are the
    // two options of a choose-one group, so they form a segmented control as
    // defined by the PyQt6 GUI design rules (section 3.2, "Choose-one groups",
    // and the Segment rules of the QSS template in section 11): edge to edge,
    // sharing one border line, square corners. The values are copied from the
    // segmented control of the right sidebar (button.sidebar-segment in
    // sidebar/SidebarSegmentBar.vue, R111); keep both places in sync. The
    // Show Tables switch of the TOML Formatted mode (R128) is an on/off
    // option and follows the NeutralToggle rules of the same template. The
    // selectors name the buttons by class so that they win over the generic
    // platform rules for buttons (body.win32.dark button).
    // Both segments are as wide as the wider of the two labels: the bar is a
    // max-content grid whose two 1fr columns resolve to the larger label
    // width; any further child (the switch) falls into an implicit column of
    // its own width. Because the bar itself is therefore only as wide as its
    // buttons, its background and bottom border are painted by a full-width
    // ::before strip behind the buttons.
    .json-view-mode-bar {
      display: grid;
      grid-auto-flow: column;
      grid-template-columns: repeat(2, 1fr);
      grid-auto-columns: auto;
      align-items: center;
      gap: 0;
      width: max-content;
      flex-shrink: 0;
      position: relative;
      z-index: 0;
      padding: 4px 10px 5px;

      &::before {
        content: '';
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        width: 100vw;
        z-index: -1;
        box-sizing: border-box;
        background-color: rgb(248, 248, 248);
        border-bottom: 1px solid rgb(220, 220, 220);
      }

      // The segmented control: unselected white with a 1px grey border,
      // selected light blue with a 2px accent-blue border and bold text.
      button.json-view-mode-segment {
        min-width: 0;
        box-sizing: border-box;
        height: 30px;
        margin: 0;
        padding: 0 6px;
        border: 1px solid #c0c4cc;
        border-radius: 0;
        background-color: #ffffff;
        background-image: none;
        box-shadow: none;
        color: #374151;
        font-family: system-ui, "Microsoft YaHei UI", sans-serif;
        font-size: 12px;
        font-weight: normal;
        line-height: 1;
        text-align: center;
        white-space: nowrap;
        overflow: hidden;
        cursor: pointer;

        // Adjacent segments share one border
        &.json-view-mode-segment-following { border-left: none; }

        &:hover:not(.active):not(:disabled) {
          border-color: #3b78d1;
          color: #111827;
        }

        &.active {
          background-color: #d6e8fa;
          color: #1a3d6b;
          border: 2px solid #3b78d1;
          font-weight: bold;
        }

        &:focus-visible {
          outline: 1px dotted #3b78d1;
          outline-offset: -4px;
        }

        // Gray means inert. The rule is listed last on purpose: it has to win
        // over the selected colours.
        &:disabled {
          background-color: #e5e7eb;
          color: #9ca3af;
          border-color: #d1d5db;
          cursor: default;
        }

        &.active:disabled { border-color: #9ca3af; }
      }

      // The on/off switch (Show Tables, R128): a checkable button with a 5px
      // left stripe that is present in every state. The switch state is read
      // from aria-checked, which the switch carries anyway (role="switch").
      // The margin separates it from the segmented control.
      button.json-view-mode-toggle {
        min-width: 0;
        box-sizing: border-box;
        height: 30px;
        margin: 0 0 0 14px;
        padding: 0 10px;
        border: 1px solid #c0c4cc;
        border-left: 5px solid #9ca3af;
        border-radius: 0;
        background-color: #eceef2;
        background-image: none;
        box-shadow: none;
        color: #374151;
        font-family: system-ui, "Microsoft YaHei UI", sans-serif;
        font-size: 12px;
        font-weight: bold;
        line-height: 1;
        text-align: center;
        white-space: nowrap;
        overflow: hidden;
        cursor: pointer;

        &:hover:not(:disabled) {
          border-color: #3b78d1;
          border-left-color: #9ca3af;
          color: #111827;
        }

        &[aria-checked='true'] {
          background-color: #d4ecdf;
          color: #1f5a46;
          border-color: #9ccbb6;
          border-left-color: #5fae90;
        }

        &[aria-checked='true']:hover:not(:disabled) {
          background-color: #e3f4ea;
          border-color: #3b78d1;
          border-left-color: #5fae90;
        }

        &:focus-visible {
          outline: 1px dotted #3b78d1;
          outline-offset: -4px;
        }

        &:disabled {
          background-color: #e5e7eb;
          color: #9ca3af;
          border-color: #d1d5db;
          border-left-color: #d1d5db;
          cursor: default;
        }
      }
    }
  }

  // Zettlr-LYH disk conflicts (R138): the line above the editor area of a
  // pane whose file is being compared in another pane. It is a full-width
  // flat bar like the mode bar above (warm tint for "attention"); the button
  // follows the neutral button of the segmented control. Both locations keep
  // these styles when the bar moves with the distraction free editor.
  .editor-pane .conflict-in-other-pane-bar,
  .conflict-comparison-host > .conflict-in-other-pane-bar {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-shrink: 0;
    box-sizing: border-box;
    padding: 4px 10px 5px;
    background-color: #fff6dc;
    border-bottom: 1px solid #e3d6a3;
    color: #5c4a10;
    font-family: system-ui, "Microsoft YaHei UI", sans-serif;
    font-size: 12px;

    &.distraction-free {
      // The notice precedes App's comparison regardless of Teleport order.
      order: -1;
    }

    .conflict-in-other-pane-text {
      flex: 0 1 auto;
      min-width: 0;
    }

    button.conflict-in-other-pane-button {
      flex: 0 0 auto;
      min-width: 0;
      box-sizing: border-box;
      height: 24px;
      margin: 0;
      padding: 0 10px;
      border: 1px solid #c0c4cc;
      border-radius: 0;
      background-color: #ffffff;
      background-image: none;
      box-shadow: none;
      color: #374151;
      font-family: system-ui, "Microsoft YaHei UI", sans-serif;
      font-size: 12px;
      font-weight: normal;
      line-height: 1;
      white-space: nowrap;
      cursor: pointer;

      &:hover {
        border-color: #3b78d1;
        color: #111827;
      }

      &:focus-visible {
        outline: 1px dotted #3b78d1;
        outline-offset: -3px;
      }
    }
  }

  // The same host moves with its pane's fullscreen editor, keeping App's
  // comparison Teleport and its mounted views intact. Other panes stay hidden
  // behind that editor without destroying their comparison state.
  .conflict-comparison-host {
    position: absolute;
    inset: 0;
    pointer-events: none;
    > * { pointer-events: auto; }

    &.distraction-free {
      z-index: 1000;
      display: flex;
      flex-direction: column;

      > .conflict-merge-overlay {
        position: relative;
        inset: auto;
        flex: 1;
      }
    }
    &.obscured-by-distraction-free { display: none; }
  }

  .editor-pane {
    .editor-container {
      position: relative;
      overflow: auto;
      flex-grow: 1;

      // Zettlr-LYH disk conflicts (R138): the notice "Reloaded from disk" in
      // the lower right corner of the editor area. It sits above the editor
      // and below the comparison view, never takes the mouse (so a click goes
      // to the text below it) and never the focus.
      .reloaded-from-disk-hint {
        position: absolute;
        right: 24px;
        bottom: 12px;
        z-index: 300;
        pointer-events: none;
        box-sizing: border-box;
        padding: 4px 10px;
        border: 1px solid #c0c4cc;
        background-color: #f3f4f6;
        color: #374151;
        font-family: system-ui, "Microsoft YaHei UI", sans-serif;
        font-size: 12px;
        line-height: 1.3;
        opacity: 1;
        transition: opacity 0.3s ease;

        &.fading { opacity: 0; }
      }

      div.dropzone {
        position: absolute;
        // The drop zones stay above a comparison view (z-index 1000), so that a
        // tab can still be dropped onto the edges of a pane that shows one
        z-index: 1100;
        background-color: rgba(0, 0, 0, 0);
        transition: all 0.3s ease;
        // Display the direction caret centered ...
        display: flex;
        align-items: center;
        // ... and in white (against the dragover background color)
        color: white;

        cds-icon { margin: 0; }

        &.dragover {
          background-color: rgb(94 127 166 / 50%);
          box-shadow: 0px 0px 5px 0px rgba(0, 0, 0, .2);
          backdrop-filter: blur(2px);
        }

        &.top {
          top: 0;
          width: 100%;
          height: @dropzone-size;
          flex-direction: column-reverse;
          cds-icon { animation: 1s ease-out infinite running caretup; }
        }

        &.left {
          top: 0;
          left: 0;
          height: 100%;
          width: @dropzone-size;
          flex-direction: row-reverse;
          cds-icon { animation: 1s ease-out infinite running caretleft; }
        }

        &.right {
          top: 0;
          right: 0;
          height: 100%;
          width: @dropzone-size;
          flex-direction: row;
          cds-icon { animation: 1s ease-out infinite running caretright; }
        }

        &.bottom {
          bottom: 0;
          width: 100%;
          height: @dropzone-size;
          justify-content: center;
          align-items: flex-start;
          cds-icon { animation: 1s ease-out infinite running caretdown; }
        }
      }

      .empty-pane {
        width: 100%;
        height: 100%;
        // If the editor is empty, display a nice background image
        background-position: center center;
        background-size: contain;
        background-repeat: no-repeat;
        background-image: url(../common/img/logo.svg);
        background-color: white;
        padding-top: 5em;
      }
    }
  }

  &.dark .editor-pane .editor-container .empty-pane {
    background-color: rgb(40, 40, 40);
  }

  // Zettlr-LYH disk conflicts (R138): dark colours of the bar above the editor
  // area and of the "Reloaded from disk" notice
  &.dark .editor-pane .conflict-in-other-pane-bar,
  &.dark .conflict-comparison-host > .conflict-in-other-pane-bar {
    background-color: rgb(58, 50, 28);
    border-bottom-color: rgb(94, 82, 46);
    color: rgb(236, 224, 184);

    button.conflict-in-other-pane-button {
      background-color: rgb(50, 50, 50);
      border-color: rgb(90, 90, 90);
      color: rgb(215, 215, 215);

      &:hover {
        border-color: #5b9bf0;
        color: rgb(240, 240, 240);
      }

      &:focus-visible { outline-color: #5b9bf0; }
    }
  }

  &.dark .editor-pane .editor-container .reloaded-from-disk-hint {
    background-color: rgb(50, 50, 50);
    border-color: rgb(90, 90, 90);
    color: rgb(215, 215, 215);
  }

  // Dark mode of the mode bar: the strip keeps its dark colours; the
  // segmented control takes the dark colours of the sidebar one (selected: a
  // blue border on a dark blue fill instead of a light block, R129). The
  // disabled colours and the dark colours of the switch have no counterpart
  // in the sidebar; they are the dark equivalents of the light values.
  &.dark .editor-pane .json-view-mode-bar {
    &::before {
      background-color: rgb(40, 40, 40);
      border-bottom-color: rgb(70, 70, 70);
    }

    button.json-view-mode-segment {
      background-color: rgb(50, 50, 50);
      border-color: rgb(90, 90, 90);
      color: rgb(215, 215, 215);

      &:hover:not(.active):not(:disabled) {
        border-color: #5b9bf0;
        color: rgb(240, 240, 240);
      }

      &.active {
        background-color: rgb(30, 58, 95);
        color: rgb(214, 232, 250);
        border-color: #5b9bf0;
      }

      &:focus-visible { outline-color: #5b9bf0; }

      &:disabled {
        background-color: rgb(45, 45, 45);
        color: rgb(120, 120, 120);
        border-color: rgb(70, 70, 70);
      }

      &.active:disabled { border-color: rgb(120, 120, 120); }
    }

    button.json-view-mode-toggle {
      background-color: rgb(50, 50, 50);
      border-color: rgb(90, 90, 90);
      border-left-color: #9ca3af;
      color: rgb(215, 215, 215);

      &:hover:not(:disabled) {
        border-color: #5b9bf0;
        border-left-color: #9ca3af;
        color: rgb(240, 240, 240);
      }

      &[aria-checked='true'] {
        background-color: rgb(31, 74, 58);
        color: rgb(212, 236, 223);
        border-color: rgb(70, 120, 100);
        border-left-color: #5fae90;
      }

      &[aria-checked='true']:hover:not(:disabled) {
        background-color: rgb(38, 90, 70);
        border-color: #5b9bf0;
        border-left-color: #5fae90;
      }

      &:focus-visible { outline-color: #5b9bf0; }

      &:disabled {
        background-color: rgb(45, 45, 45);
        color: rgb(120, 120, 120);
        border-color: rgb(70, 70, 70);
        border-left-color: rgb(70, 70, 70);
      }
    }
  }
}
</style>
