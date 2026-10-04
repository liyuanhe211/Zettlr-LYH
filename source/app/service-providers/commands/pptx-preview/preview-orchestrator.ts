/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        PptxPreviewOrchestrator
 * CVM-Role:        Controller
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     The incremental scheduler of the pandoc PPTX live preview.
 *                  It keeps one reference-counted session per previewed file
 *                  and runs conversion cycles over it: split the document into
 *                  page chunks, pick the .potx template the document asks for
 *                  (or the default one), derive a content hash per chunk, satisfy as
 *                  many chunks as possible from the on-disk image cache, and
 *                  convert the remaining ones in batches through the resident
 *                  worker (small first batch for fast first feedback), with
 *                  ambiguous batches split in half recursively and failed
 *                  batches marked as errors without stopping the cycle. The
 *                  full preview state is (re-)published after planning and
 *                  after every finished batch. All side-effect dependencies
 *                  (worker client, content fetching, publishing, filesystem)
 *                  are injected so the scheduler is unit-testable without
 *                  Electron, a real worker, or a real disk.
 *
 * END HEADER
 */

import path from 'path'
import { createHash } from 'crypto'
import fs from 'fs'
import { splitPandocSlides, extractReferencedImagePaths } from '@common/util/pandoc-slide-splitter'
import { normalizeChunkForCacheKey } from '@common/util/pandoc-chunk-normalization'
import { parsePptxPreviewConfiguration } from '@common/pandoc-util/pptx-preview-configuration'
import type { PandocSlideChunk } from '@common/util/pandoc-slide-splitter'
import type { PptxPreviewOverflowEntry, PptxPreviewSlide, PptxPreviewState, PptxPreviewUndersizedEntry } from '@dts/common/pptx-preview'
import { WorkerStartError, normalizeWorkerFindings } from './worker-client'
import type { PptxWorkerBatchReply, PptxWorkerChunk } from './worker-client'

/**
 * The first batch of a cycle is kept small so that the first slides appear
 * quickly; subsequent batches trade latency for per-batch overhead.
 */
export const FIRST_BATCH_CHUNK_LIMIT = 6
export const LATER_BATCH_CHUNK_LIMIT = 12

const DEFAULT_IDLE_SHUTDOWN_MILLISECONDS = 60_000

/**
 * The filesystem surface the orchestrator needs (injectable for tests)
 */
export interface OrchestratorFileSystem {
  statSync: (targetPath: string) => { mtimeMs: number, size: number }
  existsSync: (targetPath: string) => boolean
  readFileSync: (targetPath: string) => string
  mkdirSync: (targetPath: string) => void
}

export interface OrchestratorLogger {
  info: (message: string) => void
  error: (message: string) => void
}

/**
 * The slice of the worker client the orchestrator uses (kept minimal so tests
 * can inject a scripted fake)
 */
export interface PptxPreviewWorkerClientLike {
  convertBatch: (chunks: PptxWorkerChunk[], cacheDirectory: string, widthPixels: number, templatePath: string) => Promise<PptxWorkerBatchReply>
  shutdown: () => Promise<void>
}

export interface PptxPreviewOrchestratorOptions {
  workerClient: PptxPreviewWorkerClientLike
  /**
   * Returns the current full text of the document (in-memory editor state when
   * the file is open and modified, otherwise the on-disk content)
   */
  fetchContent: (filePath: string) => Promise<string>
  /**
   * Receives every full preview state to broadcast
   */
  publish: (state: PptxPreviewState) => void
  logger: OrchestratorLogger
  /**
   * Absolute path of the directory holding rendered images and their sidecars
   */
  cacheDirectory: string
  /**
   * Absolute path of the .potx template to use for documents that do not name
   * one of their own in a configuration comment. Whichever template a cycle
   * ends up using contributes its mtime/size to every chunk's cache key, so
   * both template edits and template switches invalidate the cache.
   */
  defaultTemplatePath: string
  /**
   * Bumped whenever the conversion pipeline changes behaviour; part of every
   * cache key
   */
  pipelineVersion: number
  /**
   * Export width of the rendered images; part of every cache key
   */
  widthPixels: number
  /**
   * How long after the last session closes the worker is shut down (defaults
   * to 60 seconds; injectable so tests can trigger it immediately)
   */
  idleShutdownMilliseconds?: number
  /**
   * Filesystem override for tests; defaults to the real node fs
   */
  fileSystem?: OrchestratorFileSystem
}

