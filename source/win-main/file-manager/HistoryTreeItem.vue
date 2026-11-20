<template>
  <div class="tree-item-container history-tree-item-container">
    <div
      v-bind:class="{
        'tree-item': true,
        'history-tree-item': true,
        'unopened': unopened,
        'collapsed': isFolder && isCollapsed,
        'directory': isFolder,
        'file': !isFolder,
        'selected': isSelected,
        'selected-ancestor': isSelectedAncestor,
        'active': activeItem === node.path && !isSelected,
        'is-modified': isModified
      }"
      v-bind:data-path="node.path"
      v-bind:style="{
        'padding-left': usesWindowsAppearance ? `calc(${depth} * var(--explorer-indent))` : `${depth * TREE_INDENT_PER_LEVEL + TREE_INDENT_BASE}px`
      }"
      v-on:click.stop="handleClick"
      v-on:dblclick.stop="handleDoubleClick"
      v-on:contextmenu="handleContextMenu"
      v-on:mousedown="handleMouseDown"
      v-on:mouseup="handleMouseUp"
    >
      <template v-if="usesWindowsAppearance">
        <span
          class="explorer-disclosure"
          v-bind:class="{ expanded: !isCollapsed, expandable: isFolder && hasChildren }"
          v-bind:role="isFolder && hasChildren ? 'button' : undefined"
          v-bind:aria-expanded="isFolder && hasChildren ? !isCollapsed : undefined"
          v-bind:aria-label="isFolder && hasChildren ? (isCollapsed ? expandLabel : collapseLabel) : undefined"
          v-bind:aria-hidden="isFolder && hasChildren ? undefined : true"
          v-on:click.stop="isFolder && hasChildren && toggleCollapsed()"
        >
          <svg v-if="isFolder && hasChildren" viewBox="0 0 16 16" aria-hidden="true"><path d="M 6 4 L 10 8 L 6 12"></path></svg>
        </span>
        <span class="explorer-icon" aria-hidden="true" v-bind:style="modifiedMaskStyle">
          <img
            v-if="nativeIcon !== null" v-bind:src="nativeIcon" alt=""
            draggable="false"
          >
          <cds-icon v-else v-bind:shape="primaryIcon" role="presentation"></cds-icon>
        </span>
      </template>
      <!-- Other platforms and unavailable native information retain the prior display. -->
      <!-- First: on a folder that has children, the folder icon doubles as a
      checkable button that collapses and uncollapses the whole node. Whether
      the button is checked, not the direction of an angle, is what tells the
      user that the folder is expanded. -->
      <span
        v-else-if="isFolder && hasChildren"
        v-bind:class="{ 'expand-toggle': true, 'checked': !isCollapsed }"
        role="button"
        v-bind:aria-expanded="!isCollapsed"
        v-bind:title="isCollapsed ? expandLabel : collapseLabel"
        v-on:click.stop="toggleCollapsed"
      >
        <cds-icon
          v-bind:shape="primaryIcon"
          role="presentation"
        ></cds-icon>
      </span>
      <!-- Rows that cannot be expanded show their icon without the button
      frame around it -->
      <span v-else class="toggle-icon" aria-hidden="true">
        <cds-icon
          v-bind:shape="primaryIcon"
          role="presentation"
        ></cds-icon>
      </span>
      <span
        ref="displayTextElement"
        class="display-text"
        role="button"
        v-bind:aria-label="`Select ${displayLabel}`"
        v-bind:title="node.path"
        v-on:mousedown="handleNameMouseDown"
      >
        <template v-if="!nameEditing">
          {{ displayLabel }}
        </template>
        <template v-else>
          <input
            ref="nameEditingInput"
            type="text"
            class="filename-input"
            v-bind:placeholder="filenameInputPlaceholder"
            v-bind:value="displayLabel"
            v-on:keyup.enter="finishNameEditing(($event.target as HTMLInputElement).value)"
            v-on:keyup.esc="nameEditing = false"
            v-on:keydown.stop=""
            v-on:blur="nameEditing = false"
            v-on:click.stop=""
          >
        </template>
      </span>
      <!-- Third: the button that shows or hides the never opened contents.
      This is fully independent of the angle in front of the row. The Show
      Only Folders with Open Tabs mode never shows grey rows, so it hides the
      button (R87). -->
      <span
        v-if="isFolder && !openTabsOnly"
        v-bind:class="{
          'unopened-content-toggle': true,
          'expand-toggle': true,
          'checked': showsUnopenedContent
        }"
        role="button"
        v-bind:aria-pressed="showsUnopenedContent"
        v-bind:title="showsUnopenedContent ? hideUnopenedContentLabel : showUnopenedContentLabel"
        v-on:click.stop="toggleUnopenedContent"
      >
        <cds-icon
          v-bind:shape="showsUnopenedContent ? 'eye-hide' : 'eye'"
          role="presentation"
        ></cds-icon>
      </span>
    </div>

    <template v-if="isFolder && !isCollapsed">
      <HistoryTreeItem
        v-for="child in displayedChildren"
        v-bind:key="child.node.path"
        v-bind:node="child.node"
        v-bind:descriptor="child.descriptor"
        v-bind:depth="depth + 1"
        v-bind:unopened="child.unopened"
        v-bind:filter-active="filterActive"
        v-bind:open-tabs-only="openTabsOnly"
        v-bind:open-history-paths="openHistoryPaths"
        v-bind:active-item="activeItem"
        v-bind:window-id="windowId"
        v-bind:selected-file-path="selectedFilePath"
        v-bind:uses-windows-appearance="usesWindowsAppearance"
        v-on:select-file="(path, unopened) => emit('select-file', path, unopened)"
      ></HistoryTreeItem>
    </template>
  </div>

  <PopoverFileProps
    v-if="showPopover && displayTextElement !== null && fileDescriptor !== undefined"
    v-bind:target="displayTextElement"
    v-bind:file="fileDescriptor"
    v-on:close="showPopover = false"
  ></PopoverFileProps>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        HistoryTreeItem Vue Component
 * CVM-Role:        View
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Renders a single row of the open history tree in the Files
 *                  section of the file manager. A row is either a folder that
 *                  the open history implies, a file from the open history, or a
 *                  grey row: a file or folder that has never been opened and
 *                  that was read from disk on demand. Below the Unsaved Files
 *                  virtual folder it also renders the scratch note rows (R96).
 *                  They offer the very same file context menu as every other
 *                  file row, acting on the real path of the scratch note; as a
 *                  scratch note is no root file, the menu has no Close file
 *                  item for it (R103). Clicking the name of the
 *                  selected file row once more opens the inline rename field,
 *                  like a slow double click in the Windows Explorer (R101).
 *                  A file row with unsaved changes, by the same list that marks
 *                  the tabs, lays a coloured mask over its icon (R109).
 *
 * END HEADER
 */

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import PopoverFileProps from './util/PopoverFileProps.vue'
import { trans } from 'source/common/i18n-renderer'
import { useDocumentTreeStore, useWindowStateStore, useWorkspaceStore } from 'source/pinia'
import type {
  AnyDescriptor,
  CodeFileDescriptor,
  MDFileDescriptor,
  OtherFileDescriptor
} from 'source/types/common/fsal'
import type { HistoryTreeNode } from 'source/common/util/open-history-tree'
import type { DocumentManagerIPCAPI } from 'source/app/service-providers/documents'
import { displayFileContext } from './util/file-item-context'
import { closeFile } from './util/item-composable'
import { hasMarkdownExt } from 'source/common/util/file-extention-checks'
import {
  getDisplayedHistoryChildren,
  hasDirectoryContents,
  loadDirectoryContents
} from './util/unopened-directory-contents'
import { TREE_INDENT_BASE, TREE_INDENT_PER_LEVEL } from './util/tree-indentation'
import { explorerAppearance } from './util/explorer-appearance'
import { historySelectionPathsEqual, isSelectedFileAncestor } from './util/history-tree-selection'
import { findPanesWithOpenFile } from './util/open-tab-paths'
import { createSlowClickRename, SLOW_CLICK_RENAME_DELAY } from '../util/slow-click-rename'

