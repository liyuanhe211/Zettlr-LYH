/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Table column resizing
 * CVM-Role:        View
 * License:         GNU GPL v3
 *
 * Description:     Lets the user change the width of a table column by
 *                  dragging the vertical line to its right (or the right
 *                  border of the last column). The widths set this way are only
 *                  remembered in the memory of the renderer process, under the
 *                  path of the document and the position of the table among the
 *                  top-level tables of the document: they survive the table
 *                  being rendered again, a cell being edited and the document
 *                  being shown again after another tab, but they are neither
 *                  written to the Markdown file nor part of the undo history.
 *                  A double click on the line removes the remembered width of
 *                  its column again, so that the column fits its contents.
 *
 * END HEADER
 */

/**
 * The class of the table cells in a column that has a width set by dragging.
 * Their text may wrap at any character, so that the column can be narrower than
 * the longest word.
 */
export const COLUMN_RESIZED_CLASS = 'cm-table-column-resized'

/**
 * The class of a table (and of the element around it) while the mouse is on a
 * draggable line (or a column is being dragged): the whole table then shows the
 * resize cursor. The element around the table carries it as well, because the
 * part of the grab area to the right of the last column's border lies outside of
 * the table.
 */
export const COLUMN_RESIZE_HOVER_CLASS = 'cm-table-column-resize-hover'

/**
 * How far (in pixels) the mouse may be from a vertical line, to the left or to
 * the right of it, and still grab it.
 */
export const COLUMN_RESIZE_HIT_DISTANCE = 4

/**
 * The narrowest a column can be dragged, in multiples of the cells' font size.
 * This is the same as the `min-width` of the cells in the table theme.
 */
export const MINIMUM_COLUMN_WIDTH_IN_EM = 3

/**
 * How far (in pixels) the mouse has to move after the button went down before
 * the movement counts as a drag. A plain click (or the clicks of a double click)
 * on a line therefore never changes a column.
 */
const DRAG_THRESHOLD = 3

/**
 * The font size (in pixels) to compute the minimum width from if the browser
 * cannot tell the font size of a cell.
 */
const FALLBACK_FONT_SIZE = 16

/**
 * The widths of the columns of one table in pixels. A column without a width
 * that was set by dragging has `null` and fits its contents.
 */
export type ColumnWidths = Array<number|null>

/**
 * Where the borders of a table are, in client coordinates.
 */
export interface TableGeometry {
  /**
   * The vertical coordinate of the table's top border
   */
  top: number
  /**
   * The vertical coordinate of the table's bottom border
   */
  bottom: number
  /**
   * The horizontal coordinates of the table's vertical borders, from the left
   * border of the table to the right border of its last column. A table with n
   * columns has n + 1 of them; the first one cannot be dragged.
   */
  edges: number[]
}

/**
 * The narrowest width a column can be dragged to.
 *
 * @param   {number}  fontSize  The computed font size of the column's cells
 *
 * @return  {number}            The width in pixels
 */
export function minimumColumnWidth (fontSize: number): number {
  return MINIMUM_COLUMN_WIDTH_IN_EM * fontSize
}

/**
 * The width of a column while its right line is dragged: the width at the start
 * of the drag plus the movement of the mouse, but not below the minimum width.
 *
 * @param   {number}  startWidth    The width when the drag started
 * @param   {number}  deltaX        The horizontal movement of the mouse since
 *                                  the start of the drag
 * @param   {number}  minimumWidth  The narrowest width allowed
 *
 * @return  {number}                The new width in pixels
 */
export function resizedColumnWidth (startWidth: number, deltaX: number, minimumWidth: number): number {
  return Math.max(minimumWidth, startWidth + deltaX)
}

/**
 * Finds the column whose right line the point is on: the point has to be
 * between the top and the bottom border of the table and at most
 * COLUMN_RESIZE_HIT_DISTANCE away from the line. The left border of the table
 * is not a line of any column.
 *
 * @param   {TableGeometry}  geometry  The borders of the table
 * @param   {number}         x         The horizontal client coordinate
 * @param   {number}         y         The vertical client coordinate
 *
 * @return  {number}                   The column's index, or -1 if the point is
 *                                     not on a line
 */
