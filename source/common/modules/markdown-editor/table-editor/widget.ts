/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TableEditor Widgets
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This module holds the graphical representations and
 *                  associated functions for the table editor.
 *
 * END HEADER
 */

import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { EditorState, Range } from '@codemirror/state'
import type { Rect, DecorationSet } from '@codemirror/view'
import { WidgetType, EditorView, Decoration } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import type { TableRow, Table } from '../../markdown-utils/markdown-ast'
import { parseTableNode } from '../../markdown-utils/markdown-ast/parse-table-node'
import { nodeToHTML } from '../../markdown-utils/markdown-to-html'
import { createSubviewForCell, hiddenSpanField } from './subview'
import { getCoordinatesForRange } from './commands/util'
import { generateColumnControls, generateEmptyTableWidgetElement, generateRowControls, tableTD, tableTH, tableTR, TABLE_WIDGET_WRAPPER_CLASS } from './widget-dom'
import { displayTableContextMenu } from './context-menu'
import { CITEPROC_MAIN_DB } from 'source/types/common/citeproc'
import { configField } from '../util/configuration'
import { interceptAnchorClicks } from './util/anchor-callbacks'
import openMarkdownLink from '../util/open-markdown-link'
import { renderCellTaskCheckboxes } from './cell-tasks'
import { cellContentsChanged, forgetCellContents, renderCellContents } from './cell-contents'
import { sourceOffsetForCellClick } from './cell-caret'

/**
 * This holds the last measured height of each rendered table to provide
 * values for the `estimatedHeight` getter. It implements a simple LRU
 * cache so that the cache size does not get out of hand, otherwise we
 * would end up with an entry for essentially every position in every
 * open document.
 */
const TABLE_HEIGHT_CACHE = new (class {
  private readonly cache = new Map<string, number>()
  private readonly maxSize = 100 // Limit the number of entries. Currently an arbitrary number.

  get (key: string): number|undefined {
    const value = this.cache.get(key)
    if (value !== undefined) {
      // Refresh the key's position
      this.cache.delete(key)
      this.cache.set(key, value)
    }
    return value
  }

  set (key: string, value: number): void {
    // Refresh the key's position
    if (this.cache.has(key)) {
      this.cache.delete(key)
    // Prune the cache entries
    } else if (this.cache.size === this.maxSize) {
      const first = this.cache.keys().next().value
      if (first !== undefined) {
        this.cache.delete(first)
      }
    }
    this.cache.set(key, value)
  }
})()

/**
 * Returns the height that Codemirror will measure for this table's widget, that
 * is: the height of the widget's wrapper element, not of the table inside it.
 *
 * NOTE that the distinction matters a great deal. The wrapper carries vertical
 * padding (so that the row/column handles never get clipped) and, since it
 * scrolls horizontally, possibly a scrollbar. Codemirror measures the wrapper,
 * because that is the DOM element the widget produced. If `estimatedHeight`
 * reports the inner table's height instead, the height map and the actual
 * layout disagree by exactly that difference every time the height map is
 * rebuilt from estimates. Codemirror's scroll anchoring then compensates for
 * the apparent shift on every measure cycle, which makes the editor creep
 * downwards -- continuously, since each scroll adjustment triggers the next
 * measure cycle. See issue #5940.
 *
 * @param   {HTMLElement}  tableOrWrapper  Either the table or its wrapper
 *
 * @return  {number}                       The wrapper's height in pixels
 */
function measureWidgetHeight (tableOrWrapper: HTMLElement): number {
  const wrapper = tableOrWrapper.closest(`.${TABLE_WIDGET_WRAPPER_CLASS}`) ?? tableOrWrapper
  return wrapper.getBoundingClientRect().height
}

// This widget holds a visual DOM representation of a table.
export class TableWidget extends WidgetType {
  // TODO: This number appears to be highly important to preventing sudden
  // jumping behavior in editors with large tables that have wrapped lines. What
  // we have found so far is that this number simply needs to be larger than the
  // highest wrapped cell in a table to prevent any jumping. But I'll keep the
  // TODO here for as long as we don't really know why this works.
  // For more background, see issue #5940.
  private readonly meanRowHeight = 100

  constructor (readonly ast: Table, readonly node: SyntaxNode) {
    super()
  }

