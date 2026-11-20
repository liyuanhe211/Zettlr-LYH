/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        DataSafetyIncidentReporter
 * CVM-Role:        Utility
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH data loss prevention (R173, specification C21
 *                  section 7 item 3): a data safety incident is a failure the
 *                  main process notices that leaves content or editing history
 *                  only in memory. This module limits how often the same
 *                  incident is reported, writes each one to the log and
 *                  broadcasts it to the main windows. The broadcast function,
 *                  the log and the clock are passed in by the caller, so this
 *                  module must not import Electron.
 *
 * END HEADER
 */

/** The least time between two rejection warnings (and incidents) for the same file and reason, in milliseconds */
export const PUSH_REJECTION_LOG_INTERVAL_MS = 10000

/** The least time between two undo history incidents for the same file, in milliseconds */
export const UNDO_FAILURE_INCIDENT_INTERVAL_MS = 60000

/** The channel on which the incidents are broadcast to the windows */
export const DATA_SAFETY_INCIDENT_CHANNEL = 'data-safety-incident'

export type DataSafetyIncidentKind = 'push-rejected'|'save-failed'|'undo-history-failed'|'delivery-timeout'

/** Why the document manager rejected updates an editor pushed */
export type PushRejectionReason = 'version-mismatch'|'document-missing'|'comparison-version-out-of-range'

/** The payload that is broadcast on the incident channel */
export interface DataSafetyIncident {
  kind: DataSafetyIncidentKind
  /** The file the incident is about, if it is about one */
  filePath?: string
  /** One English sentence for the user */
  message: string
  /** When the incident happened (milliseconds timestamp) */
  time: number
}

/** The part of the log provider this module needs */
export interface DataSafetyIncidentLog {
  info: (message: string, details?: unknown) => void
  warning: (message: string, details?: unknown) => void
  error: (message: string, details?: unknown) => void
}

export interface DataSafetyIncidentReporterOptions {
  /** Sends an incident to all windows */
  broadcast: (channel: string, incident: DataSafetyIncident) => void
  log: DataSafetyIncidentLog
  /** The clock; defaults to Date.now */
  now?: () => number
}

/**
 * The two messages of the undo history store that mean history was lost. The
 * store has a single log function without levels, so the failures have to be
 * recognized by their text (undo-history-store.ts, `logError` calls in the
 * record writer and in `recordUpdate`).
 */
const UNDO_STORE_WRITE_FAILURE_PREFIX = 'Could not write the undo history of '
const UNDO_STORE_UNFIT_UPDATE_PREFIX = 'An update does not fit the document '
const UNDO_STORE_UNFIT_UPDATE_SUFFIX = '; it is not recorded'

/**
 * Describes a thrown value in a few words.
 *
 * @param   {unknown}  error  The value that was thrown
 *
 * @return  {string}          The description
 */
