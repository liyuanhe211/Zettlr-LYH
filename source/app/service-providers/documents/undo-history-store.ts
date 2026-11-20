/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Store for the differential undo history (R135)
 * CVM-Role:        Utility
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Writes the undo history of every document as a differential
 *                  record (one JSON Lines file per document, specification C20)
 *                  and reads it back: path mapping, record format, buffering and
 *                  appending, check lines and anchors, anchoring of a record to
 *                  the text of a document that is opened, renaming of records,
 *                  the 30 day clean-up, the linear restoration of a CodeMirror
 *                  history from a record, and the change that describes an
 *                  external modification.
 *
 *                  This module neither depends on Electron nor does it touch
 *                  the file system, the clock, or the timers directly: they are
 *                  all injected through the constructor, so that the module can
 *                  be tested without any of them.
 *
 * END HEADER
 */

import { createHash } from 'node:crypto'
import { promises as fsPromises } from 'node:fs'
import path from 'node:path'
import { ChangeSet, Text } from '@codemirror/state'
import { formatScratchTimestamp, isScratchNoteFileName } from './scratch-notes'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Delay (ms) between the first unwritten line entering the buffer and the write. */
export const UNDO_HISTORY_FLUSH_DELAY = 2000
/** Approximate interval (ms) between two check lines of an actively edited document. */
export const UNDO_HISTORY_CHECK_INTERVAL = 30000
/** Texts with more characters than this get their check value from the worker thread. */
export const UNDO_HISTORY_WORKER_HASH_THRESHOLD = 262144
/** A record that grows beyond this many bytes raises the size warning once. */
export const UNDO_HISTORY_SIZE_WARNING = 200 * 1024 * 1024
/** At most this many events are restored into the editor. */
export const UNDO_HISTORY_MAX_EVENTS = 10000
/** Steps older than this many days are removed by the clean-up. */
export const UNDO_HISTORY_RETENTION_DAYS = 30

/** A mapped record path with more characters than this goes to the __Long folder. */
const MAX_RECORD_PATH_LENGTH = 259
/** A path level with more characters than this makes the record go to the __Long folder. */
const MAX_PATH_LEVEL_LENGTH = 200
/** Number of code points of the file name that are kept in the __Long folder. */
const LONG_FILE_NAME_CODE_POINTS = 100
/** Number of hexadecimal digits of the path hash that name a folder in __Long. */
const LONG_FOLDER_HASH_DIGITS = 16
const MILLISECONDS_PER_DAY = 86400000

const RECORD_SUFFIX = '.history.jsonl'
const ANCHOR_SUFFIX = '.anchor'
const TEMPORARY_SUFFIX = '.tmp'
const RECORD_FORMAT = 1

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The JSON representation of a CodeMirror ChangeSet: a number keeps that many
 * characters, [n] deletes n characters, and [n, 'line 1', 'line 2'] replaces n
 * characters with the given lines.
 */
export type ChangeSetJSON = Array<number | [number, ...string[]]>

/** The JSON representation of an EditorSelection. */
export interface SelectionJSON {
  ranges: Array<{ anchor: number, head: number }>
  main: number
}

/** The description that the editor attaches to each update it pushes. */
export interface UndoDescription {
  kind: 'edit' | 'undo' | 'redo'
  joined: boolean
  selectionBefore: SelectionJSON
  userEvent?: string
}

/** What caused an external step. */
export type ExternalSource = 'disk-reload' | 'comparison' | 'reopen'

export interface HeaderLine {
  type: 'header'
  format: number
  path: string
  created: number
  baseLength: number
  baseHash: string | null
}

export interface EditLine {
  type: 'edit'
  time: number
  timeEnd?: number
  client: string
  userEvent?: string
  joined?: boolean
  selectionBefore: SelectionJSON
  forward: ChangeSetJSON
  inverse: ChangeSetJSON
  length: number
}

export interface UndoLine {
  type: 'undo'
  time: number
  timeEnd?: number
  client: string
  userEvent?: string
  selectionBefore: SelectionJSON
  forward: ChangeSetJSON
  inverse: ChangeSetJSON
  length: number
}

export interface RedoLine {
  type: 'redo'
  time: number
  timeEnd?: number
  client: string
  userEvent?: string
  selectionBefore: SelectionJSON
  forward: ChangeSetJSON
  inverse: ChangeSetJSON
  length: number
}

export interface ExternalLine {
  type: 'external'
  time: number
  source: ExternalSource
  selectionBefore?: SelectionJSON
  forward: ChangeSetJSON
  inverse: ChangeSetJSON
  length: number
}

export interface CheckLine {
  type: 'check'
  time: number
  length: number
  hash: string
}

export interface SaveLine {
  type: 'save'
  time: number
  length: number
}

export interface RenameLine {
  type: 'rename'
  time: number
  from: string
  to: string
}

export interface BreakLine {
  type: 'break'
  time: number
  length: number
  hash: string | null
}

/** A line that changes the text of the document. */
export type StepLine = EditLine | UndoLine | RedoLine | ExternalLine

/** Any line of a record file. */
export type UndoHistoryLine = HeaderLine | StepLine | CheckLine | SaveLine | RenameLine | BreakLine

/** One event of the done branch of a CodeMirror history, in its JSON form. */
export interface HistoryEventJSON {
  changes: ChangeSetJSON
  startSelection: SelectionJSON
  selectionsAfter: []
}

/** The history that is restored from a record. */
export interface UndoHistoryJSON {
  done: HistoryEventJSON[]
  undone: []
  /** The indexes in done of the events that stem from external lines. */
  externalEventIndexes: number[]
}

/** The change that describes an external modification of a document. */
export interface ExternalStep {
  forward: ChangeSetJSON
  inverse: ChangeSetJSON
  oldLength: number
}

/** The texts, besides the current one, that a record can be anchored to. */
export interface UndoHistoryCandidates {
  /** The text that was written to the anchor file when the document was closed. */
  anchorText?: string
  /** The text in the backup cache for unsaved modifications (R50). */
  backupText?: string
}

/** The result of anchoring a record to the text of a document. */
export interface AnchorResult {
  /** The lines before this position (exclusive) can be used. */
  usableEnd: number
  /** The lines that have to be appended to the record. */
  appendLines: UndoHistoryLine[]
}

/** One update that the editor pushed to the main process. */
export interface UndoUpdate {
  changes: ChangeSet
  description?: UndoDescription
  client: string
}

/** The file system functions the store needs. All text is UTF-8. */
export interface UndoHistoryFileSystem {
  appendFile: (filePath: string, data: string) => Promise<void>
  writeFile: (filePath: string, data: string) => Promise<void>
  readFile: (filePath: string) => Promise<string>
  rename: (from: string, to: string) => Promise<void>
  unlink: (filePath: string) => Promise<void>
  /** Creates the directory including all missing parents. */
  mkdir: (directory: string) => Promise<void>
  readdir: (directory: string) => Promise<Array<{ name: string, isDirectory: boolean }>>
  /** Returns null if the path does not exist. */
  stat: (filePath: string) => Promise<{ size: number }|null>
  rmdir: (directory: string) => Promise<void>
}

export interface UndoHistoryStoreOptions {
  fs: UndoHistoryFileSystem
  /** The undo history root folder; the main process reads it from the configuration. */
  getRoot: () => string
  /** The current scratch note folder. */
  getScratchDirectory: () => string
  platform: NodeJS.Platform
  now: () => number
  setTimer: (callback: () => void, delay: number) => unknown
  clearTimer: (handle: unknown) => void
  /** Returns 'sha1:' followed by the 40 lowercase hexadecimal digits. */
  hashSync: (text: string) => string
  /** The same as hashSync, but calculated in a worker thread. */
  hashInWorker: (text: string) => Promise<string>
  /** Called once per record when it grows beyond 200 MB. */
  warn: (recordPath: string, size: number) => void
  log?: (message: string) => void
}

export interface UndoHistoryPathOptions {
  root: string
  scratchDirectory: string
  platform: NodeJS.Platform
}

