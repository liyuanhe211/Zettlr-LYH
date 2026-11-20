/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        PdfBacklinkIndex class
 * CVM-Role:        Model
 * License:         GNU GPL v3
 *
 * Description:     The backlink index of contract C11 (R62): which notes in
 *                  the open workspaces link to which PDF, and where. Built on
 *                  the first request, then kept up to date from file events
 *                  (collected for 500 ms, then applied together) and from
 *                  changes of the list of open workspaces. Does not depend on
 *                  electron: reading files, listing directories, scanning,
 *                  resolving and the timer are passed to the constructor, so
 *                  mocha tests it with stand-ins.
 *
 * END HEADER
 */

import type {
  PdfBacklink,
  PdfLinkSyntax,
  PdfNoteLink,
  PdfPathEnvironment
} from '@dts/common/pdf-viewer'

/**
 * Notes larger than this are skipped (and logged)
 */
export const PDF_BACKLINK_MAXIMUM_NOTE_SIZE = 5 * 1024 * 1024

/**
 * At most this many notes are read at the same time
 */
export const PDF_BACKLINK_MAXIMUM_CONCURRENT_READS = 8

/**
 * File events are applied once no new event has arrived for this long
 */
export const PDF_BACKLINK_EVENT_DELAY_MS = 500

/**
 * Modification time and size of a file, as far as the index needs them
 */
export interface PdfBacklinkFileStat {
  /**
   * Modification time in milliseconds
   */
  modificationTime: number
  /**
   * Size in bytes
   */
  size: number
}

/**
 * A file system event, as the FSAL reports it. `path` is absolute.
 */
export interface PdfBacklinkFileEvent {
  kind: 'add'|'change'|'unlink'|'addDir'|'unlinkDir'
  path: string
}

/**
 * The part of the LogProvider the index uses
 */
export interface PdfBacklinkLogger {
  info: (message: string) => void
  warning: (message: string) => void
  error: (message: string, details?: unknown) => void
}

/**
 * A timer that can be replaced in tests; the default uses setTimeout
 */
export interface PdfBacklinkTimer {
  set: (callback: () => void, delay: number) => unknown
  clear: (handle: unknown) => void
}

/**
 * Everything the index needs from the outside world
 */
export interface PdfBacklinkIndexOptions {
  /**
   * Absolute paths of the open workspaces at the start
   */
  workspaceRoots: string[]
  /**
   * Modification time and size of a file; rejects if it does not exist
   */
  statFile: (path: string) => Promise<PdfBacklinkFileStat>
  /**
   * The text of a file (UTF-8)
   */
  readFile: (path: string) => Promise<string>
  /**
   * Every file below a directory, recursively, as absolute paths (directory
   * paths in the result are tolerated)
   */
  listFiles: (root: string) => Promise<string[]>
  /**
   * Whether a file exists
   */
  fileExists: (path: string) => Promise<boolean>
  /**
   * Whether Zettlr treats the file as Markdown (same check as the FSAL)
   */
  isMarkdownFile: (path: string) => boolean
  scanPdfLinks: (text: string) => PdfNoteLink[]
  resolvePdfLinkPath: (syntax: PdfLinkSyntax, writtenPath: string, notePath: string, environment: PdfPathEnvironment) => Promise<string|undefined>
  resolveBacklinkColor: (link: PdfNoteLink) => string
  /**
   * True on Windows and macOS: paths that differ only in case are the same
   */
  ignoreCase: boolean
  logger: PdfBacklinkLogger
  /**
   * Called exactly once whenever the content of the index has changed, with
   * the absolute paths of the PDFs whose backlinks changed, or null after a
   * full rebuild
   */
  onChange: (pdfPaths: string[]|null) => void
  timer?: PdfBacklinkTimer
  /**
   * Defaults to PDF_BACKLINK_MAXIMUM_NOTE_SIZE
   */
  maximumNoteSize?: number
  /**
   * Defaults to PDF_BACKLINK_MAXIMUM_CONCURRENT_READS
   */
  maximumConcurrentReads?: number
  /**
   * Defaults to PDF_BACKLINK_EVENT_DELAY_MS
   */
  eventDelay?: number
}

