/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Revision model for the Track Changes mode
 * CVM-Role:        Utility function
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH: recognises, formats, accepts and rejects tracked
 *                  changes stored as Pandoc spans, for example
 *                  "[new]{.insertion author="A" date="2026-10-13T09:00:00Z"}"
 *                  and "[old]{.deletion author="A" date="…"}", including the
 *                  nested form "[[x]{.insertion …}]{.deletion …}" that records
 *                  the deletion of someone else's insertion (spec C10).
 *
 * END HEADER
 */

import {
  EditorSelection,
  EditorState,
  type ChangeSpec,
  type Extension,
  type TransactionSpec
} from '@codemirror/state'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { SyntaxNode, Tree } from '@lezer/common'
import markdownParser from '../parser/markdown-parser'

/**
 * The two kinds of tracked changes
 */
export type RevisionKind = 'insertion' | 'deletion'

/**
 * One tracked change in a document. `from` and `to` cover the whole span
 * including its brackets and attribute block, `contentFrom` and `contentTo`
 * cover the text between the brackets. `nested` is the inner insertion of a
 * deletion that wraps someone else's insertion.
 */
export interface RevisionRange {
  kind: RevisionKind
  from: number
  to: number
  contentFrom: number
  contentTo: number
  author: string|undefined
  date: string|undefined
  nested: RevisionRange|undefined
}

/**
 * The parsed attribute block of a revision span
 */
export interface RevisionAttributes {
  kind: RevisionKind
  author: string|undefined
  date: string|undefined
}

/**
 * Time budget (milliseconds) for completing the syntax tree before revisions
 * are searched
 */
const PARSE_TIMEOUT = 500

/**
 * Time budget (milliseconds) for parsing a whole Markdown text in the plain
 * text functions acceptAllRevisions and rejectAllRevisions
 */
const TEXT_PARSE_TIMEOUT = 10000

/**
 * Upper bound of accept or reject passes in the plain text functions. A second
 * pass is needed when a pass uncovers a revision, for example the insertion
 * restored by rejecting a nested deletion.
 */
const MAX_TEXT_PASSES = 4

/**
 * Parses a Pandoc attribute block such as `{.insertion author="A \"B\""}`.
 * Quoted values may contain backslash escapes, which are resolved.
 *
 * @param   {string}  block  The attribute block, with or without its braces
 *
 * @return  {{ classes: string[], properties: Map<string, string> }}  The parts
 */
function parseAttributeBlock (block: string): { classes: string[], properties: Map<string, string> } {
  let text = block.trim()
  if (text.startsWith('{')) {
    text = text.slice(1)
  }
  if (text.endsWith('}')) {
    text = text.slice(0, -1)
  }

  const classes: string[] = []
  const properties = new Map<string, string>()
  let index = 0
  const readBareWord = (): string => {
    const start = index
    while (index < text.length && !/[\s=]/.test(text[index])) {
      index++
    }
    return text.slice(start, index)
  }

  while (index < text.length) {
    if (/\s/.test(text[index])) {
      index++
      continue
    }

    if (text[index] === '.') {
      index++
      classes.push(readBareWord())
      continue
    }

    if (text[index] === '#') {
      index++
      readBareWord()
      continue
    }

    const key = readBareWord()
    if (index >= text.length || text[index] !== '=') {
      // A key without a value, or a stray character: skip it
      if (key === '') {
        index++
      }
      continue
    }

    index++ // The equals sign
    if (text[index] === '"') {
      index++
      let value = ''
      while (index < text.length && text[index] !== '"') {
        if (text[index] === '\\' && index + 1 < text.length) {
          index++
        }
        value += text[index]
        index++
      }
      index++ // The closing quotation mark
      properties.set(key, value)
    } else {
      const start = index
      while (index < text.length && !/\s/.test(text[index])) {
        index++
      }
      properties.set(key, text.slice(start, index))
    }
  }

  return { classes, properties }
}

/**
 * Determines whether an attribute block marks a revision (spec C10, storage
 * format item 4): exactly one of the classes `insertion` and `deletion` must
 * be present; the order of the items does not matter and other classes and
 * attributes are allowed.
 *
 * @param   {string}  block  The attribute block, with or without its braces
 *
 * @return  {RevisionAttributes|undefined}  The revision attributes, or
 *                                          undefined for an ordinary span
 */
export function parseRevisionAttributes (block: string): RevisionAttributes|undefined {
  const { classes, properties } = parseAttributeBlock(block)
  const isInsertion = classes.includes('insertion')
  const isDeletion = classes.includes('deletion')
  if (isInsertion === isDeletion) {
    return undefined
  }

  return {
    kind: isInsertion ? 'insertion' : 'deletion',
    author: properties.get('author'),
    date: properties.get('date')
  }
}

