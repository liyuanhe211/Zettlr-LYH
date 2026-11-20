/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Track Changes transaction filter
 * CVM-Role:        Extension
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH: while Track Changes is on, rewrites typing,
 *                  pasting, dropping and deleting into tracked changes stored
 *                  as Pandoc spans (spec C10, editing rules), and makes the
 *                  hidden brackets and attribute blocks of the revision spans
 *                  atomic for the cursor.
 *
 * END HEADER
 */

import {
  Annotation,
  ChangeSet,
  EditorSelection,
  EditorState,
  Facet,
  RangeSet,
  RangeSetBuilder,
  RangeValue,
  StateEffect,
  StateField,
  Transaction,
  findClusterBreak,
  type AnnotationType,
  type Extension,
  type Text,
  type TransactionSpec
} from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { isolateHistory } from '@codemirror/commands'
import type { SyntaxNode, Tree } from '@lezer/common'
import {
  findRevisionsInTree,
  formatRevisionAttributes,
  formatRevisionDate,
  revisionVisibleFrom,
  revisionVisibleTo,
  type RevisionKind,
  type RevisionRange
} from './revision-model'

/**
 * The Track Changes configuration of an editor
 */
export interface TrackChangesConfig {
  /**
   * Whether edits are recorded as tracked changes
   */
  enabled: boolean
  /**
   * The author name written into new tracked changes
   */
  author: string
  /**
   * The clock for the date of new tracked changes (injectable for tests)
   */
  now: () => Date
}

const DEFAULT_CONFIG: TrackChangesConfig = { enabled: false, author: '', now: () => new Date() }

/**
 * Time budget (milliseconds) for completing the syntax tree before a
 * transaction is rewritten
 */
const PARSE_TIMEOUT = 200

/**
 * Time budget (milliseconds) for completing the syntax tree before the hidden
 * markup ranges are computed
 */
const MARKUP_PARSE_TIMEOUT = 50

/**
 * Number of characters before a rewritten region that are inspected to decide
 * whether its first character is escaped by backslashes
 */
const ESCAPE_CONTEXT_LENGTH = 32

/**
 * Characters that are only safe inside a revision span when they are balanced
 * or escaped (see unsafeCharacters)
 */
