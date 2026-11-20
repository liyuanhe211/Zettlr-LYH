/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        PersistentDataContainer
 * CVM-Role:        Model
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     The persistent data container is a simple class that allows
 *                  one to continuously persist some data to disk. The container
 *                  will make sure to balance disk load and persistence.
 *
 * END HEADER
 */

import { promises as fs, constants as FSConstants, readFileSync } from 'fs'
import { parse as parseYAML, stringify as stringifyYAML } from 'yaml'
import { writeFileSafely, writeFileSafelySync } from '@common/util/write-file-safely'

// ZETTLR-LYH CRASH-SAFE DATA FILES
//
// After the system crashes of 2026-11-18, config.json came back as 41,161 zero
// bytes and Zettlr refused to start ("Could not retrieve container contents").
// Three measures keep a crash from ever blocking the start again:
//
// 1. Every write is atomic and runs in this order: first the current data
//    file, if it parses, is copied to <name>.backup (itself written safely);
//    then the new contents go into a temporary file, which is flushed, read
//    back, compared and parsed; only then does it replace the data file in a
//    single rename (writeFileSafely). At every moment the disk therefore holds
//    a complete, parseable data file, and the backup holds the version before
//    the latest write. A data file that does not parse never replaces a good
//    backup.
// 2. On the first successful read in a session, the container also refreshes
//    the backup copy, so it exists even if nothing is ever written.
// 3. When the data file exists but cannot be parsed, the container moves it
//    aside (<name>.corrupted-<timestamp>) and restores the backup; without a
//    usable backup, isInitialized() reports false so that the owner starts
//    from its defaults. The outcome is available as `recovery`.

/**
 * Describes how the container dealt with a data file it could not parse.
 */
export interface PersistentDataRecovery {
  /**
   * restored-from-backup: the data now comes from <name>.backup.
   * reset: no usable backup existed; the owner starts from its defaults.
   */
  outcome: 'restored-from-backup'|'reset'
  /** Why the data file was rejected */
  reason: string
  /** Where the rejected file was moved to, if it was not empty */
  corruptedCopyPath?: string
}

export default class PersistentDataContainer<T = any> {
  /**
   * The absolute path to the data file. Must include the file extension (e.g.,
   * yaml or json).
   *
   * @var {string}
   */
  private readonly _filePath: string
  /**
   * The datatype with which the container should store the data on disk, can be
   * either yaml or json.
   *
   * @var {'yaml'|'json'}
   */
  private readonly _dataType: 'yaml'|'json'
  /**
   * The data of the container. Initially set to undefined, after initializing/
   * getting of the data, contains the most recent data. Will be overwritten by
   * calling set()
   *
   * @var {T}
   */
  private _data: T

  /**
   * Holds the most recent timeout for writing the data to disk if applicable
   *
   * @var {NodeJS.Timeout|undefined}
   */
  private _timeout: NodeJS.Timeout|undefined

  /**
   * The delay (in milliseconds) of wait before actually writing the data to
   * disk.
   *
   * @var {number}
   */
  private _delay: number

  /**
   * Serializes the asynchronous writes so that an older snapshot can never
   * replace a newer one on the disk.
   */
  private _writeChain: Promise<void> = Promise.resolve()

  /**
   * Whether the backup copy has already been refreshed in this session.
   */
  private _backupRefreshed = false

  /**
   * Set when the data file could not be parsed (see PersistentDataRecovery).
   */
  private _recovery: PersistentDataRecovery|undefined

  /**
   * Creates a new persistent data container.
   *
   * @param   {string}         filePath  The absolute path to the data file
   * @param   {'yaml'|'json'}  type      The file format to use, defaults to JSON
   * @param   {number}         delay     The time to wait before writing, defaults to 1000ms
   *
   * @return  {PersistentDataContainer}  The file container
   */
  constructor (filePath: string, type: 'yaml'|'json' = 'json', delay: number = 1000) {
    this._filePath = filePath
    this._dataType = type
    this._delay = delay
  }

  /**
   * The path of the backup copy kept next to the data file.
   */
  public get backupPath (): string {
    return this._filePath + '.backup'
  }

  /**
   * Reports whether (and how) a data file that could not be parsed was
   * replaced in this session; undefined if that never happened.
   */
  public get recovery (): PersistentDataRecovery|undefined {
    return this._recovery
  }

  /**
   * Initializes the container with some data. Must be called before get()
   *
   * @param   {T}      initialData  The initial data to write into the file
   */
  public async init (initialData: T): Promise<void> {
    if (initialData === undefined || initialData === null) {
      throw new Error('Cannot initialize data storage with null or undefined!')
    }

    this._data = initialData
    const serialized = this.stringify()
    await this.enqueueWrite(serialized)
  }

  /**
   * Checks if the data store has already been initialized. If this function
   * returns false, you need to call init() prior. A data file that exists but
   * cannot be parsed is moved aside and replaced by the backup copy; only if
   * no usable backup exists does this function return false.
   *
   * @return  {Promise<boolean>}  Returns whether the store has been initialized
   */
  public async isInitialized (): Promise<boolean> {
    let content: string
    try {
      await fs.access(this._filePath, FSConstants.R_OK | FSConstants.W_OK)
      content = await fs.readFile(this._filePath, 'utf-8')
    } catch (err: any) {
      return false
    }

    try {
      this.parse(content)
      return true
    } catch (err: any) {
      return await this.recoverFromCorruption(String(err.message))
    }
  }

