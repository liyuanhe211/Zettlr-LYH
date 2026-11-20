/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Scratch note naming, recognition and filename suggestion
 * CVM-Role:        Utility
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Pressing Ctrl+N creates a scratch note: a file named
 *                  UNSAVED_<yyyymmdd>-<hhmmss>.md inside a dedicated scratch
 *                  folder, which is written automatically and only asks for
 *                  a location once the user saves it. A scratch note can be
 *                  renamed in place (R102) and stays a scratch note: every
 *                  file inside the scratch folder itself whose name ends in
 *                  .md is one, whatever its name. A scratch note that starts
 *                  with a level-1 heading is renamed after that heading
 *                  automatically (R132). Since R135, a closed scratch note
 *                  that the user did not save is moved into the __Unsaved
 *                  folder inside the undo history folder, with the close time
 *                  appended to its name; the _Discarded subfolder of earlier
 *                  versions is no longer created and is only recognized when
 *                  the old default scratch folder Zettlr_Unsaved is migrated
 *                  to the new default Zettlr\__Unsaved. This module contains the pure
 *                  naming, recognition and filename-suggestion logic behind
 *                  this feature. It deliberately depends on neither electron
 *                  nor fs, so that it can be tested directly.
 *
 * END HEADER
 */

import path from 'path'
import sanitize from 'sanitize-filename'

/**
 * The file names generated for new scratch notes start with this prefix. A
 * scratch note that the user has renamed does not carry it anymore.
 */
export const SCRATCH_NOTE_PREFIX = 'UNSAVED_'

/**
 * Subfolder of the scratch folder that received discarded scratch notes before
 * R135. The program no longer creates it; it is only recognized when the old
 * default scratch folder is migrated.
 */
export const SCRATCH_DISCARDED_FOLDER = '_Discarded'

/**
 * Name of the old default scratch folder inside the documents folder (before
 * R135). It is only used to recognize that folder, so that it can be migrated
 * to the new default folder.
 */
export const SCRATCH_LEGACY_FOLDER_NAME = 'Zettlr_Unsaved'

/**
 * The path segments, below the documents folder, of the scratch folder used
 * whenever no scratch folder has been configured: Zettlr\__Unsaved (R135).
 */
export const SCRATCH_DEFAULT_FOLDER_SEGMENTS = [ 'Zettlr', '__Unsaved' ] as const

/**
 * Subfolder of the undo history folder that receives closed scratch notes the
 * user did not save, and the discarded notes of the old default folder (R135).
 */
export const SCRATCH_HISTORY_SUBFOLDER = '__Unsaved'

/**
 * Delay (in milliseconds) after the last modification before a scratch note is
 * written to disk.
 */
export const SCRATCH_AUTOSAVE_DELAY = 1000

/**
 * Maximum length, counted in Unicode code points, of the file name (without
 * extension) suggested when a scratch note is saved.
 */
export const SCRATCH_SUGGESTED_NAME_MAX_LENGTH = 60

const SCRATCH_NOTE_EXTENSION = '.md'
const DISCARDED_MARKER = '__DISCARDED_'
const CLOSED_MARKER = '__CLOSED_'
const FALLBACK_SUGGESTED_NAME = 'Untitled'

// Matches the file names the program generates for new scratch notes, such as
// UNSAVED_20261006-202232.md and UNSAVED_20261006-202232_2.md
const GENERATED_SCRATCH_NOTE_FILE_NAME_PATTERN = new RegExp(`^${SCRATCH_NOTE_PREFIX}\\d{8}-\\d{6}(_\\d+)?\\.md$`)

// Markdown markers that may precede the text of the first line. They are
// stripped repeatedly, so that nested markers such as "> - [ ] " disappear
// completely. Each pattern only looks at the start of an already trimmed line.
const ATX_HEADING_MARKER = /^#{1,6}(?:\s+|$)/
const LEADING_MARKER_PATTERNS = [
  ATX_HEADING_MARKER,
  /^>\s*/, // Block quote
  /^[-*+](?:\s+|$)/, // Bullet list item
  /^\d{1,9}[.)](?:\s+|$)/, // Ordered list item
  /^\[[ xX]\](?:\s+|$)/ // Task list checkbox
]

