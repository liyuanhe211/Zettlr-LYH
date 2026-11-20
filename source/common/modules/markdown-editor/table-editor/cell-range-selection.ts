/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Table cell drag selection
 * CVM-Role:        View
 * License:         GNU GPL v3
 *
 * Description:     Handles dragging the mouse inside a table. A drag that stays
 *                  within one cell selects text in that cell, also if the cell
 *                  was not being edited when the mouse button went down (its
 *                  editor only gets mounted after the click). A drag across
 *                  cells selects the rectangular range of cells between the
 *                  start and the current cell; the range can be copied to the
 *                  clipboard as tab-separated plain text and as an HTML table.
 *                  If the range consists of entire rows, entire columns or the
 *                  entire table, Delete and Backspace remove them; any other
 *                  range cannot be deleted. While dragging, moving the mouse
 *                  close to or beyond the edge of the scrolling container
 *                  scrolls it, as in the rest of the editor.
 *
 * END HEADER
 */

import { syntaxTree } from '@codemirror/language'
import { type ChangeSpec, type EditorState, Prec, StateEffect, StateField, type TransactionSpec } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import type { Table } from '../../markdown-utils/markdown-ast'
import { parseTableNode } from '../../markdown-utils/markdown-ast/parse-table-node'
import { buildColumnDeletionChanges } from './commands/columns'
import { buildTableClipboardHTML } from './commands/row-clipboard'
import { buildRowDeletionChanges } from './commands/rows'
import { buildTableDeletion } from './commands/tables'
import { collectTableNodes } from './util/table-nodes'

/**
 * The class of the table cells inside the selected range of cells.
 */
export const CELL_RANGE_SELECTED_CLASS = 'cm-table-cell-range-selected'

/**
 * The class of the main editor while a range of cells is selected.
 */
const CELL_RANGE_ACTIVE_CLASS = 'cm-table-cell-range-active'

/**
 * How far (in pixels) the mouse has to move after the button went down before
 * the movement counts as a drag. Below that, it remains a plain click, so that
 * the cursor stays where the click has put it.
 */
const DRAG_THRESHOLD = 4

/**
 * How many animation frames to wait for a cell's editor to be mounted before
 * giving up on selecting text in it.
 */
const MOUNT_WAIT_FRAMES = 10

/**
 * How close (in pixels) the mouse has to come to the edge of the scrolling
 * container during a drag before it starts scrolling. Same as CodeMirror's own
 * drag selection.
 */
const DRAG_SCROLL_MARGIN = 6

/**
 * How often (in milliseconds) the scrolling container scrolls while the mouse
 * is held near its edge during a drag. Same as CodeMirror's own drag selection.
 */
const DRAG_SCROLL_INTERVAL = 50

/**
 * Computes how far (in pixels, per scroll step) a drag should scroll along one
 * axis, given the mouse coordinate and the visible range of the scrolling
 * container along that axis. Negative values scroll backwards (up or left),
 * zero means no scrolling. The speed grows with the distance beyond the edge,
 * as in CodeMirror's own drag selection.
 *
 * @param   {number}  pointer  The mouse coordinate
 * @param   {number}  start    The start of the visible range (top or left)
 * @param   {number}  end      The end of the visible range (bottom or right)
 *
 * @return  {number}           The scroll amount per step
 */
export function dragScrollAmount (pointer: number, start: number, end: number): number {
  if (pointer <= start + DRAG_SCROLL_MARGIN) {
    return -(Math.max(0, start - pointer) * 0.7 + 8)
  } else if (pointer >= end - DRAG_SCROLL_MARGIN) {
    return Math.max(0, pointer - end) * 0.7 + 8
  }
  return 0
}

/**
 * Finds the nearest ancestors of an element that scroll horizontally and
 * vertically.
 *
 * @param   {HTMLElement}  element  The element
 *
 * @return  {{ x: HTMLElement|null, y: HTMLElement|null }}  The scrolling
 *                                  ancestors (null: the window scrolls)
 */
