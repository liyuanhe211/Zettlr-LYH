<template>
  <div
    v-bind:class="{
      'document-tablist-wrapper': true,
      'scrollers-active': showScrollers
    }"
    v-on:wheel="handleWheel"
  >
    <!-- Left scroller arrow -->
    <div v-if="showScrollers" class="scroller left" v-on:click="scrollLeft()">
      <cds-icon shape="angle" direction="left"></cds-icon>
    </div>
    <!-- Right scroller arrow -->
    <div v-if="showScrollers" class="scroller right" v-on:click="scrollRight()">
      <cds-icon shape="angle" direction="right"></cds-icon>
    </div>

    <div
      ref="container"
      role="tablist"
      v-bind:class="{ 'tab-container': true }"
      v-on:contextmenu="handleTabbarContext($event)"
      v-on:dragover="handleExternalDragover"
      v-on:dragend="handleExternalDragleave"
    >
      <div
        v-for="file in openFiles"
        v-bind:key="file.path"
        v-bind:class="{
          active: activeFile !== null && file.path === activeFile.path,
          modified: modifiedPaths.includes(file.path),
          pinned: file.pinned,
          unsynchronized: tabSyncWarning(file.path, syncWarningRefresh) !== undefined
        }"
        v-bind:title="tabTooltip(file.path, syncWarningRefresh)"
        v-bind:data-path="file.path"
        v-bind:draggable="true"
        role="tab"
        v-on:mouseenter="refreshTabSyncWarning(file.path)"
        v-on:dragstart="handleDragStart($event, file.path)"
        v-on:drag="handleDrag"
        v-on:dragend="handleDragEnd"
        v-on:contextmenu.stop="handleContextMenu($event, file)"
        v-on:mouseup="handleMiddleMouseClick($event, file)"
        v-on:mousedown="handleClickFilename($event, file)"
      >
        <span
          class="filename"
          role="button"
        >
          {{ displayTitles.get(file.path)?.title }}
        </span>
        <span
          v-if="displayTitles.get(file.path)?.directory !== undefined"
          class="deduplicate"
        > [{{ displayTitles.get(file.path)?.directory }}]</span>
        <button
          type="button"
          class="copy-path"
          v-bind:title="copiedTabPaths.has(file.path) ? 'Copied' : 'Copy full path'"
          v-bind:aria-label="copiedTabPaths.has(file.path) ? 'Copied' : 'Copy full path'"
          v-bind:data-copied="copiedTabPaths.has(file.path)"
          v-bind:draggable="false"
          v-on:mousedown.stop.prevent="cancelSlowClickRename"
          v-on:mouseup.stop.prevent
          v-on:click.stop="copyTabPath(file.path)"
          v-on:dragstart.stop.prevent
          v-on:keydown.enter.stop
          v-on:keydown.space.stop
        >
          <cds-icon v-bind:shape="copiedTabPaths.has(file.path) ? 'check' : 'copy'" aria-hidden="true"></cds-icon>
        </button>
        <button
          type="button"
          class="tab-pin-toggle"
          v-bind:title="file.pinned ? 'Unpin tab' : 'Pin tab'"
          v-bind:aria-label="file.pinned ? 'Unpin tab' : 'Pin tab'"
          v-bind:aria-pressed="file.pinned"
          v-bind:draggable="false"
          v-on:mousedown.stop.prevent="cancelSlowClickRename"
          v-on:mouseup.stop.prevent
          v-on:click.stop="toggleTabPin(file)"
          v-on:auxclick.stop.prevent
          v-on:dragstart.stop.prevent
          v-on:keydown.enter.stop
          v-on:keydown.space.stop
          v-on:keyup.enter.stop
          v-on:keyup.space.stop
        >
          <cds-icon shape="pin" aria-hidden="true"></cds-icon>
        </button>
      </div>

      <div
        v-if="documentTabDragOver"
        v-bind:class="{
          dropzone: true,
          dragover: true
        }"
        v-on:drop="handleExternalDrop"
        v-on:dragover="handleExternalDragover"
        v-on:dragleave="handleExternalDragleave"
        v-on:dragend="handleExternalDragleave"
      >
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Tabs
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This component displays the document tabs on top of the editor.
 *
 * END HEADER
 */

import { displayTabbarContext } from './tabs-context'
import tippy from 'tippy.js'
import { nextTick, computed, ref, watch, onMounted, onBeforeUnmount, onUpdated } from 'vue'
import { useConfigStore, useDocumentTreeStore } from 'source/pinia'
import type { LeafNodeJSON, OpenDocument } from '@dts/common/documents'
import { pathBasename } from '@common/util/renderer-path-polyfill'
import type { DocumentManagerIPCAPI } from 'source/app/service-providers/documents'
import type { WindowControlsIPCAPI } from 'source/app/service-providers/windows'
import { useWorkspaceStore } from 'source/pinia/workspace-store'
import type { AnyMenuItem } from 'source/common/modules/window-register/application-menu-helper'
import { trans } from 'source/common/i18n-renderer'
import showPopupMenu from 'source/common/modules/window-register/application-menu-helper'
import { closeFile } from './file-manager/util/item-composable'
import getDocumentTitle from './util/get-document-title'
import { computeDisambiguationLabels } from './util/tab-label-disambiguation'
import { computeTabTitleParts } from './util/tab-title-width'
import { hasMarkdownExt } from '@common/util/file-extention-checks'
import { markdownContainsFormulas } from '@common/modules/markdown-utils/formula-calculated-export'
import { exportToHTMLAndShow } from './util/export-document-to-html'
import { buildSplitViewTabCommand, resolveSplitViewTarget, type SplitViewTabActionInput } from './util/split-view-target'
import { createSlowClickRename, SLOW_CLICK_RENAME_DELAY } from './util/slow-click-rename'
import { selectTabsToClose, type CloseTabsMode } from './util/close-tabs-selection'
import { isScratchNoteTabPath } from './file-manager/util/unsaved-tab-paths'
import { formatSyncWarningText, useDataSafetyStore, type SyncWarning } from 'source/pinia/data-safety-store'

const ipcRenderer = window.ipc

const props = defineProps<{
  leafId: string
  windowId: string
}>()

const showScrollers = ref<boolean>(false)
let observedTabWidth: number|undefined
const resizeObserver = new ResizeObserver((entries) => {
  const width = entries[0]?.contentRect.width
  if (width === undefined || width === observedTabWidth) {
    return
  }
  observedTabWidth = width
  requestAnimationFrame(() => {
    maybeActivateScrollers()
    // Wait for the arrows to change the viewport before revealing the tab.
    // Scrolling does not resize the container, so manual scrolls stay put.
    nextTick()
      .then(scrollActiveFileIntoView)
      .catch(err => console.error(err))
  })
})

