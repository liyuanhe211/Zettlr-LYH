/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        checkPathKinds, revealPath, isAbsoluteWindowsPath
 * CVM-Role:        Utility Function
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH R100 (specification C12, part 2): the main
 *                  process side of the folder button behind paths in the
 *                  editor. The application command check-path-kinds tells the
 *                  renderer whether absolute Windows paths are files, folders,
 *                  missing or unknown; reveal-path opens a folder in the file
 *                  manager, or shows a file selected in its folder. Both only
 *                  call stat; they never read a folder listing or a file.
 *                  The file system and the shell are injected, so this module
 *                  does not depend on electron and can be tested directly.
 *
 * END HEADER
 */

/** What an absolute path refers to on disk */
export type PathKind = 'file' | 'directory' | 'missing' | 'unknown'

/** The part of fs.Stats this module reads */
export interface PathStats {
  isDirectory: () => boolean
}

/** The part of electron's shell this module calls */
export interface PathKindsShell {
  /** Opens the path with the system; resolves to an error message, or to an empty string on success */
  openPath: (path: string) => Promise<string>
  /** Shows the file selected in its folder */
  showItemInFolder: (fullPath: string) => void
}

/**
 * The injected dependencies. The concurrency limit, the merging of requests
 * for the same path and the unreachable network shares are shared by all calls
 * that pass the same stat function, so callers pass the same function (such as
 * fs.promises.stat) every time; a test that passes a fresh function per test
 * starts from a clean state.
 */
export interface PathKindsDependencies {
  /** Reads the metadata of a path, following symbolic links and junctions (fs.promises.stat) */
  stat: (path: string) => Promise<PathStats>
  /** The shell used by reveal-path */
  shell: PathKindsShell
  /** Starts a timer and returns a function that cancels it; defaults to the global setTimeout */
  setTimeout?: (callback: () => void, milliseconds: number) => () => void
  /** The current time in milliseconds; defaults to Date.now */
  now?: () => number
  /** How long a single path may take before it counts as unknown; defaults to 3000 */
  timeoutMilliseconds?: number
  /** Writes a line to the main process log; defaults to doing nothing */
  log?: (message: string) => void
}

export type CheckPathKindsResult = { kinds: Record<string, PathKind> } | { error: 'invalid-payload' }

export interface RevealPathResult {
  result: 'opened-folder' | 'revealed-file' | 'missing' | 'error'
  message?: string
}

/** The largest number of paths one check-path-kinds request may carry */
export const maximumPathsPerRequest = 256
/** The longest path accepted, in UTF-16 code units */
export const maximumPathLength = 32767
/** How long a single path may take by default before it counts as unknown */
export const defaultTimeoutMilliseconds = 3000
/** How many stat calls of this module may run at the same time */
export const maximumConcurrentStats = 2
/** How long a network share that timed out is skipped */
export const unreachableShareLifetimeMilliseconds = 60000

