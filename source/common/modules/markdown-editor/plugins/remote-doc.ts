/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Remote Document
 * CVM-Role:        Utility
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This module defines a set of functions required by the
 *                  editor to retrieve, update, and sync with the document
 *                  provider.
 *
 * END HEADER
 */

// This plugin implements remote callbacks that keep the editor's document in
// sync with a central authority
import {
  type Update,
  sendableUpdates,
  receiveUpdates,
  collab,
  getSyncedVersion,
  getClientID
} from '@codemirror/collab'
import { ChangeSet, StateEffect, Transaction, type EditorState, type Extension } from '@codemirror/state'
import { undoDepth } from '@codemirror/commands'
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view'
import { configField } from '../util/configuration'

/**
 * Zettlr-LYH data loss prevention (R173, specification C21 section 3.1): how
 * long a pull waits at most before it asks the document authority anyway, in
 * milliseconds. Before, a pull only ever asked after a status event had
 * arrived, so a single lost event stalled the synchronization for good.
 */
export const PULL_FALLBACK_INTERVAL_MS = 2000

/**
 * Zettlr-LYH data loss prevention (R173, specification C21 section 3.2): what
 * an editor tells the document authority about itself with every pull request.
 */
export interface EditorSyncReport {
  /** The client ID of the editor's collab extension */
  clientID: string
  /** How many local updates the document authority has not confirmed yet */
  unconfirmedUpdates: number
  /** When the oldest of them came into being (milliseconds timestamp); null if there are none */
  oldestUnconfirmedAt: number|null
}

/**
 * Zettlr-LYH data loss prevention (R173): lets the plugin end the wait of a
 * pull that has not sent its request yet.
 */
export interface PullWaitControl {
  /** Ends the wait; the request is sent right away */
  wake: () => void
  /** Ends the wait without sending a request; the pull resolves with no updates */
  cancel: () => void
}

/**
 * Zettlr-LYH data loss prevention (R173): the hooks the plugin hands to a pull
 * callback. A callback may ignore them (it then cannot be woken, and reports
 * nothing about the editor).
 */
export interface PullUpdateOptions {
  /**
   * Called once, synchronously, right before the request is sent. The return
   * value is the `editor` field of the request.
   */
  prepareRequest?: () => EditorSyncReport
  /**
   * Called once, synchronously, as soon as the pull waits (with its listener
   * and timer in place). `wake` may be called from within this callback.
   */
  onWait?: (control: PullWaitControl) => void
}

/**
 * Zettlr-LYH data loss prevention (R173, specification C21 section 3.3): the
 * answer of the document authority to a push. A main process that has not been
 * restarted yet answers with a plain boolean instead.
 */
export interface PushAnswer {
  accepted: boolean
  /** Why the updates were rejected: version-mismatch, document-missing or comparison-version-out-of-range */
  reason?: string
  /** The version of the document authority; only with the reason version-mismatch */
  currentVersion?: number
}

export type PullUpdateCallback = (filePath: string, version: number, options?: PullUpdateOptions) => Promise<Update[]|false>
// The declared return type stays a boolean, because other callers depend on
// it. At runtime the plugin also accepts a PushAnswer (see readPushAnswer).
export type PushUpdateCallback = (filePath: string, version: number, updates: Update[]) => Promise<boolean>

/**
 * Zettlr-LYH undo history (R135, specification C20 section 5): what the editor
 * tells the main process about the step an update stands for, so that the main
 * process can record it in the undo history of the document.
 */
export interface UndoDescription {
  /** An ordinary edit, an undo, or a redo */
  kind: 'edit'|'undo'|'redo'
  /** Whether CodeMirror merged the edit into the previous undo group; only meaningful for an edit */
  joined: boolean
  /** The selection before the step */
  selectionBefore: { ranges: Array<{ anchor: number, head: number }>, main: number }
  /** The user event of the transaction, if it had one */
  userEvent?: string
}

