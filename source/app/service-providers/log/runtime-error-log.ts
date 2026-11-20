/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        RuntimeErrorLog, computeSignature, formatRuntimeErrorLogLine
 * CVM-Role:        Utility
 * License:         GNU GPL v3
 *
 * Description:     The dedicated runtime error log. Every unhandled runtime
 *                  error becomes one JSON line in
 *                  <userData>/runtime-errors/runtime-errors.jsonl, with a
 *                  signature that stays the same when only numbers, line and
 *                  column change. Two limits keep one fault from flooding the
 *                  file: at most 50 lines per signature and run, and no
 *                  writes while the file is larger than 5 MB. This module
 *                  does not depend on Electron so that it can be tested.
 *
 * END HEADER
 */

import path from 'path'
import fs from 'fs'
import { createHash } from 'crypto'

export type RuntimeErrorKind = 'error' | 'unhandledrejection' | 'uncaughtException' | 'render-process-gone' | 'suppressed'

/** What a caller reports; time, signature and all truncation are filled in by RuntimeErrorLog */
export interface RuntimeErrorLogInput {
  process: 'renderer' | 'main'
  window: string            // window title; 'main' for main-process errors; 'Unknown window' if unknown
  kind: Exclude<RuntimeErrorKind, 'suppressed'>
  message: string           // raw, untruncated
  location?: string         // raw, may still be a full URL such as http://localhost:3000/main_window/index.js:144789:16
  stack?: string            // raw, untruncated
}

/** One line of runtime-errors.jsonl */
export interface RuntimeErrorLogEntry {
  time: string              // local ISO 8601 with milliseconds and offset, e.g. 2026-10-14T11:20:28.123+08:00
  process: 'renderer' | 'main'
  window: string
  kind: RuntimeErrorKind
  message: string           // at most 1000 characters
  location?: string         // file name plus line and column only, e.g. index.js:144789:16
  stack?: string            // at most 4000 characters
  signature: string         // 12 lowercase hexadecimal characters
}

/**
 * Everything RuntimeErrorLog touches outside itself. All members are
 * optional; the defaults use the synchronous Node fs functions and new Date().
 */
export interface RuntimeErrorLogOptions {
  /** Appends text to a file, creating the file if necessary */
  appendFile?: (filePath: string, text: string) => void
  /** Returns the size of a file in bytes, or 0 if the file does not exist */
  getFileSize?: (filePath: string) => number
  /** Creates a directory including all missing parents; must not fail if it exists */
  makeDirectory?: (directoryPath: string) => void
  /** Returns the current time */
  now?: () => Date
  /** Receives every problem of the log itself (full file, failed write) */
  warn?: (message: string, error?: unknown) => void
}

export const RUNTIME_ERROR_LOG_DIRECTORY = 'runtime-errors'
export const RUNTIME_ERROR_LOG_FILE_NAME = 'runtime-errors.jsonl'
export const MAXIMUM_MESSAGE_LENGTH = 1000
export const MAXIMUM_STACK_LENGTH = 4000
export const MAXIMUM_LINES_PER_SIGNATURE = 50
export const MAXIMUM_FILE_SIZE_BYTES = 5 * 1024 * 1024
export const SUPPRESSED_MESSAGE = 'Further occurrences of this error in this run are not recorded.'

const ELLIPSIS = '…'

/**
 * Shortens text to at most maximumLength characters; shortened text ends with
 * an ellipsis and is then exactly maximumLength characters long.
 */
function truncate (text: string, maximumLength: number): string {
  if (text.length <= maximumLength) {
    return text
  }
  return text.slice(0, maximumLength - ELLIPSIS.length) + ELLIPSIS
}

/**
 * Formats a date as local ISO 8601 with milliseconds and offset,
 * e.g. 2026-10-14T11:20:28.123+08:00.
 */