const ipcRenderer = window.ipc

const props = defineProps<{
  // The node this row represents
  node: HistoryTreeNode
  // How deep is this row nested?
  depth: number
  // True if this row represents something that has never been opened
  unopened: boolean
  // True while the user has typed something into the quick filter
  filterActive: boolean
  // True while the Files section shows only the files open as tabs (R87)
  openTabsOnly?: boolean
  // Every path of the open history, for filtering the grey rows
  openHistoryPaths: Set<string>
  windowId: string
  // The descriptor behind a grey row; history rows do not carry one
  descriptor?: AnyDescriptor
  activeItem?: string
  selectedFilePath?: string
  usesWindowsAppearance?: boolean
}>()

const emit = defineEmits<{ 'select-file': [path: string, unopened: boolean] }>()

const windowStateStore = useWindowStateStore()
const documentTreeStore = useDocumentTreeStore()
const workspaceStore = useWorkspaceStore()

const displayTextElement = ref<HTMLElement|null>(null)
const nameEditingInput = ref<HTMLInputElement|null>(null)
const nameEditing = ref(false)
const showPopover = ref(false)
// The descriptor required by the file context menu and the properties popover.
// Grey rows already have one; history rows have to look theirs up.
const resolvedDescriptor = ref<AnyDescriptor|undefined>(props.descriptor)