/**
 * What a sidecar file (or a successful conversion result) says about a chunk
 */
interface CachedChunkFindings {
  /**
   * Image file names inside the cache directory
   */
  images: string[]
  overflow: PptxPreviewOverflowEntry[]
  undersized: PptxPreviewUndersizedEntry[]
}

/**
 * One chunk of the current cycle, carrying both the conversion input and the
 * publishable outcome
 */
interface ChunkRecord {
  key: string
  kind: 'metadata'|'slide'
  text: string
  startLine: number
  status: 'pending'|'ready'|'error'
  /**
   * Absolute image paths (empty while pending)
   */
  images: string[]
  overflow: PptxPreviewOverflowEntry[]
  undersized: PptxPreviewUndersizedEntry[]
  errorMessage?: string
}

interface PreviewSession {
  filePath: string
  referenceCount: number
  generation: number
  cycleRunning: boolean
  /**
   * Set when a refresh arrives while a cycle runs: the running cycle abandons
   * its remaining batches after the in-flight one and starts over
   */
  dirty: boolean
  closed: boolean
  chunkRecords: ChunkRecord[]
  /**
   * The template the current cycle renders against, already resolved to an
   * absolute path
   */
  templatePath: string
  /**
   * Where that template came from
   */
  templateSource: 'document'|'default'
}

const nodeFileSystem: OrchestratorFileSystem = {
  statSync: (targetPath) => {
    const stat = fs.statSync(targetPath)
    return { mtimeMs: stat.mtimeMs, size: stat.size }
  },
  existsSync: (targetPath) => fs.existsSync(targetPath),
  readFileSync: (targetPath) => fs.readFileSync(targetPath, 'utf8'),
  mkdirSync: (targetPath) => { fs.mkdirSync(targetPath, { recursive: true }) }
}

/**
 * Renders the template file's identity for cache-key purposes
 */
export function buildTemplateSignature (templatePath: string, stat: { mtimeMs: number, size: number }): string {
  return `${templatePath}:${stat.mtimeMs}:${stat.size}`
}

/**
 * Renders a referenced image's identity for cache-key purposes; a missing
 * image is recorded as such (so its appearance later changes the key)
 */
export function buildImageSignature (imagePath: string, stat: { mtimeMs: number, size: number }|undefined): string {
  if (stat === undefined) {
    return `${imagePath}:missing`
  }
  return `${imagePath}:${stat.mtimeMs}:${stat.size}`
}

/**
 * Computes the cache key of one chunk: the first 24 hex characters of the
 * SHA-256 over the chunk text (callers pass slide chunks in the form produced
 * by normalizeChunkForCacheKey), the pipeline version, the template signature,
 * every referenced image's signature, and the export width.
 */
export function computeChunkKey (chunkText: string, templateSignature: string, imageSignatures: string[], pipelineVersion: number, widthPixels: number): string {
  const hash = createHash('sha256')
  hash.update(chunkText, 'utf8')
  hash.update(` version:${pipelineVersion}`, 'utf8')
  hash.update(` template:${templateSignature}`, 'utf8')
  for (const imageSignature of imageSignatures) {
    hash.update(` image:${imageSignature}`, 'utf8')
  }
  hash.update(` width:${widthPixels}`, 'utf8')
  return hash.digest('hex').slice(0, 24)
}

/**
 * Groups the pending chunks (in document order) into conversion batches: the
 * first batch holds at most `firstBatchLimit` chunks, later ones at most
 * `laterBatchLimit`, and a metadata chunk always forms a batch of its own.
 */
export function planBatches<ChunkType extends { kind: 'metadata'|'slide' }> (
  pendingChunks: ChunkType[],
  firstBatchLimit: number = FIRST_BATCH_CHUNK_LIMIT,
  laterBatchLimit: number = LATER_BATCH_CHUNK_LIMIT
): ChunkType[][] {
  const batches: ChunkType[][] = []
  let currentBatch: ChunkType[] = []

  const flushCurrentBatch = (): void => {
    if (currentBatch.length > 0) {
      batches.push(currentBatch)
      currentBatch = []
    }
  }

  for (const chunk of pendingChunks) {
    if (chunk.kind === 'metadata') {
      flushCurrentBatch()
      batches.push([chunk])
      continue
    }
    currentBatch.push(chunk)
    const limit = batches.length === 0 ? firstBatchLimit : laterBatchLimit
    if (currentBatch.length >= limit) {
      flushCurrentBatch()
    }
  }
  flushCurrentBatch()
  return batches
}