const UNSAFE_CHARACTERS = /[\n\r[\]`$\\]/

/**
 * The Track Changes configuration. The last provided value wins.
 */
export const trackChangesConfig: Facet<TrackChangesConfig, TrackChangesConfig> = Facet.define<TrackChangesConfig, TrackChangesConfig>({
  combine: values => values.length > 0 ? values[values.length - 1] : DEFAULT_CONFIG
})

/**
 * Marks transactions that the Track Changes filter has rewritten
 */
export const revisionTransaction: AnnotationType<boolean> = Annotation.define<boolean>()

/**
 * Syntax nodes whose content is edited directly; the cursor counts as inside
 * them at both ends ("positions where no change can be tracked", block part)
 */
const BLOCK_NODES = new Set([
  'FencedCode', 'CodeBlock', 'YAMLFrontmatter', 'HTMLBlock', 'CommentBlock',
  'ProcessingInstructionBlock', 'PandocDivMark', 'PandocDivInfo', 'LinkReference'
])

/**
 * Syntax nodes whose inside is edited directly; the cursor counts as inside
 * them only strictly between their ends (inline part)
 */
const INLINE_NODES = new Set([
  'InlineCode', 'Comment', 'HTMLTag', 'ProcessingInstruction', 'URL', 'Autolink',
  'ZknLink', 'PandocAttribute', 'Entity'
])

/**
 * Syntax nodes with brackets that a partial deletion would break
 */
const BRACKETED_NODES = new Set([ 'Link', 'Image', 'PandocSpan' ])

type Direction = 'backward'|'forward'|'none'

interface RewriteContext {
  state: EditorState
  tree: Tree
  author: string
  date: string
  direction: Direction
}

/**
 * One rewritten change: replace [from, to] of the start document with
 * `insert`; afterwards the cursor belongs `cursor` characters behind `from`.
 */
interface Replacement {
  from: number
  to: number
  insert: string
  cursor: number
  rewritten: boolean
}

interface TextToken { type: 'text', text: string }

interface CursorToken { type: 'cursor' }

interface SpanToken {
  type: 'span'
  kind: RevisionKind
  /**
   * The attribute block of the (outer) span, including braces
   */
  attrs: string
  author: string|undefined
  /**
   * For a nested deletion: the attribute block and author of the inner
   * insertion
   */
  inner: { attrs: string, author: string|undefined }|undefined
  /**
   * The visible text
   */
  content: string
  /**
   * Whether the span records (part of) the current edit
   */
  fresh: boolean
  /**
   * The cursor position inside the content, if the cursor belongs here
   */
  cursor: number|undefined
}

type Token = TextToken|CursorToken|SpanToken

interface Segment { from: number, text: string, safe: boolean }

/**
 * Hidden markup ranges of revisions as plain range values
 */
class RevisionMarkupValue extends RangeValue {}

const revisionMarkupValue = new RevisionMarkupValue()

const markupCache = new WeakMap<Tree, { doc: Text, ranges: RangeSet<RangeValue> }>()

/**
 * Computes the ranges of the revision markup that is hidden in the rendered
 * view: the opening bracket(s) and the closing bracket(s) with the attribute
 * block of every revision (for a nested deletion, both levels at once). The
 * Track Changes extension uses these as atomic ranges; the revision renderer
 * hides the same ranges.
 *
 * @param   {EditorState}            state  The state
 *
 * @return  {RangeSet<RangeValue>}          The markup ranges, sorted
 */
export function revisionMarkupRanges (state: EditorState): RangeSet<RangeValue> {
  const tree = ensureSyntaxTree(state, state.doc.length, MARKUP_PARSE_TIMEOUT) ?? syntaxTree(state)
  const cached = markupCache.get(tree)
  if (cached !== undefined && cached.doc === state.doc) {
    return cached.ranges
  }

  const builder = new RangeSetBuilder<RangeValue>()
  for (const revision of findRevisionsInTree(state, tree, 0, state.doc.length)) {
    builder.add(revision.from, revisionVisibleFrom(revision), revisionMarkupValue)
    builder.add(revisionVisibleTo(revision), revision.to, revisionMarkupValue)
  }

  const ranges = builder.finish()
  markupCache.set(tree, { doc: state.doc, ranges })
  return ranges
}

/**
 * Replaces line breaks and tabs in an author name by spaces, as they are
 * written into the attribute block (storage format item 5).
 */
function normalizeAuthor (author: string): string {
  return author.replace(/[\r\n\t]/g, ' ')
}

/**
 * Whether a text is non-empty and free of characters that need balancing
 */
function isSafeText (text: string): boolean {
  return text.length > 0 && !UNSAFE_CHARACTERS.test(text)
}

/**
 * Whether the last character of a text is escaped by an odd number of
 * backslashes in front of it
 */
function isEscaped (textBefore: string): boolean {
  let count = 0
  for (let index = textBefore.length - 1; index >= 0 && textBefore[index] === '\\'; index--) {
    count++
  }
  return count % 2 === 1
}

/**
 * Length of the block markers at the start of a line: indentation, block
 * quote markers, list markers, task boxes and heading markers, together with
 * the whitespace that follows them. Lines without markers yield the length of
 * their indentation.
 *
 * @param   {string}  line  The line text
 *
 * @return  {number}        The prefix length
 */
function linePrefixLength (line: string): number {
  const markerRe = /^[ \t]*(?:>|[-*+](?=[ \t]|$)|\d{1,9}[.)](?=[ \t]|$)|#{1,6}(?=[ \t]|$)|\[[ xX]\](?=[ \t]|$))/
  let position = 0
  for (;;) {
    const match = markerRe.exec(line.slice(position))
    if (match === null) {
      break
    }
    position += match[0].length
  }
  const whitespace = /^[ \t]*/.exec(line.slice(position))
  return position + (whitespace !== null ? whitespace[0].length : 0)
}

/**
 * Splits a text into maximal runs of safe characters and single unsafe
 * characters.
 */
function segmentsOf (text: string, unsafe: boolean[]): Segment[] {
  const segments: Segment[] = []
  let index = 0
  while (index < text.length) {
    if (unsafe[index]) {
      segments.push({ from: index, text: text[index], safe: false })
      index++
      continue
    }

    let end = index
    while (end < text.length && !unsafe[end]) {
      end++
    }
    segments.push({ from: index, text: text.slice(index, end), safe: true })
    index = end
  }
  return segments
}

/**
 * Finds the characters of a text that would break a revision span around it:
 * unmatched square brackets, the last of an odd number of backticks or dollar
 * signs, a backslash that escapes nothing, a bracket pair that would turn the
 * span into a Zettelkasten link "[[…]]", and, in inserted text, line breaks
 * together with the block markers at the start of the following line (a
 * revision span stays within one line of inserted text; spec C10, storage
 * format item 7 and known limitation 1).
 *
 * @param   {string}                     text  The text
 * @param   {'insertion'|'deletion'}     mode  The kind of span to build
 *
 * @return  {boolean[]}                         One flag per character
 */
function unsafeCharacters (text: string, mode: 'insertion'|'deletion'): boolean[] {
  const unsafe = new Array<boolean>(text.length).fill(false)
  const openBrackets: number[] = []
  const matches = new Map<number, number>()
  const backticks: number[] = []
  const dollars: number[] = []

  for (let index = 0; index < text.length; index++) {
    const character = text[index]
    if (character === '\r') {
      unsafe[index] = true
      continue
    }

    if (character === '\n') {
      if (mode === 'insertion') {
        unsafe[index] = true
        const lineEnd = text.indexOf('\n', index + 1)
        const prefix = linePrefixLength(text.slice(index + 1, lineEnd < 0 ? text.length : lineEnd))
        for (let offset = 1; offset <= prefix; offset++) {
          unsafe[index + offset] = true
        }
        index += prefix
      }
      continue
    }

    if (character === '\\') {
      if (index + 1 >= text.length || text[index + 1] === '\n' || text[index + 1] === '\r') {
        unsafe[index] = true
      } else {
        index++ // The escaped character
      }
      continue
    }

    if (character === '[') {
      openBrackets.push(index)
    } else if (character === ']') {
      const opening = openBrackets.pop()
      if (opening === undefined) {
        unsafe[index] = true
      } else {
        matches.set(opening, index)
      }
    } else if (character === '`') {
      backticks.push(index)
    } else if (character === '$') {
      dollars.push(index)
    }
  }

  for (const index of openBrackets) {
    unsafe[index] = true
  }
  if (backticks.length % 2 === 1) {
    unsafe[backticks[backticks.length - 1]] = true
  }
  if (dollars.length % 2 === 1) {
    unsafe[dollars[dollars.length - 1]] = true
  }

  let changed = true
  while (changed) {
    changed = false
    for (const segment of segmentsOf(text, unsafe)) {
      const closing = matches.get(segment.from)
      if (segment.safe && closing === segment.from + segment.text.length - 1) {
        unsafe[segment.from] = true
        unsafe[closing] = true
        changed = true
      }
    }
  }

  return unsafe
}

/**
 * Splits a text into the parts that can go into a revision span and the
 * characters that cannot (see unsafeCharacters).
 */
function safeSegments (text: string, mode: 'insertion'|'deletion'): Segment[] {
  return segmentsOf(text, unsafeCharacters(text, mode))
}

function isOwnInsertion (context: RewriteContext, revision: RevisionRange): boolean {
  return revision.kind === 'insertion' && revision.nested === undefined && revision.author === context.author
}

function isOwnDeletion (context: RewriteContext, revision: RevisionRange): boolean {
  return revision.kind === 'deletion' && revision.author === context.author
}

