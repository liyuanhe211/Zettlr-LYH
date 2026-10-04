/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        DocumentBackupManager
 * CVM-Role:        Model
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Notepad++-style persistence of unsaved editing states.
 *                  Every modification to an open document is mirrored into a
 *                  backup directory inside the user data folder, so that
 *                  unsaved edits survive an application restart without ever
 *                  touching the source file. A backup is deleted once the
 *                  user actually saves the file (and no newer edits exist),
 *                  or two weeks after the document was closed without saving.
 *
 * END HEADER
 */

import path from 'path'
import { promises as fs } from 'fs'
import crypto from 'crypto'

// Persist a pending backup this long after the last modification ...
const BACKUP_DEBOUNCE_TIMEOUT = 2000 // ms
// ... but never wait longer than this after the earliest unpersisted change,
// so that continuous typing still produces regular backups.
const BACKUP_MAXIMUM_DELAY = 10000 // ms
// Backups of documents that were closed without saving are retained this long.
const CLOSED_BACKUP_RETENTION = 14 * 24 * 60 * 60 * 1000 // Two weeks in ms

export interface BackupMetadata {
  /**
   * The absolute path of the original file this backup belongs to
   */
  filePath: string
  /**
   * Timestamp (ms since epoch) of the last time the backup content was written
   */
  updatedAt: number
  /**
   * Timestamp (ms since epoch) of when the document was closed without saving
   * its changes. As long as the document counts as open, this is null. Closed
   * backups are removed after CLOSED_BACKUP_RETENTION has elapsed.
   */
  closedAt: number|null
}

interface PendingPersist {
  timeout: NodeJS.Timeout
  getContent: () => string
  earliestChangeAt: number
}

/**
 * The subset of the log provider this manager needs. Defined structurally so
 * that the manager stays free of Electron dependencies and can be unit-tested.
 */
export interface BackupManagerLogger {
  info: (message: string, details?: unknown) => void
  error: (message: string, details?: unknown) => void
}

export default class DocumentBackupManager {
  /**
   * Holds the debounced, not yet written backup states, keyed by file path
   */
  private readonly _pendingPersists: Map<string, PendingPersist>
  /**
   * Holds the tail of the operation queue per file path. All disk operations
   * on one file's backup run strictly one after another; otherwise, e.g., a
   * remove() after a save could interleave with a debounced write that is
   * already underway, and that write would resurrect a stale backup.
   */
  private readonly _operationQueues: Map<string, Promise<void>>
  private readonly _debounceTimeout: number
  private readonly _maximumDelay: number
  private readonly _closedRetention: number

  /**
   * @param  {string}               _backupDirectory  Where backups are stored
   *                                                  (for Zettlr: the folder
   *                                                  unsaved-changes inside
   *                                                  the user data directory)
   * @param  {BackupManagerLogger}  _log              The logger to use
   * @param  {object}               timings           Optional overrides of the
   *                                                  timing constants; only
   *                                                  intended for unit tests
   */
  constructor (
    private readonly _backupDirectory: string,
    private readonly _log: BackupManagerLogger,
    timings?: { debounceTimeout?: number, maximumDelay?: number, closedRetention?: number }
  ) {
    this._pendingPersists = new Map()
    this._operationQueues = new Map()
    this._debounceTimeout = timings?.debounceTimeout ?? BACKUP_DEBOUNCE_TIMEOUT
    this._maximumDelay = timings?.maximumDelay ?? BACKUP_MAXIMUM_DELAY
    this._closedRetention = timings?.closedRetention ?? CLOSED_BACKUP_RETENTION
  }

  /**
   * Ensures the backup directory exists and removes expired backups. Must be
   * called once during boot, BEFORE any editor requests documents.
   *
   * @param  {string[]}  openFilePaths  Every file path that is part of the
   *                                    restored session (i.e. open in a tab)
   */
  async boot (openFilePaths: string[]): Promise<void> {
    await fs.mkdir(this._backupDirectory, { recursive: true })
    await this.cleanup(openFilePaths)
  }

  /**
   * Schedules a (debounced) persist of the current editing state for the
   * given file. The content is only computed when the backup is actually
   * written, so that always the newest state ends up on disk.
   *
   * @param  {string}        filePath    The original file's absolute path
   * @param  {() => string}  getContent  Callback yielding the current content
   */
  public schedulePersist (filePath: string, getContent: () => string): void {
    const existing = this._pendingPersists.get(filePath)
    if (existing !== undefined) {
      clearTimeout(existing.timeout)
      existing.getContent = getContent
      if (Date.now() - existing.earliestChangeAt >= this._maximumDelay) {
        // The user has been typing continuously; persist immediately.
        this.flush(filePath).catch(err => this._logError(filePath, err))
        return
      }

      existing.timeout = setTimeout(() => {
        this.flush(filePath).catch(err => this._logError(filePath, err))
      }, this._debounceTimeout)
      return
    }

    this._pendingPersists.set(filePath, {
      earliestChangeAt: Date.now(),
      getContent,
      timeout: setTimeout(() => {
        this.flush(filePath).catch(err => this._logError(filePath, err))
      }, this._debounceTimeout)
    })
  }