/**
 * What the index remembers about one note
 */
interface NoteEntry {
  path: string
  modificationTime: number
  size: number
  links: PdfNoteLink[]
  backlinks: PdfBacklink[]
}

/**
 * One pass over the index (a build or a batch of events). The file system is
 * taken as unchanged during the pass: directory listings, existence checks
 * and link resolutions are made at most once each. A resolution depends only
 * on the syntax, the written path and the note's directory, so it is shared
 * by all notes in the same directory.
 */
interface ResolutionPass {
  environment: PdfPathEnvironment
  resolutions: Map<string, Promise<string|undefined>>
}

/**
 * Backlinks of one note before and after an update
 */
interface NoteChange {
  before: PdfBacklink[]
  after: PdfBacklink[]
}

const DEFAULT_TIMER: PdfBacklinkTimer = {
  set: (callback, delay) => setTimeout(callback, delay),
  clear: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>) }
}

/**
 * @param   {string}   path  A path
 *
 * @return  {boolean}        True if it ends with `.pdf` (in any case)
 */
function isPdfFile (path: string): boolean {
  return /\.pdf$/i.test(path)
}

/**
 * Runs the task for every item, with at most `concurrency` tasks running at
 * the same time.
 */
async function forEachConcurrently<T> (items: T[], concurrency: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next]
      next++
      await task(item)
    }
  }

  const workers: Array<Promise<void>> = []
  for (let k = 0; k < Math.max(1, Math.min(concurrency, items.length)); k++) {
    workers.push(worker())
  }
  await Promise.all(workers)
}

export class PdfBacklinkIndex {
  private readonly _options: PdfBacklinkIndexOptions
  private readonly _timer: PdfBacklinkTimer
  private readonly _maximumNoteSize: number
  private readonly _maximumConcurrentReads: number
  private readonly _eventDelay: number

  private _workspaceRoots: string[]
  private _notes: Map<string, NoteEntry>
  private _backlinksByPdf: Map<string, PdfBacklink[]>
  private _isBuilt: boolean
  private _buildPromise: Promise<void>|undefined
  private _queue: Promise<void>
  private _pendingEvents: PdfBacklinkFileEvent[]
  private _pendingTimer: unknown
  private _hasPendingTimer: boolean
  private _isDisposed: boolean

  constructor (options: PdfBacklinkIndexOptions) {
    this._options = options
    this._timer = options.timer ?? DEFAULT_TIMER
    this._maximumNoteSize = options.maximumNoteSize ?? PDF_BACKLINK_MAXIMUM_NOTE_SIZE
    this._maximumConcurrentReads = options.maximumConcurrentReads ?? PDF_BACKLINK_MAXIMUM_CONCURRENT_READS
    this._eventDelay = options.eventDelay ?? PDF_BACKLINK_EVENT_DELAY_MS

    this._workspaceRoots = this.uniquePaths(options.workspaceRoots)
    this._notes = new Map()
    this._backlinksByPdf = new Map()
    this._isBuilt = false
    this._buildPromise = undefined
    this._queue = Promise.resolve()
    this._pendingEvents = []
    this._pendingTimer = undefined
    this._hasPendingTimer = false
    this._isDisposed = false
  }

  /**
   * Returns every backlink to the PDF, sorted by note path (ignoring case if
   * `ignoreCase` is set) and then by line. Builds the index first if this is
   * the first request, and waits for updates already under way.
   *
   * @param   {string}  pdfPath  Absolute path of the PDF
   *
   * @return  {Promise<PdfBacklink[]>}  The backlinks, an empty array if there are none
   */
  public async getBacklinks (pdfPath: string): Promise<PdfBacklink[]> {
    await this.ensureBuilt()
    await this._queue
    const backlinks = this._backlinksByPdf.get(this.pathKey(pdfPath))
    return backlinks === undefined ? [] : backlinks.slice()
  }

