/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Recovery journal plugin
 * CVM-Role:        Extension
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH data loss prevention (R173, specification C21
 *                  sections 5.5 and 7): writes every step of the document into
 *                  the recovery journal, independently of the document
 *                  synchronization. Every editor state gets one session. The
 *                  session starts with the first local modification (a header
 *                  with the text before it), records every transaction that
 *                  changes the document, notes when all local modifications
 *                  are confirmed, and ends when the editor state is replaced
 *                  or destroyed, or the page is unloaded. The plugin also
 *                  watches for how long local modifications stay unconfirmed:
 *                  it reports the file as stalled and has the full text saved
 *                  as an emergency copy. It reports the file as stalled as
 *                  well while its records keep failing to be written to the
 *                  journal. Whether something is confirmed is decided with
 *                  `sendableUpdates` of the collab extension alone, which must
 *                  be part of the same editor state.
 *
 * END HEADER
 */

import { getClientID, getSyncedVersion, sendableUpdates } from '@codemirror/collab'
import {
  Facet,
  StateEffect,
  StateField,
  Transaction,
  type ChangeSet,
  type EditorState,
  type Extension,
  type Text
} from '@codemirror/state'
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view'
import type {
  RecoveryJournalEndReason,
  RecoveryJournalRecord,
  RecoveryJournalStepRecord
} from '@providers/recovery-journal/journal-store'
import { registerLiveSession, type RecoveryJournalAPI } from '../util/recovery-journal-api'
import {
  SYNCHRONIZED_HEALTH,
  SYNC_STALL_REASON_JOURNAL_WRITE_FAILED,
  SYNC_STALL_REASON_UNCONFIRMED_CHANGES,
  clearSyncHealthReporter,
  reportSyncHealth,
  type SyncHealth
} from '../util/sync-health'

/** For how long records are collected in memory at most before they are sent */
export const JOURNAL_BATCH_DELAY_MS = 500
/** After how long unconfirmed modifications make the file count as stalled */
export const SYNC_STALL_WARNING_MS = 5000
/** After how long unconfirmed modifications cause the first emergency copy of the full text */
export const EMERGENCY_COPY_FIRST_MS = 10000
/** The interval of further emergency copies while the modifications stay unconfirmed */
export const EMERGENCY_COPY_INTERVAL_MS = 30000
/**
 * After how long without a single successful append, counted from the first
 * rejected one, the file counts as stalled. Deliberately the same as
 * SYNC_STALL_WARNING_MS, so that the warning comes equally fast for both
 * causes. The appends are sent again 500, 1,500 and 3,500 ms after the first
 * rejection, so four attempts have failed by then; a hiccup that the first
 * repetitions get over is not reported.
 */
export const JOURNAL_WRITE_FAILURE_WARNING_MS = 5000

/** While the file is stalled, the reported duration is brought up to date this often */
const SYNC_STALL_REFRESH_MS = 1000
/** Records that could not be written are sent again with a delay that doubles up to this value */
const JOURNAL_RETRY_MAXIMUM_DELAY_MS = 30000
/** Must equal RECOVERY_JOURNAL_FORMAT_VERSION of the journal store, which a renderer cannot import */
const JOURNAL_FORMAT_VERSION = 1
/** The reason that the emergency copies carry */
const EMERGENCY_COPY_REASON = 'sync-stalled'

const SESSION_ID_CHARACTERS = 'abcdefghijklmnopqrstuvwxyz0123456789'
const SESSION_ID_LENGTH = 12

/**
 * The clock and the timers that the plugin uses. Tests substitute them to let
 * time pass without waiting.
 */
export interface RecoveryJournalTiming {
  now: () => number
  setTimeout: (callback: () => void, delay: number) => unknown
  clearTimeout: (handle: unknown) => void
}

export interface RecoveryJournalConfig {
  /** The absolute path of the file that the editor state shows */
  filePath: string
  windowId: string
  /** The ID of the editor pane (leaf) */
  leafId: string
  /** How the journal is reached; for production `recoveryJournalIPCAPI` */
  api: Pick<RecoveryJournalAPI, 'append'|'flush'|'preserveText'>
  /** Defaults to the real clock and timers */
  timing?: RecoveryJournalTiming
}

