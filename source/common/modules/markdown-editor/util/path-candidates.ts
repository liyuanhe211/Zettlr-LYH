/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Path candidates
 * CVM-Role:        Utility
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Finds the Windows paths in the visible part of a Markdown
 *                  document after which the editor shows a folder button
 *                  (R100, spec C12 part 1): inline code that consists of
 *                  exactly one absolute path, and drive paths written as
 *                  plain text outside code, links, HTML, comments, math,
 *                  front matter, wiki links and citations. Only the syntax
 *                  tree and the source are read; the document stays as it is.
 *
 * END HEADER
 */

import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'

/**
 * A path found in the document
 */
export interface PathCandidate {
  /** The path sent to main: the source with forward slashes as backslashes */
  path: string
  /** The cache key, shared by all spellings of the same path */
  key: string
  /** The document position after which the button sits */
  at: number
}

/**
 * At most this many candidates are returned per computation (spec C12 1.4)
 */
export const MAXIMUM_PATH_CANDIDATES = 500

/**
 * The longest path that still counts as a path (spec C12 1.3)
 */
export const MAXIMUM_PATH_LENGTH = 32767

/**
 * Plain text paths that overlap one of these nodes are dropped as a whole
 * (spec C12 1.2). Inline math is an `InlineCode` node and block math a
 * `FencedCode` node of this project's parser; `InlineCode` nodes are also
 * where inline code paths come from.
 */
export const PATH_EXCLUDING_NODES: ReadonlySet<string> = new Set([
  'InlineCode', 'FencedCode', 'CodeBlock',
  'Link', 'Image', 'URL', 'Autolink', 'LinkReference',
  'HTMLTag', 'HTMLBlock',
  'Comment', 'CommentBlock',
  'YAMLFrontmatter',
  'ZknLink',
  'Citation'
])

