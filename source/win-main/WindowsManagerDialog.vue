<template>
  <!-- Teleported to the body element so that it covers the whole window -->
  <Teleport to="body">
    <div
      class="windows-manager-overlay"
      v-on:keydown.stop
      v-on:mousedown.self.prevent
    >
      <div
        class="windows-manager-dialog"
        role="dialog"
        aria-modal="true"
        v-bind:aria-label="dialogTitle"
        v-bind:style="dialogStyle"
      >
        <div class="windows-manager-header">
          <div class="windows-manager-title">
            {{ dialogTitle }}
          </div>
          <button
            type="button"
            class="windows-manager-close"
            v-bind:title="closeLabel"
            v-bind:aria-label="closeLabel"
            v-on:click="emit('close')"
          >
            ✕
          </button>
        </div>
        <div class="windows-manager-body">
          <div
            ref="tableContainer"
            class="windows-manager-table-container"
            tabindex="0"
            role="grid"
            aria-multiselectable="true"
            v-bind:aria-label="tableLabel"
            v-on:keydown="onTableKeydown"
          >
            <table class="windows-manager-table" v-bind:style="tableStyle">
              <colgroup>
                <col
                  v-for="column in columns"
                  v-bind:key="column.id"
                  v-bind:class="'col-' + column.id"
                  v-bind:style="columnStyle(column.id)"
                >
              </colgroup>
              <thead>
                <tr ref="headerRow">
                  <th
                    v-for="column in columns"
                    v-bind:key="column.id"
                    v-bind:class="{ numeric: column.id === 'size' }"
                    v-bind:data-column="column.id"
                    v-bind:aria-sort="ariaSort(column.id)"
                    v-on:click="clickColumnHeader(column.id)"
                  >
                    <span class="windows-manager-sort-indicator" aria-hidden="true">{{ sortIndicator(column.id) }}</span>
                    {{ column.label }}
                    <span
                      class="windows-manager-column-resizer"
                      aria-hidden="true"
                      v-on:pointerdown="startColumnResize($event, column.id)"
                    ></span>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="row in sortedRows"
                  v-bind:key="row.key"
                  v-bind:data-key="row.key"
                  v-bind:class="{ selected: selectedKeys.has(row.key), cursor: cursorKey === row.key }"
                  v-bind:aria-selected="selectedKeys.has(row.key) ? 'true' : 'false'"
                  v-on:mousedown="onRowMousedown($event)"
                  v-on:click="onRowClick($event, row)"
                  v-on:dblclick="activateRow(row)"
                >
                  <td v-bind:title="row.displayName">
                    {{ row.displayName }}
                  </td>
                  <td v-bind:title="row.path">
                    {{ row.path }}
                  </td>
                  <td v-bind:title="row.type">
                    {{ row.type }}
                  </td>
                  <td class="numeric">
                    {{ row.size !== undefined ? row.size : '' }}
                  </td>
                  <td>{{ formatModificationTime(row.modtime) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="windows-manager-buttons">
            <button
              type="button"
              class="windows-manager-button"
              v-bind:disabled="selectedRows.length === 0"
              v-on:click="activateSelected()"
            >
              {{ trans('Activate') }}
            </button>
            <button
              type="button"
              class="windows-manager-button"
              v-bind:disabled="selectedRows.length === 0"
              v-on:click="saveSelected()"
            >
              {{ trans('Save') }}
            </button>
            <button
              type="button"
              class="windows-manager-button"
              v-bind:disabled="selectedRows.length === 0"
              v-on:click="closeSelected()"
            >
              {{ trans('Close window(s)') }}
            </button>
            <button
              type="button"
              class="windows-manager-button"
              v-bind:disabled="sortedRows.length === 0"
              v-on:click="sortTabs()"
            >
              {{ trans('Sort tabs') }}
            </button>
            <div class="windows-manager-buttons-spacer"></div>
            <button
              type="button"
              class="windows-manager-button primary"
              v-on:click="emit('close')"
            >
              {{ trans('OK') }}
            </button>
          </div>
        </div>
        <!-- Zettlr-LYH (R104): drag areas on the four edges and four corners -->
        <div
          v-for="edge in resizeEdges"
          v-bind:key="edge"
          class="windows-manager-resize-handle"
          v-bind:class="'edge-' + edge"
          v-bind:data-edge="edge"
          aria-hidden="true"
          v-on:pointerdown="startDialogResize($event, edge)"
        ></div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        WindowsManagerDialog
 * CVM-Role:        View
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH Windows dialog (R72): the window manager of the
 *                  Window menu, modeled on Notepad++'s Windows dialog. It
 *                  lists every open file of this main window once (pane
 *                  order, then tab order; a file open in several panes is one
 *                  row) with name, path, type, size and modification time;
 *                  the column headers sort the list. Activate switches to the
 *                  first selected document in the pane that last had the
 *                  focus (or its first pane), Save writes the selected
 *                  documents with unsaved changes once each, Close window(s)
 *                  closes every tab of the selected files through the batch
 *                  close of the document provider (which asks about unsaved
 *                  changes with Keep All / Discard All Changes), and Sort
 *                  tabs reorders the tabs of every pane to the listed order.
 *                  The list follows the document tree store, so it refreshes
 *                  while open. Zettlr-LYH (R104): the dialog can be resized
 *                  from its edges and corners and stays centered, the columns
 *                  can be resized from the right edge of their headers, and
 *                  both are remembered in localStorage for the next opening
 *                  (see util/windows-manager-layout.ts).
 *
 * END HEADER
 */

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type CSSProperties } from 'vue'
import { trans } from '@common/i18n-renderer'
import { useDocumentTreeStore } from 'source/pinia'
import type { DocumentManagerIPCAPI } from 'source/app/service-providers/documents'
import type { AnyDescriptor } from 'source/types/common/fsal'
import {
  activationLeafId,
  buildSortTabsOrders,
  buildWindowsManagerRows,
  formatModificationTime,
  nextSortState,
  pathsToSave,
  shiftSelectionRange,
  sortWindowsManagerRows,
  type WindowsManagerColumn,
  type WindowsManagerFileMetadata,
  type WindowsManagerRow,
  type WindowsManagerSortState
} from './windows-manager-rows'
import {
  availableDialogArea,
  clampDialogSize,
  displayColumnWidths,
  readWindowsDialogLayout,
  resizeColumn,
  resizeDialogFromEdge,
  writeWindowsDialogLayout,
  WINDOWS_DIALOG_COLUMNS,
  WINDOWS_DIALOG_DEFAULT_COLUMN_PERCENTAGES,
  type ColumnWidths,
  type DialogResizeEdge,
  type DialogSize,
  type WindowsDialogLayoutStorage
} from './util/windows-manager-layout'

const ipcRenderer = window.ipc

const props = defineProps<{
  windowId: string
}>()

const emit = defineEmits<(e: 'close') => void>()

const documentTreeStore = useDocumentTreeStore()

const columns: Array<{ id: WindowsManagerColumn, label: string }> = [
  { id: 'name', label: trans('Name') },
  { id: 'path', label: trans('Path') },
  { id: 'type', label: trans('Type') },
  { id: 'size', label: trans('Size') },
  { id: 'modtime', label: trans('Modified time') }
]

const closeLabel = trans('Close')
const tableLabel = trans('Open documents')

const tableContainer = ref<HTMLDivElement|null>(null)
const metadata = ref<Map<string, WindowsManagerFileMetadata>>(new Map())
const sortState = ref<WindowsManagerSortState>({ column: undefined, direction: 'ascending' })
const selectedKeys = ref<Set<string>>(new Set())
const anchorKey = ref<string|undefined>(undefined)
const cursorKey = ref<string|undefined>(undefined)

let previouslyFocused: Element|null = null
let metadataRequest = 0

// Zettlr-LYH (R104): the size and column widths of the dialog. storedSize is
// the remembered size; the dialog shows it clamped to the current main window,
// which does not change the remembered value. Without columnWidths the
// columns use the default percentages.
const resizeEdges: DialogResizeEdge[] = [ 'n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw' ]

const headerRow = ref<HTMLTableRowElement|null>(null)
const initialLayout = readWindowsDialogLayout(layoutStorage() ?? { getItem: () => null, setItem: () => {} })
const storedSize = ref<DialogSize>({ width: initialLayout.width, height: initialLayout.height })
const columnWidths = ref<ColumnWidths|undefined>(initialLayout.columns)
const viewportSize = ref<DialogSize>({ width: window.innerWidth, height: window.innerHeight })

interface DialogResizeDrag {
  kind: 'dialog'
  pointerId: number
  edge: DialogResizeEdge
  startX: number
  startY: number
  startSize: DialogSize
  available: DialogSize
}

interface ColumnResizeDrag {
  kind: 'column'
  pointerId: number
  column: WindowsManagerColumn
  startX: number
  startWidths: ColumnWidths
}

let activeDrag: DialogResizeDrag|ColumnResizeDrag|undefined
// Set when a column drag ends, so that the click the browser fires right after
// the release does not sort by that column
let swallowHeaderClick = false

const availableArea = computed<DialogSize>(() => availableDialogArea(viewportSize.value.width, viewportSize.value.height))

const displayedSize = computed<DialogSize>(() => clampDialogSize(storedSize.value, availableArea.value))

const displayedColumnWidths = computed<ColumnWidths|undefined>(() => {
  return columnWidths.value !== undefined ? displayColumnWidths(columnWidths.value) : undefined
})

const dialogStyle = computed<CSSProperties>(() => ({
  width: `${displayedSize.value.width}px`,
  height: `${displayedSize.value.height}px`
}))

// With pixel column widths, the table is as wide as its columns, and the
// table container scrolls horizontally when that is wider than the container
const tableStyle = computed<CSSProperties|undefined>(() => {
  const widths = displayedColumnWidths.value
  if (widths === undefined) {
    return undefined
  }
  const total = WINDOWS_DIALOG_COLUMNS.reduce((sum, column) => sum + widths[column], 0)
  return { width: `${total}px` }
})

const rows = computed<WindowsManagerRow[]>(() => {
  return buildWindowsManagerRows(
    documentTreeStore.paneData,
    metadata.value,
    documentTreeStore.modifiedDocuments,
    trans
  )
})

const sortedRows = computed<WindowsManagerRow[]>(() => sortWindowsManagerRows(rows.value, sortState.value))

const selectedRows = computed<WindowsManagerRow[]>(() => {
  return sortedRows.value.filter(row => selectedKeys.value.has(row.key))
})

const dialogTitle = computed<string>(() => trans('Windows - Total documents: %s', rows.value.length))

// The disk metadata is fetched again whenever the open files change, and
// whenever the modification status changes (a save changes size and time)
const metadataTrigger = computed<string>(() => {
  const paths = [...new Set(rows.value.map(row => row.path))].sort()
  return paths.join('\n') + '\u0000' + documentTreeStore.modifiedDocuments.join('\n')
})

watch(metadataTrigger, () => {
  refreshMetadata().catch(err => console.error(err))
}, { immediate: true })

// Drop selected keys whose tabs were closed in the meantime
watch(rows, (newRows) => {
  const existing = new Set(newRows.map(row => row.key))
  const remaining = [...selectedKeys.value].filter(key => existing.has(key))
  if (remaining.length !== selectedKeys.value.size) {
    selectedKeys.value = new Set(remaining)
  }
  if (anchorKey.value !== undefined && !existing.has(anchorKey.value)) {
    anchorKey.value = undefined
  }
  if (cursorKey.value !== undefined && !existing.has(cursorKey.value)) {
    cursorKey.value = remaining[0]
  }
})

onMounted(() => {
  previouslyFocused = document.activeElement
  tableContainer.value?.focus()
  // Capture phase, so that Escape closes the dialog before anything else sees it
  window.addEventListener('keydown', onWindowKeydown, true)
  window.addEventListener('resize', onWindowResize)
  onWindowResize()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown, true)
  window.removeEventListener('resize', onWindowResize)
  removeDragListeners()
  activeDrag = undefined
  if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
    previouslyFocused.focus()
  }
})

