/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        installResizeObserverDiagnostics,
 *                  uninstallResizeObserverDiagnostics, isDevelopmentBuild,
 *                  readResizeObserverRecords, collectResizeObserverDiagnosis,
 *                  formatResizeObserverDiagnosis
 * CVM-Role:        Utility
 * License:         GNU GPL v3
 *
 * Description:     A development-only diagnosis of the error "ResizeObserver
 *                  loop completed with undelivered notifications.". The
 *                  browser reports that error without a stack and without
 *                  saying which observer caused it. In development builds,
 *                  window.ResizeObserver is replaced by a subclass that
 *                  remembers where each observer was constructed and, before
 *                  each callback, measures the elements that the live
 *                  observers watch: a size that changed since the previous
 *                  callback of the same frame was changed by that previous
 *                  callback. Only the most recent records are kept. When the
 *                  loop error fires, the records of that frame and the
 *                  construction stacks of the observers involved are added to
 *                  the runtime error report. Production builds keep the
 *                  native ResizeObserver.
 *
 * END HEADER
 */

/** The start of the message of the loop error */
export const RESIZE_OBSERVER_LOOP_MESSAGE = 'ResizeObserver loop'
/** How many callback records are kept in total */
export const MAX_RECORDS = 24
/** How many callback records of one frame are kept */
export const MAX_RECORDS_PER_FRAME = 8
/** How many observed elements are measured before a callback at most */
export const MAX_MEASURED_TARGETS = 48
/** How long the diagnosis text in a report may be (the log keeps 4000 characters of a stack) */
export const MAX_DIAGNOSIS_LENGTH = 3800
/** The start of the diagnosis text in a report */
export const DIAGNOSIS_PREFIX = 'ResizeObserver diagnosis: '

const MAX_STACK_FRAMES = 6
const MAX_DELIVERED_PER_RECORD = 4
const MAX_CHANGES_PER_RECORD = 6
const STACK_SEPARATOR = ' <- '

/** A content box size: width and height in pixels */
export type BoxSize = [ number, number ]

/** The size of an element as a callback received it */
export interface DeliveredSize {
  target: string
  width: number
  height: number
}

/** An observed element whose size changed between two measurements */
export interface SizeChange {
  target: string
  from: BoxSize
  to: BoxSize
  /** The observers that watch this element */
  observedBy: number[]
}

/** One callback invocation of one observer */
export interface InvocationRecord {
  /** Counts the frames in which callbacks ran */
  frame: number
  /** The round of the observer loop within the frame (estimated from the observer order) */
  round: number
  observerId: number
  /** The first few entries the callback received */
  delivered: DeliveredSize[]
  /**
   * The observed elements whose size changed between the start of this
   * callback and the start of the next one in the same frame, or the loop
   * error if this was the last one
   */
  changedAfterwards: SizeChange[]
}

/** What a loop error report carries */
export interface ResizeObserverDiagnosis {
  frame: number
  records: InvocationRecord[]
  /** The construction stack of every observer named in the records */
  observers: Record<string, string>
  /** Whether more elements were observed than were measured */
  measurementTruncated: boolean
}

interface ObserverInfo {
  id: number
  stack: string
  targets: Set<Element>
}

interface DiagnosisState {
  native: typeof ResizeObserver
  infos: WeakMap<object, ObserverInfo>
  live: Map<number, ObserverInfo>
  nextId: number
  records: InvocationRecord[]
  frame: number
  frameOpen: boolean
  round: number
  lastObserverIdInFrame: number
  previousSnapshot: Map<Element, BoxSize|null>|null
  previousRecord: InvocationRecord|null
  measurementTruncated: boolean
}

let state: DiagnosisState|null = null

/**
 * Whether this is a development build. Webpack replaces the expression
 * process.env.NODE_ENV with the build mode ('development' while the
 * development server runs, 'production' in packaged builds).
 *
 * @return  {boolean}  Whether the diagnosis may be installed
 */
export function isDevelopmentBuild (): boolean {
  try {
    const mode = process.env.NODE_ENV
    return mode === 'development' || mode === 'develop'
  } catch (_err) {
    return false
  }
}