  /**
   * Takes note of a file event. Events are applied together once no new
   * event has arrived for the event delay. Before the first request, events
   * are ignored (the build will read the current state).
   *
   * @param  {PdfBacklinkFileEvent}  event  The event
   */
  public handleFileEvent (event: PdfBacklinkFileEvent): void {
    if (this._buildPromise === undefined || this._isDisposed) {
      return
    }

    this._pendingEvents.push(event)
    if (this._hasPendingTimer) {
      this._timer.clear(this._pendingTimer)
    }
    this._hasPendingTimer = true
    this._pendingTimer = this._timer.set(() => {
      this._hasPendingTimer = false
      this._pendingTimer = undefined
      const events = this._pendingEvents
      this._pendingEvents = []
      this.enqueue(async () => { await this.applyEvents(events) })
        .catch(err => this._options.logger.error(`[PdfBacklinkIndex] Could not update the PDF backlink index: ${errorMessage(err)}`, err))
    }, this._eventDelay)
  }

  /**
   * Sets the list of open workspaces. If it differs from the current one and
   * the index has been built, the index is rebuilt (notes whose modification
   * time and size are unchanged are not read again) and onChange receives
   * null.
   *
   * @param  {string[]}  workspaceRoots  Absolute paths of the open workspaces
   */
  public setWorkspaceRoots (workspaceRoots: string[]): void {
    const roots = this.uniquePaths(workspaceRoots)
    const currentKeys = this._workspaceRoots.map(root => this.pathKey(root)).sort()
    const newKeys = roots.map(root => this.pathKey(root)).sort()
    if (currentKeys.length === newKeys.length && currentKeys.every((key, k) => key === newKeys[k])) {
      return
    }

    this._workspaceRoots = roots
    if (this._buildPromise === undefined || this._isDisposed) {
      return
    }

    // The rebuild covers whatever the pending events would have changed
    this.cancelPendingEvents()
    this.enqueue(async () => { await this.build(true) })
      .catch(err => this._options.logger.error(`[PdfBacklinkIndex] Could not rebuild the PDF backlink index: ${errorMessage(err)}`, err))
  }

  /**
   * Resolves once every queued update has been applied (events still waiting
   * for the event delay are not included)
   */
  public async whenIdle (): Promise<void> {
    await this._queue
  }

  /**
   * Stops the event timer; later events are ignored
   */
  public dispose (): void {
    this._isDisposed = true
    this.cancelPendingEvents()
  }

  private cancelPendingEvents (): void {
    if (this._hasPendingTimer) {
      this._timer.clear(this._pendingTimer)
    }
    this._hasPendingTimer = false
    this._pendingTimer = undefined
    this._pendingEvents = []
  }

  private async ensureBuilt (): Promise<void> {
    if (this._buildPromise === undefined) {
      const build = this.enqueue(async () => { await this.build(false) })
      this._buildPromise = build
      build.catch(() => {
        // Let the next request try again
        if (this._buildPromise === build) {
          this._buildPromise = undefined
        }
      })
    }
    await this._buildPromise
  }

  /**
   * Runs the task after every task queued before it
   */
  private async enqueue (task: () => Promise<void>): Promise<void> {
    const run = this._queue.then(task)
    this._queue = run.catch(() => {})
    return await run
  }

  /**
   * Comparison key of a path: forward slashes, no trailing slash, lower case
   * if `ignoreCase` is set (the rule of isSamePdfFilePath)
   */
  private pathKey (path: string): string {
    let key = path.replace(/\\/g, '/')
    while (key.length > 1 && key.endsWith('/')) {
      key = key.slice(0, -1)
    }
    return this._options.ignoreCase ? key.toLowerCase() : key
  }

  private uniquePaths (paths: string[]): string[] {
    const seen = new Set<string>()
    const result: string[] = []
    for (const path of paths) {
      const key = this.pathKey(path)
      if (!seen.has(key)) {
        seen.add(key)
        result.push(path)
      }
    }
    return result
  }

