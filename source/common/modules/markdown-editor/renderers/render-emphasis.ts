/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Emphasis renderer
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     An emphasis renderer. NOTE that this renderer is DIFFERENT
 *                  from the others, in that it will only hide certain ranges.
 *
 * END HEADER
 */

import { syntaxTree } from '@codemirror/language'
import { type RangeSet, type Range, type EditorState } from '@codemirror/state'
import { type ViewUpdate, type EditorView, ViewPlugin, Decoration, type DecorationSet, WidgetType } from '@codemirror/view'
import { codeNodeCategory, shouldRevealSource, sourceRevealChanged } from '../util/reveal-selection'
import type { CodeEditingCategory } from '../util/code-editing-policy'
import { parsePdfCallout } from '../parser/admonition-parser'
import type { SyntaxNode } from '@lezer/common'
import { configField } from '../util/configuration'

class BulletWidget extends WidgetType {
  constructor (readonly node: SyntaxNode) {
    super()
  }

  eq (other: BulletWidget): boolean {
    return other.node.from === this.node.from && other.node.to === this.node.from
  }

  toDOM (_view: EditorView): HTMLElement {
    const elem = document.createElement('span')
    elem.innerHTML = '&bull;'
    elem.classList.add('rendered-bullet')
    return elem
  }
}

export class SpaceWidget extends WidgetType {
  constructor (readonly numChars: number, readonly node?: SyntaxNode) {
    super()
  }

  eq (other: SpaceWidget): boolean {
    if (this.node === undefined || other.node === undefined) {
      return false
    }

    return other.node.from === this.node.from && other.node.to === this.node.from
  }

  toDOM (_view: EditorView): HTMLElement {
    const elem = document.createElement('span')
    elem.innerHTML = '&nbsp;'.repeat(this.numChars)
    elem.classList.add('rendered-space')
    return elem
  }
}

/**
 * Characters that can open or close Markdown formatting inside a word, and
 * whose escape therefore has a visible effect even between word characters.
 */
const INTRAWORD_FORMATTING_CHARACTERS = '*_~=^[]`\\<>$|'

/**
 * Lets an escape whose backslash stays visible look like the text around it.
 */
const literalEscapeDeco = Decoration.mark({ class: 'cm-escape-literal' })

/**
 * Whether the backslash of an escape at `from` sits inside a word, as in the
 * Windows path `Python_Lib\.claude`. There, the escaped character has no
 * Markdown meaning, so hiding the backslash would only falsify the text.
 *
 * @param   {EditorView}  view  The editor view
 * @param   {number}      from  The position of the backslash
 *
 * @return  {boolean}           True if the backslash should stay visible
 */
function isBackslashInsideWord (view: EditorView, from: number): boolean {
  const before = view.state.sliceDoc(Math.max(0, from - 1), from)
  const escaped = view.state.sliceDoc(from + 1, from + 2)
  const after = view.state.sliceDoc(from + 2, from + 3)
  const wordCharacter = /[\p{L}\p{N}_]/u
  return wordCharacter.test(before) && wordCharacter.test(after) &&
    !INTRAWORD_FORMATTING_CHARACTERS.includes(escaped)
}

/**
 * Where a selection reveals the fences of a fenced code block, and whether
 * touching that range counts. The fences occupy lines of their own: a cursor
 * on either fence line counts as inside the block, also at the very start of
 * the opening fence or the very end of the closing fence. With
 * `previewModeShowSyntaxWhenCursorIsAdjacent`, a cursor at the end of the
 * line above the opening fence or at the start of the line below the closing
 * fence counts as adjacent. Only the global mode (`editCodeWhenClicked`)
 * counts touching or adjacent cursors at all (see `shouldRevealSource`), so
 * the exception mode keeps the block's own range. Diagrams and math blocks
 * keep their own range as well, since their widgets replace the whole node.
 *
 * @param   {EditorState}         state            The editor state
 * @param   {CodeEditingCategory} category         The category of the block
 * @param   {number}              from             The start of the block
 * @param   {number}              to               The end of the block
 * @param   {boolean}             includeAdjacent  The adjacency setting
 *
 * @return  {Object}                               The range to test and
 *                                                 whether touching it counts
 */