  // Okay, this is wild. So, this getter (plus the `coordsAt` overwrite below)
  // fixes the scroll-jumping issue that many users (incl. me) have experienced
  // and reported. It turns out that Codemirror really relies on estimates from
  // the widgets ESPECIALLY for large block ones like tables. If you don't give
  // it an estimated height (again, does not need to be pixel perfect), it will
  // apparently assume a zero height for calculating viewpoint positions. This
  // will cause scroll jumps, because Codemirror does not know how much space
  // our widget takes up. With even a rough estimate, Codemirror will jump just
  // a little bit the first time you select inside a cell (depending, of course,
  // on how wrong this estimate is), but then it will actually measure it and no
  // more jumping occurs. "Why does the jumping continue if we just don't
  // provide an estimate here?" you may ask now. Well, as far as I'm concerned,
  // I believe if the actual cursor position jumps out of the viewport,
  // Codemirror will re-calculate everything once you're back at the correct
  // position, because you changed the viewport, and only if not you but
  // Codemirror changed the viewport will it believe (itself). Anyways, now it
  // works -- much better than before.
  get estimatedHeight (): number {
    const height = TABLE_HEIGHT_CACHE.get(this.cacheKey) ?? 0
    if (height > 0) {
      return height
    }

    // We base our height estimate off the mean row height.
    return this.ast.rows.length * this.meanRowHeight
  }

  // By setting the cache key to the node's `from` position,
  // we stabilize the cache while edits happen within the table.
  private get cacheKey (): string {
    return `${this.node.from}`
  }

  toDOM (view: EditorView): HTMLElement {
    try {
      const { wrapper, table } = generateEmptyTableWidgetElement()
      const tableAST = parseTableNode(this.node, view.state.sliceDoc())
      if (tableAST.type !== 'Table') {
        throw new Error('Cannot render table: Likely malformed')
      }

      updateTable(table, tableAST, view)

      const cacheKey = this.cacheKey
      view.requestMeasure({
        read () {
          TABLE_HEIGHT_CACHE.set(cacheKey, measureWidgetHeight(wrapper))
        },
        key: cacheKey
      })

      interceptAnchorClicks(wrapper, href => openMarkdownLink(href, view))

      return wrapper
    } catch (err: unknown) {
      console.error(err)
      const error = document.createElement('div')
      error.classList.add('error')
      error.textContent = `Could not render table: ${err instanceof Error ? err.message : 'Unknown error'}`
      return error
    }
  }

  updateDOM (dom: HTMLElement, view: EditorView): boolean {
    // `dom` is the widget wrapper.
    const table: HTMLTableElement|null = dom.querySelector('table')

    // This check allows us to, e.g., create error divs
    if (table === null) {
      return false
    }

    const tableAST = parseTableNode(this.node, view.state.sliceDoc())
    if (tableAST.type === 'Table') {
      const prevHeight = TABLE_HEIGHT_CACHE.get(this.cacheKey) ?? 0
      updateTable(table, tableAST, view)
      // Instruct the editor to remeasure its height; see
      // https://discuss.codemirror.net/t/5604
      // NOTE: `dom` is the widget's wrapper element, which is what has to be
      // measured here (see measureWidgetHeight above).
      const height = measureWidgetHeight(dom)
      if (prevHeight !== height) {

        const cacheKey = this.cacheKey
        view.requestMeasure({
          read () {
            TABLE_HEIGHT_CACHE.set(cacheKey, measureWidgetHeight(dom))
          },
          key: cacheKey
        })
      }
      return true
    }

    return false
  }

  destroy (dom: HTMLElement): void {
    // Here we ensure that we completely detach any active subview from the rest
    // of the document so that the garbage collector can remove the subview.
    // NOTE that all content, including the subviews, are mounted into a content
    // wrapper DIV element within the table cell elements.
    const cells = [...dom.querySelectorAll<HTMLDivElement>('div.content')]

    for (const cell of cells) {
      const subview = EditorView.findFromDOM(cell)
      if (subview !== null) {
        subview.destroy()
      }
    }
  }

