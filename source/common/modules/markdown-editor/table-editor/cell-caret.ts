/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Table cell caret placement
 * CVM-Role:        Utility Functions
 * License:         GNU GPL v3
 *
 * Description:     When the user clicks into a rendered (i.e., not currently
 *                  edited) table cell, the cell switches to its Markdown source
 *                  and the cursor has to end up where the user clicked. This
 *                  module determines the clicked position in the rendered cell
 *                  from the mouse coordinates, and maps it onto the
 *                  corresponding offset in the cell's Markdown source by
 *                  matching the rendered text around the click against the
 *                  source.
 *
 * END HEADER
 */

import { CELL_TASK_CHECKBOX_CLASS } from './cell-tasks'

const TEXT_NODE_TYPE = 3
const ELEMENT_NODE_TYPE = 1

/**
 * How many characters of rendered text on either side of the click are matched
 * against the source.
 */
const CONTEXT_LENGTH = 32

/**
 * The text of a rendered cell, and the position of the caret within it.
 */
export interface RenderedCellText {
  text: string
  offset: number
}

/**
 * Returns the text that stands in for an element without text of its own in
 * the rendered cell: Line breaks and task checkboxes are written as their
 * Markdown source, so that the rendered text lines up with the source across
 * them. Everything else contributes nothing.
 *
 * @param   {Element}  element  The element
 *
 * @return  {string}            Its stand-in text
 */
function standInTextFor (element: Element): string {
  if (element.nodeName === 'BR') {
    return '<br>'
  }

  if (element.nodeName === 'INPUT' && element.classList.contains(CELL_TASK_CHECKBOX_CLASS)) {
    return (element as HTMLInputElement).checked ? '- [x]' : '- [ ]'
  }

  return ''
}

/**
 * Collects the text of a rendered cell, and the offset of a DOM caret position
 * (as reported by `caretPositionFromPoint`) within that text. Line breaks and
 * task checkboxes are represented by their Markdown source.
 *
 * @param   {Node}              contentWrapper  The cell's content wrapper
 * @param   {Node}              caretNode       The node of the caret position
 * @param   {number}            caretOffset     The offset within that node: A
 *                                              character offset for text
 *                                              nodes, a child index otherwise
 *
 * @return  {RenderedCellText}                  The text and the caret offset;
 *                                              the offset is the end of the
 *                                              text if the caret is not inside
 *                                              the wrapper.
 */
export function renderedCellText (contentWrapper: Node, caretNode: Node, caretOffset: number): RenderedCellText {
  let text = ''
  let offset = -1

  const visit = (node: Node): void => {
    if (node.nodeType === TEXT_NODE_TYPE) {
      const data = node.textContent ?? ''
      if (node === caretNode) {
        offset = text.length + Math.min(caretOffset, data.length)
      }
      text += data
      return
    }

    if (node.nodeType !== ELEMENT_NODE_TYPE) {
      return
    }

    text += standInTextFor(node as Element)

    const children = [...node.childNodes]
    for (let i = 0; i < children.length; i++) {
      if (node === caretNode && i === caretOffset) {
        offset = text.length
      }
      visit(children[i])
    }

    if (node === caretNode && caretOffset >= children.length) {
      offset = text.length
    }
  }

  visit(contentWrapper)

  return { text, offset: offset < 0 ? text.length : offset }
}

/**
 * Counts how many characters before `position` in `source` agree with the end
 * of `text`.
 *
 * @param   {string}  text      The text that should end at `position`
 * @param   {string}  source    The source
 * @param   {number}  position  The position in the source
 *
 * @return  {number}            The length of the common suffix
 */
function commonSuffixLength (text: string, source: string, position: number): number {
  let length = 0
  while (length < text.length && length < position && text[text.length - 1 - length] === source[position - 1 - length]) {
    length++
  }
  return length
}

/**
 * Counts how many characters from `position` in `source` onwards agree with
 * the beginning of `text`.
 *
 * @param   {string}  text      The text that should begin at `position`
 * @param   {string}  source    The source
 * @param   {number}  position  The position in the source
 *
 * @return  {number}            The length of the common prefix
 */
