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
        'active': activeItem === node.path
      }"
      v-bind:data-path="node.path"
      v-bind:style="{
        'padding-left': `${depth * TREE_INDENT_PER_LEVEL + TREE_INDENT_BASE}px`
      }"
      v-on:click.stop="handleClick"
      v-on:dblclick.stop="handleDoubleClick"
      v-on:contextmenu="handleContextMenu"
    >
      <!-- First: on a folder that has children, the folder icon doubles as a
      checkable button that collapses and uncollapses the whole node. Whether
      the button is checked, not the direction of an angle, is what tells the
      user that the folder is expanded. -->
      <span
        v-if="isFolder && hasChildren"
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
      This is fully independent of the angle in front of the row. -->
      <span
        v-if="isFolder"
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
        v-for="child in historyChildren"
        v-bind:key="child.path"
        v-bind:node="child"
        v-bind:depth="depth + 1"
        v-bind:unopened="false"
        v-bind:filter-active="filterActive"
        v-bind:open-history-paths="openHistoryPaths"
        v-bind:active-item="activeItem"
        v-bind:window-id="windowId"
      ></HistoryTreeItem>
      <HistoryTreeItem
        v-for="child in unopenedChildren"
        v-bind:key="child.descriptor.path"
        v-bind:node="child.node"
        v-bind:descriptor="child.descriptor"
        v-bind:depth="depth + 1"
        v-bind:unopened="true"
        v-bind:filter-active="filterActive"
        v-bind:open-history-paths="openHistoryPaths"
        v-bind:active-item="activeItem"
        v-bind:window-id="windowId"
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
 *                  that was read from disk on demand.
 *
 * END HEADER
 */

import { computed, nextTick, ref, watch } from 'vue'
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
  getHistoryChildPaths,
  getUnopenedChildren,
  hasDirectoryContents,
  loadDirectoryContents,
  selectedUnopenedPath
} from './util/unopened-directory-contents'
import { TREE_INDENT_BASE, TREE_INDENT_PER_LEVEL } from './util/tree-indentation'

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
  // Every path of the open history, for filtering the grey rows
  openHistoryPaths: Set<string>
  windowId: string
  // The descriptor behind a grey row; history rows do not carry one
  descriptor?: AnyDescriptor
  activeItem?: string
}>()

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

const isCollapsed = computed(() => {
  if (props.filterActive) {
    return false // A filter query uncollapses the entire tree
  }

  return !windowStateStore.uncollapsedDirectories.includes(props.node.path)
})

const showsUnopenedContent = computed(() => {
  return windowStateStore.directoriesShowingUnopenedContent.includes(props.node.path)
})

const historyChildren = computed<HistoryTreeNode[]>(() => {
  return props.node.type === 'folder' ? props.node.children : []
})

const unopenedChildren = computed(() => {
  if (props.node.type !== 'folder' || !showsUnopenedContent.value || props.filterActive) {
    return []
  }

  return getUnopenedChildren(
    props.node.path,
    getHistoryChildPaths(props.node),
    props.openHistoryPaths
  )
})

const hasChildren = computed(() => {
  return historyChildren.value.length > 0 || unopenedChildren.value.length > 0
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

const isSelected = computed(() => {
  if (props.node.type === 'folder') {
    return false
  } else if (props.unopened) {
    return selectedUnopenedPath.value === props.node.path
  } else {
    return documentTreeStore.lastLeafActiveFile?.path === props.node.path
  }
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

// The contents of a directory are read from disk the first time the user asks
// for its never opened contents, and again if the file system watcher has
// invalidated the cached listing in the meantime.
watch(
  [ showsUnopenedContent, () => props.node.path, () => hasDirectoryContents(props.node.path) ],
  () => {
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
 * workspace tree uses.
 */
function toggleCollapsed (): void {
  if (props.node.type !== 'folder') {
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
  ipcRenderer.invoke('documents-provider', {
    command: 'open-file',
    payload: {
      path: props.node.path,
      windowId: props.windowId,
      leafId: documentTreeStore.lastLeafId,
      newTab
    }
  } as DocumentManagerIPCAPI)
    .catch(error => console.error(error))
}

function handleClick (): void {
  if (props.node.type === 'folder') {
    toggleCollapsed()
  } else if (props.unopened) {
    // Files that have never been opened only open on a double click
    selectedUnopenedPath.value = props.node.path
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
  // context menu; only files do.
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

    .tree-item.history-tree-item {
      align-items: center;

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
  }
}
</style>