  // This is the second secret to preventing scroll jumping-issues: Give
  // Codemirror approximate pixel positions of a position its requesting within
  // the table widget.
  coordsAt (dom: HTMLElement, pos: number, _side: number): Rect | null {
    // We use this helper function to help Codemirror determine the exact, pixel
    // perfect position of a given position inside our table so that it can
    // correctly calculate viewpoint positions where necessary.
    const cells = [...dom.querySelectorAll<HTMLDivElement>('td, th')]
      .map(cell => {
        return {
          td: cell,
          from: parseInt(cell.dataset.cellFrom!, 10),
          to: parseInt(cell.dataset.cellTo!, 10)
        }
      })

    const realPos = pos + this.node.from // NOTE that `pos` is only an offset.

    // NOTE: This code ignores the "side" parameter. Also, it ignores the offset
    // into the table cell itself.
    for (const cell of cells) {
      const { from, to, td } = cell
      if ((from <= realPos && to >= realPos) || realPos < from) {
        // Found it: The pos is somewhere within this cell, or it was after the
        // previous cell (but before this one), or in the leading formatting
        // characters of the table. In any case, report back the correct pixel
        // position of this cell
        const content = td.querySelector('.content')
        if (content !== null) {
          // Found via https://github.com/codemirror/view/blob/45268f0eb62d1c6a0d70952ebdeb2e5ac898109d/src/dom.ts#L89
          // This seems to improve the situation marginally.
          const { left, top, bottom } = content.getBoundingClientRect()
          return { left, right: left, top, bottom }
        } else {
          console.warn('[TableEditor] Cannot provide accurate client rect: no `.content`-element found in table cell.')
          return td.getBoundingClientRect()
        }
      }
    }

    // Not found in the table -> fall back to the rect of the entire table
    return dom.getBoundingClientRect()
  }

  ignoreEvent (event: Event): boolean {
    return true // In this plugin case, the table should handle everything
  }

  /**
   * Takes an EditorState and returns a DecorationSet containing TableWidgets
   * for each Table node found in the state.
   *
   * @param   {EditorState}    state  The EditorState
   *
   * @return  {DecorationSet}         The DecorationSet
   */
  public static createForState (state: EditorState): DecorationSet {
    // We try to retrieve the full syntax tree, and if that fails, fall back to
    // the (possibly incomplete) syntax tree.
    const tree = ensureSyntaxTree(state, state.doc.length, 500) ?? syntaxTree(state)
    // Constantly calling `sliceDoc()` within the tree traversal
    // below has some negative performance impacts, so we extract
    // the markdown text outside of the loop
    const markdown = state.sliceDoc()

    const newDecos: Array<Range<Decoration>> = tree
      // Get all Table nodes in the document
      .topNode.getChildren('Table')
      .map(node => {
        return { node, ast: parseTableNode(node, markdown) }
      })
      .filter(({ ast }) => {
        // The TableEditor cannot support grid tables, since they can have
        // (a) colspans and rowspans, and (b) multiple lines, which is just
        // too difficult to represent using our approach here. (Also, grids
        // are much easier to parse visually than pipes and less common,
        // reducing the need for us to support them.)
        if (ast.type === 'Table' && ast.tableType === 'pipe') {
          const rowLength = ast.alignment?.length ?? 0
          return ast.rows.every(r => r.cells.length === rowLength)
        }

        return false
      })
      // Turn the nodes into Decorations
      .map(({ node, ast }) => {
        return Decoration.replace({
          widget: new TableWidget(ast as Table, node.node),
          // inclusive: false,
          block: true
        }).range(node.from, node.to)
      })
    return Decoration.set(newDecos, true)
  }
}

/**
 * This function takes a DOM-node and a string representing the same Markdown
 * table and ensures that the DOM-node representation conforms to the string.
 *
 * @param  {HTMLTableElement}  table     The DOM-element containing the table
 * @param  {Table}             tableAST  The table AST node
 * @param  {EditorView}        view      The EditorView
 */
function updateTable (table: HTMLTableElement, tableAST: Table, view: EditorView): void {
  // Before we get started in updating the table, we need to find and remove all
  // handle elements we have in the table. They will be re-inserted in the
  // updateRow function calls below.
  table.querySelectorAll('div.grab-handle').forEach(handle => handle.parentElement!.removeChild(handle))
  table.querySelectorAll('div.plus').forEach(plus => plus.parentElement!.removeChild(plus))

  const trs = [...table.querySelectorAll('tr')]
  const rowsChanged = trs.length !== tableAST.rows.length
  // Remove now-superfluous TRs. The for-loop below accounts for too few.
  while (trs.length > tableAST.rows.length) {
    const tr = trs.pop()!
    tr.parentElement?.removeChild(tr)
  }

  const coords = getCoordinatesForRange(view.state.selection.main, tableAST)

  for (let i = 0; i < tableAST.rows.length; i++) {
    const row = tableAST.rows[i]
    if (i === trs.length) {
      // We have to create a new TR
      const tr = tableTR()
      table.appendChild(tr)
      trs.push(tr)
    }
    // Transfer the contents
    updateRow(trs[i], row, i, tableAST.alignment, view, rowsChanged, coords)
  }

  // Store the table's document range on the element so that other extensions
  // (specifically the scroll lock registered in index.ts) can relate scroll
  // requests to this table.
  table.dataset.tableFrom = String(tableAST.from)
  table.dataset.tableTo = String(tableAST.to)

  manageColumnWidthLock(table, tableAST, view, coords)
}