function describeError (error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

export class DataSafetyIncidentReporter {
  private readonly broadcast: (channel: string, incident: DataSafetyIncident) => void
  private readonly log: DataSafetyIncidentLog
  private readonly now: () => number
  /** Key (file path and reason), then the time of the last report */
  private readonly lastPushRejection = new Map<string, number>()
  /** File path, then the time of the last report */
  private readonly lastUndoHistoryFailure = new Map<string, number>()

  constructor (options: DataSafetyIncidentReporterOptions) {
    this.broadcast = options.broadcast
    this.log = options.log
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * Reports that the document manager rejected updates an editor pushed. Per
   * file and reason, at most one warning is logged and one incident broadcast
   * within PUSH_REJECTION_LOG_INTERVAL_MS.
   *
   * @param   {string}                         filePath        The file
   * @param   {PushRejectionReason|undefined}  reason          Why the updates were rejected, if known
   * @param   {number}                         clientVersion   The version the editor sent
   * @param   {number|undefined}               currentVersion  The version of the document manager, if the document is loaded
   *
   * @return  {boolean}                                        Whether this call produced a log line and an incident
   */
  public reportPushRejected (filePath: string, reason: PushRejectionReason|undefined, clientVersion: number, currentVersion: number|undefined): boolean {
    const reasonText = reason ?? 'no reason given'
    if (!this.passesRateLimit(this.lastPushRejection, `${filePath}\u0000${reasonText}`, PUSH_REJECTION_LOG_INTERVAL_MS)) {
      return false
    }

    const versionText = currentVersion === undefined ? 'none (the document is not loaded)' : String(currentVersion)
    this.log.warning(`[Document Manager] Rejected updates for file ${filePath}: ${reasonText} (editor version ${String(clientVersion)}, document manager version ${versionText}).`)
    this.emit({
      kind: 'push-rejected',
      filePath,
      message: `The document store rejected input from an editor (${reasonText}).`,
      time: this.now()
    })
    return true
  }

  /**
   * Reports that writing a file to disk failed.
   *
   * @param  {string}   filePath  The file
   * @param  {unknown}  error     What the write threw
   */
  public reportSaveFailed (filePath: string, error: unknown): void {
    const description = describeError(error)
    this.log.error(`[Document Manager] Saving ${filePath} failed: ${description}. The document is still marked as modified.`, error)
    this.emit({
      kind: 'save-failed',
      filePath,
      message: `Saving failed: ${description}. The document is still marked as modified.`,
      time: this.now()
    })
  }

  /**
   * Reports that a step could not be recorded in the undo history. Per file,
   * at most one incident is produced within UNDO_FAILURE_INCIDENT_INTERVAL_MS.
   *
   * @param   {string|undefined}  filePath  The file, if known
   * @param   {unknown}           error     What went wrong
   *
   * @return  {boolean}                     Whether this call produced an incident
   */
  public reportUndoHistoryFailed (filePath: string|undefined, error: unknown): boolean {
    if (!this.passesRateLimit(this.lastUndoHistoryFailure, filePath ?? '', UNDO_FAILURE_INCIDENT_INTERVAL_MS)) {
      return false
    }

    const description = describeError(error)
    const subject = filePath === undefined ? 'a document' : filePath
    this.log.error(`[Document Manager] The undo history of ${subject} could not be recorded: ${description}.`, error)
    const incident: DataSafetyIncident = {
      kind: 'undo-history-failed',
      message: `The undo history could not be recorded: ${description}.`,
      time: this.now()
    }
    if (filePath !== undefined) {
      incident.filePath = filePath
    }
    this.emit(incident)
    return true
  }

  /**
   * Looks at a message the undo history store wrote to its log function and
   * reports an undo history incident if the message means that history was
   * lost. Other messages (fallbacks, cleanup, size warnings) are ignored.
   *
   * @param   {string}   message  The message of the store
   *
   * @return  {boolean}           Whether this call produced an incident
   */
  public reportUndoHistoryStoreMessage (message: string): boolean {
    if (typeof message !== 'string') {
      return false
    }

    if (message.startsWith(UNDO_STORE_WRITE_FAILURE_PREFIX)) {
      // "Could not write the undo history of <path>: <error>"
      const rest = message.slice(UNDO_STORE_WRITE_FAILURE_PREFIX.length)
      const separator = rest.indexOf(': ')
      const filePath = separator < 0 ? rest : rest.slice(0, separator)
      const description = separator < 0 ? 'the record could not be written' : rest.slice(separator + 2)
      return this.reportUndoHistoryFailed(filePath === '' ? undefined : filePath, description)
    }

    if (message.startsWith(UNDO_STORE_UNFIT_UPDATE_PREFIX)) {
      // "An update does not fit the document <path>; it is not recorded: <error>"
      const rest = message.slice(UNDO_STORE_UNFIT_UPDATE_PREFIX.length)
      const end = rest.indexOf(UNDO_STORE_UNFIT_UPDATE_SUFFIX)
      if (end < 0) {
        return false
      }
      const filePath = rest.slice(0, end)
      const tail = rest.slice(end + UNDO_STORE_UNFIT_UPDATE_SUFFIX.length)
      const description = tail.startsWith(': ') ? tail.slice(2) : 'an update does not fit the document'
      return this.reportUndoHistoryFailed(filePath === '' ? undefined : filePath, description)
    }

    return false
  }

  /**
   * Reports that input in an editor did not reach the document manager within
   * the time the document manager waited for it.
   *
   * @param  {string}  filePath  The file
   */
  public reportDeliveryTimeout (filePath: string): void {
    this.log.warning(`[Document Manager] Input in an editor for ${filePath} did not reach the document manager in time; continuing without it.`)
    this.emit({
      kind: 'delivery-timeout',
      filePath,
      message: 'Input in an editor did not reach the document store within 3 seconds.',
      time: this.now()
    })
  }

  /**
   * Checks a rate limit and, if the report may pass, remembers its time.
   *
   * @param   {Map<string, number>}  lastReports  The times of the last reports
   * @param   {string}               key          What the limit applies to
   * @param   {number}               interval     The least time between two reports
   *
   * @return  {boolean}                           Whether the report may pass
   */
  private passesRateLimit (lastReports: Map<string, number>, key: string, interval: number): boolean {
    const now = this.now()
    const last = lastReports.get(key)
    if (last !== undefined && now - last < interval) {
      return false
    }

    // Forget what is too old to matter, so that the map does not grow with
    // every file that ever had a failure.
    for (const [ otherKey, time ] of lastReports) {
      if (now - time >= interval) {
        lastReports.delete(otherKey)
      }
    }

    lastReports.set(key, now)
    return true
  }

  private emit (incident: DataSafetyIncident): void {
    try {
      this.broadcast(DATA_SAFETY_INCIDENT_CHANNEL, incident)
    } catch (err) {
      // An incident that cannot be shown must not turn into a second failure
      // of the operation that reported it; it is in the log already.
      this.log.error(`[Document Manager] Could not broadcast a data safety incident (${incident.kind}): ${describeError(err)}`, err)
    }
  }
}
