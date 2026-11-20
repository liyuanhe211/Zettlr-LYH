/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Inline code wrap plugin
 * CVM-Role:        View
 * License:         GNU GPL v3
 *
 * Description:     Lets inline code wrap at any character, wherever the line
 *                  runs out of room, regardless of words, hyphens, or slashes.
 *                  Otherwise the browser moves a long unbreakable piece of
 *                  code such as a file path to the next line, and the
 *                  justified alignment of Markdown text fills the gap it
 *                  leaves with wide spaces.
 *
 * END HEADER
 */

import { syntaxTree } from '@codemirror/language'
import { Prec, type Range } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'

const inlineCodeWrapDecoration = Decoration.mark({ class: 'cm-inline-code-wrap' })

/**
 * Marks every backtick delimited inline code within the visible ranges.
 *
 * @param   {EditorView}     view  The editor view
 *
 * @return  {DecorationSet}        The decorations
 */
function buildInlineCodeWrap (view: EditorView): DecorationSet {
  const ranges: Array<Range<Decoration>> = []

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== 'InlineCode') {
          return
        }

        // The math parser emits InlineCode nodes as well; only backtick
        // delimited code is meant here.
        if (node.from < node.to && view.state.sliceDoc(node.from, node.from + 1) === '`') {
          ranges.push(inlineCodeWrapDecoration.range(node.from, node.to))
        }

        return false
      }
    })
  }

  return Decoration.set(ranges, true)
}

const inlineCodeWrapPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet

  constructor (view: EditorView) {
    this.decorations = buildInlineCodeWrap(view)
  }

  update (update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = buildInlineCodeWrap(update.view)
    }
  }
}, { decorations: value => value.decorations })

export const inlineCodeWrap = [
  // Lowest precedence makes the mark the outermost DOM node, so that it covers
  // the whole inline code even where other marks split it into pieces.
  Prec.lowest(inlineCodeWrapPlugin),
  EditorView.baseTheme({
    '.cm-inline-code-wrap': {
      wordBreak: 'break-all',
      overflowWrap: 'anywhere'
    }
  })
]
