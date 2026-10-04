/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        PptxPreviewWorkerClient
 * CVM-Role:        Controller
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Client of the resident Python worker process that converts
 *                  pandoc slide Markdown chunks into per-slide PNG renderings
 *                  (resources/pptx-preview/pptx_preview_worker.py; its module
 *                  docstring is the protocol specification). The client spawns
 *                  the worker lazily, speaks the JSON-Lines protocol over
 *                  stdin/stdout, keeps at most one request in flight (further
 *                  requests queue internally), applies a per-request timeout,
 *                  and respawns the worker on the next request after a crash,
 *                  timeout, or shutdown. Every dependency (python path, worker
 *                  script path, logger) is injected, and the module does not
 *                  import Electron, so it can be exercised outside of it.
 *
 * END HEADER
 */

import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import type { PptxPreviewOverflowEntry, PptxPreviewUndersizedEntry } from '@dts/common/pptx-preview'

const DEFAULT_REQUEST_TIMEOUT_MILLISECONDS = 120_000
const SHUTDOWN_REPLY_TIMEOUT_MILLISECONDS = 10_000
const EXIT_WAIT_TIMEOUT_MILLISECONDS = 5_000

/**
 * Minimal logger interface used by the client (injected so that the module
 * stays free of Electron/provider dependencies)
 */
export interface PptxWorkerLogger {
  info: (message: string) => void
  error: (message: string) => void
}

/**
 * Construction options of the worker client
 */
export interface PptxWorkerClientOptions {
  /**
   * Absolute path of the Python interpreter used to run the worker
   */
  pythonPath: string
  /**
   * Absolute path of pptx_preview_worker.py
   */
  workerScriptPath: string
  /**
   * Receives the client's own log lines and the worker's stderr lines
   */
  logger: PptxWorkerLogger
  /**
   * Per-request timeout (defaults to 120 seconds). Also limits how long the
   * client waits for the worker's initial ready line.
   */
  requestTimeoutMilliseconds?: number
}

/**
 * One chunk of a convert_batch request, exactly as the worker protocol expects
 */
export interface PptxWorkerChunk {
  key: string
  text: string
  kind: 'metadata'|'slide'
}

/**
 * The per-chunk outcome of a successful batch, with the worker's snake_case
 * finding entries already normalized to the shared preview types
 */
export interface PptxWorkerChunkResult {
  key: string
  /**
   * File names (not paths) of the rendered images inside the cache directory
   */
  images: string[]
  overflow: PptxPreviewOverflowEntry[]
  undersized: PptxPreviewUndersizedEntry[]
}

/**
 * A normalized worker reply to a convert_batch request
 */
export type PptxWorkerBatchReply =
  { ok: true, ambiguous: false, results: PptxWorkerChunkResult[] } |
  { ok: true, ambiguous: true, slideCount: number } |
  { ok: false, error: string }

/**
 * Thrown (as a promise rejection) when the worker process cannot be started
 * at all -- as opposed to a started worker failing a request. Callers use this
 * distinction to fail a whole preview cycle instead of a single batch.
 */
export class WorkerStartError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'WorkerStartError'
  }
}