export class PptxPreviewOrchestrator {
  private readonly sessions = new Map<string, PreviewSession>()
  /**
   * In-memory copy of every sidecar already read from (or written to) disk
   */
  private readonly sidecarCache = new Map<string, CachedChunkFindings>()
  private idleTimer: NodeJS.Timeout|null = null
  private readonly fileSystem: OrchestratorFileSystem
  private readonly idleShutdownMilliseconds: number

  constructor (private readonly options: PptxPreviewOrchestratorOptions) {
    this.fileSystem = options.fileSystem ?? nodeFileSystem
    this.idleShutdownMilliseconds = options.idleShutdownMilliseconds ?? DEFAULT_IDLE_SHUTDOWN_MILLISECONDS
  }

  /**
   * Opens (or re-opens) a preview session for the file and starts a conversion
   * cycle. Sessions are reference-counted, so two preview panes on the same
   * file share one session.
   */
  public openSession (filePath: string): void {
    this.cancelIdleShutdown()
    let session = this.sessions.get(filePath)
    if (session === undefined) {
      session = {
        filePath,
        referenceCount: 0,
        generation: 0,
        cycleRunning: false,
        dirty: false,
        closed: false,
        chunkRecords: [],
        templatePath: this.options.defaultTemplatePath,
        templateSource: 'default'
      }
      this.sessions.set(filePath, session)
    }
    session.referenceCount++
    this.requestCycle(session)
  }

  /**
   * Re-runs a conversion cycle over the file's current content. When a cycle
   * is already running, it finishes its in-flight batch, abandons the rest,
   * and starts over with the new content.
   */
  public refreshSession (filePath: string): void {
    const session = this.sessions.get(filePath)
    if (session === undefined) {
      this.options.logger.info(`[PptxPreview] Ignoring refresh for ${filePath}: no open session`)
      return
    }
    this.requestCycle(session)
  }

  /**
   * Closes one reference to the file's session. When the last session of all
   * files is gone, the worker is shut down after an idle period (cancelled by
   * a new openSession).
   */
  public closeSession (filePath: string): void {
    const session = this.sessions.get(filePath)
    if (session === undefined) {
      return
    }
    session.referenceCount--
    if (session.referenceCount > 0) {
      return
    }
    session.closed = true
    this.sessions.delete(filePath)
    if (this.sessions.size === 0) {
      this.scheduleIdleShutdown()
    }
  }

  /**
   * Ends every session and cancels the idle timer (without touching the worker
   * process -- the owner disposes the worker client itself)
   */
  public dispose (): void {
    this.cancelIdleShutdown()
    for (const session of this.sessions.values()) {
      session.closed = true
    }
    this.sessions.clear()
  }

  // ------------------------------------------------------------------------
  // Cycle scheduling
  // ------------------------------------------------------------------------

  private requestCycle (session: PreviewSession): void {
    if (session.cycleRunning) {
      session.dirty = true
      return
    }
    session.cycleRunning = true
    void (async () => {
      try {
        do {
          session.dirty = false
          await this.runOneCycle(session)
        } while (session.dirty && !session.closed)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.options.logger.error(`[PptxPreview] A conversion cycle failed unexpectedly: ${message}`)
      } finally {
        session.cycleRunning = false
      }
    })()
  }

  private async runOneCycle (session: PreviewSession): Promise<void> {
    session.generation++

    let content: string
    try {
      content = await this.options.fetchContent(session.filePath)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.publishState(session, `Could not read the document: ${message}`)
      return
    }

    const documentDirectory = path.dirname(session.filePath)
    const resolvedTemplate = this.resolveTemplate(content, documentDirectory)
    session.templatePath = resolvedTemplate.templatePath
    session.templateSource = resolvedTemplate.source

    let templateSignature: string
    try {
      templateSignature = buildTemplateSignature(session.templatePath, this.fileSystem.statSync(session.templatePath))
    } catch (error) {
      const origin = session.templateSource === 'document'
        ? 'The template named in the document could not be found'
        : 'Template file not found'
      this.publishState(session, `${origin}: ${session.templatePath}`)
      return
    }

    try {
      this.fileSystem.mkdirSync(this.options.cacheDirectory)
    } catch (error) {
      // A real problem with the cache directory surfaces in the batches below
    }

    session.chunkRecords = splitPandocSlides(content)
      .map(chunk => this.buildChunkRecord(chunk, templateSignature, documentDirectory))
    this.publishState(session)

    const pendingRecords = session.chunkRecords.filter(record => record.status === 'pending')
    for (const batch of planBatches(pendingRecords)) {
      if (session.dirty || session.closed) {
        return
      }
      try {
        await this.convertBatchWithSplitting(session, batch)
      } catch (error) {
        if (error instanceof WorkerStartError) {
          this.publishState(session, `The preview worker could not be started: ${error.message}`)
          return
        }
        throw error
      }
    }
  }

