/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        RecoveryJournalStore
 * CVM-Role:        Model
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH data loss prevention (R173, specification C21
 *                  section 5): the session files of the recovery journal. Every
 *                  editor state writes the steps of its document into one
 *                  session file, independently of the document synchronization.
 *                  This module appends the records, rebuilds the text of a
 *                  session, decides which sessions are recoverable, resolves
 *                  sessions, writes recovery copies, and removes expired
 *                  files. It does not depend on Electron: the root directory,
 *                  the logger, the clock, and the knowledge of which sessions
 *                  are still being written all come from the caller.
 *
 * END HEADER
 */

import path from 'path'
import { promises as fs } from 'fs'
import crypto from 'crypto'
import { ChangeSet, Text } from '@codemirror/state'
import type { IPCAPI } from '../provider-contract'

/** The format version that the session header carries */
export const RECOVERY_JOURNAL_FORMAT_VERSION = 1
/** How long the file of a session that ended without unconfirmed steps is kept */
export const CLEAN_SESSION_RETENTION_HOURS = 24
/** How long the file of a resolved session is kept */
export const RESOLVED_RETENTION_DAYS = 30

const CLEAN_SESSION_RETENTION_MS = CLEAN_SESSION_RETENTION_HOURS * 60 * 60 * 1000
const RESOLVED_RETENTION_MS = RESOLVED_RETENTION_DAYS * 24 * 60 * 60 * 1000

const SESSIONS_FOLDER = 'sessions'
const COPIES_FOLDER = 'copies'
const RESOLVED_FOLDER = 'resolved'

const SESSION_ID_PATTERN = /^[a-z0-9]{12}$/
const SESSION_FILE_PATTERN = /^([0-9a-f]{16})-([a-z0-9]{12})\.jsonl$/

export type RecoveryJournalEndReason = 'unmount'|'reload'|'pagehide'
export type RecoveryJournalResolution = 'delivered'|'restored'|'kept-as-file'|'discarded'

const END_REASONS: readonly string[] = [ 'unmount', 'reload', 'pagehide' ]
const RESOLUTIONS: readonly string[] = [ 'delivered', 'restored', 'kept-as-file', 'discarded' ]

/**
 * The header of a session. It is written together with the first local step,
 * so an editor without local modifications never produces a session file.
 */
export interface RecoveryJournalSessionRecord {
  type: 'session'
  formatVersion: number
  sessionId: string
  filePath: string
  windowId: string
  leafId: string
  clientID: string
  /** Milliseconds since the epoch */
  startedAt: number
  /** The synchronized version before the first local step */
  baseVersion: number
  /** The full text before the first local step, lines separated by "\n" */
  baseText: string
}

/** One transaction that changed the document, local or remote */
export interface RecoveryJournalStepRecord {
  type: 'step'
  /** Starts at 1 and increases by 1 with every step */
  sequence: number
  time: number
  /** The result of `ChangeSet.toJSON()` */
  changes: unknown
  /** Whether the step applied updates that were pulled from the main process */
  remote: boolean
  /** The length of the document after the step */
  lengthAfter: number
  userEvent?: string
}

/** Written whenever every unconfirmed modification has been confirmed */
export interface RecoveryJournalConfirmedRecord {
  type: 'confirmed'
  /** The sequence of the last local step that is confirmed */
  through: number
  time: number
}

/** Written when the editor state is replaced or destroyed */
export interface RecoveryJournalEndRecord {
  type: 'end'
  time: number
  reason: RecoveryJournalEndReason
  /** The number of local steps after the last confirmed record */
  unconfirmedSteps: number
}

export type RecoveryJournalRecord =
  RecoveryJournalSessionRecord|RecoveryJournalStepRecord|RecoveryJournalConfirmedRecord|RecoveryJournalEndRecord

/** What `list-recoverable` returns per session when no file path is given */
export interface RecoverableSessionSummary {
  sessionId: string
  filePath: string
  startedAt: number
  /** The time of the last local step */
  lastStepAt: number
  unconfirmedSteps: number
  /** Whether the text could not be rebuilt through the last step */
  damaged: boolean
}

