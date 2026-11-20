/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Text color and background color spans
 * CVM-Role:        Utility Functions
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Colors a text selection by wrapping it in an inline HTML
 *                  span (`<span style="color: #d32f2f">...</span>`,
 *                  `<span style="background-color: #fff59d">...</span>`), which
 *                  the HTML span renderer displays. `buildColorSpanChanges`
 *                  works on plain text and returns the changes, `applyTextColor`
 *                  dispatches them to an editor view as one transaction.
 *
 *                  Rules of the changes:
 *                  * A selection that is exactly one span (with or without its
 *                    tags) gets its `style` rewritten instead of a nested span.
 *                    Text and background color share one span.
 *                  * Spans that lie completely inside the selection lose the
 *                    colored property, so that the new color (or the removal)
 *                    applies to everything that was selected.
 *                  * Every paragraph gets a span of its own: blank lines, list
 *                    markers, quote markers and heading markers stay outside of
 *                    the spans. Lines of one paragraph share one span.
 *                  * Text that must not contain tags (code blocks, YAML front
 *                    matter, HTML comments, the pipes of tables) is passed in as
 *                    excluded ranges and skipped.
 *                  * A selection that cuts through another HTML element, e.g.
 *                    `a <b>x` of `a <b>x</b> y`, is left unchanged, since the
 *                    tags could not be paired afterwards.
 *
 * END HEADER
 */