/**
 * Fetches size, modification time and type of every open file from the disk.
 */
async function refreshMetadata (): Promise<void> {
  const request = ++metadataRequest
  const paths = [...new Set(rows.value.map(row => row.path))]
  if (paths.length === 0) {
    metadata.value = new Map()
    return
  }
  const descriptors: AnyDescriptor[] = await ipcRenderer.invoke('fsal', {
    command: 'get-descriptor',
    payload: paths
  })
  if (request !== metadataRequest) {
    return // A newer request is underway
  }
  const newMetadata = new Map<string, WindowsManagerFileMetadata>()
  for (const descriptor of descriptors) {
    newMetadata.set(descriptor.path, {
      size: descriptor.size,
      modtime: descriptor.modtime,
      type: descriptor.type
    })
  }
  metadata.value = newMetadata
}

/**
 * Escape is the same as OK.
 *
 * @param   {KeyboardEvent}  event  The key press
 */
function onWindowKeydown (event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.isComposing) {
    return
  }
  event.preventDefault()
  event.stopPropagation()
  emit('close')
}

/**
 * The arrow keys move the selection (with Shift: extend it), Enter activates,
 * Delete closes the selected tabs.
 *
 * @param   {KeyboardEvent}  event  The key press
 */
function onTableKeydown (event: KeyboardEvent): void {
  if (event.isComposing) {
    return
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    moveCursor(event.key === 'ArrowDown' ? 1 : -1, event.shiftKey)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    activateSelected()
  } else if (event.key === 'Delete') {
    event.preventDefault()
    closeSelected()
  } else if (event.key === 'a' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    selectedKeys.value = new Set(sortedRows.value.map(row => row.key))
  }
}

