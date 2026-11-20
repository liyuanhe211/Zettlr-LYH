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
import { Prec, type Range, type RangeSet, type Text } from '@codemirror/state'
import { BlockWrapper, Direction, EditorView, ViewPlugin, layer, type LayerMarker, type ViewUpdate } from '@codemirror/view'
import { shouldRevealSource, sourceRevealChanged } from '../util/reveal-selection'
import type { SyntaxNode } from '@lezer/common'
import { configField, type EditorConfiguration } from '../util/configuration'
import { parsePdfCallout } from '../parser/admonition-parser'

// Zettlr-LYH (R64): blockquotes are indented on both sides by a configurable
// amount and get a configurable background, one color for light mode and one
// for dark mode. The wrapper element carries the current values as CSS custom
// properties, and the base theme below reads them. This way, switching between
// light and dark mode needs no redraw, and a change to the settings only needs
// new wrapper attributes, which CodeMirror then applies to the DOM. PDF++
// callouts (see parsePdfCallout) and the quotes inside them keep their former
// look.

/**
 * CSS custom property holding the indentation of blockquotes on either side
 */
export const BLOCKQUOTE_INDENT_PROPERTY = '--zettlr-blockquote-indent'

/**
 * CSS custom property holding the background of blockquotes in light mode
 */
export const BLOCKQUOTE_BACKGROUND_LIGHT_PROPERTY = '--zettlr-blockquote-background-light'

/**
 * CSS custom property holding the background of blockquotes in dark mode
 */
export const BLOCKQUOTE_BACKGROUND_DARK_PROPERTY = '--zettlr-blockquote-background-dark'

/**
 * Class of the blockquote wrappers to which the indentation and background
 * settings apply (all but PDF++ callouts and the quotes inside them)
 */
export const STYLED_BLOCKQUOTE_CLASS = 'blockquote-styled'

/**
 * Class of the elements that draw the backgrounds of styled blockquotes in a
 * layer below the selection
 */
export const BLOCKQUOTE_BACKGROUND_CLASS = 'cm-blockquoteBackground'

/**
 * Indentation in em if the configuration provides no usable value
 */
export const DEFAULT_BLOCKQUOTE_INDENT = 2

/**
 * Largest indentation in em
 */
export const MAXIMUM_BLOCKQUOTE_INDENT = 10

/**
 * Background in light mode if the configuration provides no usable color
 */
export const DEFAULT_BLOCKQUOTE_BACKGROUND_LIGHT = '#f3f3f3'

/**
 * Background in dark mode if the configuration provides no usable color
 */
export const DEFAULT_BLOCKQUOTE_BACKGROUND_DARK = '#2b2b2b'

// Only plain `#rrggbb` colors are accepted, so that nothing else from the
// configuration ever ends up in a style attribute
const hexColorRE = /^#[0-9a-fA-F]{6}$/

/**
 * The part of the editor configuration that concerns blockquotes
 */
export interface BlockquoteSettings {
  blockquoteIndent: EditorConfiguration['blockquoteIndent']
  blockquoteBackgroundLight: EditorConfiguration['blockquoteBackgroundLight']
  blockquoteBackgroundLightTransparent: EditorConfiguration['blockquoteBackgroundLightTransparent']
  blockquoteBackgroundDark: EditorConfiguration['blockquoteBackgroundDark']
  blockquoteBackgroundDarkTransparent: EditorConfiguration['blockquoteBackgroundDarkTransparent']
}

/**
 * Returns a usable indentation: numbers are clamped to the allowed range,
 * anything else falls back to the default.
 *
 * @param   {unknown}  value  The configured indentation in em
 *
 * @return  {number}          The indentation in em
 */
function sanitizeIndent (value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_BLOCKQUOTE_INDENT
  }
  return Math.min(MAXIMUM_BLOCKQUOTE_INDENT, Math.max(0, value))
}