const drivePathPattern = /^[A-Za-z]:[\\/]/
const uncPathPattern = /^\\\\([^\\/\s]+)[\\/]([^\\/\s]+)/
// Control characters (including NUL and line breaks) and the characters that
// Windows does not allow in file names, apart from the separators and colon
const forbiddenCharacterPattern = /[\p{Cc}<>"|?*]/u

/**
 * Decides whether the text is an absolute Windows path (specification C12,
 * part 1, section 3): a drive path such as C:\ or C:/, or a UNC path with a
 * non-empty server and share name; no control characters, none of < > " | ? *,
 * no colon apart from the one after the drive letter, at most 32767
 * characters.
 *
 * @param   {unknown}  text  The candidate
 *
 * @return  {boolean}        True if the text is an absolute Windows path
 */
export function isAbsoluteWindowsPath (text: unknown): text is string {
  if (typeof text !== 'string' || text.length > maximumPathLength) {
    return false
  }
  if (forbiddenCharacterPattern.test(text)) {
    return false
  }
  if (drivePathPattern.test(text)) {
    return !text.includes(':', 2)
  }
  if (uncPathPattern.test(text)) {
    return !text.includes(':')
  }
  return false
}

/**
 * Returns the \\server\share prefix of a UNC path in lower case, which
 * identifies a network share; undefined for drive paths.
 *
 * @param   {string}            path  An absolute Windows path
 *
 * @return  {string|undefined}        The share prefix, or undefined
 */
function uncShareKey (path: string): string|undefined {
  const match = uncPathPattern.exec(path)
  if (match === null) {
    return undefined
  }
  return `\\\\${match[1]}\\${match[2]}`.toLowerCase()
}

/** The result of checking one path, with the reason when it is unknown */
interface StatOutcome {
  kind: PathKind
  reason?: string
}

/** One queued or running stat call, shared by all requests waiting for it */
interface StatJob {
  path: string
  /** Whether the job belongs to check-path-kinds (merged, skips unreachable shares) */
  isCheck: boolean
  started: boolean
  waiters: number
  now: () => number
  outcome: Promise<StatOutcome>
  settle: (outcome: StatOutcome) => void
}

/** The state shared by all calls that use the same stat function */
interface StatState {
  stat: (path: string) => Promise<PathStats>
  running: number
  queue: StatJob[]
  /** Queued or running check jobs by path, for merging requests */
  pendingChecks: Map<string, StatJob>
  /** Share prefix to the time until which it counts as unreachable */
  unreachableShares: Map<string, number>
}

/** The per-call settings derived from the dependencies */
interface RequestOptions {
  isCheck: boolean
  now: () => number
  startTimer: (callback: () => void, milliseconds: number) => () => void
  timeoutMilliseconds: number
}

const states = new WeakMap<PathKindsDependencies['stat'], StatState>()

const unreachableShareOutcome: StatOutcome = {
  kind: 'unknown',
  reason: 'The network share did not respond recently'
}

/**
 * Starts a timer with the global setTimeout.
 *
 * @param   {Function}  callback      Called when the timer expires
 * @param   {number}    milliseconds  The delay
 *
 * @return  {Function}                Cancels the timer
 */
function startGlobalTimer (callback: () => void, milliseconds: number): () => void {
  const handle = setTimeout(callback, milliseconds)
  return () => { clearTimeout(handle) }
}

/**
 * Returns the shared state belonging to the stat function, creating it on
 * first use.
 *
 * @param   {Function}   stat  The injected stat function
 *
 * @return  {StatState}        The shared state
 */
function stateFor (stat: PathKindsDependencies['stat']): StatState {
  let state = states.get(stat)
  if (state === undefined) {
    state = { stat, running: 0, queue: [], pendingChecks: new Map(), unreachableShares: new Map() }
    states.set(stat, state)
  }
  return state
}

/**
 * Derives the per-call settings from the dependencies.
 *
 * @param   {PathKindsDependencies}  dependencies  The injected dependencies
 * @param   {boolean}                isCheck       True for check-path-kinds
 *
 * @return  {RequestOptions}                       The settings
 */
function optionsFrom (dependencies: PathKindsDependencies, isCheck: boolean): RequestOptions {
  const timeoutMilliseconds = dependencies.timeoutMilliseconds
  return {
    isCheck,
    now: dependencies.now ?? (() => Date.now()),
    startTimer: dependencies.setTimeout ?? startGlobalTimer,
    timeoutMilliseconds: typeof timeoutMilliseconds === 'number' && timeoutMilliseconds >= 0
      ? timeoutMilliseconds
      : defaultTimeoutMilliseconds
  }
}

/**
 * Tells whether the share counts as unreachable now; forgets expired marks.
 *
 * @param   {StatState}  state  The shared state
 * @param   {string}     share  The share prefix
 * @param   {number}     now    The current time
 *
 * @return  {boolean}           True if the share is marked unreachable
 */
function isShareUnreachable (state: StatState, share: string, now: number): boolean {
  const until = state.unreachableShares.get(share)
  if (until === undefined) {
    return false
  }
  if (now < until) {
    return true
  }
  state.unreachableShares.delete(share)
  return false
}

/**
 * Maps a stat error to a path kind: ENOENT and ENOTDIR mean missing, anything
 * else (EPERM, EACCES, EBUSY, network errors and so on) unknown.
 *
 * @param   {unknown}      error  The error thrown by stat
 *
 * @return  {StatOutcome}         The outcome
 */
function outcomeForError (error: unknown): StatOutcome {
  let code: string|undefined
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    code = error.code
  }
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return { kind: 'missing' }
  }
  const detail = code ?? (error instanceof Error ? error.message : String(error))
  return { kind: 'unknown', reason: `The path could not be checked (${detail})` }
}

