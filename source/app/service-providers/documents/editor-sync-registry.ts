/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        EditorSyncRegistry
 * CVM-Role:        Model
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH data loss prevention (R173, specification C21
 *                  section 4): keeps, per file and editor, what each editor
 *                  last reported about its unconfirmed input, i.e. the changes
 *                  it has applied but not yet seen confirmed by the document
 *                  manager. The document manager asks this registry before it
 *                  does anything that would discard such input (reloading a
 *                  file from disk, closing a tab, quitting). This module must
 *                  not import Electron; clock and timers can be injected.
 *
 * END HEADER
 */

/** How long a report of an editor stays valid without a newer one, in milliseconds */
export const EDITOR_HEARTBEAT_EXPIRY_MS = 6000

/** How long the main process waits at most for unconfirmed input to arrive, in milliseconds */
export const DELIVERY_WAIT_MS = 3000

/**
 * What an editor reports with every pull request (specification C21 section
 * 3.2).
 */
export interface EditorSyncReport {
  /** The client ID of the editor's collab extension */
  clientID: string
  /** How many local updates the editor has that the document manager has not confirmed */
  unconfirmedUpdates: number
  /** When the oldest of them came into being (milliseconds timestamp); null if there are none */
  oldestUnconfirmedAt: number|null
}

/** The options of the registry; all of them are optional */
export interface EditorSyncRegistryOptions {
  /** The clock; defaults to Date.now */
  now?: () => number
  /** Starts a timer; defaults to setTimeout */
  setTimer?: (callback: () => void, delay: number) => unknown
  /** Stops a timer started with setTimer; defaults to clearTimeout */
  clearTimer?: (timer: unknown) => void
  /** Overrides EDITOR_HEARTBEAT_EXPIRY_MS */
  heartbeatExpiry?: number
  /** Overrides DELIVERY_WAIT_MS */
  deliveryWait?: number
}

interface RegistryEntry {
  unconfirmedUpdates: number
  oldestUnconfirmedAt: number|null
  receivedAt: number
}

interface DeliveryWaiter {
  deadline: number
  timer: unknown
  check: () => void
}

/**
 * Checks that a value has the shape of an editor report.
 *
 * @param   {unknown}  value  Whatever the renderer sent
 *
 * @return  {EditorSyncReport|undefined}  The report, or undefined if the value is none
 */
function parseEditorSyncReport (value: unknown): EditorSyncReport|undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }

  const { clientID, unconfirmedUpdates, oldestUnconfirmedAt } = value as Record<string, unknown>
  if (typeof clientID !== 'string' || clientID === '') {
    return undefined
  }

  if (typeof unconfirmedUpdates !== 'number' || !Number.isInteger(unconfirmedUpdates) || unconfirmedUpdates < 0) {
    return undefined
  }

  if (oldestUnconfirmedAt === null || oldestUnconfirmedAt === undefined) {
    return { clientID, unconfirmedUpdates, oldestUnconfirmedAt: null }
  }

  if (typeof oldestUnconfirmedAt !== 'number' || !Number.isFinite(oldestUnconfirmedAt)) {
    return undefined
  }

  return { clientID, unconfirmedUpdates, oldestUnconfirmedAt }
}

export class EditorSyncRegistry {
  /** How long waitForDelivery waits by default, in milliseconds */
  public readonly deliveryWait: number
  private readonly heartbeatExpiry: number
  private readonly now: () => number
  private readonly setTimer: (callback: () => void, delay: number) => unknown
  private readonly clearTimer: (timer: unknown) => void
  /** File path, then client ID */
  private readonly entries = new Map<string, Map<string, RegistryEntry>>()
  private readonly waiters = new Map<string, Set<DeliveryWaiter>>()