const DRIVE_PATH_START = /^[A-Za-z]:[\\/]/
const UNC_PATH_START = /^\\\\[^\\/\s]+[\\/][^\\/\s]+/
const FORBIDDEN_PATH_CHARACTERS = /[\p{Cc}<>"|?*]/u
const DRIVE_ROOT_KEY = /^[a-z]:\\$/i

/**
 * A plain text path starts with a drive letter, a colon and a separator,
 * where the character before is no letter, digit, underscore or separator.
 * It runs up to whitespace, a character a path cannot contain, a backtick,
 * a second colon, or a full-width punctuation mark.
 */
const PLAIN_PATH_PATTERN = /(?<![A-Za-z0-9_\\/])[A-Za-z]:[\\/][^\s<>"|?*`:。，、；：！？”’」』》…]*/gu

/**
 * Characters removed from the end of a plain text path
 */
const TRAILING_PUNCTUATION: ReadonlySet<string> = new Set([...'.,;!?\'"。，、；：！？”’」』》…'])

/**
 * Closing brackets removed from the end of a plain text path when the path
 * contains fewer of the corresponding opening bracket
 */
const CLOSING_BRACKETS: ReadonlyMap<string, string> = new Map([
  [ ')', '(' ], [ ']', '[' ], [ '}', '{' ], [ '）', '（' ], [ '】', '【' ]
])

/**
 * Whether a text is one absolute Windows path (spec C12 1.3): a drive path
 * with a separator after the colon, or a UNC path with a non-empty server and
 * share; no control characters, no `< > " | ? *`, no colon except the one
 * after the drive letter, at most 32767 characters.
 *
 * @param   {string}   text  The text
 *
 * @return  {boolean}        True if the text is an absolute path
 */
export function isAbsoluteWindowsPath (text: string): boolean {
  if (text.length === 0 || text.length > MAXIMUM_PATH_LENGTH || FORBIDDEN_PATH_CHARACTERS.test(text)) {
    return false
  }
  if (DRIVE_PATH_START.test(text)) {
    return !text.slice(2).includes(':')
  }
  if (UNC_PATH_START.test(text)) {
    return !text.includes(':')
  }
  return false
}

/**
 * Turns the forward slashes of a path into backslashes (spec C12 1.4)
 *
 * @param   {string}  text  The path as written
 *
 * @return  {string}        The path as sent to main
 */
function toBackslashes (text: string): string {
  return text.replace(/\//g, '\\')
}

/**
 * Returns the cache key of a path (spec C12 1.4): backslashes only, runs of
 * backslashes merged except the two leading ones of a UNC path, no trailing
 * backslash except after a drive root, all lower case.
 *
 * @param   {string}  path  The path
 *
 * @return  {string}        The cache key
 */
export function pathCacheKey (path: string): string {
  const backslashed = toBackslashes(path)
  const prefix = backslashed.startsWith('\\\\') ? '\\\\' : ''
  let key = prefix + backslashed.slice(prefix.length).replace(/\\{2,}/g, '\\')
  while (key.endsWith('\\') && key.length > prefix.length && !DRIVE_ROOT_KEY.test(key)) {
    key = key.slice(0, -1)
  }
  return key.toLowerCase()
}

/**
 * Returns the path an inline code node consists of, if any (spec C12 1.1).
 * Inline code whose source spans lines is never a path.
 *
 * @param   {EditorState}       state  The editor state
 * @param   {SyntaxNode}        node   An `InlineCode` node
 *
 * @return  {string|undefined}         The path as written
 */
function inlineCodePath (state: EditorState, node: SyntaxNode): string|undefined {
  // The math parser emits InlineCode nodes as well; only backtick delimited
  // code is meant here.
  if (node.from >= node.to || state.sliceDoc(node.from, node.from + 1) !== '`') {
    return undefined
  }

  const marks = node.getChildren('CodeMark')
  if (marks.length < 2) {
    return undefined
  }

  const source = state.sliceDoc(marks[0].to, marks[marks.length - 1].from)
  if (/[\r\n]/.test(source)) {
    return undefined
  }

  let content = source.trim()
  // "Copy as path" in the File Explorer wraps the path in double quotes
  if (content.length > 2 && content.startsWith('"') && content.endsWith('"')) {
    content = content.slice(1, -1).trim()
  }

  return isAbsoluteWindowsPath(content) ? content : undefined
}

/**
 * Removes trailing punctuation, and unbalanced closing brackets, from a plain
 * text path (spec C12 1.2)
 *
 * @param   {string}  text  The path candidate
 *
 * @return  {string}        The trimmed candidate
 */
function trimTrailingPunctuation (text: string): string {
  let result = text
  for (;;) {
    const last = result.slice(-1)
    if (last === '') {
      return result
    }
    if (TRAILING_PUNCTUATION.has(last)) {
      result = result.slice(0, -1)
      continue
    }
    const opening = CLOSING_BRACKETS.get(last)
    if (opening !== undefined && countCharacter(result, opening) < countCharacter(result, last)) {
      result = result.slice(0, -1)
      continue
    }
    return result
  }
}

function countCharacter (text: string, character: string): number {
  return text.split(character).length - 1
}

/**
 * Whether a Link or Image node has a target (`[t](x)`) or a reference label
 * (`[t][r]`), unlike plain brackets such as `[1]`
 */
function isRealLink (node: SyntaxNode): boolean {
  return node.getChild('URL') !== null || node.getChild('LinkLabel') !== null
}

/**
 * Whether the range [from, to) overlaps one of the sorted, disjoint intervals
 */
function overlapsInterval (intervals: ReadonlyArray<{ from: number, to: number }>, from: number, to: number): boolean {
  // Binary search for the first interval that ends after `from`
  let low = 0
  let high = intervals.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (intervals[middle].to <= from) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  return low < intervals.length && intervals[low].from < to
}

/**
 * Finds the path candidates within the given ranges (normally the visible
 * ranges of an editor view), sorted by position and capped at 500 (spec C12
 * part 1). Every line touched by a range is scanned completely.
 *
 * @param   {EditorState}  state   The editor state
 * @param   {Array}        ranges  The document ranges to search
 *
 * @return  {PathCandidate[]}      The candidates
 */
export function findPathCandidates (state: EditorState, ranges: ReadonlyArray<{ from: number, to: number }>): PathCandidate[] {
  const tree = syntaxTree(state)
  const candidates: PathCandidate[] = []
  const seenInlineCode = new Set<number>()
  const seenLines = new Set<number>()

  const addCandidate = (written: string, at: number): void => {
    const path = toBackslashes(written)
    candidates.push({ path, key: pathCacheKey(path), at })
  }

  for (const range of ranges) {
    const firstLine = state.doc.lineAt(range.from)
    const lastLine = state.doc.lineAt(range.to)

    // Nodes are not entered below an excluding node, so the intervals are
    // disjoint and in document order.
    const excluded: Array<{ from: number, to: number }> = []
    tree.iterate({
      from: firstLine.from,
      to: lastLine.to,
      enter: (node) => {
        if (!PATH_EXCLUDING_NODES.has(node.name)) {
          return
        }
        // The parser also makes a Link node of plain brackets, as in
        // `Trimer[1]`; only a link with a target or a reference label counts.
        if ((node.name === 'Link' || node.name === 'Image') && !isRealLink(node.node)) {
          return
        }
        excluded.push({ from: node.from, to: node.to })
        if (node.name === 'InlineCode' && !seenInlineCode.has(node.from)) {
          seenInlineCode.add(node.from)
          const path = inlineCodePath(state, node.node)
          if (path !== undefined) {
            addCandidate(path, node.to)
          }
        }
        return false
      }
    })

    for (let lineNumber = firstLine.number; lineNumber <= lastLine.number; lineNumber++) {
      if (seenLines.has(lineNumber)) {
        continue
      }
      seenLines.add(lineNumber)

      const line = state.doc.line(lineNumber)
      for (const match of line.text.matchAll(PLAIN_PATH_PATTERN)) {
        const written = trimTrailingPunctuation(match[0])
        if (!isAbsoluteWindowsPath(written)) {
          continue
        }
        const from = line.from + (match.index ?? 0)
        const to = from + written.length
        if (!overlapsInterval(excluded, from, to)) {
          addCandidate(written, to)
        }
      }
    }
  }

  candidates.sort((first, second) => first.at - second.at)
  return candidates.slice(0, MAXIMUM_PATH_CANDIDATES)
}
