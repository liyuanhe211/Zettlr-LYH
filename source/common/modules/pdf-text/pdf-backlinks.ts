/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Finding the PDF links of a note, their highlight color
 *                  and the PDF they point to
 * CVM-Role:        Utility Function
 * License:         GNU GPL v3
 *
 * Description:     The pure functions of contract C11 (R62): scanning the
 *                  text of a note for links to places in PDFs (Markdown links
 *                  and PDF++ wiki links, outside YAML front matter, fenced
 *                  code, inline code and HTML comments), the color a backlink
 *                  is highlighted in, and resolving the path written in a link
 *                  to the absolute path of the PDF. Following a link from the
 *                  editor (open-markdown-link.ts) and the backlink index of
 *                  the main process both call resolvePdfLinkPath, so that they
 *                  always agree. Imports neither electron, Vue nor pdf.js and
 *                  does not use `window`.
 *
 * END HEADER
 */

import makeValidUri from '@common/util/make-valid-uri'
import { isAbsolutePath, pathDirname } from '@common/util/renderer-path-polyfill'
import {
  PDF_HIGHLIGHT_COLORS,
  type PdfLinkSyntax,
  type PdfNoteLink,
  type PdfPathEnvironment
} from '@dts/common/pdf-viewer'
import {
  extractQuotedSourceText,
  parsePdfLinkTarget,
  parsePdfWikiLinkContents,
  rankPdfCandidates,
  type LineSource
} from './pdf-link-target'

/**
 * The color names that have a highlight color of their own
 */
const PDF_BACKLINK_COLOR_KEYS = [ 'yellow', 'red', 'note', 'important' ] as const

/**
 * A wiki link, optionally preceded by `!`
 */
const WIKI_LINK = /(!?)\[\[([^[\]\n]+?)\]\]/g

/**
 * A Markdown link, optionally preceded by `!`: the bracketed text (which may
 * contain balanced brackets), the target (in angle brackets, or without
 * whitespace and with balanced parentheses) and an optional title
 */