  /**
   * Decides which .potx this cycle renders against: the one the document names
   * in its configuration comment (relative paths resolved against the
   * document's own directory), or the application's default.
   */
  private resolveTemplate (content: string, documentDirectory: string): { templatePath: string, source: 'document'|'default' } {
    const { configuration } = parsePptxPreviewConfiguration(content)
    const configuredPath = configuration.referenceDoc

    if (configuredPath === undefined || configuredPath === '') {
      return { templatePath: this.options.defaultTemplatePath, source: 'default' }
    }

    return {
      templatePath: path.isAbsolute(configuredPath) ? configuredPath : path.resolve(documentDirectory, configuredPath),
      source: 'document'
    }
  }

  // ------------------------------------------------------------------------
  // Chunk records and the disk cache
  // ------------------------------------------------------------------------

  private buildChunkRecord (chunk: PandocSlideChunk, templateSignature: string, documentDirectory: string): ChunkRecord {
    // Image references are extracted from the verbatim text on purpose: an
    // image mentioned only inside a stripped comment then still contributes
    // its signature. That can only cause an unnecessary re-render, never a
    // stale page, which is the conservative direction.
    const imageSignatures = extractReferencedImagePaths(chunk.text).map(imagePath => {
      const resolvedPath = path.isAbsolute(imagePath) ? imagePath : path.resolve(documentDirectory, imagePath)
      let stat: { mtimeMs: number, size: number }|undefined
      try {
        stat = this.fileSystem.statSync(resolvedPath)
      } catch (error) {
        stat = undefined
      }
      return buildImageSignature(imagePath, stat)
    })

    // Slide chunks are hashed in normalized form, so that editing ordinary
    // comments or piling up blank lines does not invalidate the cached page.
    // The metadata chunk is hashed verbatim (YAML is whitespace-sensitive),
    // and the worker always receives the verbatim text (record.text below).
    const keyText = chunk.kind === 'slide' ? normalizeChunkForCacheKey(chunk.text) : chunk.text
    const key = computeChunkKey(keyText, templateSignature, imageSignatures, this.options.pipelineVersion, this.options.widthPixels)
    const cachedFindings = this.readCachedFindings(key)
    if (cachedFindings !== undefined) {
      return {
        key,
        kind: chunk.kind,
        text: chunk.text,
        startLine: chunk.startLine,
        status: 'ready',
        images: cachedFindings.images.map(fileName => path.join(this.options.cacheDirectory, fileName)),
        overflow: cachedFindings.overflow,
        undersized: cachedFindings.undersized
      }
    }
    return {
      key,
      kind: chunk.kind,
      text: chunk.text,
      startLine: chunk.startLine,
      status: 'pending',
      images: [],
      overflow: [],
      undersized: []
    }
  }

  /**
   * Returns the chunk's cached conversion outcome when the sidecar exists and
   * every image it lists is still on disk; undefined otherwise
   */
  private readCachedFindings (key: string): CachedChunkFindings|undefined {
    let findings = this.sidecarCache.get(key)
    if (findings === undefined) {
      const sidecarPath = path.join(this.options.cacheDirectory, `${key}.json`)
      if (!this.fileSystem.existsSync(sidecarPath)) {
        return undefined
      }
      try {
        const parsed: unknown = JSON.parse(this.fileSystem.readFileSync(sidecarPath))
        if (typeof parsed !== 'object' || parsed === null) {
          return undefined
        }
        const raw = parsed as Record<string, unknown>
        const images = Array.isArray(raw.images)
          ? raw.images.filter((name): name is string => typeof name === 'string')
          : []
        const normalized = normalizeWorkerFindings(raw)
        findings = { images, overflow: normalized.overflow, undersized: normalized.undersized }
        this.sidecarCache.set(key, findings)
      } catch (error) {
        return undefined
      }
    }

    for (const fileName of findings.images) {
      if (!this.fileSystem.existsSync(path.join(this.options.cacheDirectory, fileName))) {
        this.sidecarCache.delete(key)
        return undefined
      }
    }
    return findings
  }

