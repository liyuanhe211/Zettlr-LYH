/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Reading, locating, and rewriting the directive comments of
 *                  the PPTX renderer (`<!-- style: … -->`, `<!-- table: … -->`,
 *                  `<!-- page: … -->`) that stand directly before a block
 *
 * Description:     A directive comment applies to the block that follows it.
 *                  It must form a block of its own: it starts at the start of
 *                  a line, is preceded by a blank line, the start of the
 *                  document, the opening line of a fenced div, or another such
 *                  comment, and is separated from the next comment or the
 *                  block by at most one blank line. Several comments may stand
 *                  before one block (a `style:` and a `table:` directive, or a
 *                  page-record comment such as `<!-- 新第 3 页 -->`); each
 *                  directive kind is looked up separately along that run of
 *                  comments. A new directive is inserted directly before the
 *                  block, i.e. after any comments already there, so that a
 *                  page-record comment keeps its place.
 *
 * END HEADER
 */

import type { ChangeSpec, EditorState } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'
import type { PandocAttributeKey } from './pandoc-attribute-schema'
import { readAttributeValues, updateAttributeList } from './pandoc-brace-attributes'

/**
 * `<!--`, optional whitespace, the prefix, optional whitespace, `:`, the
 * arguments, `-->`, optional whitespace -- the same shape the renderer accepts
 */
const DIRECTIVE_COMMENT = /^(<!--\s*([A-Za-z][\w-]*)\s*:)([\s\S]*?)(-->\s*)$/

export interface ParsedDirectiveComment {
  /** The directive prefix in lower case, e.g. 'table' */
  prefix: string
  /** The text up to and including the colon, verbatim (e.g. `<!-- Table:`) */
  head: string
  /** The argument text between the colon and `-->`, verbatim */
  argumentText: string
  /** `-->` and any whitespace after it */
  tail: string
}

/**
 * Parses the text of an HTML comment as a directive comment.
 *
 * @param   {string}  text  The full comment text, `<!-- … -->`
 *
 * @return  {ParsedDirectiveComment|undefined}  The parts, or undefined if the
 *                                              comment is no directive
 */
export function parseDirectiveComment (text: string): ParsedDirectiveComment|undefined {
  const match = DIRECTIVE_COMMENT.exec(text)
  if (match === null) {
    return undefined
  }
  return { prefix: match[2].toLowerCase(), head: match[1], argumentText: match[3], tail: match[4] }
}

/**
 * Whether a line is the opening line of a fenced div (a block after it needs
 * no blank line in between to stand on its own)
 */
function isDivOpeningLine (text: string): boolean {
  return /^\s*:{3,}/.test(text)
}

/**
 * Counts the line breaks in a text
 */
function countLineBreaks (text: string): number {
  return text.split('\n').length - 1
}

/**
 * Whether a comment block forms a block of its own (see the module header).
 */
function commentStandsAlone (state: EditorState, comment: SyntaxNode): boolean {
  const line = state.doc.lineAt(comment.from)
  if (state.sliceDoc(line.from, comment.from).trim() !== '') {
    return false
  }
  if (line.number === 1) {
    return true
  }
  const previousLine = state.doc.line(line.number - 1)
  if (previousLine.text.trim() === '' || isDivOpeningLine(previousLine.text)) {
    return true
  }
  const previous = comment.prevSibling
  if (previous !== null && previous.name === 'CommentBlock' && previous.to >= previousLine.from) {
    return commentStandsAlone(state, previous)
  }
  return false
}

/**
 * Whether the gap between the end of a comment and the start of the next
 * node allows the comment to apply to that node: whitespace only, at least
 * one and at most two line breaks (i.e. at most one blank line).
 */
function isDirectiveGap (gap: string): boolean {
  if (gap.trim() !== '') {
    return false
  }
  const lineBreaks = countLineBreaks(gap)
  return lineBreaks >= 1 && lineBreaks <= 2
}

export interface LocatedDirectiveComment {
  node: SyntaxNode
  parsed: ParsedDirectiveComment
}

/**
 * Finds the directive comment of the given prefix that applies to a block:
 * walks back along the run of comments directly before the block and returns
 * the nearest one with the prefix.
 *
 * @param   {EditorState}  state   The editor state
 * @param   {SyntaxNode}   block   The block node
 * @param   {string}       prefix  The directive prefix, e.g. 'style'
 *
 * @return  {LocatedDirectiveComment|undefined}  The comment, if any
 */