/**
 * The attribute that marks a table whose column widths are currently locked
 * because one of its cells is being edited. The scroll lock in index.ts keys
 * off this attribute as well.
 */
export const LOCKED_WIDTHS_ATTRIBUTE = 'data-locked-col-widths'

/**
 * Handles the column width lock lifecycle for a table widget (see #5940).
 *
 * While any cell of the table is being edited, the column widths are frozen so
 * that typing does not continuously re-layout the entire table (the layout
 * thrashing was one of the causes for the view jumping around during edits).
 * Only when the cell editing mode is exited -- the cursor moved to a different
 * cell, or out of the table entirely -- are the column widths re-fitted to the
 * contents: exactly once, and anchored such that the cursor position on screen
 * does not move.
 *
 * @param  {HTMLTableElement}                 table     The table element
 * @param  {Table}                            tableAST  The table AST node
 * @param  {EditorView}                       view      The main EditorView
 * @param  {{ col: number, row: number }?}    coords    The cell coordinates of
 *                                                      the main selection, or
 *                                                      undefined if the
 *                                                      selection is outside
 *                                                      the table
 */
function manageColumnWidthLock (
  table: HTMLTableElement,
  tableAST: Table,
  view: EditorView,
  coords: { col: number, row: number }|undefined
): void {
  const editingCell = coords !== undefined ? `${coords.row}:${coords.col}` : ''
  const wasEditingCell = table.dataset.editingCell ?? ''
  table.dataset.editingCell = editingCell

  const columnCount = tableAST.rows[0]?.cells.length ?? 0
  const isLocked = table.getAttribute(LOCKED_WIDTHS_ATTRIBUTE) === 'true'
  const columnsChangedWhileLocked = isLocked && table.dataset.lockedColumnCount !== String(columnCount)

  if (editingCell !== '' && wasEditingCell === '') {
    // Entering cell editing mode: Freeze the current column widths. This
    // happens BEFORE the cell's subview gets mounted (the mounting is
    // scheduled in a rAF within updateRow), so we capture the pre-edit layout.
    if (table.isConnected) {
      lockColumnWidths(table)
    } else {
      // We came through toDOM: The table is not yet attached to the document,
      // so measuring is impossible. Defer the locking until it is.
      requestAnimationFrame(() => { lockColumnWidths(table) })
    }
  } else if (editingCell === '' && wasEditingCell !== '') {
    // The selection left the table: Re-fit the columns once, keeping the
    // cursor stationary on screen.
    refitColumnWidths(table, view, `${tableAST.from}`, false)
  } else if (editingCell !== '' && (editingCell !== wasEditingCell || columnsChangedWhileLocked)) {
    // The selection moved to a different cell (or the table structure changed
    // while locked, e.g., a column was added): Re-fit the columns once and
    // freeze the new widths, keeping the cursor stationary on screen.
    refitColumnWidths(table, view, `${tableAST.from}`, true)
  }
}

/**
 * Freezes the table's current column widths by giving the first row's cells
 * explicit pixel widths and switching the table to the fixed layout algorithm.
 * A no-op if the table is not attached to the document or already locked.
 *
 * @param  {HTMLTableElement}  table  The table element
 */
