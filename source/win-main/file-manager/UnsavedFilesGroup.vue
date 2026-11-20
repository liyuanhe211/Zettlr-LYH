<template>
  <div class="tree-item-container history-tree-item-container unsaved-files-group">
    <div
      v-bind:class="{
        'tree-item': true,
        'history-tree-item': true,
        'unsaved-files-folder': true,
        'collapsed': collapsed,
        'directory': true,
        'selected-ancestor': isSelectedAncestor,
        'active': activeItem === UNSAVED_FILES_PATH
      }"
      v-bind:data-path="UNSAVED_FILES_PATH"
      v-bind:style="{
        'padding-left': usesWindowsAppearance ? 'calc(0 * var(--explorer-indent))' : `${TREE_INDENT_BASE}px`
      }"
      v-on:click.stop="emit('toggle')"
      v-on:contextmenu="handleContextMenu"
      v-on:mousedown="handleMouseDown"
    >
      <template v-if="usesWindowsAppearance">
        <span
          class="explorer-disclosure expandable"
          v-bind:class="{ expanded: !collapsed }"
          role="button"
          v-bind:aria-expanded="!collapsed"
          v-bind:aria-label="collapsed ? expandLabel : collapseLabel"
          v-on:click.stop="emit('toggle')"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M 6 4 L 10 8 L 6 12"></path></svg>
        </span>
        <span class="explorer-icon" aria-hidden="true">
          <img
            v-if="nativeFolderIcon !== null" v-bind:src="nativeFolderIcon" alt=""
            draggable="false"
          >
          <cds-icon v-else v-bind:shape="folderIcon" role="presentation"></cds-icon>
        </span>
      </template>
      <!-- The folder icon doubles as a checkable button, as on every folder row
      of the open history tree -->
      <span
        v-else
        v-bind:class="{ 'expand-toggle': true, 'checked': !collapsed }"
        role="button"
        v-bind:aria-expanded="!collapsed"
        v-bind:title="collapsed ? expandLabel : collapseLabel"
        v-on:click.stop="emit('toggle')"
      >
        <cds-icon v-bind:shape="folderIcon" role="presentation"></cds-icon>
      </span>
      <span class="display-text" v-bind:title="label">{{ label }}</span>
    </div>

    <template v-if="!collapsed">
      <HistoryTreeItem
        v-for="node in fileNodes"
        v-bind:key="node.path"
        v-bind:node="node"
        v-bind:depth="1"
        v-bind:unopened="false"
        v-bind:filter-active="filterActive"
        v-bind:open-tabs-only="openTabsOnly"
        v-bind:open-history-paths="noHistoryPaths"
        v-bind:active-item="activeItem"
        v-bind:window-id="windowId"
        v-bind:selected-file-path="selectedFilePath"
        v-bind:uses-windows-appearance="usesWindowsAppearance"
        v-on:select-file="(path, unopened) => emit('select-file', path, unopened)"
      ></HistoryTreeItem>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        UnsavedFilesGroup Vue Component
 * CVM-Role:        View
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Renders the Unsaved Files virtual folder at the top of the
 *                  Files section and, below it, one row per scratch note open
 *                  in this window (R96). The folder row is not a folder on disk:
 *                  it reads nothing and has no button for never opened
 *                  contents. Its context menu offers three items: New Unsaved
 *                  File, Copy path and Reveal in the file browser, the latter
 *                  two acting on the real scratch folder, never on the reserved
 *                  identity of the row (R103). The scratch note rows are regular
 *                  file rows of the open history tree with the file context
 *                  menu.
 *
 * END HEADER
 */

import { computed } from 'vue'
import HistoryTreeItem from './HistoryTreeItem.vue'
import { trans } from 'source/common/i18n-renderer'
import { useDocumentTreeStore } from 'source/pinia'
import showPopupMenu, { type AnyMenuItem } from 'source/common/modules/window-register/application-menu-helper'
import type { WindowControlsIPCAPI } from 'source/app/service-providers/windows'
import { UNSAVED_FILES_PATH } from './util/unsaved-tab-paths'
import { TREE_INDENT_BASE } from './util/tree-indentation'
import { explorerAppearance } from './util/explorer-appearance'
import { historySelectionPathsEqual } from './util/history-tree-selection'
import type { HistoryTreeFileNode } from 'source/common/util/open-history-tree'