/**
 * Returns the background of one mode: transparent if so configured, else the
 * configured color, or the fallback if that is no `#rrggbb` color.
 *
 * @param   {unknown}  color        The configured color
 * @param   {unknown}  transparent  Whether the mode has no background
 * @param   {string}   fallback     The default color of the mode
 *
 * @return  {string}                A CSS color
 */
function sanitizeBackground (color: unknown, transparent: unknown, fallback: string): string {
  if (transparent === true) {
    return 'transparent'
  }
  return typeof color === 'string' && hexColorRE.test(color) ? color : fallback
}

/**
 * Computes the values of the CSS custom properties that the base theme of the
 * blockquote renderer reads.
 *
 * @param   {Partial<BlockquoteSettings>|undefined}  config  The configuration
 *
 * @return  {Record<string, string>}                         Property values
 */
export function blockquoteStyleProperties (config: Partial<BlockquoteSettings>|undefined): Record<string, string> {
  return {
    [BLOCKQUOTE_INDENT_PROPERTY]: `${sanitizeIndent(config?.blockquoteIndent)}em`,
    [BLOCKQUOTE_BACKGROUND_LIGHT_PROPERTY]: sanitizeBackground(
      config?.blockquoteBackgroundLight,
      config?.blockquoteBackgroundLightTransparent,
      DEFAULT_BLOCKQUOTE_BACKGROUND_LIGHT
    ),
    [BLOCKQUOTE_BACKGROUND_DARK_PROPERTY]: sanitizeBackground(
      config?.blockquoteBackgroundDark,
      config?.blockquoteBackgroundDarkTransparent,
      DEFAULT_BLOCKQUOTE_BACKGROUND_DARK
    )
  }
}

/**
 * Returns the style attribute of blockquote wrappers to which the settings
 * apply.
 *
 * @param   {Partial<BlockquoteSettings>|undefined}  config  The configuration
 *
 * @return  {string}                                         The style attribute
 */
export function blockquoteWrapperStyle (config: Partial<BlockquoteSettings>|undefined): string {
  return Object.entries(blockquoteStyleProperties(config))
    .map(([ property, value ]) => `${property}: ${value}`)
    .join('; ')
}

/**
 * Determines whether a Blockquote node is a PDF++ callout or lies inside one
 *
 * @param   {SyntaxNode}  node  A Blockquote node
 * @param   {Text}        doc   The document the node belongs to
 *
 * @return  {boolean}           True if the node belongs to a PDF++ callout
 */
function belongsToPdfCallout (node: SyntaxNode, doc: Text): boolean {
  for (let current: SyntaxNode|null = node; current !== null; current = current.parent) {
    if (current.name === 'Blockquote' && parsePdfCallout(current, doc) !== null) {
      return true
    }
  }
  return false
}

