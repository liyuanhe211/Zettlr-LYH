/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TextReadingPositionStore, createPersistentTextReadingPositionStore
 * CVM-Role:        Model
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH R98: the main process side of the persistent
 *                  reading position of text files. For every file it remembers
 *                  the last scroll position, which is the line at the top of
 *                  the viewport (counted from 1) and the number of pixels the
 *                  viewport top lies below the top of that line. The cursor,
 *                  the selection and the folds are not stored. Entries are
 *                  identified by the Windows path identity (resolved and lower
 *                  case on Windows, resolved as is elsewhere), at most 200
 *                  entries are kept, and when the limit is exceeded the entry
 *                  that was written longest ago is dropped. The store takes its
 *                  reading, writing, clock and platform as injected functions,
 *                  so it does not depend on electron and can be tested
 *                  directly; the factory at the end wires it to the
 *                  PersistentDataContainer.
 *
 * END HEADER
 */

import path from 'path'
import PersistentDataContainer from '@common/modules/persistent-data-container'

/** The name of the data file in the data directory of the application */
export const TEXT_READING_POSITIONS_FILE_NAME = 'text-reading-positions.json'

/** The maximum number of files whose reading position is kept */
export const TEXT_READING_POSITION_LIMIT = 200

/** The reading position of one file */
export interface TextReadingPosition {
  /** The line at the top of the viewport, counted from 1 */
  line: number
  /** How many pixels the top of the viewport lies below the top of that line; not negative */
  offset: number
}

/** One entry of the data file: the position, the file, and when it was written */
export interface TextReadingPositionEntry extends TextReadingPosition {
  /** The absolute path as it was given in the most recent write */
  path: string
  /** The time of the most recent write, in milliseconds */
  time: number
}

/** The content of the data file */
export interface TextReadingPositionData {
  version: 1
  entries: TextReadingPositionEntry[]
}

/** What both commands return when the payload is not acceptable */
export type TextReadingPositionError = { error: 'invalid-payload' }

/**
 * The functions the store works with. Every operation after the first load
 * happens in memory; save() is called once after every successful write.
 */
export interface TextReadingPositionStoreDependencies {
  /** Reads the stored data; may reject, or resolve to anything (the content is checked by the store) */
  load: () => Promise<unknown>
  /** Persists the data after a write */
  save: (data: TextReadingPositionData) => void
  /** The current time in milliseconds */
  now: () => number
  /** The platform that decides how paths are checked and compared */
  platform: NodeJS.Platform
}

/** An entry together with its path identity, which is computed once */
interface StoredRecord {
  identity: string
  entry: TextReadingPositionEntry
}