const filenameInputPlaceholder = trans('Enter a name')
const showUnopenedContentLabel = trans('Show files that have never been opened')
const hideUnopenedContentLabel = trans('Hide files that have never been opened')
const expandLabel = trans('Expand this directory')
const collapseLabel = trans('Collapse this directory')

const isFolder = computed(() => props.node.type === 'folder')

const displayLabel = computed(() => {
  return props.node.type === 'folder' ? props.node.label : props.node.name
})

/**
 * A filter query and the Show Only Folders with Open Tabs mode both uncollapse
 * the entire tree and leave out every grey row (R87).
 */
const showsEverythingExpanded = computed(() => props.filterActive || props.openTabsOnly)

const isCollapsed = computed(() => {
  if (showsEverythingExpanded.value) {
    return false
  }

  return !windowStateStore.uncollapsedDirectories.includes(props.node.path)
})

const showsUnopenedContent = computed(() => {
  return windowStateStore.directoriesShowingUnopenedContent.includes(props.node.path)
})

const displayedChildren = computed(() => {
  if (props.node.type !== 'folder') {
    return []
  }

  return getDisplayedHistoryChildren(
    props.node,
    showsUnopenedContent.value,
    props.openHistoryPaths,
    showsEverythingExpanded.value
  )
})

const hasChildren = computed(() => {
  return displayedChildren.value.length > 0
})

const primaryIcon = computed(() => {
  if (props.node.type === 'folder') {
    return isCollapsed.value ? 'folder' : 'folder-open'
  } else if (props.descriptor !== undefined) {
    return props.descriptor.type === 'code' ? 'code' : 'markdown'
  } else {
    return hasMarkdownExt(props.node.path) ? 'markdown' : 'code'
  }
})

const isSelected = computed(() => !isFolder.value && historySelectionPathsEqual(props.selectedFilePath, props.node.path))
const isSelectedAncestor = computed(() => isFolder.value && isSelectedFileAncestor(props.node.path, props.selectedFilePath))
const nativeIcon = computed(() => explorerAppearance.icons.value.get(props.node.path) ?? null)

/**
 * Whether this file has unsaved changes, decided exactly like the unsaved mark
 * of the tabs in DocumentTabs.vue: by the modified documents of the document
 * tree store. Scratch notes are listed there as long as they are not saved to
 * a real file (R40). Folder rows never count (R109).
 */
const isModified = computed(() => {
  if (props.node.type !== 'file') {
    return false
  }

  // Store substitutes without the list count as having nothing modified
  const modifiedDocuments: readonly string[]|undefined = documentTreeStore.modifiedDocuments
  return modifiedDocuments?.includes(props.node.path)
})

/**
 * The native Windows icon is a picture, so the mask over a modified row takes
 * that picture as its alpha mask and colours only its opaque pixels (R109).
 */
const modifiedMaskStyle = computed((): Record<string, string> => {
  const style: Record<string, string> = {}

  if (isModified.value && nativeIcon.value !== null) {
    style['--history-tree-modified-icon-mask'] = `url("${nativeIcon.value}")`
  }

  return style
})

/**
 * The descriptor to hand to the properties popover, which only accepts files.
 */
const fileDescriptor = computed<MDFileDescriptor|CodeFileDescriptor|OtherFileDescriptor|undefined>(() => {
  const descriptor = resolvedDescriptor.value

  if (descriptor === undefined || descriptor.type === 'directory') {
    return undefined
  }

  return descriptor
})