export function findDirectiveComment (state: EditorState, block: SyntaxNode, prefix: string): LocatedDirectiveComment|undefined {
  let current = block
  let sibling = block.prevSibling
  while (sibling !== null && sibling.name === 'CommentBlock') {
    if (!isDirectiveGap(state.sliceDoc(sibling.to, current.from)) || !commentStandsAlone(state, sibling)) {
      return undefined
    }
    const parsed = parseDirectiveComment(state.sliceDoc(sibling.from, sibling.to))
    if (parsed !== undefined && parsed.prefix === prefix.toLowerCase()) {
      return { node: sibling, parsed }
    }
    current = sibling
    sibling = sibling.prevSibling
  }
  return undefined
}

/**
 * Reads the values of the directive of the given prefix before a block.
 */
export function readDirectiveValues (state: EditorState, block: SyntaxNode, prefix: string, keys: PandocAttributeKey[]): Record<string, string> {
  const located = findDirectiveComment(state, block, prefix)
  if (located === undefined) {
    return {}
  }
  return readAttributeValues(located.parsed.argumentText, 'directive', keys)
}

/**
 * The range that removes a comment together with its line break and one
 * following blank line
 */
function commentRemovalRange (state: EditorState, comment: SyntaxNode): { from: number, to: number } {
  const firstLine = state.doc.lineAt(comment.from)
  const lastLine = state.doc.lineAt(comment.to)
  let to = lastLine.number < state.doc.lines ? lastLine.to + 1 : lastLine.to
  if (lastLine.number < state.doc.lines) {
    const nextLine = state.doc.line(lastLine.number + 1)
    if (nextLine.text.trim() === '') {
      to = nextLine.number < state.doc.lines ? nextLine.to + 1 : nextLine.to
    }
  }
  // At the very end of the document, remove the line break before instead
  const from = to === state.doc.length && firstLine.number > 1 && lastLine.number === state.doc.lines
    ? firstLine.from - 1
    : firstLine.from
  return { from, to }
}

/**
 * Returns the smallest change turning `oldText` (at `offset`) into `newText`
 */
export function minimalChange (offset: number, oldText: string, newText: string): ChangeSpec[] {
  if (oldText === newText) {
    return []
  }
  let prefixLength = 0
  const maximum = Math.min(oldText.length, newText.length)
  while (prefixLength < maximum && oldText[prefixLength] === newText[prefixLength]) {
    prefixLength++
  }
  let suffixLength = 0
  while (
    suffixLength < maximum - prefixLength &&
    oldText[oldText.length - 1 - suffixLength] === newText[newText.length - 1 - suffixLength]
  ) {
    suffixLength++
  }
  return [{
    from: offset + prefixLength,
    to: offset + oldText.length - suffixLength,
    insert: newText.slice(prefixLength, newText.length - suffixLength)
  }]
}

/**
 * Builds the changes that apply an update to the directive of the given
 * prefix before a block: rewrites an existing directive in place (removing
 * it with one following blank line when no key remains), or inserts a new
 * directive plus a blank line directly before the block.
 *
 * @param   {EditorState}           state   The editor state
 * @param   {SyntaxNode}            block   The block the directive applies to
 * @param   {string}                prefix  The directive prefix
 * @param   {PandocAttributeKey[]}  keys    The catalog of the object kind
 * @param   {Record}                update  The update to apply
 *
 * @return  {ChangeSpec[]}                  The changes (empty if none)
 */
export function buildDirectiveChanges (
  state: EditorState,
  block: SyntaxNode,
  prefix: string,
  keys: PandocAttributeKey[],
  update: Record<string, string|undefined>
): ChangeSpec[] {
  const located = findDirectiveComment(state, block, prefix)

  if (located !== undefined) {
    const { node, parsed } = located
    const result = updateAttributeList(parsed.argumentText, 'directive', keys, update)
    if (!result.changed) {
      return []
    }
    if (result.empty) {
      return [commentRemovalRange(state, node)]
    }
    const oldText = state.sliceDoc(node.from, node.to)
    return minimalChange(node.from, oldText, parsed.head + result.text + parsed.tail)
  }

  const result = updateAttributeList('', 'directive', keys, update)
  if (result.empty) {
    return []
  }

  const line = state.doc.lineAt(block.from)
  let blankLineBefore = ''
  if (line.number > 1) {
    const previousLine = state.doc.line(line.number - 1)
    if (previousLine.text.trim() !== '' && !isDivOpeningLine(previousLine.text)) {
      blankLineBefore = '\n'
    }
  }
  return [{ from: line.from, insert: `${blankLineBefore}<!-- ${prefix}: ${result.core} -->\n\n` }]
}