function lockColumnWidths (table: HTMLTableElement): void {
  if (!table.isConnected || table.getAttribute(LOCKED_WIDTHS_ATTRIBUTE) === 'true') {
    return
  }

  const firstRowCells = [...table.querySelectorAll<HTMLTableCellElement>('tr:first-child > th, tr:first-child > td')]
  if (firstRowCells.length === 0) {
    return
  }

  // Measure everything before writing any styles so that the reads and writes
  // do not interleave (which would cause repeated re-layouts).
  const tableWidth = table.getBoundingClientRect().width
  const cellWidths = firstRowCells.map(cell => cell.getBoundingClientRect().width)

  for (let i = 0; i < firstRowCells.length; i++) {
    firstRowCells[i].style.boxSizing = 'border-box'
    firstRowCells[i].style.width = `${cellWidths[i]}px`
  }

  // NOTE: `table-layout: fixed` only becomes active with an explicit table
  // width. Under the fixed algorithm, the column widths follow the first row's
  // cell widths, regardless of the cells' contents.
  table.style.tableLayout = 'fixed'
  table.style.width = `${tableWidth}px`
  table.setAttribute(LOCKED_WIDTHS_ATTRIBUTE, 'true')
  table.dataset.lockedColumnCount = String(firstRowCells.length)
}

/**
 * Removes the column width lock again, returning the table to the automatic
 * layout algorithm (i.e., the browser re-fits all columns to their contents).
 * A no-op if the table is not locked.
 *
 * @param  {HTMLTableElement}  table  The table element
 */
function unlockColumnWidths (table: HTMLTableElement): void {
  if (table.getAttribute(LOCKED_WIDTHS_ATTRIBUTE) !== 'true') {
    return
  }

  for (const cell of [...table.querySelectorAll<HTMLTableCellElement>('th, td')]) {
    cell.style.boxSizing = ''
    cell.style.width = ''
  }

  table.style.tableLayout = ''
  table.style.width = ''
  table.removeAttribute(LOCKED_WIDTHS_ATTRIBUTE)
  delete table.dataset.lockedColumnCount
}

/**
 * Re-fits the table's column widths to their contents (optionally freezing the
 * resulting widths again), while keeping the on-screen position of the main
 * selection stationary: The layout shift caused by the re-fit is measured and
 * compensated by adjusting the scroll position.
 *
 * @param  {HTMLTableElement}  table      The table element
 * @param  {EditorView}        view       The main EditorView
 * @param  {string}            cacheKey   The table's height cache key
 * @param  {boolean}           lockAgain  Whether to freeze the new widths
 *                                        again (true when the user merely
 *                                        moved on to editing another cell)
 */
function refitColumnWidths (table: HTMLTableElement, view: EditorView, cacheKey: string, lockAgain: boolean): void {
  // The re-fit must happen outside of the current update cycle. Additionally,
  // when the user moves from one cell to another, the new cell's subview is
  // mounted in a rAF that updateRow has scheduled before this one, so by the
  // time this callback runs, the DOM shows the state we want to fit to.
  requestAnimationFrame(() => {
    if (!table.isConnected) {
      return
    }

    const head = view.state.selection.main.head
    // NOTE: For positions inside the table, this call resolves through the
    // widget's `coordsAt` override to the enclosing cell's content rectangle.
    const coordsBefore = view.coordsAtPos(head)

    unlockColumnWidths(table)

    if (lockAgain) {
      lockColumnWidths(table)
    }

    // The re-fit likely changed the table's height: Update the height cache
    // and have CodeMirror re-measure, mirroring what updateDOM does.
    TABLE_HEIGHT_CACHE.set(cacheKey, measureWidgetHeight(table))

    const coordsAfter = view.coordsAtPos(head)
    if (coordsBefore !== null && coordsAfter !== null) {
      const delta = coordsAfter.top - coordsBefore.top
      if (delta !== 0) {
        // Compensate the layout shift so that the cursor stays stationary on
        // screen.
        view.scrollDOM.scrollTop += delta
      }
    }

    view.requestMeasure()
  })
}

/**
 * This function takes a single table row to update it. This is basically the
 * second level of recursion for those tree structures, but since it is
 * noticeably different from the first level function above, and also the last
 * layer of recursion here, we use a second function for that.
 *
 * @param  {HTMLTableRowElement}  tr      The table row element
 * @param  {TableRow}             astRow  The AST table row element
 * @param  {number}               idx     The row's index in the table
 * @param  {EditorView}           view    The EditorView
 */