// Is there a document being dragged over this tabbar?
const documentTabDragOver = ref<boolean>(false)
// Is the document originating from here? (If so we should not display the
// dropzone)
const documentTabDragOverOrigin = ref<boolean>(false)

const workspaceStore = useWorkspaceStore()
const documentTreeStore = useDocumentTreeStore()

const container = ref<HTMLDivElement|null>(null)
const node = computed<LeafNodeJSON|undefined>(() => documentTreeStore.paneData.find((leaf: LeafNodeJSON) => leaf.id === props.leafId))
const openFiles = computed(() => node.value?.openFiles ?? [])
const copiedTabPaths = ref(new Set<string>())
const copiedTabTimers = new Map<string, ReturnType<typeof setTimeout>>()
// A token belongs to a path's current open lifetime, including pending writes.
const copyTabLifetimes = new Map<string, object>()
let tabCopiesDisposed = false
watch(() => openFiles.value.map(file => file.path), paths => {
  const currentPaths = new Set(paths)
  for (const filePath of copyTabLifetimes.keys()) {
    if (!currentPaths.has(filePath)) {
      copyTabLifetimes.delete(filePath)
      clearTimeout(copiedTabTimers.get(filePath))
      copiedTabTimers.delete(filePath)
      copiedTabPaths.value.delete(filePath)
    }
  }
  for (const filePath of paths) {
    if (!copyTabLifetimes.has(filePath)) copyTabLifetimes.set(filePath, {})
  }
}, { immediate: true, flush: 'sync' })
const activeFile = computed(() => node.value?.activeFile ?? null)
const modifiedPaths = computed(() => documentTreeStore.modifiedDocuments)

// Zettlr-LYH data loss prevention (R173, specification C21 section 7 item 4):
// the tab of a file whose input has not reached the main process for a while
// carries the class `unsynchronized`, a "! " in front of its name and a
// tooltip with the number of seconds. The store changes only when a file
// enters or leaves that state, so the tab bar is not drawn again every second;
// instead, the pointer entering such a tab brings its seconds up to date.
const dataSafetyStore = useDataSafetyStore()
const syncWarningRefresh = ref(0)

/**
 * Returns the synchronization warning of a tab's file.
 *
 * @param   {string}                 filePath  The file of the tab
 * @param   {number}                 _refresh  The refresh counter; the template passes it so that the tab is drawn again when it changes
 *
 * @return  {SyncWarning|undefined}            The warning, or undefined if the input of the file is delivered
 */
function tabSyncWarning (filePath: string, _refresh: number): SyncWarning|undefined {
  return dataSafetyStore.getSyncWarning(filePath)
}

/**
 * Returns the tooltip of a tab: the warning while the file is stalled,
 * otherwise its path.
 *
 * @param   {string}  filePath  The file of the tab
 * @param   {number}  refresh   The refresh counter
 *
 * @return  {string}            The tooltip
 */
function tabTooltip (filePath: string, refresh: number): string {
  const warning = tabSyncWarning(filePath, refresh)
  return warning === undefined ? filePath : formatSyncWarningText(warning.stalledSeconds, warning.reason)
}

function refreshTabSyncWarning (filePath: string): void {
  if (dataSafetyStore.stalledFilePaths.has(filePath)) {
    syncWarningRefresh.value++
  }
}

// Zettlr-LYH tab labels (R89): tabs of this tab bar that share their display
// name (ignoring upper and lower case) show the name of the directory that tells
// them apart behind the file name. The labels are computed per group of equally
// named tabs from the complete paths; the map contains the tabs of such groups
// only, and it does not know yet which of them is the active tab.
const disambiguationLabels = computed<Map<string, string>>(() => {
  const groups = new Map<string, string[]>()
  for (const doc of openFiles.value) {
    const displayName = getDocumentTitle(doc).toLowerCase()
    const group = groups.get(displayName)
    if (group === undefined) {
      groups.set(displayName, [doc.path])
    } else {
      group.push(doc.path)
    }
  }

  const labels = new Map<string, string>()
  for (const paths of groups.values()) {
    if (paths.length > 1) {
      for (const [ filePath, label ] of computeDisambiguationLabels(paths)) {
        labels.set(filePath, label)
      }
    }
  }
  return labels
})

// Limit the complete visible label, including its distinguishing directory.
// Compute directory collisions before hiding the active tab's directory so its
// siblings keep stable labels when the active tab changes.
const displayTitles = computed(() => computeTabTitleParts(
  openFiles.value.map(file => ({
    path: file.path,
    title: getDocumentTitle(file),
    directory: disambiguationLabels.value.get(file.path)
  })),
  activeFile.value?.path
))

watch(activeFile, () => {
  // Make sure the activeFile is in view
  // We must wait until Vue has actually applied the active class to the
  // new file tab so that our handler retrieves the correct one, not the old.
  nextTick()
    .then(scrollActiveFileIntoView)
    .catch(err => console.error(err))
})

// Zettlr-LYH slow click rename (R101): clicking the active tab of the focused
// pane once more renames its file, like a slow double click in the Explorer.
// The tab element and file of the latest press on this tab bar:
let slowClickTab: HTMLElement|null = null
let slowClickTabPath: string|undefined
// When the window last came to the front; the click doing that does not count
let lastWindowFocusTime = Number.NEGATIVE_INFINITY

const slowClickRename = createSlowClickRename({
  onRename: () => {
    const file = activeFile.value
    if (file === null || file.path !== slowClickTabPath || documentTreeStore.lastLeafId !== props.leafId) {
      return
    }
    startRename(file)
  },
  onActiveChange: followWindowDuringSlowClick
})

// Another active tab or another focused pane ends a slow click. The paths are
// compared, since every update from main brings new tab objects.
watch([ () => activeFile.value?.path, () => documentTreeStore.lastLeafId ], () => {
  slowClickRename.cancel()
})

