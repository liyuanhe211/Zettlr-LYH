/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Visual indentation plugin
 * CVM-Role:        ViewPlugin
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This plugin ensures that lines in soft-wrapped editors are
 *                  visually correctly indented. It additionally ensures that
 *                  lists, etc. are correctly indented so that the list marker
 *                  is placed outside of the text block.
 *
 * END HEADER
 */

import { syntaxTree, foldedRanges } from '@codemirror/language'
import { RangeSet, type Range } from '@codemirror/state'
import {
  Decoration,
  MatchDecorator,
  ViewPlugin,
  type EditorView,
  type ViewUpdate
} from '@codemirror/view'
import { SpaceWidget } from '../renderers/render-emphasis'

// Each `.cm-line` has a padding of `0 2px 0 6px` as per CodeMirror's
// base styles from somewhere in the library. We need to account for that
// not to induce any problems when adjusting the indentation
const BASE_PADDING = 6

/**
 * Measure a formatting prefix at its natural width. The editor justifies
 * Markdown lines, which can stretch the space after a list marker across most
 * of a wrapped line. Existing hanging-indent styles must be removed during
 * this measurement too, or each update would measure its own previous indent.
 */
export function measureNaturalVisualIndent (view: EditorView, lineFrom: number, contentStart: number): number|undefined {
  const position = view.domAtPos(lineFrom)
  const element = position.node instanceof HTMLElement ? position.node : position.node.parentElement
  const lineElement = element?.closest<HTMLElement>('.cm-line')
  if (lineElement === undefined || lineElement === null) {
    return undefined
  }

  const style = lineElement.style
  const properties = [ 'text-align', 'text-indent', 'padding-left' ] as const
  const original = properties.map(property => ({
    property,
    value: style.getPropertyValue(property),
    priority: style.getPropertyPriority(property)
  }))
  try {
    style.setProperty('text-align', 'left')
    style.setProperty('text-indent', '0px')
    style.setProperty('padding-left', `${BASE_PADDING}px`)
    const base = view.contentDOM.getBoundingClientRect().left
    const after = view.coordsAtPos(contentStart)?.left
    return after === undefined ? undefined : after - base
  } finally {
    for (const { property, value, priority } of original) {
      if (value === '') {
        style.removeProperty(property)
      } else {
        style.setProperty(property, value, priority)
      }
    }
  }
}

// These regexes are used to determine indentation level
// Leading whitespace characters
const WHITESPACE_RE = /^([ \t]+)/

// List and task marker formatting characters
const LISTMARK_RE = /^(\s*(?:[+*-](?:\s\[[x\s]\])?|\d+\.)\s)/

// Blockquote formatting characters
const QUOTEMARK_RE = /^((?:[ ]{0,3}\>)+[ ]?)/

// Since tab characters have no fixed width in the editor,
// we need to render every tab with the equivalent number of space
// characters to prevent jumping in the editor.
// The jumping is caused by the tab character recalculating its
// width as the line indentation is changed.
const tabReplaceDeco = new MatchDecorator({
  regexp: /\t/g,
  boundary: /[^\t]/g,
  decoration: (_match, view, _pos) => Decoration.replace({ widget: new SpaceWidget(view.state.tabSize) })
})

// Keeps the formatting prefix of a line (list marker, task checkbox and the
// whitespace around them) at its natural width in justified text.
const fixedWidthPrefixDeco = Decoration.mark({
  attributes: { style: 'display: inline-block; white-space: pre; text-indent: 0; text-align: left;' }
})

function render (view: EditorView, measurements?: Map<string, number>): RangeSet<Decoration> {
  const ranges: Array<Range<Decoration>> = []

  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to;) {
      const line = view.state.doc.lineAt(pos)
      pos = line.to + 1

      const node = syntaxTree(view.state).resolve(line.from, 1)
      if (node.name === 'CodeText' && node.parent?.name !== 'IndentedCode') {
        continue
      }

      // Determine the indentation based on any preceding formatting marks
      // for lists, tasks, or blockquotes, or any leading whitespace. The
      // LISTMARK_RE and QUOTEMARK_RE include preceding whitespace.
      const match = LISTMARK_RE.exec(line.text) ?? QUOTEMARK_RE.exec(line.text) ?? WHITESPACE_RE.exec(line.text)
      if (match === null) {
        continue // There was no indentation on the line
      }

      // Get the position of the first non-formatting, non-whitespace character
      const columnLineTextStart = match[1].length

      // Now that we know we need to indent this line, schedule a measurement so
      // that in the next round of this code running we have an accurate
      // indentation even for non-monospaced text. What we want to measure is
      // exclusively what we are basing our indentation on. If we use the entire
      // line as a key, we cause (a) duplicated measurements (`* One` and `* Two`
      // require the same indentation) and (b) cause cache misses which results in
      // jumpy behavior when the user adds novel characters to the line.
      const measurementKey = line.text.slice(0, columnLineTextStart).replace('\t', ' '.repeat(view.state.tabSize))

      view.requestMeasure({
        read (view) {
          const pos = line.from + columnLineTextStart

          // Skip drawing indentations if the line is within a
          // folded region because it causes visual glitches
          // and layout issues.
          const folded = foldedRanges(view.state).iter(pos)
          while (folded.value) {
            if (pos >= folded.from && pos <= folded.to) {
              return
            }
            folded.next()
          }

          const naturalIndent = measureNaturalVisualIndent(view, line.from, pos)
          if (naturalIndent === undefined) {
            return // Could not retrieve coordinates
          }
          // Note that this continuously updates our measurements after any layout
          // changes
          measurements?.set(measurementKey, naturalIndent)
        },
        key: measurementKey
      })

      const indent = measurements?.get(measurementKey)
      if (indent !== undefined) {
        const deco = Decoration.line({ attributes: { style: `text-indent: -${indent-BASE_PADDING}px; padding-left: ${indent}px;` } })
        ranges.push(deco.range(line.from))
      }

      // The editor justifies Markdown lines, which stretches every space on a
      // wrapped line, including the ones between a list marker, a task
      // checkbox and the first word. The first word would then no longer be
      // aligned with the continuation lines, which start at the natural
      // width of this prefix. An inline-block is atomic for justification,
      // so the prefix keeps its natural width. It must not inherit the
      // hanging indent of the line.
      if (columnLineTextStart >= line.text.length) {
        continue
      }
      if (QUOTEMARK_RE.test(line.text) && LISTMARK_RE.exec(line.text) === null) {
        continue // Blockquote lines are laid out by the blockquote renderer
      }
      ranges.push(fixedWidthPrefixDeco.range(line.from, line.from + columnLineTextStart))
    }

  }

  return Decoration.set(ranges, true)
}

export const softwrapVisualIndent = ViewPlugin.define(view => ({
  decorations: render(view),
  tabDecorations: tabReplaceDeco.createDeco(view),
  // This is an additional property, required to ensure that each editor
  // instance has its own map, preventing any potential interference.
  measurements: new Map<string, number>(),

  update (u: ViewUpdate) {
    this.decorations = render(u.view, this.measurements)
    this.tabDecorations = tabReplaceDeco.updateDeco(u, this.tabDecorations)
  }
}), {
  decorations (value) {
    return RangeSet.join([ value.decorations, value.tabDecorations ])
  }

})