export function columnBorderAt (geometry: TableGeometry, x: number, y: number): number {
  if (y < geometry.top || y > geometry.bottom) {
    return -1
  }

  let hitColumn = -1
  let hitDistance = Infinity
  for (let column = 0; column < geometry.edges.length - 1; column++) {
    const distance = Math.abs(x - geometry.edges[column + 1])
    if (distance <= COLUMN_RESIZE_HIT_DISTANCE && distance < hitDistance) {
      hitColumn = column
      hitDistance = distance
    }
  }
  return hitColumn
}

/**
 * The column widths set by dragging: for each document path (the path of the
 * file as the main editor knows it), for each table of the document (counted
 * among the top-level tables, from 0), the width of each column. A table is
 * only in here while at least one of its columns has a width.
 */
const REMEMBERED_WIDTHS = new Map<string, Map<number, ColumnWidths>>()

/**
 * Removes the remembered widths of one table.
 *
 * @param  {string}                   documentPath  The document's path
 * @param  {Map<number,ColumnWidths>} tables        The remembered tables of the document
 * @param  {number}                   tableIndex    The table's index in the document
 */
function dropTable (documentPath: string, tables: Map<number, ColumnWidths>, tableIndex: number): void {
  tables.delete(tableIndex)
  if (tables.size === 0) {
    REMEMBERED_WIDTHS.delete(documentPath)
  }
}

/**
 * Remembers the width of one column of a table. If the table was remembered
 * with a different number of columns, those widths are forgotten.
 *
 * @param  {string}  documentPath  The document's path
 * @param  {number}  tableIndex    The table's index among the top-level tables
 * @param  {number}  columnCount   The number of columns the table has now
 * @param  {number}  column        The column's index
 * @param  {number}  width         The column's width in pixels
 */
export function rememberColumnWidth (documentPath: string, tableIndex: number, columnCount: number, column: number, width: number): void {
  let tables = REMEMBERED_WIDTHS.get(documentPath)
  if (tables === undefined) {
    tables = new Map()
    REMEMBERED_WIDTHS.set(documentPath, tables)
  }

  let widths = tables.get(tableIndex)
  if (widths === undefined || widths.length !== columnCount) {
    widths = new Array<number|null>(columnCount).fill(null)
    tables.set(tableIndex, widths)
  }
  if (column >= 0 && column < columnCount) {
    widths[column] = width
  }
}

/**
 * Returns the remembered column widths of a table. If the table was remembered
 * with a different number of columns than it has now, its columns have changed
 * and the remembered widths are forgotten instead.
 *
 * @param   {string}              documentPath  The document's path
 * @param   {number}              tableIndex    The table's index among the top-level tables
 * @param   {number}              columnCount   The number of columns the table has now
 *
 * @return  {ColumnWidths|undefined}            A copy of the widths, or undefined
 *                                              if no column of the table has one
 */
export function rememberedColumnWidths (documentPath: string, tableIndex: number, columnCount: number): ColumnWidths|undefined {
  const tables = REMEMBERED_WIDTHS.get(documentPath)
  const widths = tables?.get(tableIndex)
  if (tables === undefined || widths === undefined) {
    return undefined
  }

  if (widths.length !== columnCount) {
    dropTable(documentPath, tables, tableIndex)
    return undefined
  }
  return [...widths]
}

/**
 * Forgets the width of one column, so that the column fits its contents again.
 * A table without any other remembered column is forgotten altogether.
 *
 * @param  {string}  documentPath  The document's path
 * @param  {number}  tableIndex    The table's index among the top-level tables
 * @param  {number}  column        The column's index
 */
export function forgetColumnWidth (documentPath: string, tableIndex: number, column: number): void {
  const tables = REMEMBERED_WIDTHS.get(documentPath)
  const widths = tables?.get(tableIndex)
  if (tables === undefined || widths === undefined) {
    return
  }

  if (column >= 0 && column < widths.length) {
    widths[column] = null
  }
  if (widths.every(width => width === null)) {
    dropTable(documentPath, tables, tableIndex)
  }
}

/**
 * Forgets the widths of all the tables of a document, as when its last tab in
 * the window has been closed.
 *
 * @param  {string}  documentPath  The document's path
 */
