/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Pandoc slide chunk normalization
 * CVM-Role:        Utility function
 * License:         GNU GPL v3
 *
 * Description:     Derives the text that the live PPTX preview hashes into a
 *                  slide chunk's cache key. Edits that cannot change the
 *                  rendered slide -- adding, editing, or removing an ordinary
 *                  HTML comment, or piling up extra blank lines -- must not
 *                  change the key, so that annotating a deck does not trigger
 *                  a re-render of the page. The normalized text is used for
 *                  the cache key only; the worker always converts the chunk's
 *                  verbatim text. The module is pure (no editor or filesystem
 *                  dependencies) so that it can be unit-tested in isolation.
 *
 * END HEADER
 */

// A comment whose body contains the configuration marker is the document's
// PPTX preview configuration block; it is kept verbatim, because it changes
// the rendering.
import { CONFIGURATION_MARKER } from '@common/pandoc-util/pptx-preview-configuration'

/**
 * Comment bodies starting with one of these prefixes (after leading
 * whitespace, compared case-insensitively) are directives that influence the
 * rendering, so they stay part of the cache key verbatim.
 */
const DIRECTIVE_PREFIXES = [ 'page:', 'table:', 'style:' ]


/**
 * The line that replaces a stripped comment-only group wherever the comment
 * may carry meaning of its own (see normalizeChunkForCacheKey)
 */
const COMMENT_PLACEHOLDER = '<!-- -->'

/**
 * A code fence delimiter (same definition as in the slide splitter)
 */
const FENCE_DELIMITER = /^ {0,3}(`{3,}|~{3,})(.*)$/

/**
 * A line that starts a list item (bullet, ordered, fancy, example, or
 * definition list). Deliberately generous: a false match only keeps a
 * placeholder in the key, which errs on the side of re-rendering.
 */
const LIST_ITEM_START = /^ {0,3}(?:[-*+:~]|\(?(?:\d+|#|[A-Za-z]|[ivxlcdmIVXLCDM]+|@[\w-]*)[.)])(?:[ \t]|$)/

/**
 * A line indented by at least four columns (a potential indented code block,
 * or content belonging to a list item)
 */
const INDENTED_LINE = /^(?: {4}| {0,3}\t)/

/**
 * One line of the intermediate result
 */
interface NormalizedLine {
  /**
   * 'text' for a line that is kept (possibly with inline comments removed),
   * 'removed' for a line that consisted solely of stripped comments
   */
  kind: 'text'|'removed'
  text: string
  /**
   * Verbatim lines (inside fenced code blocks or kept comments) are never
   * treated as blank and never folded
   */
  verbatim: boolean
}

/**
 * Whether a comment body marks a comment that influences the rendering
 */
function isDirectiveComment (body: string): boolean {
  const trimmedBody = body.trimStart().toLowerCase()
  if (DIRECTIVE_PREFIXES.some(prefix => trimmedBody.startsWith(prefix))) {
    return true
  }
  return body.includes(CONFIGURATION_MARKER)
}

/**
 * Whether the character at `index` is escaped by an odd number of backslashes
 */
function isEscaped (content: string, index: number): boolean {
  let backslashCount = 0
  let position = index - 1
  while (position >= 0 && content[position] === '\\') {
    backslashCount++
    position--
  }
  return backslashCount % 2 === 1
}

/**
 * Given a run of backticks starting at `start`, returns the index just after
 * the matching closing run on the same line, or undefined when the run is not
 * closed on this line.
 */
function findCodeSpanEnd (content: string, start: number): number|undefined {
  let runEnd = start
  while (runEnd < content.length && content[runEnd] === '`') {
    runEnd++
  }
  const runLength = runEnd - start

  let index = runEnd
  while (index < content.length) {
    const next = content.indexOf('`', index)
    if (next === -1) {
      return undefined
    }
    let closingEnd = next
    while (closingEnd < content.length && content[closingEnd] === '`') {
      closingEnd++
    }
    if (closingEnd - next === runLength) {
      return closingEnd
    }
    index = closingEnd
  }
  return undefined
}

