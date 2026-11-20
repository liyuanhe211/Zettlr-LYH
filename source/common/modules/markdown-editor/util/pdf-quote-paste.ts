/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Relative PDF links when pasting quotes
 * CVM-Role:        Utility Function
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH R60: Copy as Quote in the PDF viewer writes the
 *                  link to the PDF with its absolute path, so that the quote
 *                  works wherever it is pasted. When it is pasted into a
 *                  note, the paste handler turns every Markdown link whose
 *                  target is the absolute path of a PDF (with or without a
 *                  `#page=...` fragment) into a link relative to the note's
 *                  directory, encoded the way PDF++ encodes link targets
 *                  (encodePdfLinkPath). Links to PDFs on another drive or
 *                  share stay absolute; everything else stays untouched.
 *
 * END HEADER
 */

import { encodePdfLinkPath, isPdfPath } from 'source/common/modules/pdf-text'

/**
 * An absolute path split into its root and its segments, with `.` and `..`
 * resolved
 */
interface AbsolutePath {
  /**
   * `C:` (drive letter in uppercase), `//server/share` or `/`
   */
  root: string
  segments: string[]
  /**
   * True for Windows paths (drive letter or UNC share), whose names compare
   * without regard to case
   */
  caseInsensitive: boolean
}

/**
 * A Markdown link destination found in the pasted text
 */
interface LinkDestination {
  /**
   * Offset of the destination's first character (after `](`)
   */
  start: number
  /**
   * Offset right after the destination (the closing parenthesis)
   */
  end: number
  /**
   * True if the destination is written in angle brackets
   */
  angle: boolean
  /**
   * The destination without angle brackets
   */
  target: string
}

/**
 * The escapes encodePdfLinkPath writes: space, backslash, U+0000, U+0008,
 * U+000B, U+000C and U+000E to U+001F. Other `%` sequences are part of the
 * file name, since PDF++ does not encode `%`.
 */
const PDF_LINK_PATH_ESCAPES = /%(?:20|5[cC]|0[08bBcCeEfF]|1[0-9a-fA-F])/g

/**
 * Reverses encodePdfLinkPath
 *
 * @param   {string}  path  An encoded link path, e.g. E:/Literature/a%20b.pdf
 *
 * @return  {string}        The path, e.g. E:/Literature/a b.pdf
 */
export function decodePdfLinkPath (path: string): string {
  return path.replace(PDF_LINK_PATH_ESCAPES, escape => decodeURIComponent(escape))
}

/**
 * Splits an absolute path into root and segments. Windows paths may use
 * either separator; `.` segments are dropped and `..` segments remove the
 * segment before them.
 *
 * @param   {string}             path  A path
 *
 * @return  {AbsolutePath|null}        The parts, or null if the path is not absolute
 */
function parseAbsolutePath (path: string): AbsolutePath|null {
  let root: string
  let rest: string
  let caseInsensitive: boolean

  const drive = /^([a-zA-Z]):[\\/]/.exec(path)
  if (drive !== null) {
    root = `${drive[1].toUpperCase()}:`
    rest = path.slice(3).replace(/\\/g, '/')
    caseInsensitive = true
  } else if (/^[\\/]{2}[^\\/]/.test(path)) {
    const parts = path.replace(/\\/g, '/').slice(2).split('/')
    if (parts.length < 2 || parts[1] === '') {
      return null
    }
    root = `//${parts[0]}/${parts[1]}`
    rest = parts.slice(2).join('/')
    caseInsensitive = true
  } else if (path.startsWith('/')) {
    root = '/'
    rest = path.slice(1)
    caseInsensitive = false
  } else {
    return null
  }

  const segments: string[] = []
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') {
      continue
    }

    if (segment === '..') {
      segments.pop()
    } else {
      segments.push(segment)
    }
  }

  return { root, segments, caseInsensitive }
}

/**
 * Computes the path of a file relative to a directory, both given as parsed
 * absolute paths
 *
 * @param   {AbsolutePath}  target     The file
 * @param   {AbsolutePath}  directory  The directory
 *
 * @return  {string|null}              The relative path with `/`, or null if
 *                                     the two lie on different drives or shares
 */
function relativeToDirectory (target: AbsolutePath, directory: AbsolutePath): string|null {
  const caseInsensitive = target.caseInsensitive || directory.caseInsensitive
  const same = (a: string, b: string): boolean => caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b

  if (!same(target.root, directory.root) || target.segments.length === 0) {
    return null
  }

  // The file name itself never counts as a common directory
  let common = 0
  while (
    common < directory.segments.length &&
    common < target.segments.length - 1 &&
    same(directory.segments[common], target.segments[common])
  ) {
    common++
  }

  const parts: string[] = []
  for (let level = common; level < directory.segments.length; level++) {
    parts.push('..')
  }
  parts.push(...target.segments.slice(common))
  return parts.join('/')
}