function roundSize (value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Describes an element by tag, id and the first three classes.
 */
function describeElement (element: Element): string {
  let text = typeof element.tagName === 'string' ? element.tagName.toLowerCase() : 'unknown'
  if (typeof element.id === 'string' && element.id !== '') {
    text += '#' + element.id
  }
  const classes = typeof element.className === 'string'
    ? element.className.trim().split(/\s+/).filter(name => name !== '').slice(0, 3)
    : []
  if (classes.length > 0) {
    text += '.' + classes.join('.')
  }
  return text.length > 80 ? text.slice(0, 79) + '…' : text
}

/**
 * Measures the content box of an element, as a ResizeObserver does by
 * default: without borders, padding and scrollbars.
 */
function measureContentBox (element: Element): BoxSize|null {
  const htmlElement = element as HTMLElement
  if (!element.isConnected || typeof htmlElement.getBoundingClientRect !== 'function') {
    return null
  }
  const style = window.getComputedStyle(htmlElement)
  const pixels = (value: string): number => parseFloat(value) || 0
  const rectangle = htmlElement.getBoundingClientRect()
  const borderX = pixels(style.borderLeftWidth) + pixels(style.borderRightWidth)
  const borderY = pixels(style.borderTopWidth) + pixels(style.borderBottomWidth)
  const scrollbarX = Math.max(0, (htmlElement.offsetWidth ?? 0) - (htmlElement.clientWidth ?? 0) - borderX)
  const scrollbarY = Math.max(0, (htmlElement.offsetHeight ?? 0) - (htmlElement.clientHeight ?? 0) - borderY)
  const width = rectangle.width - borderX - pixels(style.paddingLeft) - pixels(style.paddingRight) - scrollbarX
  const height = rectangle.height - borderY - pixels(style.paddingTop) - pixels(style.paddingBottom) - scrollbarY
  return [ roundSize(width), roundSize(height) ]
}

/**
 * Shortens one stack frame: drops the leading "at" and every directory and
 * server address, so that only the function, the file name, line and column
 * remain.
 */
function shortenFrame (frame: string): string {
  return frame
    .replace(/^at\s+/, '')
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s()]*\/([^/\s()]+)/gi, '$1')
}

/**
 * The stack of the code that constructs an observer, without the frames of
 * this module, on one line.
 */
function constructionStack (): string {
  const frames = (new Error().stack ?? '')
    .split('\n')
    .slice(1)
    .map(line => line.trim())
    .filter(line => line !== '' && !line.includes('DiagnosedResizeObserver') && !line.includes('constructionStack'))
  return frames.slice(0, MAX_STACK_FRAMES).map(shortenFrame).join(STACK_SEPARATOR)
}

/**
 * Measures every element that a live observer watches, at most
 * MAX_MEASURED_TARGETS of them. Elements that left the document are
 * forgotten, and so are observers that no longer watch anything.
 */
function takeSnapshot (current: DiagnosisState): Map<Element, BoxSize|null> {
  const sizes = new Map<Element, BoxSize|null>()
  for (const [ id, info ] of current.live) {
    for (const target of info.targets) {
      if (!target.isConnected) {
        info.targets.delete(target)
        continue
      }
      if (sizes.has(target)) {
        continue
      }
      if (sizes.size >= MAX_MEASURED_TARGETS) {
        current.measurementTruncated = true
        continue
      }
      sizes.set(target, measureContentBox(target))
    }
    if (info.targets.size === 0) {
      current.live.delete(id)
    }
  }
  return sizes
}

function compareSnapshots (current: DiagnosisState, before: Map<Element, BoxSize|null>, after: Map<Element, BoxSize|null>): SizeChange[] {
  const changes: SizeChange[] = []
  for (const [ target, size ] of after) {
    const old = before.get(target)
    if (old === undefined || old === null || size === null) {
      continue
    }
    if (Math.abs(old[0] - size[0]) <= 0.05 && Math.abs(old[1] - size[1]) <= 0.05) {
      continue
    }
    const observedBy: number[] = []
    for (const info of current.live.values()) {
      if (info.targets.has(target)) {
        observedBy.push(info.id)
      }
    }
    changes.push({ target: describeElement(target), from: old, to: size, observedBy })
    if (changes.length >= MAX_CHANGES_PER_RECORD) {
      break
    }
  }
  return changes
}