// Emphasis and inline code delimiters that are removed when they enclose the
// whole line, e.g. "**Title**" or "`Title`"
const ENCLOSING_DELIMITERS = new Set([ '*', '_', '`', '~' ])

/**
 * Pads a number with leading zeros to the given length.
 *
 * @param   {number}  value   The number to pad
 * @param   {number}  length  The minimum number of digits
 *
 * @return  {string}          The padded number
 */
function padNumber (value: number, length = 2): string {
  return String(value).padStart(length, '0')
}

/**
 * Formats a date as local time in the form yyyymmdd-hhmmss.
 *
 * @param   {Date}    date  The date to format
 *
 * @return  {string}        The timestamp, e.g. 20261006-202232
 */
export function formatScratchTimestamp (date: Date): string {
  const datePart = padNumber(date.getFullYear(), 4) + padNumber(date.getMonth() + 1) + padNumber(date.getDate())
  const timePart = padNumber(date.getHours()) + padNumber(date.getMinutes()) + padNumber(date.getSeconds())
  return `${datePart}-${timePart}`
}

/**
 * Returns stem + extension, or, if that name is already taken, the first of
 * stem_2 + extension, stem_3 + extension, ... that is still free. Names are
 * compared case-insensitively, since Windows file systems do so as well (and
 * doing the same on other platforms does no harm).
 *
 * @param   {string}            stem           The file name without extension
 * @param   {string}            extension      The extension including the dot
 * @param   {Iterable<string>}  existingNames  The names already taken
 *
 * @return  {string}                           The first free file name
 */
function firstFreeFileName (stem: string, extension: string, existingNames: Iterable<string>): string {
  const takenNames = new Set<string>()
  for (const name of existingNames) {
    takenNames.add(name.toLowerCase())
  }

  let candidate = stem + extension
  let counter = 2
  while (takenNames.has(candidate.toLowerCase())) {
    candidate = `${stem}_${counter}${extension}`
    counter++
  }

  return candidate
}

/**
 * Returns the file name for a new scratch note created at the given time, of
 * the form UNSAVED_<yyyymmdd>-<hhmmss>.md. If that name is already taken, _2,
 * _3, ... is appended before the extension.
 *
 * @param   {Date}              date           The creation time (local time)
 * @param   {Iterable<string>}  existingNames  The file names in the scratch folder
 *
 * @return  {string}                           The new file name
 */
export function scratchNoteFileName (date: Date, existingNames: Iterable<string>): string {
  const stem = SCRATCH_NOTE_PREFIX + formatScratchTimestamp(date)
  return firstFreeFileName(stem, SCRATCH_NOTE_EXTENSION, existingNames)
}

/**
 * Returns the name under which a discarded scratch note was stored in the
 * _Discarded folder before R135: the original stem, followed by __DISCARDED_
 * and the discard time, followed by the original extension. If that name is
 * already taken, _2, _3, ... is appended before the extension. Since R135,
 * closed scratch notes are named with closedScratchFileName instead; this
 * function is kept for recognizing the names of old discarded notes.
 *
 * @param   {string}            scratchFileName  The file name of the scratch note
 * @param   {Date}              discardDate      The discard time (local time)
 * @param   {Iterable<string>}  existingNames    The file names in the _Discarded folder
 *
 * @return  {string}                             The file name for the discarded note
 */
export function discardedFileName (scratchFileName: string, discardDate: Date, existingNames: Iterable<string>): string {
  const baseName = path.basename(scratchFileName)
  const extension = path.extname(baseName)
  const originalStem = baseName.slice(0, baseName.length - extension.length)
  const stem = originalStem + DISCARDED_MARKER + formatScratchTimestamp(discardDate)
  return firstFreeFileName(stem, extension, existingNames)
}