interface PendingRequest {
  resolve: (reply: PptxWorkerBatchReply) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/**
 * Normalizes the worker's snake_case overflow/undersized finding lists (as
 * found in protocol replies and in the sidecar JSON files it writes into the
 * cache directory) into the camelCase shared preview types. Malformed entries
 * are dropped field-by-field with safe defaults.
 *
 * @param   {Record<string, unknown>}  raw  An object possibly carrying
 *                                          overflow/undersized arrays
 *
 * @return  The normalized finding lists
 */
export function normalizeWorkerFindings (raw: Record<string, unknown>): { overflow: PptxPreviewOverflowEntry[], undersized: PptxPreviewUndersizedEntry[] } {
  const overflow: PptxPreviewOverflowEntry[] = []
  if (Array.isArray(raw.overflow)) {
    for (const entry of raw.overflow) {
      if (typeof entry === 'object' && entry !== null) {
        const record = entry as Record<string, unknown>
        overflow.push({
          shape: typeof record.shape === 'string' ? record.shape : '',
          excessPt: typeof record.excess_pt === 'number' ? record.excess_pt : 0
        })
      }
    }
  }

  const undersized: PptxPreviewUndersizedEntry[] = []
  if (Array.isArray(raw.undersized)) {
    for (const entry of raw.undersized) {
      if (typeof entry === 'object' && entry !== null) {
        const record = entry as Record<string, unknown>
        undersized.push({
          shape: typeof record.shape === 'string' ? record.shape : '',
          sizePt: typeof record.size_pt === 'number' ? record.size_pt : 0,
          snippet: typeof record.snippet === 'string' ? record.snippet : ''
        })
      }
    }
  }

  return { overflow, undersized }
}

function normalizeChunkResult (raw: Record<string, unknown>): PptxWorkerChunkResult {
  const images = Array.isArray(raw.images)
    ? raw.images.filter((name): name is string => typeof name === 'string')
    : []
  const findings = normalizeWorkerFindings(raw)
  return {
    key: typeof raw.key === 'string' ? raw.key : '',
    images,
    overflow: findings.overflow,
    undersized: findings.undersized
  }
}

function normalizeReply (message: Record<string, unknown>): PptxWorkerBatchReply {
  if (message.ok !== true) {
    return {
      ok: false,
      error: typeof message.error === 'string' ? message.error : 'unknown worker error'
    }
  }

  if (message.ambiguous === true) {
    return {
      ok: true,
      ambiguous: true,
      slideCount: typeof message.slide_count === 'number' ? message.slide_count : 0
    }
  }

  const results: PptxWorkerChunkResult[] = []
  if (Array.isArray(message.results)) {
    for (const entry of message.results) {
      if (typeof entry === 'object' && entry !== null) {
        results.push(normalizeChunkResult(entry as Record<string, unknown>))
      }
    }
  }
  return { ok: true, ambiguous: false, results }
}

async function waitForExit (child: ChildProcess, timeoutMilliseconds: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true
  }
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => { resolve(false) }, timeoutMilliseconds)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

export class PptxPreviewWorkerClient {
  private readonly pythonPath: string
  private readonly workerScriptPath: string
  private readonly logger: PptxWorkerLogger
  private readonly requestTimeoutMilliseconds: number

  private childProcess: ChildProcess|null = null
  private readyPromise: Promise<void>|null = null
  private readyResolve: (() => void)|null = null
  private readyReject: ((error: Error) => void)|null = null
  private readyTimer: NodeJS.Timeout|null = null

  private stdoutBuffer = ''
  private stderrBuffer = ''
  private nextRequestId = 0
  private readonly pendingRequests = new Map<number, PendingRequest>()
  private queueTail: Promise<unknown> = Promise.resolve()
  private expectingExit = false

  constructor (options: PptxWorkerClientOptions) {
    this.pythonPath = options.pythonPath
    this.workerScriptPath = options.workerScriptPath
    this.logger = options.logger
    this.requestTimeoutMilliseconds = options.requestTimeoutMilliseconds ?? DEFAULT_REQUEST_TIMEOUT_MILLISECONDS
  }

  /**
   * Converts one batch of chunks. Requests are serialized internally: a call
   * made while another request is in flight waits for its turn. The worker is
   * (re-)spawned when necessary. Rejects with WorkerStartError when the worker
   * cannot be started, and with a plain Error on timeout or unexpected exit.
   *
   * @param   {PptxWorkerChunk[]}  chunks          The chunks of the batch
   * @param   {string}             cacheDirectory  Where images/sidecars go
   * @param   {number}             widthPixels     Export width of the images
   * @param   {string}             templatePath    The .potx to render against
   *
   * @return  {Promise<PptxWorkerBatchReply>}      The normalized reply
   */
  public async convertBatch (chunks: PptxWorkerChunk[], cacheDirectory: string, widthPixels: number, templatePath: string): Promise<PptxWorkerBatchReply> {
    return await this.enqueue(async () => {
      await this.ensureStarted()
      return await this.sendRequest({
        action: 'convert_batch',
        chunks,
        cache_dir: cacheDirectory,
        width_pixels: widthPixels,
        template_path: templatePath
      }, this.requestTimeoutMilliseconds)
    })
  }

  /**
   * Sends a shutdown request and waits for the worker to exit (killing it as a
   * last resort). A no-op when the worker is not running. A later convertBatch
   * call starts a fresh worker.
   */
  public async shutdown (): Promise<void> {
    await this.enqueue(async () => {
      const child = this.childProcess
      if (child === null) {
        return
      }
      this.expectingExit = true
      try {
        await this.sendRequest({ action: 'shutdown' }, SHUTDOWN_REPLY_TIMEOUT_MILLISECONDS)
      } catch (error) {
        // The exit checks below clean up regardless of the reply
      }
      const exited = await waitForExit(child, EXIT_WAIT_TIMEOUT_MILLISECONDS)
      if (!exited) {
        this.logger.error('[PptxPreviewWorker] The worker did not exit after the shutdown request -- killing it')
        try { child.kill() } catch (error) { /* already gone */ }
      }
      this.detachChild(child)
      this.expectingExit = false
      this.logger.info('[PptxPreviewWorker] Worker shut down')
    })
  }