// Zettlr-LYH slow click rename (R101): the name element of the latest press,
// and when the window last came to the front, since the click doing that does
// not count
let slowClickNameElement: HTMLElement|null = null
let lastWindowFocusTime = Number.NEGATIVE_INFINITY

const slowClickRename = createSlowClickRename({
  onRename: () => {
    if (props.node.type === 'file' && isSelected.value && !nameEditing.value) {
      nameEditing.value = true
    }
  },
  onActiveChange: followWindowDuringSlowClick
})

// Losing the selection ends a slow click
watch(isSelected, selected => {
  if (!selected) {
    slowClickRename.cancel()
  }
})

onMounted(() => {
  window.addEventListener('focus', handleWindowFocus)
})

onBeforeUnmount(() => {
  window.removeEventListener('focus', handleWindowFocus)
  slowClickRename.cancel()
})

// The contents of a directory are read from disk the first time the user asks
// for its never opened contents, and again if the file system watcher has
// invalidated the cached listing in the meantime. The Show Only Folders with
// Open Tabs mode displays no grey rows, so it reads nothing until it ends.
watch(
  [ showsUnopenedContent, () => props.node.path, () => hasDirectoryContents(props.node.path), () => props.openTabsOnly ],
  () => {
    if (props.openTabsOnly) {
      return
    }

    if (props.node.type === 'folder' && showsUnopenedContent.value && !hasDirectoryContents(props.node.path)) {
      loadDirectoryContents(props.node.path)
    }
  },
  { immediate: true }
)

watch(() => props.descriptor, (value) => {
  if (value !== undefined) {
    resolvedDescriptor.value = value
  }
})

watch(nameEditing, (isEditing) => {
  if (!isEditing) {
    return
  }

  nextTick().then(() => {
    if (nameEditingInput.value === null) {
      return
    }

    nameEditingInput.value.focus()
    const lastDot = nameEditingInput.value.value.lastIndexOf('.')
    nameEditingInput.value.setSelectionRange(0, lastDot > 0 ? lastDot : nameEditingInput.value.value.length)
  }).catch(error => console.error(error))
})

/**
 * Toggles the collapsed state of this row, using the very same mechanism the
 * workspace tree uses. In the Show Only Folders with Open Tabs mode every
 * folder stays expanded, and the stored state is left untouched so that the
 * tree looks exactly as before once the mode ends (R87).
 */
function toggleCollapsed (): void {
  if (props.node.type !== 'folder' || props.openTabsOnly) {
    return
  }

  const index = windowStateStore.uncollapsedDirectories.indexOf(props.node.path)

  if (index > -1) {
    windowStateStore.uncollapsedDirectories.splice(index, 1)
  } else {
    windowStateStore.uncollapsedDirectories.push(props.node.path)
  }
}

/**
 * Toggles whether this folder also displays the files and subdirectories that
 * have never been opened. Turning the display on also uncollapses the folder,
 * because otherwise the newly added rows would stay invisible.
 */
function toggleUnopenedContent (): void {
  if (props.node.type !== 'folder') {
    return
  }

  const index = windowStateStore.directoriesShowingUnopenedContent.indexOf(props.node.path)

  if (index > -1) {
    windowStateStore.directoriesShowingUnopenedContent.splice(index, 1)
    return
  }

  windowStateStore.directoriesShowingUnopenedContent.push(props.node.path)
  loadDirectoryContents(props.node.path)

  if (!windowStateStore.uncollapsedDirectories.includes(props.node.path)) {
    windowStateStore.uncollapsedDirectories.push(props.node.path)
  }
}

/**
 * Requests the file behind this row to be opened.
 *
 * @param  {boolean}  newTab  Whether to force the file into a new tab
 */
function openFile (newTab = false): void {
  emit('select-file', props.node.path, false)
  ipcRenderer.invoke('documents-provider', {
    command: 'open-file',
    payload: {
      path: props.node.path,
      windowId: props.windowId,
      leafId: documentTreeStore.lastLeafId,
      newTab,
      checkAgainstDisk: true, // Zettlr-LYH open-with disk check (R51)
      insertAfterActiveTab: true
    }
  } as DocumentManagerIPCAPI)
    .catch(error => console.error(error))
}