/**
 * Returns the name under which a closed scratch note that the user did not
 * save is stored in the __Unsaved folder of the undo history folder (R135):
 * the original stem, followed by __CLOSED_ and the close time, followed by the
 * original extension, e.g. UNSAVED_20261022-230626__CLOSED_20261023-002812.md.
 * A renamed scratch note keeps its stem (周会记录.md becomes
 * 周会记录__CLOSED_<time>.md). If that name is already taken (compared
 * case-insensitively), _2, _3, ... is appended before the extension.
 *
 * @param   {string}            scratchFileName  The file name of the scratch note
 * @param   {Date}              closeDate        The close time (local time)
 * @param   {Iterable<string>}  existingNames    The file names in the target folder
 *
 * @return  {string}                             The file name for the closed note
 */
export function closedScratchFileName (scratchFileName: string, closeDate: Date, existingNames: Iterable<string>): string {
  const baseName = path.basename(scratchFileName)
  const extension = path.extname(baseName)
  const originalStem = baseName.slice(0, baseName.length - extension.length)
  const stem = originalStem + CLOSED_MARKER + formatScratchTimestamp(closeDate)
  return firstFreeFileName(stem, extension, existingNames)
}

/**
 * Checks whether a file name (without any directory) can be the name of a
 * scratch note: it ends in a lower case .md, has a non-empty name in front of
 * that extension, and does not start with a dot or a tilde (which excludes
 * hidden files and the temporary files other programs leave behind). Whether
 * the name has the generated form UNSAVED_<yyyymmdd>-<hhmmss>[_n].md does not
 * matter, since a scratch note can be renamed (R102).
 *
 * @param   {string}   name  The file name
 *
 * @return  {boolean}        True if the name is a valid scratch note file name
 */
export function isScratchNoteFileName (name: string): boolean {
  return name.endsWith(SCRATCH_NOTE_EXTENSION) &&
    name.length > SCRATCH_NOTE_EXTENSION.length &&
    !name.startsWith('.') &&
    !name.startsWith('~')
}

/**
 * Checks whether a file name (without any directory) is one of the names the
 * program generates for new scratch notes: UNSAVED_<yyyymmdd>-<hhmmss>.md, or
 * with a counter suffix like UNSAVED_<yyyymmdd>-<hhmmss>_2.md. Any other name
 * means that the user has renamed the scratch note.
 *
 * @param   {string}   name  The file name
 *
 * @return  {boolean}        True if the name matches the generated pattern
 */
export function isGeneratedScratchNoteFileName (name: string): boolean {
  return GENERATED_SCRATCH_NOTE_FILE_NAME_PATTERN.test(name)
}

/**
 * Checks whether a path points to a scratch note: its parent folder must be
 * the scratch folder itself (not a subfolder such as _Discarded), and its file
 * name must be a valid scratch note file name (see isScratchNoteFileName). Both
 * folders are normalized with path.resolve; on Windows, they are compared
 * case-insensitively.
 *
 * @param   {string}   filePath          The path to check
 * @param   {string}   scratchDirectory  The current scratch folder
 *
 * @return  {boolean}                    True if the path is a scratch note
 */
export function isScratchNotePath (filePath: string, scratchDirectory: string): boolean {
  // An empty folder would resolve to the working directory; never match that.
  if (scratchDirectory.trim() === '') {
    return false
  }

  if (!isScratchNoteFileName(path.basename(filePath))) {
    return false
  }

  const parentDirectory = path.dirname(path.resolve(filePath))
  const resolvedScratchDirectory = path.resolve(scratchDirectory)

  if (process.platform === 'win32') {
    return parentDirectory.toLowerCase() === resolvedScratchDirectory.toLowerCase()
  }

  return parentDirectory === resolvedScratchDirectory
}

/**
 * Returns the scratch folder to use. An empty (or whitespace-only) configured
 * value falls back to the folder Zettlr\__Unsaved inside the documents folder
 * (R135; before, the fallback was Zettlr_Unsaved).
 *
 * @param   {string}  configured     The configured scratch folder
 * @param   {string}  documentsPath  The user's documents folder
 *
 * @return  {string}                 The absolute scratch folder
 */
