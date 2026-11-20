/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        renderBlockquotes
 * CVM-Role:        View
 * Maintainer:      Bennie Milburn
 * License:         GNU GPL v3
 *
 * Description:     This renderer adds a vertical bar
 *                  to the left edge of blockquotes
 *
 * END HEADER
 */

import { syntaxTree } from '@codemirror/language'
import type { Range, RangeSet } from '@codemirror/state'
import { BlockWrapper, Decoration, EditorView, ViewPlugin, WidgetType, type ViewUpdate } from '@codemirror/view'
import { shouldRevealSource, sourceRevealChanged } from '../util/reveal-selection'
import type { SyntaxNode } from '@lezer/common'
import { configField } from '../util/configuration'
import { trans } from 'source/common/i18n-renderer'
import { validAdmonitionKeywords } from '../parser/admonition-parser'
// Zettlr-LYH (R60): PDF++ callouts
import type { EditorState } from '@codemirror/state'
import { parsePdfCallout, type PdfCallout } from '../parser/admonition-parser'

class AdmonitionTitleWidget extends WidgetType {
  constructor (private readonly title: string) {
    super()
  }

  toDOM () {
    const span = document.createElement('span')
    span.className = 'cm-admonition-title'
    span.textContent = this.title
    return span
  }

  ignoreEvent () {
    return true
  }
}

const hiddenDeco = Decoration.replace({})

// Zettlr-LYH (R60): display of PDF++ callouts (see parsePdfCallout). They keep
// the look of a blockquote, but the bar takes the callout's color, and the
// `[!PDF|<color>]` marker is hidden unless a selection touches the first line.
// The first line's link stays an ordinary, clickable link.

/**
 * Bar colors of the named PDF++ colors. The highlight colors themselves
 * (PDF_HIGHLIGHT_COLORS: #f8efc9, #ffd1d1, #d6e4f5, #e9d3f3) are too pale for
 * a bar, so every name gets a darker shade of the same hue, with a contrast of
 * at least 3:1 against both a white and a near-black background.
 */
export const PDF_CALLOUT_BAR_COLORS: Record<string, string> = {
  yellow: '#b38b00',
  red: '#d64545',
  note: '#3d7fd1',
  important: '#a052c8'
}

/**
 * Bar color of callouts whose color name is not in PDF_CALLOUT_BAR_COLORS
 * (amber)
 */
export const PDF_CALLOUT_UNKNOWN_BAR_COLOR = '#c98000'

const PDF_CALLOUT_UNKNOWN_COLOR_CLASS = 'pdf-callout-unknown'

/**
 * Returns the CSS class of a callout color. Only the known names get a class
 * of their own, so that no text from the document ever becomes a class name.
 *
 * @param   {string}  color  The lowercase color name
 *
 * @return  {string}         The class name
 */
export function pdfCalloutColorClass (color: string): string {
  return Object.prototype.hasOwnProperty.call(PDF_CALLOUT_BAR_COLORS, color)
    ? `pdf-callout-${color}`
    : PDF_CALLOUT_UNKNOWN_COLOR_CLASS
}

/**
 * Lists every color class of PDF++ callouts together with its bar color
 *
 * @return  {Array<[string, string]>}  Pairs of class name and bar color
 */
export function pdfCalloutBarColorsByClass (): Array<[string, string]> {
  const pairs: Array<[string, string]> = Object.entries(PDF_CALLOUT_BAR_COLORS)
    .map(([ color, barColor ]): [string, string] => [ pdfCalloutColorClass(color), barColor ])
  pairs.push([ PDF_CALLOUT_UNKNOWN_COLOR_CLASS, PDF_CALLOUT_UNKNOWN_BAR_COLOR ])
  return pairs
}

/**
 * How a PDF++ callout is displayed in preview mode
 */
export interface PdfCalloutDisplay {
  callout: PdfCallout
  /**
   * Whether the callout needs a bar wrapper of its own. It does not while the
   * blockquote renderer wraps it, because the bar of that wrapper then takes
   * the callout's color via CSS. This way, two bars never show at once.
   */
  needsOwnWrapper: boolean
  /**
   * Whether the `[!PDF|<color>]` marker (and the whitespace after it) is
   * hidden, which is the case unless a selection touches the first line
   */
  hideMarker: boolean
}

/**
 * Determines how a syntax node is displayed if it is a PDF++ callout
 *
 * @param   {EditorState}               state  The editor state
 * @param   {SyntaxNode}                node   Any syntax node
 *
 * @return  {PdfCalloutDisplay|null}           Null if the node is no callout
 */
