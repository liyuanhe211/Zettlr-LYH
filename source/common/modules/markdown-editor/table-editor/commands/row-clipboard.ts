/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Table commands (row clipboard)
 * CVM-Role:        Utility Functions
 * License:         GNU GPL v3
 *
 * Description:     This file contains commands that copy an entire table row
 *                  to the system clipboard (as tab-separated plain text plus
 *                  an HTML table row) and paste tab-separated clipboard text
 *                  cell by cell into a table, starting at the cursor's cell.
 *
 * END HEADER
 */

import type { EditorView } from '@codemirror/view'
import { findColumnIndexByRange, findRowIndexByRange, mapSelectionsWithTables } from './util'

/**
 * Splits clipboard plain text into a matrix of cells. Lines are separated by
 * `\r\n`, `\r`, or `\n`, cells by tabs. Trailing lines that are empty (or only
 * contain whitespace) are removed, since Word and Excel usually append a line
 * break to copied rows. Every cell is trimmed of leading and trailing
 * whitespace.
 *
 * @param   {string}      text  The clipboard plain text
 *
 * @return  {string[][]}        The cells, indexed by row and cell. Empty if
 *                              the text is empty or only whitespace.
 */
export function splitClipboardTableText (text: string): string[][] {
  if (text.trim() === '') {
    return []
  }

  const lines = text.split(/\r\n|\r|\n/)
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop()
  }

  return lines.map(line => line.split('\t').map(cell => cell.trim()))
}

/**
 * Escapes all unescaped pipe characters, since a bare `|` would break the
 * structure of both pipe and grid tables. Already escaped pipes (`\|`) are
 * left untouched.
 *
 * @param   {string}  text  The cell content
 *
 * @return  {string}        The escaped cell content
 */
export function escapeCellContentForTable (text: string): string {
  return text.replace(/(?<!\\)\|/g, '\\|')
}

/**
 * Computes the changes required to paste a matrix of cells into a table. The
 * clipboard cell at (i, j) is written into the table cell at
 * (startRow + i, startCol + j). Clipboard cells whose target lies outside the
 * table (row or column out of range) are discarded; no rows or columns are
 * created. Each target cell's outer range is replaced with the escaped content,
 * padded by a single space on either side.
 *
 * @param   {[number, number][][]}  outerOffsets  The outer cell offsets of the
 *                                                table, `[rows][cells][from, to]`
 * @param   {number}                startRow      The row index to start at
 * @param   {number}                startCol      The column index to start at
 * @param   {string[][]}            cells         The clipboard cells
 *
 * @return  {Array<{ from: number, to: number, insert: string }>}  The changes,
 *                                                in document order
 */
export function computeRowPasteChanges (
  outerOffsets: [number, number][][],
  startRow: number,
  startCol: number,
  cells: string[][]
): Array<{ from: number, to: number, insert: string }> {
  const changes: Array<{ from: number, to: number, insert: string }> = []

  for (let i = 0; i < cells.length; i++) {
    const rowIndex = startRow + i
    if (rowIndex < 0 || rowIndex >= outerOffsets.length) {
      continue
    }

    const rowOffsets = outerOffsets[rowIndex]
    for (let j = 0; j < cells[i].length; j++) {
      const columnIndex = startCol + j
      if (columnIndex < 0 || columnIndex >= rowOffsets.length) {
        continue
      }

      const [ from, to ] = rowOffsets[columnIndex]
      changes.push({ from, to, insert: ' ' + escapeCellContentForTable(cells[i][j]) + ' ' })
    }
  }

  return changes
}

/**
 * Escapes the HTML special characters in a piece of text.
 *
 * @param   {string}  text  The text
 *
 * @return  {string}        The escaped text
 */
function escapeHTML (text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Builds an HTML table containing a single row with the provided cell texts.
 *
 * @param   {string[]}  cellTexts  The cell texts
 *
 * @return  {string}               The HTML string
 */
export function buildRowClipboardHTML (cellTexts: string[]): string {
  const cellsHTML = cellTexts.map(text => `<td>${escapeHTML(text)}</td>`).join('')
  return `<table><tbody><tr>${cellsHTML}</tr></tbody></table>`
}

/**
 * Copies the table row which contains the (first) cursor to the clipboard, as
 * tab-separated plain text and as an HTML table row.
 *
 * @param   {EditorView}  target  The target EditorView
 *
 * @return  {boolean}             Whether a row was found and copied
 */
export function copyTableRow (target: EditorView): boolean {
  const rowContents = mapSelectionsWithTables<string[]>(target, ctx => {
    const focusRange = ctx.ranges[0]
    const rowIndex = findRowIndexByRange(focusRange, ctx.offsets.outer, 'head')
    if (rowIndex === undefined) {
      return undefined
    }

    return ctx.offsets.inner[rowIndex].map(([ from, to ]) => target.state.sliceDoc(from, to).trim())
  })

  if (rowContents.length === 0) {
    return false
  }

  const cellTexts = rowContents[0]
  const plainText = cellTexts.join('\t')
  const html = buildRowClipboardHTML(cellTexts)

  navigator.clipboard.write([
    new ClipboardItem({
      'text/plain': new Blob([plainText], { type: 'text/plain' }),
      'text/html': new Blob([html], { type: 'text/html' })
    })
  ]).catch(err => console.error(err))

  return true
}

/**
 * Pastes tab-separated clipboard text into the table, cell by cell, starting
 * at the cell which contains the (first) cursor. Cells that would fall outside
 * the table are discarded.
 *
 * @param   {EditorView}  target  The target EditorView
 */
export function pasteTableRow (target: EditorView): void {
  navigator.clipboard.readText()
    .then(text => {
      const cells = splitClipboardTableText(text)
      if (cells.length === 0) {
        return
      }

      // NOTE: The offsets are computed only after the clipboard has been read,
      // so that they reflect the current document state.
      const changes = mapSelectionsWithTables(target, ctx => {
        const focusRange = ctx.ranges[0]
        const rowIndex = findRowIndexByRange(focusRange, ctx.offsets.outer, 'head')
        const columnIndex = findColumnIndexByRange(focusRange, ctx.offsets.outer, 'head')
        if (rowIndex === undefined || columnIndex === undefined) {
          return undefined
        }

        return computeRowPasteChanges(ctx.offsets.outer, rowIndex, columnIndex, cells)
      }).flat()

      if (changes.length > 0) {
        target.dispatch({ changes })
      }
    })
    .catch(err => console.error(err))
}
