/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        selectImageEffect, selectedImageField, findImageAt,
 *                  imageSourceRange, buildImageWidthChanges,
 *                  buildImageCaptionChanges, computeResizedWidthPercent,
 *                  findHiddenImageAttributeRanges
 * CVM-Role:        Utility Function
 * License:         GNU GPL v3
 *
 * Description:     The logic behind the property state of rendered images: a
 *                  single click selects an image without revealing its source
 *                  (the selection is kept in a state field, not in the editor
 *                  selection), dragging a resize handle writes the new width
 *                  into the Pandoc attributes after the image, and the
 *                  attribute text after a rendered image is hidden. Pure
 *                  functions, no DOM access.
 *
 * END HEADER
 */

import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { StateEffect, StateField, type ChangeSpec, type EditorState } from '@codemirror/state'
import type { SyntaxNode, Tree } from '@lezer/common'
import { PANDOC_ATTRIBUTE_SCHEMA } from '@common/pandoc-util/pandoc-attribute-schema'
import { tokenizeAttributes, updateAttributeList } from '@common/pandoc-util/pandoc-brace-attributes'
import { minimalChange } from '@common/pandoc-util/pandoc-directive-comment'
import { isRenderableImageNode, redundantAttributeRuns } from './image-only-lines'
import { shouldRevealSource } from './reveal-selection'

/**
 * How long building the changes for a new image width may parse the document
 * to make sure that the syntax tree covers the image, in milliseconds
 */
const IMAGE_PARSE_TIMEOUT = 200

/**
 * Matches a brace block at the start of a text, e.g. `{width=50%}` at the
 * start of `{width=50%} more text`
 */
const LEADING_BRACE_BLOCK = /^\{[^{}\n]*\}/

/**
 * Selects a rendered image (its start position, i.e., the `from` of the Image
 * node) or clears the selection (null). The position refers to the document
 * after the transaction that carries the effect; the dispatcher is responsible
 * for passing the correct one.
 */
export const selectImageEffect = StateEffect.define<number|null>()

/**
 * Holds the start position of the image that is selected by a single click
 * and therefore shows its resize handles, or null if no image is selected.
 * An effect sets the value (the last one wins); without an effect, any
 * document change or selection change clears it.
 */
export const selectedImageField = StateField.define<number|null>({
  create () {
    return null
  },
  update (value, transaction) {
    let selected: number|null|undefined
    for (const effect of transaction.effects) {
      if (effect.is(selectImageEffect)) {
        selected = effect.value
      }
    }

    if (selected !== undefined) {
      return selected
    }

    if (transaction.docChanged || transaction.selection !== undefined) {
      return null
    }

    return value
  }
})

/**
 * An image node together with the Pandoc attribute node directly following it
 */
export interface ImageWithAttribute {
  /** The Image node */
  image: SyntaxNode
  /** The PandocAttribute node that starts exactly where the image ends */
  attribute: SyntaxNode|null
}

/**
 * Returns the PandocAttribute node that directly follows an image (no
 * whitespace in between), or null.
 *
 * @param   {SyntaxNode}       image  The Image node
 *
 * @return  {SyntaxNode|null}         The attribute node, or null
 */
function adjacentAttribute (image: SyntaxNode): SyntaxNode|null {
  const next = image.nextSibling
  return next !== null && next.name === 'PandocAttribute' && next.from === image.to ? next : null
}

/**
 * Finds the Image node that starts exactly at the given position, together
 * with the Pandoc attribute node directly following it.
 *
 * @param   {EditorState}                     state  The editor state
 * @param   {number}                          from   The start of the image
 * @param   {Tree}                            tree   Optional: the syntax tree
 *                                                   to search; by default the
 *                                                   current tree of the state
 *
 * @return  {ImageWithAttribute|undefined}           The image and its
 *                                                   attribute, or undefined
 *                                                   if no image starts there
 */
export function findImageAt (state: EditorState, from: number, tree?: Tree): ImageWithAttribute|undefined {
  if (from < 0 || from > state.doc.length) {
    return undefined
  }

  let node: SyntaxNode|null = (tree ?? syntaxTree(state)).resolveInner(from, 1)
  while (node !== null) {
    if (node.name === 'Image' && node.from === from) {
      return { image: node, attribute: adjacentAttribute(node) }
    }
    node = node.parent
  }

  return undefined
}

/**
 * Returns the source range of an image including the Pandoc attributes
 * directly following it, e.g. all of `![a](a.png){width=50%}`. Identical
 * repetitions of the attribute block (`{width=50%}{width=50%}`) belong to the
 * range as well, since they are hidden together with the attributes.
 *
 * @param   {EditorState}  state      The editor state
 * @param   {number}       imageFrom  The start of the image
 *
 * @return  {{ from: number, to: number }|undefined}  The range, or undefined if
 *                                                    no image starts there
 */