/**
 * Moves the keyboard cursor one row up or down.
 *
 * @param   {number}   step    1 for down, -1 for up
 * @param   {boolean}  extend  Whether to extend the selection from the anchor
 */
function moveCursor (step: number, extend: boolean): void {
  const keys = sortedRows.value.map(row => row.key)
  if (keys.length === 0) {
    return
  }
  const currentIndex = cursorKey.value !== undefined ? keys.indexOf(cursorKey.value) : -1
  let newIndex = currentIndex < 0 ? (step > 0 ? 0 : keys.length - 1) : currentIndex + step
  newIndex = Math.max(0, Math.min(keys.length - 1, newIndex))
  const newKey = keys[newIndex]
  cursorKey.value = newKey
  if (extend) {
    if (anchorKey.value === undefined) {
      anchorKey.value = currentIndex >= 0 ? keys[currentIndex] : newKey
    }
    selectedKeys.value = new Set(shiftSelectionRange(keys, anchorKey.value, newKey))
  } else {
    anchorKey.value = newKey
    selectedKeys.value = new Set([newKey])
  }
  scrollRowIntoView(newKey)
}

/**
 * Scrolls the row with the given key into view.
 *
 * @param   {string}  key  The row key
 */
function scrollRowIntoView (key: string): void {
  nextTick().then(() => {
    const rowElements = tableContainer.value?.querySelectorAll<HTMLElement>('tbody tr') ?? []
    for (const element of Array.from(rowElements)) {
      if (element.dataset.key === key) {
        element.scrollIntoView({ block: 'nearest' })
        break
      }
    }
  }).catch(err => console.error(err))
}