export function forgetDocumentColumnWidths (documentPath: string): void {
  REMEMBERED_WIDTHS.delete(documentPath)
}

/**
 * Forgets all remembered widths.
 */
export function forgetAllColumnWidths (): void {
  REMEMBERED_WIDTHS.clear()
}

/**
 * Counts the tables that have remembered column widths.
 *
 * @param   {string}  documentPath  If given, only the tables of this document
 *
 * @return  {number}                The number of tables
 */
export function rememberedTableCount (documentPath?: string): number {
  if (documentPath !== undefined) {
    return REMEMBERED_WIDTHS.get(documentPath)?.size ?? 0
  }

  let count = 0
  for (const tables of REMEMBERED_WIDTHS.values()) {
    count += tables.size
  }
  return count
}

/**
 * The widths each table element has been given by applyColumnWidths, so that
 * they can be given again after the table's own column width lock has removed
 * them (see widget.ts).
 */
const APPLIED_WIDTHS = new WeakMap<HTMLTableElement, ColumnWidths>()

/**
 * Gives the cells of every column that has a width exactly that width (as the
 * width of the cell's border box), and lets the text in them wrap anywhere. All
 * other columns fit their contents again. Setting the width on every cell of the
 * column, not only on the first row's, is what makes the automatic table layout
 * give the column exactly this width, whatever its cells contain.
 *
 * @param  {HTMLTableElement}  table   The table element
 * @param  {ColumnWidths}      widths  The width of each column; null for the
 *                                     columns that fit their contents
 * @param  {boolean}           locked  Whether the table's column widths are
 *                                     currently frozen (while a cell is
 *                                     edited). The widths of the cells that
 *                                     fit their contents again then stay until
 *                                     the table is laid out anew, since they
 *                                     are what keeps the table from reflowing.
 */
export function applyColumnWidths (table: HTMLTableElement, widths: ColumnWidths, locked: boolean): void {
  APPLIED_WIDTHS.set(table, widths)

  for (const row of [...table.rows]) {
    const cells = row.cells
    for (let column = 0; column < cells.length; column++) {
      const cell = cells[column]
      const width = column < widths.length ? widths[column] : null
      if (width !== null) {
        cell.style.boxSizing = 'border-box'
        cell.style.width = `${width}px`
        cell.classList.add(COLUMN_RESIZED_CLASS)
      } else if (cell.classList.contains(COLUMN_RESIZED_CLASS)) {
        cell.classList.remove(COLUMN_RESIZED_CLASS)
        if (!locked) {
          cell.style.boxSizing = ''
          cell.style.width = ''
        }
      }
    }
  }
}

/**
 * Gives the cells the widths that applyColumnWidths has given them last. This
 * is for after something else has cleared the inline widths of all cells.
 *
 * @param  {HTMLTableElement}  table  The table element
 */
export function reapplyColumnWidths (table: HTMLTableElement): void {
  const widths = APPLIED_WIDTHS.get(table)
  if (widths !== undefined) {
    applyColumnWidths(table, widths, false)
  }
}

/**
 * What the resizing needs to know from, and to tell, the table widget.
 */
export interface ColumnResizeHost {
  /**
   * The path of the document the table belongs to
   */
  documentPath: () => string
  /**
   * Whether the table's column widths are frozen at the moment (a cell is being
   * edited)
   */
  isLocked: (table: HTMLTableElement) => boolean
  /**
   * Called after the widths of the table have changed, so that the editor
   * measures the table's new height
   */
  resized: (table: HTMLTableElement) => void
  /**
   * Fits the columns of a frozen table to their contents again and freezes the
   * result (for a column that fits its contents again while a cell is edited)
   */
  refit: (table: HTMLTableElement) => void
}

/**
 * The drag that is currently going on, if any. Only one can be going on at any
 * time.
 */
let activeResize: { end: (commit: boolean) => void }|undefined

/**
 * Shows or hides the resize cursor on a table and on the element around it.
 *
 * @param  {HTMLTableElement}  table  The table element
 * @param  {boolean}           show   Whether the mouse is on a draggable line
 */
function setResizeCursor (table: HTMLTableElement, show: boolean): void {
  table.classList.toggle(COLUMN_RESIZE_HOVER_CLASS, show)
  table.parentElement?.classList.toggle(COLUMN_RESIZE_HOVER_CLASS, show)
}