function handleClick (): void {
  if (props.node.type === 'folder') {
    toggleCollapsed()
  } else if (props.unopened) {
    // Files that have never been opened only open on a double click
    emit('select-file', props.node.path, true)
  } else {
    openFile()
  }
}

function handleDoubleClick (): void {
  if (props.node.type === 'file' && props.unopened) {
    openFile()
  }
}

/**
 * Chromium enters its middle-click autoscroll mode on mousedown, before the
 * mouseup that closes the tabs, so the middle button is stopped here, on file
 * and folder rows alike (R92, same as the tab bar since R34).
 *
 * @param  {MouseEvent}  event  The mousedown event
 */
function handleMouseDown (event: MouseEvent): void {
  if (event.button === 1) {
    event.preventDefault()
  }
}

/**
 * A press on the name of a file row, the grey rows and the scratch notes
 * included, may become a slow click rename if the row was selected already
 * (R101). Folder rows are left alone.
 *
 * @param  {MouseEvent}  event  The mousedown event on the name element
 */
function handleNameMouseDown (event: MouseEvent): void {
  if (props.node.type !== 'file' || nameEditing.value) {
    return
  }

  slowClickNameElement = event.currentTarget as HTMLElement|null
  slowClickRename.pointerDown({
    button: event.button,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    x: event.clientX,
    y: event.clientY,
    wasSelected: isSelected.value,
    windowFocused: windowHadFocus()
  })
}

function handleWindowFocus (): void {
  lastWindowFocusTime = Date.now()
}

/**
 * Whether the window had the focus before the current press. The press that
 * brings the window to the front arrives right after the focus event, so a
 * press within the double click time of that event does not count.
 *
 * @return  {boolean}  True if the window was focused already
 */
function windowHadFocus (): boolean {
  return document.hasFocus() && Date.now() - lastWindowFocusTime >= SLOW_CLICK_RENAME_DELAY
}

function handleSlowClickMouseMove (event: MouseEvent): void {
  slowClickRename.pointerMove(event.clientX, event.clientY)
}

/**
 * Hands the release of the left button to the slow click; it counts as inside
 * only on the pressed name element.
 *
 * @param  {MouseEvent}  event  The mouseup event anywhere in the window
 */
function handleSlowClickMouseUp (event: MouseEvent): void {
  if (event.button !== 0) {
    return
  }

  const inside = slowClickNameElement !== null && slowClickNameElement.contains(event.target as Node|null)
  slowClickRename.pointerUp(event.clientX, event.clientY, inside)
}

function cancelSlowClickRename (): void {
  slowClickRename.cancel()
}

/**
 * Listens to the window while a slow click is being followed: pointer moves
 * and the release, plus everything that ends it, namely another press, a key,
 * the start of a drag and the window losing the focus. The press, key and drag
 * listeners capture, so that a press elsewhere is seen even if it stops
 * propagation, and so that they do not see the press that has just added them.
 *
 * @param  {boolean}  active  True to start listening, false to stop
 */
function followWindowDuringSlowClick (active: boolean): void {
  if (active) {
    window.addEventListener('mousemove', handleSlowClickMouseMove)
    window.addEventListener('mouseup', handleSlowClickMouseUp)
    window.addEventListener('mousedown', cancelSlowClickRename, true)
    window.addEventListener('keydown', cancelSlowClickRename, true)
    window.addEventListener('dragstart', cancelSlowClickRename, true)
    window.addEventListener('blur', cancelSlowClickRename)
  } else {
    window.removeEventListener('mousemove', handleSlowClickMouseMove)
    window.removeEventListener('mouseup', handleSlowClickMouseUp)
    window.removeEventListener('mousedown', cancelSlowClickRename, true)
    window.removeEventListener('keydown', cancelSlowClickRename, true)
    window.removeEventListener('dragstart', cancelSlowClickRename, true)
    window.removeEventListener('blur', cancelSlowClickRename)
  }
}

/**
 * A middle click on a file row closes the tabs of that file in this window,
 * on release of the button like in the tab bar, which avoids the middle-click
 * paste on Linux (#2663). Selection, focus and the open history stay as they
 * are (R92).
 *
 * @param  {MouseEvent}  event  The mouseup event
 */