export function fencedCodeRevealRange (
  state: EditorState,
  category: CodeEditingCategory,
  from: number,
  to: number,
  includeAdjacent: boolean
): { from: number, to: number, includeAdjacent: boolean } {
  if (category !== 'codeBlocks' || state.field(configField, false)?.editCodeWhenClicked === false) {
    return { from, to, includeAdjacent }
  }
  if (!includeAdjacent) {
    return { from, to, includeAdjacent: true }
  }
  const firstLine = state.doc.lineAt(from)
  const lastLine = state.doc.lineAt(to)
  return {
    from: firstLine.number > 1 ? firstLine.from - 1 : from,
    to: lastLine.number < state.doc.lines ? lastLine.to + 1 : to,
    includeAdjacent: true
  }
}

function hideFormattingCharacters (view: EditorView): RangeSet<Decoration> {
  const ranges: Array<Range<Decoration>> = []
  const hiddenDeco = Decoration.replace({})
  const includeAdjacent = view.state.field(configField, false)?.previewModeShowSyntaxWhenCursorIsAdjacent ?? true

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter (node) {
        // Do not hide any characters if a selection is inside here
        let category: CodeEditingCategory = 'formatting'
        if (node.name === 'InlineCode' || node.name === 'FencedCode') {
          category = codeNodeCategory(view.state, node)
        } else if (node.name === 'ListItem') {
          category = 'lists'
        } else if (node.name === 'PandocSpan' || node.name === 'PandocDiv') {
          category = 'pandoc'
        } else if (node.name === 'Footnote' || node.name === 'FootnoteRefLabel') {
          category = 'citations'
        } else if (node.name === 'QuoteMark') {
          category = 'blockquotes'
        }
        const reveal = node.name === 'FencedCode'
          ? fencedCodeRevealRange(view.state, category, node.from, node.to, includeAdjacent)
          : { from: node.from, to: node.to, includeAdjacent }
        if (node.name !== 'QuoteMark' && shouldRevealSource(view.state, category, reveal.from, reveal.to, reveal.includeAdjacent)) {
          return
        }

        if (node.name === 'PandocAttribute') {
          return false // Do not hide the "CodeMarks" of Pandoc attributes
        }

        switch (node.name) {
          case 'Escape':
            // Only hide the actual backslash, and keep it where it is part of
            // a word such as the path `Python_Lib\.claude`
            if (!isBackslashInsideWord(view, node.from)) {
              ranges.push(hiddenDeco.range(node.from, node.from + 1))
            } else {
              ranges.push(literalEscapeDeco.range(node.from, node.to))
            }
            break
          // Hide various marks
          case 'Strikethrough': {
            const marks = node.node.getChildren('StrikethroughMark')
            for (const mark of marks) {
              ranges.push(hiddenDeco.range(mark.from, mark.to))
            }
            break
          }
          case 'StrongEmphasis':
          case 'Emphasis': {
            const marks = node.node.getChildren('EmphasisMark')
            for (const mark of marks) {
              ranges.push(hiddenDeco.range(mark.from, mark.to))
            }
            break
          }
          case 'HighlightContent': {
            const marks = node.node.getChildren('HighlightMark')
            for (const mark of marks) {
              ranges.push(hiddenDeco.range(mark.from, mark.to))
            }
            break
          }
          case 'InlineCode': {
            const marks = node.node.getChildren('CodeMark')
            for (const mark of marks) {
              ranges.push(hiddenDeco.range(mark.from, mark.to))
            }
            break
          }
          // For fenced code, also hide the CodeInfo
          case 'FencedCode': {
            const marks = node.node.getChildren('CodeMark')
            const infos = node.node.getChildren('CodeInfo')
            for (const mark of marks.concat(infos)) {
              ranges.push(hiddenDeco.range(mark.from, mark.to))
            }
            break
          }
          // For bracketed spans
          case 'PandocSpan': {
            const marks = node.node.getChildren('PandocSpanMark')
            const attrs = node.node.getChildren('PandocAttribute')
            for (const mark of marks.concat(attrs)) {
              ranges.push(hiddenDeco.range(mark.from, mark.to))
            }
            break
          }
          case 'PandocDiv': {
            const marks = node.node.getChildren('PandocDivMark')
            const information = node.node.getChildren('PandocDivInfo')
            const attributes = node.node.getChildren('PandocAttribute')
            for (const marker of marks.concat(information, attributes)) {
              ranges.push(hiddenDeco.range(marker.from, marker.to))
            }
            break
          }
          // Hide the square brackets of inline footnotes (keep footnote refs for
          // easier identification)
          case 'Footnote':
          case 'FootnoteRefLabel': {
            const isRef = node.name === 'FootnoteRefLabel'
            ranges.push(hiddenDeco.range(node.from, node.from + 2))
            ranges.push(hiddenDeco.range(node.to - (isRef ? 2 : 1), node.to))
            break
          }
          case 'QuoteMark': { // Blockquotes
            // Blockquotes can also be contained within blockquotes, so we try
            // to find the highest parent node. Otherwise, when the cursor is in a
            // parent, the quotemarks of the children will still be hidden. This
            // means that `> > >` would render as `> > [ ]` when the cursor is in
            // a parent block.
            let parent: SyntaxNode|null = node.node.parent
            let parentNode
            while (parent) {
              if (parent.name === 'Blockquote') {
                parentNode = parent.node
              }
              parent = parent.parent
            }

            // Only render QuoteMark if the parent does not contain a cursor.
            const quoteCategory = parentNode && parsePdfCallout(parentNode, view.state.doc) !== null ? 'admonitions' : 'blockquotes'
            if (parentNode && !shouldRevealSource(view.state, quoteCategory, parentNode.from, parentNode.to, includeAdjacent)) {
              // We want to also hide any trailing whitespace. Since quotemarks
              // can be followed by a max of 3 spaces, we grab three more characters
              // and test the resulting string
              const match = /^(\>[ ]{0,3})/.exec(view.state.sliceDoc(node.from, node.from + 3))
              ranges.push(hiddenDeco.range(node.from, match ? node.from + match[1].length : node.to ))
            }

            break
          }
          case 'ListItem': {
            if (node.node.parent?.name === 'OrderedList') {
              break // We only do this with bullet lists
            }
            const marks = node.node.getChildren('ListMark')
            for (const mark of marks) {
              ranges.push(Decoration.replace({ widget: new BulletWidget(mark.node) }).range(mark.from, mark.to))
            }
            break
          }
        }
      }
    })
  }

  return Decoration.set(ranges, true)
}

