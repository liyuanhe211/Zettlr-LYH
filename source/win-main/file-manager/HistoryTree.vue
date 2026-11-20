<template>
  <div class="history-tree" v-bind:class="{ 'windows-explorer': usesWindowsAppearance }" v-bind:style="appearanceStyle">
    <!-- Zettlr-LYH (R96): the scratch notes open in this window, above every
    drive row -->
    <UnsavedFilesGroup
      v-if="unsavedFiles.length > 0"
      v-bind:files="unsavedFiles"
      v-bind:collapsed="unsavedFilesCollapsed"
      v-bind:filter-active="filterActive"
      v-bind:open-tabs-only="openTabsOnly === true"
      v-bind:active-item="activeItem"
      v-bind:window-id="windowId"
      v-bind:selected-file-path="selectedFilePath"
      v-bind:uses-windows-appearance="usesWindowsAppearance"
      v-bind:scratch-folder-path="scratchDirectory"
      v-on:toggle="toggleUnsavedFiles"
      v-on:select-file="selectFile"
    ></UnsavedFilesGroup>
    <HistoryTreeItem
      v-for="node in rootNodes"
      v-bind:key="node.path"
      v-bind:node="node"
      v-bind:depth="0"
      v-bind:unopened="false"
      v-bind:filter-active="filterActive"
      v-bind:open-tabs-only="openTabsOnly === true"
      v-bind:open-history-paths="openHistoryPathSet"
      v-bind:active-item="activeItem"
      v-bind:window-id="windowId"
      v-bind:selected-file-path="treeSelectedFilePath"
      v-bind:uses-windows-appearance="usesWindowsAppearance"
      v-on:select-file="selectFile"
    ></HistoryTreeItem>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        HistoryTree Vue Component
 * CVM-Role:        View
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Renders the Files section of the file manager as a tree of
 *                  the files the user has opened, grouped by the folders they
 *                  live in. Each level lists folders before files, by name.
 *                  The component also exposes the list of currently visible
 *                  rows so that FileTree.vue can keep its arrow key navigation
 *                  in sync with what is actually on screen, and it unfolds the
 *                  folder rows leading to the most recently opened files, the
 *                  active document and every file open as a tab in this
 *                  window, so that the documents the user is working on are
 *                  on screen from the moment the window opens (R16, R93).
 *                  Above every drive row it shows the Unsaved Files virtual
 *                  folder with the scratch notes open in this window (R96) and,
 *                  after those, the scratch notes with content that lie in the
 *                  scratch folder on disk without a tab (R144).
 *
 * END HEADER
 */

import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import HistoryTreeItem from './HistoryTreeItem.vue'
import UnsavedFilesGroup from './UnsavedFilesGroup.vue'
import { buildOpenHistoryTree, collectFoldersRevealingFiles } from 'source/common/util/open-history-tree'
import { useConfigStore, useDocumentTreeStore, useWindowStateStore } from 'source/pinia'
import { collectVisibleRows, selectedUnopenedPath } from './util/unopened-directory-contents'
import { compareExplorerNames, requestExplorerNameOrder } from './util/explorer-name-order'
import { explorerAppearance } from './util/explorer-appearance'
import {
  effectiveHistoryFileSelection,
  historySelectionPathsEqual,
  normalizeHistorySelectionPath
} from './util/history-tree-selection'
import { collectOpenTabPaths, selectFilesToReveal } from './util/open-tab-paths'
import {
  UNSAVED_FILES_PATH,
  collectUnsavedTabPaths,
  filterUnsavedTabPaths,
  isScratchNoteTabPath,
  mergeUnsavedFilePaths
} from './util/unsaved-tab-paths'
import getDocumentTitle from 'source/win-main/util/get-document-title'
import type { HistoryTreeNode } from 'source/common/util/open-history-tree'

/**
 * How many of the most recently opened files the tree keeps on screen, in
 * addition to the active document and the files open as tabs. The folder rows
 * leading to all of them are unfolded automatically (R16, R93).
 */
const REVEALED_RECENT_FILE_COUNT = 5