  /**
   * Returns true while the worker process is alive
   */
  public isRunning (): boolean {
    return this.childProcess !== null && this.childProcess.exitCode === null
  }

  /**
   * Synchronous best-effort release for application quit: rejects any
   * in-flight request and closes the worker's stdin. The worker treats the
   * EOF as a shutdown request, quits its hidden PowerPoint instance and exits
   * on its own -- killing it here instead would orphan that PowerPoint
   * process. A delayed, unref'ed kill remains as a last resort for a worker
   * that is stuck and never reads the EOF.
   */
  public killSync (): void {
    const child = this.childProcess
    if (child === null) {
      return
    }
    this.expectingExit = true
    this.detachChild(child)
    this.failAllPending(new Error('The worker client was disposed'))
    if (child.exitCode === null) {
      try { child.stdin?.end() } catch (error) { /* already gone */ }
      const killTimer = setTimeout(() => {
        try { child.kill() } catch (error) { /* already gone */ }
      }, EXIT_WAIT_TIMEOUT_MILLISECONDS)
      killTimer.unref()
    }
  }

  // ------------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------------

  /**
   * Serializes jobs so that only one request is in flight at any time
   */
  private async enqueue<T> (job: () => Promise<T>): Promise<T> {
    const runJob = async (): Promise<T> => await job()
    const next = this.queueTail.then(runJob, runJob)
    this.queueTail = next.then(() => undefined, () => undefined)
    return await next
  }

  private async ensureStarted (): Promise<void> {
    if (this.childProcess === null || this.readyPromise === null) {
      this.spawnWorker()
    }
    if (this.readyPromise === null) {
      throw new WorkerStartError('The worker process could not be spawned')
    }
    await this.readyPromise
  }

  private spawnWorker (): void {
    this.logger.info(`[PptxPreviewWorker] Starting worker: ${this.pythonPath} -u ${this.workerScriptPath}`)
    this.expectingExit = false
    this.stdoutBuffer = ''
    this.stderrBuffer = ''

    let child: ChildProcess
    try {
      child = spawn(this.pythonPath, [ '-u', this.workerScriptPath ], {
        windowsHide: true,
        stdio: [ 'pipe', 'pipe', 'pipe' ]
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.readyPromise = Promise.reject(new WorkerStartError(`Could not spawn the worker process: ${message}`))
      this.readyPromise.catch(() => { /* the awaiting request handles this */ })
      return
    }

    this.childProcess = child
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    // Guard against unhandled rejections when a startup failure happens while
    // no request is awaiting readiness
    this.readyPromise.catch(() => { /* handled by the awaiting request */ })
    this.readyTimer = setTimeout(() => {
      this.logger.error('[PptxPreviewWorker] The worker did not report ready in time -- killing it')
      this.detachChild(child, new WorkerStartError(`The worker did not report ready within ${this.requestTimeoutMilliseconds} ms`))
      try { child.kill() } catch (error) { /* already gone */ }
    }, this.requestTimeoutMilliseconds)

    child.on('error', (error) => {
      if (this.childProcess !== child) {
        return
      }
      this.logger.error(`[PptxPreviewWorker] Worker process error: ${error.message}`)
      this.detachChild(child, new WorkerStartError(`Could not start the worker process: ${error.message}`))
      this.failAllPending(new Error(`Worker process error: ${error.message}`))
      try { child.kill() } catch (killError) { /* already gone */ }
    })
    child.on('exit', (exitCode) => { this.handleExit(child, exitCode) })
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { this.handleStdoutData(child, chunk) })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { this.handleStderrData(chunk) })
  }

  /**
   * Forgets about a child process: clears the readiness state (rejecting a
   * still-pending readiness wait) and marks the client as needing a restart.
   * Safe to call multiple times; only acts when `child` is the current one.
   */
  private detachChild (child: ChildProcess, startupError?: WorkerStartError): void {
    if (this.childProcess !== child) {
      return
    }
    if (this.readyTimer !== null) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
    if (this.readyReject !== null) {
      this.readyReject(startupError ?? new WorkerStartError('The worker process is gone'))
    }
    this.readyResolve = null
    this.readyReject = null
    this.childProcess = null
    this.readyPromise = null
  }