/**
 * Removes a job from the merging table if the table still points to it.
 *
 * @param   {StatState}  state  The shared state
 * @param   {StatJob}    job    The job
 */
function forgetJob (state: StatState, job: StatJob): void {
  if (state.pendingChecks.get(job.path) === job) {
    state.pendingChecks.delete(job.path)
  }
}

/**
 * Runs the stat call of a job and starts the next queued jobs afterwards. The
 * slot stays taken until stat settles, even if every request has stopped
 * waiting, because the call keeps occupying a thread of the file thread pool.
 *
 * @param   {StatState}  state  The shared state
 * @param   {StatJob}    job    The job to run
 */
async function runJob (state: StatState, job: StatJob): Promise<void> {
  try {
    const stats = await state.stat(job.path)
    job.settle({ kind: stats.isDirectory() ? 'directory' : 'file' })
  } catch (error: unknown) {
    job.settle(outcomeForError(error))
  } finally {
    state.running--
    forgetJob(state, job)
    startQueuedJobs(state)
  }
}

/**
 * Starts queued jobs while fewer than the maximum number of stat calls run.
 * A check job whose network share has been marked unreachable in the meantime
 * finishes as unknown without calling stat.
 *
 * @param   {StatState}  state  The shared state
 */
function startQueuedJobs (state: StatState): void {
  while (state.running < maximumConcurrentStats) {
    const job = state.queue.shift()
    if (job === undefined) {
      return
    }
    const share = uncShareKey(job.path)
    if (job.isCheck && share !== undefined && isShareUnreachable(state, share, job.now())) {
      forgetJob(state, job)
      job.settle(unreachableShareOutcome)
      continue
    }
    job.started = true
    state.running++
    void runJob(state, job)
  }
}

/**
 * Waits for the outcome of a job for at most the timeout. On timeout the
 * result is unknown and a late outcome is discarded; if the job was still
 * queued and nobody else waits for it, it is dropped without calling stat; if
 * stat was already running for a UNC path, its share is marked unreachable.
 *
 * @param   {StatState}       state    The shared state
 * @param   {StatJob}         job      The job
 * @param   {RequestOptions}  options  The per-call settings
 *
 * @return  {Promise<StatOutcome>}     The outcome
 */
async function waitForOutcome (state: StatState, job: StatJob, options: RequestOptions): Promise<StatOutcome> {
  return await new Promise<StatOutcome>(resolve => {
    let finished = false
    const cancelTimer = options.startTimer(() => {
      if (finished) {
        return
      }
      finished = true
      job.waiters--
      if (!job.started) {
        if (job.waiters === 0) {
          const index = state.queue.indexOf(job)
          if (index >= 0) {
            state.queue.splice(index, 1)
          }
          forgetJob(state, job)
        }
      } else {
        const share = uncShareKey(job.path)
        if (share !== undefined) {
          state.unreachableShares.set(share, options.now() + unreachableShareLifetimeMilliseconds)
        }
      }
      resolve({ kind: 'unknown', reason: `Checking the path timed out after ${options.timeoutMilliseconds} ms` })
    }, options.timeoutMilliseconds)

    void job.outcome.then(outcome => {
      if (finished) {
        return
      }
      finished = true
      job.waiters--
      cancelTimer()
      resolve(outcome)
    })
  })
}

/**
 * Checks one path. Check requests for a path that is already queued or being
 * checked share that call; check requests below a share marked unreachable
 * return unknown at once. reveal-path always gets a call of its own.
 *
 * @param   {StatState}       state    The shared state
 * @param   {string}          path     An absolute Windows path
 * @param   {RequestOptions}  options  The per-call settings
 *
 * @return  {Promise<StatOutcome>}     The outcome
 */
