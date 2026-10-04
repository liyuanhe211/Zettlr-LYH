/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        useWindowState
 * CVM-Role:        Model
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This model manages the state for any given main window, i.e.
 *                  values that represent volatile configuration of the window
 *                  UI or UX without affecting other state managers.
 *
 * END HEADER
 */

import { defineStore } from 'pinia'
import type { DocumentInfo } from 'source/common/modules/markdown-editor'
import type { ToCEntry } from 'source/common/modules/markdown-editor/plugins/toc-field'
import { computed, ref, watch, type Ref } from 'vue'
import { type WritingTarget } from '@providers/targets'
import type { AssetsProviderIPCAPI } from 'source/app/service-providers/assets'
import type { SearchResultWrapper } from 'source/win-main/GlobalSearch.vue'

const ipcRenderer = window.ipc

/**
 * Where the list of directories that display their never opened contents in the
 * open history tree is persisted. That state has to survive a restart, so it
 * goes into the renderer's local storage -- never into the Windows registry.
 */
const UNOPENED_CONTENT_STORAGE_KEY = 'zettlr-history-tree-directories-showing-unopened-content'

/**
 * Reads the persisted list of directories that display their never opened
 * contents. Returns an empty list if nothing has been persisted yet, or if the
 * local storage is unavailable.
 *
 * @return  {string[]}  The persisted directory paths
 */
function readPersistedUnopenedContentDirectories (): string[] {
  try {
    const stored = window.localStorage.getItem(UNOPENED_CONTENT_STORAGE_KEY)

    if (stored === null) {
      return []
    }

    const parsed: unknown = JSON.parse(stored)

    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed.filter((entry): entry is string => typeof entry === 'string')
  } catch (error) {
    console.error('[WindowState] Could not read the persisted open history tree state', error)
    return []
  }
}

/**
 * Persists the list of directories that display their never opened contents.
 *
 * @param  {string[]}  directories  The directory paths to persist
 */
function persistUnopenedContentDirectories (directories: string[]): void {
  try {
    window.localStorage.setItem(UNOPENED_CONTENT_STORAGE_KEY, JSON.stringify([...directories]))
  } catch (error) {
    console.error('[WindowState] Could not persist the open history tree state', error)
  }
}

async function updateSnippets (snippets: Ref<Array<{ name: string, content: string }>>): Promise<void> {
  // Now we have to pair two types of calls to the assets provider to get all
  // snippets: First a call to list all snippets, and then one `get` call to
  // retrieve its file contents.
  const snippetNames: string[] = await ipcRenderer.invoke('assets-provider', {
    command: 'list-snippets'
  } as AssetsProviderIPCAPI)

  const newSnippets: Array<{ name: string, content: string }> = []
  for (const snippet of snippetNames) {
    const content: string = await ipcRenderer.invoke('assets-provider', {
      command: 'get-snippet',
      payload: { name: snippet }
    } as AssetsProviderIPCAPI)

    newSnippets.push({ name: snippet, content })
  }

  snippets.value = newSnippets
}

export const useWindowStateStore = defineStore('window-state', () => {
  const isFullscreen = ref(false)
  const uncollapsedDirectories = ref<string[]>([])
  // Directories whose never opened files and subdirectories the open history
  // tree currently displays as grey rows. Independent of the collapse state.
  const directoriesShowingUnopenedContent = ref<string[]>(readPersistedUnopenedContentDirectories())

  watch(directoriesShowingUnopenedContent, (value) => {
    persistUnopenedContentDirectories(value)
  }, { deep: true })

  const distractionFreeMode = ref<undefined|string>(undefined)
  const activeDocumentInfo = ref<undefined|DocumentInfo>(undefined)
  const tableOfContents = ref<ToCEntry[]|undefined>(undefined)
  const snippets = ref<Array<{ name: string, content: string }>>([])
  const writingTargets = ref<WritingTarget[]>([])
  // Markdown files for which the pandoc PPTX preview pane is currently open
  const pptxPreviewPaths = ref(new Set<string>())

  // Whether the persistent Pandoc attribute panel (R22) is open. The toolbar's
  // checkable Attributes button toggles this; the last focused Markdown editor
  // renders the panel while it is open.
  const pandocAttributesPanelOpen = ref(false)

  function togglePptxPreview (filePath: string): void {
    if (pptxPreviewPaths.value.has(filePath)) {
      pptxPreviewPaths.value.delete(filePath)
    } else {
      pptxPreviewPaths.value.add(filePath)
    }
  }

  /**
   * SEARCH RESULTS FUNCTIONALITY
   */
  const searchResults = ref<SearchResultWrapper[]>([])
  const maxSearchResultWeight = computed(() => {
    const allWeights = searchResults.value.map(r => r.weight)
    return Math.max(...allWeights)
  })

  function addSearchResult (result: SearchResultWrapper) {
    searchResults.value.push(result)
    searchResults.value.sort((a, b) => b.weight - a.weight)
  }

  // Snippets
  ipcRenderer.on('assets-provider', (event, what: string) => {
    if (what === 'snippets-updated') {
      updateSnippets(snippets).catch(e => console.error(e))
    }
  })

  updateSnippets(snippets).catch(e => console.error(e))

  // Writing targets
  ipcRenderer.on('targets-provider', (event, what: string) => {
    if (what === 'writing-targets-updated') {
      ipcRenderer.invoke('targets-provider', { command: 'get-targets' })
        .then((targets: WritingTarget[]) => { writingTargets.value = targets })
        .catch(e => console.error(e))
    }
  })

  ipcRenderer.invoke('targets-provider', { command: 'get-targets' })
    .then((targets: WritingTarget[]) => { writingTargets.value = targets })
    .catch(e => console.error(e))
  
  ipcRenderer.on('window-controls', (event, { command, payload }) => {
    if (command === 'fullscreen' && typeof payload === 'boolean') {
      isFullscreen.value = payload
    }
  })

  return {
    uncollapsedDirectories,
    directoriesShowingUnopenedContent,
    distractionFreeMode,
    activeDocumentInfo,
    tableOfContents,
    searchResults,
    addSearchResult,
    maxSearchResultWeight,
    snippets,
    writingTargets,
    isFullscreen,
    pptxPreviewPaths,
    togglePptxPreview,
    pandocAttributesPanelOpen
  }
})