export function formatLocalTimestamp (date: Date): string {
  const pad = (value: number, length: number = 2): string => String(value).padStart(length, '0')
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absoluteOffset = Math.abs(offsetMinutes)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`
}

/**
 * Reduces a location to the file name plus line and column, dropping the
 * development server URL or the directory. Returns undefined for an empty or
 * missing location.
 */
export function shortenLocation (location?: string): string | undefined {
  if (location === undefined) {
    return undefined
  }
  const trimmed = location.trim()
  const lastSeparator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  const shortened = trimmed.slice(lastSeparator + 1)
  return shortened === '' ? undefined : shortened
}

/**
 * Returns the function name of the first frame of a stack trace, or an empty
 * string if there is no stack, no recognisable frame, or the first frame has
 * no function name. Understands V8 frames ("at name (url:line:col)",
 * "at url:line:col") and Firefox frames ("name@url:line:col").
 */
export function getFirstFrameFunctionName (stack?: string): string {
  if (stack === undefined) {
    return ''
  }
  const lines = stack.split(/\r?\n/).map(line => line.trim())

  const v8Frame = lines.find(line => line.startsWith('at '))
  if (v8Frame !== undefined) {
    const frame = v8Frame.slice(3).trim()
    // "name (location)" has a function name; a bare "location" has none
    const match = /^(.+?) \((.*)\)$/.exec(frame)
    if (match === null) {
      return ''
    }
    return match[1].replace(/^async /, '').trim()
  }

  for (const line of lines) {
    const match = /^([^@]*)@(.+):\d+:\d+$/.exec(line)
    if (match !== null) {
      return match[1].trim()
    }
  }

  return ''
}

/**
 * Computes the 12-hex-character signature of an error: the SHA-1 of kind,
 * the message with every run of digits replaced by N, and the function name
 * of the first stack frame, joined by "|". Use the untruncated message.
 */
export function computeSignature (kind: string, message: string, stack?: string): string {
  const normalisedMessage = message.replace(/\d+/g, 'N')
  const functionName = getFirstFrameFunctionName(stack)
  return createHash('sha1')
    .update(`${kind}|${normalisedMessage}|${functionName}`, 'utf8')
    .digest('hex')
    .slice(0, 12)
}

/**
 * Turns an entry into one JSON line without a trailing newline. The field
 * order is fixed; optional fields that are missing are left out.
 */
export function formatRuntimeErrorLogLine (entry: RuntimeErrorLogEntry): string {
  const ordered: Record<string, string> = {
    time: entry.time,
    process: entry.process,
    window: entry.window,
    kind: entry.kind,
    message: entry.message
  }
  if (entry.location !== undefined) {
    ordered.location = entry.location
  }
  if (entry.stack !== undefined) {
    ordered.stack = entry.stack
  }
  ordered.signature = entry.signature
  return JSON.stringify(ordered)
}

function defaultGetFileSize (filePath: string): number {
  const stats = fs.statSync(filePath, { throwIfNoEntry: false })
  return stats === undefined ? 0 : stats.size
}

/**
 * Writes runtime errors to <userData>/runtime-errors/runtime-errors.jsonl.
 * One instance corresponds to one run of the program: the per-signature
 * limit counts within the instance.
 */
export class RuntimeErrorLog {
  private readonly _directoryPath: string
  private readonly _filePath: string
  private readonly _appendFile: (filePath: string, text: string) => void
  private readonly _getFileSize: (filePath: string) => number
  private readonly _makeDirectory: (directoryPath: string) => void
  private readonly _now: () => Date
  private readonly _warn: (message: string, error?: unknown) => void
  /** How often each signature has been recorded in this run */
  private readonly _occurrences: Map<string, number>
  private _fileSizeWarningGiven: boolean

  constructor (userDataPath: string, options: RuntimeErrorLogOptions = {}) {
    this._directoryPath = path.join(userDataPath, RUNTIME_ERROR_LOG_DIRECTORY)
    this._filePath = path.join(this._directoryPath, RUNTIME_ERROR_LOG_FILE_NAME)
    this._appendFile = options.appendFile ?? ((filePath, text) => { fs.appendFileSync(filePath, text, { encoding: 'utf8' }) })
    this._getFileSize = options.getFileSize ?? defaultGetFileSize
    this._makeDirectory = options.makeDirectory ?? ((directoryPath) => { fs.mkdirSync(directoryPath, { recursive: true }) })
    this._now = options.now ?? (() => new Date())
    this._warn = options.warn ?? (() => {})
    this._occurrences = new Map()
    this._fileSizeWarningGiven = false
  }

  /**
   * Returns the full path of the runtime error log file.
   */
  public getFilePath (): string {
    return this._filePath
  }

  /**
   * Records one runtime error. Never throws: every problem goes to the
   * warning callback instead.
   */
  public record (input: RuntimeErrorLogInput): void {
    try {
      const signature = computeSignature(input.kind, input.message, input.stack)
      const occurrence = (this._occurrences.get(signature) ?? 0) + 1
      this._occurrences.set(signature, occurrence)

      let entry: RuntimeErrorLogEntry
      if (occurrence <= MAXIMUM_LINES_PER_SIGNATURE) {
        entry = {
          time: formatLocalTimestamp(this._now()),
          process: input.process,
          window: input.window,
          kind: input.kind,
          message: truncate(input.message, MAXIMUM_MESSAGE_LENGTH),
          signature
        }
        const location = shortenLocation(input.location)
        if (location !== undefined) {
          entry.location = location
        }
        if (input.stack !== undefined) {
          entry.stack = truncate(input.stack, MAXIMUM_STACK_LENGTH)
        }
      } else if (occurrence === MAXIMUM_LINES_PER_SIGNATURE + 1) {
        entry = {
          time: formatLocalTimestamp(this._now()),
          process: input.process,
          window: input.window,
          kind: 'suppressed',
          message: SUPPRESSED_MESSAGE,
          signature
        }
      } else {
        return // This signature is no longer recorded in this run
      }

      this._write(formatRuntimeErrorLogLine(entry) + '\n')
    } catch (error) {
      this._safeWarn(`Could not record a runtime error: ${describeError(error)}`, error)
    }
  }

  /**
   * Appends one line unless the file is over the size limit.
   */
  private _write (line: string): void {
    this._makeDirectory(this._directoryPath)
    const size = this._getFileSize(this._filePath)
    if (size > MAXIMUM_FILE_SIZE_BYTES) {
      if (!this._fileSizeWarningGiven) {
        this._fileSizeWarningGiven = true
        this._safeWarn(`The runtime error log ${this._filePath} is larger than 5 MB; runtime errors are not recorded there until it is archived or shortened.`)
      }
      return
    }
    this._appendFile(this._filePath, line)
  }

  /**
   * Calls the warning callback, swallowing anything it throws.
   */
  private _safeWarn (message: string, error?: unknown): void {
    try {
      this._warn(message, error)
    } catch {
      // The warning callback must never make record() throw
    }
  }
}

function describeError (error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}
