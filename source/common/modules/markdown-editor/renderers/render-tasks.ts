/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TaskRenderer
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This renderer displays task lists
 *
 * END HEADER
 */

import { renderInlineWidgets } from './base-renderer'
import { type SyntaxNodeRef, type SyntaxNode } from '@lezer/common'
import { WidgetType, ViewPlugin, type EditorView } from '@codemirror/view'
import { Prec, type EditorState, type Extension } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { isInTaskHitArea } from '../util/task-hit-area'

/**
 * The class name of the checkboxes rendered in place of task markers.
 */
export const TASK_CHECKBOX_CLASS = 'cm-task-checkbox'

/**
 * The class name a line receives while the pointer hovers over the enlarged
 * clickable area of its task checkbox (R116).
 */
export const TASK_HIT_AREA_HOVER_CLASS = 'cm-task-hit-area-hover'

/**
 * Toggles the task marker in the given range between `[ ]` and `[x]`, without
 * moving the cursor or scrolling (R14).
 *
 * @param   {EditorView}  view       The editor view
 * @param   {number}      from       The start of the task marker
 * @param   {number}      to         The end of the task marker
 * @param   {boolean}     isChecked  Whether the task is currently checked
 */
function toggleTaskMarker (view: EditorView, from: number, to: number, isChecked: boolean): void {
  const insert = isChecked ? '[ ]' : '[x]'
  view.dispatch({ changes: [{ from, to, insert }] })
  // view.focus() focuses with preventScroll; a bare contentDOM.focus()
  // makes the browser scroll to the (possibly far away) cursor.
  view.focus()
}

class TaskWidget extends WidgetType {
  constructor (readonly isChecked: boolean, readonly node: SyntaxNode) {
    super()
  }

  eq (other: TaskWidget): boolean {
    return other.isChecked === this.isChecked &&
      other.node.from === this.node.from &&
      other.node.to === this.node.to
  }

  toDOM (view: EditorView): HTMLElement {
    const elem = document.createElement('input')
    elem.setAttribute('type', 'checkbox')
    elem.classList.add(TASK_CHECKBOX_CLASS)
    elem.checked = this.isChecked
    elem.addEventListener('click', () => {
      toggleTaskMarker(view, this.node.from, this.node.to, this.isChecked)
    })
    return elem
  }

  ignoreEvent (event: Event): boolean {
    return event instanceof MouseEvent && event.type === 'mousedown'// Allows clicking on the checkbox without checklist toggling
  }
}

function shouldHandleNode (node: SyntaxNodeRef): boolean {
  return node.type.name === 'TaskMarker'
}

function createWidget (state: EditorState, node: SyntaxNodeRef): TaskWidget|undefined {
  // Get the actual link contents, extract title and URL and create a
  // replacement widget
  const task = state.sliceDoc(node.from, node.to) // Will be either [ ] or [x]
  const isChecked = task !== '[ ]'

  return new TaskWidget(isChecked, node.node)
}

/**
 * Returns the left edge of the list marker that belongs to the task marker at
 * `taskFrom`, as displayed (a rendered bullet, a literal `-`, or an ordered
 * list number), or null if it cannot be determined.
 *
 * @param   {EditorView}   view      The editor view
 * @param   {number}       taskFrom  The start of the task marker
 *
 * @return  {number|null}            The left edge in client coordinates
 */
function listMarkerLeft (view: EditorView, taskFrom: number): number|null {
  let node: SyntaxNode|null = syntaxTree(view.state).resolveInner(taskFrom, 1)
  while (node !== null && node.name !== 'ListItem') {
    node = node.parent
  }
  const listMark = node?.getChild('ListMark')
  if (listMark === null || listMark === undefined) {
    return null
  }
  // A rendered bullet widget replaces the list mark, and the forward side of
  // its start may report the widget's right edge; the leftmost side counts.
  const lefts = [ view.coordsAtPos(listMark.from, 1)?.left, view.coordsAtPos(listMark.from, -1)?.left ]
    .filter((left): left is number => left !== undefined)
  return lefts.length > 0 ? Math.min(...lefts) : null
}

/**
 * A task checkbox in the main editor together with its task marker's range.
 */
interface TaskHit {
  checkbox: HTMLInputElement
  from: number
  to: number
  isChecked: boolean
}

/**
 * Finds the task checkbox whose enlarged clickable area (R116) contains the
 * given pointer position. Only the checkbox of the line under the pointer is
 * considered.
 *
 * @param   {EditorView}         view    The editor view
 * @param   {EventTarget|null}   target  The event's target
 * @param   {number}             x       The pointer's client x coordinate
 * @param   {number}             y       The pointer's client y coordinate
 *
 * @return  {TaskHit|null}               The hit, or null
 */