import { ensureSyntaxTree, language, syntaxTree } from '@codemirror/language'
import { EditorSelection, type EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { parseHtmlTag } from './html-span-tags'

export type ColorProperty = 'color'|'background-color'

export interface TextRange {
  from: number
  to: number
}

export interface ColorSpanChange {
  from: number
  to: number
  insert: string
}

export interface ColorSpanRequest {
  /** The whole text of the document */
  doc: string
  /** Start of the selection */
  from: number
  /** End of the selection */
  to: number
  /** The property to color or to remove */
  property: ColorProperty
  /** The color as `#rgb` or `#rrggbb`, or null to remove the property */
  color: string|null
  /** Ranges that must not receive any tags (code blocks, table pipes, ...) */
  excludedRanges?: readonly TextRange[]
}

/**
 * The colors offered for the text, from red to brown.
 */
export const TEXT_COLOR_PRESETS: readonly string[] = [
  '#d32f2f', '#f57c00', '#fbc02d', '#388e3c', '#00897b',
  '#1976d2', '#7b1fa2', '#c2185b', '#616161', '#5d4037'
]

/**
 * The colors offered for the background: the light counterparts of the text
 * colors, in the same order.
 */
export const BACKGROUND_COLOR_PRESETS: readonly string[] = [
  '#ffcdd2', '#ffe0b2', '#fff59d', '#c8e6c9', '#b2dfdb',
  '#bbdefb', '#e1bee7', '#f8bbd0', '#e0e0e0', '#d7ccc8'
]

/**
 * Matches the text of one HTML tag (opening or closing).
 */
const TAG_PATTERN = /<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?>/gi

/**
 * Matches the attributes of a tag that have a value, in order. Names and
 * values are matched together, so that a quoted value is skipped as a whole.
 */
const ATTRIBUTE_PATTERN = /([a-z][a-z0-9-]*)(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi

const OPENING_SPAN_AT_END = /<span(?:\s[^<>]*)?>$/i
const CLOSING_SPAN_AT_START = /^<\/span\s*>/i
const OPENING_SPAN_WITHOUT_ATTRIBUTES = /^<span\s*>$/i

/**
 * How far before a selection the opening tag of a span enclosing it is
 * searched.
 */
const ENCLOSING_SPAN_LOOKBEHIND = 2000

/**
 * A line that separates paragraphs although it is not blank: a horizontal
 * rule, the underline of a heading (`=====`), or the fence of a code block or
 * of a Pandoc div.
 */
const SEPARATOR_LINE = /^[ \t]*(?:([-*_])(?:[ \t]*\1){2,}|=+|:{3,}.*|`{3,}.*|~{3,}.*)[ \t]*$/

/**
 * The markup in front of the text of a line: indentation, quote markers, then a
 * list marker (with the checkbox of a task) or a heading marker.
 */
const BLOCK_PREFIX = /^[ \t]*(?:>[ \t]*)*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?|#{1,6}[ \t]+)?/
const ATX_HEADING = /^[ \t]*#{1,6}[ \t]+/

/**
 * Syntax nodes whose text never receives tags.
 */
const EXCLUDED_NODE_NAMES = new Set([
  'FencedCode', 'CodeBlock', 'IndentedCode', 'YAMLFrontmatter', 'CommentBlock', 'Comment', 'TableDelimiter'
])

/**
 * Turns `#rgb` or `#rrggbb` (any case) into the lowercase six-digit form.
 *
 * @param   {string}       input  The color text
 *
 * @return  {string|null}         The normalized color, or null for any other input
 */
export function normalizeHexColor (input: string): string|null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input)
  if (match === null) {
    return null
  }

  let digits = match[1].toLowerCase()
  if (digits.length === 3) {
    digits = digits.split('').map(digit => digit + digit).join('')
  }
  return '#' + digits
}

// ---------------------------------------------------------------------------
// Style attribute
// ---------------------------------------------------------------------------

interface StyleAttribute {
  /** Start of `style=...` in the tag text */
  from: number
  /** End of `style=...` in the tag text */
  to: number
  value: string
  /** The quote of the value, or an empty string if it is not quoted */
  quote: string
}

function findStyleAttribute (tagText: string): StyleAttribute|undefined {
  for (const match of tagText.matchAll(ATTRIBUTE_PATTERN)) {
    if (match[1].toLowerCase() === 'style') {
      return {
        from: match.index,
        to: match.index + match[0].length,
        value: match[3] ?? match[4] ?? match[5] ?? '',
        quote: match[3] !== undefined ? '"' : (match[4] !== undefined ? "'" : '')
      }
    }
  }
  return undefined
}

/**
 * Splits the value of a `style` attribute into its declarations. Semicolons
 * inside quotes and parentheses (`url(data:...;base64,...)`) do not split.
 *
 * @param   {string}    style  The value of the attribute
 *
 * @return  {string[]}         The trimmed, nonempty declarations
 */
function splitDeclarations (style: string): string[] {
  const declarations: string[] = []
  let current = ''
  let quote = ''
  let depth = 0

  for (const character of style) {
    if (quote !== '') {
      quote = character === quote ? '' : quote
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (character === '(') {
      depth++
    } else if (character === ')') {
      depth = Math.max(0, depth - 1)
    } else if (character === ';' && depth === 0) {
      declarations.push(current)
      current = ''
      continue
    }
    current += character
  }
  declarations.push(current)

  return declarations.map(declaration => declaration.trim()).filter(declaration => declaration !== '')
}

function declarationName (declaration: string): string {
  const colon = declaration.indexOf(':')
  return colon < 0 ? '' : declaration.slice(0, colon).trim().toLowerCase()
}

/**
 * Sets or removes one property in the `style` of an opening span tag. All
 * other declarations and attributes stay as they are.
 *
 * @param   {string}       tagText   The text of the opening tag
 * @param   {ColorProperty}  property  The property to set or remove
 * @param   {string|null}  color     The new color, or null to remove the property
 *
 * @return  {string|null}            The new text of the tag; the old text if
 *                                   nothing changes; null if the tag has no
 *                                   attributes left and should be removed
 */
function rewriteSpanOpeningTag (tagText: string, property: ColorProperty, color: string|null): string|null {
  const styleAttribute = findStyleAttribute(tagText)
  const declarations = styleAttribute === undefined ? [] : splitDeclarations(styleAttribute.value)

  const updated: string[] = []
  let found = false
  for (const declaration of declarations) {
    if (declarationName(declaration) !== property) {
      updated.push(declaration)
      continue
    }
    // The first declaration of the property takes the new value, repeated ones
    // are dropped
    if (color !== null && !found) {
      updated.push(`${property}: ${color}`)
    }
    found = true
  }

  if (color === null && !found) {
    return tagText // Nothing to remove
  } else if (color !== null && !found) {
    updated.push(`${property}: ${color}`)
  }
  const style = updated.join('; ')

  if (styleAttribute === undefined) {
    // Only reached with a color: removing from a tag without `style` returned above
    return tagText.replace(/\s*>$/, () => ` style="${style}">`)
  }

  if (style !== '') {
    const quote = styleAttribute.quote === "'" ? "'" : '"'
    return tagText.slice(0, styleAttribute.from) + `style=${quote}${style}${quote}` + tagText.slice(styleAttribute.to)
  }

  const withoutStyle = tagText.slice(0, styleAttribute.from).replace(/\s+$/, '') + tagText.slice(styleAttribute.to)
  return OPENING_SPAN_WITHOUT_ATTRIBUTES.test(withoutStyle) ? null : withoutStyle
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

interface TagToken {
  from: number
  to: number
  kind: 'open'|'close'
  name: string
  text: string
}

interface TagPair {
  open: TagToken
  close: TagToken
}

/**
 * Finds the tags of whitelisted HTML elements (see `html-span-tags.ts`) in a
 * part of the document.
 */
function scanTags (doc: string, from: number, to: number): TagToken[] {
  const tokens: TagToken[] = []
  for (const match of doc.slice(from, to).matchAll(TAG_PATTERN)) {
    const parsed = parseHtmlTag(match[0], { allowLinks: true })
    if (parsed !== undefined) {
      tokens.push({
        from: from + match.index,
        to: from + match.index + match[0].length,
        kind: parsed.kind,
        name: parsed.name,
        text: match[0]
      })
    }
  }
  return tokens
}

/**
 * Pairs opening and closing tags of the same element. The result is
 * unbalanced if any tag finds no partner or partners are crossed.
 */
function pairTags (tokens: readonly TagToken[]): { pairs: TagPair[], balanced: boolean } {
  const pairs: TagPair[] = []
  const stack: TagToken[] = []
  let balanced = true

  for (const token of tokens) {
    if (token.kind === 'open') {
      stack.push(token)
      continue
    }

    let index = stack.length - 1
    while (index >= 0 && stack[index].name !== token.name) {
      index--
    }
    if (index < 0) {
      balanced = false
      continue
    }
    if (index !== stack.length - 1) {
      balanced = false
    }
    pairs.push({ open: stack[index], close: token })
    stack.length = index
  }

  return { pairs, balanced: balanced && stack.length === 0 }
}

/**
 * Moves a position that lies inside the text of a tag (on one line) to the
 * start or the end of that tag, so that no tag is split by a new tag.
 */
function snapOutOfTag (doc: string, position: number, side: 'start'|'end'): number {
  const lineStart = position === 0 ? 0 : doc.lastIndexOf('\n', position - 1) + 1
  let lineEnd = doc.indexOf('\n', position)
  if (lineEnd < 0) {
    lineEnd = doc.length
  }

  for (const match of doc.slice(lineStart, lineEnd).matchAll(TAG_PATTERN)) {
    const tagStart = lineStart + match.index
    const tagEnd = tagStart + match[0].length
    if (position > tagStart && position < tagEnd) {
      return side === 'start' ? tagStart : tagEnd
    }
  }
  return position
}

/**
 * Looks for a span whose content is exactly the piece: its opening tag ends
 * where the piece starts and its closing tag starts where the piece ends.
 */
function findEnclosingSpan (doc: string, piece: TextRange): TagPair|undefined {
  const before = doc.slice(Math.max(0, piece.from - ENCLOSING_SPAN_LOOKBEHIND), piece.from)
  const opening = OPENING_SPAN_AT_END.exec(before)
  const closing = CLOSING_SPAN_AT_START.exec(doc.slice(piece.to, piece.to + 16))
  if (opening === null || closing === null || parseHtmlTag(opening[0])?.kind !== 'open') {
    return undefined
  }

  return {
    open: { from: piece.from - opening[0].length, to: piece.from, kind: 'open', name: 'span', text: opening[0] },
    close: { from: piece.to, to: piece.to + closing[0].length, kind: 'close', name: 'span', text: closing[0] }
  }
}

/**
 * The changes that set or remove a property in the style of a span: the new
 * opening tag, or the removal of both tags if nothing is left in it.
 */
function rewritePair (pair: TagPair, property: ColorProperty, color: string|null): ColorSpanChange[] {
  const rewritten = rewriteSpanOpeningTag(pair.open.text, property, color)
  if (rewritten === null) {
    return [
      { from: pair.open.from, to: pair.open.to, insert: '' },
      { from: pair.close.from, to: pair.close.to, insert: '' }
    ]
  }
  return rewritten === pair.open.text ? [] : [{ from: pair.open.from, to: pair.open.to, insert: rewritten }]
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/**
 * The parts of a range that lie outside the excluded ranges.
 */
function subtractRanges (range: TextRange, excluded: readonly TextRange[]): TextRange[] {
  const runs: TextRange[] = []
  let cursor = range.from

  for (const { from, to } of [...excluded].sort((a, b) => a.from - b.from)) {
    if (to <= cursor) {
      continue
    }
    if (from >= range.to) {
      break
    }
    if (from > cursor) {
      runs.push({ from: cursor, to: from })
    }
    cursor = Math.max(cursor, to)
  }

  if (cursor < range.to) {
    runs.push({ from: cursor, to: range.to })
  }
  return runs
}

/**
 * Splits a range into the pieces that each get one span: runs of lines of the
 * same paragraph, without leading and trailing whitespace and without the
 * markup that starts a line.
 */
function splitIntoParagraphs (doc: string, runFrom: number, runTo: number): TextRange[] {
  const pieces: TextRange[] = []
  let pieceFrom = -1
  let pieceTo = -1
  const finishPiece = (): void => {
    if (pieceFrom >= 0) {
      pieces.push({ from: pieceFrom, to: pieceTo })
    }
    pieceFrom = -1
    pieceTo = -1
  }

  let lineStart = runFrom === 0 ? 0 : doc.lastIndexOf('\n', runFrom - 1) + 1
  while (lineStart <= runTo) {
    let lineEnd = doc.indexOf('\n', lineStart)
    if (lineEnd < 0) {
      lineEnd = doc.length
    }
    const lineText = doc.slice(lineStart, lineEnd)

    if (SEPARATOR_LINE.test(lineText)) {
      finishPiece()
    } else {
      let start = Math.max(lineStart, runFrom)
      let end = Math.min(lineEnd, runTo)

      // A line that begins with a list, quote or heading marker begins a new
      // block, and the marker itself stays outside of the span
      const prefix = BLOCK_PREFIX.exec(lineText)?.[0] ?? ''
      const prefixEnd = lineStart + prefix.length
      if (prefix.trim() !== '' && start <= prefixEnd) {
        finishPiece()
        start = Math.max(start, prefixEnd)
      }

      while (start < end && /\s/.test(doc[start])) {
        start++
      }
      while (end > start && /\s/.test(doc[end - 1])) {
        end--
      }

      if (start >= end) {
        finishPiece() // A blank line ends the paragraph
      } else {
        if (pieceFrom < 0) {
          pieceFrom = start
        }
        pieceTo = end
        if (ATX_HEADING.test(lineText)) {
          finishPiece() // A heading is a block of one line
        }
      }
    }

    lineStart = lineEnd + 1
  }

  finishPiece()
  return pieces
}

function buildPieceChanges (doc: string, piece: TextRange, property: ColorProperty, color: string|null): ColorSpanChange[] {
  const { pairs, balanced } = pairTags(scanTags(doc, piece.from, piece.to))
  if (!balanced) {
    return []
  }

  // The span to rewrite instead of nesting a new one: the piece is that span,
  // with its tags, or exactly its content
  const target = pairs.find(pair => pair.open.name === 'span' && pair.open.from === piece.from && pair.close.to === piece.to) ??
    findEnclosingSpan(doc, piece)

  const changes: ColorSpanChange[] = []
  for (const pair of pairs) {
    if (pair.open.name === 'span' && pair !== target) {
      changes.push(...rewritePair(pair, property, null))
    }
  }

  if (target !== undefined) {
    changes.push(...rewritePair(target, property, color))
  } else if (color !== null) {
    changes.push(
      { from: piece.from, to: piece.from, insert: `<span style="${property}: ${color}">` },
      { from: piece.to, to: piece.to, insert: '</span>' }
    )
  }
  return changes
}

/**
 * Sorts the changes and joins those that touch each other, so that the result
 * has no two changes at the same position.
 */
function mergeChanges (changes: readonly ColorSpanChange[]): ColorSpanChange[] {
  const merged: ColorSpanChange[] = []
  for (const change of [...changes].sort((a, b) => a.from - b.from || a.to - b.to)) {
    const previous = merged[merged.length - 1]
    if (previous !== undefined && change.from <= previous.to) {
      previous.to = Math.max(previous.to, change.to)
      previous.insert += change.insert
    } else {
      merged.push({ ...change })
    }
  }
  return merged
}

/**
 * Builds the changes that color a selection or remove a color from it. All
 * positions refer to the document as it is before the changes, and the changes
 * do not overlap. The result is empty if there is nothing to change.
 *
 * @param   {ColorSpanRequest}   request  The document, the selection, the
 *                                        property and the color
 *
 * @return  {ColorSpanChange[]}           The changes
 */
export function buildColorSpanChanges (request: ColorSpanRequest): ColorSpanChange[] {
  const { doc, property } = request
  const color = request.color === null ? null : normalizeHexColor(request.color)
  if (request.color !== null && color === null) {
    return []
  }

  const from = snapOutOfTag(doc, Math.max(0, Math.min(request.from, request.to)), 'start')
  const to = snapOutOfTag(doc, Math.min(doc.length, Math.max(request.from, request.to)), 'end')
  if (from >= to) {
    return []
  }

  const changes: ColorSpanChange[] = []
  for (const run of subtractRanges({ from, to }, request.excludedRanges ?? [])) {
    for (const piece of splitIntoParagraphs(doc, run.from, run.to)) {
      changes.push(...buildPieceChanges(doc, piece, property, color))
    }
  }
  return mergeChanges(changes)
}

// ---------------------------------------------------------------------------
// Editor command
// ---------------------------------------------------------------------------

/**
 * Collects the parts of a selection that must not receive tags (code blocks,
 * front matter, comments, table pipes) and moves a selection boundary that lies
 * inside inline code out of it.
 */
function inspectSelection (state: EditorState, from: number, to: number): { from: number, to: number, excludedRanges: TextRange[] } {
  const excludedRanges: TextRange[] = []
  let start = from
  let end = to

  const tree = ensureSyntaxTree(state, to, 100) ?? syntaxTree(state)
  tree.iterate({
    from,
    to,
    enter: (node) => {
      if (EXCLUDED_NODE_NAMES.has(node.name)) {
        excludedRanges.push({ from: node.from, to: node.to })
        return false
      } else if (node.name === 'InlineCode') {
        if (node.from < from && from < node.to) {
          start = node.from
        }
        if (node.from < to && to < node.to) {
          end = node.to
        }
        return false
      }
    }
  })

  return { from: start, to: end, excludedRanges }
}

/**
 * Colors the selection of an editor view, or removes the color from it, in one
 * transaction. Afterwards the selection covers the colored text together with
 * its tags (the renderer hides them), so that the next color applies to the
 * same span.
 *
 * @param   {EditorView}     view      The editor view
 * @param   {ColorProperty}  property  `color` for the text, `background-color`
 *                                     for the background
 * @param   {string|null}    color     The color as `#rgb` or `#rrggbb`, or null
 *                                     to remove the property
 *
 * @return  {boolean}                  Whether the document changed
 */
export function applyTextColor (view: EditorView, property: ColorProperty, color: string|null): boolean {
  if (view.state.facet(language)?.name !== 'markdown') {
    return false
  }

  const normalized = color === null ? null : normalizeHexColor(color)
  if (color !== null && normalized === null) {
    return false
  }

  const { state } = view
  const doc = state.doc.toString()
  const specs: ColorSpanChange[] = []
  for (const range of state.selection.ranges) {
    if (!range.empty) {
      specs.push(...buildColorSpanChanges({ doc, ...inspectSelection(state, range.from, range.to), property, color: normalized }))
    }
  }
  if (specs.length === 0) {
    return false
  }

  const changes = state.changes(specs)
  const ranges = state.selection.ranges.map(range => {
    if (range.empty) {
      return range.map(changes)
    }
    // Keep the tags that were inserted at the boundaries inside the selection
    const from = changes.mapPos(range.from, -1)
    const to = changes.mapPos(range.to, 1)
    return range.anchor < range.head ? EditorSelection.range(from, to) : EditorSelection.range(to, from)
  })
  // The user event keeps every coloring a step of its own in the undo history
  // (history joins adjacent changes in quick succession only if they come from
  // typing or deleting), and keeps Track Changes (which handles `input`) away.
  view.dispatch({ changes, selection: EditorSelection.create(ranges, state.selection.mainIndex), userEvent: 'format.color' })
  return true
}