function clamp (value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * The position one character (grapheme cluster or line break) before or after
 * a position
 */
function clusterStep (state: EditorState, position: number, forward: boolean): number {
  const line = state.doc.lineAt(position)
  if (forward) {
    return position === line.to ? position + 1 : line.from + findClusterBreak(line.text, position - line.from, true)
  }
  return position === line.from ? position - 1 : line.from + findClusterBreak(line.text, position - line.from, false)
}

function freshSpan (context: RewriteContext, kind: RevisionKind, content: string, cursor: number|undefined): SpanToken {
  return {
    type: 'span',
    kind,
    attrs: formatRevisionAttributes(kind, context.author, context.date),
    author: context.author,
    inner: undefined,
    content,
    fresh: true,
    cursor
  }
}

function freshNestedDeletion (context: RewriteContext, content: string, insertion: SpanToken): SpanToken {
  return {
    type: 'span',
    kind: 'deletion',
    attrs: formatRevisionAttributes('deletion', context.author, context.date),
    author: context.author,
    inner: { attrs: insertion.attrs, author: insertion.author },
    content,
    fresh: true,
    cursor: undefined
  }
}

function spanTokenOf (state: EditorState, revision: RevisionRange): SpanToken {
  const nested = revision.nested
  return {
    type: 'span',
    kind: revision.kind,
    attrs: state.sliceDoc(revision.contentTo + 1, revision.to),
    author: revision.author,
    inner: nested !== undefined ? { attrs: state.sliceDoc(nested.contentTo + 1, nested.to), author: nested.author } : undefined,
    content: state.sliceDoc(revisionVisibleFrom(revision), revisionVisibleTo(revision)),
    fresh: false,
    cursor: undefined
  }
}

/**
 * Decides whether an insertion at a (a === b) or a deletion of [a, b] falls on
 * a position where no change can be tracked (spec C10): code, math, the YAML
 * frontmatter, HTML, link addresses, Pandoc attribute blocks and div markers,
 * table delimiter rows, block markers at the start of lines, Zettelkasten
 * links and the comment braces of a Revise Comment. A deletion that cuts
 * through such an element or through the brackets of a link or span counts as
 * well; one that removes such an inline element as a whole does not.
 */
function isUntrackable (context: RewriteContext, revisions: RevisionRange[], a: number, b: number): boolean {
  const { state, tree } = context
  const revisionStarts = new Set<number>()
  const revisionAttributeStarts = new Set<number>()
  for (const revision of revisions) {
    revisionStarts.add(revision.from)
    revisionAttributeStarts.add(revision.contentTo + 1)
    if (revision.nested !== undefined) {
      revisionStarts.add(revision.nested.from)
      revisionAttributeStarts.add(revision.nested.contentTo + 1)
    }
  }

  const partial = (from: number, to: number): boolean => from < b && a < to && !(a <= from && to <= b)
  let untrackable = false

  tree.iterate({
    from: Math.max(0, a - 1),
    to: Math.min(state.doc.length, b + 1),
    enter: (node) => {
      if (untrackable) {
        return false
      }

      const name = node.name
      if (BLOCK_NODES.has(name) || (name === 'TableDelimiter' && node.node.parent?.name === 'Table')) {
        if (a === b ? node.from <= a && a <= node.to : node.from < b && a < node.to) {
          untrackable = true
        }
        return false
      }

      if (INLINE_NODES.has(name)) {
        if (name === 'PandocAttribute' && revisionAttributeStarts.has(node.from)) {
          return false
        }
        if (a === b ? node.from < a && a < node.to : partial(node.from, node.to)) {
          untrackable = true
        }
        return false
      }

      if (BRACKETED_NODES.has(name)) {
        if (name === 'PandocSpan' && revisionStarts.has(node.from)) {
          return undefined
        }

        const marks: SyntaxNode[] = []
        for (let child = node.node.firstChild; child !== null; child = child.nextSibling) {
          if (child.name === 'LinkMark' || child.name === 'PandocSpanMark') {
            marks.push(child)
          }
        }

        if (a < b && partial(node.from, node.to) && marks.some(mark => mark.from < b && a < mark.to)) {
          untrackable = true
          return false
        }

        // The address part of a link or image, from its parenthesis onwards
        if (a === b && name !== 'PandocSpan' && marks.length > 2 && marks[2].from <= a && a < node.to) {
          untrackable = true
          return false
        }
      }

      return undefined
    }
  })

  if (untrackable) {
    return true
  }

  // Block markers at the start of the line
  const line = state.doc.lineAt(a)
  const prefixLength = linePrefixLength(line.text)
  if (line.text.slice(0, prefixLength).trim() !== '') {
    const prefixEnd = line.from + prefixLength
    if (a === b ? a < prefixEnd : b <= prefixEnd) {
      return true
    }
  }

  // The comment braces of a Revise Comment "[text{comment}]", also while the
  // parser does not recognise them (for example at the start of a line)
  const inMarkup = (position: number): boolean => revisions.some(revision => {
    return (position > revision.from && position < revisionVisibleFrom(revision)) ||
      (position > revisionVisibleTo(revision) && position < revision.to)
  })
  if (b <= line.to && !inMarkup(a) && !inMarkup(b)) {
    const before = line.text.slice(0, a - line.from)
    const between = line.text.slice(a - line.from, b - line.from)
    const after = line.text.slice(b - line.from)
    if (before.lastIndexOf('{') > before.lastIndexOf('}') && !/[{}]/.test(between) && /^[^{}]*\}\]/.test(after)) {
      return true
    }
  }

  return false
}

/**
 * Whether the line break at a position is a soft line break inside one
 * paragraph (and may therefore lie inside a revision span)
 */
function isSoftBreak (context: RewriteContext, position: number): boolean {
  let node: SyntaxNode|null = context.tree.resolveInner(position, 1)
  while (node !== null && node.name !== 'Paragraph') {
    node = node.parent
  }
  return node !== null && node.from <= position && position + 1 < node.to
}

/**
 * Positions of the cell separators of table rows in [from, to]
 */