function handleMouseUp (event: MouseEvent): void {
  if (event.button !== 1) {
    return
  }

  event.preventDefault()
  if (props.node.type === 'file') {
    closeTabsOfThisFile().catch(error => console.error(error))
  }
}

/**
 * Closes the tab of this file in every editor pane of this window that has it
 * open, one pane after the other. Waiting for each close means the question
 * about unsaved changes only comes up for the last tab, and that the remaining
 * panes are left alone if the user cancels it. Pinned tabs stay open, as in
 * the tab bar. Unlike the Close item of the context menu, the file stays in
 * the open history and other windows are not affected.
 */
async function closeTabsOfThisFile (): Promise<void> {
  const panes = findPanesWithOpenFile(documentTreeStore.paneData, props.node.path)
    .filter(pane => !pane.pinned)

  for (const pane of panes) {
    const closed: boolean = await ipcRenderer.invoke('documents-provider', {
      command: 'close-file',
      payload: {
        path: pane.tabPath,
        windowId: props.windowId,
        leafId: pane.leafId
      }
    } as DocumentManagerIPCAPI)

    if (!closed) {
      return
    }
  }
}

/**
 * Resolves the descriptor for this row, looking it up in the workspace store
 * first and asking the main process only if that fails.
 *
 * @return  {Promise<AnyDescriptor|undefined>}  The descriptor, if there is one
 */
async function resolveDescriptor (): Promise<AnyDescriptor|undefined> {
  if (resolvedDescriptor.value !== undefined) {
    return resolvedDescriptor.value
  }

  const known = workspaceStore.descriptorMap.get(props.node.path)

  if (known !== undefined) {
    resolvedDescriptor.value = known
    return known
  }

  try {
    const descriptor: AnyDescriptor = await ipcRenderer.invoke('fsal', {
      command: 'get-descriptor',
      payload: props.node.path
    })
    resolvedDescriptor.value = descriptor
    return descriptor
  } catch (error) {
    console.error(`[HistoryTree] Could not retrieve a descriptor for "${props.node.path}"`, error)
    return undefined
  }
}

function handleContextMenu (event: MouseEvent): void {
  // Virtual folder rows have no descriptor of their own, so they offer no
  // context menu; only files do. The scratch notes below Unsaved Files count as
  // files: their menu acts on the real path of the scratch note (R103).
  if (props.node.type === 'folder' || displayTextElement.value === null) {
    return
  }

  event.preventDefault()

  resolveDescriptor().then(descriptor => {
    if (descriptor === undefined || descriptor.type === 'directory' || displayTextElement.value === null) {
      return
    }

    displayFileContext(event, descriptor, displayTextElement.value, clickedID => {
      handleContextMenuAction(clickedID)
    })
  }).catch(error => console.error(error))
}

function handleContextMenuAction (clickedID: string): void {
  switch (clickedID) {
    case 'new-tab':
      openFile(true)
      break
    case 'menu.rename_file':
      nameEditing.value = true
      break
    case 'menu.duplicate_file':
      ipcRenderer.invoke('application', {
        command: 'file-duplicate',
        payload: {
          path: props.node.path,
          windowId: props.windowId,
          leafId: documentTreeStore.lastLeafId
        }
      }).catch(error => console.error(error))
      break
    case 'menu.delete_file':
      ipcRenderer.invoke('application', {
        command: 'file-delete',
        payload: { path: props.node.path }
      }).catch(error => console.error(error))
      break
    case 'properties':
      showPopover.value = true
      break
    case 'menu.close_file':
      closeFile(props.node.path)
      break
  }
}

function finishNameEditing (newName: string): void {
  if (newName.trim() === '' || newName === displayLabel.value) {
    nameEditing.value = false
    return
  }

  ipcRenderer.invoke('application', {
    command: 'file-rename',
    payload: {
      path: props.node.path,
      name: newName
    }
  })
    .catch(error => console.error(error))
    .finally(() => { nameEditing.value = false })
}
</script>