const props = defineProps<{
  // The scratch notes to list, each with the text of its tab
  files: Array<{ path: string, label: string }>
  collapsed: boolean
  filterActive: boolean
  openTabsOnly?: boolean
  windowId: string
  activeItem?: string
  selectedFilePath?: string
  usesWindowsAppearance?: boolean
  // The real scratch folder on disk. Its native icon stands in for the folder
  // icon of this row in the Windows Explorer appearance, and the Copy path and
  // Reveal items of the context menu act on it (R103)
  scratchFolderPath?: string
}>()

const emit = defineEmits<{
  'toggle': []
  'select-file': [path: string, unopened: boolean]
}>()

const ipcRenderer = window.ipc
const documentTreeStore = useDocumentTreeStore()

const label = trans('Unsaved Files')
const expandLabel = trans('Show unsaved files')
const collapseLabel = trans('Hide unsaved files')

// Scratch notes are never part of the open history
const noHistoryPaths = new Set<string>()

const fileNodes = computed<HistoryTreeFileNode[]>(() => props.files.map(file => ({
  type: 'file',
  path: file.path,
  name: file.label,
  recency: Number.MAX_SAFE_INTEGER
})))

const folderIcon = computed(() => props.collapsed ? 'folder' : 'folder-open')

const nativeFolderIcon = computed(() => {
  if (props.scratchFolderPath === undefined || props.scratchFolderPath === '') {
    return null
  }
  return explorerAppearance.icons.value.get(props.scratchFolderPath) ?? null
})

const isSelectedAncestor = computed(() => {
  return props.files.some(file => historySelectionPathsEqual(file.path, props.selectedFilePath))
})

/**
 * Stops Chromium's middle-click autoscroll mode, as on every other row (R92).
 * A middle click on this row does nothing else.
 *
 * @param  {MouseEvent}  event  The mousedown event
 */
function handleMouseDown (event: MouseEvent): void {
  if (event.button === 1) {
    event.preventDefault()
  }
}

/**
 * The real folder the scratch notes live in, if the configuration names one.
 * The context menu acts on this and never on the reserved identity of the row,
 * which stands for no path on disk (R103).
 *
 * @return  {string|undefined}  The scratch folder, or undefined without one
 */
function realScratchFolder (): string|undefined {
  return props.scratchFolderPath !== undefined && props.scratchFolderPath !== ''
    ? props.scratchFolderPath
    : undefined
}

/**
 * Opens the small context menu of this row: a new scratch note, and the two
 * items that deal with the scratch folder (R103).
 *
 * @param  {MouseEvent}  event  The contextmenu event
 */
function handleContextMenu (event: MouseEvent): void {
  event.preventDefault()

  const hasScratchFolder = realScratchFolder() !== undefined
  const revealLabel = process.platform === 'darwin'
    ? trans('Reveal in Finder')
    : process.platform === 'win32' ? trans('Reveal in Explorer') : trans('Reveal in File Browser')

  const template: AnyMenuItem[] = [
    {
      label: trans('New Unsaved File'),
      id: 'new-unsaved-file',
      type: 'normal'
    },
    {
      label: trans('Copy path'),
      id: 'menu.copy_path',
      type: 'normal',
      enabled: hasScratchFolder
    },
    {
      label: revealLabel,
      id: 'menu.show_file',
      type: 'normal',
      enabled: hasScratchFolder
    }
  ]

  showPopupMenu({ x: event.clientX, y: event.clientY }, template, handleContextMenuAction)
}

function handleContextMenuAction (clickedID: string): void {
  const scratchFolder = realScratchFolder()

  switch (clickedID) {
    case 'new-unsaved-file':
      // Without path and name this is the very call of Ctrl+N, which creates a
      // scratch note; the window and editor pane make it open here
      ipcRenderer.invoke('application', {
        command: 'file-new',
        payload: { windowId: props.windowId, leafId: documentTreeStore.lastLeafId }
      }).catch(error => console.error(error))
      break
    case 'menu.copy_path':
      if (scratchFolder !== undefined) {
        navigator.clipboard.writeText(scratchFolder).catch(error => console.error(error))
      }
      break
    case 'menu.show_file':
      if (scratchFolder !== undefined) {
        ipcRenderer.send('window-controls', {
          command: 'show-item-in-folder',
          payload: { itemPath: scratchFolder }
        } as WindowControlsIPCAPI)
      }
      break
  }
}
</script>