const props = defineProps<{
  // The open history, most recently opened file first. Already reduced to the
  // files that match the quick filter, if there is one.
  historyPaths: string[]
  // True while the user has typed something into the quick filter
  filterActive: boolean
  // The quick filter query, for filtering the scratch notes (R96)
  filterQuery?: string
  // The scratch notes in the scratch folder on disk, which Unsaved Files lists
  // after the scratch notes open as tabs unless they are blank (R144)
  scratchNotesOnDisk?: Array<{ path: string, blank: boolean }>
  // True in the Show Only Folders with Open Tabs mode (R87). historyPaths
  // then holds the files open as tabs in this window instead of the history.
  openTabsOnly?: boolean
  windowId: string
  activeItem?: string
}>()

const windowStateStore = useWindowStateStore()
const documentTreeStore = useDocumentTreeStore()
const configStore = useConfigStore()
const selectedTreePath = ref<string | null | undefined>()
const usesWindowsAppearance = computed(() => process.platform === 'win32' && explorerAppearance.source.value === 'windows')
const appearanceStyle = computed(() => {
  const metrics = explorerAppearance.metrics.value
  if (!usesWindowsAppearance.value || metrics === undefined) {return {}}
  return {
    '--explorer-icon-size': `${metrics.iconSize}px`,
    '--explorer-row-height': `${metrics.rowHeight}px`,
    // Half the native TreeView indent per level, as the user requested
    '--explorer-indent': `${metrics.indent / 2}px`,
    '--explorer-disclosure-width': `${metrics.disclosureWidth}px`,
    '--explorer-icon-text-gap': `${metrics.iconTextGap}px`,
    '--explorer-font-family': metrics.fontFamily,
    '--explorer-font-size': `${metrics.fontSize}px`
  }
})

/**
 * The configured scratch folder (R40), as the main process reads it.
 */
const scratchDirectory = computed<string>(() => {
  const configured: unknown = configStore.config.scratchNotesDirectory
  return typeof configured === 'string' ? configured : ''
})

/**
 * Every scratch note open as a tab in this window, in pane and tab order,
 * regardless of the quick filter (R96).
 */
const unsavedTabPaths = computed<string[]>(() => collectUnsavedTabPaths(documentTreeStore.paneData, scratchDirectory.value))

/**
 * Every scratch note Unsaved Files lists, regardless of the quick filter: those
 * open as tabs in this window first, then the scratch notes with content on disk
 * that have no tab, by file name (R144).
 */
const allUnsavedPaths = computed<string[]>(() => {
  return mergeUnsavedFilePaths(unsavedTabPaths.value, props.scratchNotesOnDisk ?? [])
})

/**
 * The scratch notes the Unsaved Files folder lists, with the text of their
 * tabs, reduced to those that match the quick filter.
 */
const unsavedFiles = computed<Array<{ path: string, label: string }>>(() => {
  const query = props.filterActive ? props.filterQuery ?? '' : ''
  return filterUnsavedTabPaths(allUnsavedPaths.value, query, filePath => getDocumentTitle(filePath))
    .map(filePath => ({ path: filePath, label: getDocumentTitle(filePath) }))
})

/**
 * The paths the tree is built from. Scratch notes are listed below Unsaved
 * Files only, so they never appear again below the scratch folder, which can
 * otherwise happen in the Show Only Folders with Open Tabs mode (R96).
 */
const treePaths = computed<string[]>(() => {
  return props.historyPaths.filter(filePath => !isScratchNoteTabPath(filePath, scratchDirectory.value))
})

// Register outside computed getters: rank publication invalidates the display
// computations, but never initiates another IPC request from those computations.
watch(treePaths, historyPaths => {
  const names = new Set<string>()
  const collectNames = (node: HistoryTreeNode): void => {
    if (node.type === 'file') {
      names.add(node.name)
    } else {
      for (const segment of node.segments) {
        names.add(segment)
      }
      node.children.forEach(collectNames)
    }
  }
  buildOpenHistoryTree(historyPaths).forEach(collectNames)
  requestExplorerNameOrder(names)
}, { immediate: true, deep: true })

const rootNodes = computed(() => buildOpenHistoryTree(treePaths.value, undefined, compareExplorerNames))