function commonPrefixLength (text: string, source: string, position: number): number {
  let length = 0
  while (length < text.length && position + length < source.length && text[length] === source[position + length]) {
    length++
  }
  return length
}

/**
 * Maps a caret offset in the rendered text of a table cell onto an offset in
 * the cell's Markdown source. Every source position is scored by how many
 * characters of the rendered text immediately before and after the caret
 * agree with the source immediately before and after that position. The
 * best-scoring position wins; on a tie, the earliest one (so that a link's
 * text wins over a URL that repeats it). Formatting characters merely shorten
 * the agreeing stretches, so that the caret still ends up next to the clicked
 * character.
 *
 * @param   {string}  rendered        The rendered text of the cell
 * @param   {number}  renderedOffset  The caret offset within that text
 * @param   {string}  source          The cell's Markdown source
 *
 * @return  {number}                  The offset within the source
 */
export function mapRenderedOffsetToSource (rendered: string, renderedOffset: number, source: string): number {
  if (source.length === 0) {
    return 0
  }

  // Empty cells render as a non-breaking space, and the Markdown-to-HTML
  // conversion may produce more of them.
  const text = rendered.replace(/ /g, ' ')
  const normalizedSource = source.replace(/ /g, ' ')
  const offset = Math.max(0, Math.min(renderedOffset, text.length))
  const before = text.slice(Math.max(0, offset - CONTEXT_LENGTH), offset)
  const after = text.slice(offset, offset + CONTEXT_LENGTH)

  let bestPosition = -1
  let bestScore = 0
  for (let position = 0; position <= normalizedSource.length; position++) {
    const score = commonSuffixLength(before, normalizedSource, position) + commonPrefixLength(after, normalizedSource, position)
    if (score > bestScore) {
      bestScore = score
      bestPosition = position
    }
  }

  if (bestPosition >= 0) {
    return bestPosition
  }

  // Nothing around the caret occurs in the source (e.g., a cell that only
  // contains an image): Estimate the position proportionally.
  if (text.length === 0) {
    return source.length
  }
  return Math.round(offset / text.length * source.length)
}

/**
 * Determines the DOM caret position at the given client coordinates.
 *
 * @param   {number}  x  The horizontal client coordinate
 * @param   {number}  y  The vertical client coordinate
 *
 * @return  {{ node: Node, offset: number }|null}  The caret position, if any
 */
function caretPositionAt (x: number, y: number): { node: Node, offset: number }|null {
  if (typeof document.caretPositionFromPoint !== 'function') {
    return null
  }

  const position = document.caretPositionFromPoint(x, y)
  if (position === null) {
    return null
  }

  return { node: position.offsetNode, offset: position.offset }
}

/**
 * Determines the offset in a table cell's Markdown source that corresponds to
 * a click at the given client coordinates into the rendered cell. If the click
 * did not hit the cell's contents, the offset is the start of the source for
 * clicks above or to the left of the contents, and its end otherwise.
 *
 * @param   {HTMLElement}  contentWrapper  The rendered cell's content wrapper
 * @param   {string}       source          The cell's current Markdown source
 * @param   {number}       x               The horizontal client coordinate
 * @param   {number}       y               The vertical client coordinate
 *
 * @return  {number}                       The offset within the source
 */
export function sourceOffsetForCellClick (contentWrapper: HTMLElement, source: string, x: number, y: number): number {
  const caret = caretPositionAt(x, y)
  if (caret === null || !contentWrapper.contains(caret.node)) {
    const { top, bottom, left } = contentWrapper.getBoundingClientRect()
    const beforeContents = y < top || (y <= bottom && x < left)
    return beforeContents ? 0 : source.length
  }

  const rendered = renderedCellText(contentWrapper, caret.node, caret.offset)
  return mapRenderedOffsetToSource(rendered.text, rendered.offset, source)
}
