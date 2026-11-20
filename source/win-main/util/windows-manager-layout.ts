/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        readWindowsDialogLayout, writeWindowsDialogLayout,
 *                  availableDialogArea, clampDialogSize,
 *                  resizeDialogFromEdge, resizeColumn, displayColumnWidths
 * CVM-Role:        Utility function
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH (R104): the size and the column widths of the
 *                  Windows dialog of the Window menu (R72). The dialog can be
 *                  resized from its four edges and four corners and stays
 *                  centered, so that its width and height change by twice the
 *                  pointer movement; the five columns can be resized from the
 *                  right edge of their headers. The layout is remembered as
 *                  one JSON value under WINDOWS_DIALOG_LAYOUT_STORAGE_KEY.
 *                  The functions receive the storage as an argument (in the
 *                  dialog: window.localStorage) and import neither Vue nor
 *                  the DOM, so that mocha can test them directly. Broken or
 *                  unreadable storage contents never throw; the affected part
 *                  falls back to its default.
 *
 * END HEADER
 */

import type { WindowsManagerColumn } from '../windows-manager-rows'

/**
 * The key of the remembered layout in the renderer's localStorage
 */
export const WINDOWS_DIALOG_LAYOUT_STORAGE_KEY = 'zettlr-lyh-windows-dialog-layout'

/**
 * The format version of the stored value; any other version is ignored
 */
export const WINDOWS_DIALOG_LAYOUT_VERSION = 1

/**
 * The size of the dialog until the user resizes it, in pixels
 */
export const WINDOWS_DIALOG_DEFAULT_WIDTH = 960
export const WINDOWS_DIALOG_DEFAULT_HEIGHT = 620

/**
 * The smallest size of the dialog, in pixels
 */
export const WINDOWS_DIALOG_MIN_WIDTH = 560
export const WINDOWS_DIALOG_MIN_HEIGHT = 320

/**
 * The padding of the overlay around the dialog on every side, in pixels; the
 * dialog never grows into it
 */
export const WINDOWS_DIALOG_OVERLAY_PADDING = 24

/**
 * The width of the drag areas on the edges of the dialog and on the right
 * edge of the column headers, in pixels (the stylesheet of the dialog uses
 * the same value)
 */
export const WINDOWS_DIALOG_RESIZE_HANDLE_SIZE = 6

/**
 * The smallest width of a column, in pixels
 */
export const WINDOWS_DIALOG_MIN_COLUMN_WIDTH = 40

/**
 * The columns of the dialog in display order
 */
export const WINDOWS_DIALOG_COLUMNS: readonly WindowsManagerColumn[] = [ 'name', 'path', 'type', 'size', 'modtime' ]

/**
 * The column widths, in percent of the table, until the user resizes a column
 */
export const WINDOWS_DIALOG_DEFAULT_COLUMN_PERCENTAGES: Readonly<Record<WindowsManagerColumn, number>> = {
  name: 26,
  path: 30,
  type: 12,
  size: 11,
  modtime: 21
}

/**
 * The part of the Web Storage interface these functions use; localStorage
 * satisfies it, tests pass an in-memory stand-in
 */
export type WindowsDialogLayoutStorage = Pick<Storage, 'getItem'|'setItem'>

/**
 * A width and a height in pixels
 */
export interface DialogSize {
  width: number
  height: number
}

/**
 * The pixel width of every column
 */
export type ColumnWidths = Record<WindowsManagerColumn, number>

/**
 * The remembered layout. Without `columns`, the columns use the default
 * percentages.
 */
export interface WindowsDialogLayout extends DialogSize {
  columns?: ColumnWidths
}

/**
 * An edge or corner of the dialog: north, south, east, west and their
 * combinations
 */
export type DialogResizeEdge = 'n'|'s'|'e'|'w'|'ne'|'nw'|'se'|'sw'

/**
 * Whether a value is a finite number greater than zero
 *
 * @param   {unknown}  value  Any value
 *
 * @return  {boolean}         True for a finite positive number
 */