<style lang="less">
body {
  div.history-tree-item-container {
    // The colour of everything that has never been opened. It has to be
    // clearly lighter than the regular text colour in both themes.
    --history-tree-unopened-color: var(--grey-4);
    --history-tree-ancestor-background: #e5e5e5;
    // The mask over the icon of a file with unsaved changes (R109), reddish
    // purple like the unsaved tab icon of Notepad++
    --history-tree-modified-mask-rgb: 200, 30, 120;
    --history-tree-modified-mask-alpha: 0.45;

    .tree-item.history-tree-item {
      align-items: center;

      // Clarity icons draw in the current colour, so laying the translucent
      // mask over their opaque pixels amounts to mixing it into that colour.
      // The selection and ancestor highlights leave the mask alone (R109).
      &.is-modified .toggle-icon cds-icon,
      &.is-modified .explorer-icon cds-icon {
        // Escaped, so that Less does not try to evaluate the colour functions
        color: ~"color-mix(in srgb, rgb(var(--history-tree-modified-mask-rgb)) calc(var(--history-tree-modified-mask-alpha) * 100%), currentColor)";
      }

      // The native Windows icon is a picture: a layer on top of it takes the
      // picture as alpha mask, so that transparent pixels stay untinted
      &.is-modified .explorer-icon {
        position: relative;

        &::after {
          content: '';
          position: absolute;
          inset: 0;
          pointer-events: none;
          background-color: ~"rgba(var(--history-tree-modified-mask-rgb), var(--history-tree-modified-mask-alpha))";
          -webkit-mask-image: var(--history-tree-modified-icon-mask, none);
          mask-image: var(--history-tree-modified-icon-mask, none);
          -webkit-mask-size: contain;
          mask-size: contain;
          -webkit-mask-repeat: no-repeat;
          mask-repeat: no-repeat;
          -webkit-mask-position: center;
          mask-position: center;
        }
      }

      // The second selector outranks the per-platform rules in TreeItem.vue
      // that colour every expanded folder row (up to 0,5,1 in dark mode);
      // without it an expanded ancestor would lose its grey background.
      &.selected-ancestor,
      &.selected-ancestor.directory:not(.collapsed) {
        background-color: var(--history-tree-ancestor-background);
      }

      &.unopened {
        color: var(--history-tree-unopened-color);

        cds-icon {
          color: var(--history-tree-unopened-color);
          opacity: 0.75;
        }
      }

      // The button that reveals the never opened contents sits at the far end
      // of the row. It carries the very same checkable button styling as the
      // icon that expands the folder itself, so that both states of a row are
      // read off in the same way.
      .unopened-content-toggle {
        margin-inline-start: auto;
        margin-inline-end: 8px;
        opacity: 0.45;

        &:hover, &.checked {
          opacity: 1;
        }
      }
    }
  }

  &.dark div.history-tree-item-container {
    --history-tree-unopened-color: var(--grey-3);
    --history-tree-ancestor-background: #454545;
    --history-tree-modified-mask-rgb: 255, 90, 170;
  }

  .history-tree.windows-explorer div.history-tree-item-container {
    font-family: var(--explorer-font-family);
    font-size: var(--explorer-font-size);

    .tree-item.history-tree-item {
      box-sizing: border-box;
      height: var(--explorer-row-height);
      min-height: var(--explorer-row-height);
      margin: 0;
      line-height: normal;

      // Explorer rows scroll normally, including expanded ancestors.
      &.directory:not(.collapsed) { position: relative; }

      .explorer-disclosure {
        width: var(--explorer-disclosure-width);
        height: var(--explorer-row-height);
        flex: 0 0 var(--explorer-disclosure-width);
        display: flex;
        align-items: center;
        justify-content: center;
        color: #858585;

        svg { width: var(--explorer-icon-size); height: var(--explorer-icon-size); }
        path { fill: none; stroke: currentColor; stroke-width: 1.25; }
        &.expanded svg { transform: rotate(90deg); }
        &.expandable { cursor: pointer; }
      }

      .explorer-icon {
        width: var(--explorer-icon-size);
        height: var(--explorer-icon-size);
        flex: 0 0 var(--explorer-icon-size);
        display: flex;
        align-items: center;
        justify-content: center;

        img, cds-icon { width: 100%; height: 100%; object-fit: contain; }
      }

      .display-text {
        min-width: 0;
        padding: 0;
        margin-left: var(--explorer-icon-text-gap);
        line-height: var(--explorer-row-height);
      }

      &.unopened .explorer-icon { opacity: 0.65; }
      .unopened-content-toggle { max-height: var(--explorer-icon-size); }
    }
  }

  &.dark .history-tree.windows-explorer .explorer-disclosure {
    color: #b8b8b8;
  }
}
</style>