export function imageSourceRange (state: EditorState, imageFrom: number): { from: number, to: number }|undefined {
  const found = findImageAt(state, imageFrom)
  if (found === undefined) {
    return undefined
  }

  const runs = redundantAttributeRuns(state, found.image)
  const to = runs.length > 0 ? runs[runs.length - 1].to : found.attribute?.to ?? found.image.to
  return { from: found.image.from, to }
}

/**
 * Builds the changes that set the width of an image to a percentage. The
 * width is written as the Pandoc standard key `width` (which the exporters
 * and the PPTX renderer understand). An existing `width` or `w` key is
 * rewritten in place, keeping its spelling and quote style and removing
 * duplicates; otherwise `width=NN%` is appended. `height` and `h` keys are
 * removed so that the image scales proportionally. All other keys, the id,
 * and the classes stay as they are. Without attributes directly after the
 * image, `{width=NN%}` is inserted. Only the first attribute block is ever
 * changed; repetitions after it stay as they are.
 *
 * Inserting new braces next to existing ones would duplicate the attribute
 * block, so the existing block must be found reliably: the document is parsed
 * at least up to the end of the image line, and braces directly after the
 * image count as its attribute block even if the syntax tree has no node for
 * them.
 *
 * @param   {EditorState}   state         The editor state
 * @param   {number}        imageFrom     The start of the image
 * @param   {number}        widthPercent  The new width in percent (rounded to
 *                                        a whole number)
 *
 * @return  {ChangeSpec[]}                The changes, or an empty list if no
 *                                        image starts at imageFrom or nothing
 *                                        changes
 */
export function buildImageWidthChanges (state: EditorState, imageFrom: number, widthPercent: number): ChangeSpec[] {
  if (imageFrom < 0 || imageFrom > state.doc.length) {
    return []
  }

  // Rendered images never span lines, so the tree must cover the image line
  const lineEnd = state.doc.lineAt(imageFrom).to
  const tree = ensureSyntaxTree(state, lineEnd, IMAGE_PARSE_TIMEOUT) ?? syntaxTree(state)
  const found = findImageAt(state, imageFrom, tree)
  if (found === undefined) {
    return []
  }

  const width = `${Math.round(widthPercent)}%`
  const { image } = found
  let attribute: { from: number, to: number }|null = found.attribute
  if (attribute === null) {
    const braces = LEADING_BRACE_BLOCK.exec(state.sliceDoc(image.to, state.doc.lineAt(image.to).to))
    attribute = braces === null ? null : { from: image.to, to: image.to + braces[0].length }
  }

  if (attribute === null) {
    return [{ from: image.to, insert: `{width=${width}}` }]
  }

  const inner = state.sliceDoc(attribute.from + 1, attribute.to - 1)
  const hasWidth = tokenizeAttributes(inner, 'brace').some(token => {
    const key = token.key.toLowerCase()
    return token.kind === 'keyValue' && (key === 'width' || key === 'w')
  })

  const result = hasWidth
    ? updateAttributeList(inner, 'brace', PANDOC_ATTRIBUTE_SCHEMA.image, { w: width, h: undefined }, { w: ['width'], h: ['height'] })
    : updateAttributeList(inner, 'brace', [], { width, h: undefined }, { h: ['height'] })

  return minimalChange(attribute.from + 1, inner, result.text)
}

/**
 * Builds the changes that apply an edited image caption. The caption of a
 * rendered image shows the image title (or the alternative text if there is
 * no title) with escaped quotes un-escaped. If the edited caption is the same
 * text, character for character, nothing changes. Otherwise the image source
 * `![…](…)` is rewritten with the caption as both alternative text and title
 * (the exporters use one or the other); the Pandoc attributes after the image
 * lie outside the change and stay exactly as they are.
 *
 * @param   {EditorState}   state        The editor state
 * @param   {number}        imageFrom    The start of the image
 * @param   {string}        captionText  The text of the caption element
 *
 * @return  {ChangeSpec[]}               The changes, or an empty list if the
 *                                       caption is unchanged or no renderable
 *                                       image starts at imageFrom
 */
