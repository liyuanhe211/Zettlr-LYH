/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        isRenderableImageNode, findImageOnlyLines
 * CVM-Role:        Utility Function
 * License:         GNU GPL v3
 *
 * Description:     Determines which image nodes the image renderer displays,
 *                  and which lines hold nothing but such rendered images, so
 *                  that these lines can be centered.
 *
 * END HEADER
 */

import { syntaxTree } from '@codemirror/language'
import type { EditorState, Line } from '@codemirror/state'
import type { SyntaxNode, SyntaxNodeRef, Tree } from '@lezer/common'
import { rangeInSelection } from './range-in-selection'

/**
 * Checks whether the image renderer can display the given node as an image.
 *
 * @param   {EditorState}    state  The editor state
 * @param   {SyntaxNodeRef}  node   The syntax node to check
 *
 * @return  {boolean}               True if the node is a renderable image
 */
export function isRenderableImageNode (state: EditorState, node: SyntaxNodeRef): boolean {
  if (node.type.name !== 'Image') {
    return false
  }

  if (node.node.getChild('URL') === null || node.node.getChildren('LinkMark').length < 2) {
    return false
  }

  // Images (particularly captions) can include newlines and still be valid.
  // However, the image renderer is an inline plugin, and attempting to render
  // such an image would crash the editor.
  return !state.sliceDoc(node.from, node.to).includes('\n')
}

/**
 * Checks whether a line holds nothing but rendered images, the Pandoc
 * attributes directly following them, and whitespace.
 *
 * @param   {EditorState}  state            The editor state
 * @param   {Tree}         tree             The syntax tree of the state
 * @param   {Line}         line             The line to check
 * @param   {boolean}      includeAdjacent  Whether a cursor adjacent to an
 *                                          image counts as touching it
 *
 * @return  {boolean}                       True if the line only holds images
 */
function isImageOnlyLine (state: EditorState, tree: Tree, line: Line, includeAdjacent: boolean): boolean {
  if (!line.text.includes('![')) {
    return false
  }

  const images: SyntaxNode[] = []
  tree.iterate({
    from: line.from,
    to: line.to,
    enter: (node) => {
      if (node.type.name === 'Image' && node.from < line.to && node.to > line.from) {
        images.push(node.node)
      }
    }
  })

  if (images.length === 0) {
    return false
  }

  const removedRanges: Array<{ from: number, to: number }> = []
  for (const image of images) {
    if (image.from < line.from || image.to > line.to) {
      return false
    }

    if (!isRenderableImageNode(state, image) || rangeInSelection(state.selection, image.from, image.to, includeAdjacent)) {
      return false
    }

    removedRanges.push({ from: image.from, to: image.to })

    const attribute = image.nextSibling
    if (attribute !== null && attribute.name === 'PandocAttribute' && attribute.from === image.to && attribute.to <= line.to) {
      removedRanges.push({ from: attribute.from, to: attribute.to })
    }
  }

  removedRanges.sort((first, second) => first.from - second.from)

  let remainingText = ''
  let position = line.from
  for (const range of removedRanges) {
    if (range.from > position) {
      remainingText += state.sliceDoc(position, range.from)
    }
    position = Math.max(position, range.to)
  }
  remainingText += state.sliceDoc(position, line.to)

  return remainingText.trim() === ''
}

/**
 * Finds the lines that hold nothing but images which the image renderer
 * displays, apart from whitespace and the Pandoc attributes of the images.
 * Lines with list or quote marks, other text, images wrapped in links, or an
 * image whose syntax is shown because a selection touches it do not count.
 *
 * @param   {EditorState}                   state            The editor state
 * @param   {{from: number, to: number}[]}  ranges           The ranges whose
 *                                                           lines to check. An
 *                                                           empty array means
 *                                                           the full document.
 * @param   {boolean}                       includeAdjacent  Whether a cursor
 *                                                           adjacent to an
 *                                                           image counts as
 *                                                           touching it
 *
 * @return  {number[]}                                       The start positions
 *                                                           of these lines, in
 *                                                           ascending order
 */
export function findImageOnlyLines (
  state: EditorState,
  ranges: ReadonlyArray<{ from: number, to: number }>,
  includeAdjacent: boolean
): number[] {
  if (ranges.length === 0) {
    ranges = [{ from: 0, to: state.doc.length }]
  }

  const tree = syntaxTree(state)
  const checkedLines = new Set<number>()
  const lineStarts: number[] = []

  for (const { from, to } of ranges) {
    const lastLineNumber = state.doc.lineAt(to).number
    for (let lineNumber = state.doc.lineAt(from).number; lineNumber <= lastLineNumber; lineNumber++) {
      if (checkedLines.has(lineNumber)) {
        continue
      }
      checkedLines.add(lineNumber)

      const line = state.doc.line(lineNumber)
      if (isImageOnlyLine(state, tree, line, includeAdjacent)) {
        lineStarts.push(line.from)
      }
    }
  }

  return lineStarts.sort((first, second) => first - second)
}