/**
 * Builds the revision described by a PandocSpan syntax node.
 *
 * @param   {EditorState}  state  The state the node belongs to
 * @param   {SyntaxNode}   node   A PandocSpan node
 *
 * @return  {RevisionRange|undefined}  The revision, or undefined if the span is
 *                                     not a revision
 */
function revisionFromNode (state: EditorState, node: SyntaxNode): RevisionRange|undefined {
  const opening = node.firstChild
  const attribute = node.lastChild
  if (opening === null || attribute === null || opening.name !== 'PandocSpanMark' || attribute.name !== 'PandocAttribute') {
    return undefined
  }

  const closing = attribute.prevSibling
  if (closing === null || closing.name !== 'PandocSpanMark' || closing.from <= opening.from) {
    return undefined
  }

  const attributes = parseRevisionAttributes(state.sliceDoc(attribute.from, attribute.to))
  if (attributes === undefined) {
    return undefined
  }

  const revision: RevisionRange = {
    kind: attributes.kind,
    from: node.from,
    to: node.to,
    contentFrom: opening.to,
    contentTo: closing.from,
    author: attributes.author,
    date: attributes.date,
    nested: undefined
  }

  if (revision.kind === 'deletion') {
    // A deletion whose whole content is one insertion span records the
    // deletion of someone else's insertion (storage format item 8)
    const child = opening.nextSibling
    if (child !== null && child.name === 'PandocSpan' && child.from === opening.to && child.to === closing.from) {
      const inner = revisionFromNode(state, child)
      if (inner !== undefined && inner.kind === 'insertion') {
        revision.nested = inner
      }
    }
  }

  return revision
}

/**
 * Finds the revisions in a syntax tree that touch the range [from, to] (both
 * ends inclusive). Only the outer revisions are returned; the inner insertion
 * of a nested deletion is available as its `nested` property.
 *
 * @param   {EditorState}      state  The state
 * @param   {Tree}             tree   The syntax tree of the state
 * @param   {number}           from   Range start
 * @param   {number}           to     Range end
 *
 * @return  {RevisionRange[]}         The revisions, sorted by position
 */
export function findRevisionsInTree (state: EditorState, tree: Tree, from: number, to: number): RevisionRange[] {
  const revisions: RevisionRange[] = []
  tree.iterate({
    from: Math.max(0, from - 1),
    to: Math.min(state.doc.length, to + 1),
    enter: (node) => {
      if (node.name !== 'PandocSpan') {
        return undefined
      }

      const revision = revisionFromNode(state, node.node)
      if (revision === undefined) {
        // An ordinary span may contain revisions
        return undefined
      }

      if (revision.to >= from && revision.from <= to) {
        revisions.push(revision)
      }

      return false
    }
  })

  return revisions.sort((a, b) => a.from - b.from)
}

/**
 * Finds all revisions that touch the range [from, to] (both ends inclusive),
 * judged by the syntax tree: text in code, math, the YAML frontmatter or HTML
 * comments is never a revision. Only outer revisions are returned.
 *
 * @param   {EditorState}      state  The state
 * @param   {number}           from   Range start (default: document start)
 * @param   {number}           to     Range end (default: document end)
 *
 * @return  {RevisionRange[]}         The revisions, sorted by position
 */
export function findRevisions (state: EditorState, from: number = 0, to: number = state.doc.length): RevisionRange[] {
  const tree = ensureSyntaxTree(state, state.doc.length, PARSE_TIMEOUT) ?? syntaxTree(state)
  return findRevisionsInTree(state, tree, from, to)
}

/**
 * Finds the first revision whose start lies strictly behind a position.
 *
 * @param   {EditorState}               state     The state
 * @param   {number}                    position  The position
 *
 * @return  {RevisionRange|undefined}             The revision, if any
 */
export function findNextRevision (state: EditorState, position: number): RevisionRange|undefined {
  return findRevisions(state, position, state.doc.length).find(revision => revision.from > position)
}

/**
 * Escapes a value for a quoted Pandoc attribute (storage format item 5).
 *
 * @param   {string}  value  The raw value
 *
 * @return  {string}         The escaped value
 */
