/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        useDataSafetyStore
 * CVM-Role:        Model
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH data loss prevention (R173, specification C21
 *                  section 7 item 4): the data safety state of the main window.
 *                  It holds three things: the synchronization warnings of the
 *                  files whose input does not reach the main process (from the
 *                  synchronization health registry), the notices of the data
 *                  safety incidents the main process broadcasts, and the files
 *                  with recoverable sessions in the recovery journal that are
 *                  not open. The tab bar, the editor status bar and the banner
 *                  above the editor area display them.
 *
 * END HEADER
 */

import { defineStore, getActivePinia, type Pinia } from 'pinia'
import { computed, getCurrentScope, onScopeDispose, shallowRef } from 'vue'
import { trans } from '@common/i18n-renderer'
import { pathBasename } from '@common/util/renderer-path-polyfill'
import {
  getStalledFiles,
  subscribeSyncHealth,
  SYNC_STALL_REASON_DOCUMENT_FETCH_FAILED,
  SYNC_STALL_REASON_UNCONFIRMED_CHANGES,
  type StalledHealth,
  type SyncHealth
} from '@common/modules/markdown-editor/util/sync-health'
import { recoveryJournalIPCAPI } from '@common/modules/markdown-editor/util/recovery-journal-api'
import { DATA_SAFETY_INCIDENT_CHANNEL, type DataSafetyIncidentKind } from '@providers/documents/data-safety-incidents'
import type { RecoverableSessionSummary } from '@providers/recovery-journal/journal-store'

export const DATA_SAFETY_STORE_ID = 'data-safety'

/** The incident kinds that the banner shows. `push-rejected` only goes to the log; the stall warning makes it visible. */
export type DisplayedIncidentKind = Exclude<DataSafetyIncidentKind, 'push-rejected'>

const DISPLAYED_INCIDENT_KINDS: ReadonlySet<string> = new Set<DisplayedIncidentKind>([
  'save-failed',
  'undo-history-failed',
  'delivery-timeout'
])

/** The warning for a file whose input has not reached the main process for a while */
export interface SyncWarning {
  filePath: string
  /** For how many whole seconds (rounded down) the input has been stalled, as of the latest report */
  stalledSeconds: number
  /** When the stall began, in milliseconds since the epoch */
  stalledSince: number
  /** Why the input is stalled */
  reason: string
}

/** One line of the banner: a data safety incident, merged with its repetitions */
export interface DataSafetyNotice {
  /** Kind and file; incidents of the same kind for the same file share it */
  id: string
  kind: DisplayedIncidentKind
  filePath?: string
  /** The English sentence of the latest incident */
  message: string
  /** The time of the latest incident (milliseconds timestamp) */
  time: number
}

/** The part of window.ipc this store uses */
interface StoreIPC {
  on?: (channel: string, listener: (...args: any[]) => void) => unknown
  invoke?: (channel: string, ...args: unknown[]) => Promise<unknown>
}

/** When the stall of a file began and why; changes only when the file enters or leaves the stalled state */
interface StallStart {
  stalledSince: number
  reason: string
}

/**
 * The stall reason for a recovery journal that keeps failing to write to disk
 * (for instance on a full disk). Another work order adds the constant to
 * sync-health.ts; this module compares with its own copy of the string.
 */
const SYNC_STALL_REASON_JOURNAL_WRITE_FAILED = 'journal-write-failed'

/**
 * The tooltip of the tab of a stalled file (specification C21 section 7 item
 * 4). The sentence about the recovery journal is only true while the journal
 * can be written; if the journal itself fails, the text asks the user to save
 * or copy the content instead, and a reason this module does not know gets a
 * text that does not mention the journal.
 *
 * @param   {number}  stalledSeconds  Whole seconds of the stall
 * @param   {string}  reason          Why the input is stalled
 *
 * @return  {string}                  The text
 */