export function buildImageCaptionChanges (state: EditorState, imageFrom: number, captionText: string): ChangeSpec[] {
  const found = findImageAt(state, imageFrom)
  if (found === undefined || !isRenderableImageNode(state, found.image)) {
    return []
  }

  const { image } = found
  const marks = image.getChildren('LinkMark')
  const titleNode = image.getChild('LinkTitle')
  // isRenderableImageNode() guarantees that the last URL is the image source
  const urlNode = image.getChildren('URL').pop()!
  const alt = state.sliceDoc(marks[0].to, marks[1].from)
  const title = titleNode === null ? alt : state.sliceDoc(titleNode.from, titleNode.to)
  if (captionText === title.replace(/\\"/g, '"')) {
    return []
  }

  // Escape quotes to prevent breaking of the image
  const caption = captionText.replace(/"/g, '\\"')
  const url = state.sliceDoc(urlNode.from, urlNode.to)
  return [{ from: image.from, to: image.to, insert: `![${caption}](${url} "${caption}")` }]
}

/**
 * The geometry of a resize drag
 */
export interface ResizeGeometry {
  /** The rendered width of the image when the drag started, in pixels */
  startWidth: number
  /** The horizontal distance the pointer moved since then, in pixels */
  deltaX: number
  /** Which handle is dragged */
  side: 'left'|'right'
  /** Whether the line is centered, so that the image grows to both sides */
  centered: boolean
  /** The width of the content box of the line, in pixels */
  containerWidth: number
}

/**
 * Computes the width in percent of the line that results from dragging a
 * resize handle. Dragging the right handle to the right or the left handle to
 * the left enlarges the image. In a centered line, the image grows to both
 * sides at once, so the handle movement counts twice.
 *
 * @param   {ResizeGeometry}  geometry  The geometry of the drag
 *
 * @return  {number}                    The width in percent, a whole number
 *                                      between 5 and 100 (100 if the
 *                                      container has no width)
 */
export function computeResizedWidthPercent (geometry: ResizeGeometry): number {
  const { startWidth, deltaX, side, centered, containerWidth } = geometry
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) {
    return 100
  }

  const direction = side === 'right' ? 1 : -1
  const newWidth = startWidth + direction * deltaX * (centered ? 2 : 1)
  const percent = Math.round(newWidth / containerWidth * 100)
  if (Number.isNaN(percent)) {
    return 100
  }

  return Math.min(100, Math.max(5, percent))
}

/**
 * Finds the Pandoc attributes (`{…}`) that directly follow rendered images and
 * should therefore be hidden. An attribute is hidden when its image is
 * rendered (renderable and not touched by a selection), it contains no line
 * break, and no selection touches the attribute itself. Identical repetitions
 * of the attribute block directly after it (`{width=50%}{width=50%}`) are
 * hidden together with it, unless a selection lies within them; a different
 * block after it stays visible.
 *
 * @param   {EditorState}                   state            The editor state
 * @param   {{from: number, to: number}[]}  ranges           The ranges to
 *                                                           check. An empty
 *                                                           array means the
 *                                                           full document.
 * @param   {boolean}                       includeAdjacent  Whether a cursor
 *                                                           adjacent to a
 *                                                           range counts as
 *                                                           touching it
 *
 * @return  {Array<{ from: number, to: number }>}            The attribute
 *                                                           ranges, in
 *                                                           ascending order,
 *                                                           without duplicates
 */
export function findHiddenImageAttributeRanges (
  state: EditorState,
  ranges: ReadonlyArray<{ from: number, to: number }>,
  includeAdjacent: boolean
): Array<{ from: number, to: number }> {
  if (ranges.length === 0) {
    ranges = [{ from: 0, to: state.doc.length }]
  }

  const tree = syntaxTree(state)
  const hidden = new Map<number, number>()

  for (const { from, to } of ranges) {
    tree.iterate({
      from,
      to,
      enter: (reference) => {
        if (reference.type.name !== 'Image') {
          return
        }

        const image = reference.node
        const attribute = adjacentAttribute(image)
        if (!isRenderableImageNode(state, image) || shouldRevealSource(state, 'images', image.from, attribute?.to ?? image.to, includeAdjacent)) {
          return
        }

        if (attribute === null || state.sliceDoc(attribute.from, attribute.to).includes('\n')) {
          return
        }

        const runs = redundantAttributeRuns(state, image)
        if (runs.length > 0 && shouldRevealSource(state, 'images', runs[0].from, runs[runs.length - 1].to, false)) {
          return
        }

        hidden.set(attribute.from, attribute.to)
        for (const run of runs) {
          hidden.set(run.from, run.to)
        }
      }
    })
  }

  return [...hidden.entries()]
    .map(([ attributeFrom, attributeTo ]) => ({ from: attributeFrom, to: attributeTo }))
    .sort((first, second) => first.from - second.from)
}