onMounted(() => {
  // Listen for shortcuts so that we can switch tabs programmatically
  ipcRenderer.on('shortcut', (event, shortcut) => {
    if (documentTreeStore.lastLeafId !== props.leafId) {
      return // Doesn't apply to this pane
    }

    const currentIdx = openFiles.value.findIndex(elem => activeFile.value !== null && elem.path === activeFile.value.path)
    if (shortcut === 'previous-tab') {
      if (currentIdx > 0) {
        selectFile(openFiles.value[currentIdx - 1])
      } else {
        selectFile(openFiles.value[openFiles.value.length - 1])
      }
    } else if (shortcut === 'next-tab') {
      if (currentIdx < openFiles.value.length - 1) {
        selectFile(openFiles.value[currentIdx + 1])
      } else {
        selectFile(openFiles.value[0])
      }
    } else if (shortcut === 'close-window') {
      if (documentTreeStore.lastLeafId !== props.leafId) {
        return // Otherwise all document tabs would close one file at the same
        // time
      }
      // The tab bar has the responsibility to first close the activeFile if
      // there is one. If there is none, it should send a request to close
      // this window as if the user had clicked on the close-button.
      if (currentIdx > -1) {
        // There's an active file, so request the closure
        ipcRenderer.invoke('documents-provider', {
          command: 'close-file',
          payload: {
            path: openFiles.value[currentIdx].path,
            leafId: props.leafId,
            windowId: props.windowId
          }
        } as DocumentManagerIPCAPI)
          .catch(e => console.error(e))
      } else {
        // No more open files, so request closing of the window
        // TODO: This must be managed centrally
        // ipcRenderer.send('window-controls', { command: 'win-close' })
      }
    } else if (shortcut === 'rename-file') {
      // Renaming via shortcut (= F2; Ctrl+R inserts a revision comment since
      // R108) works via a tooltip underneath the corresponding filetab
      const file = openFiles.value[currentIdx]
      if (file !== undefined) {
        startRename(file)
      }
    }
  })

  if (container.value !== null) {
    resizeObserver.observe(container.value)
  }

  window.addEventListener('focus', handleWindowFocus)
})

onBeforeUnmount(() => {
  tabCopiesDisposed = true
  for (const timer of copiedTabTimers.values()) clearTimeout(timer)
  copiedTabTimers.clear()
  copiedTabPaths.value.clear()
  copyTabLifetimes.clear()
  if (container.value !== null) {
    resizeObserver.unobserve(container.value)
  }

  window.removeEventListener('focus', handleWindowFocus)
  slowClickRename.cancel()
  endTabDragOut()
})

/**
 * Shows the rename field in a tooltip underneath the active tab, prefilled
 * with the file name and with everything before the last dot selected. Enter
 * renames the file, Escape or a click elsewhere drops the field. Shared by the
 * rename-file shortcut and the slow click on the active tab (R101).
 *
 * @param  {OpenDocument}  file  The file of the active tab
 */
