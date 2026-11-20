/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Recognizing clicked links to PDF locations
 * CVM-Role:        Utility Function
 * License:         GNU GPL v3
 *
 * Description:     The pure part of following a link to a place in a PDF
 *                  (R60, contract C5): splitting a Markdown link target or the
 *                  contents of a PDF++ wiki link (`[[file.pdf#page=8&...|text]]`)
 *                  into the path and the location of its fragment, reading the
 *                  quoted source text below the link (the `> > ` lines of a
 *                  PDF++ quote) and ranking the files that a wiki link's file
 *                  name may refer to. The editor (markdown-editor's
 *                  open-markdown-link.ts) opens the file and dispatches the
 *                  location request.
 *
 * END HEADER
 */

import type { PdfLocation } from '@dts/common/pdf-viewer'
import { parsePdfLinkFragment } from './link-fragment'

/**
 * A link to a PDF: the path as written (still percent-encoded in Markdown
 * links) and the location its fragment names, or null if it names none (no
 * fragment, or one without a valid `page=`).
 */
export interface PdfLinkTarget {
  path: string
  location: PdfLocation|null
}

/**
 * The part of a CodeMirror Text that extractQuotedSourceText needs; line
 * numbers start at 1
 */
export interface LineSource {
  lines: number
  line (lineNumber: number): { text: string }
}

/**
 * A URL scheme of at least two characters, so that a Windows drive letter
 * (`C:`) does not count as one
 */
const URL_SCHEME = /^([a-z][a-z0-9+.-]+):/i

/**
 * Schemes under which a link still names a local file
 */
const LOCAL_FILE_SCHEMES = [ 'file', 'safe-file' ]

/**
 * Splits a link target at its first `#` into the path and the fragment
 * (without the `#`; empty if there is none). Angle brackets around the whole
 * target (`<path with spaces.pdf#page=2>`) and surrounding whitespace are
 * removed first.
 *
 * @param   {string}  target  The link target
 *
 * @return  {{ path: string, fragment: string }}  The path and the fragment
 */
export function splitLinkTarget (target: string): { path: string, fragment: string } {
  let text = target.trim()
  if (text.startsWith('<') && text.endsWith('>')) {
    text = text.slice(1, -1).trim()
  }

  const hashIndex = text.indexOf('#')
  if (hashIndex < 0) {
    return { path: text, fragment: '' }
  }
  return { path: text.slice(0, hashIndex), fragment: text.slice(hashIndex + 1) }
}

/**
 * @param   {string}   path  A path or link target without fragment
 *
 * @return  {boolean}        True if it ends with `.pdf` (in any case)
 */
export function isPdfPath (path: string): boolean {
  return /\.pdf$/i.test(path.trim())
}

/**
 * Recognizes the target of a Markdown link as a link to a local PDF. Returns
 * null for anything else: other files, web addresses (any scheme but `file`
 * and `safe-file`), and links to headings (`#...`).
 *
 * @param   {string}                target  The link target, e.g. `a%20b.pdf#page=8&selection=1,0,2,5`
 *
 * @return  {PdfLinkTarget|null}            The path as written and the location
 */
export function parsePdfLinkTarget (target: string): PdfLinkTarget|null {
  const { path, fragment } = splitLinkTarget(target)
  if (path === '' || !isPdfPath(path)) {
    return null
  }

  const scheme = URL_SCHEME.exec(path)
  if (scheme !== null && !LOCAL_FILE_SCHEMES.includes(scheme[1].toLowerCase())) {
    return null
  }

  return { path, location: fragment === '' ? null : parsePdfLinkFragment(fragment) }
}

/**
 * Recognizes the contents of a wiki link (the text between `[[` and `]]`) as
 * a link to a PDF. PDF++ writes `file.pdf#page=8&selection=...|display text`;
 * the part before the pipe is tried first and, for the `title|link` link
 * format, the part after the last pipe second.
 *
 * @param   {string}                contents  The wiki link contents
 *
 * @return  {PdfLinkTarget|null}              The path as written and the location, or null
 */
export function parsePdfWikiLinkContents (contents: string): PdfLinkTarget|null {
  const parts = contents.split('|')
  const candidates = parts.length > 1 ? [ parts[0], parts[parts.length - 1] ] : [contents]
  for (const candidate of candidates) {
    const { path, fragment } = splitLinkTarget(candidate)
    if (path !== '' && isPdfPath(path) && URL_SCHEME.exec(path) === null) {
      return { path, location: fragment === '' ? null : parsePdfLinkFragment(fragment) }
    }
  }
  return null
}

