/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Pandoc slide splitter
 * CVM-Role:        Utility function
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Splits the Markdown source of a pandoc slide deck into the
 *                  per-page chunks pandoc produces when writing a PPTX, so
 *                  that the live PPTX preview can re-convert only the pages
 *                  whose text (or referenced images) actually changed. The
 *                  chunks tile the source exactly: concatenating their texts
 *                  reproduces the input verbatim, and the line ranges are
 *                  contiguous. The module is pure (no editor or filesystem
 *                  dependencies) so that it can be unit-tested in isolation.
 *
 * END HEADER
 */

export interface PandocSlideChunk {
  /**
   * 'metadata' for the leading YAML metadata block (which yields the cover
   * page), 'slide' for every regular page
   */
  kind: 'metadata'|'slide'
  /**
   * The verbatim slice of the source file, including its original line breaks
   */
  text: string
  /**
   * The first line of the chunk (zero-based, inclusive)
   */
  startLine: number
  /**
   * The line after the last line of the chunk (zero-based, exclusive)
   */
  endLine: number
}

/**
 * An ATX heading: one to six hashes followed by a space. Pandoc's setext
 * headings are not supported as split points; a line of dashes below a text
 * line is instead recognized (and skipped) as a setext underline.
 */
const ATX_HEADING = /^(#{1,6}) /

/**
 * A horizontal rule: a line consisting solely of three or more identical
 * `-`, `*` or `_` characters, optionally interspersed with whitespace, after
 * at most three columns of indentation.
 */
const HORIZONTAL_RULE = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/

/**
 * A code fence delimiter: three or more backticks or tildes after at most
 * three columns of indentation, optionally followed by an info string.
 */
const FENCE_DELIMITER = /^ {0,3}(`{3,}|~{3,})(.*)$/

/**
 * The opening line of a YAML metadata block (also the closing line, but the
 * block may alternatively be closed with three dots)
 */
const METADATA_DELIMITER = /^---[ \t]*$/
const METADATA_TERMINATOR = /^(?:---|\.\.\.)[ \t]*$/

/**
 * What a single source line contributes to the page structure. Lines inside
 * fenced code blocks and HTML comments never trigger splits; blank lines and
 * comment-only lines are glue that attaches to the following chunk.
 */
interface LineAnalysis {
  /** The line contains only whitespace (and no comment delimiters) */
  blank: boolean
  /** The line consists solely of HTML comment content (plus whitespace) */
  commentOnly: boolean
  /** The line lies inside (or delimits) a fenced code block */
  fenced: boolean
  /** The heading level, if the line is an ATX heading outside fences/comments */
  headingLevel: number|undefined
  /** The marker character, if the line looks like a horizontal rule */
  ruleMarker: string|undefined
}

/**
 * Splits a document into lines, each keeping its own terminator, so that the
 * lines concatenate back to the exact input. An empty document has no lines.
 */
function splitIntoLines (markdown: string): string[] {
  return markdown.match(/[^\n]*\n|[^\n]+/g) ?? []
}

/**
 * Returns the content of a line without its trailing line terminator
 */
function lineContent (line: string): string {
  return line.replace(/\r?\n$/, '')
}

interface CommentScan {
  /** The characters of the line that lie outside HTML comments */
  nonCommentText: string
  /** Whether an HTML comment is still open at the end of the line */
  inCommentAtEnd: boolean
  /** Whether any part of the line belongs to an HTML comment */
  sawComment: boolean
}

/**
 * Walks a line, tracking `<!-- ... -->` comments (which may span lines), and
 * collects the text outside of comments.
 *
 * @param   {string}       content    The line content (without terminator)
 * @param   {boolean}      inComment  Whether a comment is open at line start
 *
 * @return  {CommentScan}             The scan result
 */
function scanComments (content: string, inComment: boolean): CommentScan {
  let nonCommentText = ''
  let sawComment = inComment
  let inside = inComment
  let index = 0

  while (index < content.length) {
    if (inside) {
      const close = content.indexOf('-->', index)
      if (close === -1) {
        index = content.length
      } else {
        inside = false
        index = close + 3
      }
    } else {
      const open = content.indexOf('<!--', index)
      if (open === -1) {
        nonCommentText += content.slice(index)
        index = content.length
      } else {
        nonCommentText += content.slice(index, open)
        inside = true
        sawComment = true
        index = open + 4
      }
    }
  }

  return { nonCommentText, inCommentAtEnd: inside, sawComment }
}

/**
 * Analyzes the lines from `firstLine` on (i.e., after any metadata block),
 * tracking fenced code blocks and multi-line HTML comments so that nothing
 * inside them can act as a split point.
 *
 * @param   {string[]}        lines      All lines of the document
 * @param   {number}          firstLine  The first line to analyze
 *
 * @return  {LineAnalysis[]}             One analysis per analyzed line
 */
function analyzeLines (lines: string[], firstLine: number): LineAnalysis[] {
  const analyses: LineAnalysis[] = []
  let openFence: string|undefined
  let inComment = false

  for (let i = firstLine; i < lines.length; i++) {
    const content = lineContent(lines[i])

    // Inside a fenced code block every line is opaque content; only a closing
    // fence (same character, at least the opening length, no info string)
    // ends the block. Comments are not parsed inside fences.
    if (openFence !== undefined) {
      const match = FENCE_DELIMITER.exec(content)
      if (match !== null && match[1][0] === openFence[0] && match[1].length >= openFence.length && match[2].trim() === '') {
        openFence = undefined
      }
      analyses.push({ blank: false, commentOnly: false, fenced: true, headingLevel: undefined, ruleMarker: undefined })
      continue
    }

    // A fence can only open outside of a comment. Backtick fences may not
    // contain backticks in their info string.
    if (!inComment) {
      const match = FENCE_DELIMITER.exec(content)
      if (match !== null && (!match[1].startsWith('`') || !match[2].includes('`'))) {
        openFence = match[1]
        analyses.push({ blank: false, commentOnly: false, fenced: true, headingLevel: undefined, ruleMarker: undefined })
        continue
      }
    }

    const inCommentAtStart = inComment
    const scan = scanComments(content, inCommentAtStart)
    inComment = scan.inCommentAtEnd

    const outsideComments = scan.nonCommentText.trim()
    const blank = outsideComments === '' && !scan.sawComment
    const commentOnly = outsideComments === '' && scan.sawComment

    // Headings and rules must start at the beginning of the line, so they can
    // only occur when no comment spans the line start.
    let headingLevel: number|undefined
    let ruleMarker: string|undefined
    if (!inCommentAtStart) {
      const headingMatch = ATX_HEADING.exec(content)
      if (headingMatch !== null) {
        headingLevel = headingMatch[1].length
      } else {
        const ruleMatch = HORIZONTAL_RULE.exec(content)
        if (ruleMatch !== null) {
          ruleMarker = ruleMatch[1]
        }
      }
    }

    analyses.push({ blank, commentOnly, fenced: false, headingLevel, ruleMarker })
  }

  return analyses
}

/**
 * Infers the slide level the way pandoc does: the smallest level among the
 * ATX headings that are followed by actual content before the next heading.
 * Blank lines, comment-only lines, and horizontal rules do not count as
 * content; fenced code blocks do. Defaults to one if no heading qualifies.
 *
 * @param   {LineAnalysis[]}  analyses  The analyzed lines
 *
 * @return  {number}                    The slide level (1-6)
 */
function inferSlideLevel (analyses: LineAnalysis[]): number {
  let slideLevel: number|undefined
  let pendingLevel: number|undefined

  for (const line of analyses) {
    if (!line.fenced && line.headingLevel !== undefined) {
      pendingLevel = line.headingLevel
    } else if (line.blank || line.commentOnly || line.ruleMarker !== undefined) {
      continue
    } else if (pendingLevel !== undefined) {
      if (slideLevel === undefined || pendingLevel < slideLevel) {
        slideLevel = pendingLevel
      }
      pendingLevel = undefined
    }
  }

  return slideLevel ?? 1
}

/**
 * Determines for every analyzed line whether it opens a new page: ATX
 * headings up to the slide level do, and so do horizontal rules -- except
 * that a line of dashes directly below a text line is a setext level-two
 * heading underline, not a rule, and therefore does not split.
 *
 * @param   {LineAnalysis[]}  analyses    The analyzed lines
 * @param   {number}          slideLevel  The inferred slide level
 *
 * @return  {boolean[]}                   One flag per analyzed line
 */
function resolveSplitPoints (analyses: LineAnalysis[], slideLevel: number): boolean[] {
  const splits: boolean[] = []
  let previousLineWasText = false

  for (const line of analyses) {
    if (line.fenced) {
      previousLineWasText = true
      splits.push(false)
    } else if (line.blank || line.commentOnly) {
      previousLineWasText = false
      splits.push(false)
    } else if (line.headingLevel !== undefined) {
      previousLineWasText = true
      splits.push(line.headingLevel <= slideLevel)
    } else if (line.ruleMarker === '-' && previousLineWasText) {
      // Setext heading underline: the dashes belong to the preceding text
      previousLineWasText = true
      splits.push(false)
    } else if (line.ruleMarker !== undefined) {
      previousLineWasText = false
      splits.push(true)
    } else {
      previousLineWasText = true
      splits.push(false)
    }
  }

  return splits
}

/**
 * Finds the end of the YAML metadata block. Pandoc only produces a cover page
 * when the very first non-blank line opens the block with three dashes and a
 * later line closes it with three dashes or three dots.
 *
 * @param   {string[]}          lines  All lines of the document
 *
 * @return  {number|undefined}         The line after the closing line, or
 *                                     undefined if there is no metadata block
 */
function findMetadataEnd (lines: string[]): number|undefined {
  let first = 0
  while (first < lines.length && lineContent(lines[first]).trim() === '') {
    first++
  }

  if (first >= lines.length || !METADATA_DELIMITER.test(lineContent(lines[first]))) {
    return undefined
  }

  for (let i = first + 1; i < lines.length; i++) {
    if (METADATA_TERMINATOR.test(lineContent(lines[i]))) {
      return i + 1
    }
  }

  return undefined
}

function makeChunk (kind: PandocSlideChunk['kind'], lines: string[], startLine: number, endLine: number): PandocSlideChunk {
  return { kind, text: lines.slice(startLine, endLine).join(''), startLine, endLine }
}

/**
 * Splits pandoc slide Markdown into page chunks following pandoc's PPTX
 * pagination: a chunk starts at the YAML metadata block, at an ATX heading
 * whose level does not exceed the slide level, or at a horizontal rule.
 * Blank lines and HTML comments between two pages belong to the page they
 * precede. The chunks tile the input exactly (their texts concatenate to the
 * input, and their line ranges are contiguous); leading material without any
 * real content is merged into the first page, and an input consisting solely
 * of such material becomes a single page.
 *
 * @param   {string}             markdown  The slide deck source
 *
 * @return  {PandocSlideChunk[]}           The page chunks, in source order
 */
export function splitPandocSlides (markdown: string): PandocSlideChunk[] {
  const lines = splitIntoLines(markdown)
  if (lines.length === 0) {
    return []
  }

  const chunks: PandocSlideChunk[] = []
  let regionStart = 0

  const metadataEnd = findMetadataEnd(lines)
  if (metadataEnd !== undefined) {
    chunks.push(makeChunk('metadata', lines, 0, metadataEnd))
    regionStart = metadataEnd
  }

  if (regionStart >= lines.length) {
    return chunks
  }

  const analyses = analyzeLines(lines, regionStart)
  const splits = resolveSplitPoints(analyses, inferSlideLevel(analyses))
  const prefixable = analyses.map(line => line.blank || line.commentOnly)

  // Every split line opens a chunk; the blank and comment-only lines directly
  // above it are pulled into that chunk (region-relative boundaries).
  const boundaries: number[] = []
  for (let i = 0; i < analyses.length; i++) {
    if (!splits[i]) {
      continue
    }
    let boundary = i
    while (boundary > 0 && prefixable[boundary - 1]) {
      boundary--
    }
    boundaries.push(boundary)
  }

  if (boundaries.length === 0) {
    chunks.push(makeChunk('slide', lines, regionStart, lines.length))
    return chunks
  }

  // Real content before the first split point forms a page of its own;
  // mere blank lines and comments are merged into the first split chunk.
  if (boundaries[0] > 0) {
    const hasContent = analyses.slice(0, boundaries[0]).some(line => !line.blank && !line.commentOnly)
    if (hasContent) {
      chunks.push(makeChunk('slide', lines, regionStart, regionStart + boundaries[0]))
    } else {
      boundaries[0] = 0
    }
  }

  for (let k = 0; k < boundaries.length; k++) {
    const start = regionStart + boundaries[k]
    const end = k + 1 < boundaries.length ? regionStart + boundaries[k + 1] : lines.length
    chunks.push(makeChunk('slide', lines, start, end))
  }

  return chunks
}

/**
 * Extracts the paths of all Markdown image references `![...](path)` in a
 * chunk, so that the modification times of the referenced images can be
 * included in the chunk's cache hash. An optional title (`![](path "title")`)
 * is dropped; the paths themselves are returned verbatim (no decoding, no
 * slash normalization). Pseudo-references inside code spans or fenced code
 * blocks are not filtered out -- for cache invalidation a false positive is
 * harmless.
 *
 * @param   {string}    chunkText  The text of one chunk
 *
 * @return  {string[]}             The referenced image paths, in source order
 */
export function extractReferencedImagePaths (chunkText: string): string[] {
  const paths: string[] = []

  for (const match of chunkText.matchAll(/!\[[^\]]*\]\(([^()]*)\)/g)) {
    const path = match[1].replace(/\s+(?:"[^"]*"|'[^']*')$/, '').trim()
    if (path !== '') {
      paths.push(path)
    }
  }

  return paths
}