  // ------------------------------------------------------------------------
  // Batch conversion
  // ------------------------------------------------------------------------

  private async convertBatchWithSplitting (session: PreviewSession, batch: ChunkRecord[]): Promise<void> {
    if (batch.length === 0) {
      return
    }

    let reply: PptxWorkerBatchReply
    try {
      reply = await this.options.workerClient.convertBatch(
        batch.map(record => ({ key: record.key, text: record.text, kind: record.kind })),
        this.options.cacheDirectory,
        this.options.widthPixels,
        session.templatePath
      )
    } catch (error) {
      if (error instanceof WorkerStartError) {
        throw error
      }
      const message = error instanceof Error ? error.message : String(error)
      this.markBatchAsFailed(session, batch, message)
      return
    }

    if (!reply.ok) {
      this.markBatchAsFailed(session, batch, reply.error)
      return
    }

    if (reply.ambiguous) {
      // Pandoc split some chunk of this batch into several slides, so the
      // slide-to-chunk assignment is unknown: convert each half separately
      // (a single-chunk batch owns all its slides and is never ambiguous).
      if (batch.length <= 1) {
        this.markBatchAsFailed(session, batch, `The worker reported an ambiguous slide count (${reply.slideCount}) for a single chunk`)
        return
      }
      const halfSize = Math.ceil(batch.length / 2)
      await this.convertBatchWithSplitting(session, batch.slice(0, halfSize))
      if (session.dirty || session.closed) {
        return
      }
      await this.convertBatchWithSplitting(session, batch.slice(halfSize))
      return
    }

    const resultsByKey = new Map<string, CachedChunkFindings>()
    for (const result of reply.results) {
      resultsByKey.set(result.key, { images: result.images, overflow: result.overflow, undersized: result.undersized })
    }
    for (const record of batch) {
      const result = resultsByKey.get(record.key)
      if (result === undefined) {
        record.status = 'error'
        record.errorMessage = 'The worker reply did not contain a result for this chunk'
        continue
      }
      record.status = 'ready'
      record.errorMessage = undefined
      record.images = result.images.map(fileName => path.join(this.options.cacheDirectory, fileName))
      record.overflow = result.overflow
      record.undersized = result.undersized
      this.sidecarCache.set(record.key, result)
    }
    this.publishState(session)
  }

  private markBatchAsFailed (session: PreviewSession, batch: ChunkRecord[], message: string): void {
    for (const record of batch) {
      record.status = 'error'
      record.errorMessage = message
      record.images = []
    }
    this.options.logger.error(`[PptxPreview] A conversion batch of ${batch.length} chunk(s) failed: ${message}`)
    this.publishState(session)
  }

  // ------------------------------------------------------------------------
  // State publishing and worker idle shutdown
  // ------------------------------------------------------------------------

  private publishState (session: PreviewSession, cycleError?: string): void {
    if (session.closed) {
      return
    }
    const slides: PptxPreviewSlide[] = session.chunkRecords.map(record => {
      const slide: PptxPreviewSlide = {
        key: record.key,
        status: record.status,
        images: [...record.images],
        overflow: record.overflow.map(entry => ({ ...entry })),
        undersized: record.undersized.map(entry => ({ ...entry })),
        startLine: record.startLine
      }
      if (record.errorMessage !== undefined) {
        slide.errorMessage = record.errorMessage
      }
      return slide
    })
    const pendingCount = slides.filter(slide => slide.status === 'pending').length
    const state: PptxPreviewState = {
      filePath: session.filePath,
      generation: session.generation,
      building: cycleError === undefined && pendingCount > 0,
      pendingCount,
      slides,
      referenceDoc: session.templatePath,
      referenceDocSource: session.templateSource
    }
    if (cycleError !== undefined) {
      state.error = cycleError
    }
    this.options.publish(state)
  }

  private scheduleIdleShutdown (): void {
    this.cancelIdleShutdown()
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      this.options.logger.info('[PptxPreview] No open preview session for a while -- shutting the worker down')
      void this.options.workerClient.shutdown().catch((error: Error) => {
        this.options.logger.error(`[PptxPreview] Worker shutdown failed: ${error.message}`)
      })
    }, this.idleShutdownMilliseconds)
  }

  private cancelIdleShutdown (): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }
}