function escapeAttributeValue (value: string): string {
  return value
    .replace(/[\r\n\t]/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
}

/**
 * Formats the attribute block of a revision span: class, author and date, in
 * this order (storage format item 4).
 *
 * @param   {RevisionKind}  kind    The revision kind
 * @param   {string}        author  The author name
 * @param   {string}        date    The date as made by formatRevisionDate
 *
 * @return  {string}                The attribute block including its braces
 */
export function formatRevisionAttributes (kind: RevisionKind, author: string, date: string): string {
  return `{.${kind} author="${escapeAttributeValue(author)}" date="${date}"}`
}

/**
 * Formats a revision span (storage format items 4 to 6).
 *
 * @param   {RevisionKind}  kind     The revision kind
 * @param   {string}        content  The inserted or deleted text
 * @param   {string}        author   The author name
 * @param   {string}        date     The date as made by formatRevisionDate
 *
 * @return  {string}                 The span markup
 */
export function formatRevisionSpan (kind: RevisionKind, content: string, author: string, date: string): string {
  return `[${content}]${formatRevisionAttributes(kind, author, date)}`
}

/**
 * Formats a time as coordinated universal time, `YYYY-MM-DDTHH:MM:SSZ`
 * (storage format item 6).
 *
 * @param   {Date}    time  The time
 *
 * @return  {string}        The formatted time
 */
export function formatRevisionDate (time: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(time.getUTCFullYear()).padStart(4, '0')}-${pad(time.getUTCMonth() + 1)}-${pad(time.getUTCDate())}` +
    `T${pad(time.getUTCHours())}:${pad(time.getUTCMinutes())}:${pad(time.getUTCSeconds())}Z`
}

/**
 * The position where the visible text of a revision starts (for a nested
 * deletion, the content of its inner insertion).
 *
 * @param   {RevisionRange}  revision  The revision
 *
 * @return  {number}                   The position
 */
export function revisionVisibleFrom (revision: RevisionRange): number {
  return revision.nested?.contentFrom ?? revision.contentFrom
}

/**
 * The position where the visible text of a revision ends.
 *
 * @param   {RevisionRange}  revision  The revision
 *
 * @return  {number}                   The position
 */
export function revisionVisibleTo (revision: RevisionRange): number {
  return revision.nested?.contentTo ?? revision.contentTo
}

/**
 * The changes that remove the markup of a span and keep its content.
 */
function unwrapChanges (revision: RevisionRange): ChangeSpec[] {
  return [
    { from: revision.from, to: revision.contentFrom },
    { from: revision.contentTo, to: revision.to }
  ]
}

/**
 * The changes that accept one revision (accept and reject items 1 to 3).
 */
function acceptChanges (revision: RevisionRange): ChangeSpec[] {
  if (revision.kind === 'insertion') {
    return unwrapChanges(revision)
  }

  return [{ from: revision.from, to: revision.to }]
}

/**
 * The changes that reject one revision (accept and reject items 1 to 3).
 */
function rejectChanges (revision: RevisionRange): ChangeSpec[] {
  if (revision.kind === 'insertion') {
    return [{ from: revision.from, to: revision.to }]
  }

  if (revision.nested !== undefined) {
    // Restore the inner insertion span
    return [
      { from: revision.from, to: revision.nested.from },
      { from: revision.nested.to, to: revision.to }
    ]
  }

  return unwrapChanges(revision)
}

/**
 * Computes the transaction that accepts one revision.
 *
 * @param   {EditorState}      state     The state
 * @param   {RevisionRange}    revision  The revision, as found in the state
 *
 * @return  {TransactionSpec}            The transaction
 */
export function acceptRevision (state: EditorState, revision: RevisionRange): TransactionSpec {
  return { changes: state.changes(acceptChanges(revision)) }
}

/**
 * Computes the transaction that rejects one revision.
 *
 * @param   {EditorState}      state     The state
 * @param   {RevisionRange}    revision  The revision, as found in the state
 *
 * @return  {TransactionSpec}            The transaction
 */
export function rejectRevision (state: EditorState, revision: RevisionRange): TransactionSpec {
  return { changes: state.changes(rejectChanges(revision)) }
}

/**
 * Selects the revisions a range acts on: for an empty range, those whose span
 * contains the position (both ends inclusive); otherwise those that overlap
 * the range.
 */
function revisionsForRange (revisions: RevisionRange[], from: number, to: number): RevisionRange[] {
  if (from === to) {
    return revisions.filter(revision => revision.from <= from && from <= revision.to)
  }

  return revisions.filter(revision => revision.from < to && from < revision.to)
}

/**
 * Builds the transaction that accepts or rejects all revisions a range acts on.
 */
function actOnRange (state: EditorState, from: number, to: number, action: 'accept'|'reject'): TransactionSpec|null {
  const start = Math.min(from, to)
  const end = Math.max(from, to)
  const revisions = revisionsForRange(findRevisions(state, start, end), start, end)
  if (revisions.length === 0) {
    return null
  }

  const changes = revisions.flatMap(action === 'accept' ? acceptChanges : rejectChanges)
  return { changes: state.changes(changes) }
}

/**
 * Computes the transaction that accepts every revision in a range. An empty
 * range acts on the revision that contains the position.
 *
 * @param   {EditorState}            state  The state
 * @param   {number}                 from   Range start
 * @param   {number}                 to     Range end
 *
 * @return  {TransactionSpec|null}          The transaction, or null if the
 *                                          range contains no revision
 */
export function acceptRevisionsInRange (state: EditorState, from: number, to: number): TransactionSpec|null {
  return actOnRange(state, from, to, 'accept')
}

/**
 * Computes the transaction that rejects every revision in a range. An empty
 * range acts on the revision that contains the position.
 *
 * @param   {EditorState}            state  The state
 * @param   {number}                 from   Range start
 * @param   {number}                 to     Range end
 *
 * @return  {TransactionSpec|null}          The transaction, or null if the
 *                                          range contains no revision
 */
export function rejectRevisionsInRange (state: EditorState, from: number, to: number): TransactionSpec|null {
  return actOnRange(state, from, to, 'reject')
}

/**
 * Computes the transaction of the toolbar buttons Accept and Reject (accept
 * and reject item 4): process the revisions the selection acts on and move the
 * cursor to the visible start of the next revision behind them, or stay at the
 * processed place when there is none; with no revision under a plain cursor,
 * leave the document alone and select the visible text of the next revision.
 *
 * @param   {EditorState}            state   The state
 * @param   {'accept'|'reject'}      action  The action
 *
 * @return  {TransactionSpec|null}           The transaction, or null if there
 *                                           is nothing to process and no
 *                                           revision behind the selection
 */
export function revisionActionAtSelection (state: EditorState, action: 'accept'|'reject'): TransactionSpec|null {
  const revisions = findRevisions(state)
  const targets = revisions.filter(revision => state.selection.ranges.some(range => {
    return revisionsForRange([revision], range.from, range.to).length > 0
  }))

  if (targets.length > 0) {
    const changes = state.changes(targets.flatMap(action === 'accept' ? acceptChanges : rejectChanges))
    const last = targets[targets.length - 1]
    const next = revisions.find(revision => revision.from >= last.to && !targets.includes(revision))
    const cursor = next !== undefined
      ? changes.mapPos(revisionVisibleFrom(next), 1)
      : changes.mapPos(last.to, -1)
    return { changes, selection: EditorSelection.cursor(cursor), scrollIntoView: true }
  }

  const main = state.selection.main
  const next = revisions.find(revision => revision.from > main.to)
  if (next === undefined) {
    return null
  }

  return {
    selection: EditorSelection.range(revisionVisibleFrom(next), revisionVisibleTo(next)),
    scrollIntoView: true
  }
}

/**
 * Accepts or rejects every revision of a Markdown text.
 */
function actOnText (markdown: string, action: 'accept'|'reject'): string {
  const extensions: Extension[] = [markdownParser()]
  if (markdown.includes('\r\n')) {
    extensions.push(EditorState.lineSeparator.of('\r\n'))
  }

  let state = EditorState.create({ doc: markdown, extensions })
  let changed = false
  for (let pass = 0; pass < MAX_TEXT_PASSES; pass++) {
    const tree = ensureSyntaxTree(state, state.doc.length, TEXT_PARSE_TIMEOUT) ?? syntaxTree(state)
    const revisions = findRevisionsInTree(state, tree, 0, state.doc.length)
    if (revisions.length === 0) {
      break
    }

    state = state.update({ changes: revisions.flatMap(action === 'accept' ? acceptChanges : rejectChanges) }).state
    changed = true
  }

  return changed ? state.sliceDoc() : markdown
}

/**
 * Returns a Markdown text with every revision accepted: insertions keep their
 * text without markup, deletions disappear. A text without revisions is
 * returned unchanged.
 *
 * @param   {string}  markdown  The Markdown text
 *
 * @return  {string}            The text with all revisions accepted
 */
export function acceptAllRevisions (markdown: string): string {
  return actOnText(markdown, 'accept')
}

/**
 * Returns a Markdown text with every revision rejected: insertions disappear,
 * deletions keep their text without markup. A text without revisions is
 * returned unchanged.
 *
 * @param   {string}  markdown  The Markdown text
 *
 * @return  {string}            The text with all revisions rejected
 */
export function rejectAllRevisions (markdown: string): string {
  return actOnText(markdown, 'reject')
}