/**
 * Prevents the text selection a Shift-click would otherwise extend.
 *
 * @param   {MouseEvent}  event  The mouse event
 */
function onRowMousedown (event: MouseEvent): void {
  if (event.shiftKey) {
    event.preventDefault()
  }
  tableContainer.value?.focus()
}

/**
 * A click selects the row; Ctrl toggles it, Shift selects the range from the
 * anchor.
 *
 * @param   {MouseEvent}         event  The mouse event
 * @param   {WindowsManagerRow}  row    The clicked row
 */
function onRowClick (event: MouseEvent, row: WindowsManagerRow): void {
  const keys = sortedRows.value.map(r => r.key)
  if (event.shiftKey) {
    const range = shiftSelectionRange(keys, anchorKey.value, row.key)
    if (event.ctrlKey || event.metaKey) {
      selectedKeys.value = new Set([ ...selectedKeys.value, ...range ])
    } else {
      selectedKeys.value = new Set(range)
    }
    if (anchorKey.value === undefined) {
      anchorKey.value = row.key
    }
  } else if (event.ctrlKey || event.metaKey) {
    const newSelection = new Set(selectedKeys.value)
    if (newSelection.has(row.key)) {
      newSelection.delete(row.key)
    } else {
      newSelection.add(row.key)
    }
    selectedKeys.value = newSelection
    anchorKey.value = row.key
  } else {
    selectedKeys.value = new Set([row.key])
    anchorKey.value = row.key
  }
  cursorKey.value = row.key
}

/**
 * A click on a column header sorts by that column, or switches the direction.
 *
 * @param   {WindowsManagerColumn}  column  The column
 */