function isFinitePositive (value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * Reads the column widths of a stored value. The widths are used only if all
 * five columns have a finite positive width, because pixel widths cannot be
 * mixed with the default percentages.
 *
 * @param   {unknown}                  value  The `columns` member of the stored value
 *
 * @return  {ColumnWidths|undefined}          The widths, or undefined
 */
function readColumnWidths (value: unknown): ColumnWidths|undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }

  const record = value as Record<string, unknown>
  const widths: Partial<ColumnWidths> = {}
  for (const column of WINDOWS_DIALOG_COLUMNS) {
    const width = record[column]
    if (!isFinitePositive(width)) {
      return undefined
    }
    widths[column] = width
  }

  return widths as ColumnWidths
}

/**
 * Reads the remembered layout. A missing value, invalid JSON, a value that is
 * no object or has another version than WINDOWS_DIALOG_LAYOUT_VERSION, and a
 * storage that throws all yield the default layout. Within a usable value,
 * a width or height that is no finite positive number falls back to its
 * default, and the column widths are dropped unless all five are finite
 * positive numbers. The values are returned as stored; clamping them to the
 * main window is up to the caller.
 *
 * @param   {WindowsDialogLayoutStorage}  storage  The storage to read from
 *
 * @return  {WindowsDialogLayout}                  A new layout object
 */
export function readWindowsDialogLayout (storage: WindowsDialogLayoutStorage): WindowsDialogLayout {
  const defaults: WindowsDialogLayout = {
    width: WINDOWS_DIALOG_DEFAULT_WIDTH,
    height: WINDOWS_DIALOG_DEFAULT_HEIGHT
  }

  let parsed: unknown
  try {
    const raw = storage.getItem(WINDOWS_DIALOG_LAYOUT_STORAGE_KEY)
    if (raw === null) {
      return defaults
    }
    parsed = JSON.parse(raw)
  } catch {
    return defaults
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return defaults
  }

  const record = parsed as Record<string, unknown>
  if (record.version !== WINDOWS_DIALOG_LAYOUT_VERSION) {
    return defaults
  }

  const layout: WindowsDialogLayout = {
    width: isFinitePositive(record.width) ? record.width : WINDOWS_DIALOG_DEFAULT_WIDTH,
    height: isFinitePositive(record.height) ? record.height : WINDOWS_DIALOG_DEFAULT_HEIGHT
  }
  const columns = readColumnWidths(record.columns)
  if (columns !== undefined) {
    layout.columns = columns
  }

  return layout
}

/**
 * Remembers a layout. Without column widths, the stored value has no
 * `columns` member. A width, height or column width that is no finite
 * positive number is not stored (the previous value stays); a storage that
 * throws (e.g. because it is full) is ignored.
 *
 * @param   {WindowsDialogLayoutStorage}  storage  The storage to write to
 * @param   {WindowsDialogLayout}         layout   The layout to remember
 */
export function writeWindowsDialogLayout (storage: WindowsDialogLayoutStorage, layout: WindowsDialogLayout): void {
  if (!isFinitePositive(layout.width) || !isFinitePositive(layout.height)) {
    return
  }

  const value: Record<string, unknown> = {
    version: WINDOWS_DIALOG_LAYOUT_VERSION,
    width: layout.width,
    height: layout.height
  }
  if (layout.columns !== undefined) {
    const columns = readColumnWidths(layout.columns)
    if (columns === undefined) {
      return
    }
    // Fixed member order, independent of the order of the given object
    const ordered: Record<string, number> = {}
    for (const column of WINDOWS_DIALOG_COLUMNS) {
      ordered[column] = columns[column]
    }
    value.columns = ordered
  }

  try {
    storage.setItem(WINDOWS_DIALOG_LAYOUT_STORAGE_KEY, JSON.stringify(value))
  } catch {
    // Storage full or unavailable: the layout is simply not remembered
  }
}