/** A local modification that has not been confirmed since the last full confirmation */
export interface UnconfirmedLocalStep {
  changes: ChangeSet
  userEvent?: string
}

/** What the code that replaces or destroys an editor state needs to know */
export interface RecoveryJournalSnapshot {
  sessionId: string
  /** Whether the session has a header, i.e. at least one local modification happened */
  sessionStarted: boolean
  /** The document at the moment when all local modifications were last confirmed */
  lastConfirmedDocument: Text
  /**
   * The local modifications since then, in order. Empty exactly if there are
   * no unconfirmed modifications. Each one applies to the result of the one
   * before it, the first one to `lastConfirmedDocument`, as long as
   * `replayable` is true.
   */
  unconfirmedLocalSteps: readonly UnconfirmedLocalStep[]
  /**
   * False if a remote update changed the document since the last full
   * confirmation; the steps then no longer apply to `lastConfirmedDocument`.
   */
  replayable: boolean
}

interface RecoveryJournalFieldValue {
  lastConfirmedDocument: Text
  unconfirmedLocalSteps: readonly UnconfirmedLocalStep[]
  replayable: boolean
  health: SyncHealth
}

const defaultTiming: RecoveryJournalTiming = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: handle => { clearTimeout(handle as ReturnType<typeof setTimeout>) }
}

const recoveryJournalConfig = Facet.define<RecoveryJournalConfig, RecoveryJournalConfig>({
  combine: values => values[0]
})

/**
 * The plugin dispatches this effect, without any change to the document,
 * whenever the synchronization health of its editor changes. The value is the
 * new health. Listen for it to redraw whatever displays the health.
 */
export const syncHealthChangedEffect = StateEffect.define<SyncHealth>()

/**
 * Returns how many local updates the collab extension still has to get
 * confirmed, or undefined if the state has no collab extension. A missing
 * extension must not make the editor fail on every transaction, so the error
 * is caught here.
 *
 * @param   {EditorState}       state  The editor state
 *
 * @return  {number|undefined}         The number of unconfirmed updates
 */
function countSendableUpdates (state: EditorState): number|undefined {
  try {
    return sendableUpdates(state).length
  } catch (err) {
    return undefined
  }
}

const recoveryJournalField = StateField.define<RecoveryJournalFieldValue>({
  create (state) {
    return {
      lastConfirmedDocument: state.doc,
      unconfirmedLocalSteps: [],
      replayable: true,
      health: SYNCHRONIZED_HEALTH
    }
  },
  update (value, transaction) {
    let next = value
    for (const effect of transaction.effects) {
      if (effect.is(syncHealthChangedEffect)) {
        next = { ...next, health: effect.value }
      }
    }

    const unconfirmedUpdates = countSendableUpdates(transaction.state)
    if (unconfirmedUpdates === undefined) {
      return next
    }

    if (unconfirmedUpdates === 0) {
      // Everything is confirmed: the current document is what the main process has
      if (next.unconfirmedLocalSteps.length > 0 || !next.replayable || next.lastConfirmedDocument !== transaction.newDoc) {
        next = { ...next, lastConfirmedDocument: transaction.newDoc, unconfirmedLocalSteps: [], replayable: true }
      }
    } else if (transaction.docChanged) {
      if (transaction.annotation(Transaction.remote) === true) {
        // The unconfirmed steps have been rebased over the remote update
        if (next.replayable) {
          next = { ...next, replayable: false }
        }
      } else {
        const step: UnconfirmedLocalStep = { changes: transaction.changes }
        const userEvent = transaction.annotation(Transaction.userEvent)
        if (userEvent !== undefined) {
          step.userEvent = userEvent
        }
        next = { ...next, unconfirmedLocalSteps: [ ...next.unconfirmedLocalSteps, step ] }
      }
    }

    return next
  }
})

function generateSessionId (): string {
  let sessionId = ''
  for (let index = 0; index < SESSION_ID_LENGTH; index++) {
    sessionId += SESSION_ID_CHARACTERS[Math.floor(Math.random() * SESSION_ID_CHARACTERS.length)]
  }
  return sessionId
}

