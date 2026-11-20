/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Admonition Raw Parser
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This is the work of @benniekiss here:
 *                  https://github.com/Zettlr/Zettlr/pull/6497#issuecomment-5543045356
 *
 * END HEADER
 */

import { syntaxTree } from '@codemirror/language'
import { sourceRevealChanged } from '../util/reveal-selection'
import type { RangeSet, Range } from '@codemirror/state'
import { EditorView, Decoration, ViewPlugin, type ViewUpdate } from '@codemirror/view'
// Zettlr-LYH (R60): PDF++ callouts
import { parsePdfCallout } from '../parser/admonition-parser'
import { pdfCalloutBarColorsByClass, pdfCalloutColorClass } from '../renderers/render-admonitions'

/**
 * Zettlr-LYH (R60): theme rules that give the `[!PDF|<color>]` marker of PDF++
 * callouts the color that their bar has in preview mode
 *
 * @return  {Record<string, { color: string }>}  The rules
 */
function pdfCalloutMarkRules (): Record<string, { color: string }> {
  const rules: Record<string, { color: string }> = {}
  for (const [ colorClass, barColor ] of pdfCalloutBarColorsByClass()) {
    rules[`.cm-pdf-callout-mark.${colorClass}`] = { color: barColor }
    // The marker is highlighted as a link as well, so its inner spans need
    // the color, too
    rules[`.cm-pdf-callout-mark.${colorClass} *`] = { color: barColor }
  }
  return rules
}

function renderAdmonitionRaw (view: EditorView): RangeSet<Decoration> {
  const inlineRanges: Range<Decoration>[] = []

  const tree = syntaxTree(view.state)
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        // Zettlr-LYH (R60): PDF++ callouts are Blockquote nodes; color their
        // marker
        if (node.type.is('Blockquote')) {
          const callout = parsePdfCallout(node.node, view.state.doc)
          if (callout !== null) {
            const markerDeco = Decoration.mark({
              class: `cm-pdf-callout-mark ${pdfCalloutColorClass(callout.color)}`
            })
            inlineRanges.push(markerDeco.range(callout.markerFrom, callout.markerTo))
          }
          return
        }

        if (!node.type.is('Admonition')) {
          return
        }

        const keywordNode = node.node.getChild('AdmonitionKeyword')
        if (keywordNode === null) {
          return false
        }

        const deco = Decoration.mark({
          class: view.state.sliceDoc(keywordNode.from, keywordNode.to).toLowerCase(),
        })
        inlineRanges.push(deco.range(node.from, node.to))
      },
    })
  }

  return Decoration.set(inlineRanges, true)
}

const admonitionRawPlugin = ViewPlugin.fromClass(
  class {
    inlines: RangeSet<Decoration>

    constructor (view: EditorView) {
      this.inlines = renderAdmonitionRaw(view)
    }

    update (update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || update.selectionSet || sourceRevealChanged(update)) {
        this.inlines = renderAdmonitionRaw(update.view)
      }
    }
  },
  {
    provide: (plugin) => {
      return [
        EditorView.decorations.of(
          (view) => view.plugin(plugin)?.inlines ?? Decoration.none,
        ),
      ]
    },
  },
)

export const renderRawAdmonitions = [
  admonitionRawPlugin,
  EditorView.baseTheme({
  // Admonitions
    '.note > :is(.cm-admonition-mark, .cm-admonition-keyword, .cm-code-mark)': { color: 'var(--zettlr-note-color)' },
    '.tip > :is(.cm-admonition-mark, .cm-admonition-keyword, .cm-code-mark)': { color: 'var(--zettlr-tip-color)' },
    '.important > :is(.cm-admonition-mark, .cm-admonition-keyword, .cm-code-mark)': { color: 'var(--zettlr-important-color)' },
    '.warning > :is(.cm-admonition-mark, .cm-admonition-keyword, .cm-code-mark)': { color: 'var(--zettlr-warning-color)' },
    '.caution > :is(.cm-admonition-mark, .cm-admonition-keyword, .cm-code-mark)': { color: 'var(--zettlr-caution-color)' },
    // Zettlr-LYH (R60): PDF++ callouts
    ...pdfCalloutMarkRules()
  }),
]
