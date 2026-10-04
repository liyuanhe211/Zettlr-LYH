<template>
  <div class="history-tree">
    <HistoryTreeItem
      v-for="node in rootNodes"
      v-bind:key="node.path"
      v-bind:node="node"
      v-bind:depth="0"
      v-bind:unopened="false"
      v-bind:filter-active="filterActive"
      v-bind:open-history-paths="openHistoryPathSet"
      v-bind:active-item="activeItem"
      v-bind:window-id="windowId"
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
 *                  live in. The most recently opened file sorts to the top.
 *                  The component also exposes the list of currently visible
 *                  rows so that FileTree.vue can keep its arrow key navigation
 *                  in sync with what is actually on screen, and it unfolds the
 *                  folder rows leading to the most recently opened files, so
 *                  that the document the user is working on is on screen from
 *                  the moment the window opens.
 *
 * END HEADER
 */

import { computed, watch } from 'vue'
import HistoryTreeItem from './HistoryTreeItem.vue'
import { buildOpenHistoryTree, collectFoldersRevealingFiles } from 'source/common/util/open-history-tree'
import { useDocumentTreeStore, useWindowStateStore } from 'source/pinia'
import { collectVisibleRows } from './util/unopened-directory-contents'

/**
 * How many of the most recently opened files the tree keeps on screen. The
 * folder rows leading to them are unfolded automatically, which is what makes
 * the current document visible right after the window opens.
 */
const REVEALED_RECENT_FILE_COUNT = 5

const props = defineProps<{
  // The open history, most recently opened file first. Already reduced to the
  // files that match the quick filter, if there is one.
  historyPaths: string[]
  // True while the user has typed something into the quick filter
  filterActive: boolean
  windowId: string
  activeItem?: string
}>()

const windowStateStore = useWindowStateStore()
const documentTreeStore = useDocumentTreeStore()

const rootNodes = computed(() => buildOpenHistoryTree(props.historyPaths))

const openHistoryPathSet = computed(() => new Set(props.historyPaths))

/**
 * The document the user is currently looking at, as far as this window knows.
 */
const activeFilePath = computed<string|undefined>(() => {
  return documentTreeStore.lastLeafActiveFile?.path
})

/**
 * The files the tree keeps on screen: the most recently opened ones, plus the
 * current document in the rare case it has dropped out of that group (a file
 * inside a workspace is not part of the open history at all, and contributes
 * nothing here). With no document open, the group starts at the file that was
 * opened last, which is what reveals it.
 */
const filesToReveal = computed<string[]>(() => {
  const recentFiles = props.historyPaths.slice(0, REVEALED_RECENT_FILE_COUNT)
  const currentFile = activeFilePath.value

  if (currentFile !== undefined && !recentFiles.includes(currentFile)) {
    recentFiles.push(currentFile)
  }

  return recentFiles
})

/**
 * Unfolds the folder rows that lead to the files worth keeping on screen. Rows
 * are only ever unfolded here: a row the user has folded up stays that way
 * until the set of files to reveal changes again.
 */
function revealFilesWorthKeepingOnScreen (): void {
  if (props.filterActive) {
    return // A filter query unfolds the whole tree anyway
  }

  for (const folderPath of collectFoldersRevealingFiles(rootNodes.value, filesToReveal.value)) {
    if (!windowStateStore.uncollapsedDirectories.includes(folderPath)) {
      windowStateStore.uncollapsedDirectories.push(folderPath)
    }
  }
}

watch(
  [ rootNodes, filesToReveal, () => props.filterActive ],
  revealFilesWorthKeepingOnScreen,
  { immediate: true }
)

/**
 * Every row that is currently on screen, as a `[path, type]` pair, in exactly
 * the order in which the rows are rendered.
 */
const visibleRows = computed<Array<[string, string]>>(() => {
  return collectVisibleRows(
    rootNodes.value,
    windowStateStore.uncollapsedDirectories,
    windowStateStore.directoriesShowingUnopenedContent,
    openHistoryPathSet.value,
    props.filterActive
  )
})

defineExpose({ visibleRows })
</script>

<style lang="less">
body {
  div.history-tree {
    position: relative;
  }
}
</style>