export function resolveScratchDirectory (configured: string, documentsPath: string): string {
  const trimmed = configured.trim()
  if (trimmed === '') {
    return path.join(documentsPath, ...SCRATCH_DEFAULT_FOLDER_SEGMENTS)
  }

  return path.resolve(trimmed)
}

/**
 * Checks whether the configured scratch folder is the old default scratch
 * folder, which has to be migrated to the new default (R135): the configured
 * value is empty (or whitespace-only), or it resolves to the Zettlr_Unsaved
 * folder inside the documents folder. On Windows, the comparison ignores case.
 *
 * @param   {string}   configured       The configured scratch folder
 * @param   {string}   documentsPath    The user's documents folder
 * @param   {boolean}  caseInsensitive  Whether to ignore case (default: on Windows)
 *
 * @return  {boolean}                   True if the old default folder is in use
 */
export function isLegacyDefaultScratchDirectory (configured: string, documentsPath: string, caseInsensitive = process.platform === 'win32'): boolean {
  const trimmed = configured.trim()
  if (trimmed === '') {
    return true
  }

  const resolved = path.resolve(trimmed)
  const legacyDirectory = path.resolve(documentsPath, SCRATCH_LEGACY_FOLDER_NAME)

  if (caseInsensitive) {
    return resolved.toLowerCase() === legacyDirectory.toLowerCase()
  }

  return resolved === legacyDirectory
}

/**
 * Checks whether the content of a scratch note is blank, i.e. consists of
 * nothing but whitespace. JavaScript's \s includes the ideographic space
 * (U+3000) and the byte order mark (U+FEFF).
 *
 * @param   {string}   content  The content of the scratch note
 *
 * @return  {boolean}           True if nothing but whitespace remains
 */
export function isBlankScratchContent (content: string): boolean {
  return !/\S/.test(content)
}

/**
 * Checks like isBlankScratchContent whether a text given in chunks (such as
 * the iterator of a CodeMirror document) is blank, without joining the chunks
 * into one string. It stops at the first chunk with visible content.
 *
 * @param   {Iterable<string>}  chunks  The chunks of the text
 *
 * @return  {boolean}                   True if nothing but whitespace remains
 */
export function isBlankScratchText (chunks: Iterable<string>): boolean {
  for (const chunk of chunks) {
    if (/\S/.test(chunk)) {
      return false
    }
  }
  return true
}

/**
 * Picks the open scratch notes that the tabs and the Files section mark as
 * unsaved (R40, R165): every one except those known to be blank. A blank
 * scratch note holds nothing that could be lost, and closing it removes it
 * without asking, so it shows the normal icon and no unsaved mark. A scratch
 * note whose content is not known yet counts as unsaved.
 *
 * @param   {string[]}                                  scratchPaths  The open scratch notes
 * @param   {(filePath: string) => boolean|undefined}  isBlank       Tells whether a scratch note is blank, undefined while unknown
 *
 * @return  {string[]}                                                The scratch notes to mark as unsaved
 */
export function selectUnsavedScratchNotePaths (
  scratchPaths: string[],
  isBlank: (filePath: string) => boolean|undefined
): string[] {
  return scratchPaths.filter(scratchPath => isBlank(scratchPath) !== true)
}

/**
 * Returns the index of the first line after a YAML front matter block, or 0 if
 * the lines do not start with a complete front matter block (an opening ---
 * line followed by a closing --- or ... line).
 *
 * @param   {string[]}  lines  The lines of the document
 *
 * @return  {number}           The index of the first line after the front matter
 */
function indexAfterFrontMatter (lines: string[]): number {
  if (lines.length === 0 || lines[0].trimEnd() !== '---') {
    return 0
  }

  for (let index = 1; index < lines.length; index++) {
    const line = lines[index].trimEnd()
    if (line === '---' || line === '...') {
      return index + 1
    }
  }

  // No closing line, so this is not a front matter block
  return 0
}