  private handleExit (child: ChildProcess, exitCode: number|null): void {
    if (this.childProcess !== child) {
      return
    }
    const wasExpected = this.expectingExit
    this.detachChild(child, new WorkerStartError(`The worker process exited before becoming ready (code ${String(exitCode)})`))
    if (wasExpected) {
      this.logger.info(`[PptxPreviewWorker] Worker exited (code ${String(exitCode)})`)
    } else {
      this.logger.error(`[PptxPreviewWorker] Worker exited unexpectedly (code ${String(exitCode)})`)
      this.failAllPending(new Error(`The worker process exited unexpectedly (code ${String(exitCode)})`))
    }
  }

  private failAllPending (error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pendingRequests.clear()
  }

  private async sendRequest (payload: Record<string, unknown>, timeoutMilliseconds: number): Promise<PptxWorkerBatchReply> {
    const child = this.childProcess
    if (child === null || child.stdin === null) {
      throw new Error('The worker process is not running')
    }
    const requestId = ++this.nextRequestId
    const line = JSON.stringify({ id: requestId, ...payload }) + '\n'

    return await new Promise<PptxWorkerBatchReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.logger.error(`[PptxPreviewWorker] Request ${requestId} timed out after ${timeoutMilliseconds} ms -- killing the worker`)
        this.expectingExit = true // The exit that follows the kill is deliberate
        this.detachChild(child)
        this.failAllPending(new Error(`The worker request timed out after ${timeoutMilliseconds} ms`))
        try { child.kill() } catch (error) { /* already gone */ }
      }, timeoutMilliseconds)
      this.pendingRequests.set(requestId, { resolve, reject, timer })
      try {
        child.stdin?.write(line, 'utf8')
      } catch (error) {
        clearTimeout(timer)
        this.pendingRequests.delete(requestId)
        const message = error instanceof Error ? error.message : String(error)
        reject(new Error(`Could not write to the worker process: ${message}`))
      }
    })
  }

  private handleStdoutData (child: ChildProcess, chunk: string): void {
    if (this.childProcess !== child) {
      return // Data of an already detached (killed) worker
    }
    this.stdoutBuffer += chunk
    let newlineIndex = this.stdoutBuffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1)
      if (line !== '') {
        this.handleProtocolLine(line)
      }
      newlineIndex = this.stdoutBuffer.indexOf('\n')
    }
  }

  private handleProtocolLine (line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      this.logger.error(`[PptxPreviewWorker] Protocol line is not valid JSON: ${line.slice(0, 200)}`)
      return
    }
    if (typeof parsed !== 'object' || parsed === null) {
      this.logger.error(`[PptxPreviewWorker] Protocol line is not an object: ${line.slice(0, 200)}`)
      return
    }
    const message = parsed as Record<string, unknown>

    if (message.ready === true) {
      this.settleReady()
      return
    }

    const messageId = message.id
    if (typeof messageId === 'number' && this.pendingRequests.has(messageId)) {
      const pending = this.pendingRequests.get(messageId)!
      this.pendingRequests.delete(messageId)
      clearTimeout(pending.timer)
      pending.resolve(normalizeReply(message))
      return
    }

    // For example the worker's {"id": null, ...} answers to malformed request
    // lines land here; they match no in-flight request and are only logged.
    this.logger.info(`[PptxPreviewWorker] Protocol line without matching request: ${line.slice(0, 200)}`)
  }

  private settleReady (): void {
    if (this.readyTimer !== null) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
    if (this.readyResolve !== null) {
      this.logger.info('[PptxPreviewWorker] Worker is ready')
      this.readyResolve()
    }
    this.readyResolve = null
    this.readyReject = null
  }

  private handleStderrData (chunk: string): void {
    this.stderrBuffer += chunk
    let newlineIndex = this.stderrBuffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const line = this.stderrBuffer.slice(0, newlineIndex).replace(/\r$/, '')
      this.stderrBuffer = this.stderrBuffer.slice(newlineIndex + 1)
      if (line.trim() !== '') {
        this.logger.info(`[PptxPreviewWorker] ${line}`)
      }
      newlineIndex = this.stderrBuffer.indexOf('\n')
    }
  }
}
