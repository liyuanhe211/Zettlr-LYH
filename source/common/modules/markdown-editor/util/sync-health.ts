/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Synchronization health registry
 * CVM-Role:        Utility
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH data loss prevention (R173, specification C21
 *                  section 7): records per file whether the input of its
 *                  editors reaches the main process. The same file can be open
 *                  in two editors at once, and the code that reloads a document
 *                  reports failures as well, so every report is stored per file
 *                  path and reporter. Towards the outside the reports of one
 *                  file are combined: the file is stalled as soon as one
 *                  reporter is stalled. This module does not depend on Vue;
 *                  whoever wants to display the health subscribes to it.
 *
 * END HEADER
 */

/** The reason that the recovery journal plugin reports: local modifications stay unconfirmed */
export const SYNC_STALL_REASON_UNCONFIRMED_CHANGES = 'unconfirmed-changes'
/** The reason for the code that reloads a document to report: the document could not be fetched */
export const SYNC_STALL_REASON_DOCUMENT_FETCH_FAILED = 'document-fetch-failed'
/** The second reason that the recovery journal plugin reports: its records keep failing to be written to disk */
export const SYNC_STALL_REASON_JOURNAL_WRITE_FAILED = 'journal-write-failed'

export interface SynchronizedHealth {
  status: 'synchronized'
}

export interface StalledHealth {
  status: 'stalled'
  /** For how many milliseconds the input had been stalled when the report was made */
  stalledForMs: number
  /** When the stall began, in milliseconds since the epoch; lets a display count on without new reports */
  stalledSince: number
  /** Why the input is stalled */
  reason: string
}

export type SyncHealth = SynchronizedHealth|StalledHealth

export type SyncHealthListener = (filePath: string, health: SyncHealth) => void

export const SYNCHRONIZED_HEALTH: SynchronizedHealth = Object.freeze({ status: 'synchronized' as const })

/** File path -> reporter -> the stalled report of that reporter. Synchronized reporters are not stored. */
const stalledReports = new Map<string, Map<string, StalledHealth>>()
const listeners = new Set<SyncHealthListener>()

function isSameHealth (first: SyncHealth, second: SyncHealth): boolean {
  if (first.status === 'synchronized' || second.status === 'synchronized') {
    return first.status === second.status
  }

  return first.stalledForMs === second.stalledForMs && first.stalledSince === second.stalledSince &&
    first.reason === second.reason
}

/**
 * Returns the combined health of a file: stalled if at least one reporter is
 * stalled (the report of the reporter that has been stalled the longest),
 * otherwise synchronized.
 *
 * @param   {string}      filePath  The absolute path of the file
 *
 * @return  {SyncHealth}            The health
 */
export function getSyncHealth (filePath: string): SyncHealth {
  const reports = stalledReports.get(filePath)
  if (reports === undefined) {
    return SYNCHRONIZED_HEALTH
  }

  let longest: StalledHealth|undefined
  for (const report of reports.values()) {
    if (longest === undefined || report.stalledSince < longest.stalledSince) {
      longest = report
    }
  }

  return longest ?? SYNCHRONIZED_HEALTH
}

/**
 * Returns every file that is stalled at the moment, with its combined health.
 *
 * @return  {Array<{ filePath: string, health: StalledHealth }>}  The stalled files
 */
export function getStalledFiles (): Array<{ filePath: string, health: StalledHealth }> {
  const stalled: Array<{ filePath: string, health: StalledHealth }> = []
  for (const filePath of stalledReports.keys()) {
    const health = getSyncHealth(filePath)
    if (health.status === 'stalled') {
      stalled.push({ filePath, health })
    }
  }
  return stalled
}

/**
 * Stores the health that one reporter observes for a file. The listeners are
 * called if the combined health of the file changes. A listener that throws
 * does not keep the other listeners from being called.
 *
 * @param  {string}      filePath    The absolute path of the file
 * @param  {string}      reporterId  Who reports; unique among the reporters of
 *                                   the file (the recovery journal plugin uses
 *                                   its session ID)
 * @param  {SyncHealth}  health      What the reporter observes
 */
export function reportSyncHealth (filePath: string, reporterId: string, health: SyncHealth): void {
  const before = getSyncHealth(filePath)

  let reports = stalledReports.get(filePath)
  if (health.status === 'stalled') {
    if (reports === undefined) {
      reports = new Map()
      stalledReports.set(filePath, reports)
    }
    reports.set(reporterId, { ...health })
  } else if (reports !== undefined) {
    reports.delete(reporterId)
    if (reports.size === 0) {
      stalledReports.delete(filePath)
    }
  }

  const after = getSyncHealth(filePath)
  if (isSameHealth(before, after)) {
    return
  }

  for (const listener of [...listeners]) {
    try {
      listener(filePath, after)
    } catch (err) {
      console.error(`A synchronization health listener failed for ${filePath}`, err)
    }
  }
}

/**
 * Removes the report of a reporter that ceases to exist (an editor that is
 * destroyed, a reload that succeeded). Same as reporting `synchronized`.
 *
 * @param  {string}  filePath    The absolute path of the file
 * @param  {string}  reporterId  The reporter
 */
export function clearSyncHealthReporter (filePath: string, reporterId: string): void {
  reportSyncHealth(filePath, reporterId, SYNCHRONIZED_HEALTH)
}

/**
 * Calls the listener whenever the combined health of any file changes.
 *
 * @param   {SyncHealthListener}  listener  Receives the file path and its new health
 *
 * @return  {() => void}                    Call this to stop listening; whoever
 *                                          subscribes must call it when it is
 *                                          unmounted, destroyed, or replaced by
 *                                          a hot module update
 */
export function subscribeSyncHealth (listener: SyncHealthListener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