function tableCellDelimiters (context: RewriteContext, from: number, to: number): number[] {
  const positions: number[] = []
  context.tree.iterate({
    from,
    to,
    enter: (node) => {
      if (node.name === 'TableDelimiter' && node.from >= from && node.to <= to) {
        const parent = node.node.parent?.name
        if (parent === 'TableRow' || parent === 'TableHeader') {
          positions.push(node.from)
        }
      }
    }
  })
  return positions
}

/**
 * Turns the deletion of plain text [from, to] (outside any revision) into
 * tokens: deletion spans for the text, untouched text for paragraph and block
 * boundaries, the block markers at the start of lines and table cell
 * separators. Characters that cannot go into a span (see unsafeCharacters) are
 * deleted directly.
 */
function plainDeletionTokens (context: RewriteContext, from: number, to: number): Token[] {
  const { state } = context
  const keeps: Array<[number, number]> = []

  const firstLine = state.doc.lineAt(from)
  const firstPrefixEnd = firstLine.from + linePrefixLength(firstLine.text)
  if (from < firstPrefixEnd) {
    keeps.push([ from, Math.min(to, firstPrefixEnd) ])
  }

  const text = state.sliceDoc(from, to)
  for (let offset = text.indexOf('\n'); offset >= 0; offset = text.indexOf('\n', offset + 1)) {
    const newline = from + offset
    if (isSoftBreak(context, newline)) {
      continue
    }

    let end = newline + 1
    while (end < to) {
      const line = state.doc.lineAt(end)
      if (line.text.trim() === '') {
        end = line.to + 1
        continue
      }
      end = line.from + linePrefixLength(line.text)
      break
    }
    keeps.push([ newline, Math.min(end, to) ])
  }

  for (const position of tableCellDelimiters(context, from, to)) {
    keeps.push([ position, position + 1 ])
  }

  keeps.sort((x, y) => x[0] - y[0])

  const tokens: Token[] = []
  let position = from
  const deleteUpTo = (end: number): void => {
    if (end <= position) {
      return
    }
    for (const segment of safeSegments(state.sliceDoc(position, end), 'deletion')) {
      if (segment.safe) {
        tokens.push(freshSpan(context, 'deletion', segment.text, undefined))
      }
    }
    position = end
  }

  for (const [ keepFrom, keepTo ] of keeps) {
    if (keepTo <= position) {
      continue
    }
    deleteUpTo(Math.max(position, keepFrom))
    tokens.push({ type: 'text', text: state.sliceDoc(position, keepTo) })
    position = keepTo
  }
  deleteUpTo(to)

  return tokens
}

/**
 * Whether two adjacent span tokens can become one span: same kind, both by
 * the current author, the same inner insertion for nested deletions, and
 * either one of them records the current edit or both come from the same span.
 */
function canMerge (context: RewriteContext, left: SpanToken, right: SpanToken): boolean {
  if (left.kind !== right.kind || left.author !== context.author || right.author !== context.author) {
    return false
  }

  const sameInner = left.inner === undefined
    ? right.inner === undefined
    : right.inner !== undefined && left.inner.attrs === right.inner.attrs
  return sameInner && (left.fresh || right.fresh || left.attrs === right.attrs)
}

/**
 * Merges adjacent spans that can be merged (see canMerge) and adjacent text.
 * A cursor between two merged spans moves into the merged content. A merged
 * span keeps the attributes of the existing span, so that its date stays the
 * date of the first edit (storage format item 6).
 */
function mergeTokens (context: RewriteContext, tokens: Token[]): Token[] {
  const result: Token[] = []
  for (const token of tokens) {
    if (token.type === 'span' && token.content === '') {
      if (token.cursor !== undefined) {
        result.push({ type: 'cursor' })
      }
      continue
    }

    if (token.type === 'span') {
      let index = result.length - 1
      let cursorBetween = false
      while (index >= 0 && result[index].type === 'cursor') {
        cursorBetween = true
        index--
      }

      const previous = index >= 0 ? result[index] : undefined
      if (previous !== undefined && previous.type === 'span' && canMerge(context, previous, token)) {
        let cursor = previous.cursor
        if (cursorBetween) {
          cursor = previous.content.length
        } else if (cursor === undefined && token.cursor !== undefined) {
          cursor = previous.content.length + token.cursor
        }

        result.splice(index, result.length - index, {
          ...previous,
          content: previous.content + token.content,
          attrs: previous.fresh && !token.fresh ? token.attrs : previous.attrs,
          fresh: previous.fresh || token.fresh,
          cursor
        })
        continue
      }
    }

    if (token.type === 'text') {
      const last = result[result.length - 1]
      if (last !== undefined && last.type === 'text') {
        result[result.length - 1] = { type: 'text', text: last.text + token.text }
        continue
      }
    }

    result.push(token)
  }

  return result
}

/**
 * Moves a cursor that directly follows an insertion span of the current
 * author to the end of its content (the cursor stays visually in place and
 * further typing extends the span).
 */
function absorbCursors (context: RewriteContext, tokens: Token[]): Token[] {
  const result: Token[] = []
  for (const token of tokens) {
    const previous = result[result.length - 1]
    if (
      token.type === 'cursor' && previous !== undefined && previous.type === 'span' &&
      previous.kind === 'insertion' && previous.inner === undefined &&
      previous.author === context.author && previous.cursor === undefined
    ) {
      result[result.length - 1] = { ...previous, cursor: previous.content.length }
      continue
    }
    result.push(token)
  }
  return result
}

/**
 * Writes tokens out as Markdown. A span directly behind "!" or "^" would be
 * read as an image or an inline footnote, so that character is escaped; a span
 * directly behind "]" would be read as a reference link, which cannot be
 * avoided, so serialisation fails then.
 *
 * @param   {Token[]}  tokens         The tokens
 * @param   {string}   contextBefore  The document text in front of the tokens
 *
 * @return  {{ text: string, cursor: number|undefined }|undefined}  The text and
 *                                    the cursor offset, or undefined on failure
 */