function startRename (file: OpenDocument): void {
  // First, make sure the container is visible
  scrollActiveFileIntoView()

  const containerElement = container.value?.querySelector('.active')
  if (containerElement == null) {
    return
  }

  const wrapper = document.createElement('div')
  wrapper.classList.add('file-rename')

  const input = document.createElement('input')
  input.style.backgroundColor = 'transparent'
  input.style.border = 'none'
  input.style.color = 'white'
  input.value = pathBasename(file.path)

  wrapper.appendChild(input)

  // Then do the magic
  const instance = tippy(containerElement, {
    content: wrapper,
    allowHTML: true,
    interactive: true,
    placement: 'bottom',
    showOnCreate: true, // Immediately show the tooltip
    arrow: true, // Arrow for these tooltips
    onShown: function () {
      input.focus()
      // Select from the beginning until the last dot
      input.setSelectionRange(0, input.value.lastIndexOf('.'))
    }
  })

  input.addEventListener('keydown', (event) => {
    if (![ 'Enter', 'Escape' ].includes(event.key)) {
      return
    }

    if (event.key === 'Enter' && input.value.trim() !== '') {
      ipcRenderer.invoke('application', {
        command: 'file-rename',
        payload: {
          path: file.path,
          name: input.value
        }
      })
        .catch(e => console.error(e))
    }
    instance.hide()
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
 * Hands the release of the left button to the slow click. It counts as inside
 * only on the pressed tab, and not on its copy or pin button.
 *
 * @param  {MouseEvent}  event  The mouseup event anywhere in the window
 */
function handleSlowClickMouseUp (event: MouseEvent): void {
  if (event.button !== 0) {
    return
  }

  const target = event.target as Element|null
  const onTabButton = target !== null && typeof target.closest === 'function' && target.closest('.copy-path, .tab-pin-toggle') !== null
  const inside = slowClickTab !== null && slowClickTab.contains(target) && !onTabButton
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

onUpdated(maybeActivateScrollers)

function maybeActivateScrollers (): void {
  if (container.value === null) {
    return
  }

  // scrollWidth includes the browser-tab gaps and track padding. Compare
  // against the width without arrows so showing them cannot keep an otherwise
  // unnecessary pair of arrows alive after tabs close or the pane grows.
  const availableWidth = container.value.clientWidth + (showScrollers.value ? 40 : 0)
  showScrollers.value = container.value.scrollWidth > availableWidth
}

function scrollActiveFileIntoView (): void {
  if (container.value === null) {
    return
  }

  // First, we need to find the tab displaying the active file
  const elem = container.value.querySelector('.active')
  if (elem === null || !(elem instanceof HTMLDivElement)) {
    return // The container is not yet present
  }
  // Then, find out where the element is ...
  const left = elem.offsetLeft
  const right = left + elem.getBoundingClientRect().width
  // ... with respect to the container
  const leftEdge = container.value.scrollLeft
  const containerWidth = container.value.getBoundingClientRect().width
  const rightEdge = leftEdge + containerWidth

  if (left < leftEdge) {
    // The active tab is (partially) hidden to the left -> Decrease scrollLeft
    container.value.scrollLeft -= leftEdge - left
  } else if (right > rightEdge) {
    // The active tab is (partially) hidden to the right -> Increase scrollLeft
    container.value.scrollLeft += right - rightEdge
  }
}

function scrollLeft (): void {
  if (container.value === null || container.value.scrollLeft === 0) {
    return // Can't scroll further
  }

  // Get the first partially hidden file from the right. For that we first
  // need a list of all tabs. NOTE that we have to convert the nodelist to
  // an array manually. Also, we know every element will be a DIV.
  const tabs = [...container.value.querySelectorAll('[role="tab"]')] as HTMLDivElement[]

  // Test this from the back
  tabs.reverse()

  // Find the first tab whose left border is hidden behind the left edge of
  // the container
  for (const tab of tabs) {
    const left = tab.offsetLeft
    const leftEdge = container.value.scrollLeft

    if (left < leftEdge) {
      tab.scrollIntoView({ inline: 'start' })
      break
    }
  }
}

function scrollRight (): void {
  if (container.value === null) {
    return
  }

  // Similar to scrollLeft, this does the same for the right hand side
  const tabs = [...container.value.querySelectorAll('[role="tab"]')] as HTMLDivElement[]

  // Find the first tab whose right border is hidden behind the right edge
  // of the container
  const rightEdge = container.value.scrollLeft + container.value.getBoundingClientRect().width
  for (const tab of tabs) {
    const right = tab.offsetLeft + tab.getBoundingClientRect().width

    if (right > rightEdge) {
      tab.scrollIntoView({ inline: 'end' })
      break
    }
  }
}

/**
 * Lets the (vertical) mouse wheel scroll the tabbar horizontally whenever the
 * tabs overflow the available width.
 *
 * @param   {WheelEvent}  event  The wheel event
 */
function handleWheel (event: WheelEvent): void {
  if (container.value === null || event.ctrlKey || event.metaKey) {
    return // Leave zooming and similar gestures alone
  }

  const { scrollWidth, clientWidth } = container.value
  if (scrollWidth <= clientWidth) {
    return // Nothing to scroll
  }

  // Horizontal wheel movements (touchpads, tilt wheels) scroll natively
  if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) {
    return
  }

  event.preventDefault()
  // NOTE: The container has `scroll-behavior: smooth`, which would animate
  // every single wheel step and make consecutive steps lag behind.
  container.value.scrollBy({ left: event.deltaY, behavior: 'instant' })
}

async function copyTabPath (filePath: string): Promise<void> {
  const lifetime = copyTabLifetimes.get(filePath)
  if (tabCopiesDisposed || lifetime === undefined) return
  try {
    await navigator.clipboard.writeText(filePath)
    if (tabCopiesDisposed || copyTabLifetimes.get(filePath) !== lifetime) return
    clearTimeout(copiedTabTimers.get(filePath))
    copiedTabPaths.value.add(filePath)
    copiedTabTimers.set(filePath, setTimeout(() => {
      copiedTabPaths.value.delete(filePath)
      copiedTabTimers.delete(filePath)
    }, 1500))
  } catch (err) {
    // A failed pending write must not erase another write's success feedback.
    console.error(err)
  }
}

function toggleTabPin (file: OpenDocument): void {
  ipcRenderer.invoke('documents-provider', {
    command: 'set-pinned',
    payload: {
      path: file.path, leafId: props.leafId, windowId: props.windowId, pinned: !file.pinned
    }
  } satisfies DocumentManagerIPCAPI).catch(err => console.error(err))
}

/**
 * Closes the tab after a middle-mouse click.
 *
 * @param   {MouseEvent}    event  The triggering event
 * @param   {OpenDocument}  file   The file descriptor
 */
function handleClickClose (event: MouseEvent|KeyboardEvent, file: OpenDocument): void {
  if (!('button' in event) || event.button < 2) {
    // It was either a left-click (button === 0) or an auxiliary/middle
    // click (button === 1), so we should prevent the event from bubbling up
    // and triggering other events. If it was a right-button click
    // (button === 2), we should let it bubble up to the container to show
    // the context menu.
    // See: https://developer.mozilla.org/en-US/docs/Web/API/MouseEvent/button#return_value
    event.stopPropagation()
    event.preventDefault()
  } else {
    return // We don't handle this event here.
  }

  ipcRenderer.invoke('documents-provider', {
    command: 'close-file',
    payload: {
      path: file.path,
      windowId: props.windowId,
      leafId: props.leafId
    }
  } as DocumentManagerIPCAPI)
    .catch(e => console.error(e))
}

/**
 * Handles a click on the filename
 *
 * @param   {MouseEvent}    event  The triggering event
 * @param   {OpenDocument}  file   The file descriptor
 */
function handleClickFilename (event: MouseEvent, file: OpenDocument): void {
  // A press on the active tab of the focused pane may become a slow click
  // rename (R101). Whether it was active must be read before selectFile.
  const wasSelected = activeFile.value !== null && activeFile.value.path === file.path &&
    documentTreeStore.lastLeafId === props.leafId
  slowClickTab = event.currentTarget as HTMLElement|null
  slowClickTabPath = file.path
  slowClickRename.pointerDown({
    button: event.button,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    x: event.clientX,
    y: event.clientY,
    wasSelected,
    windowFocused: windowHadFocus()
  })

  if (event.button === 1) {
    // Chromium enters its middle-click autoscroll (scroll-lock) mode on
    // mousedown, i.e. before the mouseup that closes the tab in
    // handleMiddleMouseClick fires, so the preventDefault there comes too
    // late to stop it. Prevent it here so a middle-click only closes the tab.
    event.preventDefault()
  } else if (event.button === 0) {
    // It was a left-click. (We must check because otherwise we would also
    // perform this action on a right-click (button === 2), but that event
    // must be handled by the container).
    selectFile(file)
  }
}

/**
 * Handles a middle-mouse click on the filename
 *
 * Middle-mouse clicks are handled separately through a `mouseup` event,
 * to prevent unintentional pasting on Linux systems (#2663).
 *
 * @param   {MouseEvent}    event  The triggering event
 * @param   {OpenDocument}  file   The file descriptor
 */
function handleMiddleMouseClick (event: MouseEvent, file: OpenDocument): void {
  if (event.button === 1) {
    // It was a middle-click (auxiliary button), so we should close
    // the file.
    event.preventDefault() // Otherwise, on Windows we'd have a middle-click-scroll
    handleClickClose(event, file)
  }
}

function selectFile (file: OpenDocument): void {
  // NOTE: We're handling active file setting via the open-file command. As
  // long as a given file is already open, the document manager will simply
  // set it as active. That is why we don't provide the newTab property.
  ipcRenderer.invoke('documents-provider', {
    command: 'open-file',
    payload: { path: file.path, windowId: props.windowId, leafId: props.leafId }
  } as DocumentManagerIPCAPI)
    .catch(e => console.error(e))
}

function handleTabbarContext (event: MouseEvent): void {
  // If the person didn't click on a file, let them to close the whole leaf
  displayTabbarContext(event, (clickedID: string) => {
    if (clickedID === 'close-leaf') {
      ipcRenderer.invoke('documents-provider', {
        command: 'close-leaf',
        payload: {
          leafId: props.leafId,
          windowId: props.windowId
        }
      } as DocumentManagerIPCAPI).catch(e => console.error(e))
    }
  })
}

async function handleContextMenu (event: MouseEvent, doc: OpenDocument): Promise<void> {
  // NOTE: The descriptor can be legitimately absent from the map (store still
  // loading, file outside any loaded workspace, or the map being rebuilt).
  // The menu must still show in that case; almost every item only needs
  // doc.path, so only the descriptor-dependent items are gated below.
  const descriptor = workspaceStore.descriptorMap.get(doc.path)

  // The formula-calculated export item is only offered for Markdown files
  // whose saved contents actually contain double-bracket formulas.
  let documentHasFormulas = false
  if (hasMarkdownExt(doc.path)) {
    try {
      const contents = await ipcRenderer.invoke('application', {
        command: 'get-file-contents',
        payload: doc.path
      })
      documentHasFormulas = typeof contents === 'string' && markdownContainsFormulas(contents)
    } catch (err) {
      console.error(err)
    }
  }

  const isMac = process.platform === 'darwin'
  const isWin = process.platform === 'win32'

  // Zettlr-LYH split view (R44): the tab goes into a new split to the right
  // when this is the window's only pane, else into the next pane
  const splitViewInput: Omit<SplitViewTabActionInput, 'action'> = {
    leafIds: documentTreeStore.paneData.map((leaf: LeafNodeJSON) => leaf.id),
    currentLeafId: props.leafId,
    currentTabCount: openFiles.value.length,
    tabPinned: doc.pinned,
    windowId: props.windowId,
    filePath: doc.path
  }
  const sendToSplitView = (action: 'copy'|'move'): void => {
    const command = buildSplitViewTabCommand({ ...splitViewInput, action })
    if (command !== undefined) {
      ipcRenderer.invoke('documents-provider', command).catch(e => console.error(e))
    }
  }

  // Zettlr-LYH (R144): Close all tabs and Close All Saved Tabs never close a
  // scratch note (a draft of Unsaved Files) or a pinned tab; the latter also
  // keeps every tab with unsaved modifications, so that it never asks anything.
  // The store is looked up here, since only this menu needs the scratch folder.
  const configuredScratchDirectory: unknown = useConfigStore().config.scratchNotesDirectory
  const scratchDirectory = typeof configuredScratchDirectory === 'string' ? configuredScratchDirectory : ''
  const tabsToClose = (mode: CloseTabsMode): string[] => selectTabsToClose(
    openFiles.value,
    modifiedPaths.value,
    filePath => isScratchNoteTabPath(filePath, scratchDirectory),
    mode
  )
  const closeTabs = (mode: CloseTabsMode): void => {
    for (const filePath of tabsToClose(mode)) {
      ipcRenderer.invoke('documents-provider', {
        command: 'close-file',
        payload: { path: filePath, leafId: props.leafId, windowId: props.windowId }
      } satisfies DocumentManagerIPCAPI).catch(e => console.error(e))
    }
  }

  const items: AnyMenuItem[] = [
    {
      label: trans('Close tab'),
      accelerator: 'Middle click',
      type: 'normal',
      enabled: true,
      action () {
        ipcRenderer.invoke('documents-provider', {
          command: 'close-file',
          payload: { path: doc.path, leafId: props.leafId, windowId: props.windowId }
        } satisfies DocumentManagerIPCAPI).catch(e => console.error(e))
      }
    },
    {
      label: trans('Close other tabs'),
      type: 'normal',
      action () {
        for (const openFile of openFiles.value) {
          if (openFile.path === doc.path) {
            continue
          }

          ipcRenderer.invoke('documents-provider', {
            command: 'close-file',
            payload: { path: openFile.path, leafId: props.leafId, windowId: props.windowId }
          } satisfies DocumentManagerIPCAPI).catch(e => console.error(e))
        }
      }
    },
    {
      label: trans('Close all tabs'),
      type: 'normal',
      enabled: !doc.pinned,
      action () {
        closeTabs('all')
      }
    },
    {
      label: 'Close All Saved Tabs',
      type: 'normal',
      enabled: tabsToClose('saved').length > 0,
      action () {
        closeTabs('saved')
      }
    },
    {
      type: 'separator'
    },
    {
      label: trans('Move'),
      type: 'submenu',
      enabled: !doc.pinned,
      submenu: [
        {
          label: trans('Move to start'),
          enabled: !isFirstUnpinned(doc.path),
          type: 'normal',
          action () { moveFile(doc.path, 'start') }
        },
        {
          label: trans('Move to end'),
          enabled: !isLast(doc.path),
          type: 'normal',
          action () { moveFile(doc.path, 'end') }
        }
      ]
    },
    {
      label: doc.pinned ? trans('Unpin tab') : trans('Pin tab'),
      type: 'normal',
      action () {
        toggleTabPin(doc)
      }
    },
    {
      label: 'Copy to Split View',
      type: 'normal',
      action () { sendToSplitView('copy') }
    },
    {
      label: 'Move to Split View',
      type: 'normal',
      enabled: resolveSplitViewTarget(splitViewInput).moveEnabled,
      action () { sendToSplitView('move') }
    },
    {
      type: 'separator'
    },
    {
      label: trans('Copy filename'),
      type: 'normal',
      action () {
        navigator.clipboard.writeText(pathBasename(doc.path)).catch(err => console.error(err))
      }
    },
    {
      label: trans('Copy path'),
      type: 'normal',
      action () {
        navigator.clipboard.writeText(doc.path).catch(err => console.error(err))
      }
    },
    {
      label: isMac ? trans('Reveal in Finder') : isWin ? trans('Reveal in Explorer') : trans('Reveal in File Browser'),
      type: 'normal',
      action () {
        ipcRenderer.send('window-controls', {
          command: 'show-item-in-folder',
          payload: { itemPath: doc.path }
        } satisfies WindowControlsIPCAPI)
      }
    },
    {
      label: trans('Copy ID'),
      type: 'normal',
      enabled: descriptor?.type === 'file' && descriptor.id !== '',
      action () {
        if (descriptor?.type === 'file' && descriptor.id !== '') {
          navigator.clipboard.writeText(descriptor.id).catch(err => console.error(err))
        }
      }
    },
    {
      type: 'separator'
    },
    {
      label: trans('Close file'),
      type: 'normal',
      enabled: descriptor !== undefined && workspaceStore.rootDescriptors.includes(descriptor),
      action () {
        closeFile(doc.path)
      }
    },
  ]

  if (hasMarkdownExt(doc.path)) {
    items.push(
      { type: 'separator' },
      {
        label: 'Export to HTML',
        type: 'normal',
        action () {
          exportToHTMLAndShow(doc.path).catch(e => console.error(e))
        }
      }
    )
  }

  if (documentHasFormulas) {
    items.push(
      {
        // Exports a copy in which every double-bracket formula is replaced
        // by its computed outcome, viewable in any other Markdown viewer.
        label: 'Export Formula-Calculated Copy',
        type: 'normal',
        action () {
          ipcRenderer.invoke('application', {
            command: 'export-formula-calculated',
            payload: { path: doc.path }
          }).then(newPath => {
            if (typeof newPath === 'string') {
              ipcRenderer.send('window-controls', {
                command: 'show-item-in-folder',
                payload: { itemPath: newPath }
              } satisfies WindowControlsIPCAPI)
            }
          }).catch(e => console.error(e))
        }
      }
    )
  }

  const point = { x: event.clientX, y: event.clientY }
  showPopupMenu(point, items)
}

/**
 * Managed the begin of a drag of one of the internal document tabs we have
 * here on this tabbar.
 *
 * @param   {DragEvent}  event     The Drag event
 * @param   {string}     filePath  The file to be dragged
 */
function handleDragStart (event: DragEvent, filePath: string): void {
  slowClickRename.cancel() // A dragged tab is no slow click (R101)
  const DELIM = (process.platform === 'win32') ? ';' : ':'
  // NOTE: When retrieving this data, destructure as an array and capture
  // any remaining parts with `...filePath` and re-join with DELIM to
  // account for the fact that Unixoid systems allow colons in paths.
  const data = [ props.windowId, props.leafId, filePath ].join(DELIM)
  event.dataTransfer?.setData('zettlr/document-tab', data)
  documentTabDragOverOrigin.value = true
  startTabDragOut(event, filePath)
}

// Zettlr-LYH tab drag-out (R115): a tab released outside all Zettlr windows
// opens in a new window. Escape during the drag cancels this. Windows ends the
// drag on the key press, which the page often does not see, so an Escape key
// released within this many milliseconds after the drag still cancels it.
const TAB_DRAG_OUT_ESCAPE_GRACE = 250

interface TabDragOut {
  filePath: string
  // Where the tab was grabbed, relative to the window, in CSS pixels
  grabOffsetX: number
  grabOffsetY: number
  cancelled: boolean
  timer: ReturnType<typeof setTimeout>|undefined
}

let tabDragOut: TabDragOut|null = null

function handleTabDragOutKey (event: KeyboardEvent): void {
  if (event.key === 'Escape' && tabDragOut !== null) {
    tabDragOut.cancelled = true
  }
}

/**
 * Remembers a tab drag that may end outside all windows, and listens for
 * Escape until it is decided.
 *
 * @param   {DragEvent}  event     The dragstart event
 * @param   {string}     filePath  The file of the dragged tab
 */
function startTabDragOut (event: DragEvent, filePath: string): void {
  endTabDragOut()
  const tab = event.currentTarget as HTMLElement|null
  const tabLeft = tab?.getBoundingClientRect().left ?? event.clientX
  const containerLeft = container.value?.getBoundingClientRect().left ?? 0
  tabDragOut = {
    filePath,
    // The tab becomes the first one of the new window, so the pointer should
    // hold the first tab at the spot where it held this one
    grabOffsetX: containerLeft + (event.clientX - tabLeft),
    grabOffsetY: event.clientY,
    cancelled: false,
    timer: undefined
  }
  window.addEventListener('keydown', handleTabDragOutKey, true)
  window.addEventListener('keyup', handleTabDragOutKey, true)
}

/**
 * Forgets the current tab drag, including a pending request, and stops
 * listening for Escape.
 */
function endTabDragOut (): void {
  if (tabDragOut === null) {
    return
  }

  if (tabDragOut.timer !== undefined) {
    clearTimeout(tabDragOut.timer)
  }
  tabDragOut = null
  window.removeEventListener('keydown', handleTabDragOutKey, true)
  window.removeEventListener('keyup', handleTabDragOutKey, true)
}

/**
 * Returns the scroll position of this pane's editor if it shows the file.
 *
 * @param   {string}            filePath  The file of the dragged tab
 *
 * @return  {number|undefined}            The scrollTop, or undefined
 */
function readEditorScrollTop (filePath: string): number|undefined {
  if (activeFile.value?.path !== filePath) {
    return undefined
  }

  const scroller = container.value?.closest('.editor-pane')?.querySelector('.editor-container .cm-scroller')
  return scroller instanceof HTMLElement ? scroller.scrollTop : undefined
}

/**
 * Decides at the end of a tab drag whether the tab goes into a new window. A
 * drop that some Zettlr drop zone accepted, or a drag cancelled with Escape,
 * does not. Otherwise main receives the release point after the Escape grace
 * period and opens the new window unless a main window covers that point
 * (drops inside a window, such as reordering, are not accepted either).
 *
 * @param   {DragEvent}  event  The dragend event
 */
function finishTabDragOut (event: DragEvent): void {
  const dragOut = tabDragOut
  if (dragOut === null) {
    return
  }

  if (dragOut.cancelled || event.dataTransfer?.dropEffect !== 'none') {
    endTabDragOut()
    return
  }

  const payload = {
    originWindow: props.windowId,
    originLeaf: props.leafId,
    path: dragOut.filePath,
    screenX: event.screenX,
    screenY: event.screenY,
    offsetX: dragOut.grabOffsetX,
    offsetY: dragOut.grabOffsetY,
    scrollTop: readEditorScrollTop(dragOut.filePath)
  }

  dragOut.timer = setTimeout(() => {
    const cancelled = dragOut.cancelled
    endTabDragOut()
    if (cancelled) {
      return
    }

    ipcRenderer.invoke('documents-provider', {
      command: 'move-file-to-new-window',
      payload
    } satisfies DocumentManagerIPCAPI)
      .catch(err => console.error(err))
  }, TAB_DRAG_OUT_ESCAPE_GRACE)
}

/**
 * This function handles internal document tabs (i.e. the reordering of
 * document tabs belonging to this tabbar)
 *
 * @param   {DragEvent}  event  The drag event
 */
function handleDrag (event: DragEvent): void {
  if (container.value === null) {
    return
  }

  const tab = event.target as Element
  const tablist = tab.parentNode as Element
  let coordsX = event.clientX
  let coordsY = event.clientY

  // Ensure the coords are somewhere inside the tablist. NOTE that exactly
  // the border would only select the tablist, not the actual tab at that
  // point. NOTE that the value of five is arbitrary and relies on the fact
  // that the tablist only contains tabs.
  const { left, top, right, bottom, height } = container.value.getBoundingClientRect()
  // Stop handling if the user drags the tab out of the document tab bar
  // This is so that editor instances can enable splitting via drag&drop
  if (coordsX < left - 10 || coordsX > right + 10 || coordsY < top - 10 || coordsY > bottom + 10) {
    return
  }

  const middle = height / 2
  if (coordsX < left) {
    coordsX = left + 5
  }

  if (coordsX > right) {
    coordsX = right - 5
  }

  if (coordsY < top) {
    coordsY = top + middle
  }

  if (coordsY > bottom) {
    coordsY = bottom - middle
  }

  let swapItem: Element = tab
  const elemAtCoords = document.elementFromPoint(coordsX, coordsY)
  if (elemAtCoords !== null) {
    swapItem = elemAtCoords
  }

  // We need to make sure we got the DIV, not one of the containing spans
  while (swapItem.getAttribute('role') !== 'tab') {
    if (swapItem.parentNode === document) {
      break // Don't overdo it
    }
    swapItem = swapItem.parentNode as Element
  }

  if (tablist === swapItem.parentNode) {
    // @ts-expect-error TODO This didn't lead to a bug yet, but may
    swapItem = swapItem !== tab.nextSibling ? swapItem : swapItem.nextSibling
    tablist.insertBefore(tab, swapItem)
  }
}

/**
 * This event is solely used when the user drops a document tab onto the
 * origin tabbar to see if something has changed and resort the document
 * tabs as necessary.
 *
 * @param   {DragEvent}  event  The drag event
 */
function handleDragEnd (event: DragEvent): void {
  documentTabDragOverOrigin.value = false
  finishTabDragOut(event) // Zettlr-LYH tab drag-out (R115)
  if (container.value === null) {
    return
  }

  // Here we just need to inspect the actual order and notify the main
  // process of that order.
  const newOrder: string[] = []
  for (let i = 0; i < container.value.children.length; i++) {
    if (container.value.children[i].getAttribute('role') !== 'tab') {
      // There may be other children in the element, such as the scrollers
      continue
    }
    const fpath = container.value.children[i].getAttribute('data-path')
    if (fpath === null) {
      console.warn(`Could not determine file path of document tab index ${i}: data-path was empty.`)
      continue
    }

    newOrder.push(fpath)
  }

  const originalOrdering = openFiles.value.map(file => file.path)

  // Did the order change at all?
  let somethingChanged = false
  for (let i = 0; i < newOrder.length; i++) {
    if (newOrder[i] !== originalOrdering[i]) {
      somethingChanged = true
      break
    }
  }

  if (!somethingChanged) {
    return
  }

  // Now that we have the correct NEW ordering, we need to temporarily
  // restore the old ordering, because otherwise Vue will be confused since
  // it needs to keep track of the element ordering, and we just messed with
  // that big time.
  const targetElement = event.target as Element|null
  if (targetElement === null) {
    return
  }

  const dataPath = targetElement.getAttribute('data-path')

  if (dataPath === null) {
    return
  }

  const originalIndex = originalOrdering.indexOf(dataPath)
  if (originalIndex === 0) {
    container.value.insertBefore(targetElement, container.value.children[0])
  } else if (originalIndex === container.value.children.length - 1) {
    container.value.insertBefore(targetElement, null) // null means append at the end
  } else {
    container.value.insertBefore(targetElement, container.value.children[originalIndex + 1])
  }

  ipcRenderer.invoke('documents-provider', {
    command: 'sort-open-files',
    payload: {
      newOrder,
      windowId: props.windowId,
      leafId: props.leafId
    }
  } satisfies DocumentManagerIPCAPI)
    .catch(err => console.error(err))
}

/**
 * Returns true if the item identified by `itemPath` is the first non-pinned
 * item in the tab list.
 *
 * @param   {string}   itemPath  The item
 *
 * @return  {boolean}            Whether it's the first unpinned.
 */
function isFirstUnpinned (itemPath: string): boolean {
  const idx = getIndexInTabList(itemPath)
  const firstUnpinned = openFiles.value.findIndex(doc => !doc.pinned)
  return idx === firstUnpinned
}

/**
 * Returns true if the item identified by `itemPath` is the last item in the
 * open files.
 *
 * @param   {string}   itemPath  The item
 *
 * @return  {boolean}            Whether it's last
 */
function isLast (itemPath: string): boolean {
  const idx = getIndexInTabList(itemPath)
  return idx === openFiles.value.length - 1
}

/**
 * Returns the index of the item identified by `itemPath` in the list of open
 * files.
 *
 * @param   {string}  itemPath  The item
 *
 * @return  {number}            The item's index
 */
function getIndexInTabList (itemPath: string): number {
  return openFiles.value.findIndex(doc => doc.path === itemPath)
}

/**
 * Moves the file identified by `itemPath` to the first or last position in the
 * tab bar, indicated by `where`.
 *
 * @param  {string}         itemPath  The item to move
 * @param  {'start'|'end'}  where     Where to move the file to
 */
function moveFile (itemPath: string, where: 'start'|'end') {
  const currentIdx = getIndexInTabList(itemPath)

  if (currentIdx < 0) {
    return
  }

  const newOrder = openFiles.value.map(f => f.path)
  newOrder.splice(currentIdx, 1)

  if (where === 'start') {
    newOrder.unshift(itemPath)
  } else {
    newOrder.push(itemPath)
  }

  ipcRenderer.invoke('documents-provider', {
    command: 'sort-open-files',
    payload: {
      newOrder,
      windowId: props.windowId,
      leafId: props.leafId
    }
  } satisfies DocumentManagerIPCAPI)
    .catch(err => console.error(err))
}

/**
 * This function is used when something *external* has been dropped onto the
 * tabbar. In this case, we need to execute a move command (if applicable
 * analogously to the MainEditor component).
 *
 * @param   {DragEvent}  event  The drag event
 */
function handleExternalDrop (event: DragEvent): void {
  documentTabDragOver.value = false
  const DELIM = (process.platform === 'win32') ? ';' : ':'
  const documentTab = event.dataTransfer?.getData('zettlr/document-tab')
  if (documentTab === undefined) {
    return
  } else if (!documentTab.includes(DELIM)) {
    return
  }

  // The user dropped the file onto the origin (this indicates a bug as
  // the dropzone shouldn't even be on the DOM in that case)
  if (documentTabDragOverOrigin.value) {
    console.error('A document tab has been dropped onto its origin, but the dropzone was in the DOM. This is a bug.')
    documentTabDragOverOrigin.value = false
    return
  }

  // At this point, we have received a drop we need to handle it. The drag
  // data contains both the origin and the path, separated by the $PATH
  // delimiter -> window:leaf:absPath
  const [ originWindow, originLeaf, ...filePath ] = documentTab.split(DELIM)
  // Now actually perform the act
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
}

/**
 * This event is used to indicate to the user if they can drop a document
 * tab onto this tabbar. This gives the tabbar a blue-ish shimmer (similarly
 * to the dropzones in the MainEditor component) to indicate that the user
 * can drop a document tab on here.
 *
 * @param   {DragEvent}  event  The drag event
 */
function handleExternalDragover (event: DragEvent): void {
  if (documentTabDragOverOrigin.value) {
    return // The document tab is coming from this tabbar
  }

  const hasDocumentTab = event.dataTransfer?.types.includes('zettlr/document-tab') ?? false
  if (hasDocumentTab) {
    documentTabDragOver.value = true
  } else {
    documentTabDragOver.value = false
  }
}

/**
 * This is being called on dragleave and some other, related external events
 * to reset the internal state so that the dropzone disappears.
 *
 * @param   {DragEvent}  event  The drag event
 */
function handleExternalDragleave (event: DragEvent): void {
  documentTabDragOver.value = false
}
</script>

<style lang="less">
@tabbar-height: 30px;
@scroller-width: 20px;

body div.document-tablist-wrapper {
  --tab-track: #e8eaed;
  --tab-inactive: #dfe1e5;
  --tab-hover: #d3d6db;
  --tab-active: #ffffff;
  --tab-border: #c7cbd1;
  --tab-text: #4b525b;
  --tab-active-text: #202124;
  --tab-close-hover: #e3e6ea;
  position: relative;
  background-color: var(--tab-track);

  &.scrollers-active { padding: 0 @scroller-width; }

  div.scroller {
    position: absolute;
    top: 0;
    bottom: 0;
    width: @scroller-width;
    line-height: 34px;
    text-align: center;
    background-color: var(--tab-track);
    color: var(--tab-text);
    box-shadow: inset 0 -1px var(--tab-border);
    z-index: 3;

    &:hover { background-color: var(--tab-hover); }
    &.left { left: 0; }
    &.right { right: 0; }
  }
}

body div.tab-container {
  position: relative;
  isolation: isolate;
  box-sizing: border-box;
  width: 100%;
  height: 34px;
  padding: 4px 6px 0;
  display: flex;
  align-items: flex-end;
  gap: 4px;
  overflow-x: auto;
  background-color: var(--tab-track);
  box-shadow: inset 0 -1px var(--tab-border);

  .dropzone {
    position: absolute;
    transition: all 0.3s ease;
    background-color: rgba(21, 61, 107, 0.5);
    inset: 0;
    z-index: 4;
  }

  // Keep wheel, touchpad and arrow scrolling without a visible scrollbar.
  &::-webkit-scrollbar { display: none; }
  scroll-behavior: smooth;

  div[role="tab"] {
    position: relative;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    flex: 0 0 auto;
    height: @tabbar-height;
    min-width: 0;
    padding: 0 10px;
    border: 1px solid transparent;
    border-radius: 8px 8px 0 0;
    background-color: var(--tab-inactive);
    color: var(--tab-text);
    font-size: 11px;
    line-height: (@tabbar-height - 2px);
    z-index: 1;
    transition: background-color 0.15s ease;

    &:hover { background-color: var(--tab-hover); }

    .copy-path {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 19.5px;
      width: 19.5px;
      min-width: 0;
      max-width: 19.5px;
      height: @tabbar-height;
      min-height: 0;
      padding: 0;
      margin: 0;
      margin-left: 6px;
      border: 0;
      border-radius: 3px;
      background: transparent;
      color: inherit;
      cursor: pointer;
      opacity: 0.65;

      cds-icon { width: 13px; height: 13px; }

      &:hover, &:focus-visible {
        background-color: var(--tab-close-hover);
        opacity: 1;
      }
    }

    .filename {
      display: inline-flex;
      align-items: center;
      white-space: pre;

      cds-icon { margin-right: 4px; }
    }

    .deduplicate {
      white-space: pre;
      font-style: italic;
      font-size: 80%;
      opacity: 0.8;
    }

    // State marks and controls remain separate from the title's text budget.
    &.modified .filename::before { content: '* '; }

    // Zettlr-LYH data loss prevention (R173): the input of this tab has not
    // reached the main process. "! " comes before the unsaved mark, so that
    // both show. The warning colours are those of the window (generic.css);
    // the look is provisional until the user confirms it.
    &.unsynchronized .filename::before { content: '! '; }
    &.unsynchronized.modified .filename::before { content: '! * '; }

    &.unsynchronized,
    &.unsynchronized:hover,
    &.unsynchronized.active {
      background-color: var(--zettlr-warning-bg);
      border-color: var(--zettlr-warning-color);
      color: var(--zettlr-warning-color);
    }

    .tab-pin-toggle {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 19.5px;
      width: 19.5px;
      min-width: 0;
      max-width: 19.5px;
      height: @tabbar-height;
      min-height: 0;
      padding: 0;
      margin: 0;
      margin-left: 6px;
      border: 0;
      border-radius: 3px;
      background: transparent;
      color: inherit;
      cursor: pointer;
      opacity: 0.65;

      cds-icon { width: 13px; height: 13px; }

      &[aria-pressed="true"], &:hover, &:focus-visible {
        background-color: var(--tab-close-hover);
        opacity: 1;
      }

      &:focus-visible {
        outline: 2px solid var(--tab-active-text);
        outline-offset: -2px;
      }
    }

    &.active {
      border-color: var(--tab-border);
      border-bottom-color: var(--tab-active);
      background-color: var(--tab-active);
      color: var(--tab-active-text);
      z-index: 2;

      // Concave lower corners join the selected tab to the editor surface.
      &::before, &::after {
        content: '';
        position: absolute;
        bottom: -1px;
        width: 6px;
        height: 6px;
        pointer-events: none;
      }

      &::before {
        left: -6px;
        background: radial-gradient(circle at 0 0, transparent 5px, var(--tab-active) 5.5px);
      }

      &::after {
        right: -6px;
        background: radial-gradient(circle at 100% 0, transparent 5px, var(--tab-active) 5.5px);
      }
    }
  }
}

body.darwin div.tab-container div[role="tab"] {
  font-family: system-ui, sans-serif;
}

body.win32 div.tab-container div[role="tab"] {
  // The bundled face supplies Consolas Latin and YaHei Chinese glyphs.
  font-family: "YaHei Consolas Hybrid", Consolas, "Microsoft YaHei UI", sans-serif;
}

body.dark div.document-tablist-wrapper {
  --tab-track: #202124;
  --tab-inactive: #2b2d31;
  --tab-hover: #36393e;
  --tab-active: #323232;
  --tab-border: #45484d;
  --tab-text: #c4c7cc;
  --tab-active-text: #f1f3f4;
  --tab-close-hover: #484c52;
}
</style>