export function formatSyncWarningText (stalledSeconds: number, reason: string = SYNC_STALL_REASON_UNCONFIRMED_CHANGES): string {
  const seconds = String(stalledSeconds)
  if (reason === SYNC_STALL_REASON_UNCONFIRMED_CHANGES || reason === SYNC_STALL_REASON_DOCUMENT_FETCH_FAILED) {
    return trans('Input in this tab has not reached the document store for %s seconds. It is being kept in the recovery journal.', seconds)
  }

  if (reason === SYNC_STALL_REASON_JOURNAL_WRITE_FAILED) {
    return trans('Input in this tab has not reached the document store for %s seconds, and the latest input could not be written to the recovery journal. Save or copy the content as soon as possible.', seconds)
  }

  return trans('Input in this tab has not reached the document store for %s seconds.', seconds)
}

/**
 * The text of a notice in the banner: the file name in front of the message of
 * the incident. Incidents without a file show the message alone.
 *
 * @param   {DataSafetyNotice}  notice  The notice
 *
 * @return  {string}                    The text
 */
export function formatNoticeText (notice: Pick<DataSafetyNotice, 'filePath'|'message'>): string {
  if (notice.filePath === undefined || notice.filePath === '') {
    return notice.message
  }

  return `${pathBasename(notice.filePath)}: ${notice.message}`
}

/**
 * The text of the banner line about recoverable sessions of files that are not open.
 *
 * @param   {number}  fileCount  How many files
 *
 * @return  {string}             The text
 */
export function formatRecoverableFilesText (fileCount: number): string {
  return trans('Recovered input is available for %s files', String(fileCount))
}

/**
 * Checks that a broadcast payload is a data safety incident the banner shows.
 *
 * @param   {unknown}  payload  What arrived on the incident channel
 *
 * @return  {boolean}           Whether it is an incident of a displayed kind
 */
function isDisplayedIncident (payload: unknown): payload is { kind: DisplayedIncidentKind, filePath?: unknown, message: string, time?: unknown } {
  if (typeof payload !== 'object' || payload === null) {
    return false
  }

  const incident = payload as Record<string, unknown>
  return typeof incident.kind === 'string' && DISPLAYED_INCIDENT_KINDS.has(incident.kind) &&
    typeof incident.message === 'string'
}