  /**
   * @return  {boolean}  True if the path lies inside the directory
   */
  private isInside (path: string, directory: string): boolean {
    const pathKey = this.pathKey(path)
    const directoryKey = this.pathKey(directory)
    return pathKey.startsWith(directoryKey.endsWith('/') ? directoryKey : directoryKey + '/')
  }

  private isNoteInWorkspace (path: string): boolean {
    return this._options.isMarkdownFile(path) && this._workspaceRoots.some(root => this.isInside(path, root))
  }

  /**
   * Starts a pass: directory listings, existence checks and link resolutions
   * are made at most once each during the pass.
   */
  private createPass (): ResolutionPass {
    const listings = new Map<string, Promise<string[]>>()
    const existence = new Map<string, Promise<boolean>>()
    const { logger } = this._options

    const environment: PdfPathEnvironment = {
      workspaceRoots: this._workspaceRoots.slice(),
      ignoreCase: this._options.ignoreCase,
      exists: async (path: string): Promise<boolean> => {
        const key = this.pathKey(path)
        let result = existence.get(key)
        if (result === undefined) {
          result = this._options.fileExists(path).catch(() => false)
          existence.set(key, result)
        }
        return await result
      },
      listFiles: async (root: string): Promise<string[]> => {
        const key = this.pathKey(root)
        let result = listings.get(key)
        if (result === undefined) {
          result = this._options.listFiles(root).catch(err => {
            logger.warning(`[PdfBacklinkIndex] Could not list the files of ${root}: ${errorMessage(err)}`)
            return []
          })
          listings.set(key, result)
        }
        return await result
      }
    }

    return { environment, resolutions: new Map() }
  }

  /**
   * Resolves the links of a note to backlinks; links that resolve to no PDF
   * are left out.
   */
  private async resolveLinks (notePath: string, links: PdfNoteLink[], pass: ResolutionPass): Promise<PdfBacklink[]> {
    const noteKey = this.pathKey(notePath)
    const directoryKey = noteKey.slice(0, noteKey.lastIndexOf('/') + 1)
    const backlinks: PdfBacklink[] = []
    for (const link of links) {
      const resolutionKey = `${link.syntax}\u0000${directoryKey}\u0000${link.writtenPath}`
      let resolution = pass.resolutions.get(resolutionKey)
      if (resolution === undefined) {
        resolution = this._options.resolvePdfLinkPath(link.syntax, link.writtenPath, notePath, pass.environment)
        pass.resolutions.set(resolutionKey, resolution)
      }

      let pdfPath: string|undefined
      try {
        pdfPath = await resolution
      } catch (err: unknown) {
        this._options.logger.warning(`[PdfBacklinkIndex] Could not resolve the link to ${link.writtenPath} on line ${link.line} of ${notePath}: ${errorMessage(err)}`)
        continue
      }

      if (pdfPath === undefined) {
        continue
      }

      backlinks.push({ ...link, notePath, pdfPath, color: this._options.resolveBacklinkColor(link) })
    }
    return backlinks
  }

  /**
   * Reads and scans a note, unless its modification time and size equal
   * those of `previous`, in which case `previous` itself is returned.
   * Returns undefined if the note is gone, unreadable, or too large.
   */
  private async loadNote (path: string, previous: NoteEntry|undefined, pass: ResolutionPass): Promise<NoteEntry|undefined> {
    const { logger } = this._options

    let stat: PdfBacklinkFileStat
    try {
      stat = await this._options.statFile(path)
    } catch (err: unknown) {
      return undefined // The note is gone
    }

    if (previous !== undefined && previous.modificationTime === stat.modificationTime && previous.size === stat.size) {
      return previous
    }

    if (stat.size > this._maximumNoteSize) {
      logger.warning(`[PdfBacklinkIndex] Skipping ${path}: the file is larger than ${Math.round(this._maximumNoteSize / 1024 / 1024)} MB (${stat.size} bytes)`)
      return undefined
    }

    let text: string
    try {
      text = await this._options.readFile(path)
    } catch (err: unknown) {
      logger.warning(`[PdfBacklinkIndex] Could not read ${path}: ${errorMessage(err)}`)
      return undefined
    }

    let links: PdfNoteLink[]
    try {
      links = this._options.scanPdfLinks(text)
    } catch (err: unknown) {
      logger.error(`[PdfBacklinkIndex] Could not scan ${path} for PDF links: ${errorMessage(err)}`, err)
      return undefined
    }

    const backlinks = await this.resolveLinks(path, links, pass)
    return { path, modificationTime: stat.modificationTime, size: stat.size, links, backlinks }
  }

