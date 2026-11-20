<template>
  <WindowChrome
    title="Recent Files" v-bind:titlebar="true" v-bind:menubar="false"
    v-bind:disable-vibrancy="true"
  >
    <main class="recent-files">
      <label for="recent-files-search">Search</label>
      <input
        id="recent-files-search" v-model="searchQuery" type="search"
        placeholder="Search full paths" autofocus
      >
      <p v-if="errorMessage !== ''" class="error-message" role="alert">
        {{ errorMessage }}
      </p>
      <p v-if="loading" role="status">
        Loading recent files…
      </p>
      <p v-else-if="paths.length === 0" role="status">
        No recent files.
      </p>
      <p v-else-if="visiblePaths.length === 0" role="status">
        No matching recent files.
      </p>
      <ul v-else class="recent-files-list" aria-label="Recent files">
        <li v-for="path in visiblePaths" v-bind:key="path">
          <button
            type="button" class="recent-file"
            v-bind:aria-pressed="selectedPath === path" v-bind:title="path"
            v-on:click="selectPath(path)" v-on:focus="selectPath(path)"
            v-on:dblclick="openPath(path)"
          >
            <span class="file-name">{{ path.split(/[\\/]/).pop() }}</span>
            <span class="file-path">{{ path }}</span>
          </button>
        </li>
      </ul>
      <footer>
        <button
          type="button" class="clear-history-button"
          v-bind:disabled="paths.length === 0 || clearing"
          v-on:click="clearHistory"
        >
          Clear History…
        </button>
        <span role="status" class="recent-files-count">{{ visiblePaths.length }} of {{ paths.length }} recent files</span>
        <button
          type="button" class="open-button"
          v-bind:disabled="selectedPath === null || opening"
          v-on:click="openSelected"
        >
          {{ opening ? 'Opening…' : 'Open' }}
        </button>
      </footer>
    </main>
  </WindowChrome>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import WindowChrome from '@common/vue/window/WindowChrome.vue'
import {
  RECENT_FILES_CHANNEL, RECENT_FILES_UPDATED_CHANNEL,
  type RecentFilesClearResult, type RecentFilesOpenResult, type RecentFilesRequest,
  type RecentFilesSnapshot
} from '@dts/common/recent-files'
import { retainRecentSelection, searchRecentPaths } from './history'

const paths = ref<string[]>([])
const searchQuery = ref('')
const selectedPath = ref<string|null>(null)
const loading = ref(true)
const opening = ref(false)
const clearing = ref(false)
const errorMessage = ref('')
const visiblePaths = computed(() => searchRecentPaths(paths.value, searchQuery.value))
const ipcRenderer = window.ipc
let disposed = false
let updateCount = 0
let stopUpdates: (() => void)|undefined
let stopShortcuts: (() => void)|undefined

watch(visiblePaths, currentPaths => {
  selectedPath.value = retainRecentSelection(currentPaths, selectedPath.value, process.platform === 'win32')
}, { flush: 'sync' })

function selectPath (path: string): void {
  selectedPath.value = path
}

function applySnapshot (snapshot: RecentFilesSnapshot): void {
  paths.value = snapshot.paths.slice()
  loading.value = false
}

async function loadHistory (): Promise<void> {
  const requestedUpdateCount = updateCount
  const request: RecentFilesRequest = { command: 'get-history' }
  try {
    const snapshot: RecentFilesSnapshot = await ipcRenderer.invoke(RECENT_FILES_CHANNEL, request)
    if (!disposed && requestedUpdateCount === updateCount) {
      applySnapshot(snapshot)
    }
  } catch (error) {
    if (!disposed && requestedUpdateCount === updateCount) {
      errorMessage.value = 'Unable to load recent files. Please reopen this window to try again.'
      loading.value = false
    }
  }
}

async function openPath (path: string): Promise<void> {
  if (disposed || opening.value || !visiblePaths.value.includes(path)) {
    return
  }
  selectedPath.value = path
  opening.value = true
  errorMessage.value = ''
  const request: RecentFilesRequest = { command: 'open-file', payload: { path } }
  try {
    const result: RecentFilesOpenResult = await ipcRenderer.invoke(RECENT_FILES_CHANNEL, request)
    if (!disposed && !result.success) {
      errorMessage.value = result.error ?? 'Unable to open this recent file.'
    }
  } catch (error) {
    if (!disposed) {
      errorMessage.value = 'Unable to open this recent file. Please try again.'
    }
  } finally {
    if (!disposed) {
      opening.value = false
    }
  }
}

function openSelected (): void {
  if (selectedPath.value !== null) {
    void openPath(selectedPath.value)
  }
}

// Zettlr-LYH (R97): the main process asks for confirmation and clears the
// history; the list is reloaded after a confirmed clear (the provider's update
// push carries the same empty snapshot).
async function clearHistory (): Promise<void> {
  if (disposed || clearing.value || paths.value.length === 0) {
    return
  }
  clearing.value = true
  errorMessage.value = ''
  const request: RecentFilesRequest = { command: 'clear-history' }
  try {
    const result: RecentFilesClearResult = await ipcRenderer.invoke(RECENT_FILES_CHANNEL, request)
    if (!disposed && result.cleared) {
      await loadHistory()
    }
  } catch (error) {
    if (!disposed) {
      errorMessage.value = 'Unable to clear the recent files history. Please try again.'
    }
  } finally {
    if (!disposed) {
      clearing.value = false
    }
  }
}

function closeWindow (): void {
  ipcRenderer.send('window-controls', { command: 'win-close' })
}

function handleKeydown (event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeWindow()
  } else if (event.key === 'Enter') {
    // Prevent a focused button's native click from opening the file twice.
    event.preventDefault()
    if (!event.repeat) {
      openSelected()
    }
  }
}

onMounted(() => {
  stopUpdates = ipcRenderer.on(RECENT_FILES_UPDATED_CHANNEL, (event, snapshot: RecentFilesSnapshot) => {
    if (!disposed) {
      updateCount++
      applySnapshot(snapshot)
    }
  })
  stopShortcuts = ipcRenderer.on('shortcut', (event, shortcut: string) => {
    if (shortcut === 'close-window') {
      closeWindow()
    }
  })
  window.addEventListener('keydown', handleKeydown)
  void loadHistory()
})

onBeforeUnmount(() => {
  disposed = true
  stopUpdates?.()
  stopShortcuts?.()
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<style scoped>
.recent-files {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  min-height: 0;
  padding: 16px;
}

input { flex-shrink: 0; width: 100%; box-sizing: border-box; padding: 8px; }
.recent-files-list { flex: 1; overflow-y: auto; min-height: 0; padding: 0; margin: 0; list-style: none; }
.recent-file { display: block; text-align: left; width: 100%; padding: 10px; border: 1px solid transparent; background: transparent; color: inherit; }
.recent-file[aria-pressed="true"] { background: var(--blue-selection); border-color: var(--blue-0); }
.file-name { display: block; font-weight: 600; }
.file-path { display: block; overflow-wrap: anywhere; opacity: 0.8; }
.error-message { color: var(--fg-error); background: var(--bg-error); padding: 8px; margin: 0; }
footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: auto; }
.open-button { padding: 6px 20px; }
.clear-history-button { padding: 6px 12px; }

:global(body.dark) .recent-file[aria-pressed="true"] { background: var(--blue-selection-dark); }
</style>