function clickColumnHeader (column: WindowsManagerColumn): void {
  if (swallowHeaderClick) {
    // The release of a column drag, not a click on the header
    swallowHeaderClick = false
    return
  }
  sortState.value = nextSortState(sortState.value, column)
}

/**
 * Zettlr-LYH (R104): the storage of the remembered layout, or undefined if
 * localStorage cannot be accessed.
 *
 * @return  {WindowsDialogLayoutStorage|undefined}  The storage
 */
function layoutStorage (): WindowsDialogLayoutStorage|undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

/**
 * Remembers the current size and column widths for the next opening.
 */
function persistLayout (): void {
  const storage = layoutStorage()
  if (storage === undefined) {
    return
  }
  writeWindowsDialogLayout(storage, {
    width: storedSize.value.width,
    height: storedSize.value.height,
    columns: columnWidths.value
  })
}

/**
 * Follows the size of the main window; this only changes how the remembered
 * size is clamped for display.
 */
function onWindowResize (): void {
  viewportSize.value = { width: window.innerWidth, height: window.innerHeight }
}

/**
 * The width of a column: in pixels once a column was resized, else the
 * default percentage.
 *
 * @param   {WindowsManagerColumn}  column  The column
 *
 * @return  {CSSProperties}                 The style of its col element
 */
function columnStyle (column: WindowsManagerColumn): CSSProperties {
  const widths = displayedColumnWidths.value
  if (widths === undefined) {
    return { width: `${WINDOWS_DIALOG_DEFAULT_COLUMN_PERCENTAGES[column]}%` }
  }
  return { width: `${widths[column]}px` }
}

/**
 * The current pixel widths of the header cells, the starting point of the
 * first column drag.
 *
 * @return  {ColumnWidths}  The widths
 */
function measureColumnWidths (): ColumnWidths {
  const widths: Partial<ColumnWidths> = {}
  for (const column of WINDOWS_DIALOG_COLUMNS) {
    const cell = headerRow.value?.querySelector<HTMLElement>(`th[data-column="${column}"]`)
    widths[column] = Math.round(cell?.getBoundingClientRect().width ?? 0)
  }
  return displayColumnWidths(widths as ColumnWidths)
}

/**
 * Starts resizing the dialog from one of its edges or corners.
 *
 * @param   {PointerEvent}      event  The pointerdown event on the drag area
 * @param   {DialogResizeEdge}  edge   The edge or corner
 */
function startDialogResize (event: PointerEvent, edge: DialogResizeEdge): void {
  if (event.button !== 0 || activeDrag !== undefined) {
    return
  }
  event.preventDefault()
  event.stopPropagation()
  activeDrag = {
    kind: 'dialog',
    pointerId: event.pointerId,
    edge,
    startX: event.clientX,
    startY: event.clientY,
    startSize: { ...displayedSize.value },
    available: { ...availableArea.value }
  }
  beginPointerDrag(event)
}

/**
 * Starts resizing a column from the right edge of its header. The first
 * column drag starts from the widths the columns have on screen.
 *
 * @param   {PointerEvent}          event   The pointerdown event on the separator
 * @param   {WindowsManagerColumn}  column  The column
 */
function startColumnResize (event: PointerEvent, column: WindowsManagerColumn): void {
  if (event.button !== 0 || activeDrag !== undefined) {
    return
  }
  event.preventDefault()
  event.stopPropagation()
  const startWidths = displayedColumnWidths.value ?? measureColumnWidths()
  activeDrag = {
    kind: 'column',
    pointerId: event.pointerId,
    column,
    startX: event.clientX,
    startWidths: { ...startWidths }
  }
  beginPointerDrag(event)
}

/**
 * Captures the pointer on the drag area and follows it until it is released.
 *
 * @param   {PointerEvent}  event  The pointerdown event
 */
function beginPointerDrag (event: PointerEvent): void {
  const target = event.currentTarget as HTMLElement|null
  if (target !== null && typeof target.setPointerCapture === 'function') {
    try {
      target.setPointerCapture(event.pointerId)
    } catch {
      // The pointer is no longer active; the window listeners still follow it
    }
  }
  window.addEventListener('pointermove', onDragPointerMove)
  window.addEventListener('pointerup', onDragPointerUp)
  window.addEventListener('pointercancel', onDragPointerCancel)
}

/**
 * Stops following the pointer.
 */
