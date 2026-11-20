/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        HeadingRenderer
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This renderer hides heading marks, analogously to the
 *                  emphasis renderer. The reason this is not integrated into
 *                  the emphasis renderer is because this renderer was always
 *                  controlled by a different setting; so keeping it separate
 *                  makes the logic predictable for the users.
 *
 * END HEADER
 */

import { type RangeSet, type Range } from '@codemirror/state'
import { shouldRevealSource, sourceRevealChanged } from '../util/reveal-selection'
import { syntaxTree } from '@codemirror/language'
import { Decoration, type DecorationSet, ViewPlugin, type ViewUpdate, type EditorView } from '@codemirror/view'

function hideHeadingMarks (view: EditorView): RangeSet<Decoration> {
  const ranges: Array<Range<Decoration>> = []
  const hiddenDeco = Decoration.replace({})

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from, to,
      enter (node) {
        // Global source editing preserves the heading's adjacent-cursor UX;
        // exception mode requires an actual cursor within the heading.
        if (shouldRevealSource(view.state, 'headings', node.from, node.to, true)) {
          return
        }

        if (!node.name.startsWith('ATXHeading') && !node.name.startsWith('SetextHeading')) {
          return
        }

        const mark = node.node.getChild('HeaderMark')
        if (mark === null) {
          return
        }

        const span = view.state.sliceDoc(mark.to, node.to)
        let offset = 0
        while (span.charAt(offset) === ' ') {
          offset++
        }
        ranges.push(hiddenDeco.range(mark.from, mark.to + offset))
        return false
      }
    })
  }

  return Decoration.set(ranges, true)
}

export const renderHeadings = ViewPlugin.fromClass(class {
  decorations: DecorationSet

  constructor (view: EditorView) {
    this.decorations = hideHeadingMarks(view)
  }

  update (update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged || update.selectionSet || sourceRevealChanged(update)) {
      this.decorations = hideHeadingMarks(update.view)
    }
  }
}, {
  decorations: v => v.decorations
})