const MARKDOWN_LINK = /(!?)\[((?:[^[\]\n]|\[[^[\]\n]*\])*)\]\(\s*(<[^<>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\s*\)/g

/**
 * The header of a PDF++ callout, `[!PDF|color]`, after the quote markers
 */
const PDF_CALLOUT_HEADER = /^\[!pdf\|([^\]]*)\]/i

/**
 * The block quote markers and whitespace at the start of a line
 */
const LEADING_QUOTE_MARKERS = /^(?:[ \t]*>)+[ \t]*/

/**
 * Decodes percent-encoded characters, leaving the text as is if it is not
 * validly encoded (e.g. a file name containing a bare `%`)
 */
function safeDecodeURIComponent (text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/**
 * Turns the path written in a Markdown link (without fragment) into the
 * absolute path of a local file: relative to the directory of the note,
 * percent-decoded. Drive-letter paths use the platform's separator on
 * Windows, so that a file opened from a link has the same path as when
 * opened from the file manager. This is how the editor has always resolved
 * links to files; open-markdown-link.ts uses it to decide whether a link to
 * a PDF names a local file.
 *
 * @param   {string}            writtenPath  The path as written in the link
 * @param   {string}            notePath     Absolute path of the note holding the link
 *
 * @return  {string|undefined}               The absolute path, or undefined if the link does not name a local file
 */
export function resolveMarkdownLinkPath (writtenPath: string, notePath: string): string|undefined {
  const validURI = makeValidUri(writtenPath, pathDirname(notePath))
  if (!validURI.startsWith('safe-file://')) {
    return undefined
  }

  let localPath = safeDecodeURIComponent(validURI.replace('safe-file://', ''))
  if (/^\/[A-Z]:/i.test(localPath)) {
    localPath = localPath.slice(1)
  }

  if (!isAbsolutePath(localPath)) {
    return undefined
  }

  if (process.platform === 'win32' && /^[A-Z]:/i.test(localPath)) {
    localPath = localPath.replace(/\//g, '\\')
  }
  return localPath
}

/**
 * Finds the PDF a wiki link refers to. Obsidian, and so PDF++, write wiki
 * links with the file name alone (if it is unique in the vault) or with a
 * path relative to the vault. First the path is tried relative to the note;
 * failing that, the workspaces that contain the note (or, if none does, the
 * note's directory) are searched for files of that name, best first as
 * ranked by rankPdfCandidates.
 */
async function resolveWikiLinkPath (writtenPath: string, notePath: string, environment: PdfPathEnvironment): Promise<string|undefined> {
  const relative = resolveMarkdownLinkPath(writtenPath, notePath)
  if (relative !== undefined && await environment.exists(relative)) {
    return relative
  }

  if (!isAbsolutePath(notePath)) {
    return undefined
  }

  const noteDirectory = pathDirname(notePath)
  const comparable = (path: string): string => {
    const forward = path.replace(/\\/g, '/')
    return environment.ignoreCase ? forward.toLowerCase() : forward
  }
  const roots = environment.workspaceRoots
    .filter(root => typeof root === 'string' && root !== '')
    .filter(root => comparable(notePath).startsWith(comparable(root).replace(/\/$/, '') + '/'))
  if (roots.length === 0) {
    roots.push(noteDirectory)
  }

  const files: string[] = []
  for (const root of roots) {
    files.push(...await environment.listFiles(root))
  }
  return rankPdfCandidates(files, writtenPath, noteDirectory)[0]
}

/**
 * Resolves the path written in a PDF link to the absolute path of the PDF
 * (contract C11). Markdown links are resolved like every other link to a
 * file: relative to the note's directory, percent-decoded; whether the file
 * exists is not checked. Wiki links are first tried relative to the note
 * and, if no such file exists, looked up by name in the workspaces holding
 * the note. Both the editor and the backlink index call this function.
 *
 * @param   {PdfLinkSyntax}       syntax       `markdown` or `wiki`
 * @param   {string}              writtenPath  The path as written in the link, without fragment
 * @param   {string}              notePath     Absolute path of the note holding the link
 * @param   {PdfPathEnvironment}  env          Workspaces and file system access
 *
 * @return  {Promise<string|undefined>}        The absolute path of the PDF, or undefined
 */
export async function resolvePdfLinkPath (syntax: PdfLinkSyntax, writtenPath: string, notePath: string, env: PdfPathEnvironment): Promise<string|undefined> {
  if (syntax === 'wiki') {
    return await resolveWikiLinkPath(writtenPath, notePath, env)
  }
  return resolveMarkdownLinkPath(writtenPath, notePath)
}

/**
 * Returns the color a backlink is highlighted in: the link's own `&color=`
 * if it is not empty, otherwise the color of the `[!PDF|color]` callout it
 * stands in if that is not empty, otherwise yellow; always in lowercase.
 *
 * @param   {PdfNoteLink}  link  The link
 *
 * @return  {string}             The color name
 */
export function resolveBacklinkColor (link: PdfNoteLink): string {
  const own = link.location.color?.trim() ?? ''
  if (own !== '') {
    return own.toLowerCase()
  }

  const callout = link.calloutColor?.trim() ?? ''
  if (callout !== '') {
    return callout.toLowerCase()
  }

  return 'yellow'
}

/**
 * Returns the key under which a color is drawn: the color name itself if it
 * is one of the keys of PDF_HIGHLIGHT_COLORS, otherwise `default` (drawn in
 * the amber of PDF_DEFAULT_HIGHLIGHT_COLOR).
 *
 * @param   {string}  color  A color name, e.g. as returned by resolveBacklinkColor
 *
 * @return  {'yellow'|'red'|'note'|'important'|'default'}  The color key
 */
export function pdfBacklinkColorKey (color: string): 'yellow' | 'red' | 'note' | 'important' | 'default' {
  const name = color.trim().toLowerCase()
  for (const key of PDF_BACKLINK_COLOR_KEYS) {
    if (key === name && Object.prototype.hasOwnProperty.call(PDF_HIGHLIGHT_COLORS, key)) {
      return key
    }
  }
  return 'default'
}

/**
 * An opened fenced code block: its fence character and length
 */
interface OpenFence {
  character: string
  length: number
}

/**
 * Recognizes a code fence (three or more backticks or tildes) at the start of
 * a line, after any block quote markers and indentation. A backtick fence
 * whose info string contains a backtick is no fence.
 *
 * @return  {{ character: string, length: number, rest: string }|undefined}  The fence, or undefined
 */
function readFence (lineText: string): { character: string, length: number, rest: string }|undefined {
  const content = lineText.replace(LEADING_QUOTE_MARKERS, '').replace(/^[ \t]*/, '')
  const match = /^(`{3,}|~{3,})(.*)$/.exec(content)
  if (match === null) {
    return undefined
  }

  const character = match[1][0]
  if (character === '`' && match[2].includes('`')) {
    return undefined
  }
  return { character, length: match[1].length, rest: match[2] }
}

/**
 * Returns the number of lines at the start of the note that belong to the
 * YAML front matter: from a first line `---` to the next line that is `---`
 * or `...`. Without such a closing line there is no front matter (0).
 */
function yamlFrontMatterLength (lines: string[]): number {
  if (lines.length === 0 || lines[0].trimEnd() !== '---') {
    return 0
  }

  for (let index = 1; index < lines.length; index++) {
    const trimmed = lines[index].trimEnd()
    if (trimmed === '---' || trimmed === '...') {
      return index + 1
    }
  }
  return 0
}

/**
 * Replaces everything in the lines that must not be scanned with spaces,
 * keeping every line's length so that positions stay valid: the YAML front
 * matter, fenced code blocks (also inside block quotes) including their
 * fences, inline code spans (on one line) and HTML comments (which may span
 * lines).
 *
 * @param   {string[]}  lines  The lines of the note
 *
 * @return  {string[]}         The lines with the excluded parts blanked
 */
function maskExcludedRegions (lines: string[]): string[] {
  const blank = (text: string): string => ' '.repeat(text.length)
  const masked: string[] = []
  const frontMatterLength = yamlFrontMatterLength(lines)

  let fence: OpenFence|undefined
  let inComment = false

  for (let index = 0; index < lines.length; index++) {
    const lineText = lines[index]

    if (index < frontMatterLength) {
      masked.push(blank(lineText))
      continue
    }

    if (fence !== undefined) {
      const closing = readFence(lineText)
      if (closing !== undefined && closing.character === fence.character && closing.length >= fence.length && closing.rest.trim() === '') {
        fence = undefined
      }
      masked.push(blank(lineText))
      continue
    }

    if (!inComment) {
      const opening = readFence(lineText)
      if (opening !== undefined) {
        fence = { character: opening.character, length: opening.length }
        masked.push(blank(lineText))
        continue
      }
    }

    // Walk through the line, blanking comments and inline code spans
    const characters = lineText.split('')
    let position = 0
    while (position < lineText.length) {
      if (inComment) {
        const end = lineText.indexOf('-->', position)
        const stop = end < 0 ? lineText.length : end + 3
        for (let k = position; k < stop; k++) {
          characters[k] = ' '
        }
        position = stop
        if (end >= 0) {
          inComment = false
        }
        continue
      }

      if (lineText.startsWith('<!--', position)) {
        inComment = true
        continue
      }

      if (lineText[position] === '`') {
        let runEnd = position
        while (lineText[runEnd] === '`') {
          runEnd++
        }
        const runLength = runEnd - position
        const closing = findBacktickRun(lineText, runEnd, runLength)
        if (closing < 0) {
          // An unmatched run of backticks is literal text
          position = runEnd
          continue
        }
        const stop = closing + runLength
        for (let k = position; k < stop; k++) {
          characters[k] = ' '
        }
        position = stop
        continue
      }

      position++
    }

    masked.push(characters.join(''))
  }

  return masked
}

/**
 * Finds the next run of exactly `length` backticks at or after `from`.
 *
 * @return  {number}  Where the run starts, or -1
 */
function findBacktickRun (text: string, from: number, length: number): number {
  let position = from
  while (position < text.length) {
    if (text[position] !== '`') {
      position++
      continue
    }
    let runEnd = position
    while (text[runEnd] === '`') {
      runEnd++
    }
    if (runEnd - position === length) {
      return position
    }
    position = runEnd
  }
  return -1
}

/**
 * Splits the contents of a wiki link into its PDF target and display text,
 * following parsePdfWikiLinkContents: the part before the first pipe is the
 * target if it names a PDF, the rest being the display text; otherwise, for
 * the `title|link` format, the part after the last pipe is the target and
 * the part before it the display text.
 */
function wikiDisplayText (contents: string): string {
  const parts = contents.split('|')
  if (parts.length < 2) {
    return ''
  }
  if (parsePdfWikiLinkContents(parts[0]) !== null) {
    return parts.slice(1).join('|')
  }
  return parts.slice(0, -1).join('|')
}

/**
 * A link found on one line, before line-level information is added
 */
interface LineMatch {
  start: number
  end: number
  link: Omit<PdfNoteLink, 'line'|'calloutColor'|'sourceText'>
}

/**
 * Finds the PDF links on one (masked) line. Positions come from the masked
 * line, the texts from the original line.
 */
function findLinksOnLine (original: string, masked: string): LineMatch[] {
  const found: LineMatch[] = []

  for (const match of masked.matchAll(WIKI_LINK)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    const contentsStart = start + match[1].length + 2
    const contents = original.slice(contentsStart, end - 2)
    const target = parsePdfWikiLinkContents(contents)
    if (target === null || target.location === null) {
      continue
    }
    found.push({
      start,
      end,
      link: {
        syntax: 'wiki',
        embed: match[1] === '!',
        writtenPath: target.path,
        location: target.location,
        displayText: wikiDisplayText(contents)
      }
    })
  }

  for (const match of masked.matchAll(MARKDOWN_LINK)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    const textStart = start + match[1].length + 1
    const displayText = original.slice(textStart, textStart + match[2].length)
    const targetStart = masked.indexOf(match[3], textStart + match[2].length + 2)
    const targetText = original.slice(targetStart, targetStart + match[3].length)
    const target = parsePdfLinkTarget(targetText)
    if (target === null || target.location === null) {
      continue
    }
    found.push({
      start,
      end,
      link: {
        syntax: 'markdown',
        embed: match[1] === '!',
        writtenPath: target.path,
        location: target.location,
        displayText
      }
    })
  }

  // In order of appearance; a link inside another one is dropped
  found.sort((a, b) => a.start - b.start)
  const kept: LineMatch[] = []
  for (const candidate of found) {
    const previous = kept[kept.length - 1]
    if (previous !== undefined && candidate.start < previous.end) {
      continue
    }
    kept.push(candidate)
  }
  return kept
}

/**
 * Finds the links to places in PDFs in the text of a note (contract C11):
 * Markdown links `[text](target)` and wiki links `[[contents]]`, also when
 * embedded with `!`, whose target is a local PDF and whose fragment names a
 * valid page. Links in the YAML front matter, in fenced code blocks (also
 * inside block quotes), in inline code and in HTML comments are skipped.
 * `\r\n` and `\r` count as line breaks; line numbers start at 1, as in
 * CodeMirror. The result is ordered by line and by position in the line.
 *
 * @param   {string}         text  The text of the note
 *
 * @return  {PdfNoteLink[]}        The links
 */
export function scanPdfLinks (text: string): PdfNoteLink[] {
  const lines = text.split(/\r\n|\r|\n/)
  const masked = maskExcludedRegions(lines)
  const lineSource: LineSource = {
    lines: lines.length,
    line: (lineNumber: number) => ({ text: lines[lineNumber - 1] })
  }

  const links: PdfNoteLink[] = []
  for (let index = 0; index < lines.length; index++) {
    const matches = findLinksOnLine(lines[index], masked[index])
    if (matches.length === 0) {
      continue
    }

    const lineNumber = index + 1
    const calloutMatch = LEADING_QUOTE_MARKERS.test(lines[index])
      ? PDF_CALLOUT_HEADER.exec(lines[index].replace(LEADING_QUOTE_MARKERS, ''))
      : null
    const sourceText = extractQuotedSourceText(lineSource, lineNumber)

    for (const match of matches) {
      const link: PdfNoteLink = { line: lineNumber, ...match.link }
      if (calloutMatch !== null) {
        link.calloutColor = calloutMatch[1].trim().toLowerCase()
      }
      if (sourceText !== undefined) {
        link.sourceText = sourceText
      }
      links.push(link)
    }
  }

  return links
}
