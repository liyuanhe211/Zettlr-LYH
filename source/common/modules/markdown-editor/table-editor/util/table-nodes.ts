/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Table node lookup and blockquote prefix helpers
 * CVM-Role:        Utility Functions
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH: The table editor renders and edits the tables
 *                  at the top level of a document and those inside
 *                  blockquotes (also nested ones). Every line of a table inside
 *                  a blockquote begins with the blockquote's markers (`> `),
 *                  which the commands that build lines from a table line have
 *                  to keep. This module collects the table nodes and handles
 *                  these markers.
 *
 * END HEADER
 */

import type { SyntaxNode, Tree } from '@lezer/common'
import type { EditorState } from '@codemirror/state'
import type { Table, TableCell } from '../../../markdown-utils/markdown-ast'
import { parseTableNode } from '../../../markdown-utils/markdown-ast/parse-table-node'

/**
 * Matches the blockquote markers at the start of a line, including nested
 * markers (`> > `) and the indentation of up to three spaces before each.
 */
const BLOCKQUOTE_PREFIX_RE = /^(?:[ \t]{0,3}>[ \t]?)+/

/**
 * Returns every Table node of the document that the table editor handles, in
 * document order: the tables at the top level and the tables inside
 * blockquotes, also inside nested blockquotes. Tables inside other containers
 * (e.g., list items) are not returned.
 *
 * @param   {Tree}          tree  The syntax tree of the document
 *
 * @return  {SyntaxNode[]}        The Table nodes
 */
export function collectTableNodes (tree: Tree): SyntaxNode[] {
  const tables: SyntaxNode[] = []
  const visit = (parent: SyntaxNode): void => {
    let child = parent.firstChild
    while (child !== null) {
      if (child.name === 'Table') {
        tables.push(child)
      } else if (child.name === 'Blockquote') {
        visit(child)
      }
      child = child.nextSibling
    }
  }
  visit(tree.topNode)
  return tables
}

/**
 * Returns the length of the blockquote markers at the start of a line, or zero
 * if the line does not begin with a blockquote marker.
 *
 * @param   {string}  line  The line text
 *
 * @return  {number}        The length of the markers, including the spaces
 */
export function blockquotePrefixLength (line: string): number {
  return BLOCKQUOTE_PREFIX_RE.exec(line)?.[0].length ?? 0
}

/**
 * Splits a line into its blockquote markers and the rest of the line.
 *
 * @param   {string}            line  The line text
 *
 * @return  {[string, string]}        The markers (empty if there are none) and
 *                                    the rest of the line
 */
export function splitBlockquotePrefix (line: string): [ string, string ] {
  const length = blockquotePrefixLength(line)
  return [ line.slice(0, length), line.slice(length) ]
}

/**
 * Builds an empty table row from a row of the same table: the cell contents
 * are removed and only the delimiters and the whitespace remain. The
 * blockquote markers at the start of the line are kept, so that a new row
 * inside a blockquote stays inside it.
 *
 * @param   {string}  line        The line text of an existing row
 * @param   {RegExp}  removeChars The characters to remove from the row (global)
 *
 * @return  {string}              The empty row
 */
export function emptyRowFromLine (line: string, removeChars: RegExp = /[^\s|]/g): string {
  const [ prefix, rest ] = splitBlockquotePrefix(line)
  return prefix + rest.replace(removeChars, '')
}

/**
 * A table that the table editor renders as a widget
 */
export interface RenderableTable {
  /**
   * The Table node
   */
  node: SyntaxNode
  /**
   * The parsed table, with the cells that short rows leave out
   */
  ast: Table
  /**
   * The index of the table among the tables the editor handles
   */
  tableIndex: number
  /**
   * The start of the range the widget replaces (the start of the table's
   * first line)
   */
  from: number
  /**
   * The end of the range the widget replaces
   */
  to: number
}

/**
 * Zettlr-LYH: The attribute that marks a cell which a row of a pipe table
 * leaves out (the row has fewer cells than the delimiter row). Such a cell is
 * rendered empty; clicking it writes the missing cells into the row.
 */
export const MISSING_CELL_ATTRIBUTE = 'missing-cell'