/** How long to wait before the next push, in milliseconds */
const PUSH_RETRY_DELAY = 100

/** The longest time between two pushes while pushes keep failing, in milliseconds */
const PUSH_RETRY_DELAY_MAXIMUM = PULL_FALLBACK_INTERVAL_MS

/** While pushes keep failing, the failure is written to the console at most this often, in milliseconds */
const PUSH_FAILURE_LOG_INTERVAL = 10000

type SerializedUpdate = Update & { undoDescription?: UndoDescription }

/** What the plugin knows about the pull it is currently waiting for */
interface PullAttempt {
  /** Set by the callback through `onWait`; undefined if the callback cannot be woken */
  control: PullWaitControl|undefined
  /** Whether the callback has sent its request (it called `prepareRequest`) */
  requested: boolean
  /** Whether the request was sent after the push that waits for a pull */
  coversPush: boolean
}

/**
 * Zettlr-LYH undo history (R135): describes the step that the transaction
 * which produced a sendable update stands for. The description rides along with
 * the update itself: `sendableUpdates` returns objects with an `origin`, the
 * original transaction, so no shared effect is needed to pair them.
 *
 * @param   {Transaction}      origin  The transaction that produced the update
 *
 * @return  {UndoDescription}          The description
 */
function describeUpdate (origin: Transaction): UndoDescription|undefined {
  try {
    const kind = origin.isUserEvent('undo') ? 'undo' : (origin.isUserEvent('redo') ? 'redo' : 'edit')
    // CodeMirror merged the edit into the previous undo group if the
    // transaction entered the history and left the number of undoable groups as
    // it was. A transaction that did not enter the history is never joined.
    const joined = kind === 'edit' &&
      origin.annotation(Transaction.addToHistory) !== false &&
      undoDepth(origin.startState) === undoDepth(origin.state)
    const description: UndoDescription = {
      kind,
      joined,
      selectionBefore: origin.startState.selection.toJSON()
    }
    const userEvent = origin.annotation(Transaction.userEvent)
    if (userEvent !== undefined) {
      description.userEvent = userEvent
    }
    return description
  } catch (err) {
    // The description is an extra; failing to describe a step must never keep
    // the update itself from reaching the document authority
    console.error('Could not describe an update for the undo history', err)
    return undefined
  }
}

/**
 * Turns the sendable updates of a state into what goes over the wire.
 * Zettlr-LYH undo history (R135): every update carries a description of the
 * step it stands for (the main process records it in the undo history of the
 * document).
 *
 * @param   {ReturnType<typeof sendableUpdates>}  updates  The sendable updates
 *
 * @return  {SerializedUpdate[]}                           The serialized updates
 */
function serializeUpdates (updates: ReturnType<typeof sendableUpdates>): SerializedUpdate[] {
  return updates.map(u => {
    const serialized: SerializedUpdate = { clientID: u.clientID, changes: u.changes.toJSON() }
    const undoDescription = describeUpdate(u.origin)
    if (undoDescription !== undefined) {
      serialized.undoDescription = undoDescription
    }
    return serialized
  })
}

/**
 * Zettlr-LYH data loss prevention (R173, specification C21 section 3.4): reads
 * the answer to a push. Only the boolean false and an object whose `accepted`
 * is false mean that the updates were rejected.
 *
 * @param   {unknown}     answer  Whatever the push callback resolved with
 *
 * @return  {PushAnswer}          The answer in its object form
 */
function readPushAnswer (answer: unknown): PushAnswer {
  if (answer === false) {
    return { accepted: false }
  }

  if (typeof answer === 'object' && answer !== null && (answer as PushAnswer).accepted === false) {
    const { reason, currentVersion } = answer as PushAnswer
    return { accepted: false, reason, currentVersion }
  }

  return { accepted: true }
}

