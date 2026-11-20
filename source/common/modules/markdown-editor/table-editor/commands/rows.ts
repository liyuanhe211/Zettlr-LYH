/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Table commands (rows)
 * CVM-Role:        Utility Functions
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file exposes a series of CodeMirror commands that make
 *                  working with tables easier and allow for keyboard-based
 *                  manipulation of them.
 *
 * END HEADER
 */

import { type SelectionRange, EditorSelection, type ChangeSpec, type EditorState, type Line, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import type { Table } from 'source/common/modules/markdown-utils/markdown-ast'
import { findColumnIndexByRange, findRowIndexByRange, getRowIndicesByRanges, isGridTableDelimRow, isPipeTableDelimRow, mapSelectionsWithTables } from './util'
import { emptyRowFromLine } from '../util/table-nodes'

/**
 * This command takes all editor selections and moves those within tables to the
 * next row, same cell offset.
 *
 * @param   {EditorView}  target  The EditorView
 *
 * @return  {boolean}             Whether any movement has happened
 */
export function moveNextRow (target: EditorView): boolean {
  const newSelections: SelectionRange[] = mapSelectionsWithTables(target, ctx => {
    // Now with the offsets at hand, it's relatively easy: We only need to find
    // the cell in which the cursor is in, then see if there is a next one, and
    // return a cursor that points to the start of the next cell.
    return ctx.ranges.map(range => {
      const rowIndex = findRowIndexByRange(range, ctx.offsets.outer, 'anchor')
      const cellIndex = findColumnIndexByRange(range, ctx.offsets.outer, 'anchor')

      if (rowIndex === undefined || cellIndex === undefined) {
        return undefined
      }

      if (rowIndex === ctx.offsets.outer.length - 1) {
        return undefined
      }
  
      // NOTE that we move by the inner offsets here
      return EditorSelection.cursor(ctx.offsets.inner[rowIndex + 1][cellIndex][0])
    }).filter(i => i !== undefined)
  }).flat()

  if (newSelections.length > 0) {
    target.dispatch({ selection: EditorSelection.create(newSelections) })
    return true
  } else {
    return false
  }
}

/**
 * This command takes all editor selections and moves those within tables to the
 * previous row, same cell offset.
 *
 * @param   {EditorView}  target  The EditorView
 *
 * @return  {boolean}             Whether any movement has happened
 */
export function movePrevRow (target: EditorView): boolean {
  const newSelections: SelectionRange[] = mapSelectionsWithTables(target, ctx => {
    // Now with the offsets at hand, it's relatively easy: We only need to find
    // the cell in which the cursor is in, then see if there is a next one, and
    // return a cursor that points to the start of the next cell.
    return ctx.ranges.map(range => {
      const rowIndex = findRowIndexByRange(range, ctx.offsets.outer, 'anchor')
      const cellIndex = findColumnIndexByRange(range, ctx.offsets.outer, 'anchor')

      if (rowIndex === undefined || cellIndex === undefined || rowIndex === 0) {
        return undefined
      }
  
      // NOTE that we move by the inner offsets
      return EditorSelection.cursor(ctx.offsets.inner[rowIndex - 1][cellIndex][0])
    }).filter(i => i !== undefined)
  }).flat()

  if (newSelections.length > 0) {
    target.dispatch({ selection: EditorSelection.create(newSelections) })
    return true
  } else {
    return false
  }
}

/**
 * For any selection ranges within a table, this function swaps the anchor's row
 * with the next one if applicable, accounting for table type and header rows.
 *
 * @param   {EditorView}  target  The target view
 *
 * @return  {boolean}             Whether any swaps have happened.
 */
export function swapNextRow (target: EditorView): boolean {
  const tr = mapSelectionsWithTables<TransactionSpec>(target, ctx => {
    // TODO: What if selection spans multiple rows? The user then clearly
    // intends to move them all together
    // NOTE: Swapping is complex; here we only consider the first range
    const focusRange = ctx.ranges[0]
    const thisLine = target.state.doc.lineAt(focusRange.head)
    const lastLine = target.state.doc.lineAt(ctx.tableNode.to)
    if (thisLine.number === target.state.doc.lines || thisLine.number === lastLine.number) {
      return undefined
    }

    if (ctx.tableAST.tableType === 'grid') {
      // Handle a grid table
      let nextLine = target.state.doc.line(thisLine.number + 2)
      if (nextLine.number > lastLine.number || nextLine.number >= target.state.doc.lines) {
        return undefined
      }

      return {
        selection: { anchor: focusRange.anchor, head: focusRange.head },
        changes: [
          { from: thisLine.from, to: thisLine.to, insert: nextLine.text },
          { from: nextLine.from, to: nextLine.to, insert: thisLine.text }
        ]
      }
    } else {
      // Handle a pipe table
      let nextLine = target.state.doc.line(thisLine.number + 1)
      let selectionOffset = thisLine.text.length + 1 // Account for the \n
      if (isPipeTableDelimRow(nextLine.text)) {
        // We have to modify nextLine and the selectionOffset to "jump over" the
        // header row
        nextLine = target.state.doc.line(nextLine.number + 1)
        selectionOffset += nextLine.text.length + 1 // Account for the 2nd \n
      }
      const diff = nextLine.text.length - thisLine.text.length
      selectionOffset += diff
      return {
        selection: {
          anchor: focusRange.anchor + selectionOffset,
          head: focusRange.head  + selectionOffset
        },
        changes: [
          { from: thisLine.from, to: thisLine.to, insert: nextLine.text },
          { from: nextLine.from, to: nextLine.to, insert: thisLine.text }
        ]
      }
    }
  }).flat() // NOTE: We're receiving 2d arrays from the callback

  if (tr.length > 0) {
    target.dispatch(...tr)
    return true
  } else {
    return false
  }
}

/**
 * Swaps table rows to the top.
 *
 * @param   {EditorView}  target  The target view
 *
 * @return  {boolean}             Whether any swaps occurred
 */
export function swapPrevRow (target: EditorView): boolean {
  const tr = mapSelectionsWithTables<TransactionSpec>(target, ctx => {
    // TODO: What if selection spans multiple rows? The user then clearly
    // intends to move them all together
    // NOTE: Swapping is complex; here we only consider the first range
    const focusRange = ctx.ranges[0]
    const thisLine = target.state.doc.lineAt(focusRange.head)
    const firstLine = target.state.doc.lineAt(ctx.tableNode.from)
    if (thisLine.number === 1 || thisLine.number === firstLine.number) {
      return undefined
    }

    if (ctx.tableAST.tableType === 'grid') {
      // Handle a grid table
      let prevLine = target.state.doc.line(thisLine.number - 2)
      if (prevLine.number < firstLine.number || prevLine.number < 1) {
        return undefined
      }
      return {
        selection: { anchor: focusRange.anchor, head: focusRange.head },
        changes: [
          { from: thisLine.from, to: thisLine.to, insert: prevLine.text },
          { from: prevLine.from, to: prevLine.to, insert: thisLine.text }
        ]
      }
    } else {
      // Handle a pipe table
      let prevLine = target.state.doc.line(thisLine.number - 1)
      let selectionOffset = thisLine.text.length + 1 // Account for \n
      if (isPipeTableDelimRow(prevLine.text)) {
        // We have to swap the lines to retain the header row
        selectionOffset += prevLine.text.length + 1 // Account for \n
        prevLine = target.state.doc.line(prevLine.number - 1)
      }
      const diff = prevLine.text.length - thisLine.text.length
      selectionOffset += diff
      return {
        selection: {
          anchor: focusRange.anchor - selectionOffset,
          head: focusRange.head  - selectionOffset
        },
        changes: [
          { from: thisLine.from, to: thisLine.to, insert: prevLine.text },
          { from: prevLine.from, to: prevLine.to, insert: thisLine.text }
        ]
      }
    }
  }).flat() // NOTE: We're receiving 2d arrays from the callback

  if (tr.length > 0) {
    target.dispatch(...tr)
    return true
  } else {
    return false
  }
}

/**
 * Adds a row to a table after the one the cursor is in.
 *
 * @param   {EditorView}  target  The target EditorView
 *
 * @return  {boolean}             Whether the command has changed anything
 */
export function addRowAfter (target: EditorView): boolean {
  const tr = mapSelectionsWithTables<TransactionSpec>(target, ctx => {
    const focusRange = ctx.ranges[0]
    const thisLine = target.state.doc.lineAt(focusRange.head)
    if (ctx.tableAST.tableType === 'pipe') {
      // Did the user select the divider? The second check is necessary as the
      // regex also matches empty lines
      if (isPipeTableDelimRow(thisLine.text)) {
        return undefined
      }

      const lineCount = target.state.doc.lines
      let isHeader = false
      let nextLine = thisLine.number < lineCount ? target.state.doc.line(thisLine.number + 1) : undefined
      if (nextLine !== undefined && isPipeTableDelimRow(nextLine.text) && nextLine.number < lineCount) {
        // Next line is the header, so we have to add a line thereafter
        isHeader = true
      }

      // Zettlr-LYH: Keeps the blockquote markers of a table in a blockquote
      const newRow = emptyRowFromLine(thisLine.text)
      // The new row begins right after the inserted newline character
      const newRowStart = (isHeader && nextLine !== undefined ? nextLine.to : thisLine.to) + 1
      // Place the selection at the same column in the new row, clamped to its
      // length. The new row can be shorter than the current one (cell contents
      // are removed), so the same column may lie past its end.
      const anchorOffset = Math.max(0, Math.min(focusRange.anchor - thisLine.from, newRow.length))
      const headOffset = Math.max(0, Math.min(focusRange.head - thisLine.from, newRow.length))

      return {
        selection: {
          anchor: newRowStart + anchorOffset,
          head: newRowStart + headOffset
        },
        changes: {
          from: isHeader && nextLine !== undefined ? nextLine.to : thisLine.to,
          insert: '\n' + newRow
        }
      }
    } else {
      // Grid table
      // The user may have the cursor in a divider or a content row
      if (/^[\s+=:-]+$/.test(thisLine.text)) {
        return undefined
      }
      const nextLine = target.state.doc.line(thisLine.number + 1)
      return {
        from: nextLine.number === target.state.doc.lines ? nextLine.to : nextLine.to + 1,
        insert: thisLine.text.replace(/[^\s|+=]/g, '') + '\n' + nextLine.text + '\n'
      }
    }
  })

  // What we should do here (and in addRowBefore) is stupidly simple: Just take
  // the current row (grid tables = this + next one), remove every character between
  // the pipes and put it after the row. Maybe even works without the forEveryTable thing
  if (tr.length > 0) {
    target.dispatch(...tr)
    return true
  } else {
    return false
  }
}

/**
 * Adds a table row before the one with the cursor.
 *
 * @param   {EditorView}  target  The target EditorView
 *
 * @return  {boolean}             Whether the command has changed anything.
 */
export function addRowBefore (target: EditorView): boolean {
  const tr = mapSelectionsWithTables<TransactionSpec>(target, ctx => {
    // TODO: Iterate over all ranges (but only once per row)
    const focusRange = ctx.ranges[0]
    const nLines = target.state.doc.lines
    const firstLine = target.state.doc.lineAt(ctx.tableNode.from)
    let thisLine = target.state.doc.lineAt(focusRange.head)
    if (ctx.tableAST.tableType === 'pipe') {
      // Can only add rows in the table body
      if (thisLine.number === firstLine.number) {
        return undefined
      }

      // Did the user select the divider? If so, move thisLine one below so that
      // the following checks correctly add rows.
      if (isPipeTableDelimRow(thisLine.text) && thisLine.number < nLines) {
        thisLine = target.state.doc.line(thisLine.number + 1)
      } else if (isPipeTableDelimRow(thisLine.text)) {
        return undefined // Seems like a malformed table that ends with the delim
      }

      return {
        // Keep the cursor which will end up at the correct position
        selection: { anchor: focusRange.anchor, head: focusRange.head },
        changes: {
          from: thisLine.from,
          // Zettlr-LYH: Keeps the blockquote markers of a table in a blockquote
          insert: emptyRowFromLine(thisLine.text) + '\n'
        }
      }
    } else {
      // Grid table
      // The user may have the cursor in a divider or a content row
      if (isGridTableDelimRow(thisLine.text)) {
        return undefined
      }
      const nextLine = target.state.doc.line(thisLine.number + 1)
      return {
        changes: {
          from: thisLine.from,
          insert: thisLine.text.replace(/[^\s|+=]/g, '') + '\n' + nextLine.text + '\n'
        }
      }
    }
  })

  // What we should do here (and in addRowBefore) is stupidly simple: Just take
  // the current row (grid tables = this + next one), remove every character between
  // the pipes and put it after the row. Maybe even works without the forEveryTable thing
  if (tr.length > 0) {
    target.dispatch(...tr)
    return true
  } else {
    return false
  }
}

/**
 * Builds the change that removes a whole line including the line break after
 * it. The last line of the document has no line break after it, so only its
 * text is removed.
 *
 * @param   {EditorState}  state  The editor state
 * @param   {Line}         line   The line to remove
 *
 * @return  {ChangeSpec}          The change
 */
function wholeLineRemoval (state: EditorState, line: Line): ChangeSpec {
  return { from: line.from, to: Math.min(line.to + 1, state.doc.length), insert: '' }
}

/**
 * Builds the changes that delete entire rows from a table. The row indices
 * refer to `tableAST.rows`: The header row has index 0, and the delimiter row of
 * a pipe table does not count. The cursor command `deleteRow` and the deletion
 * of a selected range of cells share this function.
 *
 * If a pipe table's header row is deleted, the first remaining row becomes the
 * new header row, which means that the delimiter row moves below it. If every
 * row is deleted, the delimiter row is deleted as well. In a grid table, every
 * row is removed together with the delimiter line that follows it.
 *
 * @param   {EditorState}  state       The editor state
 * @param   {SyntaxNode}   tableNode   The table's syntax node
 * @param   {Table}        tableAST    The parsed table
 * @param   {number[]}     rowIndices  The indices of the rows to delete
 *
 * @return  {ChangeSpec[]}             The changes, relative to the current
 *                                     document (empty if there is nothing to do)
 */
export function buildRowDeletionChanges (
  state: EditorState,
  tableNode: SyntaxNode,
  tableAST: Table,
  rowIndices: number[]
): ChangeSpec[] {
  const doc = state.doc
  const indices = [...new Set(rowIndices)]
    .filter(index => index >= 0 && index < tableAST.rows.length)
    .sort((a, b) => a - b)
  if (indices.length === 0) {
    return []
  }

  const rowLines = tableAST.rows.map(row => doc.lineAt(row.from))
  const changes: ChangeSpec[] = []

  if (tableAST.tableType === 'pipe') {
    // The delimiter row is not part of the AST, but a direct child of the table
    const delimiterNode = tableNode.getChild('TableDelimiter')
    if (delimiterNode === null) {
      return []
    }
    const delimiterLine = doc.lineAt(delimiterNode.from)
    const deletedRows = new Set(indices)

    for (const index of indices) {
      changes.push(wholeLineRemoval(state, rowLines[index]))
    }

    if (deletedRows.has(0)) {
      // The header row is gone, so the delimiter row has to leave its place,
      // and, unless nothing remains, move below the new header row (the first
      // row that is not deleted).
      changes.push(wholeLineRemoval(state, delimiterLine))
      const newHeaderIndex = tableAST.rows.findIndex((_row, index) => !deletedRows.has(index))
      if (newHeaderIndex > -1) {
        changes.push({ from: rowLines[newHeaderIndex].to, insert: '\n' + delimiterLine.text })
      }
    }
  } else {
    // Grid table: A row is followed by a delimiter line, which goes with it
    for (const index of indices) {
      const line = rowLines[index]
      // The row may start in a delimiter line, or the table is cut off
      if (isGridTableDelimRow(line.text) || line.number >= doc.lines) {
        continue
      }
      const nextLine = doc.line(line.number + 1)
      changes.push({ from: line.from, to: Math.min(nextLine.to + 1, doc.length), insert: '' })
    }
  }

  return changes
}

/**
 * Deletes an entire row from a table.
 *
 * @param   {EditorView}  target  The target EditorView
 *
 * @return  {boolean}             Whether the command has changed anything.
 */
export function deleteRow (target: EditorView): boolean {
  // Deleting a row is really boring: Simply replace the current line with nothing
  const changes = mapSelectionsWithTables<ChangeSpec[]>(target, ctx => {
    const rowIndices = getRowIndicesByRanges(ctx.ranges, ctx.offsets.outer)
    return buildRowDeletionChanges(target.state, ctx.tableNode, ctx.tableAST, rowIndices)
  }).flat()

  if (changes.length > 0) {
    target.dispatch({ changes })
    return true
  } else {
    return false
  }
}

/**
 * Clears an entire table row out.
 *
 * @param   {EditorView}  target  The target EditorView
 *
 * @return  {boolean}             Whether the command has changed anything
 */
export function clearRow (target: EditorView): boolean {
  // Clearing a row is even simpler, by simply replacing a row cell's contents with whitespace
  const changes = mapSelectionsWithTables(target, ctx => {
    const rows = getRowIndicesByRanges(ctx.ranges, ctx.offsets.outer)

    return rows.flatMap(row => {
      return ctx.offsets.outer[row].map(([ from, to ]) => {
        return { from, to, insert: ' '.repeat(to - from) }
      })
    })
  }).flat()

  if (changes.length > 0) {
    target.dispatch({ changes })
    return true
  } else {
    return false
  }
}