function errorMessage (err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

class RecoveryJournalSession {
  public readonly sessionId: string
  private readonly config: RecoveryJournalConfig
  private readonly timing: RecoveryJournalTiming
  /** True if the state has no collab extension; the plugin then records nothing */
  private readonly inert: boolean

  private started: boolean
  private ended: boolean
  private endReason: RecoveryJournalEndReason
  /** The sequence of the last step record */
  private sequence: number
  /** The sequence of the last local step */
  private lastLocalSequence: number
  /** The `through` of the last confirmed record */
  private confirmedThrough: number
  /** The number of local steps after the last confirmed record */
  private localStepsSinceConfirmation: number

  /** The records that have not been sent yet, or have to be sent again */
  private pendingRecords: RecoveryJournalRecord[]
  private appendInFlight: boolean
  private sendWhenSettled: boolean
  private batchTimer: unknown
  private retryDelay: number
  /** When the first append of the current run of rejected appends was rejected; undefined if the last append was written */
  private journalWriteFailingSince: number|undefined

  /** The local transactions that are not confirmed yet, the oldest first, with the time they happened */
  private unconfirmedTransactions: Array<{ origin: Transaction, time: number }>
  private health: SyncHealth
  private stallTimer: unknown
  /** When it was last checked whether an emergency copy is due; undefined while the unconfirmed modifications do not make the file count as stalled */
  private lastEmergencyCheckAt: number|undefined
  /** The document of the last emergency copy */
  private lastEmergencyDocument: Text|undefined

  private unregisterLiveSession: (() => void)|undefined

  constructor (private readonly view: EditorView) {
    this.sessionId = generateSessionId()
    this.config = view.state.facet(recoveryJournalConfig)
    this.timing = this.config.timing ?? defaultTiming
    this.inert = countSendableUpdates(view.state) === undefined

    this.started = false
    this.ended = false
    this.endReason = 'unmount'
    this.sequence = 0
    this.lastLocalSequence = 0
    this.confirmedThrough = 0
    this.localStepsSinceConfirmation = 0

    this.pendingRecords = []
    this.appendInFlight = false
    this.sendWhenSettled = false
    this.batchTimer = undefined
    this.retryDelay = JOURNAL_BATCH_DELAY_MS
    this.journalWriteFailingSince = undefined

    this.unconfirmedTransactions = []
    this.health = SYNCHRONIZED_HEALTH
    this.stallTimer = undefined
    this.lastEmergencyCheckAt = undefined
    this.lastEmergencyDocument = undefined

    this.unregisterLiveSession = undefined

    if (this.inert) {
      console.error(`The recovery journal of ${this.config.filePath} is inactive: the editor state has no collab extension.`)
    }
  }

  public get isStarted (): boolean {
    return this.started
  }

  /**
   * Sets the reason that the end record will carry once the editor state is
   * replaced or destroyed.
   *
   * @param  {RecoveryJournalEndReason}  reason  The reason
   */
  public setEndReason (reason: RecoveryJournalEndReason): void {
    this.endReason = reason
  }

  update (update: ViewUpdate): void {
    if (this.ended || this.inert) {
      return
    }

    const oldestBefore = this.unconfirmedTransactions[0]
    for (const transaction of update.transactions) {
      this.recordTransaction(transaction)
    }

    if (this.unconfirmedTransactions[0] !== oldestBefore) {
      this.rescheduleStallTimer()
    }
  }

  destroy (): void {
    this.endSession(this.endReason)
  }

  /**
   * Records one transaction: a step record if it changed the document, and a
   * confirmed record if it left no local modification unconfirmed.
   *
   * @param  {Transaction}  transaction  The transaction
   */
  private recordTransaction (transaction: Transaction): void {
    const now = this.timing.now()

    if (transaction.docChanged) {
      const remote = transaction.annotation(Transaction.remote) === true
      if (!this.started && !remote) {
        this.startSession(transaction, now)
      }

      if (this.started) {
        this.sequence++
        // Only the changes are serialized here, never the full document
        const step: RecoveryJournalStepRecord = {
          type: 'step',
          sequence: this.sequence,
          time: now,
          changes: transaction.changes.toJSON(),
          remote,
          lengthAfter: transaction.newDoc.length
        }
        const userEvent = transaction.annotation(Transaction.userEvent)
        if (userEvent !== undefined) {
          step.userEvent = userEvent
        }
        this.enqueue(step)
      }

      if (!remote) {
        this.lastLocalSequence = this.sequence
        this.localStepsSinceConfirmation++
        this.unconfirmedTransactions.push({ origin: transaction, time: now })
      }
    }

    // The collab extension confirms updates in the order in which they were
    // made, and every unconfirmed update keeps the transaction it came from
    const unconfirmedUpdates = sendableUpdates(transaction.state)
    if (unconfirmedUpdates.length === 0) {
      this.unconfirmedTransactions = []
      if (this.started && this.lastLocalSequence > this.confirmedThrough) {
        this.confirmedThrough = this.lastLocalSequence
        this.localStepsSinceConfirmation = 0
        this.enqueue({ type: 'confirmed', through: this.confirmedThrough, time: now })
      }
    } else {
      while (
        this.unconfirmedTransactions.length > 0 &&
        !unconfirmedUpdates.some(unconfirmed => unconfirmed.origin === this.unconfirmedTransactions[0].origin)
      ) {
        this.unconfirmedTransactions.shift()
      }
    }
  }

  /**
   * Writes the header of the session. Called with the first local
   * modification; this is one of the two places that take the full text.
   *
   * @param  {Transaction}  transaction  The first local modification
   * @param  {number}       now          The current time
   */
  private startSession (transaction: Transaction, now: number): void {
    this.started = true
    this.enqueue({
      type: 'session',
      formatVersion: JOURNAL_FORMAT_VERSION,
      sessionId: this.sessionId,
      filePath: this.config.filePath,
      windowId: this.config.windowId,
      leafId: this.config.leafId,
      clientID: getClientID(transaction.startState),
      startedAt: now,
      baseVersion: getSyncedVersion(transaction.startState),
      baseText: transaction.startState.doc.toString()
    })
    this.unregisterLiveSession = registerLiveSession(reason => { this.endSession(reason) })
  }

  /**
   * Queues a record. The queue is sent JOURNAL_BATCH_DELAY_MS after its first
   * record was queued at the latest.
   *
   * @param  {RecoveryJournalRecord}  record  The record
   */
  private enqueue (record: RecoveryJournalRecord): void {
    this.pendingRecords.push(record)
    if (this.batchTimer === undefined) {
      this.scheduleBatch(JOURNAL_BATCH_DELAY_MS)
    }
  }

  private scheduleBatch (delay: number): void {
    if (this.batchTimer !== undefined) {
      this.timing.clearTimeout(this.batchTimer)
    }
    this.batchTimer = this.timing.setTimeout(() => {
      this.batchTimer = undefined
      this.sendBatch()
    }, delay)
  }

  /**
   * Sends the queued records. Only one append is under way at a time, so the
   * records reach the main process in order.
   */
  private sendBatch (): void {
    if (this.ended || this.pendingRecords.length === 0) {
      return
    }

    if (this.appendInFlight) {
      this.sendWhenSettled = true
      return
    }

    const records = this.pendingRecords
    this.pendingRecords = []
    this.appendInFlight = true

    let outcome: Promise<void>
    try {
      outcome = this.config.api.append(this.config.filePath, this.sessionId, records)
    } catch (err) {
      outcome = Promise.reject(err)
    }

    outcome.then(
      () => {
        this.appendInFlight = false
        this.retryDelay = JOURNAL_BATCH_DELAY_MS
        if (this.journalWriteFailingSince !== undefined) {
          // The journal is written again: the stall that its failures caused ends
          this.journalWriteFailingSince = undefined
          this.rescheduleStallTimer()
        }
        if (this.sendWhenSettled) {
          this.sendWhenSettled = false
          this.sendBatch()
        }
      },
      (err: unknown) => {
        this.appendInFlight = false
        this.sendWhenSettled = false
        this.handleAppendFailure(records, err)
      }
    )
  }

  /**
   * The main process could not write the records, or has no handler for the
   * channel (it was not restarted yet). The records stay in the queue and are
   * sent again together with the next batch. The first rejection after an
   * append that was written starts the count towards
   * JOURNAL_WRITE_FAILURE_WARNING_MS; the next append that is written ends it.
   *
   * @param  {RecoveryJournalRecord[]}  records  The records that were not written
   * @param  {unknown}                  err      Why
   */
  private handleAppendFailure (records: RecoveryJournalRecord[], err: unknown): void {
    console.error(`Could not write ${records.length} record(s) to the recovery journal of ${this.config.filePath}; they are kept and sent again: ${errorMessage(err)}`, err)

    if (this.ended) {
      // Nothing will send a next batch anymore, so this is the last attempt
      this.flushRecords(records)
      return
    }

    if (this.journalWriteFailingSince === undefined) {
      this.journalWriteFailingSince = this.timing.now()
      this.rescheduleStallTimer()
    }

    this.pendingRecords = records.concat(this.pendingRecords)
    this.scheduleBatch(this.retryDelay)
    this.retryDelay = Math.min(this.retryDelay * 2, JOURNAL_RETRY_MAXIMUM_DELAY_MS)
  }

  private flushRecords (records: RecoveryJournalRecord[]): void {
    try {
      this.config.api.flush(this.config.filePath, this.sessionId, records)
    } catch (err) {
      console.error(`Could not write out ${records.length} record(s) of the recovery journal of ${this.config.filePath}: ${errorMessage(err)}`, err)
    }
  }

  /**
   * Ends the session: the records that have not been sent yet and the end
   * record go out at once, without waiting for an answer. Records of an append
   * that is still under way are not repeated; they are on their way already.
   *
   * @param  {RecoveryJournalEndReason}  reason  Why the session ends
   */
  private endSession (reason: RecoveryJournalEndReason): void {
    if (this.ended) {
      return
    }
    this.ended = true

    if (this.batchTimer !== undefined) {
      this.timing.clearTimeout(this.batchTimer)
      this.batchTimer = undefined
    }
    if (this.stallTimer !== undefined) {
      this.timing.clearTimeout(this.stallTimer)
      this.stallTimer = undefined
    }
    if (this.unregisterLiveSession !== undefined) {
      this.unregisterLiveSession()
      this.unregisterLiveSession = undefined
    }

    if (this.started) {
      const records = this.pendingRecords
      this.pendingRecords = []
      records.push({
        type: 'end',
        time: this.timing.now(),
        reason,
        unconfirmedSteps: this.localStepsSinceConfirmation
      })
      this.flushRecords(records)
    }

    // The input of this editor is either delivered or preserved in the journal
    // from here on; whoever takes over reports for itself. Both causes of a
    // stall are reported under the session ID, so this withdraws either one.
    this.journalWriteFailingSince = undefined
    clearSyncHealthReporter(this.config.filePath, this.sessionId)
  }

  /**
   * Sets the timer for the next moment at which the health has to be looked
   * at: when the oldest unconfirmed modification or the failing journal
   * reaches its warning threshold, once per SYNC_STALL_REFRESH_MS while the
   * file is stalled, or right away if the reported health is out of date.
   */
  private rescheduleStallTimer (): void {
    if (this.stallTimer !== undefined) {
      this.timing.clearTimeout(this.stallTimer)
      this.stallTimer = undefined
    }
    if (this.ended) {
      return
    }

    const delay = this.nextStallDelay()
    if (delay !== undefined) {
      this.stallTimer = this.timing.setTimeout(() => {
        this.stallTimer = undefined
        this.evaluateStall()
      }, delay)
    }
  }

  private nextStallDelay (): number|undefined {
    const now = this.timing.now()
    const stall = this.dueStall(now)
    const reported = this.health

    // The reported health is out of date: bring it up to date right away
    if (stall === undefined) {
      if (reported.status === 'stalled') {
        return 0
      }
    } else if (reported.status !== 'stalled' || reported.stalledSince !== stall.since || reported.reason !== stall.reason) {
      return 0
    }

    const delays: number[] = []
    if (stall !== undefined) {
      delays.push(SYNC_STALL_REFRESH_MS)
    }

    const oldest = this.unconfirmedTransactions[0]
    if (oldest !== undefined) {
      const unconfirmedFor = now - oldest.time
      if (unconfirmedFor < SYNC_STALL_WARNING_MS) {
        delays.push(SYNC_STALL_WARNING_MS - unconfirmedFor)
      } else {
        delays.push(this.lastEmergencyCheckAt === undefined
          ? EMERGENCY_COPY_FIRST_MS - unconfirmedFor
          : this.lastEmergencyCheckAt + EMERGENCY_COPY_INTERVAL_MS - now)
      }
    }

    const failingSince = this.journalWriteFailingSince
    if (failingSince !== undefined && now - failingSince < JOURNAL_WRITE_FAILURE_WARNING_MS) {
      delays.push(JOURNAL_WRITE_FAILURE_WARNING_MS - (now - failingSince))
    }

    return delays.length === 0 ? undefined : Math.max(0, Math.min(...delays))
  }

  /**
   * Tells which stall has to be reported at the given moment. Two causes can
   * hold at once: local modifications that stay unconfirmed, and a journal
   * that cannot be written. Like the health registry does for several
   * reporters of one file, the cause that has lasted the longest is reported
   * (the unconfirmed modifications if both began at the same moment). Each
   * cause is judged by its own data, so the end of one never withdraws the
   * other.
   *
   * @param   {number}  now  The current time
   *
   * @return  {{ since: number, reason: string }|undefined}  When the stall
   *                                                         began and why;
   *                                                         undefined if
   *                                                         nothing is stalled
   */
  private dueStall (now: number): { since: number, reason: string }|undefined {
    let stall: { since: number, reason: string }|undefined

    const oldest = this.unconfirmedTransactions[0]
    if (oldest !== undefined && now - oldest.time >= SYNC_STALL_WARNING_MS) {
      stall = { since: oldest.time, reason: SYNC_STALL_REASON_UNCONFIRMED_CHANGES }
    }

    const failingSince = this.journalWriteFailingSince
    if (
      failingSince !== undefined && now - failingSince >= JOURNAL_WRITE_FAILURE_WARNING_MS &&
      (stall === undefined || failingSince < stall.since)
    ) {
      stall = { since: failingSince, reason: SYNC_STALL_REASON_JOURNAL_WRITE_FAILED }
    }

    return stall
  }

  /**
   * Looks at how long the oldest unconfirmed modification has been waiting
   * and for how long the journal could not be written, reports the health,
   * and has an emergency copy written when one is due. Only ever called from
   * a timer, never during an update of the view, because it dispatches an
   * effect.
   */
  private evaluateStall (): void {
    if (this.ended) {
      return
    }

    const now = this.timing.now()
    const oldest = this.unconfirmedTransactions[0]
    const stall = this.dueStall(now)
    this.setHealth(stall === undefined
      ? SYNCHRONIZED_HEALTH
      : { status: 'stalled', stalledForMs: now - stall.since, stalledSince: stall.since, reason: stall.reason })

    // The emergency copies follow the unconfirmed modifications alone,
    // whichever cause is reported: they preserve what the main process lacks
    if (oldest === undefined || now - oldest.time < SYNC_STALL_WARNING_MS) {
      this.lastEmergencyCheckAt = undefined
      this.lastEmergencyDocument = undefined
    } else {
      const emergencyCheckDue = this.lastEmergencyCheckAt === undefined
        ? now - oldest.time >= EMERGENCY_COPY_FIRST_MS
        : now - this.lastEmergencyCheckAt >= EMERGENCY_COPY_INTERVAL_MS
      if (emergencyCheckDue) {
        this.lastEmergencyCheckAt = now
        const document = this.view.state.doc
        // Comparing two documents does not build their strings
        if (this.lastEmergencyDocument === undefined || !document.eq(this.lastEmergencyDocument)) {
          this.lastEmergencyDocument = document
          this.preserveText(document)
        }
      }
    }

    this.rescheduleStallTimer()
  }

  /**
   * Has the full text written as the emergency copy of this session. This is
   * the second of the two places that take the full text.
   *
   * @param  {Text}  document  The document to preserve
   */
  private preserveText (document: Text): void {
    let outcome: Promise<unknown>
    try {
      outcome = this.config.api.preserveText(this.config.filePath, this.sessionId, document.toString(), EMERGENCY_COPY_REASON)
    } catch (err) {
      outcome = Promise.reject(err)
    }

    outcome.catch((err: unknown) => {
      console.error(`Could not write the emergency copy of ${this.config.filePath}: ${errorMessage(err)}`, err)
      // Have the same text written again at the next check
      if (this.lastEmergencyDocument === document) {
        this.lastEmergencyDocument = undefined
      }
    })
  }

  /**
   * Reports a changed health to the registry and to the editor state.
   *
   * @param  {SyncHealth}  health  The current health
   */
  private setHealth (health: SyncHealth): void {
    const unchanged = health.status === 'synchronized'
      ? this.health.status === 'synchronized'
      : this.health.status === 'stalled' && this.health.stalledForMs === health.stalledForMs &&
        this.health.stalledSince === health.stalledSince && this.health.reason === health.reason
    if (unchanged) {
      return
    }

    this.health = health
    reportSyncHealth(this.config.filePath, this.sessionId, health)
    this.view.dispatch({ effects: syncHealthChangedEffect.of(health) })
  }
}

const recoveryJournalPlugin = ViewPlugin.fromClass(RecoveryJournalSession)

/**
 * Returns the extension that writes the recovery journal of an editor state.
 * The state must also contain the collab extension. The plugin is created
 * anew, with a new session, for every editor state that a view shows.
 *
 * @param   {RecoveryJournalConfig}  config  The file, the window, the editor
 *                                           pane, and the way to the journal
 *
 * @return  {Extension}                      A CodeMirror extension
 */
export function recoveryJournal (config: RecoveryJournalConfig): Extension {
  return [
    recoveryJournalConfig.of(config),
    recoveryJournalField,
    recoveryJournalPlugin
  ]
}

/**
 * Returns what the recovery journal plugin knows about the unconfirmed local
 * modifications of an editor.
 *
 * @param   {EditorView}  view  The editor
 *
 * @return  {RecoveryJournalSnapshot|undefined}  Undefined if the editor has no
 *                                               (working) recovery journal plugin
 */
export function getRecoveryJournalSnapshot (view: EditorView): RecoveryJournalSnapshot|undefined {
  const session = view.plugin(recoveryJournalPlugin)
  const value = view.state.field(recoveryJournalField, false)
  if (session === null || value === undefined) {
    return undefined
  }

  return {
    sessionId: session.sessionId,
    sessionStarted: session.isStarted,
    lastConfirmedDocument: value.lastConfirmedDocument,
    unconfirmedLocalSteps: value.unconfirmedLocalSteps,
    replayable: value.replayable
  }
}

/**
 * Tells the plugin why its session is about to end. Call this right before
 * the editor state is replaced (`reload`); the end record is written while the
 * state is replaced. Without it, the end record carries the reason `unmount`.
 *
 * @param   {EditorView}                view    The editor
 * @param   {RecoveryJournalEndReason}  reason  The reason for the end record
 *
 * @return  {boolean}                           False if the editor has no
 *                                              (working) recovery journal plugin
 */
export function setRecoveryJournalEndReason (view: EditorView, reason: RecoveryJournalEndReason): boolean {
  const session = view.plugin(recoveryJournalPlugin)
  if (session === null) {
    return false
  }

  session.setEndReason(reason)
  return true
}

/**
 * Returns the synchronization health of the editor that the state belongs to,
 * as its recovery journal plugin last reported it.
 *
 * @param   {EditorState}  state  The editor state
 *
 * @return  {SyncHealth}          The health; synchronized if the state has no
 *                                recovery journal plugin
 */
export function getEditorSyncHealth (state: EditorState): SyncHealth {
  return state.field(recoveryJournalField, false)?.health ?? SYNCHRONIZED_HEALTH
}