  /**
   * Immediately writes the pending backup for the given file, if one exists.
   *
   * @param  {string}  filePath  The original file's absolute path
   */
  public async flush (filePath: string): Promise<void> {
    await this._serialized(filePath, async () => { await this._flushUnqueued(filePath) })
  }

  /**
   * Immediately writes all pending backups. Used on shutdown.
   */
  public async flushAll (): Promise<void> {
    for (const filePath of [...this._pendingPersists.keys()]) {
      await this.flush(filePath)
    }
  }

  /**
   * Returns true if there are backups scheduled but not yet written to disk.
   */
  public hasPendingPersists (): boolean {
    return this._pendingPersists.size > 0
  }

  /**
   * Writes the given content as the backup state for filePath. The content
   * file is written atomically (tmp file + rename) so that a crash mid-write
   * cannot corrupt an existing backup.
   *
   * @param  {string}  filePath  The original file's absolute path
   * @param  {string}  content   The current editor content (LF linefeeds)
   */
  public async persistNow (filePath: string, content: string): Promise<void> {
    await this._serialized(filePath, async () => { await this._persistUnqueued(filePath, content) })
  }

  /**
   * Removes the backup for the given file (including any pending, not yet
   * written state). Called after a successful save, or when the user decides
   * to discard a retained backup.
   *
   * @param  {string}  filePath  The original file's absolute path
   */
  public async remove (filePath: string): Promise<void> {
    // Cancel the pending state right away, so that no debounce timer firing
    // before the queued removal runs can schedule another write.
    this._cancelPending(filePath)
    await this._serialized(filePath, async () => {
      this._cancelPending(filePath)
      await this._unlinkSilently(this._contentPathFor(filePath) + '.tmp')
      await this._unlinkSilently(this._contentPathFor(filePath))
      await this._unlinkSilently(this._metadataPathFor(filePath))
    })
  }

  /**
   * Marks the backup for the given file as belonging to a closed document.
   * This starts the two-week retention clock. Any pending state is written
   * out first so the backup reflects the very last editing state.
   *
   * @param  {string}  filePath  The original file's absolute path
   */
  public async markClosed (filePath: string): Promise<void> {
    await this._serialized(filePath, async () => {
      await this._flushUnqueued(filePath)
      await this._updateMetadata(filePath, metadata => {
        metadata.closedAt = Date.now()
      })
    })
  }

  /**
   * Marks the backup for the given file as belonging to an open document
   * again (e.g., after the user restored a retained backup).
   *
   * @param  {string}  filePath  The original file's absolute path
   */
  public async markOpen (filePath: string): Promise<void> {
    await this._serialized(filePath, async () => {
      await this._updateMetadata(filePath, metadata => {
        metadata.closedAt = null
      })
    })
  }

  /**
   * Reads the backup state for the given file, if one exists.
   *
   * @param   {string}  filePath  The original file's absolute path
   *
   * @return  {Promise<{ content: string, metadata: BackupMetadata }|undefined>}
   */
  public async read (filePath: string): Promise<{ content: string, metadata: BackupMetadata }|undefined> {
    return await this._serialized(filePath, async () => {
      try {
        const metadata = await this._readMetadata(filePath)
        if (metadata === undefined) {
          return undefined
        }
        const content = await fs.readFile(this._contentPathFor(filePath), 'utf-8')
        return { content, metadata }
      } catch (err: unknown) {
        return undefined
      }
    })
  }

  /**
   * Re-keys a backup after the original file has been moved or renamed, so
   * that the backup keeps following its file.
   *
   * @param  {string}  oldPath  The previous absolute path
   * @param  {string}  newPath  The new absolute path
   */
  public async rename (oldPath: string, newPath: string): Promise<void> {
    await this._serialized(oldPath, async () => {
      await this._serialized(newPath, async () => {
        try {
          await this._flushUnqueued(oldPath)
          const metadata = await this._readMetadata(oldPath)
          if (metadata === undefined) {
            return
          }

          await fs.rename(this._contentPathFor(oldPath), this._contentPathFor(newPath))
          metadata.filePath = newPath
          await fs.writeFile(this._metadataPathFor(newPath), JSON.stringify(metadata), 'utf-8')
          await this._unlinkSilently(this._metadataPathFor(oldPath))
        } catch (err: unknown) {
          this._logError(oldPath, err)
        }
      })
    })
  }