export interface UndoHistoryPruneOptions {
  now: number
  retentionDays: number
  isOpen: (filePath: string) => boolean
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Calculates the check value of a text: "sha1:" followed by the SHA-1 of the
 * UTF-8 encoded text as 40 lowercase hexadecimal digits.
 *
 * @param   {string}  text  The text
 *
 * @return  {string}        The check value
 */
export function sha1Hash (text: string): string {
  return 'sha1:' + createHash('sha1').update(text, 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------
// Path mapping
// ---------------------------------------------------------------------------

type PathApi = typeof path.posix

function getPathApi (platform: NodeJS.Platform): PathApi {
  return platform === 'win32' ? path.win32 : path.posix
}

/**
 * Returns a key for comparing paths: resolved, and on Windows lower case.
 * Backslashes and slashes are equivalent on Windows.
 */
function comparisonKey (filePath: string, platform: NodeJS.Platform): string {
  const resolved = getPathApi(platform).resolve(filePath)
  return platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * Checks whether a path lies strictly inside a directory, at any depth.
 */
function isPathInside (filePath: string, directory: string, platform: NodeJS.Platform): boolean {
  const pathApi = getPathApi(platform)
  const relative = pathApi.relative(comparisonKey(directory, platform), comparisonKey(filePath, platform))
  if (relative === '' || pathApi.isAbsolute(relative)) {
    return false
  }

  return relative.split(pathApi.sep)[0] !== '..'
}

function splitParts (value: string, separator: string): string[] {
  return value.split(separator).filter(part => part !== '')
}

interface SplitPath {
  /** The folders that stand for the drive, the network share, or the root. */
  prefix: string[]
  /** The names below that, the last one being the file name. */
  parts: string[]
}

/**
 * Splits an absolute path into the folders that the undo history uses to
 * represent the drive (X:\ becomes X), the network share (\\server\share
 * becomes __UNC, server, share) or the file system root (/ becomes __Root),
 * and the names below it.
 */
function splitAbsolutePath (filePath: string, platform: NodeJS.Platform): SplitPath {
  if (platform !== 'win32') {
    return { prefix: ['__Root'], parts: splitParts(path.posix.normalize(filePath), '/') }
  }

  let normalized = path.win32.normalize(filePath)

  // Paths in the extended-length form carry a prefix that has no meaning here
  const extendedUnc = /^\\\\\?\\UNC\\/i
  if (extendedUnc.test(normalized)) {
    normalized = '\\\\' + normalized.replace(extendedUnc, '')
  } else if (/^\\\\\?\\[A-Za-z]:/.test(normalized)) {
    normalized = normalized.slice(4)
  }

  const drive = /^([A-Za-z]):(?:\\(.*))?$/.exec(normalized)
  if (drive !== null) {
    return { prefix: [drive[1]], parts: splitParts(drive[2] ?? '', '\\') }
  }

  const unc = /^\\\\([^\\]+)\\([^\\]+)(?:\\(.*))?$/.exec(normalized)
  if (unc !== null) {
    return { prefix: [ '__UNC', unc[1], unc[2] ], parts: splitParts(unc[3] ?? '', '\\') }
  }

  // Not an absolute Windows path; keep it unique at least
  return { prefix: ['__Root'], parts: splitParts(normalized, '\\') }
}

function mapRecordPathWithoutLimits (filePath: string, options: UndoHistoryPathOptions): string {
  const { root, scratchDirectory, platform } = options
  const pathApi = getPathApi(platform)

  // Rule 1: inside the undo history root, the record is the sibling of the file
  if (isPathInside(filePath, root, platform)) {
    return filePath + RECORD_SUFFIX
  }

  // Rule 2: a scratch note
  const fileName = pathApi.basename(filePath)
  if (scratchDirectory.trim() !== '' && isScratchNoteFileName(fileName) &&
    comparisonKey(pathApi.dirname(filePath), platform) === comparisonKey(scratchDirectory, platform)) {
    return pathApi.join(root, '__Unsaved', fileName + RECORD_SUFFIX)
  }

  // Rules 3, 4 and 5: mirror the folder structure below the root
  const { prefix, parts } = splitAbsolutePath(filePath, platform)
  const folders = parts.slice(0, -1)
  const lastName = parts.length > 0 ? parts[parts.length - 1] : ''
  return pathApi.join(root, ...prefix, ...folders, lastName + RECORD_SUFFIX)
}

/**
 * Returns the folder (below the root) that the undo history uses to represent
 * a document folder, or null if the folder lies inside the root itself, where
 * the records are siblings of the documents and move with them.
 */
function mapDirectoryWithoutLimits (directory: string, options: UndoHistoryPathOptions): string | null {
  const { root, platform } = options
  if (isPathInside(directory, root, platform)) {
    return null
  }

  const { prefix, parts } = splitAbsolutePath(directory, platform)
  return getPathApi(platform).join(root, ...prefix, ...parts)
}

/**
 * Returns the folder in which the undo history records are stored, given the
 * configured folder.
 *
 * @param   {string}  configured     The value of the undoHistoryDirectory option
 * @param   {string}  documentsPath  The documents folder of the user
 *
 * @return  {string}                 The undo history root folder
 */
export function resolveUndoHistoryDirectory (configured: string, documentsPath: string): string {
  const trimmed = configured.trim()
  if (trimmed === '') {
    return path.join(documentsPath, 'Zettlr', '__History')
  }

  return path.resolve(trimmed)
}

/**
 * Returns the path of the record file of a document (specification C20,
 * section 2). Nothing but this function may build record paths.
 *
 * @param   {string}                   filePath  The absolute path of the document
 * @param   {UndoHistoryPathOptions}   options   The root, the scratch folder, the platform
 *
 * @return  {string}                             The path of the record
 */
export function undoHistoryRecordPath (filePath: string, options: UndoHistoryPathOptions): string {
  const { root, platform } = options
  const pathApi = getPathApi(platform)
  const mapped = mapRecordPathWithoutLimits(filePath, options)

  // Rule 6: paths that are too long for the file system
  const levels = pathApi.relative(root, mapped).split(pathApi.sep)
  const isTooLong = mapped.length > MAX_RECORD_PATH_LENGTH || levels.some(level => level.length > MAX_PATH_LEVEL_LENGTH)
  if (!isTooLong) {
    return mapped
  }

  const resolved = pathApi.resolve(filePath)
  const hashInput = platform === 'win32' ? resolved.toLowerCase() : resolved
  const folderName = createHash('sha1').update(hashInput, 'utf8').digest('hex').slice(0, LONG_FOLDER_HASH_DIGITS)
  const shortName = Array.from(pathApi.basename(filePath)).slice(0, LONG_FILE_NAME_CODE_POINTS).join('')
  return pathApi.join(root, '__Long', folderName, shortName + RECORD_SUFFIX)
}

/**
 * Returns the path of the anchor file that belongs to a record: the record
 * path, with the ending .history.jsonl replaced by .anchor.
 *
 * @param   {string}  recordPath  The path of the record
 *
 * @return  {string}              The path of the anchor file
 */
export function undoHistoryAnchorPath (recordPath: string): string {
  if (recordPath.endsWith(RECORD_SUFFIX)) {
    return recordPath.slice(0, recordPath.length - RECORD_SUFFIX.length) + ANCHOR_SUFFIX
  }

  return recordPath + ANCHOR_SUFFIX
}

// ---------------------------------------------------------------------------
// External changes
// ---------------------------------------------------------------------------

function isHighSurrogate (codeUnit: number): boolean {
  return codeUnit >= 0xD800 && codeUnit <= 0xDBFF
}

function isLowSurrogate (codeUnit: number): boolean {
  return codeUnit >= 0xDC00 && codeUnit <= 0xDFFF
}

function createDocument (text: string): Text {
  return Text.of(text.split('\n'))
}

/**
 * Returns the change from the old to the new text as one replacement of the
 * part between the identical beginning and end, as ChangeSet objects.
 */
function computeExternalChangeSets (oldText: string, newText: string): { forward: ChangeSet, inverse: ChangeSet } | null {
  if (oldText === newText) {
    return null
  }

  const shortestLength = Math.min(oldText.length, newText.length)

  let prefixLength = 0
  while (prefixLength < shortestLength && oldText.charCodeAt(prefixLength) === newText.charCodeAt(prefixLength)) {
    prefixLength++
  }
  // Do not cut a surrogate pair in half
  if (prefixLength > 0 && isHighSurrogate(oldText.charCodeAt(prefixLength - 1))) {
    prefixLength--
  }

  let suffixLength = 0
  while (
    suffixLength < shortestLength - prefixLength &&
    oldText.charCodeAt(oldText.length - 1 - suffixLength) === newText.charCodeAt(newText.length - 1 - suffixLength)
  ) {
    suffixLength++
  }
  if (suffixLength > 0 && isLowSurrogate(oldText.charCodeAt(oldText.length - suffixLength))) {
    suffixLength--
  }

  const insertedText = newText.slice(prefixLength, newText.length - suffixLength)
  const forward = ChangeSet.of({
    from: prefixLength,
    to: oldText.length - suffixLength,
    insert: createDocument(insertedText)
  }, oldText.length)
  const inverse = forward.invert(createDocument(oldText))
  return { forward, inverse }
}

/**
 * Computes the change that describes an external modification: the identical
 * beginning and end of both texts are cut off, and the part in between is
 * replaced in one step.
 *
 * @param   {string}  oldText  The text before the modification
 * @param   {string}  newText  The text after the modification
 *
 * @return  {object|null}      The forward and the inverse change, or null if both texts are identical
 */
export function computeExternalChange (oldText: string, newText: string): { forward: ChangeSetJSON, inverse: ChangeSetJSON } | null {
  const sets = computeExternalChangeSets(oldText, newText)
  if (sets === null) {
    return null
  }

  return {
    forward: sets.forward.toJSON() as ChangeSetJSON,
    inverse: sets.inverse.toJSON() as ChangeSetJSON
  }
}

// ---------------------------------------------------------------------------
// Reading records
// ---------------------------------------------------------------------------

/** Returns true if the line changes the text of the document. */
function isStepLine (line: UndoHistoryLine): line is StepLine {
  return line.type === 'edit' || line.type === 'undo' || line.type === 'redo' || line.type === 'external'
}

function isPlainObject (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNumber (value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isChangeSetJSON (value: unknown): value is ChangeSetJSON {
  if (!Array.isArray(value)) {
    return false
  }

  for (const part of value) {
    if (typeof part === 'number') {
      continue
    }

    if (!Array.isArray(part) || typeof part[0] !== 'number') {
      return false
    }

    for (let index = 1; index < part.length; index++) {
      if (typeof part[index] !== 'string') {
        return false
      }
    }
  }

  return true
}

function parseSelection (value: unknown): SelectionJSON | null {
  if (!isPlainObject(value) || !Array.isArray(value.ranges) || value.ranges.length === 0 || !isNumber(value.main)) {
    return null
  }

  const ranges: Array<{ anchor: number, head: number }> = []
  for (const range of value.ranges) {
    if (!isPlainObject(range) || !isNumber(range.anchor) || !isNumber(range.head)) {
      return null
    }

    ranges.push({ anchor: range.anchor, head: range.head })
  }

  if (!Number.isInteger(value.main) || value.main < 0 || value.main >= ranges.length) {
    return null
  }

  return { ranges, main: value.main }
}

type Validation =
  | { status: 'line', line: UndoHistoryLine }
  | { status: 'ignore' }
  | { status: 'invalid' }

const IGNORE: Validation = { status: 'ignore' }
const INVALID: Validation = { status: 'invalid' }

function validateStepLine (value: Record<string, unknown>, type: 'edit' | 'undo' | 'redo'): Validation {
  const selectionBefore = parseSelection(value.selectionBefore)
  if (!isNumber(value.time) || typeof value.client !== 'string' || selectionBefore === null ||
    !isChangeSetJSON(value.forward) || !isChangeSetJSON(value.inverse) || !isNumber(value.length)) {
    return INVALID
  }

  const common = {
    time: value.time,
    timeEnd: isNumber(value.timeEnd) ? value.timeEnd : undefined,
    client: value.client,
    userEvent: typeof value.userEvent === 'string' ? value.userEvent : undefined,
    selectionBefore,
    forward: value.forward,
    inverse: value.inverse,
    length: value.length
  }

  if (type === 'edit') {
    return { status: 'line', line: { type, ...common, joined: value.joined === true ? true : undefined } }
  }

  return { status: 'line', line: { type, ...common } }
}

/**
 * Checks whether a parsed line is valid, ignoring the keys it does not know.
 */
function validateLine (value: unknown): Validation {
  if (!isPlainObject(value) || typeof value.type !== 'string') {
    return INVALID
  }

  switch (value.type) {
    case 'header':
      if (!isNumber(value.format) || typeof value.path !== 'string' || !isNumber(value.created) || !isNumber(value.baseLength)) {
        return INVALID
      }
      return {
        status: 'line',
        line: {
          type: 'header',
          format: value.format,
          path: value.path,
          created: value.created,
          baseLength: value.baseLength,
          baseHash: typeof value.baseHash === 'string' ? value.baseHash : null
        }
      }
    case 'edit':
    case 'undo':
    case 'redo':
      return validateStepLine(value, value.type)
    case 'external': {
      const selectionBefore = parseSelection(value.selectionBefore)
      if (!isNumber(value.time) || typeof value.source !== 'string' || !isChangeSetJSON(value.forward) ||
        !isChangeSetJSON(value.inverse) || !isNumber(value.length)) {
        return INVALID
      }
      return {
        status: 'line',
        line: {
          type: 'external',
          time: value.time,
          source: value.source as ExternalSource,
          selectionBefore: selectionBefore ?? undefined,
          forward: value.forward,
          inverse: value.inverse,
          length: value.length
        }
      }
    }
    case 'check':
      if (!isNumber(value.time) || !isNumber(value.length) || typeof value.hash !== 'string') {
        return INVALID
      }
      return { status: 'line', line: { type: 'check', time: value.time, length: value.length, hash: value.hash } }
    case 'save':
      if (!isNumber(value.time) || !isNumber(value.length)) {
        return INVALID
      }
      return { status: 'line', line: { type: 'save', time: value.time, length: value.length } }
    case 'rename':
      if (!isNumber(value.time) || typeof value.from !== 'string' || typeof value.to !== 'string') {
        return INVALID
      }
      return { status: 'line', line: { type: 'rename', time: value.time, from: value.from, to: value.to } }
    case 'break':
      if (!isNumber(value.time) || !isNumber(value.length)) {
        return INVALID
      }
      return {
        status: 'line',
        line: { type: 'break', time: value.time, length: value.length, hash: typeof value.hash === 'string' ? value.hash : null }
      }
    default:
      // Lines of a type that this version does not know are ignored
      return IGNORE
  }
}

/** A line of a record file, together with its text. */
export interface ParsedEntry {
  /** The text of the line, without the line break. */
  raw: string
  /** The line, or null for a line of an unknown type, which is ignored. */
  line: UndoHistoryLine | null
}

export interface ParsedRecord {
  /** All non-blank lines, including the ones that are ignored. */
  entries: ParsedEntry[]
  /** The lines that are known; a line that is damaged is replaced by a break. */
  lines: UndoHistoryLine[]
}

/**
 * Parses the text of a record file. A line that is not valid JSON, lacks a
 * required key, or has a malformed change counts as a break at that place;
 * lines of an unknown type are ignored; the last line is ignored if it is not
 * complete, i.e., if the file does not end with a line break and the line is
 * no valid JSON.
 *
 * @param   {string}        text  The content of the record file
 *
 * @return  {ParsedRecord}        The lines
 */
export function parseUndoHistoryRecord (text: string): ParsedRecord {
  const entries: ParsedEntry[] = []
  const lines: UndoHistoryLine[] = []
  const segments = text.split('\n')
  const lastIndex = segments.length - 1

  for (let index = 0; index < segments.length; index++) {
    const raw = segments[index]
    if (raw.trim() === '') {
      continue
    }

    let validation: Validation
    try {
      validation = validateLine(JSON.parse(raw))
    } catch {
      if (index === lastIndex) {
        // The last line of a file that does not end with a line break: written
        // only halfway when the program crashed
        continue
      }
      validation = INVALID
    }

    if (validation.status === 'ignore') {
      entries.push({ raw, line: null })
    } else if (validation.status === 'invalid') {
      const damaged: BreakLine = { type: 'break', time: 0, length: -1, hash: null }
      entries.push({ raw, line: damaged })
      lines.push(damaged)
    } else if (validation.line.type === 'header' && lines.length > 0) {
      // A header is only valid as the first line
      entries.push({ raw, line: null })
    } else {
      entries.push({ raw, line: validation.line })
      lines.push(validation.line)
    }
  }

  return { entries, lines }
}

// ---------------------------------------------------------------------------
// Anchoring
// ---------------------------------------------------------------------------

interface WalkResult {
  verified: boolean
  captured: Text | null
}

/**
 * Walks a record backwards from a text: the inverse change of every step is
 * applied to the text, so that the text reaches the state it had before that
 * step. The first check line (or break line, or the header) that is reached is
 * compared with the text, which has to match.
 *
 * If captureIndex is given, the walk continues after the verification, down to
 * the step at that index; the text before that step is returned as captured.
 */
function walkBack (lines: UndoHistoryLine[], startText: Text, hash: (text: string) => string, captureIndex: number | null): WalkResult {
  let current = startText
  let verified = false
  let captured: Text | null = null

  for (let index = lines.length - 1; index >= 0; index--) {
    if (verified && (captureIndex === null || captured !== null)) {
      break
    }

    const line = lines[index]
    if (isStepLine(line)) {
      if (current.length !== line.length) {
        return { verified, captured: null }
      }

      try {
        current = ChangeSet.fromJSON(line.inverse).apply(current)
      } catch {
        return { verified, captured: null }
      }

      if (index === captureIndex) {
        captured = current
      }
    } else if (line.type === 'check') {
      if (!verified) {
        if (current.length !== line.length || hash(current.toString()) !== line.hash) {
          return { verified: false, captured: null }
        }
        verified = true
      }
    } else if (line.type === 'break') {
      // The steps before a break belong to another chain; the break describes
      // the text at that moment, unless the line was damaged
      if (!verified) {
        if (line.hash !== null && (current.length !== line.length || hash(current.toString()) !== line.hash)) {
          return { verified: false, captured: null }
        }
        verified = true
      }
      break
    } else if (line.type === 'header') {
      if (!verified) {
        if (current.length !== line.baseLength || (line.baseHash !== null && hash(current.toString()) !== line.baseHash)) {
          return { verified: false, captured: null }
        }
        verified = true
      }
      break
    }
  }

  return { verified, captured }
}

/**
 * Checks a record against the text of a document that is opened, and decides
 * which steps of the record can be used (specification C20, section 6):
 *
 * 1. The text is taken back through the steps from the end of the record. If
 *    it matches the first check line (or the header) that it reaches, all
 *    steps can be used.
 * 2. Otherwise, if the text equals the text of a check line, the record is
 *    newer than the text (the steps after that line were never saved), and
 *    only the steps before that line can be used.
 * 3. Otherwise the same is tried with the text of the anchor file and the
 *    backup text. If one of them matches the end of the record, the document
 *    was modified while it was closed; one external step is appended.
 * 4. Otherwise a break is appended, and no step can be used.
 *
 * @param   {UndoHistoryLine[]}        lines        All lines of the record, header first
 * @param   {string}                   currentText  The text of the document
 * @param   {UndoHistoryCandidates}    candidates   The anchor text and the backup text
 * @param   {Function}                 hash         The check value function, default SHA-1
 * @param   {number}                   time         The time for the lines to append
 *
 * @return  {AnchorResult}                          The end of the usable lines and the lines to append
 */
export function anchorRecord (
  lines: UndoHistoryLine[],
  currentText: string,
  candidates: UndoHistoryCandidates,
  hash: (text: string) => string = sha1Hash,
  time: number = Date.now()
): AnchorResult {
  if (lines.length === 0) {
    return { usableEnd: 0, appendLines: [] }
  }

  // 1. Walk back from the current text
  if (walkBack(lines, createDocument(currentText), hash, null).verified) {
    return { usableEnd: lines.length, appendLines: [] }
  }

  // 2. The record is newer than the text
  const currentHash = hash(currentText)
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]
    if (line.type === 'check' && line.length === currentText.length && line.hash === currentHash) {
      return { usableEnd: index + 1, appendLines: [] }
    }
  }

  // 3. The text is newer than the record
  for (const candidate of [ candidates.anchorText, candidates.backupText ]) {
    if (candidate === undefined || !walkBack(lines, createDocument(candidate), hash, null).verified) {
      continue
    }

    const change = computeExternalChange(candidate, currentText)
    if (change === null) {
      return { usableEnd: lines.length, appendLines: [] }
    }

    const external: ExternalLine = {
      type: 'external',
      time,
      source: 'reopen',
      forward: change.forward,
      inverse: change.inverse,
      length: currentText.length
    }
    return { usableEnd: lines.length, appendLines: [external] }
  }

  // 4. Nothing fits
  const breakLine: BreakLine = { type: 'break', time, length: currentText.length, hash: currentHash }
  return { usableEnd: lines.length, appendLines: [breakLine] }
}

// ---------------------------------------------------------------------------
// Restoring the history
// ---------------------------------------------------------------------------

function clampSelection (selection: SelectionJSON | undefined, documentLength: number): SelectionJSON {
  if (selection === undefined || selection.ranges.length === 0) {
    return { ranges: [{ anchor: 0, head: 0 }], main: 0 }
  }

  const ranges = selection.ranges.map(range => ({
    anchor: Math.max(0, Math.min(documentLength, range.anchor)),
    head: Math.max(0, Math.min(documentLength, range.head))
  }))
  return { ranges, main: Math.max(0, Math.min(selection.main, ranges.length - 1)) }
}

function tryParseChangeSet (json: ChangeSetJSON): ChangeSet | null {
  try {
    return ChangeSet.fromJSON(json)
  } catch {
    return null
  }
}

interface RestoredEvent {
  inverse: ChangeSet
  startSelection: SelectionJSON
  external: boolean
}

/**
 * Builds the history of a CodeMirror editor from the lines of a record, as a
 * linear time line (specification C20, section 7): everything after the last
 * break is read, and every step becomes an event of the done branch, so that
 * even what was undone before is restored as an ordinary step that can be
 * undone. An edit that was joined to the edit before it (same editor, nothing
 * but check and save lines in between) becomes part of that event.
 *
 * A step whose change does not fit the text that the steps before it lead to
 * counts as a break.
 *
 * @param   {UndoHistoryLine[]}  lines      The usable lines of the record
 * @param   {number}             maxEvents  The maximum number of events (the last ones are kept)
 *
 * @return  {UndoHistoryJSON}               The done events, no undone events, and which done events stem from external changes
 */
export function buildHistoryJSON (lines: UndoHistoryLine[], maxEvents: number): UndoHistoryJSON {
  let startIndex = 0
  for (let index = lines.length - 1; index >= 0; index--) {
    if (lines[index].type === 'break') {
      startIndex = index + 1
      break
    }
  }

  let events: RestoredEvent[] = []
  let previousStep: StepLine | null = null
  let previousLength: number | null = null

  // The first line after a break needs no verification of the length: the
  // break does not tell the length if it stems from a damaged line
  const reset = (length: number | null): void => {
    events = []
    previousStep = null
    previousLength = length
  }

  if (startIndex > 0) {
    const breakLine = lines[startIndex - 1]
    reset(breakLine.type === 'break' && breakLine.length >= 0 ? breakLine.length : null)
  }

  for (let index = startIndex; index < lines.length; index++) {
    const line = lines[index]

    if (line.type === 'header') {
      reset(line.baseLength >= 0 ? line.baseLength : null)
    } else if (line.type === 'break') {
      reset(line.length >= 0 ? line.length : null)
    } else if (line.type === 'rename') {
      previousStep = null
    } else if (isStepLine(line)) {
      const inverse = tryParseChangeSet(line.inverse)
      if (inverse === null || inverse.length !== line.length || (previousLength !== null && inverse.newLength !== previousLength)) {
        reset(null)
        continue
      }

      const top = events.length > 0 ? events[events.length - 1] : undefined
      const previous: StepLine | null = previousStep
      if (
        line.type === 'edit' && line.joined === true && top !== undefined &&
        previous !== null && previous.type === 'edit' && previous.client === line.client
      ) {
        try {
          top.inverse = inverse.compose(top.inverse)
        } catch {
          reset(null)
          continue
        }
      } else {
        events.push({
          inverse,
          startSelection: clampSelection(line.type === 'external' ? undefined : line.selectionBefore, inverse.newLength),
          external: line.type === 'external'
        })
      }

      previousStep = line
      previousLength = line.length
    }
  }

  const kept = maxEvents > 0 ? events.slice(Math.max(0, events.length - maxEvents)) : []
  const externalEventIndexes: number[] = []
  kept.forEach((event, index) => {
    if (event.external) {
      externalEventIndexes.push(index)
    }
  })

  return {
    done: kept.map(event => ({
      changes: event.inverse.toJSON() as ChangeSetJSON,
      startSelection: event.startSelection,
      selectionsAfter: []
    })),
    undone: [],
    externalEventIndexes
  }
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

interface BufferedStep {
  kind: 'step'
  type: 'edit' | 'undo' | 'redo' | 'external'
  time: number
  timeEnd?: number
  client: string
  userEvent?: string
  joined?: boolean
  source?: ExternalSource
  selectionBefore?: SelectionJSON
  forward: ChangeSet
  inverse: ChangeSet
  length: number
}

interface BufferedLine {
  kind: 'plain'
  line: UndoHistoryLine
}

interface BufferedCheck {
  kind: 'check'
  time: number
  length: number
  /** Null while the worker thread is still busy with it. */
  hash: string | null
  pending: Promise<void> | null
}

type BufferedEntry = BufferedStep | BufferedLine | BufferedCheck

interface DocumentState {
  /** The current path of the document. */
  filePath: string
  /** The current path of its record. */
  recordPath: string
  /** The key under which the state is registered. */
  key: string
  /** The text after the last recorded step. */
  currentText: Text
  /** The text before the first recorded step, until the record has a header. */
  baseText: Text | null
  created: number
  buffer: BufferedEntry[]
  flushScheduled: boolean
  flushHandle: unknown
  checkScheduled: boolean
  checkHandle: unknown
  /** True if there are steps after the last check line. */
  hasUnverifiedSteps: boolean
  disposed: boolean
}

interface HeaderSource {
  baseText: Text
  created: number
}

function stepToLine (step: BufferedStep): Record<string, unknown> {
  if (step.type === 'external') {
    return {
      type: 'external',
      time: step.time,
      source: step.source,
      selectionBefore: step.selectionBefore,
      forward: step.forward.toJSON(),
      inverse: step.inverse.toJSON(),
      length: step.length
    }
  }

  return {
    type: step.type,
    time: step.time,
    timeEnd: step.timeEnd,
    client: step.client,
    userEvent: step.userEvent,
    joined: step.joined,
    selectionBefore: step.selectionBefore,
    forward: step.forward.toJSON(),
    inverse: step.inverse.toJSON(),
    length: step.length
  }
}

function serializeEntry (entry: BufferedEntry): string {
  switch (entry.kind) {
    case 'plain':
      return JSON.stringify(entry.line) + '\n'
    case 'check':
      return JSON.stringify({ type: 'check', time: entry.time, length: entry.length, hash: entry.hash }) + '\n'
    case 'step':
      return JSON.stringify(stepToLine(entry)) + '\n'
  }
}

/**
 * Removes the byte order mark and unifies the line breaks, so that a text read
 * from the disk equals the text that the document manager keeps.
 */
function normalizeDocumentText (text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}

/**
 * Writes and reads the undo history records of all documents. See the
 * description of this module and specification C20.
 */
export class UndoHistoryStore {
  private readonly options: UndoHistoryStoreOptions
  /** The state of every document that has recorded steps, by path key. */
  private readonly states = new Map<string, DocumentState>()
  /** The tail of the chain of operations on each record, by record path key. */
  private readonly chains = new Map<string, Promise<void>>()
  /** The size in bytes of the records that were appended to, by record path key. */
  private readonly recordSizes = new Map<string, number>()
  /** The records for which the size warning was raised, by record path key. */
  private readonly warnedRecords = new Set<string>()

  constructor (options: UndoHistoryStoreOptions) {
    this.options = options
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private get pathApi (): PathApi {
    return getPathApi(this.options.platform)
  }

  private keyOf (filePath: string): string {
    return comparisonKey(filePath, this.options.platform)
  }

  private pathOptions (): UndoHistoryPathOptions {
    return {
      root: this.options.getRoot(),
      scratchDirectory: this.options.getScratchDirectory(),
      platform: this.options.platform
    }
  }

  private recordPathOf (filePath: string): string {
    return undoHistoryRecordPath(filePath, this.pathOptions())
  }

  private logError (context: string, error: unknown): void {
    this.options.log?.(`${context}: ${error instanceof Error ? error.message : String(error)}`)
  }

  /**
   * Runs a task after all earlier tasks on the same record have finished. This
   * is how appends to one record are strictly serial.
   */
  private enqueue<T> (key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve()
    const result = previous.then(task)
    const tail = result.then(() => undefined, () => undefined)
    this.chains.set(key, tail)
    void tail.then(() => {
      if (this.chains.get(key) === tail) {
        this.chains.delete(key)
      }
    })
    return result
  }

  /** Returns a promise that resolves when the tasks queued so far have finished. */
  private idle (key: string): Promise<void> {
    return this.chains.get(key) ?? Promise.resolve()
  }

  private async hashText (text: string): Promise<string> {
    if (text.length > UNDO_HISTORY_WORKER_HASH_THRESHOLD) {
      try {
        return await this.options.hashInWorker(text)
      } catch (error) {
        this.logError('The hash worker failed, calculating the check value in the main thread', error)
      }
    }

    return this.options.hashSync(text)
  }

  private async readTextIfExists (filePath: string): Promise<string | null> {
    try {
      if ((await this.options.fs.stat(filePath)) === null) {
        return null
      }

      return await this.options.fs.readFile(filePath)
    } catch {
      return null
    }
  }

  // -------------------------------------------------------------------------
  // Document state and buffer
  // -------------------------------------------------------------------------

  private createState (filePath: string, baseText: Text): DocumentState {
    const state: DocumentState = {
      filePath,
      recordPath: this.recordPathOf(filePath),
      key: this.keyOf(filePath),
      currentText: baseText,
      baseText,
      created: this.options.now(),
      buffer: [],
      flushScheduled: false,
      flushHandle: undefined,
      checkScheduled: false,
      checkHandle: undefined,
      hasUnverifiedSteps: false,
      disposed: false
    }
    this.states.set(state.key, state)
    return state
  }

  private cancelFlushTimer (state: DocumentState): void {
    if (state.flushScheduled) {
      this.options.clearTimer(state.flushHandle)
      state.flushScheduled = false
    }
  }

  private cancelCheckTimer (state: DocumentState): void {
    if (state.checkScheduled) {
      this.options.clearTimer(state.checkHandle)
      state.checkScheduled = false
    }
  }

  private disposeState (state: DocumentState): void {
    state.disposed = true
    this.cancelFlushTimer(state)
    this.cancelCheckTimer(state)
    if (this.states.get(state.key) === state) {
      this.states.delete(state.key)
    }
  }

  /**
   * Makes sure that the buffer is written 2 seconds after its first line came
   * in. Lines that come in later do not postpone this.
   */
  private scheduleFlush (state: DocumentState): void {
    if (state.disposed || state.flushScheduled || state.buffer.length === 0) {
      return
    }

    state.flushScheduled = true
    state.flushHandle = this.options.setTimer(() => {
      state.flushScheduled = false
      this.flushState(state, false).catch(error => {
        this.logError(`Could not write the undo history of ${state.filePath}`, error)
      })
    }, UNDO_HISTORY_FLUSH_DELAY)
  }

  /**
   * Makes sure that a check line is added about 30 seconds after the first step
   * since the last check line.
   */
  private scheduleCheck (state: DocumentState): void {
    if (state.disposed || state.checkScheduled || !state.hasUnverifiedSteps) {
      return
    }

    state.checkScheduled = true
    state.checkHandle = this.options.setTimer(() => {
      state.checkScheduled = false
      if (state.disposed || !state.hasUnverifiedSteps) {
        return
      }

      this.addCheckEntry(state)
      this.scheduleFlush(state)
    }, UNDO_HISTORY_CHECK_INTERVAL)
  }

  /**
   * Puts a check line for the current text of the document into the buffer.
   * Texts above the threshold are hashed in the worker thread; the line holds
   * its place in the buffer until the value arrives.
   */
  private addCheckEntry (state: DocumentState): void {
    state.hasUnverifiedSteps = false
    this.cancelCheckTimer(state)

    const content = state.currentText.toString()
    const entry: BufferedCheck = {
      kind: 'check',
      time: this.options.now(),
      length: state.currentText.length,
      hash: null,
      pending: null
    }

    if (content.length > UNDO_HISTORY_WORKER_HASH_THRESHOLD) {
      entry.pending = this.hashText(content).then(hash => {
        entry.hash = hash
      }, (error: unknown) => {
        this.logError('Could not calculate a check value', error)
        entry.hash = ''
      }).then(() => {
        entry.pending = null
        this.scheduleFlush(state)
      })
    } else {
      entry.hash = this.options.hashSync(content)
    }

    state.buffer.push(entry)
  }

  /**
   * Puts a step into the buffer. An edit that CodeMirror joined to the group
   * before it is merged into the line before it, as long as that line is the
   * last one in the buffer and stems from the same editor.
   */
  private pushStep (state: DocumentState, step: BufferedStep): void {
    const last = state.buffer.length > 0 ? state.buffer[state.buffer.length - 1] : undefined
    if (
      step.type === 'edit' && step.joined === true && last !== undefined && last.kind === 'step' &&
      last.type === 'edit' && last.client === step.client && last.forward.newLength === step.forward.length
    ) {
      last.forward = last.forward.compose(step.forward)
      last.inverse = step.inverse.compose(last.inverse)
      last.timeEnd = step.time
      last.length = step.length
    } else {
      state.buffer.push(step)
    }

    state.hasUnverifiedSteps = true
    this.scheduleFlush(state)
    this.scheduleCheck(state)
  }

  /** Takes the lines out of the buffer that can be written: up to the first check line without value. */
  private takeFlushable (state: DocumentState): BufferedEntry[] {
    let count = 0
    for (const entry of state.buffer) {
      if (entry.kind === 'check' && entry.hash === null) {
        break
      }
      count++
    }

    return state.buffer.splice(0, count)
  }

  /**
   * Writes the buffer of a document to its record.
   *
   * @param  {DocumentState}  state      The document
   * @param  {boolean}        immediate  True to wait for pending check values and to write everything
   */
  private async flushState (state: DocumentState, immediate: boolean): Promise<void> {
    this.cancelFlushTimer(state)

    if (immediate) {
      const pending: Array<Promise<void>> = []
      for (const entry of state.buffer) {
        if (entry.kind === 'check' && entry.pending !== null) {
          pending.push(entry.pending)
        }
      }

      if (pending.length > 0) {
        await Promise.all(pending)
      }
    }

    // From here on until the write is queued, nothing is awaited: the lines
    // and the path that they belong to stay together
    const taken = this.takeFlushable(state)
    const recordPath = state.recordPath
    const filePath = state.filePath
    const recordKey = this.keyOf(recordPath)
    this.scheduleFlush(state)

    if (taken.length === 0) {
      if (immediate) {
        await this.idle(recordKey)
      }
      return
    }

    const payload = taken.map(serializeEntry).join('')
    const headerSource: HeaderSource | null = state.baseText === null ? null : { baseText: state.baseText, created: state.created }
    await this.enqueue(recordKey, async () => {
      await this.appendEntries(recordPath, filePath, headerSource, payload)
      if (headerSource !== null && state.baseText === headerSource.baseText) {
        state.baseText = null
      }
    })
  }

  /**
   * Appends text to a record. If the record does not exist yet, its header is
   * written first. Must only be called from a task of the record's chain.
   */
  private async appendEntries (recordPath: string, filePath: string, headerSource: HeaderSource | null, payload: string): Promise<void> {
    const fs = this.options.fs
    const recordKey = this.keyOf(recordPath)
    let text = payload
    let size = this.recordSizes.get(recordKey)

    if (size === undefined) {
      const stats = await fs.stat(recordPath)
      if (stats === null) {
        await fs.mkdir(this.pathApi.dirname(recordPath))
        const header: HeaderLine = {
          type: 'header',
          format: RECORD_FORMAT,
          path: filePath,
          created: headerSource !== null ? headerSource.created : this.options.now(),
          // Without the text before the first step, the base cannot be verified
          baseLength: headerSource !== null ? headerSource.baseText.length : -1,
          baseHash: headerSource !== null ? await this.hashText(headerSource.baseText.toString()) : null
        }
        text = JSON.stringify(header) + '\n' + payload
        size = 0
      } else {
        size = stats.size
      }
    }

    await fs.appendFile(recordPath, text)
    size += Buffer.byteLength(text, 'utf8')
    this.recordSizes.set(recordKey, size)

    if (size > UNDO_HISTORY_SIZE_WARNING && !this.warnedRecords.has(recordKey)) {
      this.warnedRecords.add(recordKey)
      try {
        this.options.warn(recordPath, size)
      } catch (error) {
        this.logError('The size warning failed', error)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Recording
  // -------------------------------------------------------------------------

  /**
   * Records the updates that an editor pushed to the main process. Call this
   * before the updates are applied to the document of the main process.
   *
   * @param  {string}          filePath        The path of the document
   * @param  {Text}            documentBefore  The text of the document before the first update
   * @param  {UndoUpdate[]}    updates         The updates, in the order they are applied
   */
  public recordUpdates (filePath: string, documentBefore: Text, updates: UndoUpdate[]): void {
    const key = this.keyOf(filePath)
    const state = this.states.get(key) ?? this.createState(filePath, documentBefore)
    let current = documentBefore

    for (const update of updates) {
      if (update.changes.empty) {
        continue
      }

      let inverse: ChangeSet
      let next: Text
      try {
        inverse = update.changes.invert(current)
        next = update.changes.apply(current)
      } catch (error) {
        this.logError(`An update does not fit the document ${filePath}; it is not recorded`, error)
        break
      }

      const description: UndoDescription = update.description ?? {
        kind: 'edit',
        joined: false,
        selectionBefore: { ranges: [{ anchor: 0, head: 0 }], main: 0 }
      }
      this.pushStep(state, {
        kind: 'step',
        type: description.kind,
        time: this.options.now(),
        client: update.client,
        userEvent: description.userEvent,
        joined: description.kind === 'edit' && description.joined ? true : undefined,
        selectionBefore: description.selectionBefore,
        forward: update.changes,
        inverse,
        length: next.length
      })
      current = next
    }

    state.currentText = current
  }

  /**
   * Records that the text of a document was changed from the outside (the file
   * on the disk was loaded, the result of the comparison view was loaded). The
   * line is written immediately.
   *
   * @param   {string}                  filePath  The path of the document
   * @param   {string}                  oldText   The text before
   * @param   {string}                  newText   The text after
   * @param   {ExternalSource}          source    What caused it
   *
   * @return  {Promise<ExternalStep|null>}        The change, or null if both texts are the same
   */
  public async recordExternal (filePath: string, oldText: string, newText: string, source: ExternalSource): Promise<ExternalStep | null> {
    const sets = computeExternalChangeSets(oldText, newText)
    if (sets === null) {
      return null
    }

    const key = this.keyOf(filePath)
    const state = this.states.get(key) ?? this.createState(filePath, createDocument(oldText))
    this.pushStep(state, {
      kind: 'step',
      type: 'external',
      time: this.options.now(),
      client: '',
      source,
      forward: sets.forward,
      inverse: sets.inverse,
      length: newText.length
    })
    state.currentText = createDocument(newText)
    await this.flushState(state, true)

    return {
      forward: sets.forward.toJSON() as ChangeSetJSON,
      inverse: sets.inverse.toJSON() as ChangeSetJSON,
      oldLength: oldText.length
    }
  }

  /**
   * Records that the text of a document was written to the disk.
   *
   * @param  {string}  filePath  The path of the document
   * @param  {number}  length    The length of the text
   */
  public recordSave (filePath: string, length: number): void {
    const state = this.states.get(this.keyOf(filePath))
    if (state === undefined) {
      return
    }

    state.buffer.push({ kind: 'plain', line: { type: 'save', time: this.options.now(), length } })
    this.scheduleFlush(state)
  }

  /**
   * Writes the buffer of a document at once.
   *
   * @param   {string}         filePath  The path of the document
   *
   * @return  {Promise<void>}            Resolves when everything is on the disk
   */
  public async flush (filePath: string): Promise<void> {
    const state = this.states.get(this.keyOf(filePath))
    if (state !== undefined) {
      await this.flushState(state, true)
    }
  }

  /**
   * Writes the buffers of all documents at once. Documents that have steps
   * after their last check line get a check line (this is for quitting the
   * program).
   *
   * @return  {Promise<void>}  Resolves when everything is on the disk
   */
  public async flushAll (): Promise<void> {
    const states = [...this.states.values()]
    for (const state of states) {
      if (state.hasUnverifiedSteps) {
        this.addCheckEntry(state)
      }
    }

    await Promise.all(states.map(async state => { await this.flushState(state, true) }))
  }

  /**
   * Closes a document: a check line is added if there are steps after the
   * last one, the buffer is written, and the state of the document is
   * dropped.
   *
   * @param   {string}   filePath     The path of the document
   * @param   {string}   text         The text of the document when it was closed
   * @param   {object}   options      writeAnchor: whether to write the text to the anchor file
   *
   * @return  {Promise<void>}         Resolves when everything is on the disk
   */
  public async closeDocument (filePath: string, text: string, options: { writeAnchor: boolean }): Promise<void> {
    const key = this.keyOf(filePath)
    const state = this.states.get(key)
    const recordPath = state !== undefined ? state.recordPath : this.recordPathOf(filePath)

    if (state !== undefined) {
      this.disposeState(state)
      if (state.hasUnverifiedSteps) {
        if (state.currentText.length !== text.length) {
          state.currentText = createDocument(text)
        }
        this.addCheckEntry(state)
      }
      await this.flushState(state, true)
    }

    if (options.writeAnchor) {
      const recordKey = this.keyOf(recordPath)
      await this.enqueue(recordKey, async () => {
        if (!this.recordSizes.has(recordKey) && (await this.options.fs.stat(recordPath)) === null) {
          // No record, nothing to anchor
          return
        }

        await this.options.fs.writeFile(undoHistoryAnchorPath(recordPath), text)
      })
    }
  }

  /**
   * Checks whether a document has any step, in the buffer or in the record.
   *
   * @param   {string}            filePath  The path of the document
   *
   * @return  {Promise<boolean>}            True if there is a step
   */
  public async hasSteps (filePath: string): Promise<boolean> {
    const state = this.states.get(this.keyOf(filePath))
    if (state !== undefined && state.buffer.some(entry => entry.kind === 'step')) {
      return true
    }

    const recordPath = state !== undefined ? state.recordPath : this.recordPathOf(filePath)
    const text = await this.enqueue(this.keyOf(recordPath), async () => await this.readTextIfExists(recordPath))
    if (text === null) {
      return false
    }

    return parseUndoHistoryRecord(text).lines.some(isStepLine)
  }

  /**
   * Deletes the record and the anchor of a document, and forgets its buffer.
   * A record that does not exist is no error.
   *
   * @param   {string}         filePath  The path of the document
   *
   * @return  {Promise<void>}            Resolves when both files are gone
   */
  public async deleteRecord (filePath: string): Promise<void> {
    const state = this.states.get(this.keyOf(filePath))
    let recordPath: string
    if (state !== undefined) {
      recordPath = state.recordPath
      state.buffer.length = 0
      this.disposeState(state)
    } else {
      recordPath = this.recordPathOf(filePath)
    }

    await this.enqueue(this.keyOf(recordPath), async () => {
      await this.deleteRecordFiles(recordPath)
    })
  }

  private async deleteRecordFiles (recordPath: string): Promise<void> {
    for (const target of [ recordPath, undoHistoryAnchorPath(recordPath) ]) {
      if ((await this.options.fs.stat(target)) !== null) {
        await this.options.fs.unlink(target)
      }
    }

    this.recordSizes.delete(this.keyOf(recordPath))
  }

  // -------------------------------------------------------------------------
  // Opening a document
  // -------------------------------------------------------------------------

  /**
   * Reads the record of a document, anchors it to the text of the document,
   * and restores the history from it (specification C20, sections 6 and 7).
   * The lines that anchoring requires are appended to the record.
   *
   * @param   {string}                      filePath     The path of the document
   * @param   {string}                      currentText  The text of the document
   * @param   {UndoHistoryCandidates}       candidates   The anchor text and the backup text
   * @param   {number}                      maxEvents    The maximum number of events to restore
   *
   * @return  {Promise<UndoHistoryJSON|null>}            The history, or null if there is nothing to restore
   */
  public async getHistory (filePath: string, currentText: string, candidates: UndoHistoryCandidates, maxEvents: number): Promise<UndoHistoryJSON | null> {
    await this.flush(filePath)

    const recordPath = this.recordPathOf(filePath)
    const recordKey = this.keyOf(recordPath)
    const text = await this.enqueue(recordKey, async () => await this.readTextIfExists(recordPath))
    if (text === null) {
      return null
    }

    const parsed = parseUndoHistoryRecord(text)
    if (parsed.lines.length === 0) {
      return null
    }

    const anchoring = anchorRecord(parsed.lines, currentText, candidates, this.options.hashSync, this.options.now())
    if (anchoring.appendLines.length > 0) {
      const payload = anchoring.appendLines.map(line => JSON.stringify(line) + '\n').join('')
      await this.enqueue(recordKey, async () => {
        await this.appendEntries(recordPath, filePath, null, payload)
      })
    }

    const usableLines = parsed.lines.slice(0, anchoring.usableEnd).concat(anchoring.appendLines)
    const history = buildHistoryJSON(usableLines, maxEvents)
    return history.done.length > 0 ? history : null
  }

  // -------------------------------------------------------------------------
  // Renaming
  // -------------------------------------------------------------------------

  /**
   * Renames the record that existing steps were written to: the file name of
   * the record that already exists at the new place, which cannot be joined
   * to the chain of the renamed record, is turned into an orphan.
   */
  private async orphanRecord (recordPath: string): Promise<void> {
    const fs = this.options.fs
    const directory = this.pathApi.dirname(recordPath)
    const baseName = this.pathApi.basename(recordPath)
    const stem = baseName.endsWith(RECORD_SUFFIX) ? baseName.slice(0, baseName.length - RECORD_SUFFIX.length) : baseName
    const timestamp = formatScratchTimestamp(new Date(this.options.now()))

    let orphanPath = this.pathApi.join(directory, `${stem}.${timestamp}.orphan${RECORD_SUFFIX}`)
    let counter = 2
    while ((await fs.stat(orphanPath)) !== null) {
      orphanPath = this.pathApi.join(directory, `${stem}.${timestamp}_${counter}.orphan${RECORD_SUFFIX}`)
      counter++
    }

    await fs.rename(recordPath, orphanPath)
    this.recordSizes.delete(this.keyOf(recordPath))
    await this.moveAnchorFile(recordPath, orphanPath)
    this.options.log?.(`The undo history record ${recordPath} was kept as ${orphanPath}, because the record of the renamed document replaces it`)
  }

  private async moveAnchorFile (fromRecordPath: string, toRecordPath: string): Promise<void> {
    const fromAnchor = undoHistoryAnchorPath(fromRecordPath)
    if ((await this.options.fs.stat(fromAnchor)) !== null) {
      await this.options.fs.rename(fromAnchor, undoHistoryAnchorPath(toRecordPath))
    }
  }

  /**
   * Moves a record, and its anchor file, to a new place. An existing record at
   * the new place becomes an orphan.
   */
  private async moveRecordFiles (fromRecordPath: string, toRecordPath: string): Promise<void> {
    const fs = this.options.fs
    const fromKey = this.keyOf(fromRecordPath)
    await fs.mkdir(this.pathApi.dirname(toRecordPath))
    if ((await fs.stat(toRecordPath)) !== null) {
      await this.orphanRecord(toRecordPath)
    }

    const size = this.recordSizes.get(fromKey)
    await fs.rename(fromRecordPath, toRecordPath)
    this.recordSizes.delete(fromKey)
    if (size !== undefined) {
      this.recordSizes.set(this.keyOf(toRecordPath), size)
    }
    await this.moveAnchorFile(fromRecordPath, toRecordPath)
  }

  /**
   * Gives a document that is open a new path: its buffer, which is empty by
   * now, continues to be written to the new record.
   */
  private rekeyState (state: DocumentState, newPath: string): void {
    if (this.states.get(state.key) === state) {
      this.states.delete(state.key)
    }

    state.filePath = newPath
    state.recordPath = this.recordPathOf(newPath)
    state.key = this.keyOf(newPath)
    this.states.set(state.key, state)
  }

  /**
   * Handles the renaming or moving of a document: everything buffered is
   * written, a check line is added, and the record and the anchor file are
   * renamed to the place that belongs to the new path. A rename line is added
   * to the end of the record. A record that exists at the new place is kept
   * as an orphan. Steps that are recorded afterwards go to the new record.
   *
   * @param   {string}         oldPath  The old path of the document
   * @param   {string}         newPath  The new path of the document
   *
   * @return  {Promise<void>}           Resolves when the record is in its new place
   */
  public async rename (oldPath: string, newPath: string): Promise<void> {
    const oldRecordPath = this.recordPathOf(oldPath)
    const newRecordPath = this.recordPathOf(newPath)
    const oldRecordKey = this.keyOf(oldRecordPath)
    const newRecordKey = this.keyOf(newRecordPath)
    const state = this.states.get(this.keyOf(oldPath))

    // A document that was open at the new path would be replaced
    const replaced = this.states.get(this.keyOf(newPath))
    if (replaced !== undefined && replaced !== state) {
      this.disposeState(replaced)
      await this.flushState(replaced, true)
    }

    if (state !== undefined) {
      if (state.hasUnverifiedSteps) {
        this.addCheckEntry(state)
      }
      await this.flushState(state, true)
    }

    // From here on, nothing is awaited until the move is queued: whatever is
    // buffered for the document from now on goes to the new record, which is
    // queued behind the move
    if (state !== undefined) {
      this.rekeyState(state, newPath)
    }
    const writesToOldRecord = this.idle(oldRecordKey)

    await this.enqueue(newRecordKey, async () => {
      await writesToOldRecord
      if ((await this.options.fs.stat(oldRecordPath)) === null) {
        return
      }

      if (oldRecordKey !== newRecordKey) {
        await this.moveRecordFiles(oldRecordPath, newRecordPath)
      }

      const line: RenameLine = { type: 'rename', time: this.options.now(), from: oldPath, to: newPath }
      await this.appendEntries(newRecordPath, newPath, null, JSON.stringify(line) + '\n')
    })
  }

  private async collectRecordPaths (directory: string): Promise<string[]> {
    const result: string[] = []
    for (const entry of await this.options.fs.readdir(directory)) {
      const fullPath = this.pathApi.join(directory, entry.name)
      if (entry.isDirectory) {
        result.push(...await this.collectRecordPaths(fullPath))
      } else if (entry.name.endsWith(RECORD_SUFFIX)) {
        result.push(fullPath)
      }
    }
    return result
  }

  /**
   * Moves the content of one folder of the undo history into another that
   * already exists, file by file. A record that already exists at the target
   * becomes an orphan.
   */
  private async mergeDirectory (sourceDirectory: string, targetDirectory: string): Promise<void> {
    const fs = this.options.fs
    await fs.mkdir(targetDirectory)

    for (const entry of await fs.readdir(sourceDirectory)) {
      const sourcePath = this.pathApi.join(sourceDirectory, entry.name)
      const targetPath = this.pathApi.join(targetDirectory, entry.name)
      if (entry.isDirectory) {
        if ((await fs.stat(targetPath)) === null) {
          await fs.rename(sourcePath, targetPath)
        } else {
          await this.mergeDirectory(sourcePath, targetPath)
        }
      } else if (entry.name.endsWith(RECORD_SUFFIX)) {
        if ((await fs.stat(targetPath)) !== null) {
          await this.orphanRecord(targetPath)
        }
        await fs.rename(sourcePath, targetPath)
        await this.moveAnchorFile(sourcePath, targetPath)
      }
    }

    // Files that are no records, and anchor files without a record, are
    // moved if the name is free, and otherwise left where they are
    for (const entry of await fs.readdir(sourceDirectory)) {
      if (entry.isDirectory) {
        continue
      }

      const targetPath = this.pathApi.join(targetDirectory, entry.name)
      if ((await fs.stat(targetPath)) === null) {
        await fs.rename(this.pathApi.join(sourceDirectory, entry.name), targetPath)
      }
    }

    if ((await fs.readdir(sourceDirectory)).length === 0) {
      await fs.rmdir(sourceDirectory)
    }
  }

  /**
   * Moves the folder of the undo history that represents the old document
   * folder to the place of the new document folder, and returns the records
   * below it with their old and new document paths.
   */
  private async moveHistoryDirectory (
    oldDirectory: string, newDirectory: string, oldHistory: string, newHistory: string
  ): Promise<Array<{ recordPath: string, from: string, to: string }>> {
    const fs = this.options.fs
    if ((await fs.stat(oldHistory)) === null) {
      return []
    }

    // The records below the old folder, as names relative to it
    const relativeRecords: string[][] = []
    const collect = async (directory: string, relativeParts: string[]): Promise<void> => {
      for (const entry of await fs.readdir(directory)) {
        if (entry.isDirectory) {
          await collect(this.pathApi.join(directory, entry.name), [ ...relativeParts, entry.name ])
        } else if (entry.name.endsWith(RECORD_SUFFIX)) {
          relativeRecords.push([ ...relativeParts, entry.name ])
        }
      }
    }
    await collect(oldHistory, [])

    if ((await fs.stat(newHistory)) === null) {
      await fs.mkdir(this.pathApi.dirname(newHistory))
      await fs.rename(oldHistory, newHistory)
    } else {
      await this.mergeDirectory(oldHistory, newHistory)
    }

    // The sizes of all records below the old folder are unknown now
    const oldPrefix = this.keyOf(oldHistory) + this.pathApi.sep
    for (const key of [...this.recordSizes.keys()]) {
      if (key.startsWith(oldPrefix)) {
        this.recordSizes.delete(key)
      }
    }

    const moved: Array<{ recordPath: string, from: string, to: string }> = []
    for (const parts of relativeRecords) {
      const folders = parts.slice(0, -1)
      const documentName = parts[parts.length - 1].slice(0, parts[parts.length - 1].length - RECORD_SUFFIX.length)
      moved.push({
        recordPath: this.pathApi.join(newHistory, ...parts),
        from: this.pathApi.join(oldDirectory, ...folders, documentName),
        to: this.pathApi.join(newDirectory, ...folders, documentName)
      })
    }
    return moved
  }

  /**
   * Handles the renaming or moving of a folder of documents: the records of
   * all documents below it move together with it, and a rename line is added
   * to the end of each, so that the clean-up knows the new path. Documents
   * below the folder that are open continue to be recorded at their new path.
   *
   * Records that the path mapping puts into the __Long folder do not move,
   * since their place depends on the whole path of the document.
   *
   * @param   {string}         oldDirectory  The old path of the folder
   * @param   {string}         newDirectory  The new path of the folder
   *
   * @return  {Promise<void>}                Resolves when the records are in their new place
   */
  public async renameDirectory (oldDirectory: string, newDirectory: string): Promise<void> {
    const platform = this.options.platform
    const oldHistory = mapDirectoryWithoutLimits(oldDirectory, this.pathOptions())
    const newHistory = mapDirectoryWithoutLimits(newDirectory, this.pathOptions())

    // Documents that are open below the folder: write what is buffered
    const affected = [...this.states.values()].filter(state => isPathInside(state.filePath, oldDirectory, platform))
    for (const state of affected) {
      if (state.hasUnverifiedSteps) {
        this.addCheckEntry(state)
      }
    }
    await Promise.all(affected.map(async state => { await this.flushState(state, true) }))

    // From here on, nothing is awaited until the writes of the open documents
    // are queued behind the move
    let releaseWrites: () => void = () => undefined
    const moveFinished = new Promise<void>(resolve => {
      releaseWrites = resolve
    })
    for (const state of affected) {
      const relative = this.pathApi.relative(this.pathApi.resolve(oldDirectory), this.pathApi.resolve(state.filePath))
      this.rekeyState(state, this.pathApi.join(newDirectory, relative))
      void this.enqueue(this.keyOf(state.recordPath), async () => { await moveFinished })
    }

    let moved: Array<{ recordPath: string, from: string, to: string }> = []
    try {
      if (oldHistory !== null && newHistory !== null && this.keyOf(oldHistory) !== this.keyOf(newHistory)) {
        moved = await this.moveHistoryDirectory(oldDirectory, newDirectory, oldHistory, newHistory)
      }
    } finally {
      releaseWrites()
    }

    const time = this.options.now()
    await Promise.all(moved.map(async entry => {
      const line: RenameLine = { type: 'rename', time, from: entry.from, to: entry.to }
      await this.enqueue(this.keyOf(entry.recordPath), async () => {
        if ((await this.options.fs.stat(entry.recordPath)) !== null) {
          await this.appendEntries(entry.recordPath, entry.to, null, JSON.stringify(line) + '\n')
        }
      })
    }))
  }

  // -------------------------------------------------------------------------
  // Clean-up
  // -------------------------------------------------------------------------

  private async removeEmptyDirectories (startDirectory: string): Promise<void> {
    const root = this.options.getRoot()
    const rootKey = this.keyOf(root)
    let directory = startDirectory
    while (this.keyOf(directory) !== rootKey && isPathInside(directory, root, this.options.platform)) {
      if ((await this.options.fs.readdir(directory)).length > 0) {
        break
      }

      await this.options.fs.rmdir(directory)
      directory = this.pathApi.dirname(directory)
    }
  }

  private async pruneRecord (recordPath: string, options: UndoHistoryPruneOptions): Promise<void> {
    const fs = this.options.fs
    const parsed = parseUndoHistoryRecord(await fs.readFile(recordPath))

    type LineEntry = ParsedEntry & { line: UndoHistoryLine }
    const lineEntries = parsed.entries.filter((entry): entry is LineEntry => entry.line !== null)
    const lines = lineEntries.map(entry => entry.line)
    const header = lines[0]
    if (header === undefined || header.type !== 'header') {
      // Not a record that this program wrote; leave it alone
      return
    }

    // The path that the document has now, after all renamings
    let latestPath = header.path
    for (const line of lines) {
      if (line.type === 'rename') {
        latestPath = line.to
      }
    }
    if (options.isOpen(latestPath) || this.states.has(this.keyOf(latestPath))) {
      return
    }

    // Everything before the first step that is young enough goes
    const cutoff = options.now - options.retentionDays * MILLISECONDS_PER_DAY
    let firstStepIndex = -1
    let firstKeptIndex = -1
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]
      if (!isStepLine(line)) {
        continue
      }

      if (firstStepIndex < 0) {
        firstStepIndex = index
      }
      if (line.time >= cutoff) {
        firstKeptIndex = index
        break
      }
    }

    if (firstStepIndex < 0 ? header.created < cutoff : firstKeptIndex < 0) {
      // Nothing is left that is worth keeping
      await this.deleteRecordFiles(recordPath)
      await this.removeEmptyDirectories(this.pathApi.dirname(recordPath))
      return
    }

    if (firstStepIndex < 0 || firstKeptIndex === firstStepIndex) {
      // Nothing is too old
      return
    }

    // The path of the document at the cut, and the length of its text there
    let pathAtCut = header.path
    for (let index = 1; index < firstKeptIndex; index++) {
      const line = lines[index]
      if (line.type === 'rename') {
        pathAtCut = line.to
      }
    }

    let lengthAtCut = -1
    for (let index = firstKeptIndex - 1; index >= 1; index--) {
      const line = lines[index]
      if (isStepLine(line) || line.type === 'break') {
        lengthAtCut = line.length
        break
      }
    }

    // The text at the cut: from the anchor file or the document itself, if one
    // of them leads back to the last check line through the steps of the record
    const candidateTexts: string[] = []
    const anchorText = await this.readTextIfExists(undoHistoryAnchorPath(recordPath))
    if (anchorText !== null) {
      candidateTexts.push(normalizeDocumentText(anchorText))
    }
    const documentText = await this.readTextIfExists(latestPath)
    if (documentText !== null) {
      candidateTexts.push(normalizeDocumentText(documentText))
    }

    let textAtCut: Text | null = null
    for (const candidate of candidateTexts) {
      const walk = walkBack(lines, createDocument(candidate), this.options.hashSync, firstKeptIndex)
      if (walk.verified && walk.captured !== null) {
        textAtCut = walk.captured
        break
      }
    }

    const newHeader: HeaderLine = {
      type: 'header',
      format: RECORD_FORMAT,
      path: pathAtCut,
      created: header.created,
      baseLength: textAtCut !== null ? textAtCut.length : lengthAtCut,
      baseHash: textAtCut !== null ? await this.hashText(textAtCut.toString()) : null
    }

    // Keep the text of the remaining lines as it is, including lines that this
    // version does not know
    const startEntry = parsed.entries.indexOf(lineEntries[firstKeptIndex])
    const content = JSON.stringify(newHeader) + '\n' + parsed.entries.slice(startEntry).map(entry => entry.raw + '\n').join('')

    const temporaryPath = recordPath + TEMPORARY_SUFFIX
    await fs.writeFile(temporaryPath, content)
    await fs.rename(temporaryPath, recordPath)
    this.recordSizes.delete(this.keyOf(recordPath))
  }

  /**
   * Removes the steps that are older than the retention time from all records,
   * and the records whose steps are all too old. Only files that end in
   * .history.jsonl (and their .anchor files) are touched. The record of a
   * document that is open is not touched.
   *
   * @param   {UndoHistoryPruneOptions}  options  The current time, the retention time, and the function that tells whether a document is open
   *
   * @return  {Promise<void>}                      Resolves when all records are processed
   */
  public async pruneExpired (options: UndoHistoryPruneOptions): Promise<void> {
    const root = this.options.getRoot()
    if ((await this.options.fs.stat(root)) === null) {
      return
    }

    for (const recordPath of await this.collectRecordPaths(root)) {
      try {
        await this.enqueue(this.keyOf(recordPath), async () => {
          await this.pruneRecord(recordPath, options)
        })
      } catch (error) {
        this.logError(`Could not clean up the undo history record ${recordPath}`, error)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The file system of the program
// ---------------------------------------------------------------------------

/**
 * Creates the file system object for the store, based on fs.promises.
 *
 * @return  {UndoHistoryFileSystem}  The file system
 */
export function createNodeUndoHistoryFileSystem (): UndoHistoryFileSystem {
  return {
    appendFile: async (filePath, data) => { await fsPromises.appendFile(filePath, data, 'utf8') },
    writeFile: async (filePath, data) => { await fsPromises.writeFile(filePath, data, 'utf8') },
    readFile: async (filePath) => await fsPromises.readFile(filePath, 'utf8'),
    rename: async (from, to) => { await fsPromises.rename(from, to) },
    unlink: async (filePath) => { await fsPromises.unlink(filePath) },
    mkdir: async (directory) => { await fsPromises.mkdir(directory, { recursive: true }) },
    readdir: async (directory) => {
      const entries = await fsPromises.readdir(directory, { withFileTypes: true })
      return entries.map(entry => ({ name: entry.name, isDirectory: entry.isDirectory() }))
    },
    stat: async (filePath) => {
      try {
        const stats = await fsPromises.stat(filePath)
        return { size: stats.size }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          return null
        }
        throw error
      }
    },
    rmdir: async (directory) => { await fsPromises.rmdir(directory) }
  }
}