/** What `list-recoverable` returns per session when a file path is given */
export interface RecoverableSession extends RecoverableSessionSummary {
  /** The rebuilt text, lines separated by "\n" (as `EditorState.doc.toString()` returns it) */
  finalText: string
}

export interface RecoveryJournalResolveResult {
  /** False if there was no such session in the sessions folder (anymore) */
  resolved: boolean
  /** The recovery copy; only for the resolution `kept-as-file` */
  copyPath?: string
}

export interface RecoveryJournalPreserveResult {
  copyPath: string
}

export interface RecoveryJournalCleanupResult {
  removedCleanSessions: number
  removedResolvedSessions: number
}

export interface RecoveryJournalAppendPayload {
  filePath: string
  sessionId: string
  records: RecoveryJournalRecord[]
}

export interface RecoveryJournalListPayload {
  filePath?: string
}

export interface RecoveryJournalResolvePayload {
  filePath: string
  sessionId: string
  resolution: RecoveryJournalResolution
}

export interface RecoveryJournalPreservePayload {
  filePath: string
  sessionId: string
  text: string
  reason: string
}

/** The commands of the channel `recovery-journal` with their payloads */
export interface RecoveryJournalAPIMap {
  'append': RecoveryJournalAppendPayload
  'list-recoverable': RecoveryJournalListPayload|undefined
  'resolve': RecoveryJournalResolvePayload
  'preserve-text': RecoveryJournalPreservePayload
}

export type RecoveryJournalIPCAPI = IPCAPI<RecoveryJournalAPIMap>

/**
 * The subset of the log provider this store needs. Defined structurally so
 * that the store stays free of Electron dependencies and can be unit-tested.
 */
export interface RecoveryJournalLogger {
  info: (message: string, details?: unknown) => void
  error: (message: string, details?: unknown) => void
}

export interface RecoveryJournalStoreOptions {
  /** The clock, in milliseconds since the epoch */
  now: () => number
  /**
   * Tells whether a session is still being written: it was written during this
   * run of the main process, and the page that writes it still exists and has
   * not been reloaded since. Only asked for sessions without an end record.
   */
  isSessionLive: (sessionId: string, filePath: string) => boolean
  /** The platform that decides whether paths are compared case-insensitively; defaults to the current one */
  platform?: NodeJS.Platform
}

/** The records of one session file */
export interface ParsedRecoverySession {
  header: RecoveryJournalSessionRecord|undefined
  /** Without duplicates, ordered by sequence */
  steps: RecoveryJournalStepRecord[]
  /** The highest `through` of the confirmed records, 0 if there is none */
  confirmedThrough: number
  end: RecoveryJournalEndRecord|undefined
  /** Whether the file contains lines that are not valid records of this format version */
  malformed: boolean
}

export interface RebuiltRecoveryText {
  text: string
  /** Whether rebuilding stopped before the last step, or the file has unreadable lines */
  damaged: boolean
  /** How many steps were applied */
  appliedSteps: number
}

/**
 * Returns the path key of a file: the first 16 hexadecimal characters of the
 * SHA-256 of its absolute path, which is lowercased first on Windows.
 *
 * @param   {string}           filePath  The absolute path of the file
 * @param   {NodeJS.Platform}  platform  The platform; defaults to the current one
 *
 * @return  {string}                     The path key
 */
export function recoveryPathKey (filePath: string, platform: NodeJS.Platform = process.platform): string {
  const normalized = platform === 'win32' ? filePath.toLowerCase() : filePath
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16)
}

/**
 * Returns the file name of a recovery copy:
 * `<name without extension> (Recovered <YYYYMMDD-HHMMSS>)<extension>`, with
 * the time in the local time zone.
 *
 * @param   {string}  filePath   The original file
 * @param   {number}  timestamp  Milliseconds since the epoch
 *
 * @return  {string}             The file name
 */