/**
 * Checks whether a line is a thematic break (horizontal rule) such as ---,
 * * * * or ___, which consists of nothing but Markdown markup.
 *
 * @param   {string}   line  The line to check
 *
 * @return  {boolean}        True if the line is a thematic break
 */
function isThematicBreak (line: string): boolean {
  const compact = line.replace(/\s/g, '')
  if (compact.length < 3) {
    return false
  }

  const marker = compact[0]
  if (marker !== '-' && marker !== '*' && marker !== '_') {
    return false
  }

  for (const character of compact) {
    if (character !== marker) {
      return false
    }
  }

  return true
}

/**
 * Removes the optional closing sequence of an ATX heading, e.g. the trailing
 * "##" in "## Title ##". Hashes directly attached to a word (as in "C#") are
 * part of the text and are kept.
 *
 * @param   {string}  text  The heading text, already without the opening hashes
 *
 * @return  {string}        The heading text without the closing sequence
 */
function stripClosingHeadingSequence (text: string): string {
  let end = text.length
  while (end > 0 && text[end - 1] === '#') {
    end--
  }

  if (end === text.length) {
    return text // No closing sequence
  }

  if (end === 0) {
    return '' // Nothing but hashes
  }

  if (/\s/.test(text[end - 1])) {
    return text.slice(0, end).trim()
  }

  return text
}

/**
 * Removes the Markdown markers at the start of a line: heading hashes, block
 * quote markers, bullet and ordered list markers, and task list checkboxes.
 *
 * @param   {string}  line  The line
 *
 * @return  {string}        The trimmed line without leading markers
 */
function stripLeadingMarkdownMarkers (line: string): string {
  let result = line.trim()
  let isHeading = false
  let markerRemoved = true

  while (markerRemoved && result !== '') {
    markerRemoved = false
    for (const pattern of LEADING_MARKER_PATTERNS) {
      const match = pattern.exec(result)
      if (match !== null) {
        isHeading = isHeading || pattern === ATX_HEADING_MARKER
        result = result.slice(match[0].length).trim()
        markerRemoved = true
        break
      }
    }
  }

  return isHeading ? stripClosingHeadingSequence(result) : result
}

/**
 * Removes emphasis or inline code delimiters that enclose the whole text, e.g.
 * "**Title**", "_Title_", "`Title`" or "~~Title~~". Nested pairs such as
 * "**_Title_**" are removed one after another.
 *
 * @param   {string}  text  The trimmed text
 *
 * @return  {string}        The text without enclosing delimiters
 */
function stripEnclosingDelimiters (text: string): string {
  let result = text

  while (result.length > 0 && ENCLOSING_DELIMITERS.has(result[0]) && result[result.length - 1] === result[0]) {
    const delimiter = result[0]

    let leadingRun = 0
    while (leadingRun < result.length && result[leadingRun] === delimiter) {
      leadingRun++
    }

    if (leadingRun === result.length) {
      return '' // Nothing but delimiters, e.g. "**"
    }

    let trailingRun = 0
    while (result[result.length - 1 - trailingRun] === delimiter) {
      trailingRun++
    }

    const runLength = Math.min(leadingRun, trailingRun)
    result = result.slice(runLength, result.length - runLength).trim()
  }

  return result
}

/**
 * Removes trailing spaces and dots. Implemented as a loop rather than a regular
 * expression to avoid quadratic backtracking on long runs of spaces and dots.
 *
 * @param   {string}  text  The text
 *
 * @return  {string}        The text without trailing spaces and dots
 */
function stripTrailingSpacesAndDots (text: string): string {
  let end = text.length
  while (end > 0 && (text[end - 1] === ' ' || text[end - 1] === '.')) {
    end--
  }
  return text.slice(0, end)
}

/**
 * Turns a line of Markdown into a file name stem: markup is removed, invalid
 * characters are replaced with hyphens, whitespace is collapsed, and the
 * result is cut to SCRATCH_SUGGESTED_NAME_MAX_LENGTH code points.
 *
 * @param   {string}  line  The line
 *
 * @return  {string}        The file name stem, possibly empty
 */