function scrollingAncestors (element: HTMLElement): { x: HTMLElement|null, y: HTMLElement|null } {
  let x: HTMLElement|null = null
  let y: HTMLElement|null = null
  for (let current = element.parentElement; current !== null && current !== document.body; current = current.parentElement) {
    const style = getComputedStyle(current)
    if (x === null && current.scrollWidth > current.clientWidth && style.overflowX !== 'visible' && style.overflowX !== 'hidden') {
      x = current
    }
    if (y === null && current.scrollHeight > current.clientHeight && style.overflowY !== 'visible' && style.overflowY !== 'hidden') {
      y = current
    }
    if (x !== null && y !== null) {
      break
    }
  }
  return { x, y }
}

export interface CellCoordinates {
  row: number
  col: number
}

/**
 * A rectangular range of cells in one table. `tableFrom` identifies the table
 * by its start in the document; `anchor` is the cell where the drag started,
 * `head` the cell where it currently is.
 */
export interface CellRangeSelection {
  tableFrom: number
  anchor: CellCoordinates
  head: CellCoordinates
}

/**
 * The inclusive row and column bounds of a range of cells.
 */
export interface CellRangeBounds {
  top: number
  bottom: number
  left: number
  right: number
}

/**
 * Sets the selected range of cells, or removes it (`null`).
 */
export const setCellRangeSelection = StateEffect.define<CellRangeSelection|null>()

/**
 * Holds the selected range of cells, if any. Any change to the document or to
 * the main selection removes it, so that clicking anywhere or typing ends the
 * cell selection.
 */
export const cellRangeSelectionField = StateField.define<CellRangeSelection|null>({
  create () {
    return null
  },
  update (value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setCellRangeSelection)) {
        return effect.value
      }
    }

    if (value !== null && (tr.docChanged || tr.selection !== undefined)) {
      return null
    }

    return value
  }
})

/**
 * Returns the bounds of a range of cells.
 *
 * @param   {CellRangeSelection}  range  The range of cells
 *
 * @return  {CellRangeBounds}            Its bounds
 */
export function cellRangeBounds (range: CellRangeSelection): CellRangeBounds {
  return {
    top: Math.min(range.anchor.row, range.head.row),
    bottom: Math.max(range.anchor.row, range.head.row),
    left: Math.min(range.anchor.col, range.head.col),
    right: Math.max(range.anchor.col, range.head.col)
  }
}

/**
 * Checks whether a cell lies within the bounds of a range of cells.
 *
 * @param   {CellRangeBounds}  bounds  The bounds
 * @param   {number}           row     The row index of the cell
 * @param   {number}           col     The column index of the cell
 *
 * @return  {boolean}                  Whether the cell is in the range
 */
export function isCellInBounds (bounds: CellRangeBounds, row: number, col: number): boolean {
  return row >= bounds.top && row <= bounds.bottom && col >= bounds.left && col <= bounds.right
}

/**
 * Returns the bounds of the selected range of cells if it belongs to the
 * table starting at `tableFrom`.
 *
 * @param   {EditorState}               state      The main editor state
 * @param   {number}                    tableFrom  The start of the table
 *
 * @return  {CellRangeBounds|undefined}            The bounds, if any
 */
export function activeCellRangeBounds (state: EditorState, tableFrom: number): CellRangeBounds|undefined {
  const range = state.field(cellRangeSelectionField, false)
  if (range === undefined || range === null || range.tableFrom !== tableFrom) {
    return undefined
  }
  return cellRangeBounds(range)
}

/**
 * Determines into which of a series of consecutive intervals a coordinate
 * falls, given the end of every interval. Coordinates before the first
 * interval count towards the first one, coordinates after the last one
 * towards the last one.
 *
 * @param   {number[]}  ends   The (ascending) end coordinates of the intervals
 * @param   {number}    value  The coordinate
 *
 * @return  {number}           The index of the interval
 */
export function indexForCoordinate (ends: number[], value: number): number {
  const index = ends.findIndex(end => value < end)
  return index < 0 ? ends.length - 1 : index
}

/**
 * Cuts the cells within the bounds out of a matrix of cell texts.
 *
 * @param   {string[][]}       cellTexts  The cell texts, by row and cell
 * @param   {CellRangeBounds}  bounds     The bounds
 *
 * @return  {string[][]}                  The cell texts within the bounds
 */