function pushRecord (current: DiagnosisState, record: InvocationRecord): void {
  current.records.push(record)
  const recordsOfFrame = current.records.filter(item => item.frame === record.frame).length
  if (recordsOfFrame > MAX_RECORDS_PER_FRAME) {
    const oldest = current.records.findIndex(item => item.frame === record.frame)
    current.records.splice(oldest, 1)
  }
  if (current.records.length > MAX_RECORDS) {
    current.records.splice(0, current.records.length - MAX_RECORDS)
  }
}

/**
 * Runs before every callback: starts a new frame if necessary, attributes the
 * size changes since the previous callback to it, and records this one.
 */
function beforeInvocation (current: DiagnosisState, info: ObserverInfo, entries: ResizeObserverEntry[]): void {
  if (!current.frameOpen) {
    // All callbacks of one frame run within one task, so the frame ends with
    // the next task
    current.frameOpen = true
    current.frame++
    current.round = 0
    current.lastObserverIdInFrame = 0
    current.previousSnapshot = null
    current.previousRecord = null
    setTimeout(() => { current.frameOpen = false }, 0)
  } else if (info.id <= current.lastObserverIdInFrame) {
    // The browser calls the observers in the order of their construction
    current.round++
  }
  current.lastObserverIdInFrame = info.id

  for (const entry of entries) {
    info.targets.add(entry.target)
  }
  current.live.set(info.id, info)

  const snapshot = takeSnapshot(current)
  if (current.previousRecord !== null && current.previousSnapshot !== null) {
    current.previousRecord.changedAfterwards = compareSnapshots(current, current.previousSnapshot, snapshot)
  }
  current.previousSnapshot = snapshot

  const record: InvocationRecord = {
    frame: current.frame,
    round: current.round,
    observerId: info.id,
    delivered: entries.slice(0, MAX_DELIVERED_PER_RECORD).map(entry => ({
      target: describeElement(entry.target),
      width: roundSize(entry.contentRect.width),
      height: roundSize(entry.contentRect.height)
    })),
    changedAfterwards: []
  }
  current.previousRecord = record
  pushRecord(current, record)
}

/**
 * Replaces window.ResizeObserver with the diagnosing subclass, but only in
 * development builds (or when explicitly enabled), and only once.
 *
 * @param   {boolean}  enabled  Whether to install; defaults to isDevelopmentBuild()
 *
 * @return  {boolean}           Whether the diagnosis was installed by this call
 */
export function installResizeObserverDiagnostics (enabled: boolean = isDevelopmentBuild()): boolean {
  if (!enabled || state !== null || typeof window.ResizeObserver !== 'function') {
    return false
  }

  const native = window.ResizeObserver
  const current: DiagnosisState = {
    native,
    infos: new WeakMap(),
    live: new Map(),
    nextId: 1,
    records: [],
    frame: 0,
    frameOpen: false,
    round: 0,
    lastObserverIdInFrame: 0,
    previousSnapshot: null,
    previousRecord: null,
    measurementTruncated: false
  }
  state = current

  class DiagnosedResizeObserver extends native {
    constructor (callback: ResizeObserverCallback) {
      const info: ObserverInfo = { id: current.nextId++, stack: constructionStack(), targets: new Set() }
      super((entries, observer) => {
        try {
          beforeInvocation(current, info, entries)
        } catch (err) {
          // The diagnosis must never keep a callback from running
          console.error('[ResizeObserver Diagnosis] Could not record a callback', err)
        }
        callback(entries, observer)
      })
      current.infos.set(this, info)
    }

    observe (target: Element, options?: ResizeObserverOptions): void {
      const info = current.infos.get(this)
      if (info !== undefined) {
        info.targets.add(target)
        current.live.set(info.id, info)
      }
      super.observe(target, options)
    }

    unobserve (target: Element): void {
      const info = current.infos.get(this)
      if (info !== undefined) {
        info.targets.delete(target)
        if (info.targets.size === 0) {
          current.live.delete(info.id)
        }
      }
      super.unobserve(target)
    }

    disconnect (): void {
      const info = current.infos.get(this)
      if (info !== undefined) {
        info.targets.clear()
        current.live.delete(info.id)
      }
      super.disconnect()
    }
  }

  window.ResizeObserver = DiagnosedResizeObserver
  return true
}

