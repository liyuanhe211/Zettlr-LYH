/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Code syntax renderer
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Apply syntax highlighting to code elements
 *
 * END HEADER
 */

import type { Range, RangeSet } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { codeBlockCopy } from '../plugins/code-block-copy'

const codeDecorator = Decoration.mark({ class: 'code' })
// Inline code gets an additional class so visible source delimiters can share
// the code's styling while source editing is active.
const inlineCodeDecorator = Decoration.mark({ class: 'code inline-code' })

function getCodeHighlighter (view: EditorView): RangeSet<Decoration> {
  const ranges: Range<Decoration>[] = []
  const seen = new Set<string>()

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        // CodeText contains a single node that has all the code's contents
        if ([ 'CodeText', 'InlineCode' ].includes(node.name) && node.from < node.to) {
          const key = `${node.name}:${node.from}:${node.to}`
          if (seen.has(key)) {
            return false
          }
          seen.add(key)
          const decorator = node.name === 'InlineCode' ? inlineCodeDecorator : codeDecorator
          ranges.push(decorator.range(node.from, node.to))
          return false
        }
      }
    })
  }

  return Decoration.set(ranges, true)
}

const renderCodePlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet

  constructor (view: EditorView) {
    this.decorations = getCodeHighlighter(view)
  }

  update (update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
      this.decorations = getCodeHighlighter(update.view)
    }
  }
}, {
  decorations: v => v.decorations
})

export const renderCode = [
  renderCodePlugin,
  codeBlockCopy,
]