export function cellTextsInBounds (cellTexts: string[][], bounds: CellRangeBounds): string[][] {
  return cellTexts
    .slice(bounds.top, bounds.bottom + 1)
    .map(row => row.slice(bounds.left, bounds.right + 1))
}

/**
 * Builds the clipboard contents for a range of cells: Tab-separated plain text
 * (one line per row) and an HTML table, as for copying a table row.
 *
 * @param   {string[][]}  cellTexts  The cell texts, by row and cell
 *
 * @return  {{ plainText: string, html: string }}  The clipboard contents
 */
export function buildCellRangeClipboard (cellTexts: string[][]): { plainText: string, html: string } {
  return {
    plainText: cellTexts.map(row => row.join('\t')).join('\n'),
    html: buildTableClipboardHTML(cellTexts)
  }
}

/**
 * What deleting a range of cells does: `table` deletes the entire table, `rows`
 * the rows of the range, `columns` the columns of the range, and `none` means
 * that the range cannot be deleted.
 */
export type CellRangeDeletionKind = 'table'|'rows'|'columns'|'none'

/**
 * Determines what deleting a range of cells would delete. Only entire rows
 * (the range spans all columns), entire columns (the range spans all rows) or
 * the entire table (both) can be deleted. A single cell is only deletable if it
 * is the whole row or the whole column, i.e., if the table has only one column
 * or only one row.
 *
 * @param   {CellRangeBounds}          bounds       The bounds of the range
 * @param   {number}                   rowCount     The number of rows in the
 *                                                  table, including the header
 * @param   {number}                   columnCount  The number of columns
 *
 * @return  {CellRangeDeletionKind}                 What the range can delete
 */
export function classifyCellRangeForDeletion (
  bounds: CellRangeBounds,
  rowCount: number,
  columnCount: number
): CellRangeDeletionKind {
  if (rowCount < 1 || columnCount < 1) {
    return 'none'
  }

  const coversAllColumns = bounds.left <= 0 && bounds.right >= columnCount - 1
  const coversAllRows = bounds.top <= 0 && bounds.bottom >= rowCount - 1

  if (coversAllColumns && coversAllRows) {
    return 'table'
  } else if (coversAllColumns) {
    return 'rows'
  } else if (coversAllRows) {
    return 'columns'
  } else {
    return 'none'
  }
}

/**
 * Lists the integers from `first` to `last` (both included).
 *
 * @param   {number}    first  The first integer
 * @param   {number}    last   The last integer
 *
 * @return  {number[]}         The integers
 */
function integersBetween (first: number, last: number): number[] {
  return Array.from({ length: Math.max(0, last - first + 1) }, (_item, offset) => first + offset)
}

/**
 * Finds the table a range of cells belongs to and parses it.
 *
 * @param   {EditorState}          state  The main editor state
 * @param   {CellRangeSelection}   range  The range of cells
 *
 * @return  {{ tableNode: SyntaxNode, tableAST: Table }|undefined}  The table's
 *                                        syntax node and the parsed table, if
 *                                        it exists
 */
function findCellRangeTable (
  state: EditorState,
  range: CellRangeSelection
): { tableNode: SyntaxNode, tableAST: Table }|undefined {
  const tableNode = collectTableNodes(syntaxTree(state))
    .find(node => node.from <= range.tableFrom && node.to >= range.tableFrom)
  if (tableNode === undefined) {
    return undefined
  }

  const tableAST = parseTableNode(tableNode, state.sliceDoc())
  return tableAST.type === 'Table' ? { tableNode, tableAST } : undefined
}

/**
 * Plans the deletion of a range of cells. The range index of a row is its
 * index in the parsed table (the header row is 0, the delimiter row of a pipe
 * table does not count), which is also the index of the table row in the
 * rendered table.
 *
 * @param   {EditorState}          state  The main editor state
 * @param   {CellRangeSelection}   range  The range of cells
 *
 * @return  {TransactionSpec|undefined}   The transaction that deletes the
 *                                        entire rows, the entire columns or the
 *                                        entire table of the range as one step,
 *                                        or undefined if the range cannot be
 *                                        deleted (or deleting it would not
 *                                        change the document)
 */
