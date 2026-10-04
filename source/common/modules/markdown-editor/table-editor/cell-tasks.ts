/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Table cell task checkboxes
 * CVM-Role:        View
 * License:         GNU GPL v3
 *
 * Description:     Pipe table cells cannot contain real task lists, but a cell
 *                  can emulate one by separating its lines with `<br>`, e.g.
 *                  `- [ ] 1<br>- [x] 2`. This module renders the `- [ ] `
 *                  prefixes of such lines as clickable checkboxes inside the
 *                  rendered (i.e., not currently edited) table cells, and
 *                  toggles the corresponding task marker in the Markdown
 *                  source when a checkbox is clicked.
 *
 * END HEADER
 */

import type { EditorView } from '@codemirror/view'

/**
 * A task marker inside the Markdown source of a single table cell.
 */
export interface CellTaskMarker {
  /**
   * The offset of the opening bracket `[` of the marker, relative to the start
   * of the cell's Markdown source.
   */
  offset: number
  /**
   * Whether the task is checked (`[x]` or `[X]`).
   */
  checked: boolean
}

/**
 * A single document change that toggles one task marker.
 */
export interface CellTaskChange {
  from: number
  to: number
  insert: string
}

/**
 * The part of the EditorView that the checkboxes need.
 */
export type CellTaskView = Pick<EditorView, 'state'|'dispatch'>

/**
 * The class name of the rendered checkboxes.
 */
export const CELL_TASK_CHECKBOX_CLASS = 'cm-table-cell-task'

const TEXT_NODE_TYPE = 3
const ELEMENT_NODE_TYPE = 1

/**
 * Line breaks inside a cell's Markdown source: `<br>`, `<br/>`, `<br />`, in
 * any letter case.
 */
const SOURCE_LINE_BREAK = /<br\s*\/?>/gi

/**
 * A task prefix at the start of a line in the Markdown source. Group 1 is
 * everything before the opening bracket, group 2 the bracket's content.
 */
const SOURCE_TASK_PREFIX = /^(\s*-[ \t]+)\[([ xX])\](?=\s|$)/

/**
 * A task prefix at the start of a line in the rendered DOM. Whitespace is
 * matched more leniently, since the Markdown-to-HTML conversion may duplicate
 * whitespace around inline nodes (e.g., around `[x]`, which the parser reads
 * as a reference link).
 */
const DOM_TASK_PREFIX = /^\s*-\s+\[([ xX])\](?=\s|$)/

/**
 * Finds all task markers in the Markdown source of a table cell. The source is
 * split into lines at every `<br>` tag; a line counts as a task if it starts
 * (after optional whitespace) with `- [ ]`, `- [x]`, or `- [X]`, followed by
 * whitespace or the end of the line.
 *
 * @param   {string}            cellSource  The Markdown source of the cell
 *
 * @return  {CellTaskMarker[]}              The task markers, in source order
 */
export function findCellTaskMarkers (cellSource: string): CellTaskMarker[] {
  const markers: CellTaskMarker[] = []

  const lineStarts = [0]
  const lineEnds: number[] = []
  // NOTE: A fresh copy, so that no `lastIndex` state is shared between calls
  const lineBreak = new RegExp(SOURCE_LINE_BREAK)
  for (let match = lineBreak.exec(cellSource); match !== null; match = lineBreak.exec(cellSource)) {
    lineEnds.push(match.index)
    lineStarts.push(match.index + match[0].length)
  }
  lineEnds.push(cellSource.length)

  for (let i = 0; i < lineStarts.length; i++) {
    const line = cellSource.slice(lineStarts[i], lineEnds[i])
    const match = SOURCE_TASK_PREFIX.exec(line)
    if (match !== null) {
      markers.push({
        offset: lineStarts[i] + match[1].length,
        checked: match[2] !== ' '
      })
    }
  }

  return markers
}

/**
 * Computes the document change that toggles the task marker with the given
 * index in a table cell: Only the character between the brackets is replaced.
 *
 * @param   {string}               cellSource  The cell's current Markdown source
 * @param   {number}               cellFrom    The document offset of the cell's
 *                                             source
 * @param   {number}               index       The index of the task marker
 *
 * @return  {CellTaskChange|null}              The change, or null if the cell
 *                                             no longer contains such a task.
 */
export function toggleCellTaskChange (cellSource: string, cellFrom: number, index: number): CellTaskChange|null {
  const marker = findCellTaskMarkers(cellSource)[index]
  if (marker === undefined) {
    return null
  }

  const from = cellFrom + marker.offset + 1
  return { from, to: from + 1, insert: marker.checked ? ' ' : 'x' }
}

/**
 * Toggles the task that belongs to a rendered checkbox. All information is
 * read at the time of the click: The cell's document range from the dataset of
 * the surrounding table cell element (which the table widget refreshes on
 * every update), and the cell's source from the current editor state.
 *
 * @param   {HTMLElement}   checkbox  The checkbox element
 * @param   {CellTaskView}  view      The main editor view
 *
 * @return  {boolean}                 Whether a change has been dispatched
 */
export function toggleCellTaskFromCheckbox (checkbox: HTMLElement, view: CellTaskView): boolean {
  const cellElement = checkbox.closest<HTMLElement>('td, th')
  if (cellElement === null) {
    return false
  }

  const cellFrom = parseInt(cellElement.dataset.cellFrom ?? '', 10)
  const cellTo = parseInt(cellElement.dataset.cellTo ?? '', 10)
  const index = parseInt(checkbox.dataset.taskIndex ?? '', 10)
  if (Number.isNaN(cellFrom) || Number.isNaN(cellTo) || Number.isNaN(index)) {
    return false
  }

  if (cellFrom < 0 || cellTo < cellFrom || cellTo > view.state.doc.length) {
    return false
  }

  const change = toggleCellTaskChange(view.state.sliceDoc(cellFrom, cellTo), cellFrom, index)
  if (change === null) {
    return false
  }

  view.dispatch({ changes: change })
  return true
}