function fileNameStemFromLine (line: string): string {
  if (isThematicBreak(line)) {
    return ''
  }

  let stem = stripEnclosingDelimiters(stripLeadingMarkdownMarkers(line))

  // Collapse whitespace (including tabs) and remove trailing dots BEFORE
  // sanitizing: sanitize-filename would otherwise turn tabs, as well as
  // trailing spaces and dots, into the replacement character.
  stem = stripTrailingSpacesAndDots(stem.replace(/\s+/g, ' ').trim())
  stem = sanitize(stem, { replacement: '-' })
  stem = stripTrailingSpacesAndDots(stem.replace(/\s+/g, ' ').trim())

  // Cut by code points, so that CJK characters and emoji count as one each
  stem = Array.from(stem).slice(0, SCRATCH_SUGGESTED_NAME_MAX_LENGTH).join('')
  return stripTrailingSpacesAndDots(stem)
}

/**
 * Returns the creation time encoded in a generated scratch note file name, e.g.
 * 20261006-202232 for UNSAVED_20261006-202232.md, or 20261006-202232_2 for
 * UNSAVED_20261006-202232_2.md.
 *
 * @param   {string}  scratchFileName  The generated file name of the scratch note
 *
 * @return  {string}                   The creation time part of the name
 */
function creationTimeFromFileName (scratchFileName: string): string {
  let name = path.basename(scratchFileName)

  if (name.toLowerCase().endsWith(SCRATCH_NOTE_EXTENSION)) {
    name = name.slice(0, name.length - SCRATCH_NOTE_EXTENSION.length)
  }

  if (name.startsWith(SCRATCH_NOTE_PREFIX)) {
    name = name.slice(SCRATCH_NOTE_PREFIX.length)
  }

  return name
}

/**
 * Returns the file name (with .md) pre-filled in the save dialog of a scratch
 * note. If the user has given the scratch note a name of their own (the file
 * name is not a generated one), that name is returned unchanged. Otherwise the
 * name is derived from the first non-blank line after an optional YAML front
 * matter block; if that yields nothing, the creation time encoded in the
 * scratch note's generated file name is used instead.
 *
 * @param   {string}  content          The content of the scratch note
 * @param   {string}  scratchFileName  The file name of the scratch note
 *
 * @return  {string}                   The suggested file name
 */
export function suggestSaveFileName (content: string, scratchFileName: string): string {
  if (!isGeneratedScratchNoteFileName(scratchFileName)) {
    return scratchFileName
  }

  const lines =content.replace(/^﻿/, '').split(/\r\n|\r|\n/)

  let stem = ''
  for (let index = indexAfterFrontMatter(lines); index < lines.length; index++) {
    if (/\S/.test(lines[index])) {
      stem = fileNameStemFromLine(lines[index])
      break
    }
  }

  if (stem === '') {
    stem = creationTimeFromFileName(scratchFileName)
  }

  if (stem === '') {
    stem = FALLBACK_SUGGESTED_NAME
  }

  return stem + SCRATCH_NOTE_EXTENSION
}

/**
 * Removes trailing whitespace and dots. Implemented as a loop rather than a
 * regular expression to avoid quadratic backtracking on long runs of them.
 *
 * @param   {string}  text  The text
 *
 * @return  {string}        The text without trailing whitespace and dots
 */
function stripTrailingWhitespaceAndDots (text: string): string {
  let end = text.length
  while (end > 0 && (text[end - 1] === '.' || /\s/.test(text[end - 1]))) {
    end--
  }
  return text.slice(0, end)
}

/**
 * Turns the new name a user typed when renaming a scratch note (R102) into the
 * file name of the scratch note. Surrounding whitespace is removed, and so is
 * one .md extension (in any letter case); other extensions are not recognized
 * and stay part of the name, so that notes.txt becomes notes.txt.md. Trailing
 * whitespace and dots are removed before characters that file names do not
 * allow are replaced with hyphens, so that "Meeting notes." does not become
 * "Meeting notes-" (the order of R40, decision record 049).
 *
 * @param   {string}        requested  The name the user typed
 *
 * @return  {string|null}              The new file name with .md, or null if no
 *                                     valid name remains (empty, or starting
 *                                     with a dot or a tilde)
 */
