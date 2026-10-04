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
    <!-- JSON and JSON Lines files can be shown formatted or as raw text -->
    <div
      v-if="activeFileIsJSON && !distractionFree"
      class="json-view-mode-bar"
      role="radiogroup"
      aria-label="JSON view mode"
    >
      <button
        type="button"
        role="radio"
        v-bind:aria-checked="!showRawJSON"
        v-bind:class="{ active: !showRawJSON }"
        v-on:click="setRawJSON(false)"
      >
        Formatted (Read-Only)
      </button>
      <button
        type="button"
        role="radio"
        v-bind:aria-checked="showRawJSON"
        v-bind:class="{ active: showRawJSON }"
        v-on:click="setRawJSON(true)"
      >
        Raw Text (Editable)
      </button>
    </div>
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
                v-bind:file="activeFileDescriptor"
                v-bind:distraction-free="distractionFree"
                v-bind:leaf-id="leafId"
                v-bind:active-file="activeFile"
                v-bind:window-id="windowId"
                v-bind:editor-commands="editorCommands"
                v-bind:persistent-state-map="persistentStateMap"
                v-on:global-search="emit('globalSearch', $event)"
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
import { type LeafNodeJSON, type OpenDocument } from '@dts/common/documents'
import { type EditorCommands } from './App.vue'
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import DocumentTabs from './DocumentTabs.vue'
import MainEditor from './MainEditor.vue'
import { useDocumentTreeStore, useWindowStateStore } from 'source/pinia'
import ImageViewer from './file-viewers/ImageViewer.vue'
import { hasImageExt, hasJSONOrJSONLinesExt, hasMarkdownExt, hasPDFExt } from '@common/util/file-extention-checks'
import PDFViewer from './file-viewers/PDFViewer.vue'
import JSONViewer from './file-viewers/JSONViewer.vue'
import PandocPptxPreview from './file-viewers/PandocPptxPreview.vue'
import SplitView from '@common/vue/window/SplitView.vue'
import type { DocumentManagerIPCAPI } from 'source/app/service-providers/documents'
import { type EditorViewPersistentState } from 'source/common/modules/markdown-editor'

const ipcRenderer = window.ipc

const windowStateStore = useWindowStateStore()
const documentTreeStore = useDocumentTreeStore()

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
const persistentStateMap = new Map<string, EditorViewPersistentState>()
// The same for the reading position of the formatted JSON viewer
const jsonViewerTopLineMap = new Map<string, number>()

// JSON and JSON Lines files open in the formatted, read-only viewer by default.
// This set holds the files for which the user has switched to the raw text
// editor in this pane.
const rawJSONPaths = ref(new Set<string>())

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

    .json-view-mode-bar {
      display: flex;
      flex-shrink: 0;
      gap: 4px;
      padding: 4px 10px;
      font-size: 12px;
      background-color: rgb(248, 248, 248);
      border-bottom: 1px solid rgb(220, 220, 220);

      button {
        padding: 2px 10px;
        border: 1px solid transparent;
        border-radius: 4px;
        background-color: transparent;
        color: inherit;
        cursor: pointer;

        &:hover { background-color: rgba(0, 0, 0, 0.06); }

        &.active {
          border-color: var(--system-accent-color);
          color: var(--system-accent-color);
        }
      }
    }

    .editor-container {
      position: relative;
      overflow: auto;
      flex-grow: 1;

      div.dropzone {
        position: absolute;
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

  &.dark .editor-pane .json-view-mode-bar {
    background-color: rgb(40, 40, 40);
    border-bottom-color: rgb(70, 70, 70);

    button:hover { background-color: rgba(255, 255, 255, 0.08); }
  }
}
</style>