  /**
   * Builds the whole index from the open workspaces. Notes already in the
   * index whose modification time and size are unchanged are not read again,
   * but their links are resolved again. After a rebuild, onChange receives
   * null.
   */
  private async build (isRebuild: boolean): Promise<void> {
    const start = Date.now()
    const pass = this.createPass()

    const notePaths = new Map<string, string>()
    for (const root of this._workspaceRoots) {
      for (const file of await pass.environment.listFiles(root)) {
        if (this._options.isMarkdownFile(file)) {
          const key = this.pathKey(file)
          if (!notePaths.has(key)) {
            notePaths.set(key, file)
          }
        }
      }
    }

    const previousNotes = this._notes
    const notes = new Map<string, NoteEntry>()
    await forEachConcurrently([...notePaths.entries()], this._maximumConcurrentReads, async ([ key, path ]) => {
      const previous = previousNotes.get(key)
      let entry = await this.loadNote(path, previous, pass)
      if (entry !== undefined && entry === previous) {
        entry = { ...previous, backlinks: await this.resolveLinks(previous.path, previous.links, pass) }
      }
      if (entry !== undefined) {
        notes.set(key, entry)
      }
    })

    this._notes = notes
    this.rebuildPdfMap()
    this._isBuilt = true

    let linkCount = 0
    for (const entry of notes.values()) {
      linkCount += entry.backlinks.length
    }
    this._options.logger.info(`[PdfBacklinkIndex] Indexed ${linkCount} PDF links in ${notes.size} notes in ${Date.now() - start} ms`)

    if (isRebuild) {
      this._options.onChange(null)
    }
  }