export function recoveryCopyFileName (filePath: string, timestamp: number): string {
  // Paths of both kinds may arrive here regardless of the platform
  const baseName = path.win32.basename(path.posix.basename(filePath))
  const extension = path.extname(baseName)
  const stem = baseName.slice(0, baseName.length - extension.length)
  const date = new Date(timestamp)
  const twoDigits = (value: number): string => String(value).padStart(2, '0')
  const day = `${date.getFullYear()}${twoDigits(date.getMonth() + 1)}${twoDigits(date.getDate())}`
  const time = `${twoDigits(date.getHours())}${twoDigits(date.getMinutes())}${twoDigits(date.getSeconds())}`
  return `${stem} (Recovered ${day}-${time})${extension}`
}

function isObject (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCount (value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isTime (value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Checks that a value is a record of the journal format, field by field.
 *
 * @param   {unknown}  value  The value to check
 *
 * @return  {boolean}         Whether it is a valid record
 */
export function isRecoveryJournalRecord (value: unknown): value is RecoveryJournalRecord {
  if (!isObject(value)) {
    return false
  }

  switch (value.type) {
    case 'session':
      return value.formatVersion === RECOVERY_JOURNAL_FORMAT_VERSION &&
        typeof value.sessionId === 'string' && SESSION_ID_PATTERN.test(value.sessionId) &&
        typeof value.filePath === 'string' && typeof value.windowId === 'string' &&
        typeof value.leafId === 'string' && typeof value.clientID === 'string' &&
        isTime(value.startedAt) && isCount(value.baseVersion) && typeof value.baseText === 'string'
    case 'step':
      return isCount(value.sequence) && value.sequence >= 1 && isTime(value.time) &&
        Array.isArray(value.changes) && typeof value.remote === 'boolean' && isCount(value.lengthAfter) &&
        (value.userEvent === undefined || typeof value.userEvent === 'string')
    case 'confirmed':
      return isCount(value.through) && isTime(value.time)
    case 'end':
      return isTime(value.time) && typeof value.reason === 'string' && END_REASONS.includes(value.reason) &&
        isCount(value.unconfirmedSteps)
    default:
      return false
  }
}

/**
 * Reads the records out of the contents of a session file. Lines that are not
 * valid records are skipped and reported through the `malformed` flag. Steps
 * are ordered by their sequence and a repeated sequence counts once, so a batch
 * that was written twice or out of order does not damage the session.
 *
 * @param   {string}                 contents  The contents of the session file
 *
 * @return  {ParsedRecoverySession}            The records
 */
export function parseRecoverySession (contents: string): ParsedRecoverySession {
  const session: ParsedRecoverySession = { header: undefined, steps: [], confirmedThrough: 0, end: undefined, malformed: false }
  const stepsBySequence = new Map<number, RecoveryJournalStepRecord>()

  for (const line of contents.split('\n')) {
    if (line.trim() === '') {
      continue
    }

    let record: unknown
    try {
      record = JSON.parse(line)
    } catch (err) {
      session.malformed = true
      continue
    }

    if (!isRecoveryJournalRecord(record)) {
      session.malformed = true
      continue
    }

    if (record.type === 'session') {
      session.header = session.header ?? record
    } else if (record.type === 'step') {
      if (!stepsBySequence.has(record.sequence)) {
        stepsBySequence.set(record.sequence, record)
      }
    } else if (record.type === 'confirmed') {
      session.confirmedThrough = Math.max(session.confirmedThrough, record.through)
    } else {
      session.end = session.end ?? record
    }
  }

  session.steps = [...stepsBySequence.values()].sort((first, second) => first.sequence - second.sequence)
  return session
}

/**
 * Rebuilds the text of a session: starting from the base text, the changes of
 * every step are applied in the order of the sequences, and the length of the
 * document is compared with `lengthAfter` after every step. If a step is
 * missing, cannot be applied, or leaves a different length, rebuilding stops
 * at the step before it and the result is marked as damaged.
 *
 * @param   {ParsedRecoverySession}  session  The records of the session
 *
 * @return  {RebuiltRecoveryText}             The text and whether it is damaged
 */
export function rebuildRecoveryText (session: ParsedRecoverySession): RebuiltRecoveryText {
  if (session.header === undefined) {
    return { text: '', damaged: true, appliedSteps: 0 }
  }

  let document = Text.of(session.header.baseText.split('\n'))
  let appliedSteps = 0
  let damaged = session.malformed

  for (const step of session.steps) {
    if (step.sequence !== appliedSteps + 1) {
      damaged = true
      break
    }

    let nextDocument: Text
    try {
      nextDocument = ChangeSet.fromJSON(step.changes).apply(document)
    } catch (err) {
      damaged = true
      break
    }

    if (nextDocument.length !== step.lengthAfter) {
      damaged = true
      break
    }

    document = nextDocument
    appliedSteps++
  }

  return { text: document.toString(), damaged, appliedSteps }
}

function errorMessage (err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isMissingFileError (err: unknown): boolean {
  return isObject(err) && err.code === 'ENOENT'
}

export default class RecoveryJournalStore {
  /**
   * Holds the tail of the operation queue per session file (and per folder of
   * recovery copies). The operations on one file run strictly one after
   * another, so records are written in the order in which they arrived, and
   * a session is never listed, resolved, or removed in the middle of a write.
   */
  private readonly _operationQueues: Map<string, Promise<void>>
  /** The recovery copy of every session that got one during this run */
  private readonly _copyPaths: Map<string, string>
  /** The session files without a usable header that have been reported already */
  private readonly _reportedUnreadableFiles: Set<string>
  private readonly _platform: NodeJS.Platform
  private _directoriesReady: Promise<void>|undefined

  /**
   * @param  {string}                       _rootDirectory  Where the journal is stored
   *                                                        (for Zettlr: the folder
   *                                                        recovery-journal inside the
   *                                                        user data directory)
   * @param  {RecoveryJournalLogger}        _logger         The logger to use
   * @param  {RecoveryJournalStoreOptions}  _options        The clock and the knowledge
   *                                                        of which sessions are live
   */
  constructor (
    private readonly _rootDirectory: string,
    private readonly _logger: RecoveryJournalLogger,
    private readonly _options: RecoveryJournalStoreOptions
  ) {
    this._operationQueues = new Map()
    this._copyPaths = new Map()
    this._reportedUnreadableFiles = new Set()
    this._platform = _options.platform ?? process.platform
    this._directoriesReady = undefined
  }

  /** Sessions in progress, recoverable sessions, cleanly ended sessions that await removal, and sessions without an end record whose steps were all confirmed */
  public get sessionsDirectory (): string { return path.join(this._rootDirectory, SESSIONS_FOLDER) }
  /** Recovery copies, in one subfolder per path key */
  public get copiesDirectory (): string { return path.join(this._rootDirectory, COPIES_FOLDER) }
  /** Resolved sessions */
  public get resolvedDirectory (): string { return path.join(this._rootDirectory, RESOLVED_FOLDER) }

  /**
   * Returns the name of the session file: `<path key>-<session ID>.jsonl`.
   *
   * @param   {string}  filePath   The file the session belongs to
   * @param   {string}  sessionId  Twelve lowercase letters and digits
   *
   * @return  {string}             The file name
   *
   * @throws  {Error}              If the file path or the session ID is invalid
   */
  public sessionFileName (filePath: string, sessionId: string): string {
    if (typeof filePath !== 'string' || filePath === '') {
      throw new Error('The recovery journal needs the path of the file')
    }
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
      throw new Error(`Invalid recovery journal session ID: ${String(sessionId)}`)
    }
    return `${recoveryPathKey(filePath, this._platform)}-${sessionId}.jsonl`
  }

  /**
   * Creates the three folders of the journal.
   */
  public async boot (): Promise<void> {
    await this._ensureDirectories()
  }

  /**
   * Appends records to the file of a session. When the returned promise
   * resolves, the records are on disk: they are written and synchronized
   * immediately, without any delay or buffer.
   *
   * @param   {string}                   filePath   The file the session belongs to
   * @param   {string}                   sessionId  The session
   * @param   {RecoveryJournalRecord[]}  records    The records, in order
   *
   * @throws  {Error}                               If the records are invalid or
   *                                                could not be written; the
   *                                                failure is also logged
   */
  public async append (filePath: string, sessionId: string, records: RecoveryJournalRecord[]): Promise<void> {
    let fileName: string
    let lines: string
    try {
      fileName = this.sessionFileName(filePath, sessionId)
      lines = this._serializeRecords(sessionId, records)
    } catch (err) {
      this._logger.error(`[Recovery Journal] Refused to append to session ${String(sessionId)} of ${String(filePath)}: ${errorMessage(err)}`, err)
      throw err
    }

    if (lines === '') {
      return
    }

    await this._enqueue(fileName, async () => {
      try {
        await this._ensureDirectories()
        const handle = await fs.open(path.join(this.sessionsDirectory, fileName), 'a')
        try {
          await handle.appendFile(lines, 'utf8')
          await handle.sync()
        } finally {
          await handle.close()
        }
      } catch (err) {
        // Create the folders anew next time; they may have been removed
        this._directoriesReady = undefined
        this._logger.error(`[Recovery Journal] Could not append ${records.length} record(s) to session ${sessionId} of ${filePath}: ${errorMessage(err)}`, err)
        throw err
      }
    })
  }

  /**
   * Returns the recoverable sessions of one file with their rebuilt texts, the
   * newest first.
   *
   * @param   {string}                         filePath  The file
   *
   * @return  {Promise<RecoverableSession[]>}            The sessions
   */
  public async listRecoverable (filePath: string): Promise<RecoverableSession[]> {
    if (typeof filePath !== 'string' || filePath === '') {
      throw new Error('The recovery journal needs the path of the file')
    }
    return await this._collectRecoverable(recoveryPathKey(filePath, this._platform))
  }

  /**
   * Returns the recoverable sessions of all files, the newest first, without
   * their texts.
   *
   * @return  {Promise<RecoverableSessionSummary[]>}  The sessions
   */
  public async listRecoverableSummaries (): Promise<RecoverableSessionSummary[]> {
    const sessions = await this._collectRecoverable(undefined)
    return sessions.map(session => ({
      sessionId: session.sessionId,
      filePath: session.filePath,
      startedAt: session.startedAt,
      lastStepAt: session.lastStepAt,
      unconfirmedSteps: session.unconfirmedSteps,
      damaged: session.damaged
    }))
  }

  /**
   * Resolves a session: its file is moved into the folder of resolved
   * sessions, never deleted. The resolution `kept-as-file` additionally
   * writes the rebuilt text as a recovery copy.
   *
   * @param   {string}                     filePath    The file the session belongs to
   * @param   {string}                     sessionId   The session
   * @param   {RecoveryJournalResolution}  resolution  How the session was settled
   *
   * @return  {Promise<RecoveryJournalResolveResult>}  Whether a session was
   *                                                   moved, and the recovery copy
   *
   * @throws  {Error}                                  If the session is still
   *                                                   being written, or a file
   *                                                   operation failed
   */
  public async resolve (filePath: string, sessionId: string, resolution: RecoveryJournalResolution): Promise<RecoveryJournalResolveResult> {
    const fileName = this.sessionFileName(filePath, sessionId)
    if (!RESOLUTIONS.includes(resolution)) {
      throw new Error(`Invalid recovery journal resolution: ${String(resolution)}`)
    }

    return await this._enqueue<RecoveryJournalResolveResult>(fileName, async () => {
      try {
        const source = path.join(this.sessionsDirectory, fileName)
        let contents: string
        try {
          contents = await fs.readFile(source, 'utf8')
        } catch (err) {
          if (isMissingFileError(err)) {
            return { resolved: false }
          }
          throw err
        }

        const session = parseRecoverySession(contents)
        if (session.end === undefined && this._options.isSessionLive(sessionId, filePath)) {
          throw new Error('The session is still being written')
        }

        let copyPath: string|undefined
        if (resolution === 'kept-as-file') {
          if (session.header === undefined) {
            throw new Error('The session has no header, so its text cannot be rebuilt')
          }
          const rebuilt = rebuildRecoveryText(session)
          // A damaged session yields an incomplete text, which must not
          // replace an emergency copy of the full text
          copyPath = await this._writeCopy(filePath, sessionId, rebuilt.text, rebuilt.damaged)
        }

        await this._ensureDirectories()
        const target = path.join(this.resolvedDirectory, fileName)
        await fs.rename(source, target)
        // The modification time records when the session was resolved; the
        // retention period of resolved sessions counts from it
        const resolvedAt = new Date(this._options.now())
        await fs.utimes(target, resolvedAt, resolvedAt)
        this._copyPaths.delete(sessionId)
        this._logger.info(`[Recovery Journal] Session ${sessionId} of ${filePath} resolved as ${resolution}${copyPath === undefined ? '' : `; recovery copy: ${copyPath}`}`)
        return copyPath === undefined ? { resolved: true } : { resolved: true, copyPath }
      } catch (err) {
        this._logger.error(`[Recovery Journal] Could not resolve session ${sessionId} of ${filePath} as ${resolution}: ${errorMessage(err)}`, err)
        throw err
      }
    })
  }

  /**
   * Writes a full text as the recovery copy of a session. The same session
   * always writes the same file.
   *
   * @param   {string}  filePath   The file the session belongs to
   * @param   {string}  sessionId  The session
   * @param   {string}  text       The full text
   * @param   {string}  reason     Why the text is preserved; goes to the log
   *
   * @return  {Promise<RecoveryJournalPreserveResult>}  The recovery copy
   *
   * @throws  {Error}              If the copy could not be written; the failure
   *                               is also logged
   */
  public async preserveText (filePath: string, sessionId: string, text: string, reason: string): Promise<RecoveryJournalPreserveResult> {
    try {
      this.sessionFileName(filePath, sessionId) // Validates both
      if (typeof text !== 'string') {
        throw new Error('The text to preserve must be a string')
      }
      const copyPath = await this._writeCopy(filePath, sessionId, text, false)
      this._logger.info(`[Recovery Journal] Preserved the text of session ${sessionId} of ${filePath} (${String(reason)}): ${copyPath}`)
      return { copyPath }
    } catch (err) {
      this._logger.error(`[Recovery Journal] Could not preserve the text of session ${String(sessionId)} of ${String(filePath)}: ${errorMessage(err)}`, err)
      throw err
    }
  }

  /**
   * Removes expired files: sessions that ended without unconfirmed steps at
   * least CLEAN_SESSION_RETENTION_HOURS ago, and resolved sessions that were
   * resolved at least RESOLVED_RETENTION_DAYS ago. Recoverable sessions that
   * have not been resolved and recovery copies are never removed here.
   *
   * @return  {Promise<RecoveryJournalCleanupResult>}  How many files were removed
   */
  public async cleanup (): Promise<RecoveryJournalCleanupResult> {
    const now = this._options.now()
    const result: RecoveryJournalCleanupResult = { removedCleanSessions: 0, removedResolvedSessions: 0 }

    for (const fileName of await this._listSessionFiles(this.sessionsDirectory)) {
      try {
        await this._enqueue(fileName, async () => {
          const absolutePath = path.join(this.sessionsDirectory, fileName)
          const session = parseRecoverySession(await fs.readFile(absolutePath, 'utf8'))
          const endedCleanly = session.header !== undefined && !session.malformed &&
            session.end !== undefined && session.end.unconfirmedSteps === 0
          if (endedCleanly && session.end !== undefined && now - session.end.time >= CLEAN_SESSION_RETENTION_MS) {
            await fs.unlink(absolutePath)
            result.removedCleanSessions++
          }
        })
      } catch (err) {
        if (!isMissingFileError(err)) {
          this._logger.error(`[Recovery Journal] Could not clean up session file ${fileName}: ${errorMessage(err)}`, err)
        }
      }
    }

    for (const fileName of await this._listSessionFiles(this.resolvedDirectory)) {
      try {
        const absolutePath = path.join(this.resolvedDirectory, fileName)
        const stat = await fs.stat(absolutePath)
        if (now - stat.mtimeMs >= RESOLVED_RETENTION_MS) {
          await fs.unlink(absolutePath)
          result.removedResolvedSessions++
        }
      } catch (err) {
        if (!isMissingFileError(err)) {
          this._logger.error(`[Recovery Journal] Could not clean up resolved session file ${fileName}: ${errorMessage(err)}`, err)
        }
      }
    }

    if (result.removedCleanSessions > 0 || result.removedResolvedSessions > 0) {
      this._logger.info(`[Recovery Journal] Removed ${result.removedCleanSessions} cleanly ended session file(s) and ${result.removedResolvedSessions} resolved session file(s)`)
    }
    return result
  }

  /**
   * Resolves once every operation that has been started so far has finished.
   */
  public async idle (): Promise<void> {
    await Promise.all([...this._operationQueues.values()])
  }

  /**
   * Turns records into the lines of a session file.
   *
   * @param   {string}                   sessionId  The session the records must belong to
   * @param   {RecoveryJournalRecord[]}  records    The records
   *
   * @return  {string}                              One JSON document per line
   */
  private _serializeRecords (sessionId: string, records: RecoveryJournalRecord[]): string {
    if (!Array.isArray(records)) {
      throw new Error('The records must be an array')
    }

    let lines = ''
    for (const record of records) {
      if (!isRecoveryJournalRecord(record)) {
        throw new Error('A record does not have the format of the recovery journal')
      }
      if (record.type === 'session' && record.sessionId !== sessionId) {
        throw new Error('The session header belongs to another session')
      }
      lines += JSON.stringify(record) + '\n'
    }
    return lines
  }

  /**
   * Runs an operation after every earlier operation with the same key.
   *
   * @param   {string}            key        The session file name or copy folder
   * @param   {() => Promise<T>}  operation  The operation
   *
   * @return  {Promise<T>}                   What the operation returns
   */
  private async _enqueue<T> (key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this._operationQueues.get(key) ?? Promise.resolve()
    const outcome = previous.then(operation)
    const tail = outcome.then(() => undefined, () => undefined)
    this._operationQueues.set(key, tail)
    void tail.then(() => {
      if (this._operationQueues.get(key) === tail) {
        this._operationQueues.delete(key)
      }
    })
    return await outcome
  }

  private async _ensureDirectories (): Promise<void> {
    if (this._directoriesReady === undefined) {
      const creation = (async () => {
        await fs.mkdir(this.sessionsDirectory, { recursive: true })
        await fs.mkdir(this.copiesDirectory, { recursive: true })
        await fs.mkdir(this.resolvedDirectory, { recursive: true })
      })()
      this._directoriesReady = creation
      creation.catch(() => {
        if (this._directoriesReady === creation) {
          this._directoriesReady = undefined
        }
      })
    }
    await this._directoriesReady
  }

  /**
   * Lists the session files of a folder.
   *
   * @param   {string}             directory  The sessions or the resolved folder
   * @param   {string|undefined}   pathKey    Only the sessions of this path key
   *
   * @return  {Promise<string[]>}             The file names
   */
  private async _listSessionFiles (directory: string, pathKey?: string): Promise<string[]> {
    let names: string[]
    try {
      names = await fs.readdir(directory)
    } catch (err) {
      if (isMissingFileError(err)) {
        return []
      }
      throw err
    }

    return names.filter(name => {
      const match = SESSION_FILE_PATTERN.exec(name)
      return match !== null && (pathKey === undefined || match[1] === pathKey)
    })
  }

  /**
   * Reads the session files and returns the recoverable sessions: those with
   * at least one local step that either ended with unconfirmed steps, or have
   * no end record, are not live, and contain at least one local step after
   * the last confirmed one. A session without an end record whose local steps
   * were all confirmed (its page went away before it could write the end
   * record) is not recoverable.
   *
   * @param   {string|undefined}  pathKey  Only the sessions of this path key
   *
   * @return  {Promise<RecoverableSession[]>}  The sessions, the newest first
   */
  private async _collectRecoverable (pathKey: string|undefined): Promise<RecoverableSession[]> {
    // Records that are being written right now belong to the answer
    await this.idle()

    const recoverable: RecoverableSession[] = []
    for (const fileName of await this._listSessionFiles(this.sessionsDirectory, pathKey)) {
      const sessionId = SESSION_FILE_PATTERN.exec(fileName)?.[2] ?? ''
      let session: ParsedRecoverySession
      try {
        session = parseRecoverySession(await fs.readFile(path.join(this.sessionsDirectory, fileName), 'utf8'))
      } catch (err) {
        if (!isMissingFileError(err)) {
          this._logger.error(`[Recovery Journal] Could not read session file ${fileName}: ${errorMessage(err)}`, err)
        }
        continue
      }

      const header = session.header
      if (header === undefined) {
        if (!this._reportedUnreadableFiles.has(fileName)) {
          this._reportedUnreadableFiles.add(fileName)
          this._logger.error(`[Recovery Journal] Session file ${fileName} has no usable header; it is kept, but cannot be offered for recovery`)
        }
        continue
      }

      const localSteps = session.steps.filter(step => !step.remote)
      if (localSteps.length === 0) {
        continue
      }

      let unconfirmedSteps: number
      if (session.end !== undefined) {
        unconfirmedSteps = session.end.unconfirmedSteps
      } else {
        if (this._options.isSessionLive(sessionId, header.filePath)) {
          continue
        }
        unconfirmedSteps = localSteps.filter(step => step.sequence > session.confirmedThrough).length
      }

      // Every local step was confirmed, whether the session could still write
      // its end record or not: there is nothing to recover
      if (unconfirmedSteps === 0) {
        continue
      }

      const rebuilt = rebuildRecoveryText(session)
      recoverable.push({
        sessionId,
        filePath: header.filePath,
        startedAt: header.startedAt,
        lastStepAt: localSteps[localSteps.length - 1].time,
        unconfirmedSteps,
        damaged: rebuilt.damaged,
        finalText: rebuilt.text
      })
    }

    return recoverable.sort((first, second) => second.lastStepAt - first.lastStepAt)
  }

  /**
   * Writes the recovery copy of a session into the subfolder of the path key.
   * The copy of a session keeps its file during the whole run of the main
   * process. The text first goes into a temporary file, so a failed write
   * cannot destroy an earlier copy.
   *
   * @param   {string}   filePath    The original file
   * @param   {string}   sessionId   The session
   * @param   {string}   text        The text to write
   * @param   {boolean}  useNewFile  Write a separate file if the session already has a copy
   *
   * @return  {Promise<string>}      The absolute path of the copy
   */
  private async _writeCopy (filePath: string, sessionId: string, text: string, useNewFile: boolean): Promise<string> {
    const directory = path.join(this.copiesDirectory, recoveryPathKey(filePath, this._platform))
    return await this._enqueue(`copies:${directory}`, async () => {
      await fs.mkdir(directory, { recursive: true })

      const existing = this._copyPaths.get(sessionId)
      let copyPath = existing
      if (copyPath === undefined || useNewFile) {
        copyPath = await this._unusedCopyPath(directory, filePath)
        if (existing === undefined) {
          this._copyPaths.set(sessionId, copyPath)
        }
      }

      const temporaryPath = `${copyPath}.tmp`
      const handle = await fs.open(temporaryPath, 'w')
      try {
        await handle.writeFile(text, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await fs.rename(temporaryPath, copyPath)
      return copyPath
    })
  }

  /**
   * Finds a recovery copy name that no other session uses. If the name for the
   * current second is taken, the next second is tried.
   *
   * @param   {string}  directory  The subfolder of the path key
   * @param   {string}  filePath   The original file
   *
   * @return  {Promise<string>}    The absolute path of the copy
   */
  private async _unusedCopyPath (directory: string, filePath: string): Promise<string> {
    const assigned = new Set(this._copyPaths.values())
    let timestamp = this._options.now()
    for (;;) {
      const candidate = path.join(directory, recoveryCopyFileName(filePath, timestamp))
      if (!assigned.has(candidate) && !await this._exists(candidate)) {
        return candidate
      }
      timestamp += 1000
    }
  }

  private async _exists (absolutePath: string): Promise<boolean> {
    try {
      await fs.access(absolutePath)
      return true
    } catch (err) {
      return false
    }
  }
}