export function findTaskHit (view: EditorView, target: EventTarget|null, x: number, y: number): TaskHit|null {
  const element = target instanceof Element ? target : (target instanceof Node ? target.parentElement : null)
  const line = element?.closest<HTMLElement>('.cm-line')
  if (line === null || line === undefined || line.closest('.cm-content') !== view.contentDOM) {
    return null
  }

  const checkbox = line.querySelector<HTMLInputElement>(`input.${TASK_CHECKBOX_CLASS}`)
  if (checkbox === null) {
    return null
  }

  const from = view.posAtDOM(checkbox)
  const marker = view.state.sliceDoc(from, from + 3)
  if (!/^\[[ xX]\]$/.test(marker)) {
    return null
  }

  const checkboxRectangle = checkbox.getBoundingClientRect()
  const lineRectangle = line.getBoundingClientRect()
  // A wrapped line spans several visual rows; the checkbox is in the first.
  const rowHeight = Math.max(view.defaultLineHeight, checkboxRectangle.bottom - lineRectangle.top)
  const geometry = {
    markerLeft: listMarkerLeft(view, from) ?? checkboxRectangle.left,
    checkboxLeft: checkboxRectangle.left,
    checkboxRight: checkboxRectangle.right,
    rowTop: lineRectangle.top,
    rowBottom: lineRectangle.top + Math.min(lineRectangle.height, rowHeight)
  }

  if (!isInTaskHitArea(geometry, x, y)) {
    return null
  }

  return { checkbox, from, to: from + 3, isChecked: marker !== '[ ]' }
}

/**
 * Zettlr-LYH (R116): Enlarges the clickable area of rendered task checkboxes
 * to the whole list marker area of their line. A press and release within
 * that area toggles the task like a click on the checkbox itself, without
 * placing the cursor; the pointer shows a hand there.
 *
 * The listeners sit directly on the content element, in the capture phase:
 * the rendered bullet replacing the list mark is a widget that ignores events,
 * so CodeMirror's own event handlers never see a press on it.
 */
const taskHitArea = Prec.high(ViewPlugin.fromClass(class {
  /**
   * The checkbox whose area received the last primary button press.
   */
  pressedCheckbox: HTMLInputElement|null = null
  constructor (readonly view: EditorView) {
    view.contentDOM.addEventListener('mousedown', this.onMouseDown, true)
    view.contentDOM.addEventListener('click', this.onClick, true)
    view.contentDOM.addEventListener('mousemove', this.onMouseMove)
    view.contentDOM.addEventListener('mouseleave', this.onMouseLeave)
  }

  onMouseDown = (event: MouseEvent): void => {
    this.pressedCheckbox = null
    if (event.button !== 0 || (event.target instanceof Element && event.target.classList.contains(TASK_CHECKBOX_CLASS))) {
      return
    }
    const hit = findTaskHit(this.view, event.target, event.clientX, event.clientY)
    if (hit === null) {
      return
    }
    // Neither place the cursor nor move the focus; the toggle follows on
    // the click, just like with the checkbox itself.
    event.preventDefault()
    event.stopPropagation()
    this.pressedCheckbox = hit.checkbox
  }

  onClick = (event: MouseEvent): void => {
    const pressedCheckbox = this.pressedCheckbox
    this.pressedCheckbox = null
    if (pressedCheckbox === null || event.target === pressedCheckbox) {
      return
    }
    const hit = findTaskHit(this.view, event.target, event.clientX, event.clientY)
    if (hit === null || hit.checkbox !== pressedCheckbox) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    toggleTaskMarker(this.view, hit.from, hit.to, hit.isChecked)
  }

  onMouseMove = (event: MouseEvent): void => {
    this.setHovered(findTaskHit(this.view, event.target, event.clientX, event.clientY) !== null)
  }

  onMouseLeave = (): void => {
    this.setHovered(false)
  }

  /**
   * Shows or hides the hand pointer. The class goes on the scroller, which
   * CodeMirror neither observes nor re-renders, unlike the content and its
   * lines.
   *
   * @param   {boolean}  hovered  Whether the pointer is within an area
   */
  setHovered (hovered: boolean): void {
    this.view.scrollDOM.classList.toggle(TASK_HIT_AREA_HOVER_CLASS, hovered)
  }

  destroy (): void {
    this.view.contentDOM.removeEventListener('mousedown', this.onMouseDown, true)
    this.view.contentDOM.removeEventListener('click', this.onClick, true)
    this.view.contentDOM.removeEventListener('mousemove', this.onMouseMove)
    this.view.contentDOM.removeEventListener('mouseleave', this.onMouseLeave)
    this.setHovered(false)
  }
}))

export const renderTasks: Extension = [
  renderInlineWidgets(shouldHandleNode, createWidget, undefined, 'checkboxes'),
  taskHitArea
]