/**
 * Reads the borders of the table from the layout.
 *
 * @param   {HTMLTableElement}       table  The table element
 *
 * @return  {TableGeometry|undefined}       The borders, or undefined for a table
 *                                          without cells
 */
function tableGeometry (table: HTMLTableElement): TableGeometry|undefined {
  const firstRow = table.rows[0]
  if (firstRow === undefined || firstRow.cells.length === 0) {
    return undefined
  }

  const cells = [...firstRow.cells]
  const tableRect = table.getBoundingClientRect()
  return {
    top: tableRect.top,
    bottom: tableRect.bottom,
    edges: [ cells[0].getBoundingClientRect().left, ...cells.map(cell => cell.getBoundingClientRect().right) ]
  }
}

/**
 * Finds the column whose right line is at a point of the screen.
 *
 * @param   {HTMLTableElement}  table  The table element
 * @param   {number}            x      The horizontal client coordinate
 * @param   {number}            y      The vertical client coordinate
 *
 * @return  {number}                   The column's index, or -1 if there is no line
 */
function columnBorderOfTableAt (table: HTMLTableElement, x: number, y: number): number {
  const geometry = tableGeometry(table)
  return geometry === undefined ? -1 : columnBorderAt(geometry, x, y)
}

/**
 * The computed font size of a cell.
 *
 * @param   {HTMLTableCellElement}  cell  The cell
 *
 * @return  {number}                      The font size in pixels
 */
function cellFontSize (cell: HTMLTableCellElement): number {
  const fontSize = parseFloat(window.getComputedStyle(cell).fontSize)
  return Number.isFinite(fontSize) && fontSize > 0 ? fontSize : FALLBACK_FONT_SIZE
}

/**
 * Under which key the widths of a table are remembered.
 *
 * @param   {HTMLTableElement}   table  The table element
 * @param   {ColumnResizeHost}   host   The table widget
 *
 * @return  {object|undefined}          The key, or undefined if the table has
 *                                      not been given its position yet
 */
function storageKey (table: HTMLTableElement, host: ColumnResizeHost): { documentPath: string, tableIndex: number, columnCount: number }|undefined {
  const tableIndex = parseInt(table.dataset.tableIndex ?? '', 10)
  const columnCount = table.rows[0]?.cells.length ?? 0
  if (Number.isNaN(tableIndex) || columnCount === 0) {
    return undefined
  }
  return { documentPath: host.documentPath(), tableIndex, columnCount }
}

/**
 * Sets or removes the width of one column: remembers it, shows it, and tells
 * the editor to measure the table again.
 *
 * @param  {HTMLTableElement}  table   The table element
 * @param  {ColumnResizeHost}  host    The table widget
 * @param  {number}            column  The column's index
 * @param  {number|null}       width   The new width in pixels, or null for a
 *                                     column that fits its contents
 */
function setColumnWidth (table: HTMLTableElement, host: ColumnResizeHost, column: number, width: number|null): void {
  const key = storageKey(table, host)
  if (key === undefined) {
    return
  }

  const locked = host.isLocked(table)
  // A frozen table has a width of its own, which has to follow the column
  const widthBefore = locked ? table.rows[0].cells[column].getBoundingClientRect().width : 0
  const hadWidth = (rememberedColumnWidths(key.documentPath, key.tableIndex, key.columnCount)?.[column] ?? null) !== null

  if (width === null) {
    forgetColumnWidth(key.documentPath, key.tableIndex, column)
  } else {
    rememberColumnWidth(key.documentPath, key.tableIndex, key.columnCount, column, width)
  }
  applyColumnWidths(table, rememberedColumnWidths(key.documentPath, key.tableIndex, key.columnCount) ?? [], locked)

  if (locked) {
    if (width === null) {
      if (hadWidth) {
        host.refit(table)
      }
    } else {
      const tableWidth = parseFloat(table.style.width)
      if (Number.isFinite(tableWidth)) {
        table.style.width = `${tableWidth + width - widthBefore}px`
      }
    }
  }
  host.resized(table)
}