const openHistoryPathSet = computed(() => new Set(treePaths.value))

/**
 * The document the user is currently looking at, as far as this window knows.
 */
const activeFilePath = computed<string|undefined>(() => {
  return documentTreeStore.lastLeafActiveFile?.path
})

const selectedFilePath = computed(() => effectiveHistoryFileSelection(activeFilePath.value, selectedTreePath.value))

/**
 * The selection as the rows of the real folders see it. A selected scratch
 * note sits below Unsaved Files, so it marks no real folder as its ancestor.
 */
const treeSelectedFilePath = computed(() => {
  const selected = selectedFilePath.value
  return selected !== undefined && isScratchNoteTabPath(selected, scratchDirectory.value) ? undefined : selected
})

/**
 * Unsaved Files is folded only while its identity is missing from the
 * unfolded rows, which the window keeps for as long as the interface stays
 * loaded. Like every folder, it cannot be folded while a filter query or the
 * Show Only Folders with Open Tabs mode is active (R87, R96).
 */
const unsavedFilesCollapsed = computed(() => {
  if (props.filterActive || props.openTabsOnly) {
    return false
  }
  return !windowStateStore.uncollapsedDirectories.includes(UNSAVED_FILES_PATH)
})

function toggleUnsavedFiles (): void {
  if (props.openTabsOnly) {
    return
  }

  const index = windowStateStore.uncollapsedDirectories.indexOf(UNSAVED_FILES_PATH)
  if (index > -1) {
    windowStateStore.uncollapsedDirectories.splice(index, 1)
  } else {
    windowStateStore.uncollapsedDirectories.push(UNSAVED_FILES_PATH)
  }
}

/**
 * The scratch notes seen so far. Unsaved Files starts out unfolded, and it
 * unfolds again whenever a scratch note joins, so that a new scratch note is
 * visible at once (R96).
 */
let knownUnsavedIdentities: ReadonlySet<string> = new Set()

watch(allUnsavedPaths, paths => {
  const identities = new Set(paths.map(normalizeHistorySelectionPath))
  const hasNewScratchNote = [...identities].some(identity => !knownUnsavedIdentities.has(identity))
  knownUnsavedIdentities = identities

  if (hasNewScratchNote && !windowStateStore.uncollapsedDirectories.includes(UNSAVED_FILES_PATH)) {
    windowStateStore.uncollapsedDirectories.push(UNSAVED_FILES_PATH)
  }
}, { immediate: true })

/**
 * The rows of Unsaved Files that are on screen, in rendering order.
 */
const unsavedRows = computed<Array<[string, string]>>(() => {
  if (unsavedFiles.value.length === 0) {
    return []
  }

  const rows: Array<[string, string]> = [[ UNSAVED_FILES_PATH, 'directory' ]]
  if (!unsavedFilesCollapsed.value) {
    rows.push(...unsavedFiles.value.map(file => [ file.path, 'file' ] as [string, string]))
  }
  return rows
})

/**
 * The paths whose native icons the Windows Explorer appearance needs. Unsaved
 * Files is no path on disk; it borrows the icon of the scratch folder.
 */
function appearancePaths (rows: Array<[string, string]>): string[] {
  return rows.map(row => row[0] === UNSAVED_FILES_PATH ? scratchDirectory.value : row[0])
    .filter(rowPath => rowPath !== '')
}

function selectFile (path: string, unopened: boolean): void {
  selectedTreePath.value = path
  selectedUnopenedPath.value = unopened ? path : undefined
}

watch([ activeFilePath, () => documentTreeStore.lastLeafId ], () => {
  selectedTreePath.value = undefined
  selectedUnopenedPath.value = undefined
}, { flush: 'sync' })

/**
 * The files open as tabs in any editor pane of this window, each only once.
 * Files outside the open history have no row in this view and are ignored
 * further down.
 */
const openTabPaths = computed<string[]>(() => collectOpenTabPaths(documentTreeStore.paneData, treePaths.value))

/**
 * The identities of the files that are currently worth keeping on screen and
 * whose folder rows have already been unfolded once, and the active document
 * at that time. A file in this record is not unfolded again, so that a row the
 * user has folded up stays folded until a file below it is opened anew or
 * becomes the active document (R93).
 */