function serializeTokens (tokens: Token[], contextBefore: string): { text: string, cursor: number|undefined }|undefined {
  let text = ''
  let cursor: number|undefined
  let failed = false

  const openSpan = (): void => {
    if (text.length === 0) {
      return
    }
    const previous = text[text.length - 1]
    if (previous !== '!' && previous !== '^' && previous !== ']') {
      return
    }
    if (isEscaped(contextBefore + text.slice(0, -1))) {
      return
    }
    if (previous === ']') {
      failed = true
      return
    }
    const index = text.length - 1
    text = text.slice(0, index) + '\\' + previous
    if (cursor !== undefined && cursor > index) {
      cursor++
    }
  }

  for (const token of tokens) {
    if (token.type === 'text') {
      text += token.text
      continue
    }

    if (token.type === 'cursor') {
      cursor = text.length
      continue
    }

    if (token.content === '') {
      continue
    }

    if (token.kind === 'insertion' && token.inner === undefined) {
      let found = false
      for (const segment of safeSegments(token.content, 'insertion')) {
        const segmentEnd = segment.from + segment.text.length
        if (!segment.safe) {
          if (!found && token.cursor === segment.from) {
            cursor = text.length
            found = true
          }
          text += segment.text
          continue
        }

        openSpan()
        const start = text.length
        text += '[' + segment.text + ']' + token.attrs
        if (!found && token.cursor !== undefined && token.cursor >= segment.from && token.cursor <= segmentEnd) {
          cursor = start + 1 + token.cursor - segment.from
          found = true
        }
      }

      if (!found && token.cursor !== undefined) {
        cursor = text.length
      }
      continue
    }

    openSpan()
    const start = text.length
    const opening = token.inner !== undefined ? '[[' : '['
    text += opening + token.content + (token.inner !== undefined ? ']' + token.inner.attrs : '') + ']' + token.attrs
    if (token.cursor !== undefined) {
      cursor = start + opening.length + token.cursor
    }
  }

  return failed ? undefined : { text, cursor }
}

/**
 * Rewrites one change by tokenising the affected region (the change plus the
 * revisions it touches and same-author spans it may merge with), applying the
 * editing rules to the tokens and writing them out again.
 *
 * @return  {Replacement|undefined}  The replacement, or undefined if the change
 *                                   must be applied directly
 */
function rewriteRegion (context: RewriteContext, revisions: RevisionRange[], a: number, b: number, text: string, insertCursor: number): Replacement|undefined {
  const { state } = context
  const included = revisions.filter(revision => {
    if (revision.from < b && a < revision.to) {
      return true
    }
    if (a === b) {
      return isOwnInsertion(context, revision) && (revision.from === a || revision.to === a)
    }
    if (revision.to === a) {
      return isOwnDeletion(context, revision)
    }
    if (revision.from === b) {
      return isOwnDeletion(context, revision) || (text !== '' && isOwnInsertion(context, revision))
    }
    return false
  })

  let regionFrom = Math.min(a, ...included.map(revision => revision.from))
  let regionTo = Math.max(b, ...included.map(revision => revision.to))

  // A deletion also takes in deletions of the current author that touch the
  // region, so that consecutive deletions become one span (rule 3); this
  // matters where the deleted character lies inside another span
  if (a < b) {
    for (let pass = 0; pass < 2; pass++) {
      const neighbours = findRevisionsInTree(state, context.tree, regionFrom, regionTo).filter(revision => {
        return (revision.to === regionFrom || revision.from === regionTo) &&
          isOwnDeletion(context, revision) &&
          !included.some(other => other.from === revision.from)
      })
      if (neighbours.length === 0) {
        break
      }
      included.push(...neighbours)
      included.sort((x, y) => x.from - y.from)
      regionFrom = Math.min(regionFrom, ...neighbours.map(revision => revision.from))
      regionTo = Math.max(regionTo, ...neighbours.map(revision => revision.to))
    }
  }

  // Include a character that changes the meaning of a following "[" so that
  // the serialisation can escape it or give up
  if (regionFrom > 0 && '!^]'.includes(state.sliceDoc(regionFrom - 1, regionFrom))) {
    regionFrom--
  }

  const cursorPosition = text !== '' ? -1 : (context.direction === 'forward' ? b : a)
  const tokens: Token[] = []
  let insertionPlaced = text === ''
  let cursorPlaced = text !== ''

  const placeInsertion = (): void => {
    if (!insertionPlaced) {
      tokens.push(freshSpan(context, 'insertion', text, insertCursor))
      insertionPlaced = true
    }
  }

  const placeCursor = (): void => {
    if (!cursorPlaced) {
      tokens.push({ type: 'cursor' })
      cursorPlaced = true
    }
  }

  const emitGap = (from: number, to: number): void => {
    const points = [...new Set([ from, to, a, b, cursorPosition ])]
      .filter(point => point >= from && point <= to)
      .sort((x, y) => x - y)
    for (let index = 0; index < points.length - 1; index++) {
      const x = points[index]
      const y = points[index + 1]
      if (x === b) {
        placeInsertion()
      }
      if (x === cursorPosition) {
        placeCursor()
      }
      if (x >= a && y <= b) {
        tokens.push(...plainDeletionTokens(context, x, y))
      } else {
        tokens.push({ type: 'text', text: state.sliceDoc(x, y) })
      }
    }
  }

  const emitSpan = (revision: RevisionRange): void => {
    const visibleFrom = revisionVisibleFrom(revision)
    const visibleTo = revisionVisibleTo(revision)
    const base = spanTokenOf(state, revision)
    const piece = (from: number, to: number): SpanToken => ({ ...base, content: state.sliceDoc(from, to) })

    if (b <= visibleFrom && !(a < b && b === revision.from && revision.kind === 'deletion')) {
      placeInsertion()
    }
    if (cursorPosition !== -1 && cursorPosition <= revision.from) {
      placeCursor()
    }

    const cut1 = clamp(a, visibleFrom, visibleTo)
    const cut2 = clamp(b, visibleFrom, visibleTo)

    if (revision.kind === 'insertion') {
      const own = isOwnInsertion(context, revision)
      if (cut1 > visibleFrom) {
        tokens.push(piece(visibleFrom, cut1))
      }
      if (!own && cut2 > cut1) {
        // Deleting someone else's insertion: nested deletion (rule 7)
        for (const segment of safeSegments(state.sliceDoc(cut1, cut2), 'deletion')) {
          if (segment.safe) {
            tokens.push(freshNestedDeletion(context, segment.text, base))
          }
        }
      }
      // Deleting from one's own insertion removes the text (rule 4)
      if (cut2 > visibleFrom && cut2 < visibleTo) {
        placeInsertion()
      }
      const cursorInside = cursorPosition > visibleFrom && cursorPosition < visibleTo
      const cursorAtRemoval = own && cut2 > cut1 && cursorPosition >= visibleFrom && cursorPosition <= visibleTo
      if (cursorInside || cursorAtRemoval) {
        placeCursor()
      }
      if (cut2 < visibleTo) {
        tokens.push(piece(cut2, visibleTo))
      }
      return
    }

    // A deletion: typing inside it splits it, deleting leaves it alone (rule 6)
    if (a === b && b > visibleFrom && b < visibleTo) {
      tokens.push(piece(visibleFrom, b))
      placeInsertion()
      tokens.push(piece(b, visibleTo))
      return
    }

    if (cursorPosition > revision.from && cursorPosition < revision.to && context.direction !== 'forward') {
      placeCursor()
    }
    tokens.push(base)
    if (b > revision.from && b < revision.to) {
      placeInsertion()
    }
    if (cursorPosition > revision.from && cursorPosition < revision.to) {
      placeCursor()
    }
  }

  let position = regionFrom
  for (const revision of included) {
    emitGap(position, revision.from)
    emitSpan(revision)
    position = revision.to
  }
  emitGap(position, regionTo)
  placeInsertion()
  placeCursor()

  let merged = mergeTokens(context, tokens)
  const isFresh = (token: Token): boolean => token.type === 'span' && token.fresh
  if (text === '' && merged.some(isFresh)) {
    // Backspace leaves the cursor in front of the deletion span, Delete behind
    // it (rule 3)
    merged = merged
      .filter(token => token.type !== 'cursor')
      .map(token => token.type === 'span' ? { ...token, cursor: undefined } : token)
    if (context.direction === 'forward') {
      let last = merged.length - 1
      while (last >= 0 && !isFresh(merged[last])) {
        last--
      }
      merged.splice(last + 1, 0, { type: 'cursor' })
    } else {
      merged.splice(merged.findIndex(isFresh), 0, { type: 'cursor' })
    }
  }
  merged = absorbCursors(context, merged)

  const serialized = serializeTokens(merged, state.sliceDoc(Math.max(0, regionFrom - ESCAPE_CONTEXT_LENGTH), regionFrom))
  if (serialized === undefined) {
    return undefined
  }

  const cursor = serialized.cursor ?? serialized.text.length
  if (serialized.text === state.sliceDoc(regionFrom, regionTo)) {
    return { from: regionFrom, to: regionFrom, insert: '', cursor, rewritten: true }
  }

  return { from: regionFrom, to: regionTo, insert: serialized.text, cursor, rewritten: true }
}