function showBlockquoteWrappers (view: EditorView): RangeSet<BlockWrapper> {
  const ranges: Range<BlockWrapper>[] = []
  const config = view.state.field(configField, false)
  const includeAdjacent = config?.previewModeShowSyntaxWhenCursorIsAdjacent ?? true

  // Zettlr-LYH (R64): the same two wrappers serve every blockquote
  const styledWrapper = BlockWrapper.create({
    tagName: 'blockquote-wrapper',
    attributes: {
      class: `blockquote-wrapper ${STYLED_BLOCKQUOTE_CLASS}`,
      style: blockquoteWrapperStyle(config)
    }
  })
  const calloutWrapper = BlockWrapper.create({
    tagName: 'blockquote-wrapper',
    attributes: {
      class: 'blockquote-wrapper',
    }
  })

  // Zettlr-LYH: every replaced range of at least 20 characters (a rendered
  // formula, for instance) splits the visible ranges, and each visible range
  // enters every blockquote it touches. Wrapping a blockquote once per visible
  // range would nest as many identical wrappers into each other, so every
  // Blockquote node is handled only once. A truly nested blockquote is a node
  // of its own and keeps its wrapper.
  const handledBlockquotes = new Set<string>()

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from, to,
      enter: (node) => {
        if (node.name !== 'Blockquote') {
          return
        }

        const nodeKey = `${node.from}:${node.to}`
        if (handledBlockquotes.has(nodeKey)) {
          return
        }
        handledBlockquotes.add(nodeKey)

        const category = belongsToPdfCallout(node.node, view.state.doc) ? 'admonitions' : 'blockquotes'
        if (shouldRevealSource(view.state, category, node.from, node.to, includeAdjacent)) {
          return
        }

        let parent: SyntaxNode|null = node.node.parent
        let parentNode

        while (parent) {
          if (parent.name === 'Blockquote') {
            parentNode = parent.node
          }
          parent = parent.parent
        }

        if (parentNode && shouldRevealSource(view.state, category, parentNode.from, parentNode.to, includeAdjacent)) {
          return
        }

        const line = view.state.doc.lineAt(node.from)
        const wrapper = belongsToPdfCallout(node.node, view.state.doc) ? calloutWrapper : styledWrapper

        ranges.push(wrapper.range(line.from, node.to))
      },
    })
  }

  return BlockWrapper.set(ranges, true)
}

const blockquotePlugin = ViewPlugin.fromClass(class {
  blockWrappers: RangeSet<BlockWrapper>

  constructor (view: EditorView) {
    this.blockWrappers = showBlockquoteWrappers(view)
  }

  update (update: ViewUpdate) {
    // Zettlr-LYH (R64): a new configuration may change the indentation or the
    // backgrounds, which live in the wrapper attributes
    const configChanged = update.state.field(configField, false) !== update.startState.field(configField, false)
    if (update.docChanged || update.viewportChanged || update.selectionSet || sourceRevealChanged(update) || configChanged) {
      this.blockWrappers = showBlockquoteWrappers(update.view)
    }
  }

}, {
  provide: plugin => EditorView.blockWrappers.of(view => view.plugin(plugin)?.blockWrappers as RangeSet<BlockWrapper>|undefined || BlockWrapper.set([]))
})

// Zettlr-LYH: the selection is drawn in a layer behind the text, so a
// background on the wrapper itself would hide every selection inside a
// blockquote. The backgrounds are therefore drawn as rectangles in a layer of
// their own beneath the selection layer, one per styled wrapper.

/**
 * One background rectangle; it carries the CSS custom properties of the
 * wrapper, so that the theme picks the color of the current mode.
 */
class BlockquoteBackgroundMarker implements LayerMarker {
  constructor (
    readonly left: number,
    readonly top: number,
    readonly width: number,
    readonly height: number,
    readonly style: string
  ) {}

  draw (): HTMLElement {
    const element = document.createElement('div')
    element.className = BLOCKQUOTE_BACKGROUND_CLASS
    this.adjust(element)
    return element
  }

  update (element: HTMLElement): boolean {
    this.adjust(element)
    return true
  }

  adjust (element: HTMLElement): void {
    element.setAttribute(
      'style',
      `${this.style}; left: ${this.left}px; top: ${this.top}px; width: ${this.width}px; height: ${this.height}px`
    )
  }

  eq (other: LayerMarker): boolean {
    return other instanceof BlockquoteBackgroundMarker &&
      other.left === this.left && other.top === this.top &&
      other.width === this.width && other.height === this.height &&
      other.style === this.style
  }
}

/**
 * Measures the styled wrappers and returns one background rectangle for each,
 * relative to the origin of the editor's layers.
 *
 * @param   {EditorView}                    view  The editor view
 *
 * @return  {BlockquoteBackgroundMarker[]}        The rectangles
 */