  constructor (options: EditorSyncRegistryOptions = {}) {
    // The global functions are looked up when they are called, not here, so
    // that a test which replaces the global timers also reaches a registry
    // that was created before.
    this.now = options.now ?? (() => Date.now())
    this.setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay))
    this.clearTimer = options.clearTimer ?? (timer => { clearTimeout(timer as ReturnType<typeof setTimeout>) })
    this.heartbeatExpiry = options.heartbeatExpiry ?? EDITOR_HEARTBEAT_EXPIRY_MS
    this.deliveryWait = options.deliveryWait ?? DELIVERY_WAIT_MS
  }

  /**
   * Registers what an editor reported with a pull request.
   *
   * @param   {string}   filePath          The file the editor shows
   * @param   {unknown}  editorReport      The report as it arrived; it is checked here
   * @param   {number}   confirmedUpdates  How many updates of this editor the
   *                                       answer to the same pull request
   *                                       confirms. The report was written
   *                                       before the answer, so these are
   *                                       subtracted; otherwise the registry
   *                                       would keep seeing unconfirmed input
   *                                       until the next pull request.
   *
   * @return  {boolean}                    Whether the report was registered
   */
  public report (filePath: string, editorReport: unknown, confirmedUpdates: number = 0): boolean {
    const parsed = parseEditorSyncReport(editorReport)
    if (parsed === undefined) {
      return false
    }

    const confirmed = Number.isInteger(confirmedUpdates) && confirmedUpdates > 0 ? confirmedUpdates : 0
    const unconfirmedUpdates = Math.max(0, parsed.unconfirmedUpdates - confirmed)

    let entriesOfFile = this.entries.get(filePath)
    if (entriesOfFile === undefined) {
      entriesOfFile = new Map()
      this.entries.set(filePath, entriesOfFile)
    }

    entriesOfFile.set(parsed.clientID, {
      unconfirmedUpdates,
      oldestUnconfirmedAt: unconfirmedUpdates > 0 ? parsed.oldestUnconfirmedAt : null,
      receivedAt: this.now()
    })

    this.removeExpiredEntries(filePath)
    this.checkWaiters(filePath)
    return true
  }

  /**
   * Whether at least one editor holds input for the file that the document
   * manager has not confirmed, according to a report that has not expired.
   *
   * @param   {string}   filePath  The file
   *
   * @return  {boolean}            Whether there is unconfirmed input
   */
  public hasUnconfirmedInput (filePath: string): boolean {
    this.removeExpiredEntries(filePath)
    const entriesOfFile = this.entries.get(filePath)
    if (entriesOfFile === undefined) {
      return false
    }

    for (const entry of entriesOfFile.values()) {
      if (entry.unconfirmedUpdates > 0) {
        return true
      }
    }

    return false
  }

  /**
   * Lists the files for which at least one editor holds unconfirmed input.
   *
   * @return  {string[]}  The file paths
   */
  public filesWithUnconfirmedInput (): string[] {
    return [...this.entries.keys()].filter(filePath => this.hasUnconfirmedInput(filePath))
  }

  /**
   * Waits until no editor holds unconfirmed input for the file anymore. The
   * condition is checked again after every report for the file, and when a
   * report expires.
   *
   * @param   {string}            filePath  The file
   * @param   {number}            timeout   How long to wait at most, in milliseconds
   *
   * @return  {Promise<boolean>}            True if the input has been delivered
   *                                        (or there was none), false if the
   *                                        time ran out first
   */
  public async waitForDelivery (filePath: string, timeout: number = this.deliveryWait): Promise<boolean> {
    if (!this.hasUnconfirmedInput(filePath)) {
      return true
    }

    return await new Promise<boolean>(resolve => {
      const waiter: DeliveryWaiter = {
        deadline: this.now() + timeout,
        timer: undefined,
        check: () => {
          if (waiter.timer !== undefined) {
            this.clearTimer(waiter.timer)
            waiter.timer = undefined
          }

          const delivered = !this.hasUnconfirmedInput(filePath)
          const remaining = waiter.deadline - this.now()
          if (delivered || remaining <= 0) {
            const waitersOfFile = this.waiters.get(filePath)
            waitersOfFile?.delete(waiter)
            if (waitersOfFile?.size === 0) {
              this.waiters.delete(filePath)
            }
            resolve(delivered)
            return
          }

          // Wake up when the time runs out, or earlier if the last report with
          // unconfirmed input expires before that. A timer may fire a little
          // early; in that case the check simply arms it again.
          const untilExpiry = this.timeUntilNextExpiry(filePath)
          const delay = Math.max(1, Math.min(remaining, untilExpiry ?? remaining))
          waiter.timer = this.setTimer(waiter.check, delay)
        }
      }

      let waitersOfFile = this.waiters.get(filePath)
      if (waitersOfFile === undefined) {
        waitersOfFile = new Set()
        this.waiters.set(filePath, waitersOfFile)
      }
      waitersOfFile.add(waiter)
      waiter.check()
    })
  }

  /**
   * Forgets everything the editors reported for a file. Pending waits for the
   * file end as delivered: there is no editor state left to wait for.
   *
   * @param  {string}  filePath  The file
   */
  public forgetFile (filePath: string): void {
    this.entries.delete(filePath)
    this.checkWaiters(filePath)
  }

  /**
   * Returns how long it takes until the next report with unconfirmed input for
   * the file expires.
   *
   * @param   {string}            filePath  The file
   *
   * @return  {number|undefined}            The time in milliseconds, or
   *                                        undefined if there is no such report
   */
  private timeUntilNextExpiry (filePath: string): number|undefined {
    const entriesOfFile = this.entries.get(filePath)
    if (entriesOfFile === undefined) {
      return undefined
    }

    const now = this.now()
    let earliest: number|undefined
    for (const entry of entriesOfFile.values()) {
      if (entry.unconfirmedUpdates === 0) {
        continue
      }
      const untilExpiry = entry.receivedAt + this.heartbeatExpiry - now
      if (earliest === undefined || untilExpiry < earliest) {
        earliest = untilExpiry
      }
    }

    return earliest
  }

  private removeExpiredEntries (filePath: string): void {
    const entriesOfFile = this.entries.get(filePath)
    if (entriesOfFile === undefined) {
      return
    }

    const now = this.now()
    for (const [ clientID, entry ] of entriesOfFile) {
      if (now - entry.receivedAt >= this.heartbeatExpiry) {
        entriesOfFile.delete(clientID)
      }
    }

    if (entriesOfFile.size === 0) {
      this.entries.delete(filePath)
    }
  }

  private checkWaiters (filePath: string): void {
    const waitersOfFile = this.waiters.get(filePath)
    if (waitersOfFile === undefined) {
      return
    }

    // A check removes its waiter from the set when it is done, so iterate
    // over a copy.
    for (const waiter of [...waitersOfFile]) {
      waiter.check()
    }
  }
}