  /**
   * Removes expired backups. A backup expires when its document has been
   * closed without saving for longer than the retention period. Backups that
   * are marked open but whose file is not part of the restored session (e.g.
   * because the containing window was discarded) get their retention clock
   * started now. Orphaned and temporary files are removed as well.
   *
   * @param  {string[]}  openFilePaths  All file paths in the restored session
   */
  public async cleanup (openFilePaths: string[]): Promise<void> {
    let entries: string[] = []
    try {
      entries = await fs.readdir(this._backupDirectory)
    } catch (err: unknown) {
      this._log.error('[DocumentBackupManager] Could not read the backup directory', err)
      return
    }

    const now = Date.now()
    const validContentFiles: string[] = []

    for (const entry of entries.filter(e => e.endsWith('.json'))) {
      const metadataPath = path.join(this._backupDirectory, entry)
      const contentPath = path.join(this._backupDirectory, entry.slice(0, -'.json'.length) + '.txt')
      let metadata: BackupMetadata
      try {
        metadata = JSON.parse(await fs.readFile(metadataPath, 'utf-8'))
        if (typeof metadata.filePath !== 'string') {
          throw new Error('Malformed backup metadata')
        }
      } catch (err: unknown) {
        // Unreadable metadata -> remove the whole entry
        await this._unlinkSilently(metadataPath)
        await this._unlinkSilently(contentPath)
        continue
      }

      if (metadata.closedAt !== null && now - metadata.closedAt > this._closedRetention) {
        this._log.info(`[DocumentBackupManager] Removing expired backup for ${metadata.filePath}`)
        await this._unlinkSilently(metadataPath)
        await this._unlinkSilently(contentPath)
        continue
      }

      if (metadata.closedAt === null && !openFilePaths.includes(metadata.filePath)) {
        // The document is marked open but is not part of the restored
        // session, so it must have been closed at some point (e.g. its
        // window was discarded, or the app crashed after the tab was
        // closed). Start the retention clock now.
        metadata.closedAt = now
        try {
          await fs.writeFile(metadataPath, JSON.stringify(metadata), 'utf-8')
        } catch (err: unknown) {
          this._logError(metadata.filePath, err)
        }
      }

      validContentFiles.push(path.basename(contentPath))
    }

    // Finally remove temporary files and content files without metadata
    for (const entry of entries.filter(e => !e.endsWith('.json'))) {
      if (entry.endsWith('.tmp') || !validContentFiles.includes(entry)) {
        await this._unlinkSilently(path.join(this._backupDirectory, entry))
      }
    }
  }

  /**
   * Runs the operation after all previously queued operations for the same
   * file have settled. Operations passed in here must never call another
   * public method for the same file, since that would wait on itself.
   */
  private async _serialized<T> (filePath: string, operation: () => Promise<T>): Promise<T> {
    const previous = this._operationQueues.get(filePath) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(() => undefined, () => undefined)
    this._operationQueues.set(filePath, tail)
    try {
      return await result
    } finally {
      if (this._operationQueues.get(filePath) === tail) {
        this._operationQueues.delete(filePath)
      }
    }
  }

  private _cancelPending (filePath: string): void {
    const pending = this._pendingPersists.get(filePath)
    if (pending !== undefined) {
      clearTimeout(pending.timeout)
      this._pendingPersists.delete(filePath)
    }
  }

  private async _flushUnqueued (filePath: string): Promise<void> {
    const pending = this._pendingPersists.get(filePath)
    if (pending === undefined) {
      return
    }

    this._cancelPending(filePath)
    await this._persistUnqueued(filePath, pending.getContent())
  }

  private async _persistUnqueued (filePath: string, content: string): Promise<void> {
    try {
      const contentPath = this._contentPathFor(filePath)
      const temporaryPath = contentPath + '.tmp'
      await fs.writeFile(temporaryPath, content, 'utf-8')
      await fs.rename(temporaryPath, contentPath)

      const metadata: BackupMetadata = {
        filePath,
        updatedAt: Date.now(),
        closedAt: null
      }
      await fs.writeFile(this._metadataPathFor(filePath), JSON.stringify(metadata), 'utf-8')
    } catch (err: unknown) {
      this._logError(filePath, err)
    }
  }

  private async _updateMetadata (filePath: string, mutate: (metadata: BackupMetadata) => void): Promise<void> {
    try {
      const metadata = await this._readMetadata(filePath)
      if (metadata === undefined) {
        return // No backup -> nothing to update
      }
      mutate(metadata)
      await fs.writeFile(this._metadataPathFor(filePath), JSON.stringify(metadata), 'utf-8')
    } catch (err: unknown) {
      this._logError(filePath, err)
    }
  }

  private async _readMetadata (filePath: string): Promise<BackupMetadata|undefined> {
    try {
      const raw = await fs.readFile(this._metadataPathFor(filePath), 'utf-8')
      const metadata = JSON.parse(raw)
      if (typeof metadata.filePath !== 'string') {
        return undefined
      }
      return metadata
    } catch (err: unknown) {
      return undefined
    }
  }

  private async _unlinkSilently (absolutePath: string): Promise<void> {
    try {
      await fs.unlink(absolutePath)
    } catch (err: unknown) {
      // Ignore: The file did not exist (or is not removable, in which case
      // the cleanup on next boot will retry).
    }
  }

  private _keyFor (filePath: string): string {
    return crypto.createHash('sha1').update(filePath).digest('hex')
  }

  private _contentPathFor (filePath: string): string {
    return path.join(this._backupDirectory, this._keyFor(filePath) + '.txt')
  }

  private _metadataPathFor (filePath: string): string {
    return path.join(this._backupDirectory, this._keyFor(filePath) + '.json')
  }

  private _logError (filePath: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    this._log.error(`[DocumentBackupManager] Backup operation failed for ${filePath}: ${message}`, err)
  }
}