export function planCellRangeDeletion (
  state: EditorState,
  range: CellRangeSelection
): TransactionSpec|undefined {
  const table = findCellRangeTable(state, range)
  if (table === undefined) {
    return undefined
  }

  const { tableNode, tableAST } = table
  const rowCount = tableAST.rows.length
  const columnCount = tableAST.rows[0]?.cells.length ?? 0
  if (tableAST.rows.some(row => row.cells.length !== columnCount)) {
    return undefined // The rows of the table don't line up
  }

  const bounds = cellRangeBounds(range)
  const rowsInRange = integersBetween(Math.max(0, bounds.top), Math.min(rowCount - 1, bounds.bottom))
  const columnsInRange = integersBetween(Math.max(0, bounds.left), Math.min(columnCount - 1, bounds.right))

  let changes: ChangeSpec[]
  switch (classifyCellRangeForDeletion(bounds, rowCount, columnCount)) {
    case 'table':
      return buildTableDeletion(state, tableAST.from, tableAST.to)
    case 'rows':
      changes = buildRowDeletionChanges(state, tableNode, tableAST, rowsInRange)
      break
    case 'columns':
      changes = buildColumnDeletionChanges(state, tableNode, tableAST, columnsInRange)
      break
    default:
      return undefined
  }

  return changes.length > 0 ? { changes } : undefined
}

/**
 * Checks whether a key press asks to delete the selected cells: Delete or
 * Backspace, without any modifier.
 *
 * @param   {KeyboardEvent}  event  The key press
 *
 * @return  {boolean}               Whether it is a deletion
 */
function isCellRangeDeletionKey (event: KeyboardEvent): boolean {
  return (event.key === 'Delete' || event.key === 'Backspace') &&
    !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
}

/**
 * Writes the selected range of cells to the clipboard of a copy event.
 *
 * @param   {EditorView}      view   The main view
 * @param   {ClipboardEvent}  event  The copy event
 *
 * @return  {boolean}                Whether a range of cells was copied
 */
function copyCellRange (view: EditorView, event: ClipboardEvent): boolean {
  const range = view.state.field(cellRangeSelectionField, false)
  if (range === undefined || range === null || event.clipboardData === null) {
    return false
  }

  const table = findCellRangeTable(view.state, range)
  if (table === undefined) {
    return false
  }

  const tableAST = table.tableAST
  const cellTexts = tableAST.rows.map(row => {
    return row.cells.map(cell => view.state.sliceDoc(cell.from, cell.to).trim())
  })
  const { plainText, html } = buildCellRangeClipboard(cellTextsInBounds(cellTexts, cellRangeBounds(range)))

  event.clipboardData.setData('text/plain', plainText)
  event.clipboardData.setData('text/html', html)
  event.preventDefault()
  return true
}

/**
 * While a range of cells is selected, the main view has the keyboard focus,
 * and its cursor sits inside the table's source. Copying writes the cells to
 * the clipboard. Delete and Backspace delete the selected cells if they are
 * entire rows, entire columns or the entire table (see
 * `planCellRangeDeletion`); the deletion ends the cell selection. If the cells
 * are anything else, the key press changes nothing and the cell selection stays.
 * Any other key (apart from lone modifiers) only ends the cell selection, so
 * that no keystroke can edit the table's source behind the rendered table; the
 * cursor then returns into the cell where the drag started.
 */
const cellRangeSelectionHandlers = Prec.highest(EditorView.domEventHandlers({
  copy (event, view) {
    return copyCellRange(view, event)
  },
  keydown (event, view) {
    const range = view.state.field(cellRangeSelectionField, false)
    if (range === undefined || range === null) {
      return false
    }

    if ([ 'Control', 'Shift', 'Alt', 'Meta' ].includes(event.key)) {
      return false
    }

    const isCopy = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'c'
    if (isCopy) {
      return false // Let the copy event happen
    }

    event.preventDefault()

    if (isCellRangeDeletionKey(event)) {
      // The deletion changes the document, which ends the cell selection. If
      // there is nothing to delete, the cell selection stays.
      const deletion = planCellRangeDeletion(view.state, range)
      if (deletion !== undefined) {
        view.dispatch(deletion)
      }
      return true
    }

    view.dispatch({ effects: setCellRangeSelection.of(null) })
    return true
  }
}))

