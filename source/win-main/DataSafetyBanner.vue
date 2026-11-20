<template>
  <!--
    Zettlr-LYH data loss prevention (R173, specification C21 section 7 item
    4): the banner above the editor area. One line per data safety incident
    (save failed, undo history not recorded, input not delivered in time), and
    one line for the files with recoverable input that are not open. Without
    anything to show, the banner is not rendered and takes no space.
  -->
  <div
    v-if="notices.length > 0 || recoverableFileCount > 0"
    class="data-safety-banner"
  >
    <div
      v-for="notice in notices"
      v-bind:key="notice.id"
      class="data-safety-notice"
      v-bind:data-kind="notice.kind"
      v-bind:data-path="notice.filePath"
      role="alert"
    >
      <span class="data-safety-text" v-bind:title="notice.filePath">{{ formatNoticeText(notice) }}</span>
      <button
        v-if="notice.kind === 'save-failed' && notice.filePath !== undefined"
        type="button"
        class="data-safety-button data-safety-retry"
        v-bind:disabled="retryingNoticeIds.has(notice.id)"
        v-on:click="retrySave(notice.id)"
      >
        {{ retryingNoticeIds.has(notice.id) ? retryingLabel : retryLabel }}
      </button>
      <button
        type="button"
        class="data-safety-button data-safety-dismiss"
        v-on:click="dataSafetyStore.dismissNotice(notice.id)"
      >
        {{ dismissLabel }}
      </button>
    </div>
    <div
      v-if="recoverableFileCount > 0"
      class="data-safety-notice data-safety-recoverable"
      role="status"
    >
      <span class="data-safety-text">{{ formatRecoverableFilesText(recoverableFileCount) }}</span>
      <button
        type="button"
        class="data-safety-button data-safety-show"
        v-bind:aria-expanded="recoverableFilesShown"
        v-on:click="recoverableFilesShown = !recoverableFilesShown"
      >
        {{ showLabel }}
      </button>
      <ul v-if="recoverableFilesShown" class="data-safety-recoverable-files">
        <li v-for="filePath in recoverableFilesNotOpen" v-bind:key="filePath">
          <button
            type="button"
            class="data-safety-recoverable-file"
            v-bind:title="filePath"
            v-bind:data-path="filePath"
            v-on:click="openRecoverableFile(filePath)"
          >
            {{ pathBasename(filePath) }}
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        DataSafetyBanner
 * CVM-Role:        View
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH data loss prevention (R173): shows the incident
 *                  notices and the recoverable files of the data safety store
 *                  above the editor area of a pane. Every pane shows the same
 *                  notices; dismissing one removes it from all panes.
 *
 * END HEADER
 */

import { computed, ref, watch } from 'vue'
import { useDocumentTreeStore } from 'source/pinia'
import { formatNoticeText, formatRecoverableFilesText, useDataSafetyStore } from 'source/pinia/data-safety-store'
import { pathBasename } from '@common/util/renderer-path-polyfill'
import { trans } from 'source/common/i18n-renderer'
import type { DocumentManagerIPCAPI } from 'source/app/service-providers/documents'

const ipcRenderer = window.ipc

const props = defineProps<{
  leafId: string
  windowId: string
}>()

const dataSafetyStore = useDataSafetyStore()
const documentTreeStore = useDocumentTreeStore()

const dismissLabel = trans('Dismiss')
const showLabel = trans('Show')
const retryLabel = trans('Retry')
const retryingLabel = trans('Retrying…')

const notices = computed(() => dataSafetyStore.notices)
const retryingNoticeIds = computed(() => dataSafetyStore.retryingNoticeIds)
const recoverableFileCount = computed(() => dataSafetyStore.recoverableFileCount)
const recoverableFilesNotOpen = computed(() => dataSafetyStore.recoverableFilesNotOpen)
const recoverableFilesShown = ref(false)

// The store lists only the recoverable files that are not open, so it has to
// know the open files of the whole window (every pane reports the same set)
watch(
  () => documentTreeStore.paneData.flatMap(leaf => leaf.openFiles.map(file => file.path)),
  paths => { dataSafetyStore.setOpenFilePaths(paths) },
  { immediate: true }
)

watch(recoverableFileCount, count => {
  if (count === 0) {
    recoverableFilesShown.value = false
  }
})

/**
 * Saves the file of a save-failed notice again; the store removes the notice
 * if the save succeeds.
 *
 * @param  {string}  id  The ID of the notice
 */
function retrySave (id: string): void {
  dataSafetyStore.retrySave(id).catch(err => console.error(err))
}

/**
 * Opens a file with recoverable input in a new tab of this pane; the editor
 * then offers to restore the input.
 *
 * @param  {string}  filePath  The absolute path of the file
 */
function openRecoverableFile (filePath: string): void {
  ipcRenderer.invoke('documents-provider', {
    command: 'open-file',
    payload: { path: filePath, windowId: props.windowId, leafId: props.leafId, newTab: true }
  } as DocumentManagerIPCAPI)
    .catch(err => console.error(err))
}
</script>

<style lang="less">
// The colours are the warning colours of the window (generic.css), which also
// switch for the dark mode. The look is provisional, until the user confirms it.
body .data-safety-banner {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  box-sizing: border-box;
  background-color: var(--zettlr-warning-bg);
  border-bottom: 1px solid var(--zettlr-warning-color);
  border-left: 4px solid var(--zettlr-warning-color);
  font-family: system-ui, "Microsoft YaHei UI", sans-serif;
  font-size: 12px;

  .data-safety-notice {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px 12px;
    padding: 4px 10px 5px;

    & + .data-safety-notice {
      border-top: 1px solid var(--zettlr-warning-color);
    }
  }

  .data-safety-text {
    flex: 0 1 auto;
    min-width: 0;
    font-weight: 600;
  }

  button.data-safety-button,
  button.data-safety-recoverable-file {
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
    font-family: inherit;
    font-size: 12px;
    font-weight: normal;
    line-height: 1;
    cursor: pointer;

    &:hover { border-color: #3b82f6; }
    &:focus-visible { outline: 2px solid #3b82f6; outline-offset: 1px; }
  }

  .data-safety-recoverable-files {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    flex-basis: 100%;
    margin: 0;
    padding: 0;
    list-style: none;
  }
}

body.dark .data-safety-banner {
  button.data-safety-button,
  button.data-safety-recoverable-file {
    background-color: rgb(50, 50, 50);
    border-color: rgb(90, 90, 90);
    color: rgb(215, 215, 215);

    &:hover { border-color: #5b9bf0; }
    &:focus-visible { outline-color: #5b9bf0; }
  }
}
</style>
