/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ClosedTabHistory
 * CVM-Role:        Model
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH reopen closed tab (R43): the in-memory stack of
 *                  recently closed tabs behind Ctrl+Shift+T. Every closed tab
 *                  is pushed as one record (window, editor pane, file, its
 *                  position in the tab bar, whether it was pinned, and when it
 *                  was closed); at most CLOSED_TAB_HISTORY_LIMIT records are
 *                  kept, dropping the oldest. Reopening pops records from the
 *                  top until the caller's judgement finds one that can be
 *                  restored. This module deliberately depends on neither
 *                  electron nor fs, so that it can be tested directly.
 *
 * END HEADER
 */

/**
 * The maximum number of closed tabs that are remembered.
 */
export const CLOSED_TAB_HISTORY_LIMIT = 30

/**
 * Describes one closed tab.
 */
export interface ClosedTabRecord {
  /**
   * The window the tab was closed in
   */
  windowId: string
  /**
   * The editor pane (leaf) the tab was closed in
   */
  leafId: string
  /**
   * The absolute path of the file the tab showed
   */
  filePath: string
  /**
   * The position of the tab in the tab bar of its editor pane, counted from
   * zero, right before it was closed
   */
  index: number
  /**
   * Whether the tab was pinned when it was closed
   */
  pinned: boolean
  /**
   * Timestamp (ms since epoch) of when the tab was closed
   */
  closedAt: number
}

/**
 * Why a popped record could not be restored:
 * - already-open: the target editor pane already shows the file
 * - missing:      the file no longer exists and there is nothing to restore it from
 */
export type ClosedTabSkipReason = 'already-open'|'missing'

/**
 * The caller's judgement of a popped record: either it can be restored (and
 * the caller may attach whatever it worked out while judging, e.g. the target
 * pane), or it is skipped for the given reason.
 */
export type ClosedTabJudgement<Plan> = { restorable: true, plan: Plan }
  | { restorable: false, reason: ClosedTabSkipReason }

/**
 * The result of popping: the first restorable record (if any) together with
 * the caller's plan for it, and every record that was skipped on the way.
 */
export interface ClosedTabPopResult<Plan> {
  restorable: { record: ClosedTabRecord, plan: Plan }|undefined
  skipped: Array<{ record: ClosedTabRecord, reason: ClosedTabSkipReason }>
}

export class ClosedTabHistory {
  /**
   * The records, oldest first; the last element is the top of the stack.
   */
  private readonly _records: ClosedTabRecord[]

  /**
   * @param  {number}  _limit  The maximum number of records to keep
   */
  constructor (private readonly _limit = CLOSED_TAB_HISTORY_LIMIT) {
    this._records = []
  }

  /**
   * Returns the number of records currently remembered.
   *
   * @return  {number}  The number of records
   */
  public get size (): number {
    return this._records.length
  }

  /**
   * Returns a copy of all records, the most recently closed tab first.
   *
   * @return  {ClosedTabRecord[]}  The records
   */
  public list (): ClosedTabRecord[] {
    return this._records.map(record => ({ ...record })).reverse()
  }

  /**
   * Pushes a closed tab on top of the stack. If the stack then holds more
   * records than allowed, the oldest records are dropped.
   *
   * @param  {ClosedTabRecord}  record  The closed tab
   */
  public push (record: ClosedTabRecord): void {
    this._records.push({ ...record })
    while (this._records.length > this._limit) {
      this._records.shift()
    }
  }

  /**
   * Drops every record of the given file, e.g. after the file's content has
   * been restored from elsewhere, so that the remaining records can no longer
   * be restored.
   *
   * @param   {(filePath: string) => boolean}  matches  Whether a record's file is the file in question
   *
   * @return  {ClosedTabRecord[]}                       The dropped records
   */
  public removeWhere (matches: (filePath: string) => boolean): ClosedTabRecord[] {
    const dropped: ClosedTabRecord[] = []
    for (let index = this._records.length - 1; index >= 0; index--) {
      if (matches(this._records[index].filePath)) {
        dropped.push(...this._records.splice(index, 1))
      }
    }
    return dropped
  }

  /**
   * Pops records from the top of the stack until the judgement finds one that
   * can be restored. Each popped record is removed from the stack before it is
   * judged, so that concurrent calls never judge the same record. Records the
   * judgement rejects are dropped and returned in the order they were popped.
   * If no record is restorable, the stack ends up empty.
   *
   * @param   {(record: ClosedTabRecord) => Promise<ClosedTabJudgement<Plan>>|ClosedTabJudgement<Plan>}  judge  Decides about one record
   *
   * @return  {Promise<ClosedTabPopResult<Plan>>}  The restorable record and the skipped ones
   */
  public async popFirstRestorable<Plan> (
    judge: (record: ClosedTabRecord) => Promise<ClosedTabJudgement<Plan>>|ClosedTabJudgement<Plan>
  ): Promise<ClosedTabPopResult<Plan>> {
    const skipped: ClosedTabPopResult<Plan>['skipped'] = []

    let record = this._records.pop()
    while (record !== undefined) {
      const judgement = await judge(record)
      if (judgement.restorable) {
        return { restorable: { record, plan: judgement.plan }, skipped }
      }

      skipped.push({ record, reason: judgement.reason })
      record = this._records.pop()
    }

    return { restorable: undefined, skipped }
  }
}