/**
 * The extensions the main view needs for selecting ranges of cells.
 */
export const cellRangeSelection = [
  cellRangeSelectionField,
  cellRangeSelectionHandlers,
  EditorView.editorAttributes.compute([cellRangeSelectionField], (state): Record<string, string> => {
    return state.field(cellRangeSelectionField) !== null ? { class: CELL_RANGE_ACTIVE_CLASS } : {}
  }),
  EditorView.baseTheme({
    // The main view's cursor sits at the drag's starting cell, which would make
    // it show up within the selected cells.
    [`&.${CELL_RANGE_ACTIVE_CLASS} .cm-cursorLayer`]: { display: 'none' }
  })
]

/**
 * Returns the row and column index of a table cell element.
 *
 * @param   {HTMLTableElement}         table  The table
 * @param   {HTMLTableCellElement}     cell   The cell
 *
 * @return  {CellCoordinates|undefined}       Its coordinates, if it belongs to
 *                                            the table
 */
function cellCoordinatesOf (table: HTMLTableElement, cell: HTMLTableCellElement): CellCoordinates|undefined {
  const row = [...table.rows].indexOf(cell.parentElement as HTMLTableRowElement)
  return row < 0 ? undefined : { row, col: cell.cellIndex }
}

/**
 * Returns the coordinates of the table cell at the given client coordinates.
 * Points outside the table count towards the nearest row and column, so that
 * dragging beyond the table's edges extends the range up to the edge.
 *
 * @param   {HTMLTableElement}           table  The table
 * @param   {number}                     x      The horizontal client coordinate
 * @param   {number}                     y      The vertical client coordinate
 *
 * @return  {CellCoordinates|undefined}         The cell's coordinates
 */
function cellCoordinatesAt (table: HTMLTableElement, x: number, y: number): CellCoordinates|undefined {
  const rows = [...table.rows]
  if (rows.length === 0) {
    return undefined
  }

  const row = indexForCoordinate(rows.map(tr => tr.getBoundingClientRect().bottom), y)
  const cells = [...rows[row].cells]
  if (cells.length === 0) {
    return undefined
  }

  const col = indexForCoordinate(cells.map(cell => cell.getBoundingClientRect().right), x)
  return { row, col }
}

/**
 * Ends the drag that is currently being tracked, if any.
 */
let endActiveDrag: (() => void)|undefined

/**
 * Follows a drag that starts with a mouse button press in a table cell, until
 * the button is released.
 *
 * While the mouse stays in the starting cell, the text from `anchorPosition`
 * to the mouse is selected in the cell's editor, unless `nativeSelection` is
 * set: The cell's editor already existed when the button went down and selects
 * the text on its own. Once the mouse moves into another cell, the range of
 * cells between the two is selected instead. Moving back into the starting
 * cell selects text again.
 *
 * @param   {EditorView}            view             The main view
 * @param   {HTMLTableCellElement}  cell             The cell of the button press
 * @param   {MouseEvent}            startEvent       The button press
 * @param   {number}                anchorPosition   The document position where
 *                                                   a text selection in the
 *                                                   starting cell begins
 * @param   {boolean}               nativeSelection  Whether the cell's editor
 *                                                   handles the drag within
 *                                                   the starting cell itself
 */
