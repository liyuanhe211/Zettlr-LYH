/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        selectImageEffect, selectedImageField, findImageAt,
 *                  imageSourceRange, buildImageWidthChanges,
 *                  computeResizedWidthPercent, findHiddenImageAttributeRanges
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

import { syntaxTree } from '@codemirror/language'
import { StateEffect, StateField, type ChangeSpec, type EditorState } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'
import { PANDOC_ATTRIBUTE_SCHEMA } from '@common/pandoc-util/pandoc-attribute-schema'
import { tokenizeAttributes, updateAttributeList } from '@common/pandoc-util/pandoc-brace-attributes'
import { minimalChange } from '@common/pandoc-util/pandoc-directive-comment'
import { isRenderableImageNode } from './image-only-lines'
import { rangeInSelection } from './range-in-selection'

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
 *
 * @return  {ImageWithAttribute|undefined}           The image and its
 *                                                   attribute, or undefined
 *                                                   if no image starts there
 */
export function findImageAt (state: EditorState, from: number): ImageWithAttribute|undefined {
  if (from < 0 || from > state.doc.length) {
    return undefined
  }

  let node: SyntaxNode|null = syntaxTree(state).resolveInner(from, 1)
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
 * directly following it, e.g. all of `![a](a.png){width=50%}`.
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

  return { from: found.image.from, to: found.attribute?.to ?? found.image.to }
}

/**
 * Builds the changes that set the width of an image to a percentage. The
 * width is written as the Pandoc standard key `width` (which the exporters
 * and the PPTX renderer understand). An existing `width` or `w` key is
 * rewritten in place, keeping its spelling and quote style and removing
 * duplicates; otherwise `width=NN%` is appended. `height` and `h` keys are
 * removed so that the image scales proportionally. All other keys, the id,
 * and the classes stay as they are. Without attributes directly after the
 * image, `{width=NN%}` is inserted.
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
  const found = findImageAt(state, imageFrom)
  if (found === undefined) {
    return []
  }

  const width = `${Math.round(widthPercent)}%`
  const { image, attribute } = found
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
 * break, and no selection touches the attribute itself.
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
        if (!isRenderableImageNode(state, image) || rangeInSelection(state.selection, image.from, image.to, includeAdjacent)) {
          return
        }

        const attribute = adjacentAttribute(image)
        if (attribute === null || state.sliceDoc(attribute.from, attribute.to).includes('\n')) {
          return
        }

        if (rangeInSelection(state.selection, attribute.from, attribute.to, includeAdjacent)) {
          return
        }

        hidden.set(attribute.from, attribute.to)
      }
    })
  }

  return [...hidden.entries()]
    .map(([ attributeFrom, attributeTo ]) => ({ from: attributeFrom, to: attributeTo }))
    .sort((first, second) => first.from - second.from)
}