/**
 * Rewrites one change of a user transaction according to the editing rules.
 *
 * @param   {RewriteContext}  context       The rewrite context
 * @param   {number}          a             Change start in the start document
 * @param   {number}          b             Change end in the start document
 * @param   {string}          text          The inserted text
 * @param   {number}          insertCursor  Where the cursor sits within the
 *                                          inserted text
 * @param   {number}          depth         Recursion depth of retargeting
 *
 * @return  {Replacement}                   The replacement
 */
function rewriteChange (context: RewriteContext, a: number, b: number, text: string, insertCursor: number, depth: number): Replacement {
  const { state } = context
  const direct: Replacement = { from: a, to: b, insert: text, cursor: insertCursor, rewritten: false }
  const revisions = findRevisionsInTree(state, context.tree, a, b)

  if (a === b) {
    // A position inside hidden markup moves out of it
    let position = a
    for (const revision of revisions) {
      if (position > revision.from && position < revisionVisibleFrom(revision)) {
        position = revision.from
      } else if (position > revisionVisibleTo(revision) && position < revision.to) {
        position = revision.to
      }
    }

    if (position === a && isUntrackable(context, revisions, a, a)) {
      return direct
    }

    // Typing into one's own insertion extends it (rule 2)
    if (isSafeText(text)) {
      const own = revisions.find(revision => isOwnInsertion(context, revision) && revision.from <= position && position <= revision.to)
      if (own !== undefined) {
        const target = clamp(position, revisionVisibleFrom(own), revisionVisibleTo(own))
        return { from: target, to: target, insert: text, cursor: insertCursor, rewritten: target !== a }
      }
    }

    return rewriteRegion(context, revisions, position, position, text, insertCursor) ?? direct
  }

  if (isUntrackable(context, revisions, a, b)) {
    return direct
  }

  const originalCursor = context.direction === 'backward' ? b : a
  const unchanged: Replacement = { from: originalCursor, to: originalCursor, insert: '', cursor: 0, rewritten: true }

  if (text === '') {
    // A deletion that only hits the hidden markup of an insertion is turned
    // into the deletion of the neighbouring visible character
    const host = revisions.find(revision => revision.from <= a && b <= revision.to)
    if (host !== undefined && host.kind === 'insertion') {
      const visibleFrom = revisionVisibleFrom(host)
      const visibleTo = revisionVisibleTo(host)
      if (!(a < visibleTo && b > visibleFrom)) {
        if (depth > 0 || context.direction === 'none') {
          return unchanged
        }

        let target: [number, number]|undefined
        const backward = context.direction === 'backward'
        if (a >= visibleTo) {
          if (backward) {
            target = visibleTo > visibleFrom ? [ clusterStep(state, visibleTo, false), visibleTo ] : undefined
          } else {
            target = host.to < state.doc.length ? [ host.to, clusterStep(state, host.to, true) ] : undefined
          }
        } else if (backward) {
          target = host.from > 0 ? [ clusterStep(state, host.from, false), host.from ] : undefined
        } else {
          target = visibleTo > visibleFrom ? [ visibleFrom, clusterStep(state, visibleFrom, true) ] : undefined
        }

        if (target === undefined) {
          return unchanged
        }
        return rewriteChange(context, target[0], target[1], '', 0, depth + 1)
      }
    }
  }

  // Editing inside one's own insertion changes it directly (rules 4 and 8)
  const own = revisions.find(revision => {
    return isOwnInsertion(context, revision) && revisionVisibleFrom(revision) <= a && b <= revisionVisibleTo(revision)
  })
  if (own !== undefined && (text === '' || isSafeText(text)) && !UNSAFE_CHARACTERS.test(state.sliceDoc(a, b))) {
    const remaining = revisionVisibleTo(own) - revisionVisibleFrom(own) - (b - a) + text.length
    if (remaining > 0) {
      return { from: a, to: b, insert: text, cursor: insertCursor, rewritten: false }
    }
  }

  return rewriteRegion(context, revisions, a, b, text, insertCursor) ?? direct
}