function blockquoteBackgroundMarkers (view: EditorView): BlockquoteBackgroundMarker[] {
  const wrappers = view.contentDOM.querySelectorAll<HTMLElement>(`.blockquote-wrapper.${STYLED_BLOCKQUOTE_CLASS}`)
  if (wrappers.length === 0) {
    return []
  }

  // Same origin as CodeMirror's own layers use
  const scroller = view.scrollDOM
  const scrollerRect = scroller.getBoundingClientRect()
  const baseLeft = (view.textDirection === Direction.LTR ? scrollerRect.left : scrollerRect.right - scroller.clientWidth * view.scaleX) - scroller.scrollLeft * view.scaleX
  const baseTop = scrollerRect.top - scroller.scrollTop * view.scaleY

  const style = blockquoteWrapperStyle(view.state.field(configField, false))
  const markers: BlockquoteBackgroundMarker[] = []
  for (const wrapper of wrappers) {
    const rect = wrapper.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) {
      markers.push(new BlockquoteBackgroundMarker(rect.left - baseLeft, rect.top - baseTop, rect.width, rect.height, style))
    }
  }
  return markers
}

// The lowest precedence puts this layer after the selection layer in the layer
// order, and with that beneath it
const blockquoteBackgroundLayer = Prec.lowest(layer({
  above: false,
  class: 'cm-blockquoteBackgroundLayer',
  markers: blockquoteBackgroundMarkers,
  update: update => update.docChanged || update.viewportChanged || update.selectionSet ||
    sourceRevealChanged(update) ||
    update.state.field(configField, false) !== update.startState.field(configField, false)
}))

export const renderBlockquotes = [
  blockquotePlugin,
  blockquoteBackgroundLayer,
  EditorView.baseTheme({
    '.blockquote-wrapper': {
      display: 'block',
      borderLeft: 'solid 0.25em',
      paddingLeft: '0.5em',
      marginLeft: '0.25em'
    },
    // Zettlr-LYH (R64): styled blockquotes are indented on both sides and
    // framed all around instead of carrying a bar on the left; the padding keeps
    // the text off the frame. The frame itself is drawn by the background
    // rectangle beneath (see above), so it never covers a selection.
    [`.blockquote-wrapper.${STYLED_BLOCKQUOTE_CLASS}`]: {
      marginLeft: `var(${BLOCKQUOTE_INDENT_PROPERTY}, ${DEFAULT_BLOCKQUOTE_INDENT}em)`,
      marginRight: `var(${BLOCKQUOTE_INDENT_PROPERTY}, ${DEFAULT_BLOCKQUOTE_INDENT}em)`,
      borderLeft: 'none',
      padding: '0.4em 0.9em'
    },
    // The backgrounds live in the layer beneath the selection (see above)
    [`.${BLOCKQUOTE_BACKGROUND_CLASS}`]: {
      boxSizing: 'border-box',
      border: '1.5px solid var(--zettlr-editor-primary-color, #1cb27e)',
      borderRadius: '10px'
    },
    [`&light .${BLOCKQUOTE_BACKGROUND_CLASS}`]: {
      backgroundColor: `var(${BLOCKQUOTE_BACKGROUND_LIGHT_PROPERTY}, transparent)`
    },
    [`&dark .${BLOCKQUOTE_BACKGROUND_CLASS}`]: {
      backgroundColor: `var(${BLOCKQUOTE_BACKGROUND_DARK_PROPERTY}, transparent)`
    },
    '.blockquote-wrapper .cm-line': {
      opacity: '0.7',
      // We need to revert these stylings set by the
      // visual-indent plugin since they conflict with
      // the paddingLeft set by the blockquote-wrapper.
      paddingLeft: 'revert !important',
      textIndent: 'revert !important'
    },
    // Zettlr-LYH: the text of styled blockquotes has the color of the body
    // text; only PDF++ callouts keep the dimmed text
    [`.blockquote-wrapper.${STYLED_BLOCKQUOTE_CLASS} .cm-line`]: {
      opacity: '1'
    }
  })
]