async function requestOutcome (state: StatState, path: string, options: RequestOptions): Promise<StatOutcome> {
  const share = uncShareKey(path)
  if (options.isCheck && share !== undefined && isShareUnreachable(state, share, options.now())) {
    return unreachableShareOutcome
  }

  let job = options.isCheck ? state.pendingChecks.get(path) : undefined
  const isNewJob = job === undefined
  if (job === undefined) {
    let settle: (outcome: StatOutcome) => void = () => {}
    const outcome = new Promise<StatOutcome>(resolve => { settle = resolve })
    job = { path, isCheck: options.isCheck, started: false, waiters: 0, now: options.now, outcome, settle }
    if (options.isCheck) {
      state.pendingChecks.set(path, job)
    }
    state.queue.push(job)
  }
  job.waiters++
  if (isNewJob) {
    startQueuedJobs(state)
  }
  return await waitForOutcome(state, job, options)
}

/**
 * Narrows an unknown value to a plain object.
 *
 * @param   {unknown}  value  The value
 *
 * @return  {boolean}         True for a non-null, non-array object
 */
function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The application command check-path-kinds: { paths: string[] } with 1 to 256
 * absolute Windows paths. Returns { kinds } keyed by the input strings, or
 * { error: 'invalid-payload' } without checking anything if any item is not a
 * string or not an absolute Windows path, or the count is out of range.
 *
 * @param   {unknown}                payload       The request payload
 * @param   {PathKindsDependencies}  dependencies  The injected dependencies
 *
 * @return  {Promise<CheckPathKindsResult>}        The kinds, or the payload error
 */
export async function checkPathKinds (payload: unknown, dependencies: PathKindsDependencies): Promise<CheckPathKindsResult> {
  const invalid: CheckPathKindsResult = { error: 'invalid-payload' }
  if (!isRecord(payload)) {
    return invalid
  }
  const items: unknown = payload.paths
  if (!Array.isArray(items) || items.length < 1 || items.length > maximumPathsPerRequest) {
    return invalid
  }
  const paths: string[] = []
  // An index loop, so that holes in a sparse array are rejected as well
  for (let i = 0; i < items.length; i++) {
    const item: unknown = items[i]
    if (!isAbsoluteWindowsPath(item)) {
      return invalid
    }
    paths.push(item)
  }

  const state = stateFor(dependencies.stat)
  const options = optionsFrom(dependencies, true)
  const uniquePaths = [...new Set(paths)]
  const outcomes = await Promise.all(uniquePaths.map(async path => await requestOutcome(state, path, options)))

  const kinds: Record<string, PathKind> = {}
  for (let i = 0; i < uniquePaths.length; i++) {
    kinds[uniquePaths[i]] = outcomes[i].kind
  }
  return { kinds }
}

/**
 * The application command reveal-path: { path: string }. Checks the path again
 * with stat (never from a cache), then opens a folder with shell.openPath, or
 * shows a file selected in its folder with shell.showItemInFolder. A file is
 * never passed to shell.openPath, since that would open or run it.
 *
 * @param   {unknown}                payload       The request payload
 * @param   {PathKindsDependencies}  dependencies  The injected dependencies
 *
 * @return  {Promise<RevealPathResult>}            What happened
 */
export async function revealPath (payload: unknown, dependencies: PathKindsDependencies): Promise<RevealPathResult> {
  if (!isRecord(payload)) {
    return { result: 'error', message: 'invalid-payload' }
  }
  const target: unknown = payload.path
  if (!isAbsoluteWindowsPath(target)) {
    return { result: 'error', message: 'invalid-payload' }
  }

  const log = dependencies.log ?? (() => {})
  const outcome = await requestOutcome(stateFor(dependencies.stat), target, optionsFrom(dependencies, false))

  if (outcome.kind === 'directory') {
    let failure: string
    try {
      failure = await dependencies.shell.openPath(target)
    } catch (error: unknown) {
      failure = error instanceof Error ? error.message : String(error)
    }
    if (failure === '') {
      return { result: 'opened-folder' }
    }
    log(`[Application] Could not open the folder ${target}: ${failure}`)
    return { result: 'error', message: failure }
  } else if (outcome.kind === 'file') {
    try {
      dependencies.shell.showItemInFolder(target)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      log(`[Application] Could not show the file ${target} in its folder: ${message}`)
      return { result: 'error', message }
    }
    return { result: 'revealed-file' }
  } else if (outcome.kind === 'missing') {
    return { result: 'missing' }
  } else {
    const message = outcome.reason ?? 'The path could not be checked'
    log(`[Application] Could not reveal the path ${target}: ${message}`)
    return { result: 'error', message }
  }
}