function removeDragListeners (): void {
  window.removeEventListener('pointermove', onDragPointerMove)
  window.removeEventListener('pointerup', onDragPointerUp)
  window.removeEventListener('pointercancel', onDragPointerCancel)
}

/**
 * Applies the pointer position to the size or column being dragged.
 *
 * @param   {PointerEvent}  event  A pointer event of the drag
 */
function applyDrag (event: PointerEvent): void {
  if (activeDrag === undefined) {
    return
  }
  if (activeDrag.kind === 'dialog') {
    storedSize.value = resizeDialogFromEdge(
      activeDrag.startSize,
      activeDrag.edge,
      event.clientX - activeDrag.startX,
      event.clientY - activeDrag.startY,
      activeDrag.available
    )
  } else {
    columnWidths.value = resizeColumn(activeDrag.startWidths, activeDrag.column, event.clientX - activeDrag.startX)
  }
}

/**
 * Follows the pointer during a drag.
 *
 * @param   {PointerEvent}  event  The pointermove event
 */
function onDragPointerMove (event: PointerEvent): void {
  if (activeDrag === undefined || event.pointerId !== activeDrag.pointerId) {
    return
  }
  event.preventDefault()
  applyDrag(event)
}

/**
 * Ends a drag where the pointer was released and remembers the layout.
 *
 * @param   {PointerEvent}  event  The pointerup event
 */
function onDragPointerUp (event: PointerEvent): void {
  if (activeDrag === undefined || event.pointerId !== activeDrag.pointerId) {
    return
  }
  applyDrag(event)
  finishDrag()
}

/**
 * Ends a drag the system cancelled, keeping the last size, and remembers the
 * layout.
 *
 * @param   {PointerEvent}  event  The pointercancel event
 */
function onDragPointerCancel (event: PointerEvent): void {
  if (activeDrag === undefined || event.pointerId !== activeDrag.pointerId) {
    return
  }
  finishDrag()
}

/**
 * Ends the current drag. After a column drag, the click that follows the
 * release in the same task is swallowed; should no click follow, the flag is
 * dropped before the next task.
 */
function finishDrag (): void {
  const wasColumnDrag = activeDrag?.kind === 'column'
  activeDrag = undefined
  removeDragListeners()
  if (wasColumnDrag) {
    swallowHeaderClick = true
    setTimeout(() => { swallowHeaderClick = false }, 0)
  }
  persistLayout()
}

/**
 * The sort arrow of a column header.
 *
 * @param   {WindowsManagerColumn}  column  The column
 *
 * @return  {string}                        The arrow
 */
function sortIndicator (column: WindowsManagerColumn): string {
  if (sortState.value.column !== column) {
    return '⇅'
  }
  return sortState.value.direction === 'ascending' ? '▲' : '▼'
}

/**
 * The aria-sort value of a column header.
 *
 * @param   {WindowsManagerColumn}  column  The column
 *
 * @return  {string}                        The value
 */
function ariaSort (column: WindowsManagerColumn): 'ascending'|'descending'|'none' {
  return sortState.value.column === column ? sortState.value.direction : 'none'
}

/**
 * Switches to the given file and closes the dialog. Zettlr-LYH Windows dialog
 * (R72): a file open in several panes is activated in the pane that last had
 * the focus, or else in its first pane.
 *
 * @param   {WindowsManagerRow}  row  The row
 */
function activateRow (row: WindowsManagerRow): void {
  const leafId = activationLeafId(row, documentTreeStore.lastLeafId)
  ipcRenderer.invoke('documents-provider', {
    command: 'open-file',
    payload: { path: row.path, windowId: props.windowId, leafId, newTab: false }
  } satisfies DocumentManagerIPCAPI)
    .then(() => ipcRenderer.invoke('documents-provider', {
      command: 'focus-leaf',
      payload: { windowId: props.windowId, leafId }
    } satisfies DocumentManagerIPCAPI))
    .catch(err => console.error(err))
  emit('close')
}

/**
 * Activates the first selected document.
 */
function activateSelected (): void {
  const first = selectedRows.value[0]
  if (first !== undefined) {
    activateRow(first)
  }
}

/**
 * Saves the selected documents that have unsaved changes.
 */