export function trackCellDrag (
  view: EditorView,
  cell: HTMLTableCellElement,
  startEvent: MouseEvent,
  anchorPosition: number,
  nativeSelection: boolean
): void {
  endActiveDrag?.()

  const table = cell.closest('table')
  if (table === null) {
    return
  }

  const tableFrom = parseInt(table.dataset.tableFrom ?? '', 10)
  const anchor = cellCoordinatesOf(table, cell)
  const contentWrapper = cell.querySelector<HTMLElement>('div.content')
  if (Number.isNaN(tableFrom) || anchor === undefined || contentWrapper === null) {
    return
  }

  let dragging = false
  let inCellRange = false
  let leftStartingCell = false
  let point = { x: startEvent.clientX, y: startEvent.clientY }
  let waitFrame: number|undefined
  let waitFramesLeft = 0
  const scrollers = scrollingAncestors(table)
  let scrollSpeed = { x: 0, y: 0 }
  let scrollTimer: ReturnType<typeof setInterval>|undefined

  const selectTextInStartingCell = (): void => {
    if (waitFrame !== undefined) {
      cancelAnimationFrame(waitFrame)
      waitFrame = undefined
    }

    const subview = EditorView.findFromDOM(contentWrapper)
    if (subview === null) {
      // The cell's editor gets mounted in an animation frame after the click
      // (or after the cell range has been removed again), so wait for it.
      if (waitFramesLeft > 0) {
        waitFramesLeft--
        waitFrame = requestAnimationFrame(() => {
          waitFrame = undefined
          selectTextInStartingCell()
        })
      }
      return
    }

    const head = subview.posAtCoords(point, false)
    subview.dispatch({ selection: { anchor: anchorPosition, head } })
  }

  const onMove = (event: MouseEvent): void => {
    if ((event.buttons & 1) === 0 || !table.isConnected) {
      // The button was released outside the window
      finish()
      return
    }

    point = { x: event.clientX, y: event.clientY }
    if (!dragging) {
      if (Math.hypot(point.x - startEvent.clientX, point.y - startEvent.clientY) < DRAG_THRESHOLD) {
        return
      }
      dragging = true
    }

    updateSelection()
    updateScrollSpeed()
  }

  // Scrolls the container while the mouse is near or beyond its edge. While
  // the drag stays in the starting cell and that cell's editor handles it
  // natively, the cell's editor already scrolls on its own.
  const updateScrollSpeed = (): void => {
    let sx = 0
    let sy = 0
    if (inCellRange || !nativeSelection || leftStartingCell) {
      const xRect = scrollers.x?.getBoundingClientRect() ?? { left: 0, right: window.innerWidth }
      const yRect = scrollers.y?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight }
      sx = dragScrollAmount(point.x, xRect.left, xRect.right)
      sy = dragScrollAmount(point.y, yRect.top, yRect.bottom)
    }

    scrollSpeed = { x: sx, y: sy }
    if (sx !== 0 || sy !== 0) {
      if (scrollTimer === undefined) {
        scrollTimer = setInterval(scrollStep, DRAG_SCROLL_INTERVAL)
      }
    } else {
      stopScrolling()
    }
  }

  const scrollStep = (): void => {
    if (!table.isConnected) {
      finish()
      return
    }

    let { x, y } = scrollSpeed
    if (x !== 0 && scrollers.x !== null) {
      scrollers.x.scrollLeft += x
      x = 0
    }
    if (y !== 0 && scrollers.y !== null) {
      scrollers.y.scrollTop += y
      y = 0
    }
    if (x !== 0 || y !== 0) {
      window.scrollBy(x, y)
    }

    // The content has moved under the (unmoved) mouse
    updateSelection()
  }

  const stopScrolling = (): void => {
    if (scrollTimer !== undefined) {
      clearInterval(scrollTimer)
      scrollTimer = undefined
    }
  }

  const updateSelection = (): void => {
    const head = cellCoordinatesAt(table, point.x, point.y)
    if (head === undefined) {
      return
    }

    if (head.row !== anchor.row || head.col !== anchor.col) {
      leftStartingCell = true
      const current = view.state.field(cellRangeSelectionField, false)
      if (!inCellRange || current?.head.row !== head.row || current?.head.col !== head.col) {
        view.dispatch({ effects: setCellRangeSelection.of({ tableFrom, anchor, head }) })
      }

      if (!inCellRange) {
        inCellRange = true
        // The starting cell's editor is gone now. The main view takes the
        // keyboard focus, so that the range can be copied.
        view.focus()
      }
      return
    }

    if (inCellRange) {
      inCellRange = false
      view.dispatch({ effects: setCellRangeSelection.of(null) })
    }

    if (!nativeSelection || leftStartingCell) {
      waitFramesLeft = MOUNT_WAIT_FRAMES
      selectTextInStartingCell()
    }
  }

  const finish = (): void => {
    stopScrolling()
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', finish)
    if (endActiveDrag === finish) {
      endActiveDrag = undefined
    }
  }

  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', finish)
  endActiveDrag = finish
}