export function getPdfCalloutDisplay (state: EditorState, node: SyntaxNode): PdfCalloutDisplay|null {
  const callout = parsePdfCallout(node, state.doc)
  if (callout === null) {
    return null
  }

  const config = state.field(configField, false)
  const includeAdjacent = config?.previewModeShowSyntaxWhenCursorIsAdjacent ?? true

  // This mirrors render-blockquotes.ts: the blockquote renderer is active in
  // preview mode together with renderEmphasis, and it wraps a blockquote
  // unless a selection touches the outermost blockquote around it.
  let outermostBlockquote = node
  for (let parent = node.parent; parent !== null; parent = parent.parent) {
    if (parent.name === 'Blockquote') {
      outermostBlockquote = parent
    }
  }
  const wrappedByBlockquoteRenderer = (config?.renderEmphasis ?? true) &&
    !shouldRevealSource(state, parsePdfCallout(outermostBlockquote, state.doc) !== null ? 'admonitions' : 'blockquotes', outermostBlockquote.from, outermostBlockquote.to, includeAdjacent)

  return {
    callout,
    needsOwnWrapper: !wrappedByBlockquoteRenderer,
    hideMarker: !shouldRevealSource(state, 'admonitions',
      config?.editCodeWhenClicked === false ? callout.from : callout.headerLineFrom,
      config?.editCodeWhenClicked === false ? callout.to : callout.headerLineTo, true)
  }
}

/**
 * Adds the wrapper and the decorations that display a PDF++ callout
 *
 * @param   {PdfCalloutDisplay}     display        How to display the callout
 * @param   {Range<BlockWrapper>[]} wrapperRanges  Receives the wrapper
 * @param   {Range<Decoration>[]}   inlineRanges   Receives the decorations
 */
function addPdfCalloutDecorations (
  display: PdfCalloutDisplay,
  wrapperRanges: Range<BlockWrapper>[],
  inlineRanges: Range<Decoration>[]
): void {
  const { callout } = display
  const colorClass = pdfCalloutColorClass(callout.color)

  // The classes on the first line let the theme color the bar of the
  // blockquote wrapper around it
  inlineRanges.push(
    Decoration.line({ class: `pdf-callout-header ${colorClass}` }).range(callout.headerLineFrom)
  )

  if (display.hideMarker) {
    inlineRanges.push(hiddenDeco.range(callout.markerFrom, callout.markerSpaceTo))
  }

  if (display.needsOwnWrapper) {
    const wrapper = BlockWrapper.create({
      tagName: 'pdf-callout-wrapper',
      attributes: { class: `pdf-callout-wrapper ${colorClass}` }
    })
    wrapperRanges.push(wrapper.range(callout.headerLineFrom, callout.to))
  }
}

/**
 * Theme rules that color the bars of PDF++ callouts, both of their own
 * wrapper and of a blockquote wrapper whose first line is a callout's
 *
 * @return  {Record<string, { borderLeftColor: string }>}  The rules
 */
function pdfCalloutBarRules (): Record<string, { borderLeftColor: string }> {
  const rules: Record<string, { borderLeftColor: string }> = {}
  for (const [ colorClass, barColor ] of pdfCalloutBarColorsByClass()) {
    rules[`.pdf-callout-wrapper.${colorClass}`] = { borderLeftColor: barColor }
    rules[`.blockquote-wrapper:has(> .pdf-callout-header.${colorClass})`] = { borderLeftColor: barColor }
  }
  return rules
}