/**
 * Counts the block quote markers (`>`) at the start of a line, allowing up to
 * three spaces of indentation and spaces between the markers, and returns
 * where the text after the marker number `depth` (and one optional space
 * after it) starts.
 *
 * @param   {string}  lineText  The line
 *
 * @return  {{ depth: number, contentStarts: number[] }}  The number of markers; contentStarts[k] is where the text after marker k + 1 begins
 */
function quoteMarkers (lineText: string): { depth: number, contentStarts: number[] } {
  const contentStarts: number[] = []
  let position = 0
  let indentation = 0
  while (indentation < 3 && lineText[position] === ' ') {
    position++
    indentation++
  }

  while (lineText[position] === '>') {
    position++
    if (lineText[position] === ' ' || lineText[position] === '\t') {
      position++
    }
    contentStarts.push(position)
    // Further markers may follow after spaces
    let lookahead = position
    while (lineText[lookahead] === ' ' || lineText[lookahead] === '\t') {
      lookahead++
    }
    if (lineText[lookahead] !== '>') {
      break
    }
    position = lookahead
  }

  return { depth: contentStarts.length, contentStarts }
}

/**
 * Returns the quoted source text below a link: the lines directly following
 * the link's line that are quoted one level deeper than it, as PDF++ writes
 * the text below the link in the header of a `> [!PDF|color]` callout
 * (`> > text`). The link's line must itself be inside a block quote; the
 * markers of the deeper level and one space after them are removed, and
 * several such lines are joined with `\n`. Returns undefined if there is no
 * such line, or if they hold only whitespace.
 *
 * @param   {LineSource}        document    The document, e.g. an EditorState's doc
 * @param   {number}            lineNumber  The number (from 1) of the line holding the link
 *
 * @return  {string|undefined}              The source text, or undefined
 */
export function extractQuotedSourceText (document: LineSource, lineNumber: number): string|undefined {
  if (lineNumber < 1 || lineNumber > document.lines) {
    return undefined
  }

  const linkDepth = quoteMarkers(document.line(lineNumber).text).depth
  if (linkDepth === 0) {
    return undefined
  }

  const sourceLines: string[] = []
  for (let next = lineNumber + 1; next <= document.lines; next++) {
    const lineText = document.line(next).text
    const markers = quoteMarkers(lineText)
    if (markers.depth <= linkDepth) {
      break
    }
    sourceLines.push(lineText.slice(markers.contentStarts[linkDepth]))
  }

  const sourceText = sourceLines.join('\n')
  return sourceText.trim() === '' ? undefined : sourceText
}

/**
 * Splits a path into its segments, whatever the separator
 */
function pathSegments (path: string): string[] {
  return path.split(/[\\/]+/).filter(segment => segment !== '' && segment !== '.')
}

/**
 * Returns the files a wiki link's path may refer to, best first. Obsidian
 * writes either the file name alone (if it is unique in the vault) or a path
 * relative to the vault, so a file qualifies if its name equals the written
 * file name (ignoring case). Files whose path ends with all written segments
 * come first; among equals, those sharing more leading directories with the
 * note come first.
 *
 * @param   {string[]}  files          Absolute paths of candidate files
 * @param   {string}    writtenPath    The path as written in the link, e.g. `Papers/a.pdf`
 * @param   {string}    noteDirectory  Absolute path of the directory of the note holding the link
 *
 * @return  {string[]}                 The qualifying files, best first
 */
export function rankPdfCandidates (files: string[], writtenPath: string, noteDirectory: string): string[] {
  const written = pathSegments(writtenPath).map(segment => segment.toLowerCase())
  if (written.length === 0) {
    return []
  }

  const fileName = written[written.length - 1]
  const noteSegments = pathSegments(noteDirectory).map(segment => segment.toLowerCase())

  const ranked = files
    .map(file => ({ file, segments: pathSegments(file).map(segment => segment.toLowerCase()) }))
    .filter(candidate => candidate.segments.length > 0 && candidate.segments[candidate.segments.length - 1] === fileName)
    .map(candidate => {
      const endsWithWritten = written.every((segment, k) => candidate.segments[candidate.segments.length - written.length + k] === segment)
      let sharedDirectories = 0
      while (
        sharedDirectories < noteSegments.length &&
        sharedDirectories < candidate.segments.length - 1 &&
        candidate.segments[sharedDirectories] === noteSegments[sharedDirectories]
      ) {
        sharedDirectories++
      }
      return { file: candidate.file, endsWithWritten, sharedDirectories }
    })

  ranked.sort((a, b) => {
    if (a.endsWithWritten !== b.endsWithWritten) {
      return a.endsWithWritten ? -1 : 1
    }
    return b.sharedDirectories - a.sharedDirectories
  })

  return ranked.map(candidate => candidate.file)
}