/**
 * Returns the text of a node as it contributes to the visible cell content.
 *
 * @param   {Node}    node  The node
 *
 * @return  {string}        Its text; empty for comments and similar nodes.
 */
function visibleText (node: Node): string {
  if (node.nodeType === TEXT_NODE_TYPE || node.nodeType === ELEMENT_NODE_TYPE) {
    return node.textContent ?? ''
  }
  return ''
}

/**
 * Describes how the task prefix of a single rendered line is to be replaced
 * with a checkbox.
 */
interface LinePlan {
  /**
   * The node in front of which the checkbox goes.
   */
  firstNode: Node
  /**
   * Nodes that are entirely part of the prefix and get removed.
   */
  removedNodes: Node[]
  /**
   * A text node that starts with the remainder of the prefix, and how many of
   * its characters belong to the prefix.
   */
  partialText?: { node: Text, length: number }
  checked: boolean
}

/**
 * Determines whether a rendered line starts with a task prefix, and if so,
 * which nodes make up that prefix.
 *
 * @param   {Node[]}         nodes  The line's nodes
 *
 * @return  {LinePlan|null}         The plan, or null if this is no task line
 */
function planLine (nodes: Node[]): LinePlan|null {
  if (nodes.length === 0) {
    return null
  }

  const match = DOM_TASK_PREFIX.exec(nodes.map(visibleText).join(''))
  if (match === null) {
    return null
  }

  const plan: LinePlan = { firstNode: nodes[0], removedNodes: [], checked: match[1] !== ' ' }
  let remaining = match[0].length
  for (const node of nodes) {
    if (remaining === 0) {
      break
    }

    const length = visibleText(node).length
    if (node.nodeType === ELEMENT_NODE_TYPE && length === 0) {
      // An element without text (e.g., an image) in front of the marker: This
      // is not a task line.
      return null
    } else if (length <= remaining) {
      plan.removedNodes.push(node)
      remaining -= length
    } else if (node.nodeType === TEXT_NODE_TYPE) {
      plan.partialText = { node: node as Text, length: remaining }
      remaining = 0
    } else {
      // The prefix ends inside an element; we cannot cleanly cut it out.
      return null
    }
  }

  return plan
}

/**
 * Creates a checkbox for the task with the given index.
 *
 * @param   {boolean}           checked  Whether the task is checked
 * @param   {number}            index    The task's index within the cell
 * @param   {CellTaskView}      view     The main editor view
 *
 * @return  {HTMLInputElement}           The checkbox
 */
function createCheckbox (checked: boolean, index: number, view: CellTaskView): HTMLInputElement {
  const checkbox = document.createElement('input')
  checkbox.setAttribute('type', 'checkbox')
  checkbox.classList.add(CELL_TASK_CHECKBOX_CLASS)
  checkbox.setAttribute('aria-label', 'Toggle task')
  checkbox.checked = checked
  checkbox.dataset.taskIndex = String(index)

  // Prevent the table cell from entering editing mode, and prevent any focus
  // or selection change, so that the viewport stays where it is.
  checkbox.addEventListener('mousedown', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })

  checkbox.addEventListener('click', (event) => {
    // The displayed state is determined by the re-rendering after the change,
    // not by the native toggle.
    event.preventDefault()
    event.stopPropagation()
    toggleCellTaskFromCheckbox(checkbox, view)
  })

  return checkbox
}

/**
 * Replaces the task prefixes in a rendered table cell with checkboxes. Must be
 * called right after the cell's content wrapper has been filled with the HTML
 * rendered from `cellSource`. The DOM is only modified if the number of task
 * lines and their states in the DOM agree exactly with those in the source;
 * otherwise the cell is left untouched.
 *
 * @param   {HTMLElement}   contentWrapper  The cell's content wrapper
 * @param   {string}        cellSource      The cell's Markdown source
 * @param   {CellTaskView}  view            The main editor view
 *
 * @return  {number}                        The number of checkboxes rendered
 */
export function renderCellTaskCheckboxes (
  contentWrapper: HTMLElement,
  cellSource: string,
  view: CellTaskView
): number {
  const markers = findCellTaskMarkers(cellSource)
  if (markers.length === 0) {
    return 0
  }

  // Split the wrapper's children into lines at every <br> element
  const lines: Node[][] = [[]]
  for (const child of [...contentWrapper.childNodes]) {
    if (child.nodeName === 'BR') {
      lines.push([])
    } else {
      lines[lines.length - 1].push(child)
    }
  }

  const plans: LinePlan[] = []
  for (const line of lines) {
    const plan = planLine(line)
    if (plan !== null) {
      plans.push(plan)
    }
  }

  if (plans.length !== markers.length || plans.some((plan, i) => plan.checked !== markers[i].checked)) {
    return 0 // Better no checkboxes than wrong ones
  }

  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i]
    contentWrapper.insertBefore(createCheckbox(plan.checked, i, view), plan.firstNode)
    for (const node of plan.removedNodes) {
      node.parentNode?.removeChild(node)
    }
    if (plan.partialText !== undefined) {
      plan.partialText.node.data = plan.partialText.node.data.slice(plan.partialText.length)
    }
  }

  return plans.length
}