export const renderEmphasis = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  composing = false
  codeComposition = false

  constructor (view: EditorView) {
    this.decorations = hideFormattingCharacters(view)
  }

  update (update: ViewUpdate): void {
    const composing = update.view.compositionStarted
    if (composing && !this.composing) {
      // Chromium can compose in the closing CodeMark's text node, even with
      // an empty document selection after the code. Hiding that mark while
      // CodeMirror preserves the composition DOM can remove the code's other
      // text nodes; its next DOM diff then deletes that text from the document.
      const selection = update.startState.selection
      syntaxTree(update.startState).iterate({
        from: selection.ranges[0].from,
        to: selection.ranges[selection.ranges.length - 1].to,
        enter: node => {
          if ((node.name === 'InlineCode' || node.name === 'FencedCode') &&
            selection.ranges.some(range => range.from <= node.to && range.to >= node.from) &&
            [ 'inlineCode', 'codeBlocks' ].includes(codeNodeCategory(update.startState, node))) {
            this.codeComposition = true
            return false
          }
        }
      })
    }
    const compositionEnded = this.composing && !composing
    this.composing = composing
    if (composing && this.codeComposition) {
      // Keep the existing DOM boundaries until the native composition ends.
      // Mapping keeps source positions current without changing input ranges.
      this.decorations = this.decorations.map(update.changes)
      return
    }
    this.codeComposition = false
    // A freshly loaded state is parsed only up to its first few thousand
    // characters; the rest of the tree arrives later from the background
    // parser, in transactions that change neither the document, the viewport
    // nor the selection. Without rebuilding then, the marks in the part
    // parsed afterwards (e.g., the fences of a code block further down) stay
    // visible until the next click.
    if (compositionEnded || update.docChanged || update.viewportChanged || update.selectionSet || sourceRevealChanged(update) ||
      syntaxTree(update.startState) !== syntaxTree(update.state)) {
      this.decorations = hideFormattingCharacters(update.view)
    }
  }
}, {
  decorations: v => v.decorations
})