/**
 * The area the dialog may occupy inside a main window of the given inner
 * size: the window less the overlay padding on every side
 *
 * @param   {number}      viewportWidth   The inner width of the main window
 * @param   {number}      viewportHeight  The inner height of the main window
 *
 * @return  {DialogSize}                  The available area
 */
export function availableDialogArea (viewportWidth: number, viewportHeight: number): DialogSize {
  return {
    width: Math.max(0, viewportWidth - 2 * WINDOWS_DIALOG_OVERLAY_PADDING),
    height: Math.max(0, viewportHeight - 2 * WINDOWS_DIALOG_OVERLAY_PADDING)
  }
}

/**
 * Clamps a dialog size to the available area and to the minimum size. The
 * minimum wins when the available area is smaller than it.
 *
 * @param   {DialogSize}  size       The wanted size
 * @param   {DialogSize}  available  The available area
 *
 * @return  {DialogSize}             A new, clamped size
 */
export function clampDialogSize (size: DialogSize, available: DialogSize): DialogSize {
  return {
    width: Math.max(WINDOWS_DIALOG_MIN_WIDTH, Math.min(available.width, size.width)),
    height: Math.max(WINDOWS_DIALOG_MIN_HEIGHT, Math.min(available.height, size.height))
  }
}

/**
 * The size of the dialog while one of its edges or corners is dragged. The
 * dialog stays centered and the dragged edge follows the pointer, so the
 * width and height change by twice the pointer movement: dragging the east
 * edge to the right or the west edge to the left widens the dialog, dragging
 * the south edge down or the north edge up makes it taller. The result is
 * clamped with clampDialogSize.
 *
 * @param   {DialogSize}        start      The size when the drag started
 * @param   {DialogResizeEdge}  edge       The dragged edge or corner
 * @param   {number}            dx         Horizontal pointer movement since the start
 * @param   {number}            dy         Vertical pointer movement since the start
 * @param   {DialogSize}        available  The available area
 *
 * @return  {DialogSize}                   A new size
 */
export function resizeDialogFromEdge (
  start: DialogSize,
  edge: DialogResizeEdge,
  dx: number,
  dy: number,
  available: DialogSize
): DialogSize {
  let width = start.width
  let height = start.height
  if (edge.includes('e')) {
    width += 2 * dx
  } else if (edge.includes('w')) {
    width -= 2 * dx
  }
  if (edge.includes('s')) {
    height += 2 * dy
  } else if (edge.includes('n')) {
    height -= 2 * dy
  }

  return clampDialogSize({ width, height }, available)
}

/**
 * The column widths while the right edge of one column header is dragged:
 * that column changes by the pointer movement, but not below
 * WINDOWS_DIALOG_MIN_COLUMN_WIDTH; the other columns keep their width.
 *
 * @param   {ColumnWidths}          widths  The widths when the drag started
 * @param   {WindowsManagerColumn}  column  The resized column
 * @param   {number}                dx      Horizontal pointer movement since the start
 *
 * @return  {ColumnWidths}                  A new widths object
 */
export function resizeColumn (widths: ColumnWidths, column: WindowsManagerColumn, dx: number): ColumnWidths {
  return {
    ...widths,
    [column]: Math.max(WINDOWS_DIALOG_MIN_COLUMN_WIDTH, widths[column] + dx)
  }
}

/**
 * The widths the columns are displayed with: a stored width below
 * WINDOWS_DIALOG_MIN_COLUMN_WIDTH is shown at that minimum.
 *
 * @param   {ColumnWidths}  widths  The remembered widths
 *
 * @return  {ColumnWidths}          A new widths object
 */
export function displayColumnWidths (widths: ColumnWidths): ColumnWidths {
  const displayed: Partial<ColumnWidths> = {}
  for (const column of WINDOWS_DIALOG_COLUMNS) {
    displayed[column] = Math.max(WINDOWS_DIALOG_MIN_COLUMN_WIDTH, widths[column])
  }
  return displayed as ColumnWidths
}