function saveSelected (): void {
  const paths = pathsToSave(selectedRows.value)
  ;(async () => {
    for (const path of paths) {
      await ipcRenderer.invoke('documents-provider', {
        command: 'save-file',
        payload: { path }
      } satisfies DocumentManagerIPCAPI)
    }
  })().catch(err => console.error(err))
}

/**
 * Zettlr-LYH Windows dialog (R72): closes every tab of the selected files in
 * this window through the batch close of the document provider. A single
 * file with unsaved changes gets the regular question; with several files,
 * each file with unsaved changes is asked about with Keep All and Discard All
 * Changes next to Save, Don't Save and Cancel, and Cancel keeps that file
 * while the others are still closed. The files kept open stay selected.
 */
function closeSelected (): void {
  const paths = selectedRows.value.map(row => row.path)
  if (paths.length === 0) {
    return
  }
  ;(async () => {
    await ipcRenderer.invoke('documents-provider', {
      command: 'close-files-batch',
      payload: { windowId: props.windowId, paths }
    } satisfies DocumentManagerIPCAPI)
  })()
    .catch(err => console.error(err))
    .finally(() => { tableContainer.value?.focus() })
}

/**
 * Reorders the tabs of every pane to the order of the list.
 */
function sortTabs (): void {
  const orders = buildSortTabsOrders(sortedRows.value)
  ;(async () => {
    for (const { leafId, newOrder } of orders) {
      await ipcRenderer.invoke('documents-provider', {
        command: 'sort-open-files',
        payload: { newOrder, windowId: props.windowId, leafId }
      } satisfies DocumentManagerIPCAPI)
    }
  })().catch(err => console.error(err))
}
</script>

