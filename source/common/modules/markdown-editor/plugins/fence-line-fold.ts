/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        fenceLineFold
 * CVM-Role:        CodeMirror Extension
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     In the preview rendering mode, folds the opening and the
 *                  closing fence line of a fenced code block to zero height
 *                  while neither the cursor nor the selection is inside the
 *                  block (requirement R165, specification C6). The emphasis
 *                  renderer already hides the fence marks and the language of
 *                  such a block (requirement R130), but the fence lines
 *                  themselves kept their height, so every block carried an empty
 *                  line above and below it, and two neighboring blocks were
 *                  separated by three blank lines. A folded line is replaced as
 *                  a whole by a block decoration, so the editor draws no line
 *                  element for it and the neighboring lines touch. The document
 *                  text is never changed.
 *
 *                  The decision is the one the emphasis renderer takes for the
 *                  fence marks, made by the same functions: it unfolds when
 *                  `shouldRevealSource` says that the source of the block is to
 *                  be shown (cursor or selection in the block, adjacent cursor
 *                  with `previewModeShowSyntaxWhenCursorIsAdjacent`, raw mode,
 *                  typed marks), so this module reads no selection itself.
 *
 *                  CodeMirror lets only decoration sets that a state field
 *                  provides directly affect the vertical layout; a view plugin
 *                  such as the emphasis renderer throws as soon as it provides a
 *                  block decoration. Hence this separate state field. A state
 *                  field cannot see the viewport, so it covers every fenced code
 *                  block of the document. It is registered together with the
 *                  emphasis renderer (see `renderers/index.ts`).
 *
 *                  Not folded: blocks without any code text (otherwise the
 *                  whole block would disappear), diagrams and math blocks (their
 *                  own renderers replace the whole block), and fence lines that
 *                  carry anything but the fence itself, white space and block
 *                  quote marks in front of it (such as `- ```js`, where the
 *                  list mark would vanish with the line). An unclosed block only
 *                  folds its opening line.
 *
 * END HEADER
 */

import { syntaxTree } from '@codemirror/language'
import { StateField, type EditorState, type Range, type Transaction } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import type { SyntaxNodeRef } from '@lezer/common'
import { configField } from '../util/configuration'
import { codeNodeCategory, shouldRevealSource } from '../util/reveal-selection'
import { fencedCodeRevealRange } from '../renderers/render-emphasis'

/**
 * Replaces a line as a whole by nothing, as a block. The line break behind the
 * line stays in the document, but without a line to end it draws no element.
 */
const foldedLine = Decoration.replace({ block: true })

/**
 * Only white space and block quote marks may precede the fence on its line;
 * anything else (e.g., a list mark) would be folded away together with the line.
 */
const ALLOWED_BEFORE_FENCE = /^[\s>]*$/

/**
 * Returns the decoration that folds the line of a fence mark, or undefined if
 * the line carries more than the fence.
 *
 * @param   {EditorState}   state  The editor state
 * @param   {SyntaxNodeRef} mark   The `CodeMark` node of the fence
 *
 * @return  {Range<Decoration>|undefined}  The decoration of the whole line
 */
function foldFenceLine (state: EditorState, mark: SyntaxNodeRef): Range<Decoration>|undefined {
  const line = state.doc.lineAt(mark.from)
  // A replaced range must not be empty, and a line with a fence never is
  if (line.from >= line.to || !ALLOWED_BEFORE_FENCE.test(state.sliceDoc(line.from, mark.from))) {
    return undefined
  }
  return foldedLine.range(line.from, line.to)
}

/**
 * Computes the folds of all fenced code blocks that do not show their source.
 *
 * @param   {EditorState}    state  The editor state
 *
 * @return  {DecorationSet}         The decorations of the folded fence lines
 */
function foldFenceLines (state: EditorState): DecorationSet {
  const includeAdjacent = state.field(configField, false)?.previewModeShowSyntaxWhenCursorIsAdjacent ?? true
  const ranges: Array<Range<Decoration>> = []

  syntaxTree(state).iterate({
    enter (node) {
      // Fenced code is a block: it sits in the document or in a container, never in a paragraph
      if (node.name === 'Paragraph') {
        return false
      }
      if (node.name !== 'FencedCode') {
        return
      }

      const block = node.node
      // The decision for all fence parts of this node is made here, below no node is entered
      if (codeNodeCategory(state, node) === 'codeBlocks' && block.getChildren('CodeText').some(text => text.from < text.to)) {
        const reveal = fencedCodeRevealRange(state, 'codeBlocks', node.from, node.to, includeAdjacent)
        if (!shouldRevealSource(state, 'codeBlocks', reveal.from, reveal.to, reveal.includeAdjacent)) {
          for (const mark of block.getChildren('CodeMark')) {
            const fold = foldFenceLine(state, mark)
            if (fold !== undefined) {
              ranges.push(fold)
            }
          }
        }
      }
      return false
    }
  })

  return Decoration.set(ranges, true)
}

/**
 * Whether the folds can differ from the ones before the transaction: when the
 * document, the selection, the configuration or the syntax tree (which the
 * background parser extends without any other change) changed, or when the
 * transaction carries effects (which freeze the reveal selection while the
 * mouse button is held down, release it again, and update the configuration).
 * Everything the reveal decision reads from the state changes through one of
 * these.
 *
 * @param   {Transaction}  transaction  The transaction
 *
 * @return  {boolean}                   True if the folds have to be recomputed
 */
function foldsMayChange (transaction: Transaction): boolean {
  return transaction.docChanged ||
    transaction.selection !== undefined ||
    transaction.effects.length > 0 ||
    syntaxTree(transaction.state) !== syntaxTree(transaction.startState) ||
    transaction.state.field(configField, false) !== transaction.startState.field(configField, false)
}

/**
 * The folds of the opening and closing fence lines of the fenced code blocks
 * whose source is not shown. Provided directly to the editor, since only such
 * decoration sets may influence the vertical layout.
 */
export const fenceLineFold = StateField.define<DecorationSet>({
  create (state) {
    return foldFenceLines(state)
  },
  update (value, transaction) {
    return foldsMayChange(transaction) ? foldFenceLines(transaction.state) : value
  },
  provide: field => EditorView.decorations.from(field)
})
