/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Table cell line breaks and arrow key navigation
 * CVM-Role:        Utility Functions
 * License:         GNU GPL v3
 *
 * Description:     While a table cell is being edited, Enter inserts a line
 *                  break (`<br>`) into the cell instead of leaving it, and the
 *                  arrow keys move the cursor within the cell. Only when the
 *                  cursor cannot move any further in the given direction (the
 *                  first or last character for Left and Right, the first or
 *                  last visual line for Up and Down) do the arrow keys move on
 *                  to the neighboring cell, or out of the table if there is no
 *                  neighboring cell in that direction.
 *
 * END HEADER
 */

import { syntaxTree } from '@codemirror/language'
import { EditorSelection, type ChangeSpec, type EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { parseTableNode } from 'source/common/modules/markdown-utils/markdown-ast/parse-table-node'
import { findColumnIndexByRange, findRowIndexByRange, getTableCellOffsets } from './commands/util'
import { sourceOffsetForCellClick } from './cell-caret'

/**
 * The line break that Enter inserts into a table cell.
 */
export const CELL_LINE_BREAK = '<br>'

/**
 * Line breaks inside a cell's Markdown source: `<br>`, `<br/>`, `<br />`, in
 * any letter case.
 */
const SOURCE_LINE_BREAK = /<br\s*\/?>/gi

/**
 * The directions in which the arrow keys move.
 */
export type CellDirection = 'left'|'right'|'up'|'down'

/**
 * Where an arrow key leads when the cursor leaves the current cell: Either
 * into a neighboring cell (given by its content range), or to a position
 * outside of the table. If there is no line next to the table in that
 * direction, `insert` creates one, and `position` refers to the document after
 * that change.
 */
export type CellNavigationTarget = {
  type: 'cell'
  from: number
  to: number
} | {
  type: 'outside'
  position: number
  insert?: ChangeSpec
}

/**
 * Returns the positions right after every line break (`<br>`) within the
 * given text.
 *
 * @param   {string}    text    The text, e.g., the source of a table cell
 * @param   {number}    offset  The document position of the text's start
 *
 * @return  {number[]}          The document positions after the line breaks
 */
export function lineBreakEndPositions (text: string, offset: number): number[] {
  return [...text.matchAll(SOURCE_LINE_BREAK)].map(match => offset + (match.index ?? 0) + match[0].length)
}

/**
 * Determines where an arrow key leads that leaves the table cell containing
 * the given position: The next cell in that direction (Left and Right wrap
 * around to the previous or next row, Up and Down keep the column), or the
 * line before or after the table if there is no such cell.
 *
 * @param   {EditorState}                    state         The editor state
 * @param   {number}                         cellPosition  A position within
 *                                                         the current cell
 * @param   {CellDirection}                  direction     The direction
 *
 * @return  {CellNavigationTarget|undefined}               The target, or
 *                                                         undefined if the
 *                                                         position is not
 *                                                         inside a table cell
 */
export function neighborCellTarget (state: EditorState, cellPosition: number, direction: CellDirection): CellNavigationTarget|undefined {
  const tableNode = syntaxTree(state).topNode.getChildren('Table')
    .find(node => node.from <= cellPosition && node.to >= cellPosition)
  if (tableNode === undefined) {
    return undefined
  }

  const tableAST = parseTableNode(tableNode, state.sliceDoc())
  if (tableAST.type !== 'Table') {
    return undefined
  }

  const offsets = getTableCellOffsets(tableAST)
  const cursor = EditorSelection.cursor(cellPosition)
  const row = findRowIndexByRange(cursor, offsets.outer)
  const column = findColumnIndexByRange(cursor, offsets.outer)
  if (row === undefined || column === undefined) {
    return undefined
  }

  const lastRow = offsets.inner.length - 1
  const lastColumnOf = (rowIndex: number): number => offsets.inner[rowIndex].length - 1
  const cellAt = (rowIndex: number, columnIndex: number): CellNavigationTarget => {
    const [ from, to ] = offsets.inner[rowIndex][Math.min(columnIndex, lastColumnOf(rowIndex))]
    return { type: 'cell', from, to }
  }

  switch (direction) {
    case 'left':
      if (column > 0) {
        return cellAt(row, column - 1)
      }
      return row > 0 ? cellAt(row - 1, lastColumnOf(row - 1)) : positionBeforeTable(state, tableNode.from)
    case 'right':
      if (column < lastColumnOf(row)) {
        return cellAt(row, column + 1)
      }
      return row < lastRow ? cellAt(row + 1, 0) : positionAfterTable(state, tableNode.from, tableNode.to)
    case 'up':
      return row > 0 ? cellAt(row - 1, column) : positionBeforeTable(state, tableNode.from)
    case 'down':
      return row < lastRow ? cellAt(row + 1, column) : positionAfterTable(state, tableNode.from, tableNode.to)
  }
}

/**
 * Returns the end of the line before the table, creating an empty line if the
 * table starts the document.
 */
function positionBeforeTable (state: EditorState, tableFrom: number): CellNavigationTarget {
  const firstLine = state.doc.lineAt(tableFrom)
  if (firstLine.number > 1) {
    return { type: 'outside', position: state.doc.line(firstLine.number - 1).to }
  }
  return { type: 'outside', position: firstLine.from, insert: { from: firstLine.from, insert: '\n' } }
}

/**
 * Returns the start of the line after the table, creating an empty line if the
 * table ends the document.
 */
function positionAfterTable (state: EditorState, tableFrom: number, tableTo: number): CellNavigationTarget {
  // NOTE: Should the table node include the final line break, its end lies on
  // the line after the table.
  const lastLine = state.doc.lineAt(Math.max(tableFrom, tableTo - 1))
  if (lastLine.number < state.doc.lines) {
    return { type: 'outside', position: state.doc.line(lastLine.number + 1).from }
  }
  return { type: 'outside', position: lastLine.to + 1, insert: { from: lastLine.to, insert: '\n' } }
}

/**
 * Inserts a line break (`<br>`) into the table cell at the cursor, replacing
 * the selection.
 *
 * @param   {EditorView}  subview  The subview of the edited cell
 *
 * @return  {boolean}              Always true
 */
export function insertCellLineBreak (subview: EditorView): boolean {
  subview.dispatch({
    ...subview.state.replaceSelection(CELL_LINE_BREAK),
    scrollIntoView: true,
    userEvent: 'input'
  })
  return true
}

/**
 * Determines whether the cursor in the cell's subview cannot move any further
 * in the given direction without leaving the cell. Only applies to a single,
 * empty selection; otherwise, the arrow keys keep their default behavior.
 *
 * @param   {EditorView}        subview    The subview of the edited cell
 * @param   {[number, number]}  cellRange  The cell's range in the document
 * @param   {CellDirection}     direction  The direction
 *
 * @return  {boolean}                      Whether the cursor is at the cell's
 *                                         boundary in that direction
 */
function isAtCellBoundary (subview: EditorView, cellRange: [number, number], direction: CellDirection): boolean {
  const { ranges, main } = subview.state.selection
  if (ranges.length > 1 || !main.empty) {
    return false
  }

  const [ cellFrom, cellTo ] = cellRange
  if (direction === 'left') {
    return main.head <= cellFrom
  } else if (direction === 'right') {
    return main.head >= cellTo
  }

  // Up and Down: The cursor is on the first or last visual line of the cell if
  // moving vertically does not end up on a different line within the cell.
  const target = subview.moveVertically(main, direction === 'down')
  if (target.head < cellFrom || target.head > cellTo || target.head === main.head) {
    return true
  }

  const currentCoordinates = subview.coordsAtPos(main.head)
  const targetCoordinates = subview.coordsAtPos(target.head)
  if (currentCoordinates === null || targetCoordinates === null) {
    return false
  }
  return Math.abs(targetCoordinates.top - currentCoordinates.top) < 2
}

/**
 * Returns the source offset within the target cell that lies closest to the
 * given horizontal client coordinate, on the target cell's first line (when
 * moving down) or last line (when moving up). Falls back to the start or end
 * of the cell if the rendered cell cannot be found.
 */
function verticalEntryOffset (mainView: EditorView, target: { from: number, to: number }, direction: 'up'|'down', x: number|undefined): number {
  const fallback = direction === 'down' ? 0 : target.to - target.from
  if (x === undefined) {
    return fallback
  }

  const selector = `.cm-table-editor-widget td[data-cell-from="${target.from}"], .cm-table-editor-widget th[data-cell-from="${target.from}"]`
  const contentWrapper = mainView.dom.querySelector(selector)?.querySelector<HTMLElement>('div.content')
  if (contentWrapper === null || contentWrapper === undefined || contentWrapper.classList.contains('editing')) {
    return fallback
  }

  const { top, bottom } = contentWrapper.getBoundingClientRect()
  const y = direction === 'down' ? top + 2 : bottom - 2
  const source = mainView.state.sliceDoc(target.from, target.to)
  return sourceOffsetForCellClick(contentWrapper, source, x, y)
}

/**
 * The arrow key command for table cells: Moves on to the neighboring cell (or
 * out of the table) if the cursor is at the cell's boundary in the given
 * direction. Returns false otherwise, so that the default command moves the
 * cursor within the cell.
 *
 * @param   {EditorView}        mainView   The main editor view
 * @param   {EditorView}        subview    The subview of the edited cell
 * @param   {[number, number]}  cellRange  The cell's range in the document
 * @param   {CellDirection}     direction  The direction
 *
 * @return  {boolean}                      Whether the cursor left the cell
 */
export function moveAcrossCellBoundary (mainView: EditorView, subview: EditorView, cellRange: [number, number], direction: CellDirection): boolean {
  if (!isAtCellBoundary(subview, cellRange, direction)) {
    return false
  }

  const target = neighborCellTarget(mainView.state, cellRange[0], direction)
  if (target === undefined) {
    return false
  }

  if (target.type === 'outside') {
    mainView.dispatch({
      changes: target.insert,
      selection: { anchor: target.position },
      scrollIntoView: true,
      userEvent: 'select'
    })
    mainView.focus()
    return true
  }

  let offset: number
  if (direction === 'left') {
    offset = target.to - target.from
  } else if (direction === 'right') {
    offset = 0
  } else {
    const x = subview.coordsAtPos(subview.state.selection.main.head)?.left
    offset = verticalEntryOffset(mainView, target, direction, x)
  }

  mainView.dispatch({ selection: { anchor: Math.min(target.from + offset, target.to) } })
  return true
}