/**
 * The region of a running input method composition while Track Changes is on:
 * [from, to] holds the composed text, `original` the text it replaced.
 */
interface PendingComposition {
  from: number
  to: number
  original: string
}

/**
 * Ends the pending composition (carried by its commit transaction)
 */
const finishCompositionEffect = StateEffect.define<null>()

/**
 * Whether a transaction belongs to a running composition: it is marked as
 * composition input by CodeMirror, or it is further input inside the region
 * of a composition that has not been committed yet.
 */
function isCompositionInput (transaction: Transaction, pending: PendingComposition|null): boolean {
  if (transaction.annotation(revisionTransaction) === true || !transaction.docChanged) {
    return false
  }
  if (transaction.isUserEvent('input.type.compose')) {
    return true
  }
  return pending !== null && transaction.isUserEvent('input') && transaction.changes.touchesRange(pending.from, pending.to) !== false
}

/**
 * Tracks the region of a composition that the Track Changes filter has let
 * through unchanged (Decision 107, problem 3): rewriting the text around a
 * running composition aborts it, so the composed text is only recorded as a
 * tracked change once the composition has ended (see commitTrackedComposition).
 */
const pendingCompositionField = StateField.define<PendingComposition|null>({
  create () {
    return null
  },
  update (value, transaction) {
    if (transaction.effects.some(effect => effect.is(finishCompositionEffect))) {
      return null
    }
    if (!transaction.startState.facet(trackChangesConfig).enabled) {
      return null
    }

    if (!isCompositionInput(transaction, value)) {
      if (value === null || !transaction.docChanged) {
        return value
      }
      const from = transaction.changes.mapPos(value.from, 1)
      return { ...value, from, to: Math.max(from, transaction.changes.mapPos(value.to, -1)) }
    }

    // Join the changed ranges of the start document with the pending region;
    // the parts outside the region are still original text
    const startState = transaction.startState
    let fromA = value?.from ?? Number.MAX_SAFE_INTEGER
    let toA = value?.to ?? -1
    transaction.changes.iterChangedRanges((changeFrom, changeTo) => {
      fromA = Math.min(fromA, changeFrom)
      toA = Math.max(toA, changeTo)
    })
    const original = value === null
      ? startState.sliceDoc(fromA, toA)
      : startState.sliceDoc(fromA, value.from) + value.original + startState.sliceDoc(value.to, toA)
    return {
      from: transaction.changes.mapPos(fromA, -1),
      to: transaction.changes.mapPos(toA, 1),
      original
    }
  }
})

/**
 * Builds the transaction that records a finished composition as a tracked
 * change: the composed text is treated as if it had been typed in one go over
 * the text it replaced, according to the editing rules.
 *
 * @param   {EditorState}           state  The state after the composition
 *
 * @return  {TransactionSpec|null}         The commit, or null if no
 *                                         composition is pending
 */
export function commitTrackedComposition (state: EditorState): TransactionSpec|null {
  const pending = state.field(pendingCompositionField, false) ?? null
  if (pending === null) {
    return null
  }

  const finish = finishCompositionEffect.of(null)
  const composed = state.sliceDoc(pending.from, pending.to)
  if (!state.facet(trackChangesConfig).enabled || composed === pending.original) {
    return { effects: finish }
  }

  // The state as it was before the composition, then the composed text typed
  // into it through the Track Changes filter
  const restore = state.update({
    changes: { from: pending.from, to: pending.to, insert: pending.original },
    effects: finish,
    annotations: revisionTransaction.of(true),
    filter: false
  })
  const head = state.selection.main.head
  const insertCursor = head >= pending.from && head <= pending.to ? head - pending.from : composed.length
  const typing = restore.state.update({
    changes: { from: pending.from, to: pending.from + pending.original.length, insert: composed },
    selection: EditorSelection.cursor(pending.from + insertCursor),
    userEvent: 'input.type',
    filter: false
  })
  const rewritten = trackRevisionChanges(typing)
  if (rewritten instanceof Transaction || Array.isArray(rewritten)) {
    // Typed as it is (for example inside an own insertion or inside code):
    // the composed text already stands where it belongs
    return { effects: finish }
  }

  const spec = rewritten as TransactionSpec
  return {
    changes: restore.changes.compose(spec.changes as ChangeSet),
    selection: spec.selection as EditorSelection,
    effects: finish,
    annotations: [ revisionTransaction.of(true), Transaction.userEvent.of('input.type') ],
    scrollIntoView: true
  }
}

/**
 * Commits a pending composition as soon as the editor no longer composes:
 * after the update that ends the composition or after the compositionend event.
 */