/**
 * Normalizes the text of one slide chunk for cache-key purposes:
 *
 * 1. Ordinary HTML comments (page-identity records such as `<!-- 新第 3 页 -->`
 *    and user annotations alike) are stripped, including comments spanning
 *    several lines. Directive comments -- bodies starting with `page:`,
 *    `table:`, or `style:`, and the `Pandoc_PPTX_Configuration` block -- are
 *    kept verbatim, because they change the rendering.
 * 2. Runs of two or more blank lines are folded into a single blank line.
 * 3. Blank lines at the start and the end of the chunk are dropped.
 *
 * Boundary decisions:
 *
 * - The FIRST blank line between two lines of body text still changes the
 *   result: it does change the Markdown semantics (a tight list becomes a
 *   loose one, a table caption needs a preceding blank line, a paragraph is
 *   split in two). Only the second and every further consecutive blank line
 *   are folded away.
 * - A line that consists solely of stripped comments (plus whitespace) is
 *   removed together with its line break, so "text / comment / text" on
 *   three lines normalizes to the two text lines without a blank line in
 *   between -- keeping the line as an empty line would fake a paragraph
 *   break. Blank lines that surround such a line are folded afterwards, so
 *   "text / blank / comment / blank / text" normalizes to "text / blank /
 *   text", exactly like the document without the comment.
 * - An inline comment is cut out of its line; the text around it stays. When
 *   the comment is followed by whitespace or by the end of the line, the
 *   whitespace directly before it is dropped as well (but never the line's
 *   indentation), so that "text <!-- c -->" normalizes to "text" and
 *   "a <!-- c --> b" to "a b", matching the comment-free text. A comment
 *   glued to a word on its right keeps the whitespace on its left.
 * - A comment-only group that stands as a block of its own (a blank line
 *   above it, earlier content in the chunk) directly above a list item or an
 *   indented line is replaced by a fixed placeholder line instead of
 *   vanishing: pandoc users put such a comment there on purpose to end a list
 *   (or to separate a list from an indented code block), so its presence
 *   changes the rendering while its wording does not. Adding or removing such
 *   a comment therefore still changes the result; editing it does not.
 * - Comments inside fenced code blocks and inline code spans on one line are
 *   literal text and stay; fenced code blocks are kept verbatim altogether
 *   (including their blank lines). Comments opening on a line indented by
 *   four or more columns are kept verbatim, since that line may belong to an
 *   indented code block. An unterminated `<!--` and a backslash-escaped one
 *   are literal text.
 * - Carriage returns are dropped, and blank lines are normalized to empty
 *   lines; trailing whitespace on non-blank lines is kept (two trailing
 *   spaces form a hard line break).
 *
 * @param   {string}  chunkText  The verbatim text of one slide chunk
 *
 * @return  {string}             The normalized text (lines joined with \n,
 *                               without a trailing line break)
 */
export function normalizeChunkForCacheKey (chunkText: string): string {
  const text = chunkText.replace(/\r\n?/g, '\n')
  const lines = text.split('\n')

  const lineStarts: number[] = []
  let offset = 0
  for (const line of lines) {
    lineStarts.push(offset)
    offset += line.length + 1
  }

  const normalizedLines: NormalizedLine[] = []
  let openFence: string|undefined
  // The comment currently open (it may span lines): its absolute end offset
  // (just after the closing `-->`) and whether it is kept verbatim
  let openComment: { end: number, keep: boolean }|undefined

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const content = lines[lineIndex]
    const lineStart = lineStarts[lineIndex]

    // Fenced code blocks are opaque; the fence handling mirrors the slide
    // splitter (fences only open outside comments).
    if (openFence !== undefined) {
      const match = FENCE_DELIMITER.exec(content)
      if (match !== null && match[1][0] === openFence[0] && match[1].length >= openFence.length && match[2].trim() === '') {
        openFence = undefined
      }
      normalizedLines.push({ kind: 'text', text: content, verbatim: true })
      continue
    }

    if (openComment === undefined) {
      const match = FENCE_DELIMITER.exec(content)
      if (match !== null && (!match[1].startsWith('`') || !match[2].includes('`'))) {
        openFence = match[1]
        normalizedLines.push({ kind: 'text', text: content, verbatim: true })
        continue
      }
    }

    const startsOutsideComment = openComment === undefined
    const lineIsIndented = startsOutsideComment && INDENTED_LINE.test(content)
    let output = ''
    let verbatim = openComment?.keep === true
    let strippedComment = openComment !== undefined && !openComment.keep
    let index = 0

    while (index < content.length) {
      if (openComment !== undefined) {
        const endInLine = openComment.end - lineStart
        const stop = Math.min(endInLine, content.length)
        if (openComment.keep) {
          output += content.slice(index, stop)
        }
        index = stop
        if (endInLine <= content.length) {
          const wasStripped = !openComment.keep
          openComment = undefined
          if (wasStripped) {
            const nextCharacter = content[index]
            if ((nextCharacter === undefined || /\s/.test(nextCharacter)) && output.trim() !== '') {
              output = output.trimEnd()
            }
          }
        }
        continue
      }

      const commentOpen = content.indexOf('<!--', index)
      const backtick = content.indexOf('`', index)

      if (backtick !== -1 && (commentOpen === -1 || backtick < commentOpen)) {
        output += content.slice(index, backtick)
        const spanEnd = findCodeSpanEnd(content, backtick)
        if (spanEnd === undefined) {
          // An unclosed run of backticks is literal text
          let runEnd = backtick
          while (runEnd < content.length && content[runEnd] === '`') {
            runEnd++
          }
          output += content.slice(backtick, runEnd)
          index = runEnd
        } else {
          output += content.slice(backtick, spanEnd)
          index = spanEnd
        }
        continue
      }

      if (commentOpen === -1) {
        output += content.slice(index)
        index = content.length
        continue
      }

      output += content.slice(index, commentOpen)
      const bodyStart = lineStart + commentOpen + 4
      const commentClose = text.indexOf('-->', bodyStart)
      if (commentClose === -1 || isEscaped(content, commentOpen)) {
        // Not a comment: an unterminated or escaped opener is literal text
        output += '<!--'
        index = commentOpen + 4
        continue
      }

      const keep = lineIsIndented || isDirectiveComment(text.slice(bodyStart, commentClose))
      openComment = { end: commentClose + 3, keep }
      if (keep) {
        verbatim = true
        output += '<!--'
      } else {
        strippedComment = true
      }
      index = commentOpen + 4

      // A stripped comment running past the end of this line counts as being
      // followed by the end of the line
      if (!keep && openComment.end - lineStart > content.length && output.trim() !== '') {
        output = output.trimEnd()
      }
    }

    if (strippedComment && !verbatim && output.trim() === '') {
      normalizedLines.push({ kind: 'removed', text: '', verbatim: false })
    } else {
      normalizedLines.push({ kind: 'text', text: output, verbatim })
    }
  }

  return foldLines(replaceMeaningfulCommentGroups(normalizedLines))
}