export function scratchRenameFileName (requested: string): string|null {
  let stem = requested.trim()

  if (stem.toLowerCase().endsWith(SCRATCH_NOTE_EXTENSION)) {
    stem = stem.slice(0, stem.length - SCRATCH_NOTE_EXTENSION.length)
  }

  stem = sanitize(stripTrailingWhitespaceAndDots(stem), { replacement: '-' })

  if (stem === '' || stem.startsWith('.') || stem.startsWith('~')) {
    return null
  }

  return stem + SCRATCH_NOTE_EXTENSION
}

// A level-1 ATX heading (R132): at most three spaces, a single #, at least one
// space or tab, and the text. A second # directly after the first one (as in
// "## Title") does not match; neither does a Setext heading, which has no # at
// all. The closing sequence of # characters is removed separately.
const LEVEL_ONE_HEADING_PATTERN = /^ {0,3}#[ \t]+([\s\S]*)$/

// Inline Markdown that is removed from a heading before it becomes a file name
// (R132). Each pattern keeps only the text: the link text of links and images,
// the content of code spans, and the text between emphasis delimiters.
// Underscores only count as emphasis delimiters at the edge of a word, so that
// snake_case_names stay as they are.
const INLINE_LINK_OR_IMAGE_PATTERN = /!?\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g
const INLINE_CODE_PATTERN = /(`+)(.+?)\1(?!`)/g
const INLINE_HTML_PATTERN = /<!--[\s\S]*?-->|<\/?[A-Za-z][^<>]*>/g
const INLINE_EMPHASIS_PATTERNS = [
  /\*\*(?=\S)(.*?\S)\*\*/g,
  /(?<![\p{L}\p{N}_])__(?=\S)(.*?\S)__(?![\p{L}\p{N}_])/gu,
  /~~(?=\S)(.*?\S)~~/g,
  /\*(?=\S)(.*?\S)\*/g,
  /(?<![\p{L}\p{N}_])_(?=\S)(.*?\S)_(?![\p{L}\p{N}_])/gu
]

// The patterns above can take quadratic time on a line full of unmatched
// delimiters. A heading is cut to this many characters before its markup is
// removed, which is far more than the 60 code points that a file name keeps.
const MAX_HEADING_LENGTH_TO_CLEAN = 2000