function createInvalidPayloadError (): TextReadingPositionError {
  return { error: 'invalid-payload' }
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** A path is acceptable if it is a string without NUL that is absolute on the given platform */
function isValidFilePath (value: unknown, platform: NodeJS.Platform): value is string {
  if (typeof value !== 'string' || value.includes('\0')) {
    return false
  }
  return platform === 'win32' ? path.win32.isAbsolute(value) : path.posix.isAbsolute(value)
}

function isValidLine (value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

function isValidOffset (value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isValidTime (value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Two paths denote the same file if and only if their identities are equal */
function getPathIdentity (filePath: string, platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? path.win32.resolve(filePath).toLowerCase()
    : path.posix.resolve(filePath)
}

/**
 * Removes the records beyond the limit. The ones with the smallest time go
 * first; among equal times the one earlier in the list (written earlier) goes
 * first. The record passed as keep (the one that was just written) is never
 * removed, so that a clock that jumped backwards cannot discard the write that
 * is being reported as successful.
 */
function removeExcessRecords (records: StoredRecord[], keep?: StoredRecord): StoredRecord[] {
  const excess = records.length - TEXT_READING_POSITION_LIMIT
  if (excess <= 0) {
    return records
  }

  const candidates = records
    .map((record, index) => ({ record, index }))
    .filter(candidate => candidate.record !== keep)
  candidates.sort((first, second) => {
    const difference = first.record.entry.time - second.record.entry.time
    return difference !== 0 ? difference : first.index - second.index
  })
  const removed = new Set(candidates.slice(0, excess).map(candidate => candidate.record))
  return records.filter(record => !removed.has(record))
}

/**
 * Turns whatever was read from the data file into a list of records. Content
 * that is not an object with an entries array counts as empty; unusable
 * entries are dropped one by one; of several entries with the same path
 * identity the one with the largest time is kept (the later one if the times
 * are equal); the result is cut down to the limit. The version number is not
 * checked, so that every usable entry is read even from a future format.
 */
function readRecords (data: unknown, platform: NodeJS.Platform): StoredRecord[] {
  if (!isRecord(data) || !Array.isArray(data.entries)) {
    return []
  }

  const usable: StoredRecord[] = []
  for (const candidate of data.entries as unknown[]) {
    if (!isRecord(candidate)) {
      continue
    }
    const { path: filePath, line, offset, time } = candidate
    if (!isValidFilePath(filePath, platform) || !isValidLine(line) || !isValidOffset(offset) || !isValidTime(time)) {
      continue
    }
    usable.push({ identity: getPathIdentity(filePath, platform), entry: { path: filePath, line, offset, time } })
  }

  const winners = new Map<string, number>()
  usable.forEach((record, index) => {
    const winner = winners.get(record.identity)
    if (winner === undefined || record.entry.time >= usable[winner].entry.time) {
      winners.set(record.identity, index)
    }
  })
  const distinct = usable.filter((record, index) => winners.get(record.identity) === index)

  return removeExcessRecords(distinct)
}

/**
 * Remembers the reading position of text files. The first call of either
 * method loads the data once; after that everything happens in memory, and
 * every successful setPosition() hands the complete data to save().
 */
export class TextReadingPositionStore {
  private records: StoredRecord[] = []
  private loading: Promise<void>|undefined

  constructor (private readonly dependencies: TextReadingPositionStoreDependencies) {}

  /**
   * Returns the reading position of a file, or null if there is none.
   *
   * @param   {unknown}  payload  Expected to be { filePath: string }
   */
  async getPosition (payload: unknown): Promise<TextReadingPosition | null | TextReadingPositionError> {
    if (!isRecord(payload)) {
      return createInvalidPayloadError()
    }
    const { filePath } = payload
    if (!isValidFilePath(filePath, this.dependencies.platform)) {
      return createInvalidPayloadError()
    }

    await this.ensureLoaded()

    const identity = getPathIdentity(filePath, this.dependencies.platform)
    const record = this.records.find(candidate => candidate.identity === identity)
    return record === undefined ? null : { line: record.entry.line, offset: record.entry.offset }
  }

  /**
   * Writes the reading position of a file. A write for a file that has an
   * entry replaces it, and gives it a new write time.
   *
   * @param   {unknown}  payload  Expected to be { filePath: string, line: number, offset: number }
   */
  async setPosition (payload: unknown): Promise<true | TextReadingPositionError> {
    if (!isRecord(payload)) {
      return createInvalidPayloadError()
    }
    const { filePath, line, offset } = payload
    if (!isValidFilePath(filePath, this.dependencies.platform) || !isValidLine(line) || !isValidOffset(offset)) {
      return createInvalidPayloadError()
    }

    await this.ensureLoaded()

    const identity = getPathIdentity(filePath, this.dependencies.platform)
    const record: StoredRecord = { identity, entry: { path: filePath, line, offset, time: this.dependencies.now() } }
    this.records = this.records.filter(candidate => candidate.identity !== identity)
    this.records.push(record)
    this.records = removeExcessRecords(this.records, record)

    this.dependencies.save({ version: 1, entries: this.records.map(candidate => ({ ...candidate.entry })) })
    return true
  }

  private async ensureLoaded (): Promise<void> {
    this.loading ??= this.loadRecords()
    await this.loading
  }

  private async loadRecords (): Promise<void> {
    let stored: unknown
    try {
      stored = await this.dependencies.load()
    } catch {
      // A data file that is missing or malformed counts as empty data
      stored = undefined
    }
    this.records = readRecords(stored, this.dependencies.platform)
  }
}

/** A store that persists into a file, and the function that writes pending changes immediately */
export interface PersistentTextReadingPositionStore {
  store: TextReadingPositionStore
  /** Writes pending changes to disk at once; to be called when the program exits */
  flush: () => void
}

/**
 * Creates the store that persists into the data file of the application. The
 * data file is read at the first use only. Writes go through the
 * PersistentDataContainer, which writes to disk after a delay of 1,000
 * milliseconds; flush() writes immediately.
 *
 * @param   {string}           dataFilePath  The absolute path of the data file
 * @param   {NodeJS.Platform}  platform      The platform; only tests pass a different one
 */
export function createPersistentTextReadingPositionStore (dataFilePath: string, platform: NodeJS.Platform = process.platform): PersistentTextReadingPositionStore {
  const container = new PersistentDataContainer<TextReadingPositionData>(dataFilePath, 'json', 1000)
  const store = new TextReadingPositionStore({
    load: async () => {
      if (!await container.isInitialized()) {
        return undefined
      }
      // A data file with malformed JSON makes get() throw; the store treats that as empty data
      return await container.get()
    },
    save: data => { container.set(data) },
    now: () => Date.now(),
    platform
  })
  return { store, flush: () => { container.shutdown() } }
}