let revealedIdentities: ReadonlySet<string> = new Set()
let lastActiveFile: string|undefined

/**
 * Unfolds the folder rows that lead to the files worth keeping on screen: the
 * most recently opened files, the active document, and every file open as a
 * tab. Rows are only ever unfolded here, never folded.
 */
function revealFilesWorthKeepingOnScreen (): void {
  if (props.filterActive || props.openTabsOnly) {
    // Both unfold the whole tree anyway. The open tabs mode must not touch the
    // stored unfolded rows either, since they come back when it ends (R87).
    // The records stay as they are, so that afterwards only the files that
    // joined in the meantime are unfolded.
    return
  }

  const { reveal, nextRevealed } = selectFilesToReveal({
    historyPaths: treePaths.value,
    openTabPaths: openTabPaths.value,
    activeFile: activeFilePath.value,
    previousActiveFile: lastActiveFile,
    previouslyRevealed: revealedIdentities,
    recentCount: REVEALED_RECENT_FILE_COUNT
  })
  revealedIdentities = nextRevealed
  lastActiveFile = activeFilePath.value

  if (reveal.length === 0) {
    return
  }

  for (const folderPath of collectFoldersRevealingFiles(rootNodes.value, reveal)) {
    if (!windowStateStore.uncollapsedDirectories.includes(folderPath)) {
      windowStateStore.uncollapsedDirectories.push(folderPath)
    }
  }
}

// Comparison keys instead of deep watchers: the pane data changes on every
// switch of the active tab, but only a change of the paths matters here.
watch(
  [
    () => JSON.stringify(treePaths.value),
    () => JSON.stringify(openTabPaths.value),
    activeFilePath,
    () => props.filterActive,
    () => props.openTabsOnly
  ],
  revealFilesWorthKeepingOnScreen,
  { immediate: true }
)

/**
 * Every row that is currently on screen, as a `[path, type]` pair, in exactly
 * the order in which the rows are rendered.
 */
const visibleRows = computed<Array<[string, string]>>(() => {
  return [
    ...unsavedRows.value,
    ...collectVisibleRows(
      rootNodes.value,
      windowStateStore.uncollapsedDirectories,
      windowStateStore.directoriesShowingUnopenedContent,
      openHistoryPathSet.value,
      props.filterActive || props.openTabsOnly
    )
  ]
})

/**
 * The scratch note rows that are on screen, for the arrow key navigation of
 * FileTree.vue: their parent row is Unsaved Files, not the scratch folder.
 */
const unsavedFilePaths = computed<string[]>(() => {
  return unsavedRows.value.filter(row => row[0] !== UNSAVED_FILES_PATH).map(row => row[0])
})

watch(() => props.activeItem, path => {
  const row = visibleRows.value.find(row => historySelectionPathsEqual(row[0], path))
  selectedTreePath.value = path === undefined ? undefined : row !== undefined && row[1] !== 'directory' ? row[0] : null
  selectedUnopenedPath.value = undefined
}, { flush: 'sync' })

watch(visibleRows, rows => {
  const selectedPath = selectedTreePath.value
  if (typeof selectedPath === 'string' && !rows.some(row => historySelectionPathsEqual(row[0], selectedPath))) {
    selectedTreePath.value = undefined
    selectedUnopenedPath.value = undefined
  }
  if (process.platform === 'win32') {explorerAppearance.request(appearancePaths(rows))}
}, { immediate: true })

let lastAppearanceRefresh = 0
function refreshAppearance (): void {
  if (process.platform !== 'win32' || Date.now() - lastAppearanceRefresh < 5000) {return}
  lastAppearanceRefresh = Date.now()
  explorerAppearance.refresh(appearancePaths(visibleRows.value))
}
onMounted(() => { window.addEventListener('focus', refreshAppearance) })
onUnmounted(() => { window.removeEventListener('focus', refreshAppearance) })

defineExpose({ visibleRows, unsavedFilePaths })
</script>

<style lang="less">
body {
  div.history-tree {
    position: relative;
  }
}
</style>