/**
 * Computes the path of a PDF relative to a directory, as written into a
 * link: with `/` as separator, `..` for every level up, and no `./` prefix
 * (like PDF++ writes relative links).
 *
 * @param   {string}       pdfPath    The absolute path of the PDF (either separator)
 * @param   {string}       directory  The absolute path of the directory
 *
 * @return  {string|null}             The relative path (not encoded), or null
 *                                    if either path is not absolute or the
 *                                    two lie on different drives or shares
 */
export function relativePdfLinkPath (pdfPath: string, directory: string): string|null {
  const target = parseAbsolutePath(pdfPath)
  const base = parseAbsolutePath(directory)
  if (target === null || base === null) {
    return null
  }

  return relativeToDirectory(target, base)
}

/**
 * Reads the destination of a Markdown inline link, starting right after
 * `](`. Supports bare destinations (with balanced parentheses and backslash
 * escapes, ending at the closing parenthesis) and destinations in angle
 * brackets. Destinations followed by a title are not recognized.
 *
 * @param   {string}                text   The text
 * @param   {number}                start  Offset right after `](`
 *
 * @return  {LinkDestination|null}         The destination, or null
 */
function readLinkDestination (text: string, start: number): LinkDestination|null {
  if (text.charAt(start) === '<') {
    let index = start + 1
    while (index < text.length && text[index] !== '>' && text[index] !== '<' && text[index] !== '\n') {
      index++
    }

    if (text.charAt(index) !== '>' || text.charAt(index + 1) !== ')') {
      return null
    }

    return { start, end: index + 1, angle: true, target: text.slice(start + 1, index) }
  }

  let depth = 0
  let index = start
  while (index < text.length) {
    const character = text[index]
    if (character === '\\' && index + 1 < text.length) {
      index += 2
      continue
    }

    if (/\s/.test(character)) {
      return null
    }

    if (character === '(') {
      depth++
    } else if (character === ')') {
      if (depth === 0) {
        break
      }
      depth--
    }
    index++
  }

  if (index >= text.length || index === start) {
    return null
  }

  return { start, end: index, angle: false, target: text.slice(start, index) }
}

/**
 * Returns the rewritten destination if it names a PDF by an absolute path
 * that can be expressed relative to the directory, otherwise null. The
 * fragment is kept as written.
 *
 * @param   {LinkDestination}  destination  The destination
 * @param   {AbsolutePath}     directory    The note's directory
 *
 * @return  {string|null}                   The new destination text (with
 *                                          angle brackets if the old one had them)
 */
function rewriteDestination (destination: LinkDestination, directory: AbsolutePath): string|null {
  const hashIndex = destination.target.indexOf('#')
  const pathPart = hashIndex < 0 ? destination.target : destination.target.slice(0, hashIndex)
  const fragmentPart = hashIndex < 0 ? '' : destination.target.slice(hashIndex)
  if (!isPdfPath(pathPart)) {
    return null
  }

  const target = parseAbsolutePath(destination.angle ? pathPart : decodePdfLinkPath(pathPart))
  if (target === null) {
    return null
  }

  const relative = relativeToDirectory(target, directory)
  if (relative === null) {
    return null
  }

  return destination.angle
    ? `<${relative}${fragmentPart}>`
    : `${encodePdfLinkPath(relative)}${fragmentPart}`
}

/**
 * Rewrites the Markdown links in a pasted text whose target is the absolute
 * path of a PDF (as Copy as Quote writes them, e.g.
 * `[《a b》P3](E:/Literature/a%20b.pdf#page=3&selection=1,0,2,5&color=yellow)`)
 * into links relative to the note's directory. Returns the text unchanged
 * if the note has no absolute path (e.g. it has never been saved) or no link
 * qualifies.
 *
 * @param   {string}  text      The pasted text
 * @param   {string}  notePath  The absolute path of the note pasted into
 *
 * @return  {string}            The text with relative PDF links
 */
export function rewritePdfLinksForNote (text: string, notePath: string): string {
  if (!text.includes('](')) {
    return text
  }

  const note = parseAbsolutePath(notePath)
  if (note === null || note.segments.length === 0) {
    return text
  }

  const directory: AbsolutePath = { ...note, segments: note.segments.slice(0, -1) }
  const parts: string[] = []
  let cursor = 0
  let marker = text.indexOf('](')
  while (marker >= 0) {
    const destination = readLinkDestination(text, marker + 2)
    let next = marker + 2
    if (destination !== null) {
      const replacement = rewriteDestination(destination, directory)
      if (replacement !== null) {
        parts.push(text.slice(cursor, destination.start), replacement)
        cursor = destination.end
      }
      next = destination.end
    }
    marker = text.indexOf('](', next)
  }

  if (parts.length === 0) {
    return text
  }

  parts.push(text.slice(cursor))
  return parts.join('')
}