const compositionCommitter = ViewPlugin.fromClass(class {
  private scheduled = false
  private destroyed = false

  constructor (private readonly view: EditorView) {}

  update (update: ViewUpdate): void {
    if (update.state.field(pendingCompositionField, false) != null && !update.view.composing) {
      this.schedule()
    }
  }

  schedule (): void {
    if (this.scheduled) {
      return
    }
    this.scheduled = true
    // After CodeMirror has flushed the last composition change
    setTimeout(() => {
      this.scheduled = false
      if (this.destroyed || this.view.composing || this.view.state.readOnly) {
        return
      }
      const commit = commitTrackedComposition(this.view.state)
      if (commit !== null) {
        this.view.dispatch(commit)
      }
    }, 0)
  }

  destroy (): void {
    this.destroyed = true
  }
}, {
  eventHandlers: {
    compositionend () {
      this.schedule()
    }
  }
})

/**
 * Rewrites a user transaction into tracked changes according to the editing
 * rules of spec C10. Only typing, pasting, dropping and deleting (user events
 * "input", "delete" and "move.drop") are rewritten, and only while Track
 * Changes is on; every other transaction passes unchanged, as does one that
 * already carries the revisionTransaction annotation. Input that belongs to a
 * running composition passes unchanged as well and is recorded when the
 * composition ends (commitTrackedComposition).
 *
 * @param   {Transaction}  transaction  The transaction
 *
 * @return  {TransactionSpec|readonly TransactionSpec[]|Transaction}  The
 *                                        rewritten transaction, or the original
 */
export function trackRevisionChanges (transaction: Transaction): TransactionSpec|readonly TransactionSpec[]|Transaction {
  if (!transaction.docChanged || transaction.annotation(revisionTransaction) === true) {
    return transaction
  }

  const config = transaction.startState.facet(trackChangesConfig)
  if (!config.enabled) {
    return transaction
  }

  const userEvent = transaction.annotation(Transaction.userEvent)
  if (userEvent === undefined || ![ 'input', 'delete', 'move.drop' ].some(event => transaction.isUserEvent(event))) {
    return transaction
  }

  const state = transaction.startState
  if (isCompositionInput(transaction, state.field(pendingCompositionField, false) ?? null)) {
    return transaction
  }

  let direction: Direction = 'none'
  if (transaction.isUserEvent('delete.backward')) {
    direction = 'backward'
  } else if (transaction.isUserEvent('delete.forward')) {
    direction = 'forward'
  }

  const context: RewriteContext = {
    state,
    tree: ensureSyntaxTree(state, state.doc.length, PARSE_TIMEOUT) ?? syntaxTree(state),
    author: normalizeAuthor(config.author),
    date: formatRevisionDate(config.now()),
    direction
  }

  const newSelection = transaction.newSelection
  const changes: Array<{ fromA: number, toA: number, fromB: number, toB: number, text: string }> = []
  transaction.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    changes.push({ fromA, toA, fromB, toB, text: inserted.toString() })
  })

  const replacements = changes.map(change => {
    const range = newSelection.ranges.find(range => range.head >= change.fromB && range.head <= change.toB)
    const insertCursor = range !== undefined ? range.head - change.fromB : change.text.length
    const replacement = rewriteChange(context, change.fromA, change.toA, change.text, insertCursor, 0)
    // A change that was moved elsewhere (for example out of hidden markup)
    // counts as rewritten even if it is applied as it is at its new place
    const moved = replacement.from !== change.fromA || replacement.to !== change.toA || replacement.insert !== change.text
    return { ...replacement, rewritten: replacement.rewritten || moved }
  })

  if (replacements.every(replacement => !replacement.rewritten)) {
    return transaction
  }

  for (let index = 1; index < replacements.length; index++) {
    if (replacements[index].from < replacements[index - 1].to) {
      // Two changes would rewrite the same region: apply the edit as it is
      return transaction
    }
  }

  const changeSet = ChangeSet.of(
    replacements
      .filter(replacement => replacement.from !== replacement.to || replacement.insert !== '')
      .map(replacement => ({ from: replacement.from, to: replacement.to, insert: replacement.insert })),
    state.doc.length
  )

  const cursors: number[] = []
  let delta = 0
  for (const replacement of replacements) {
    cursors.push(replacement.from + delta + replacement.cursor)
    delta += replacement.insert.length - (replacement.to - replacement.from)
  }

  const mapPosition = (position: number): number => {
    return changeSet.mapPos(transaction.changes.invertedDesc.mapPos(position, -1), 1)
  }
  const ranges = newSelection.ranges.map(range => {
    const index = changes.findIndex(change => range.head >= change.fromB && range.head <= change.toB)
    if (index >= 0) {
      return EditorSelection.cursor(cursors[index])
    }
    return EditorSelection.range(mapPosition(range.anchor), mapPosition(range.head))
  })

  const annotations = [ revisionTransaction.of(true), Transaction.userEvent.of(userEvent) ]
  const addToHistory = transaction.annotation(Transaction.addToHistory)
  if (addToHistory !== undefined) {
    annotations.push(Transaction.addToHistory.of(addToHistory))
  }
  const historyIsolation = transaction.annotation(isolateHistory)
  if (historyIsolation !== undefined) {
    annotations.push(isolateHistory.of(historyIsolation))
  }

  return {
    changes: changeSet,
    selection: EditorSelection.create(ranges, newSelection.mainIndex),
    effects: transaction.effects,
    annotations,
    scrollIntoView: transaction.scrollIntoView
  }
}

/**
 * The Track Changes extension: the transaction filter and, while Track Changes
 * is on, atomic ranges over the hidden revision markup (rule 10). The
 * configuration comes from the trackChangesConfig facet; a configuration given
 * here is added to it.
 *
 * @param   {TrackChangesConfig}  config  Optional configuration
 *
 * @return  {Extension}                   The extension
 */
export function trackChangesExtension (config?: TrackChangesConfig): Extension {
  return [
    config !== undefined ? trackChangesConfig.of(config) : [],
    EditorState.transactionFilter.of(trackRevisionChanges),
    pendingCompositionField,
    compositionCommitter,
    EditorView.atomicRanges.of(view => {
      return view.state.facet(trackChangesConfig).enabled ? revisionMarkupRanges(view.state) : RangeSet.empty
    })
  ]
}