function describeError (err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * NOTE: The caller MUST listen for this state effect. If this effect is being
 * emitted, the document is irrepairably out of sync with the document authority
 * and the entire state must be reinitialized.
 *
 * Zettlr-LYH data loss prevention (R173, specification C21 section 3.1): the
 * plugin itself discards nothing when it emits this effect. Its local updates
 * stay in the state, and it keeps trying to synchronize (one pull and one push
 * every PULL_FALLBACK_INTERVAL_MS) until the caller replaces the state.
 */
export const reloadStateEffect = StateEffect.define<boolean>()

/**
 * Call this function to retrieve an Extension that can be used to synchronize
 * an editor with a central document authority.
 * @param   {string}              filePath      The file's path to be requested
 * @param   {number}              startVersion  Retrieve this when you retrieve
 *                                              the document initially.
 * @param   {PullUpdateCallback}  pullUpdates   The callback to request new
 *                                              updates from the document
 *                                              authority.
 * @param   {PushUpdateCallback}  pushUpdates   The callback to send updates to
 *                                              the document authority.
 *
 * @return  {Extension}                         A CodeMirror v6 extension
 */
export function hookDocumentAuthority (
  filePath: string,
  startVersion: number,
  pullUpdates: PullUpdateCallback,
  pushUpdates: PushUpdateCallback
): Extension {
  // Zettlr-LYH data loss prevention (R173, specification C21 section 3). How
  // push and pull work together:
  //
  // * One pull loop runs for the lifetime of the plugin. Each round waits (for
  //   a status event, for PULL_FALLBACK_INTERVAL_MS, or until it is woken),
  //   then asks the authority once and applies the answer once.
  // * After a push has been sent, the next push has to wait until a pull that
  //   was requested after that push has been processed ("pushAwaitsPull").
  //   This is what guarantees a pull between any two pushes: a rejected push
  //   is never repeated unchanged, the pull first brings whatever the editor
  //   was missing.
  // * A pull callback that takes no notice of the hooks it is handed (onWait,
  //   prepareRequest) cannot be woken. With such a callback a push is never
  //   held back, as before.
  const plugin = ViewPlugin.fromClass(class {
    private isCurrentlyPushing: boolean
    private pluginDestroyed: boolean
    private pushRetryTimer: ReturnType<typeof setTimeout>|undefined
    /** How many updates the push in flight carries */
    private updatesInFlight: number
    /** True from the moment a push is sent until a pull requested after it has been processed */
    private pushAwaitsPull: boolean
    /** The synchronized version and the number of updates of the last push the authority accepted */
    private lastAcceptedPush: { version: number, updates: number }|undefined
    private consecutivePushFailures: number
    private lastPushFailureLogAt: number|undefined
    private pullLoopRunning: boolean
    /** Somebody asked for a pull while the loop was not running */
    private pullRestartRequested: boolean
    /** Runs for PULL_FALLBACK_INTERVAL_MS after the pull loop has ended; the loop is not restarted before */
    private pullLoopCooldownTimer: ReturnType<typeof setTimeout>|undefined
    /** The pause of the pull loop after a failed pull */
    private pullPauseTimer: ReturnType<typeof setTimeout>|undefined
    private releasePullPause: (() => void)|undefined
    private currentPullAttempt: PullAttempt|undefined
    /** The next pull that starts waiting is woken at once */
    private pullWakeRequested: boolean
    /** When the unconfirmed updates went from none to some; null while there are none */
    private oldestUnconfirmedAt: number|null

    constructor (private readonly view: EditorView) {
      this.isCurrentlyPushing = false
      this.pluginDestroyed = false
      this.pushRetryTimer = undefined
      this.updatesInFlight = 0
      this.pushAwaitsPull = false
      this.lastAcceptedPush = undefined
      this.consecutivePushFailures = 0
      this.lastPushFailureLogAt = undefined
      this.pullLoopRunning = false
      this.pullRestartRequested = false
      this.pullLoopCooldownTimer = undefined
      this.pullPauseTimer = undefined
      this.releasePullPause = undefined
      this.currentPullAttempt = undefined
      this.pullWakeRequested = false
      this.oldestUnconfirmedAt = null
      this.trackUnconfirmedUpdates(view.state)

      // Immediately enter a loop to pull updates to the document.
      this.startPullLoop()
    }

    update (update: ViewUpdate): void {
      this.trackUnconfirmedUpdates(update.state)
      // Whenever the doc changed, sync those changes with the document authority
      if (update.docChanged) {
        try {
          this.push()
        } catch (err: unknown) {
          // CodeMirror switches a plugin off for good once its update method
          // throws; the synchronization must survive any failure in here.
          console.error(`Pushing updates failed: ${describeError(err)}`, err)
          this.schedulePushRetry(PUSH_RETRY_DELAY)
        }
      }
    }

    /**
     * Remembers when the unconfirmed updates went from none to some, and
     * forgets it once all of them have been confirmed.
     */
    trackUnconfirmedUpdates (state: EditorState): void {
      const unconfirmed = sendableUpdates(state).length
      if (unconfirmed === 0) {
        this.oldestUnconfirmedAt = null
      } else if (this.oldestUnconfirmedAt === null) {
        this.oldestUnconfirmedAt = Date.now()
      }
    }

    /** What the editor reports about itself with a pull request */
    describeSyncState (): EditorSyncReport {
      const state = this.view.state
      const unconfirmedUpdates = sendableUpdates(state).length
      return {
        clientID: getClientID(state),
        unconfirmedUpdates,
        oldestUnconfirmedAt: unconfirmedUpdates > 0 ? (this.oldestUnconfirmedAt ?? Date.now()) : null
      }
    }

    /**
     * Sends the sendable updates to the document authority, unless a push is
     * in flight, or the previous push still waits for its pull. In the latter
     * case the pull is woken; processing it calls this method again.
     */
    push (): void {
      if (this.pluginDestroyed) {
        return // The editor is gone; nothing may be pushed or scheduled anymore
      }

      if (this.isCurrentlyPushing) {
        return // There's another push going on atm
      }

      const updates = sendableUpdates(this.view.state)
      if (updates.length === 0) {
        return // No updates available
      }

      if (this.pushAwaitsPull && this.requestPull()) {
        return // The pull comes first
      }

      this.isCurrentlyPushing = true
      this.updatesInFlight = updates.length
      this.pushAwaitsPull = true
      const version = getSyncedVersion(this.view.state)
      new Promise<unknown>(resolve => { resolve(pushUpdates(filePath, version, serializeUpdates(updates))) })
        .then(
          answer => { this.handlePushSettled(version, updates.length, readPushAnswer(answer), undefined) },
          (err: unknown) => { this.handlePushSettled(version, updates.length, undefined, err) }
        )
        .catch(err => { console.error(`Handling the result of a push for ${filePath} failed: ${describeError(err)}`, err) })
    }

    /**
     * Runs when a push has been answered, or has thrown. Also after a failed
     * push the editor must be able to push again (Zettlr-LYH undo history,
     * R135).
     */
    handlePushSettled (version: number, updateCount: number, answer: PushAnswer|undefined, err: unknown): void {
      this.isCurrentlyPushing = false
      this.updatesInFlight = 0
      const accepted = answer?.accepted === true
      if (accepted) {
        this.lastAcceptedPush = { version, updates: updateCount }
      }

      if (this.pluginDestroyed) {
        return // Nothing is scheduled once the plugin has been destroyed
      }

      if (accepted) {
        this.consecutivePushFailures = 0
        this.lastPushFailureLogAt = undefined
        // Allow another push, if new updates have amassed during the push
        this.schedulePushRetry(PUSH_RETRY_DELAY)
        return
      }

      this.consecutivePushFailures += 1
      const now = Date.now()
      // The first failure of a streak is always written; after that at most
      // one line every PUSH_FAILURE_LOG_INTERVAL
      if (this.consecutivePushFailures === 1 || this.lastPushFailureLogAt === undefined || now - this.lastPushFailureLogAt >= PUSH_FAILURE_LOG_INTERVAL) {
        this.lastPushFailureLogAt = now
        if (answer === undefined) {
          console.error(`Pushing updates failed: ${describeError(err)}`, err)
        } else {
          const reason = answer.reason ?? 'no reason given'
          const authorityVersion = answer.currentVersion === undefined ? '' : `, document authority version ${answer.currentVersion}`
          console.warn(`The document authority rejected ${updateCount} update(s) for ${filePath} (${reason}; locally synchronized version ${version}${authorityVersion}). Pulling before the next push.`)
        }
      }

      // Zettlr-LYH data loss prevention (R173, specification C21 section 3.4):
      // a failed push is not simply repeated. The pull is woken at once; the
      // timer only limits how fast pushes follow each other while they keep
      // failing (100, 200, 400 ... milliseconds, at most 2 seconds).
      this.requestPull()
      const delay = Math.min(PUSH_RETRY_DELAY * 2 ** (this.consecutivePushFailures - 1), PUSH_RETRY_DELAY_MAXIMUM)
      this.schedulePushRetry(delay)
    }

    /**
     * Allows another push, if new updates have amassed during the push (or the
     * push failed). Nothing is scheduled once the plugin has been destroyed,
     * otherwise the retry would keep running for as long as updates remain
     * unconfirmed.
     */
    schedulePushRetry (delay: number = PUSH_RETRY_DELAY): void {
      if (this.pluginDestroyed) {
        return
      }
      if (this.pushRetryTimer !== undefined) {
        clearTimeout(this.pushRetryTimer)
      }
      this.pushRetryTimer = setTimeout(() => {
        this.pushRetryTimer = undefined
        this.push()
      }, delay)
    }

    /**
     * Makes sure a pull is requested from the document authority as soon as
     * possible: wakes the waiting pull, or restarts the pull loop if it has
     * ended.
     *
     * @return  {boolean}  True if a pull is (or will be) under way, after
     *                     which push() is called again. False if the pull
     *                     callback cannot be woken; the caller then must not
     *                     wait for the pull.
     */
    requestPull (): boolean {
      if (this.pluginDestroyed) {
        return false
      }

      if (!this.pullLoopRunning) {
        if (this.pullLoopCooldownTimer !== undefined) {
          // The loop ended less than PULL_FALLBACK_INTERVAL_MS ago. The timer
          // restarts it, and then calls push().
          this.pullRestartRequested = true
          return true
        }
        this.startPullLoop()
      }

      const attempt = this.currentPullAttempt
      if (attempt === undefined) {
        // The loop pauses after a failed pull, or is about to begin its next
        // round; that round must not wait.
        this.pullWakeRequested = true
        return true
      }

      if (attempt.requested) {
        if (!attempt.coversPush) {
          // The request in flight was sent before the push; its answer may not
          // contain what the push is waiting for. Pull once more after it.
          this.pullWakeRequested = true
        }
        return true
      }

      if (attempt.control !== undefined) {
        attempt.control.wake()
        return true
      }

      return false
    }

    startPullLoop (): void {
      if (this.pluginDestroyed || this.pullLoopRunning) {
        return
      }

      this.pullLoopRunning = true
      this.pullRestartRequested = false
      if (this.pullLoopCooldownTimer !== undefined) {
        clearTimeout(this.pullLoopCooldownTimer)
        this.pullLoopCooldownTimer = undefined
      }

      this.pull().catch(err => {
        console.error(`Pulling updates failed: ${describeError(err)}`, err)
        this.finishPullLoop()
      })
    }

    /**
     * Records that the pull loop has ended. If the plugin is still alive, the
     * loop can be restarted: by the next push that needs a pull, but not
     * earlier than PULL_FALLBACK_INTERVAL_MS from now.
     */
    finishPullLoop (): void {
      if (!this.pullLoopRunning) {
        return
      }

      this.pullLoopRunning = false
      this.currentPullAttempt = undefined
      if (this.pluginDestroyed) {
        return
      }

      this.pullLoopCooldownTimer = setTimeout(() => {
        this.pullLoopCooldownTimer = undefined
        if (this.pullRestartRequested) {
          this.startPullLoop()
          this.push()
        }
      }, PULL_FALLBACK_INTERVAL_MS)
    }

    /** Pauses the pull loop for PULL_FALLBACK_INTERVAL_MS; destroy() ends the pause early. */
    async pausePullLoop (): Promise<void> {
      await new Promise<void>(resolve => {
        const release = (): void => {
          if (this.pullPauseTimer !== undefined) {
            clearTimeout(this.pullPauseTimer)
            this.pullPauseTimer = undefined
          }
          this.releasePullPause = undefined
          resolve()
        }
        this.releasePullPause = release
        this.pullPauseTimer = setTimeout(release, PULL_FALLBACK_INTERVAL_MS)
      })
    }

    /**
     * Runs after the answer to a pull has been applied (or the authority has
     * answered that the document must be reloaded).
     *
     * @param  {boolean}  coversPush  Whether the pull was requested after the
     *                                last push was sent
     */
    settleProcessedPull (coversPush: boolean): void {
      if (coversPush) {
        this.pushAwaitsPull = false
      }

      // If a push timer is pending, it limits how fast pushes follow each
      // other and will push itself; otherwise push what has amassed right now.
      if (this.pushRetryTimer === undefined && !this.isCurrentlyPushing) {
        this.push()
      }
    }

    /**
     * The pull loop. Only one runs at any time (see startPullLoop), and it has
     * only one request in flight at any time, so the updates of one answer are
     * applied exactly once.
     */
    async pull (): Promise<void> {
      while (!this.pluginDestroyed) {
        const attempt: PullAttempt = { control: undefined, requested: false, coversPush: false }
        this.currentPullAttempt = attempt
        const version = getSyncedVersion(this.view.state)
        let updates: Update[]|false
        try {
          updates = await pullUpdates(filePath, version, {
            prepareRequest: () => {
              attempt.requested = true
              attempt.coversPush = this.pushAwaitsPull
              return this.describeSyncState()
            },
            onWait: control => {
              attempt.control = control
              if (this.pluginDestroyed) {
                control.cancel()
              } else if (this.pullWakeRequested) {
                this.pullWakeRequested = false
                control.wake()
              }
            }
          })
        } catch (err: unknown) {
          this.currentPullAttempt = undefined
          if (this.pluginDestroyed) {
            break
          }
          // Zettlr-LYH data loss prevention (R173): a failed pull used to end
          // the loop for good. Now it continues after a pause.
          console.error(`Pulling updates for ${filePath} failed (retrying in ${PULL_FALLBACK_INTERVAL_MS} ms): ${describeError(err)}`, err)
          await this.pausePullLoop()
          this.pullWakeRequested = true // The pause was the wait
          continue
        }

        this.currentPullAttempt = undefined
        if (this.pluginDestroyed) {
          break
        }

        // A callback that took no notice of the hooks cannot tell when it sent
        // its request; its answer counts as one that covers the push.
        const coversPush = attempt.coversPush || (!attempt.requested && attempt.control === undefined)

        // NOTE: At this point, time may have passed, so we have to re-check the
        // current state, because the view will remain valid for as long as the
        // editor leaf exists. If the editor now shows a different file, these
        // updates shall not be applied to the current state.
        const currentFilePath = this.view.state.field(configField, false)?.metadata.path
        if (currentFilePath !== undefined && currentFilePath !== filePath) {
          console.warn(`Updates pulled for ${filePath} are not applied: the editor now shows ${currentFilePath}. The pull loop for ${filePath} stops until its next push needs it.`)
          break
        }

        if (updates === false) {
          // By returning `false`, the authority told us that we've lost
          // synchronization and there is no way to re-synchronize in this method.
          // This means that here we need to emit an effect that must be captured
          // by the MainEditor instance to perform a full reload of the document
          // state. After that, we break out of the pull loop.
          // Zettlr-LYH data loss prevention (R173): the plugin discards
          // nothing itself. Whoever handles the effect decides what happens
          // to the unconfirmed local input.
          console.warn(`Document ${filePath} lost synchronization with the main process (locally synchronized version ${version}, ${sendableUpdates(this.view.state).length} unconfirmed local update(s)); requesting a reload.`)
          this.finishPullLoop()
          this.view.dispatch({ effects: reloadStateEffect.of(true) })
          if (!this.pluginDestroyed) {
            this.settleProcessedPull(coversPush)
          }
          return
        }

        let applied = true
        try {
          if (updates.length > 0) {
            // Deserialize & apply updates
            const deserializedUpdates = updates.map(u => {
              return {
                clientID: u.clientID,
                changes: ChangeSet.fromJSON(u.changes)
              }
            })
            const transaction = receiveUpdates(this.view.state, deserializedUpdates)
            this.view.dispatch(transaction)
          }
        } catch (err: unknown) {
          applied = false
          console.error(`Applying pulled updates for ${filePath} failed (retrying in ${PULL_FALLBACK_INTERVAL_MS} ms): ${describeError(err)}`, err)
        }

        if (this.pluginDestroyed) {
          break
        }

        if (applied) {
          this.settleProcessedPull(coversPush)
        } else {
          // The same answer would fail the same way; do not ask again at once
          await this.pausePullLoop()
          this.pullWakeRequested = true
        }
      }

      this.finishPullLoop()
    }

    destroy (): void {
      // This ensures that the client stops trying to receive updates after the
      // editor has been removed (hence, no dangling promises that will prevent
      // a smooth shutdown of the application)
      this.pluginDestroyed = true

      // Zettlr-LYH data loss prevention (R173, specification C21 section 3.4
      // item 4): one last push, sent before this method returns and not waited
      // for. It is left out only where it could not be accepted anyway: the
      // push in flight carries the same updates, or the authority has already
      // accepted exactly these updates and only their confirmation is missing.
      try {
        const updates = sendableUpdates(this.view.state)
        const version = getSyncedVersion(this.view.state)
        const sameAsInFlight = this.isCurrentlyPushing && this.updatesInFlight === updates.length
        const alreadyAccepted = this.lastAcceptedPush?.version === version && this.lastAcceptedPush.updates === updates.length
        if (updates.length > 0 && !sameAsInFlight && !alreadyAccepted) {
          new Promise<unknown>(resolve => { resolve(pushUpdates(filePath, version, serializeUpdates(updates))) })
            .catch(err => { console.error(`Pushing the last updates of ${filePath} failed: ${describeError(err)}`, err) })
        }
      } catch (err: unknown) {
        console.error(`Could not push the last updates of ${filePath}: ${describeError(err)}`, err)
      }

      if (this.pushRetryTimer !== undefined) {
        clearTimeout(this.pushRetryTimer)
        this.pushRetryTimer = undefined
      }
      if (this.pullLoopCooldownTimer !== undefined) {
        clearTimeout(this.pullLoopCooldownTimer)
        this.pullLoopCooldownTimer = undefined
      }
      this.releasePullPause?.()
      // Ends the wait of the pull, which removes its listener and its timer
      const control = this.currentPullAttempt?.control
      const requested = this.currentPullAttempt?.requested === true
      this.currentPullAttempt = undefined
      if (control !== undefined && !requested) {
        try {
          control.cancel()
        } catch (err: unknown) {
          console.error(`Could not cancel the pending pull for ${filePath}: ${describeError(err)}`, err)
        }
      }
    }
  })

  return [ collab({ startVersion }), plugin ]
}