/**
 * Restores the native ResizeObserver and forgets all records. Observers that
 * were constructed in the meantime keep working.
 */
export function uninstallResizeObserverDiagnostics (): void {
  if (state === null) {
    return
  }
  window.ResizeObserver = state.native
  state = null
}

/**
 * Returns copies of all callback records that are kept (the most recent
 * ones), or an empty list if the diagnosis is not installed.
 *
 * @return  {InvocationRecord[]}  The records, oldest first
 */
export function readResizeObserverRecords (): InvocationRecord[] {
  return state === null ? [] : structuredCloneRecords(state.records)
}

function structuredCloneRecords (records: InvocationRecord[]): InvocationRecord[] {
  return JSON.parse(JSON.stringify(records)) as InvocationRecord[]
}

/**
 * Collects the diagnosis for a loop error: the records of the most recent
 * frame and the construction stacks of the observers involved. While that
 * frame is still running (the browser fires the loop error at its end), the
 * changes after the last callback are measured, too.
 *
 * @return  {ResizeObserverDiagnosis|undefined}  The diagnosis, or undefined if there is nothing to report
 */
export function collectResizeObserverDiagnosis (): ResizeObserverDiagnosis|undefined {
  const current = state
  if (current === null || current.records.length === 0) {
    return undefined
  }

  if (current.frameOpen && current.previousRecord !== null && current.previousSnapshot !== null) {
    current.previousRecord.changedAfterwards = compareSnapshots(current, current.previousSnapshot, takeSnapshot(current))
  }

  const frame = current.records[current.records.length - 1].frame
  const records = structuredCloneRecords(current.records.filter(record => record.frame === frame))
  const observers: Record<string, string> = {}
  const remember = (id: number): void => {
    const info = current.live.get(id)
    if (info !== undefined) {
      observers[String(id)] = info.stack
    }
  }
  for (const record of records) {
    remember(record.observerId)
    for (const change of record.changedAfterwards) {
      change.observedBy.forEach(remember)
    }
  }

  return { frame, records, observers, measurementTruncated: current.measurementTruncated }
}

/**
 * Writes a diagnosis as one line of text: DIAGNOSIS_PREFIX followed by JSON.
 * One line without "at" frames keeps the signature of the runtime error log
 * entry the same as without the diagnosis. If the text is too long, the
 * oldest records are dropped first, then stack frames.
 *
 * @param   {ResizeObserverDiagnosis}  diagnosis  The diagnosis
 * @param   {number}                   maxLength  The maximum length of the text
 *
 * @return  {string}                              The text
 */
export function formatResizeObserverDiagnosis (diagnosis: ResizeObserverDiagnosis, maxLength: number = MAX_DIAGNOSIS_LENGTH): string {
  let records = diagnosis.records
  let stackFrames = MAX_STACK_FRAMES
  for (;;) {
    const observers: Record<string, string> = {}
    for (const record of records) {
      const ids = [ record.observerId, ...record.changedAfterwards.flatMap(change => change.observedBy) ]
      for (const id of ids) {
        const stack = diagnosis.observers[String(id)]
        if (stack !== undefined) {
          observers[String(id)] = stack.split(STACK_SEPARATOR).slice(0, stackFrames).join(STACK_SEPARATOR)
        }
      }
    }
    const text = DIAGNOSIS_PREFIX + JSON.stringify({
      frame: diagnosis.frame,
      droppedRecords: diagnosis.records.length - records.length,
      measurementTruncated: diagnosis.measurementTruncated,
      records: records.map(({ frame: _frame, ...rest }) => rest),
      observers
    })
    if (text.length <= maxLength) {
      return text
    }
    if (records.length > 1) {
      records = records.slice(1)
    } else if (stackFrames > 2) {
      stackFrames--
    } else {
      return text.slice(0, maxLength - 1) + '…'
    }
  }
}
