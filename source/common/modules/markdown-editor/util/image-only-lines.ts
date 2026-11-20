/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        isRenderableImageNode, redundantAttributeRuns,
 *                  findImageOnlyLines
 * CVM-Role:        Utility Function
 * License:         GNU GPL v3
 *
 * Description:     Determines which image nodes the image renderer displays,
 *                  which repeated Pandoc attributes follow an image, and which
 *                  lines hold nothing but such rendered images, so that these
 *                  lines can be centered.
 *
 * END HEADER
 */

import { syntaxTree } from '@codemirror/language'
import type { EditorState, Line } from '@codemirror/state'
import type { SyntaxNode, SyntaxNodeRef, Tree } from '@lezer/common'
import { shouldRevealSource } from './reveal-selection'

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

  // Since alt-text can potentially contain multiple URLs, the last one is
  // taken as the image source.
  const urlNode = node.node.getChildren('URL').pop()
  const marks = node.node.getChildren('LinkMark')
  if (urlNode === undefined || marks.length < 2) {
    return false
  }

  // alt-text can contain URLs, so if the last URL node still lies within the
  // alt-text, the image has no real source.
  if (urlNode.from < marks[1].from) {
    return false
  }

  // Images (particularly captions) can include newlines and still be valid.
  // However, the image renderer is an inline plugin, and attempting to render
  // such an image would crash the editor.
  return !state.sliceDoc(node.from, node.to).includes('\n')
}

/**
 * Finds the repetitions of the Pandoc attribute block of an image: the blocks
 * that directly follow the attribute block right after the image (no
 * whitespace in between) and are identical to it character for character,
 * e.g. the second `{width=50%}` in `![a](a.png){width=50%}{width=50%}`. For
 * Pandoc, only the first block is an attribute; the repetitions are text. A
 * block that differs from the first ends the run.
 *
 * @param   {EditorState}  state  The editor state
 * @param   {SyntaxNode}   image  The Image node
 *
 * @return  {Array<{ from: number, to: number }>}  The ranges of the repeated
 *                                                 blocks, in ascending order;
 *                                                 empty if the image has no
 *                                                 attribute block or it is not
 *                                                 repeated
 */
export function redundantAttributeRuns (state: EditorState, image: SyntaxNode): Array<{ from: number, to: number }> {
  const attribute = image.nextSibling
  if (attribute === null || attribute.name !== 'PandocAttribute' || attribute.from !== image.to) {
    return []
  }

  const attributeText = state.sliceDoc(attribute.from, attribute.to)
  if (attributeText.length < 2 || attributeText.includes('\n')) {
    return []
  }

  // The repetitions are compared as text, since they need not be parsed as
  // attribute nodes of their own
  const lineEnd = state.doc.lineAt(attribute.to).to
  const runs: Array<{ from: number, to: number }> = []
  let position = attribute.to
  while (position + attributeText.length <= lineEnd && state.sliceDoc(position, position + attributeText.length) === attributeText) {
    runs.push({ from: position, to: position + attributeText.length })
    position += attributeText.length
  }

  return runs
}

/**
 * Checks whether a line holds nothing but rendered images, the Pandoc
 * attributes directly following them (including identical repetitions of
 * these attributes), and whitespace.
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

    const attribute = image.nextSibling
    const sourceTo = attribute?.name === 'PandocAttribute' && attribute.from === image.to ? attribute.to : image.to
    if (!isRenderableImageNode(state, image) || shouldRevealSource(state, 'images', image.from, sourceTo, includeAdjacent)) {
      return false
    }

    removedRanges.push({ from: image.from, to: image.to })

    if (attribute !== null && attribute.name === 'PandocAttribute' && attribute.from === image.to && attribute.to <= line.to) {
      removedRanges.push({ from: attribute.from, to: attribute.to })

      // Repetitions of the attribute block are hidden as well, unless a
      // selection touches them (then they are shown as text)
      const runs = redundantAttributeRuns(state, image)
      if (runs.length > 0) {
        if (shouldRevealSource(state, 'images', runs[0].from, runs[runs.length - 1].to, false)) {
          return false
        }
        removedRanges.push(...runs)
      }
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