  /**
   * Overwrites the stored data and sets a timeout for writing the data to disk.
   * Writes to disk if no changes occurred after the set amount of delay. NOTE
   * that passing non-serializable objects such as functions will lead to data
   * loss or can throw errors.
   *
   * @param   {T}   newData  The new data
   */
  public set (newData: T): void {
    if (newData === undefined || newData === null) {
      throw new Error('Cannot set the data to "undefined" or "null"!')
    }

    // Clone the data so it becomes detached from the caller. This also ensures
    // that this function already throws an error if the data cannot be serialized.
    this._data = JSON.parse(JSON.stringify(newData))

    if (this._timeout !== undefined) {
      clearTimeout(this._timeout)
    }

    this._timeout = setTimeout(() => { this.flushToDisk() }, this._delay)
  }

  /**
   * Reads the data file and returns the data
   *
   * @return  {Promise<Partial<T>>}  Resolves with the data contained in the file. NOTE that the returned type is a partial T to indicate that the container does not perform a sanity check on the data
   */
  public async get (): Promise<Partial<T>> {
    if (this._timeout !== undefined) {
      // _data contains the most recent iteration, NOT the datafile. So return
      // that one instead.
      return this._data
    }

    let content: string
    try {
      content = await fs.readFile(this._filePath, { encoding: 'utf-8' })
    } catch (err: any) {
      throw new Error('Could not retrieve container contents: Either the contents were malformed, or you forgot to init the container. ' + String(err.message))
    }

    try {
      this._data = this.parse(content)
    } catch (err: any) {
      if (await this.recoverFromCorruption(String(err.message))) {
        return this._data
      }
      throw new Error('Could not retrieve container contents: Either the contents were malformed, or you forgot to init the container. ' + String(err.message))
    }

    await this.refreshBackup(content)
    return this._data
  }

  /**
   * Changes the delay of waiting time before writing (in milliseconds)
   *
   * @param   {number}  delay  The new delay in ms
   */
  public setDelay (delay: number): void {
    this._delay = delay
  }

  /**
   * Parses the contents of a data file. Throws if the contents are not valid
   * or do not describe an object or array (a file of zero bytes, for example,
   * is rejected here).
   *
   * @param   {string}  content  The file contents
   *
   * @return  {T}                The parsed data
   */
  private parse (content: string): T {
    if (content.trim() === '') {
      throw new Error('The data file is empty.')
    }
    const data = this._dataType === 'json' ? JSON.parse(content) : parseYAML(content)
    if (data === null || typeof data !== 'object') {
      throw new Error(`The data file does not contain an object or array (found ${data === null ? 'null' : typeof data}).`)
    }
    return data
  }

  /**
   * Handles a data file that exists but cannot be parsed: moves it aside and
   * restores the backup copy if that one can be parsed.
   *
   * @param   {string}            reason  Why the data file was rejected
   *
   * @return  {Promise<boolean>}          True if the backup was restored
   */
  private async recoverFromCorruption (reason: string): Promise<boolean> {
    let corruptedCopyPath: string|undefined
    try {
      const stat = await fs.stat(this._filePath)
      if (stat.size > 0) {
        corruptedCopyPath = await this.corruptedCopyPathFor(this._filePath)
        await fs.rename(this._filePath, corruptedCopyPath)
      }
    } catch (err: any) {
      console.error(`[PersistentDataContainer] Could not move the unreadable file ${this._filePath} aside: ${String(err.message)}`)
      corruptedCopyPath = undefined
    }

    let backupContent: string|undefined
    let backupData: T|undefined
    try {
      backupContent = await fs.readFile(this.backupPath, 'utf-8')
      backupData = this.parse(backupContent)
    } catch (err: any) {
      backupData = undefined
    }

    if (backupData !== undefined && backupContent !== undefined) {
      this._data = backupData
      await this.enqueueWrite(backupContent)
      this._backupRefreshed = true // The backup is what we just restored
      this._recovery = { outcome: 'restored-from-backup', reason, corruptedCopyPath }
      console.warn(`[PersistentDataContainer] ${this._filePath} could not be read (${reason}); restored it from ${this.backupPath}.`)
      return true
    }

    this._recovery = { outcome: 'reset', reason, corruptedCopyPath }
    console.warn(`[PersistentDataContainer] ${this._filePath} could not be read (${reason}) and no usable backup exists; the defaults will be used.`)
    return false
  }

  /**
   * Returns a path next to filePath under which a rejected data file is kept.
   */
  private async corruptedCopyPathFor (filePath: string): Promise<string> {
    const now = new Date()
    const pad = (value: number): string => String(value).padStart(2, '0')
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    const base = `${filePath}.corrupted-${stamp}`
    let candidate = base
    for (let counter = 2; await fs.stat(candidate).then(() => true, () => false); counter++) {
      candidate = `${base}-${counter}`
    }
    return candidate
  }