function renderAdmonitionWrappers (view: EditorView): { wrappers: RangeSet<BlockWrapper>, inlines: RangeSet<Decoration> } {
  const wrapperRanges: Range<BlockWrapper>[] = []
  const inlineRanges: Range<Decoration>[] = []
  const includeAdjacent = view.state.field(configField, false)?.previewModeShowSyntaxWhenCursorIsAdjacent ?? true

  const tree = syntaxTree(view.state)
  // Zettlr-LYH (R60): several visible ranges can enter the same node, because
  // every replaced range of at least 20 characters (a rendered formula, for
  // instance) splits the visible ranges. Each callout and each admonition is
  // therefore handled only once; otherwise as many identical wrappers would be
  // nested into each other as there are visible ranges touching the block.
  const pdfCalloutStarts = new Set<number>()
  const handledAdmonitions = new Set<string>()
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from, to,
      enter: (node) => {
        // Zettlr-LYH (R60): PDF++ callouts are Blockquote nodes
        if (node.type.is('Blockquote')) {
          const display = pdfCalloutStarts.has(node.from) ? null : getPdfCalloutDisplay(view.state, node.node)
          if (display !== null) {
            pdfCalloutStarts.add(node.from)
            addPdfCalloutDecorations(display, wrapperRanges, inlineRanges)
          }
          return
        }

        if (!node.type.is('Admonition')) {
          return
        }

        const nodeKey = `${node.from}:${node.to}`
        if (handledAdmonitions.has(nodeKey)) {
          return
        }
        handledAdmonitions.add(nodeKey)

        if (shouldRevealSource(view.state, 'admonitions', node.from, node.to, includeAdjacent)) {
          return
        }

        const keywordMarker = node.node.getChild('AdmonitionKeyword')
        if (keywordMarker === null) {
          return
        }

        const keyword = view.state.sliceDoc(keywordMarker.from, keywordMarker.to).toLowerCase()

        if (!validAdmonitionKeywords.includes(keyword)) {
          return
        }

        let parent: SyntaxNode|null = node.node.parent
        let parentNode

        while (parent) {
          if (parent.name === 'Admonition') {
            parentNode = parent.node
          }
          parent = parent.parent
        }

        if (parentNode && shouldRevealSource(view.state, 'admonitions', parentNode.from, parentNode.to, includeAdjacent)) {
          return
        }

        const genericKeywordTranslated = {
          note: trans('Note'),
          tip: trans('Tip'),
          important: trans('Important'),
          warning: trans('Warning'),
          caution: trans('Caution')
        }[keyword] ?? trans('Note')

        // Then, we may have a custom title in the AdmonitionTitle element.
        const titleMarker = node.node.getChild('AdmonitionTitle')

        // Hide title marker, keyword marker, and the quote and code marks
        if (titleMarker !== null) {
          // We have a custom title -> hide the keyword entirely
          const widget = new AdmonitionTitleWidget(view.state.sliceDoc(titleMarker.from, titleMarker.to))
          inlineRanges.push(
            Decoration
              .replace({ widget })
              .range(keywordMarker.from, titleMarker.to)
          )
        } else {
          // We need a generic widget with the keyword
          const widget = new AdmonitionTitleWidget(genericKeywordTranslated)
          inlineRanges.push(
            Decoration
              .replace({ widget })
              .range(keywordMarker.from, keywordMarker.to)
          )
        }

        for (const qm of node.node.getChildren('QuoteMark')) {
          inlineRanges.push(hiddenDeco.range(qm.from, qm.to))
        }
        for (const cm of node.node.getChildren('AdmonitionMark')) {
          inlineRanges.push(hiddenDeco.range(cm.from, cm.to))
        }

        const line = view.state.doc.lineAt(node.from)
        const wrapper = BlockWrapper.create({
          tagName: 'admonition-wrapper',
          attributes: {
            class: [ 'admonition-wrapper', keyword ].join(' '),
          }
        })

        wrapperRanges.push(wrapper.range(line.from, node.to))
      },
    })
  }

  return {
    wrappers: BlockWrapper.set(wrapperRanges, true),
    inlines: Decoration.set(inlineRanges, true)
  }
}

const admonitionPlugin = ViewPlugin.fromClass(class {
  blockWrappers: RangeSet<BlockWrapper>
  inlines: RangeSet<Decoration>

  constructor (view: EditorView) {
    const { wrappers, inlines } = renderAdmonitionWrappers(view)
    this.blockWrappers = wrappers
    this.inlines = inlines
  }

  update (update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged || update.selectionSet || sourceRevealChanged(update)) {
      const { wrappers, inlines } = renderAdmonitionWrappers(update.view)
      this.blockWrappers = wrappers
      this.inlines = inlines
    }
  }

}, {
  provide: plugin => {
    return [
      EditorView.blockWrappers.of(view => view.plugin(plugin)?.blockWrappers ?? BlockWrapper.set([])),
      EditorView.decorations.of(view => view.plugin(plugin)?.inlines ?? Decoration.none)
    ]
  }
})

export const renderAdmonitions = [
  admonitionPlugin,
  EditorView.baseTheme({
    '.admonition-wrapper': {
      display: 'block',
      borderRadius: '8px',
      padding: '0.5em',
      marginLeft: '0.25em',
      border: '1px solid transparent'
    },
    '.admonition-wrapper .cm-line': {
      // We need to revert these stylings set by the
      // visual-indent plugin since they conflict with
      // the padding set by the wrapper.
      paddingLeft: 'revert !important',
      textIndent: 'revert !important'
    },
    '.admonition-wrapper.note': {
      backgroundColor: 'var(--zettlr-note-bg)',
      borderColor: 'var(--zettlr-note-color)',
      color: 'var(--zettlr-note-color)',
    },
    '.admonition-wrapper.tip': {
      backgroundColor: 'var(--zettlr-tip-bg)',
      borderColor: 'var(--zettlr-tip-color)',
      color: 'var(--zettlr-tip-color)',
    },
    '.admonition-wrapper.important': {
      backgroundColor: 'var(--zettlr-important-bg)',
      borderColor: 'var(--zettlr-important-color)',
      color: 'var(--zettlr-important-color)',
    },
    '.admonition-wrapper.warning': {
      backgroundColor: 'var(--zettlr-warning-bg)',
      borderColor: 'var(--zettlr-warning-color)',
      color: 'var(--zettlr-warning-color)',
    },
    '.admonition-wrapper.caution': {
      backgroundColor: 'var(--zettlr-caution-bg)',
      borderColor: 'var(--zettlr-caution-color)',
      color: 'var(--zettlr-caution-color)',
    },
    // Zettlr-LYH (R60): own wrapper of PDF++ callouts, shaped like the
    // blockquote wrapper (render-blockquotes.ts) it stands in for
    '.pdf-callout-wrapper': {
      display: 'block',
      borderLeft: 'solid 0.25em',
      paddingLeft: '0.5em',
      marginLeft: '0.25em'
    },
    ...pdfCalloutBarRules()
  })
]