/**
 * Follows a drag of a column's right line from the button press until the
 * button is released (the width is then kept), or until the drag is cancelled
 * with Escape, by the window losing the focus or by the system (the column then
 * has the width it had before the button went down).
 *
 * @param  {HTMLTableElement}  table       The table element
 * @param  {ColumnResizeHost}  host        The table widget
 * @param  {number}            column      The column to resize
 * @param  {MouseEvent}        startEvent  The button press
 */
function startResize (table: HTMLTableElement, host: ColumnResizeHost, column: number, startEvent: MouseEvent): void {
  activeResize?.end(true)

  const cell = table.rows[0].cells[column]
  const key = storageKey(table, host)
  const startX = startEvent.clientX
  const startWidth = cell.getBoundingClientRect().width
  const minimumWidth = minimumColumnWidth(cellFontSize(cell))
  const widthBefore = key === undefined
    ? null
    : rememberedColumnWidths(key.documentPath, key.tableIndex, key.columnCount)?.[column] ?? null
  let moved = false

  setResizeCursor(table, true)

  const resizeTo = (x: number): void => {
    const deltaX = x - startX
    if (!moved && Math.abs(deltaX) < DRAG_THRESHOLD) {
      return
    }
    moved = true
    setColumnWidth(table, host, column, resizedColumnWidth(startWidth, deltaX, minimumWidth))
  }

  const onMouseMove = (event: MouseEvent): void => {
    if ((event.buttons & 1) === 0) {
      // The button was released outside of the window
      end(true)
      return
    }
    resizeTo(event.clientX)
  }

  const onMouseUp = (event: MouseEvent): void => {
    if (event.button !== 0) {
      return
    }
    resizeTo(event.clientX)
    end(true)
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      end(false)
    }
  }

  const onCancel = (): void => {
    end(false)
  }

  // The click that follows the release of a drag must not do anything
  const swallowClick = (event: MouseEvent): void => {
    event.preventDefault()
    event.stopPropagation()
  }

  const end = (commit: boolean): void => {
    window.removeEventListener('mousemove', onMouseMove, true)
    window.removeEventListener('mouseup', onMouseUp, true)
    window.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('blur', onCancel)
    window.removeEventListener('pointercancel', onCancel, true)
    activeResize = undefined
    setResizeCursor(table, false)

    if (!commit && moved) {
      setColumnWidth(table, host, column, widthBefore)
    }
    if (moved) {
      window.addEventListener('click', swallowClick, true)
      setTimeout(() => { window.removeEventListener('click', swallowClick, true) }, 0)
    }
  }

  window.addEventListener('mousemove', onMouseMove, true)
  window.addEventListener('mouseup', onMouseUp, true)
  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('blur', onCancel)
  window.addEventListener('pointercancel', onCancel, true)
  activeResize = { end }
}

/**
 * Makes the vertical lines of a table draggable: shows the resize cursor on
 * them, starts a drag with the left mouse button and removes a column's width
 * with a double click. The button press on a line is intercepted before the
 * cells see it, so that it neither edits a cell, nor selects cells, nor opens an
 * image.
 *
 * @param  {HTMLElement}       wrapper  The element around the table that
 *                                      receives the events
 * @param  {HTMLTableElement}  table    The table element
 * @param  {ColumnResizeHost}  host     The table widget
 */
export function attachColumnResize (wrapper: HTMLElement, table: HTMLTableElement, host: ColumnResizeHost): void {
  wrapper.addEventListener('mousedown', event => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
      return
    }

    const column = columnBorderOfTableAt(table, event.clientX, event.clientY)
    if (column < 0) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    startResize(table, host, column, event)
  }, true)

  wrapper.addEventListener('mousemove', event => {
    if (activeResize === undefined) {
      setResizeCursor(table, columnBorderOfTableAt(table, event.clientX, event.clientY) >= 0)
    }
  }, { capture: true, passive: true })

  wrapper.addEventListener('mouseleave', () => {
    if (activeResize === undefined) {
      setResizeCursor(table, false)
    }
  })

  wrapper.addEventListener('dblclick', event => {
    const column = columnBorderOfTableAt(table, event.clientX, event.clientY)
    if (column < 0) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    setColumnWidth(table, host, column, null)
  }, true)
}
