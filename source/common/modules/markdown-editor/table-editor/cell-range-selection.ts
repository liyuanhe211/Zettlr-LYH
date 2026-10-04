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
 *
 * END HEADER
 */

import { syntaxTree } from '@codemirror/language'
import { type EditorState, Prec, StateEffect, StateField } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { parseTableNode } from '../../markdown-utils/markdown-ast/parse-table-node'
import { buildTableClipboardHTML } from './commands/row-clipboard'

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

  const tableNode = syntaxTree(view.state).topNode.getChildren('Table')
    .find(node => node.from <= range.tableFrom && node.to >= range.tableFrom)
  if (tableNode === undefined) {
    return false
  }

  const tableAST = parseTableNode(tableNode, view.state.sliceDoc())
  if (tableAST.type !== 'Table') {
    return false
  }

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
 * the clipboard. Any other key (apart from lone modifiers) only ends the cell
 * selection, so that no keystroke can edit the table's source behind the
 * rendered table; the cursor then returns into the cell where the drag
 * started.
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