function updateRow (
  tr: HTMLTableRowElement,
  astRow: TableRow,
  idx: number,
  align: Array<'left'|'center'|'right'|null>,
  view: EditorView,
  rowsChanged: boolean,
  selectionCoords?: { col: number, row: number },
): void {
  const tds = [...tr.querySelectorAll(astRow.isHeaderOrFooter ? 'th' : 'td')]
  const columnsChanged = tds.length !== astRow.cells.length
  // Remove now-superfluous TRs. The for-loop below accounts for too few.
  while (tds.length > astRow.cells.length) {
    const td = tds.pop()!
    td.parentElement?.removeChild(td)
  }

  const { row, col } = selectionCoords !== undefined ? selectionCoords : { row: -1, col: -1 }

  // Prepare the citation callback
  let { library } = view.state.field(configField).metadata
  library = library === '' ? CITEPROC_MAIN_DB : library
  const onCitation = window.getCitationCallback(library)
  // Relative image sources in the cells are resolved against this path
  const documentPath = view.state.field(configField).metadata.path

  for (let i = 0; i < astRow.cells.length; i++) {
    const cell = astRow.cells[i]
    const selectionInCell = row === idx && col === i
    if (i === tds.length) {
      // We have to create a new TD
      const td = astRow.isHeaderOrFooter ? tableTH() : tableTD()

      const contentWrapper = document.createElement('div')
      contentWrapper.classList.add('content')
      td.appendChild(contentWrapper)

      const { zknLinkFormat } = view.state.field(configField)
      const html = nodeToHTML(cell.children, {
        onCitation, zknLinkFormat,
      }, 0).trim()
      renderCellContents(contentWrapper, html, documentPath)
      renderCellTaskCheckboxes(contentWrapper, cell.textContent, view)

      // NOTE: This handle gets attached once and then remains on the TD for
      // the existence of the table. Since the `view` will always be the same,
      // we only have to save the cellFrom and cellTo to the TDs dataset each
      // time around (see below).
      td.addEventListener('mousedown', (event) => {
        if (contentWrapper.classList.contains('editing')) {
          // There is already a subview inside this cell to handle selections.
          return
        }

        event.preventDefault()
        event.stopPropagation()

        setSelectionToCell(td, event, view)
      })

      td.addEventListener('contextmenu', (event) => {
        const ctxEvent = event instanceof PointerEvent && event.button === 2
        if (!ctxEvent) {
          return
        }

        event.preventDefault()
        event.stopPropagation()

        const subview = EditorView.findFromDOM(td)

        if (subview === null) {
          setSelectionToCell(td, event, view)
        }

        displayTableContextMenu(event, view, subview ?? view)
      })

      tr.appendChild(td)
      tds.push(td)
    }

    // At this point, there is guaranteed to be an element at i. We need to do
    // // two update operations here. First, insert handles to first row/col
    // cells, and second verify if we have to simply transfer the contents, or
    // add/remove a subview in this cell based on selection.
    if (idx === 0 && col === i) {
      // Selection is in this column
      for (const elem of generateColumnControls(view)) {
        tds[i].appendChild(elem)
      }
    }

    if (i === 0 && row === idx) {
      // Selection is in this row
      for (const elem of generateRowControls(view)) {
        tds[i].appendChild(elem)
      }
    }

    // Save the corresponding document offsets appropriately. NOTE that we
    // include whitespace here (minus one space padding if applicable).
    tds[i].dataset.cellFrom = String(cell.from)
    tds[i].dataset.cellTo = String(cell.to)
    tds[i].style.textAlign = align[i] ?? ''

    const contentWrapper: HTMLDivElement = tds[i].querySelector('div.content')!
    const subview = EditorView.findFromDOM(contentWrapper)

    const [ subviewFrom, subviewTo ] = subview?.state.field(hiddenSpanField).cellRange ?? [ -1, -1 ]

    if (subview !== null && !selectionInCell) {
      subview.destroy()
      contentWrapper.classList.remove('editing')
      const { zknLinkFormat } = view.state.field(configField)
      const html = nodeToHTML(cell.children, {
        onCitation, zknLinkFormat,
      }, 0).trim()
      renderCellContents(contentWrapper, html, documentPath)
      renderCellTaskCheckboxes(contentWrapper, cell.textContent, view)
      interceptAnchorClicks(contentWrapper, href => openMarkdownLink(href, view))
    } else if (subview === null && selectionInCell) {
      // Before we mount a subview, we need to normalize the selection if
      // necessary. The table commands are allowed to place the new selection
      // anywhere inside the table cell delimiters, and this will make
      // `selectionInCell` turn `true` because that only checks if we are
      // anywhere between the table cell delimiters. However, especially when
      // the selection is inside an empty cell with more than two spaces, it is
      // entirely arbitrary where the (synthetic) content span will end up.
      // Our AST parser will just decide on something, so before this point we
      // actually don't know if the selection will literally end up where the
      // AST has placed the cell content span. But that is important, because
      // that is where the subview will place the editable span of the cell. If
      // the selection is inside the table cell delimiters, but outside of what
      // the AST considers "content," this will lead to weird transactions that
      // won't pass either the transaction filter of the subview, or, worse, add
      // the inserted characters at completely arbitrary positions of the table.
      // So, here we enforce that the main selection is definitely somewhere
      // inside the table cell *content*.
      const sel = view.state.selection.main
      const newFrom = Math.min(Math.max(sel.from, cell.from), cell.to)
      const newTo = Math.min(Math.max(sel.to, cell.from), cell.to)

      // NOTE: This entire code runs during updates (since that's when the
      // widget's updateDOM function will be called), so we must wait until that
      // update is complete before we do anything.
      requestAnimationFrame(() => {
        if (newFrom !== sel.from || newTo !== sel.to) {
          view.dispatch({ selection: { anchor: newFrom, head: newTo } })
        }

        // Create a new subview to represent the selection here. Ensure the cell
        // itself is empty before we mount the subview.
        // NOTE: Forget the rendered contents, so that the cell is re-rendered
        // once the subview is gone, no matter who destroyed it.
        forgetCellContents(contentWrapper)
        contentWrapper.innerHTML = ''
        createSubviewForCell(view, contentWrapper, { from: cell.from, to: cell.to })
        contentWrapper.classList.add('editing')
      })
    } else if (subview === null) {
      // Simply transfer the contents
      const { zknLinkFormat } = view.state.field(configField)
      const html = nodeToHTML(cell.children, {
        onCitation, zknLinkFormat,
      }, 0).trim()
      // NOTE: Compare against what the cell has been rendered from, since
      // resolved image sources and task checkboxes alter its inner HTML.
      if (cellContentsChanged(contentWrapper, html, documentPath)) {
        renderCellContents(contentWrapper, html, documentPath)
        renderCellTaskCheckboxes(contentWrapper, cell.textContent, view)
        interceptAnchorClicks(contentWrapper, href => openMarkdownLink(href, view))
      }
    } else if ((subviewFrom !== cell.from || subviewTo !== cell.to) && (columnsChanged || rowsChanged)) {
      // Here, there is a subview in the cell and the selection is in this cell,
      // but the subview has been "carried over" from a different column or row,
      // which happens if the user adds or removes columns or rows. In this case
      // we basically have to remove and recreate the subview, to ensure it
      // grabs the correct cell's information.
      // NOTE: This is a potential point of failure. `cell.from` and `cell.to`
      // may not correspond to the subview range, since the user can insert
      // spaces which the parser will not consider part of the cell. This is why
      // we also check for whether the amount of columns or rows has changed.
      // This is usually a good indicator that the subview may contain an
      // outdated cell view.
      subview.destroy()
      createSubviewForCell(view, contentWrapper, { from: cell.from, to: cell.to })
    } // Else: The cell has a subview and the selection is still in there.
  }
}

