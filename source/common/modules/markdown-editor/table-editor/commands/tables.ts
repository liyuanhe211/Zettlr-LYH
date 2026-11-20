/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Table commands (tables)
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

import type { EditorView } from '@codemirror/view'
import { findColumnIndexByRange, getDelimiterLineCellOffsets, mapSelectionsWithTables } from './util'
import { splitBlockquotePrefix } from '../util/table-nodes'
import { EditorSelection, type ChangeSpec, type EditorState, type TransactionSpec } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'

/**
 * Utility function that will return a CodeMirror command based on the `which`
 * argument that then applies the provided alignment to the corresponding table
 * column in which the selection resides.
 *
 * @param   {'left'|'right'|'center'}  alignTo  Which alignment this should apply
 *
 * @return  {(EditorView): boolean}             A CodeMirror compatible command function
 */
export function setAlignment (alignTo?: 'left'|'right'|'center'): (target: EditorView) => boolean {
  return (target) => {
    const changes = mapSelectionsWithTables<ChangeSpec>(target, ctx => {
      const delimNodes = ctx.tableNode.getChildren('TableDelimiter')
      let node: SyntaxNode|undefined = delimNodes[0]
      if (delimNodes.length > 1) {
        node = delimNodes.find(node => target.state.sliceDoc(node.from, node.to).includes('='))
      }

      if (node === undefined) {
        return undefined
      }

      const delimLine = target.state.sliceDoc(node.from, node.to)

      // TODO: Iterate over all ranges (but only once per row)
      const idx = findColumnIndexByRange(ctx.ranges[0], ctx.offsets.outer)

      if (idx === undefined) {
        return undefined
      }

      const delimChar = ctx.tableAST.tableType === 'grid' ? '+' : delimLine.includes('|') ? '|' : '+'
      const fillChar = ctx.tableAST.tableType === 'grid' ? '=' : '-'
      const delimOffsets = getDelimiterLineCellOffsets(delimLine, delimChar)
      const [ from, to ] = delimOffsets[idx]
      // ensure that each delimiter contains at least 3 characters
      switch (alignTo) {
        case 'left':
          return { from: node.from + from, to: node.from + to, insert: ':' + fillChar.repeat(Math.max(to - from - 1, 2)) }
        case 'right':
          return { from: node.from + from, to: node.from + to, insert: fillChar.repeat(Math.max(to - from - 1, 2)) + ':' }
        case 'center':
          return { from: node.from + from, to: node.from + to, insert: ':' + fillChar.repeat(Math.max(to - from - 2, 1)) + ':' }
        default:
          return { from: node.from + from, to: node.from + to, insert: fillChar.repeat(Math.max(to - from, 3)) }
      }
    })

    if (changes.length > 0) {
      target.dispatch({ changes })
      return true
    } else {
      return false
    }
  }
}

/**
 * Clears all tables with selections inside them.
 *
 * @param   {EditorView}  target  The target EditorView
 *
 * @return  {boolean}             Whether the command has applied any changes.
 */
export function clearTable (target: EditorView): boolean {
  const changes = mapSelectionsWithTables<ChangeSpec[]>(target, ctx => {
    // Map over the offset rows, and then simply yield changes that replace each
    // table cell with whitespace, flattening the array
    return ctx.offsets.outer.flatMap(row => row.map(([ from, to ]) => ({ from, to, insert: ' '.repeat(to - from) })))
  }).flat() // Flatten the corresponding array

  if (changes.length > 0) {
    target.dispatch({ changes })
    return true
  } else {
    return false
  }
}

/**
 * Deletes all tables with selections inside them.
 *
 * @param   {EditorView}  target  The target EditorView
 *
 * @return  {boolean}             Whether the command has applied any changes.
 */
export function deleteTable (target: EditorView): boolean {
  const changes = mapSelectionsWithTables<ChangeSpec>(target, ({ tableAST }) => {
    const { from, to } = tableAST
    return { from, to, insert: '', selection: EditorSelection.cursor(from) }
  })

  if (changes.length > 0) {
    target.dispatch({ changes })
    target.focus()
    return true
  } else {
    return false
  }
}

/**
 * Builds the transaction that removes a whole table from the document, used
 * when a selected range of cells covers the entire table. The table's lines go
 * away together with a line break, so that the surrounding text is not joined.
 * If the table was separated from the text before and after it by blank lines
 * (or sat at the very start of the document), one of these blank lines goes as
 * well, which keeps a single blank line between the remaining paragraphs. For a
 * table at the very end of the document, the line break before it is removed.
 * The cursor ends up where the table started.
 *
 * @param   {EditorState}      state  The editor state
 * @param   {number}           from   The start of the table
 * @param   {number}           to     The end of the table (a grid table's end
 *                                    includes the line break after its last line)
 *
 * @return  {TransactionSpec}         The transaction
 */