/**
 * Whether a normalized line counts as blank for folding purposes
 */
function isBlankLine (line: NormalizedLine): boolean {
  return line.kind === 'text' && !line.verbatim && line.text.trim() === ''
}

/**
 * Drops every group of removed comment-only lines, except a group that forms a
 * block of its own (a blank line above it) between earlier content and a
 * following list item or indented line: there the comment may end a list, so
 * the group is replaced by a placeholder line. Without the blank line above,
 * the comment is merely a lazy continuation of the preceding paragraph and
 * cannot end anything, so it vanishes like everywhere else.
 */
function replaceMeaningfulCommentGroups (lines: NormalizedLine[]): NormalizedLine[] {
  const result: NormalizedLine[] = []
  let hasEarlierContent = false
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    if (line.kind !== 'removed') {
      result.push(line)
      if (!isBlankLine(line)) {
        hasEarlierContent = true
      }
      index++
      continue
    }

    const previousLine = result.length > 0 ? result[result.length - 1] : undefined
    const standsAsOwnBlock = previousLine !== undefined && isBlankLine(previousLine)

    let groupEnd = index
    while (groupEnd < lines.length && lines[groupEnd].kind === 'removed') {
      groupEnd++
    }

    let next = groupEnd
    while (next < lines.length && (isBlankLine(lines[next]) || lines[next].kind === 'removed')) {
      next++
    }
    const nextLine = next < lines.length ? lines[next] : undefined
    const precedesListOrIndentedLine = nextLine !== undefined && !nextLine.verbatim &&
      (LIST_ITEM_START.test(nextLine.text) || INDENTED_LINE.test(nextLine.text))

    if (hasEarlierContent && standsAsOwnBlock && precedesListOrIndentedLine) {
      result.push({ kind: 'text', text: COMMENT_PLACEHOLDER, verbatim: true })
    }
    index = groupEnd
  }

  return result
}

/**
 * Folds runs of blank lines into one empty line, drops leading and trailing
 * blank lines, and joins the lines with \n.
 */
function foldLines (lines: NormalizedLine[]): string {
  const output: string[] = []
  let pendingBlank = false

  for (const line of lines) {
    if (line.kind === 'removed') {
      continue
    }
    if (isBlankLine(line)) {
      pendingBlank = output.length > 0
      continue
    }
    if (pendingBlank) {
      output.push('')
      pendingBlank = false
    }
    output.push(line.text)
  }

  return output.join('\n')
}