// The return type is inferred: Pinia derives the type of the store from it
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function setupDataSafetyStore () {
  // ---------------------------------------------------------------------------
  // Synchronization warnings
  // ---------------------------------------------------------------------------

  // The reactive part changes only when a file enters or leaves the stalled
  // state (or a new stall begins). The registry reports a stalled file anew
  // every second; those reports only update the non-reactive map below, so
  // the tab bar is not drawn again every second.
  const stallStarts = shallowRef<ReadonlyMap<string, StallStart>>(new Map())
  const latestStalledHealth = new Map<string, StalledHealth>()

  function applySyncHealth (filePath: string, health: SyncHealth): void {
    const current = stallStarts.value.get(filePath)
    if (health.status === 'stalled') {
      latestStalledHealth.set(filePath, health)
      if (current !== undefined && current.stalledSince === health.stalledSince && current.reason === health.reason) {
        return
      }
      const next = new Map(stallStarts.value)
      next.set(filePath, { stalledSince: health.stalledSince, reason: health.reason })
      stallStarts.value = next
    } else {
      latestStalledHealth.delete(filePath)
      if (current === undefined) {
        return
      }
      const next = new Map(stallStarts.value)
      next.delete(filePath)
      stallStarts.value = next
    }
  }

  for (const { filePath, health } of getStalledFiles()) {
    applySyncHealth(filePath, health)
  }
  const stopSyncHealthSubscription = subscribeSyncHealth(applySyncHealth)

  /** The paths of the stalled files; changes only when a file enters or leaves the stalled state */
  const stalledFilePaths = computed<ReadonlySet<string>>(() => new Set(stallStarts.value.keys()))

  /**
   * Returns the warning of a file, or undefined if its input reaches the main
   * process. Reactive as to whether the file is stalled; the seconds are those
   * of the latest report at the moment of the call.
   *
   * @param   {string}                  filePath  The absolute path of the file
   *
   * @return  {SyncWarning|undefined}             The warning
   */
  function getSyncWarning (filePath: string): SyncWarning|undefined {
    const start = stallStarts.value.get(filePath)
    if (start === undefined) {
      return undefined
    }

    const health = latestStalledHealth.get(filePath)
    const stalledForMs = health?.stalledForMs ?? 0
    return {
      filePath,
      stalledSeconds: Math.max(0, Math.floor(stalledForMs / 1000)),
      stalledSince: start.stalledSince,
      reason: start.reason
    }
  }

  // ---------------------------------------------------------------------------
  // Incident notices
  // ---------------------------------------------------------------------------

  const notices = shallowRef<readonly DataSafetyNotice[]>([])

  /**
   * Adds an incident from the main process to the notices. Incidents of the
   * same kind for the same file are merged into one notice whose message and
   * time are those of the latest. `push-rejected` and malformed payloads are
   * ignored.
   *
   * @param  {unknown}  payload  The broadcast payload
   */
  function receiveIncident (payload: unknown): void {
    if (!isDisplayedIncident(payload)) {
      return
    }

    const filePath = typeof payload.filePath === 'string' && payload.filePath !== '' ? payload.filePath : undefined
    const time = typeof payload.time === 'number' ? payload.time : Date.now()
    const id = `${payload.kind}\u0000${filePath ?? ''}`
    const notice: DataSafetyNotice = { id, kind: payload.kind, message: payload.message, time }
    if (filePath !== undefined) {
      notice.filePath = filePath
    }

    const index = notices.value.findIndex(existing => existing.id === id)
    if (index < 0) {
      notices.value = [ ...notices.value, notice ]
    } else {
      const next = [...notices.value]
      next[index] = notice
      notices.value = next
    }
  }

  /**
   * Removes one notice; the others stay.
   *
   * @param  {string}  id  The ID of the notice
   */
  function dismissNotice (id: string): void {
    if (notices.value.some(notice => notice.id === id)) {
      notices.value = notices.value.filter(notice => notice.id !== id)
    }
  }

  const ipc = (window as unknown as { ipc?: StoreIPC }).ipc
  let stopIncidentListener: (() => void)|undefined
  if (ipc !== undefined && typeof ipc.on === 'function') {
    const stop = ipc.on(DATA_SAFETY_INCIDENT_CHANNEL, (_event: unknown, payload: unknown) => { receiveIncident(payload) })
    if (typeof stop === 'function') {
      stopIncidentListener = stop as () => void
    }
  }

  /** The IDs of the notices whose save is being retried */
  const retryingNoticeIds = shallowRef<ReadonlySet<string>>(new Set())

  /**
   * Asks the main process to save the file of a save-failed notice again. If
   * the save succeeds, the notice is removed; otherwise it stays (the main
   * process reports a failed write anew, which updates its text). Does nothing
   * if the notice is not a save-failed notice with a file, if its save is
   * already being retried, or if there is no IPC to ask with.
   *
   * @param   {string}         id  The ID of the notice
   *
   * @return  {Promise<void>}      Resolves when the attempt is over
   */
  async function retrySave (id: string): Promise<void> {
    const notice = notices.value.find(existing => existing.id === id)
    if (notice === undefined || notice.kind !== 'save-failed' || notice.filePath === undefined) {
      return
    }
    if (retryingNoticeIds.value.has(id) || ipc === undefined || typeof ipc.invoke !== 'function') {
      return
    }

    const started = new Set(retryingNoticeIds.value)
    started.add(id)
    retryingNoticeIds.value = started

    let saved = false
    try {
      const result = await ipc.invoke('documents-provider', {
        command: 'save-file',
        payload: { path: notice.filePath }
      })
      saved = result === true
    } catch (err) {
      console.error(`Retrying the save of ${notice.filePath} failed`, err)
    } finally {
      const finished = new Set(retryingNoticeIds.value)
      finished.delete(id)
      retryingNoticeIds.value = finished
    }

    if (saved) {
      dismissNotice(id)
    }
  }

  // ---------------------------------------------------------------------------
  // Recoverable sessions of files that are not open
  // ---------------------------------------------------------------------------

  const recoverableSessions = shallowRef<readonly RecoverableSessionSummary[]>([])
  const openFilePaths = shallowRef<ReadonlySet<string>>(new Set())
  // Counts the requests, so that an answer that arrives after a newer request was made is dropped
  let recoverableRequest = 0
  // Until the main process has been restarted, the recovery journal channel
  // has no handler. Warn once instead of at every change of the open files.
  let recoverableFailureWarned = false
  let disposed = false

  /** The files with recoverable sessions that are not open, newest session first, each once */
  const recoverableFilesNotOpen = computed<readonly string[]>(() => {
    const files: string[] = []
    for (const session of recoverableSessions.value) {
      if (!openFilePaths.value.has(session.filePath) && !files.includes(session.filePath)) {
        files.push(session.filePath)
      }
    }
    return files
  })

  const recoverableFileCount = computed<number>(() => recoverableFilesNotOpen.value.length)

  /**
   * Fetches the summary of all recoverable sessions anew. A failure (for
   * instance because the main process has not been restarted yet and the
   * channel does not exist) writes one console warning and leaves the list
   * empty; nothing else in the window is affected.
   */
  async function refreshRecoverableSessions (): Promise<void> {
    const request = ++recoverableRequest
    let sessions: RecoverableSessionSummary[]
    try {
      sessions = await recoveryJournalIPCAPI.listRecoverable()
    } catch (err) {
      if (request === recoverableRequest && !disposed) {
        recoverableSessions.value = []
      }
      if (!recoverableFailureWarned) {
        recoverableFailureWarned = true
        console.warn('Could not retrieve the recoverable sessions of the recovery journal; the banner does not list them', err)
      }
      return
    }

    recoverableFailureWarned = false
    if (request !== recoverableRequest || disposed) {
      return
    }
    recoverableSessions.value = Array.isArray(sessions)
      ? sessions.filter(session => typeof session?.filePath === 'string')
      : []
  }

  /**
   * Tells the store which files are open in the window. Fetches the
   * recoverable sessions anew whenever the set changes, since opening a file
   * can resolve its sessions and closing one can leave a session behind.
   *
   * @param  {Iterable<string>}  paths  The paths of all open files of the window
   */
  function setOpenFilePaths (paths: Iterable<string>): void {
    const next = new Set(paths)
    const current = openFilePaths.value
    if (next.size === current.size && [...next].every(filePath => current.has(filePath))) {
      return
    }

    openFilePaths.value = next
    refreshRecoverableSessions().catch(err => console.error(err))
  }

  refreshRecoverableSessions().catch(err => console.error(err))

  // ---------------------------------------------------------------------------
  // Disposal
  // ---------------------------------------------------------------------------

  function dispose (): void {
    disposed = true
    stopIncidentListener?.()
    stopIncidentListener = undefined
    stopSyncHealthSubscription()
  }

  // Pinia runs the setup of a store inside an effect scope and stops that
  // scope when the store is disposed of (also when this module is replaced by
  // a hot update, see the end of this file).
  if (getCurrentScope() !== undefined) {
    onScopeDispose(dispose)
  }

  return {
    stalledFilePaths,
    getSyncWarning,
    notices,
    receiveIncident,
    dismissNotice,
    retryingNoticeIds,
    retrySave,
    recoverableSessions,
    recoverableFilesNotOpen,
    recoverableFileCount,
    refreshRecoverableSessions,
    setOpenFilePaths
  }
}

export const useDataSafetyStore = defineStore(DATA_SAFETY_STORE_ID, setupDataSafetyStore)

/**
 * Disposes of the store of a Pinia instance, if it exists: its listeners are
 * removed and Pinia forgets it, so that the next use creates a new one. Called
 * when a hot update replaces this module.
 *
 * @param  {Pinia}  pinia  The Pinia instance; defaults to the active one
 */
export function disposeDataSafetyStore (pinia: Pinia|undefined = getActivePinia()): void {
  if (pinia === undefined || pinia.state.value[DATA_SAFETY_STORE_ID] === undefined) {
    return
  }

  useDataSafetyStore(pinia).$dispose()
}

// A hot update of this module must not leave the incident listener and the
// health subscription of the old module behind (specification C21 section 2
// item 4). Webpack provides module.hot in development builds only.
interface HotModule {
  hot?: { dispose: (callback: () => void) => void }
}
const hotModule = typeof module === 'undefined' ? undefined : (module as unknown as HotModule).hot
hotModule?.dispose(() => { disposeDataSafetyStore() })
