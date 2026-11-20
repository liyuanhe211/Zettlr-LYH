/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        RecentDocsProvider class
 * CVM-Role:        Service Provider
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Manages the list of recently viewed documents.
 *
 * END HEADER
 */

import EventEmitter from 'events'
import path from 'path'
import { app } from 'electron'
import ProviderContract from '../provider-contract'
import type LogProvider from '../log'
import PersistentDataContainer from '@common/modules/persistent-data-container'
import { RECENT_FILES_MENU_LIMIT, RECENT_FILES_HISTORY_LIMIT } from '@dts/common/recent-files'

/**
* This class manages recently opened documents. Windows uses application-owned
* history because Electron's system recent list includes other applications.
*/
export default class RecentDocumentsProvider extends ProviderContract {
  private _recentDocs: string[]
  private readonly _emitter: EventEmitter
  private readonly _container: PersistentDataContainer<string[]>|undefined
  private _pendingWrite: Promise<void> = Promise.resolve()

  /**
  * Create the instance on program start.
  */
  constructor (private readonly _logger: LogProvider) {
    super()

    this._recentDocs = [] // This array holds all recent documents

    this._emitter = new EventEmitter()
    if (process.platform === 'win32') {
      this._container = new PersistentDataContainer(path.join(app.getPath('userData'), 'recent-documents.json'), 'json')
    }
  }

  public async boot (): Promise<void> {
    if (this._container === undefined) {
      return
    }

    if (!await this._container.isInitialized()) {
      this.persist()
      await this._pendingWrite
      return
    }

    let storedDocuments: unknown
    try {
      storedDocuments = await this._container.get()
    } catch (error) {
      this._logger.error(`Could not load recent documents: ${String(error)}`)
    }

    const seenPaths = new Set<string>()
    this._recentDocs = Array.isArray(storedDocuments)
      ? storedDocuments.filter((documentPath): documentPath is string => {
        if (!this.isValidPath(documentPath)) {
          return false
        }
        const pathKey = path.win32.normalize(documentPath).toLowerCase()
        if (seenPaths.has(pathKey)) {
          return false
        }
        seenPaths.add(pathKey)
        return true
      }).slice(0, RECENT_FILES_HISTORY_LIMIT)
      : []
    this.persist()
    await this._pendingWrite
  }

  private isValidPath (documentPath: unknown): documentPath is string {
    return typeof documentPath === 'string' && !documentPath.includes('\0') &&
      (process.platform === 'win32' ? path.win32.isAbsolute(documentPath) : path.posix.isAbsolute(documentPath))
  }

  private persist (): void {
    const container = this._container
    if (container === undefined) {
      return
    }

    // The container's delayed set/shutdown writes are not awaitable. Serialize
    // immediate writes so shutdown can await the final snapshot without races.
    const documents = this._recentDocs.slice()
    this._pendingWrite = this._pendingWrite
      .then(async () => { await container.init(documents) })
      .catch(error => { this._logger.error(`Could not save recent documents: ${String(error)}`) })
  }

  on (evt: string, callback: (...args: any[]) => void): void {
    this._emitter.on(evt, callback)
  }

  off (evt: string, callback: (...args: any[]) => void): void {
    this._emitter.off(evt, callback)
  }

  /**
   * Add a document to the list of recently opened documents
   * @param {Object} doc A document exposing at least the metadata of the file
   */
  add (docPath: string): void {
    if (!this.isValidPath(docPath)) {
      return
    }
    // First remove the document if it's already somewhere in the list
    const idx = this._recentDocs.findIndex(documentPath => process.platform === 'win32'
      ? path.win32.normalize(documentPath).toLowerCase() === path.win32.normalize(docPath).toLowerCase()
      : documentPath === docPath)
    if (idx > -1) {
      this._recentDocs.splice(idx, 1)
    }

    // Push the file to the beginning
    this._recentDocs.unshift(docPath)
    // Keep the full history separate from the menu's display limit.
    if (this._recentDocs.length > RECENT_FILES_HISTORY_LIMIT) {
      this._recentDocs = this._recentDocs.slice(0, RECENT_FILES_HISTORY_LIMIT)
    }

    this.persist()
    // Keep Windows taskbar integration independent of application history.
    if (process.platform === 'win32') {
      try {
        app.addRecentDocument(docPath)
      } catch (error) {
        this._logger.error(`Could not update system recent documents: ${String(error)}`)
      }
    } else if (process.platform === 'darwin') {
      app.addRecentDocument(docPath)
    }

    // Finally, announce the fact that the list of recent documents has
    // changed to whomever it may concern
    this._emitter.emit('update')
  }

  /**
   * Clears out the list of recent files
   */
  clear (): void {
    this._recentDocs = []
    this.persist()
    // Windows system history also contains documents from other applications.
    if (process.platform === 'darwin') {
      app.clearRecentDocuments()
    }
    // Announce that the list of recent docs has changed
    this._emitter.emit('update')
  }

  /**
   * Retrieve the recent documents shown in the menu.
   */
  get (): string[] {
    // Return a copy
    return process.platform === 'darwin' ? app.getRecentDocuments() : this._recentDocs.slice(0, RECENT_FILES_MENU_LIMIT)
  }

  /** Return a detached snapshot of the full application history. */
  getAll (): string[] {
    return this._recentDocs.slice()
  }

  /**
  * Shuts down the provider
  * @return {Boolean} Always returns true
  */
  async shutdown (): Promise<void> {
    this._logger.verbose('Recent documents provider shutting down ...')
    await this._pendingWrite
    this._container?.shutdown()
  }
}