  /**
   * Applies a batch of file events: changed and added notes are scanned
   * again (unless modification time and size are unchanged), removed notes
   * leave the index. Adding or removing a PDF or a directory, or a rename
   * (a removal and an addition in the same batch), resolves the links of
   * every note again.
   */
  private async applyEvents (events: PdfBacklinkFileEvent[]): Promise<void> {
    if (!this._isBuilt || events.length === 0) {
      return
    }

    const pass = this.createPass()
    const notesToLoad = new Map<string, string>()
    const notesToRemove = new Set<string>()
    let resolveAll = false
    let sawAddition = false
    let sawRemoval = false

    for (const event of events) {
      const key = this.pathKey(event.path)
      switch (event.kind) {
        case 'add':
        case 'change':
          if (event.kind === 'add') {
            sawAddition = true
            if (isPdfFile(event.path)) {
              resolveAll = true
            }
          }
          if (this.isNoteInWorkspace(event.path)) {
            notesToLoad.set(key, event.path)
            notesToRemove.delete(key)
          }
          break
        case 'unlink':
          sawRemoval = true
          if (isPdfFile(event.path)) {
            resolveAll = true
          }
          notesToRemove.add(key)
          notesToLoad.delete(key)
          break
        case 'addDir':
          sawAddition = true
          resolveAll = true
          for (const file of await pass.environment.listFiles(event.path)) {
            if (this.isNoteInWorkspace(file)) {
              const fileKey = this.pathKey(file)
              notesToLoad.set(fileKey, file)
              notesToRemove.delete(fileKey)
            }
          }
          break
        case 'unlinkDir':
          sawRemoval = true
          resolveAll = true
          for (const [ noteKey, entry ] of this._notes) {
            if (this.isInside(entry.path, event.path)) {
              notesToRemove.add(noteKey)
              notesToLoad.delete(noteKey)
            }
          }
          for (const [ noteKey, path ] of [...notesToLoad]) {
            if (this.isInside(path, event.path)) {
              notesToLoad.delete(noteKey)
            }
          }
          break
      }
    }

    if (sawAddition && sawRemoval) {
      resolveAll = true // A rename
    }

    const changes: NoteChange[] = []

    for (const key of notesToRemove) {
      const entry = this._notes.get(key)
      if (entry !== undefined) {
        this._notes.delete(key)
        changes.push({ before: entry.backlinks, after: [] })
      }
    }

    const freshlyResolved = new Set<string>()
    await forEachConcurrently([...notesToLoad.entries()], this._maximumConcurrentReads, async ([ key, path ]) => {
      const previous = this._notes.get(key)
      const entry = await this.loadNote(path, previous, pass)
      if (entry === undefined) {
        if (previous !== undefined) {
          this._notes.delete(key)
          changes.push({ before: previous.backlinks, after: [] })
        }
        return
      }

      if (entry !== previous) {
        freshlyResolved.add(key)
        this._notes.set(key, entry)
        changes.push({ before: previous?.backlinks ?? [], after: entry.backlinks })
      }
    })

    if (resolveAll) {
      const toResolve = [...this._notes.entries()].filter(([key]) => !freshlyResolved.has(key))
      await forEachConcurrently(toResolve, this._maximumConcurrentReads, async ([ key, entry ]) => {
        const backlinks = await this.resolveLinks(entry.path, entry.links, pass)
        this._notes.set(key, { ...entry, backlinks })
        changes.push({ before: entry.backlinks, after: backlinks })
      })
    }

    const affected = this.affectedPdfPaths(changes)
    if (affected.length > 0) {
      this.rebuildPdfMap()
      this._options.onChange(affected)
    }
  }

  /**
   * The PDFs whose backlinks differ before and after the changes, each once
   */
  private affectedPdfPaths (changes: NoteChange[]): string[] {
    const affected = new Map<string, string>()
    for (const { before, after } of changes) {
      const groupsBefore = this.groupByPdf(before)
      const groupsAfter = this.groupByPdf(after)
      for (const [ key, group ] of [ ...groupsBefore, ...groupsAfter ]) {
        if (affected.has(key)) {
          continue
        }
        if (JSON.stringify(groupsBefore.get(key) ?? []) !== JSON.stringify(groupsAfter.get(key) ?? [])) {
          affected.set(key, group[0].pdfPath)
        }
      }
    }
    return [...affected.values()]
  }

  /**
   * The backlinks of one note grouped by PDF, keyed by PDF path key
   */
  private groupByPdf (backlinks: PdfBacklink[]): Map<string, PdfBacklink[]> {
    const groups = new Map<string, PdfBacklink[]>()
    for (const backlink of backlinks) {
      const key = this.pathKey(backlink.pdfPath)
      const group = groups.get(key)
      if (group === undefined) {
        groups.set(key, [backlink])
      } else {
        group.push(backlink)
      }
    }
    return groups
  }

  /**
   * Groups the backlinks of all notes by PDF, each group sorted by note path
   * and line
   */
  private rebuildPdfMap (): void {
    const byPdf = new Map<string, PdfBacklink[]>()
    for (const entry of this._notes.values()) {
      for (const backlink of entry.backlinks) {
        const key = this.pathKey(backlink.pdfPath)
        const group = byPdf.get(key)
        if (group === undefined) {
          byPdf.set(key, [backlink])
        } else {
          group.push(backlink)
        }
      }
    }

    for (const group of byPdf.values()) {
      group.sort((a, b) => {
        const first = this.pathKey(a.notePath)
        const second = this.pathKey(b.notePath)
        if (first !== second) {
          return first < second ? -1 : 1
        }
        return a.line - b.line
      })
    }

    this._backlinksByPdf = byPdf
  }
}

/**
 * @return  {string}  The message of an error, or the value as a string
 */
function errorMessage (err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