  /**
   * Keeps a copy of a data file that has just been read successfully, once per
   * session. Failures are only logged: the backup is a safety net, not a
   * requirement for working.
   *
   * @param   {string}  content  The contents that were read and parsed
   */
  private async refreshBackup (content: string): Promise<void> {
    if (this._backupRefreshed) {
      return
    }
    this._backupRefreshed = true
    try {
      const existing = await fs.readFile(this.backupPath, 'utf-8').catch(() => undefined)
      if (existing !== content) {
        await writeFileSafely(this.backupPath, Buffer.from(content, 'utf-8'), message => { console.warn(message) })
      }
    } catch (err: any) {
      console.error(`[PersistentDataContainer] Could not write the backup copy ${this.backupPath}: ${String(err.message)}`)
    }
  }

  /**
   * Queues a crash-safe write of the given serialized data. The returned
   * promise rejects if this particular write fails; the queue itself goes on.
   *
   * @param   {string}         serialized  The complete file contents
   */
  private async enqueueWrite (serialized: string): Promise<void> {
    const write = this._writeChain.then(async () => {
      await this.backupCurrentFile()
      await writeFileSafely(
        this._filePath,
        Buffer.from(serialized, 'utf-8'),
        message => { console.warn(message) },
        readBack => { this.parse(readBack.toString('utf-8')) }
      )
    })
    this._writeChain = write.catch(() => {})
    await write
  }

  /**
   * First step of every write: copies the current data file to the backup
   * path if the file exists and parses. A missing data file (first start,
   * or one just moved aside) is skipped; an unparseable one is skipped with
   * a warning so that it never replaces a good backup. A failure to write
   * the backup cancels the write, so the old file is never replaced without
   * a backup of it.
   */
  private async backupCurrentFile (): Promise<void> {
    let current: string
    try {
      current = await fs.readFile(this._filePath, 'utf-8')
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        return
      }
      throw err
    }
    if (!this.parsesCleanly(current)) {
      console.warn(`[PersistentDataContainer] ${this._filePath} does not parse; the backup copy is kept unchanged.`)
      return
    }
    const existing = await fs.readFile(this.backupPath, 'utf-8').catch(() => undefined)
    if (existing !== current) {
      await writeFileSafely(this.backupPath, Buffer.from(current, 'utf-8'), message => { console.warn(message) })
    }
  }

  /**
   * Synchronous variant of backupCurrentFile for shutdown().
   */
  private backupCurrentFileSync (): void {
    let current: string
    try {
      current = readFileSync(this._filePath, 'utf-8')
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        return
      }
      throw err
    }
    if (!this.parsesCleanly(current)) {
      console.warn(`[PersistentDataContainer] ${this._filePath} does not parse; the backup copy is kept unchanged.`)
      return
    }
    let existing: string|undefined
    try {
      existing = readFileSync(this.backupPath, 'utf-8')
    } catch {
      existing = undefined
    }
    if (existing !== current) {
      writeFileSafelySync(this.backupPath, Buffer.from(current, 'utf-8'))
    }
  }

  /**
   * Returns whether the given file contents parse (see parse()).
   */
  private parsesCleanly (content: string): boolean {
    try {
      this.parse(content)
      return true
    } catch {
      return false
    }
  }

  /**
   * Flushes the content to disk if it has been modified in the meantime
   */
  private flushToDisk (): void {
    if (this._data === undefined) {
      return // No need to flush the data
    }

    if (this._timeout !== undefined) {
      clearTimeout(this._timeout)
      this._timeout = undefined
    }

    this.enqueueWrite(this.stringify()).catch(err => {
      console.error(`[PersistentDataContainer] Could not write ${this._filePath}: ${String(err.message)}`)
    })
  }

  /**
   * Stringifies the data to be written to disk according to the data type
   *
   * @return  {string}  The contained data as a serialized string
   */
  private stringify (): string {
    if (this._dataType === 'json') {
      // By passing a space as the third character, we make the JSON readable
      return JSON.stringify(this._data, undefined, '  ')
    } else {
      return stringifyYAML(this._data)
    }
  }

  /**
   * This shuts down the container. Can be used to speed up the shutdown of the
   * node process since this will clear the timeout and immediately write the
   * data to disk. The final write is synchronous, because the process may exit
   * right afterwards; it is still crash-safe (temporary file, flush, rename).
   * An asynchronous write that is already running at this moment may still
   * finish afterwards; it carries data at most one write delay older.
   */
  public shutdown (): void {
    if (this._timeout === undefined || this._data === undefined) {
      return
    }

    clearTimeout(this._timeout)
    this._timeout = undefined
    try {
      this.backupCurrentFileSync()
      writeFileSafelySync(
        this._filePath,
        Buffer.from(this.stringify(), 'utf-8'),
        readBack => { this.parse(readBack.toString('utf-8')) }
      )
    } catch (err: any) {
      console.error(`[PersistentDataContainer] Could not write ${this._filePath} during shutdown: ${String(err.message)}`)
    }
  }
}