export function buildTableDeletion (state: EditorState, from: number, to: number): TransactionSpec {
  const doc = state.doc
  const firstLine = doc.lineAt(from)
  const lastLine = doc.lineAt(Math.max(from, to - 1))
  const hasLineBefore = firstLine.number > 1
  const hasLineAfter = lastLine.number < doc.lines
  let deleteFrom = firstLine.from
  let deleteTo = lastLine.to

  if (hasLineAfter) {
    // Take the table's line break along
    deleteTo = lastLine.to + 1
    const lineAfter = doc.line(lastLine.number + 1)
    const isSeparatedBefore = !hasLineBefore || doc.line(firstLine.number - 1).text.trim() === ''
    if (isSeparatedBefore && lineAfter.text.trim() === '') {
      // Two blank lines would meet: Take one of them along
      deleteTo = Math.min(lineAfter.to + 1, doc.length)
    }
  } else if (hasLineBefore) {
    // The last line has no line break after it: Take the one before it
    deleteFrom = firstLine.from - 1
  }

  return {
    changes: { from: deleteFrom, to: deleteTo, insert: '' },
    selection: EditorSelection.cursor(deleteFrom)
  }
}

// Utility/Helper function that adds appropriate spacing
export function alignTables (target: EditorView, pos?: number): boolean {
  const tr = mapSelectionsWithTables<TransactionSpec>(target, ctx => {
    if (pos !== undefined && (pos < ctx.tableAST.from || pos > ctx.tableAST.to)) {
      return
    }

    const cellContents = ctx.tableAST.rows.map(row => {
      return row.cells.map(cell => target.state.sliceDoc(cell.from, cell.to).trim())
    })

    const cellSizes = cellContents.map(row => {
      return row.map(cell => cell.length)
    })

    // Zettlr-LYH: The delimiter row determines the number of columns. A row
    // with fewer cells receives empty cells at its end.
    const columnCount = ctx.tableAST.alignment.length
    const targetColumnSizes = []
    for (let i = 0; i < columnCount; i++) {
      targetColumnSizes.push(Math.max(...cellSizes.map(row => row[i] ?? 0)) + 2)
    }

    const newContents: string[][] = []
    for (let i = 0; i < cellContents.length; i++) {
      newContents.push([])
      for (let j = 0; j < columnCount; j++) {
        const cell = cellContents[i][j] ?? ''
        const pad = targetColumnSizes[j] - cell.length
        switch (ctx.tableAST.alignment[j]) {
          case 'right':
            newContents[i].push(cell.padStart(targetColumnSizes[j] - 1, ' ') + ' ')
            break
          case 'center':
            newContents[i].push(' '.repeat(Math.floor(pad/2)) + cell + ' '.repeat(Math.ceil(pad/2)))
            break
          case 'left':
          default:
            newContents[i].push(' ' + cell.padEnd(targetColumnSizes[j] - 1, ' '))
            break
        }
      }
    }

    const delimRow: string[] = []
    for (let i = 0; i < ctx.tableAST.alignment.length; i++) {
      const size = targetColumnSizes[i]
      // ensure that each delimiter contains at least 3 characters
      switch (ctx.tableAST.alignment[i]) {
        case 'left':
          delimRow.push(':' + '-'.repeat(Math.max(size - 1, 2)))
          break
        case 'right':
          delimRow.push('-'.repeat(Math.max(size - 1, 2)) + ':')
          break
        case 'center':
          delimRow.push(':' + '-'.repeat(Math.max(size - 2, 1)) + ':')
          break
        default:
          delimRow.push('-'.repeat(Math.max(size, 3)))
      }
    }

    const newRows = newContents.map(row => '|' + row.join('|') + '|')
    newRows.splice(1, 0, '|' + delimRow.join('|') + '|')

    console.log({ cellContents, newRows, newContents, cellSizes, targetColumnSizes })

    // Zettlr-LYH: Every line of a table inside a blockquote begins with the
    // blockquote markers. The first line keeps its own (the table starts
    // behind them), and the other lines receive the same markers.
    const [ prefix ] = splitBlockquotePrefix(target.state.doc.lineAt(ctx.tableAST.from).text)

    return {
      changes: {
        from: ctx.tableAST.from, to: ctx.tableAST.to,
        insert: newRows.join('\n' + prefix)
      }
    }
  })

  if (tr.length > 0) {
    target.dispatch(...tr)
    return true
  } else {
    return false
  }
}