/**
 * Zettlr-LYH: Parses a Table node into the table that the widget renders, or
 * returns undefined if the widget cannot render it. Only pipe tables are
 * rendered. Following the GFM specification, a row with fewer cells than the
 * delimiter row has empty cells at its end; these are added to the row as
 * cells without a range of their own (positioned at the end of the row) and
 * marked with the missing cell attribute. A row with more cells than the
 * delimiter row is not rendered.
 *
 * @param   {SyntaxNode}       node      The Table node
 * @param   {string}           markdown  The document source
 *
 * @return  {Table|undefined}            The table, or undefined
 */
export function parseRenderableTable (node: SyntaxNode, markdown: string): Table|undefined {
  const ast = parseTableNode(node, markdown)
  // The TableEditor cannot support grid tables, since they can have
  // (a) colspans and rowspans, and (b) multiple lines, which is just
  // too difficult to represent using our approach here. (Also, grids
  // are much easier to parse visually than pipes and less common,
  // reducing the need for us to support them.)
  if (ast.type !== 'Table' || ast.tableType !== 'pipe') {
    return undefined
  }

  const columnCount = ast.alignment.length
  if (columnCount === 0 || ast.rows.some(row => row.cells.length === 0 || row.cells.length > columnCount)) {
    return undefined
  }

  for (const row of ast.rows) {
    while (row.cells.length < columnCount) {
      const missingCell: TableCell = {
        type: 'TableCell',
        name: row.isHeaderOrFooter ? 'th' : 'td',
        from: row.to,
        to: row.to,
        whitespaceBefore: '',
        children: [],
        padding: { from: row.to, to: row.to },
        textContent: '',
        attributes: { [MISSING_CELL_ATTRIBUTE]: 'true' }
      }
      row.cells.push(missingCell)
    }
  }

  return ast
}

/**
 * Zettlr-LYH: Builds the change that writes the cells a table row leaves out
 * at the end of its line, and the position inside one of them. Each missing
 * cell is written as two spaces and a pipe; a row without a trailing pipe
 * first receives one, so that its last cell keeps its content.
 *
 * @param   {string}  lineText      The text of the row's line
 * @param   {number}  lineTo        The document offset of the line's end
 * @param   {number}  missingCount  The number of missing cells
 * @param   {number}  targetIndex   The index of the cell to place the cursor
 *                                  in, counted among the missing cells
 *
 * @return  {{ insert: string, from: number, cursor: number }}  The insertion
 *                                  and the cursor position after it
 */
export function missingCellsInsertion (
  lineText: string,
  lineTo: number,
  missingCount: number,
  targetIndex: number
): { insert: string, from: number, cursor: number } {
  const [ , rowText ] = splitBlockquotePrefix(lineText)
  const trimmedLength = rowText.trimEnd().length
  // Insert after the row's content, so that trailing whitespace stays behind
  const from = lineTo - (rowText.length - trimmedLength)
  const lead = rowText.trimEnd().endsWith('|') ? '' : ' |'
  const insert = lead + '  |'.repeat(missingCount)
  // The cursor goes between the two spaces of the target cell
  const cursor = from + lead.length + 3 * targetIndex + 1
  return { insert, from, cursor }
}

/**
 * Zettlr-LYH: Returns the tables of the document that the table editor
 * renders as widgets, with the range each widget replaces. The index of a
 * table counts every table the editor handles (see collectTableNodes), also
 * those that are not rendered, so that it stays the same whatever the
 * preceding tables look like. A table inside a blockquote begins behind the
 * blockquote markers of its first line; the widget replaces whole lines, so
 * that these markers are hidden as well.
 *
 * @param   {EditorState}  state  The editor state
 * @param   {Tree}         tree   The syntax tree of the document
 *
 * @return  {RenderableTable[]}   The tables in document order
 */
export function renderableTables (state: EditorState, tree: Tree): RenderableTable[] {
  const markdown = state.sliceDoc()
  const tables: RenderableTable[] = []
  collectTableNodes(tree).forEach((node, tableIndex) => {
    const ast = parseRenderableTable(node, markdown)
    if (ast !== undefined) {
      tables.push({ node, ast, tableIndex, from: state.doc.lineAt(node.from).from, to: node.to })
    }
  })
  return tables
}