/**
 * Sets the selection into a targeted cell in preparation for instantiating a
 * table editor here. The cursor is placed at the position in the cell's
 * Markdown source that corresponds to the clicked position in the rendered
 * cell.
 *
 * NOTE: The DOM selection cannot be used for this, since the mousedown handler
 * prevents the default action, so the browser never moves the DOM selection
 * to the click position.
 *
 * @param   {HTMLTableCellElement}  td     The table cell element
 * @param   {MouseEvent}            event  The mouse event of the click
 * @param   {EditorView}            view   The editor view
 */
function setSelectionToCell (td: HTMLTableCellElement, event: MouseEvent, view: EditorView): void {
  // NOTE: Read the cell's range and source at the time of the click, since the
  // listeners outlive any edits to the cell.
  const cellFrom = parseInt(td.dataset.cellFrom ?? '0', 10)
  const cellTo = parseInt(td.dataset.cellTo ?? '0', 10)
  const source = view.state.sliceDoc(cellFrom, cellTo)
  const contentWrapper = td.querySelector<HTMLElement>('div.content')
  const offset = contentWrapper !== null
    ? sourceOffsetForCellClick(contentWrapper, source, event.clientX, event.clientY)
    : source.length
  view.dispatch({ selection: { anchor: Math.min(cellFrom + offset, cellTo) } })
}