<style lang="less">
// Zettlr-LYH Windows dialog (R72): follows the flat design language of the
// conflict merge overlay (square corners, 1 px borders, neutral and
// action-blue fills); body.dark switches to dark colors.
.windows-manager-overlay {
  position: fixed;
  inset: 0;
  z-index: 99000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  box-sizing: border-box;
  background-color: rgba(0, 0, 0, 0.45);

  // Zettlr-LYH (R104): width and height are set inline from the remembered
  // layout (default 960 by 620 pixels)
  .windows-manager-dialog {
    position: relative;
    display: flex;
    flex-direction: column;
    max-width: 100%;
    max-height: 100%;
    background-color: #ffffff;
    color: #1f2328;
    border: 1px solid #c0c4cc;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.35);
  }

  // Drag areas 6 pixels wide (WINDOWS_DIALOG_RESIZE_HANDLE_SIZE), centered on
  // the border; the corners lie above the edges
  .windows-manager-resize-handle {
    position: absolute;
    z-index: 2;
    touch-action: none;

    &.edge-n, &.edge-s {
      left: 3px;
      right: 3px;
      height: 6px;
      cursor: ns-resize;
    }

    &.edge-e, &.edge-w {
      top: 3px;
      bottom: 3px;
      width: 6px;
      cursor: ew-resize;
    }

    &.edge-ne, &.edge-nw, &.edge-se, &.edge-sw {
      z-index: 3;
      width: 6px;
      height: 6px;
    }

    &.edge-n, &.edge-ne, &.edge-nw { top: -3px; }
    &.edge-s, &.edge-se, &.edge-sw { bottom: -3px; }
    &.edge-e, &.edge-ne, &.edge-se { right: -3px; }
    &.edge-w, &.edge-nw, &.edge-sw { left: -3px; }
    &.edge-ne, &.edge-sw { cursor: nesw-resize; }
    &.edge-nw, &.edge-se { cursor: nwse-resize; }
  }

  .windows-manager-header {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 8px 8px 8px 16px;
    border-bottom: 1px solid #dcdfe5;
  }

  .windows-manager-title {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 14px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  button.windows-manager-close {
    flex: 0 0 auto;
    min-width: 0;
    width: 28px;
    height: 28px;
    padding: 0;
    border: none;
    border-radius: 0;
    background: none;
    color: #374151;
    font-size: 14px;

    &:hover {
      background-color: #e81123;
      color: #ffffff;
    }
  }

  .windows-manager-body {
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
    gap: 16px;
    padding: 12px 16px 16px 16px;
  }

  .windows-manager-table-container {
    flex: 1 1 auto;
    min-width: 0;
    overflow: auto;
    border: 1px solid #c0c4cc;
    background-color: #ffffff;
    outline: none;

    &:focus-visible {
      border-color: #3b78d1;
    }
  }

  // Zettlr-LYH (R104): the col widths are set inline, as percentages until a
  // column is resized and in pixels afterwards; then the table is set inline
  // to the sum of the columns instead of 100%
  .windows-manager-table {
    width: 100%;
    table-layout: fixed;
    border-collapse: collapse;
    font-size: 13px;
    user-select: none;

    .windows-manager-column-resizer {
      position: absolute;
      top: 0;
      right: 0;
      bottom: 0;
      width: 6px;
      cursor: col-resize;
      touch-action: none;

      &:hover {
        background-color: rgba(59, 120, 209, 0.35);
      }
    }

    th, td {
      padding: 3px 8px;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      text-align: left;
    }

    th.numeric, td.numeric {
      text-align: right;
    }

    thead th {
      position: sticky;
      top: 0;
      z-index: 1;
      background-color: #eceef2;
      color: #374151;
      font-weight: bold;
      border-bottom: 1px solid #dcdfe5;
      border-right: 1px solid #dcdfe5;
      cursor: pointer;

      &:hover {
        background-color: #dcdfe5;
      }
    }

    .windows-manager-sort-indicator {
      display: inline-block;
      min-width: 1em;
      font-size: 10px;
      color: #6b7280;
    }

    tbody tr {
      cursor: default;

      &:hover {
        background-color: #f4f5f7;
      }

      &.selected {
        background-color: #d6e8fa;
        color: #1a3d6b;
      }

      &.cursor td:first-child {
        box-shadow: inset 2px 0 0 #3b78d1;
      }
    }
  }

  .windows-manager-buttons {
    display: flex;
    flex-direction: column;
    flex: 0 0 140px;
    gap: 8px;
  }

  .windows-manager-buttons-spacer {
    flex: 1 1 auto;
  }

  button.windows-manager-button {
    min-width: 0;
    background-color: #eceef2;
    color: #374151;
    border: 1px solid #c0c4cc;
    border-radius: 0;
    padding: 5px 14px;
    font-weight: bold;

    &:hover:not(:disabled) {
      border-color: #3b78d1;
      color: #111827;
    }

    &:active:not(:disabled) {
      background-color: #dcdfe5;
    }

    &:disabled {
      opacity: 0.5;
    }

    &.primary {
      background-color: #d6e8fa;
      color: #1a3d6b;
      border-color: #b8d2ec;

      &:hover:not(:disabled) {
        border-color: #3b78d1;
        background-color: #e6f2ff;
      }

      &:active:not(:disabled) {
        background-color: #b8d2ec;
      }
    }
  }
}

body.dark .windows-manager-overlay {
  background-color: rgba(0, 0, 0, 0.6);

  .windows-manager-dialog {
    background-color: #2b2b2c;
    color: #e0e0e0;
    border-color: #505050;
  }

  .windows-manager-header {
    border-bottom-color: #3c3c3c;
  }

  button.windows-manager-close {
    color: #d0d0d0;

    &:hover {
      background-color: #e81123;
      color: #ffffff;
    }
  }

  .windows-manager-table-container {
    background-color: #2b2b2c;
    border-color: #505050;

    &:focus-visible {
      border-color: #3b78d1;
    }
  }

  .windows-manager-table {
    thead th {
      background-color: #333436;
      color: #d0d0d0;
      border-bottom-color: #3c3c3c;
      border-right-color: #3c3c3c;

      &:hover {
        background-color: #3a3b3d;
      }
    }

    .windows-manager-sort-indicator {
      color: #a0a0a0;
    }

    tbody tr {
      &:hover {
        background-color: #333436;
      }

      &.selected {
        background-color: #24476e;
        color: #e6f2ff;
      }
    }
  }

  button.windows-manager-button {
    background-color: #3a3b3d;
    color: #e0e0e0;
    border-color: #55575b;

    &:hover:not(:disabled) {
      border-color: #3b78d1;
      color: #ffffff;
    }

    &:active:not(:disabled) {
      background-color: #303133;
    }

    &.primary {
      background-color: #24476e;
      color: #e6f2ff;
      border-color: #3b78d1;

      &:hover:not(:disabled) {
        background-color: #2c5584;
      }

      &:active:not(:disabled) {
        background-color: #1d3a5a;
      }
    }
  }
}
</style>