// What remains of a heading that consisted of nothing but markup, such as "**"
const MARKUP_ONLY_PATTERN = /^[*_~`#\s]*$/

/**
 * Removes the inline Markdown from the text of a heading: links and images are
 * reduced to their text, code spans and emphasis to their content, and inline
 * HTML tags are dropped. Runs of whitespace become one space.
 *
 * @param   {string}  text  The text of the heading
 *
 * @return  {string}        The plain text, trimmed; empty if the heading
 *                          consisted of nothing but markup
 */
function stripInlineMarkdown (text: string): string {
  let result = text
    .slice(0, MAX_HEADING_LENGTH_TO_CLEAN)
    .replace(INLINE_LINK_OR_IMAGE_PATTERN, '$1')
    .replace(INLINE_CODE_PATTERN, '$2')
    .replace(INLINE_HTML_PATTERN, '')

  for (const pattern of INLINE_EMPHASIS_PATTERNS) {
    result = result.replace(pattern, '$1')
  }

  result = result.replace(/\s+/g, ' ').trim()
  return MARKUP_ONLY_PATTERN.test(result) ? '' : result
}

/**
 * Returns the text of the level-1 ATX heading (# Title) that starts a scratch
 * note (R132): the first non-blank line after an optional YAML front matter
 * block (skipped exactly as suggestSaveFileName does), if it is such a heading.
 * Deeper headings (## Title), Setext headings (Title followed by a line of =),
 * and a first line that is not a heading at all yield null. The closing
 * sequence of a heading (the trailing # in "# Title #") is not part of the
 * text. The text may still contain inline Markdown, and it is empty if nothing
 * follows the #.
 *
 * @param   {string}        content  The content of the scratch note
 *
 * @return  {string|null}            The text of the heading, or null
 */
export function scratchHeadingTitle (content: string): string|null {
  const lines = content.replace(/^﻿/, '').split(/\r\n|\r|\n/)

  for (let index = indexAfterFrontMatter(lines); index < lines.length; index++) {
    if (!/\S/.test(lines[index])) {
      continue
    }

    // Only the first non-blank line can be the heading
    const match = LEVEL_ONE_HEADING_PATTERN.exec(lines[index])
    return match === null ? null : stripClosingHeadingSequence(match[1].trim())
  }

  return null
}

/**
 * Returns the file name (with .md) that a scratch note gets from the level-1
 * heading it starts with (R132): the text of the heading without inline
 * Markdown, cut to SCRATCH_SUGGESTED_NAME_MAX_LENGTH code points and then
 * turned into a file name exactly like the name of a manual rename
 * (scratchRenameFileName).
 *
 * @param   {string}        content  The content of the scratch note
 *
 * @return  {string|null}            The file name, or null if the scratch note
 *                                   does not start with a level-1 heading or
 *                                   no valid name remains
 */
export function scratchHeadingFileName (content: string): string|null {
  const title = scratchHeadingTitle(content)
  if (title === null) {
    return null
  }

  const plainTitle = stripInlineMarkdown(title)
  if (plainTitle === '') {
    return null
  }

  // Cut by code points, so that CJK characters and emoji count as one each
  const cutTitle = Array.from(plainTitle).slice(0, SCRATCH_SUGGESTED_NAME_MAX_LENGTH).join('')
  return scratchRenameFileName(cutTitle)
}

/**
 * Checks whether the program may still rename a scratch note after its heading
 * (R132), i.e. whether the user has not given the scratch note a name of their
 * own. That is the case if the current file name is a generated one
 * (UNSAVED_<yyyymmdd>-<hhmmss>[_n].md), or if it is the name the heading of the
 * previous content produces: the same stem in any letter case, optionally
 * followed by _ and a number (the form that uniqueScratchFileName gives to a
 * name that was taken).
 *
 * @param   {string}   currentName      The current file name of the scratch note
 * @param   {string}   previousContent  The content that was last written to the
 *                                      scratch note, before the current write
 *
 * @return  {boolean}                   True if the name may follow the heading
 */
export function isAutoNamedScratchFileName (currentName: string, previousContent: string): boolean {
  if (isGeneratedScratchNoteFileName(currentName)) {
    return true
  }

  const previousFileName = scratchHeadingFileName(previousContent)
  if (previousFileName === null || !currentName.toLowerCase().endsWith(SCRATCH_NOTE_EXTENSION)) {
    return false
  }

  const previousStem = previousFileName.slice(0, previousFileName.length - SCRATCH_NOTE_EXTENSION.length).toLowerCase()
  const currentStem = currentName.slice(0, currentName.length - SCRATCH_NOTE_EXTENSION.length).toLowerCase()
  if (currentStem === previousStem) {
    return true
  }

  return currentStem.startsWith(previousStem + '_') && /^\d+$/.test(currentStem.slice(previousStem.length + 1))
}

/**
 * Returns the given file name, or, if that name is already taken, the first of
 * name_2.md, name_3.md, ... that is still free (R132). Names are compared
 * case-insensitively, like everywhere else in this module.
 *
 * @param   {string}    name           The wanted file name, usually with .md
 * @param   {string[]}  existingNames  The names already taken
 *
 * @return  {string}                   The first free file name
 */
export function uniqueScratchFileName (name: string, existingNames: string[]): string {
  if (name.toLowerCase().endsWith(SCRATCH_NOTE_EXTENSION)) {
    const stem = name.slice(0, name.length - SCRATCH_NOTE_EXTENSION.length)
    return firstFreeFileName(stem, name.slice(stem.length), existingNames)
  }

  return firstFreeFileName(name, '', existingNames)
}
