/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        RecoveryJournalProvider class
 * CVM-Role:        Service Provider
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH data loss prevention (R173, specification C21
 *                  section 5.3): offers the recovery journal to the renderers.
 *                  The channel `recovery-journal` answers the four commands
 *                  `append`, `list-recoverable`, `resolve` and `preserve-text`;
 *                  the channel `recovery-journal-flush` takes the payload of
 *                  `append` without answering, for editors that are being
 *                  destroyed and pages that are being unloaded. The provider
 *                  remembers which page writes which session, so that the
 *                  store can tell sessions in progress from sessions whose
 *                  page is gone. The journal never passes through the document
 *                  synchronization and never reads the state of a document.
 *
 * END HEADER
 */

import path from 'path'
import { app, ipcMain, type WebContents } from 'electron'
import ProviderContract from '../provider-contract'
import type LogProvider from '../log'
import RecoveryJournalStore, {
  type RecoveryJournalAppendPayload,
  type RecoveryJournalIPCAPI,
  type RecoveryJournalRecord,
  type RecoveryJournalResolution
} from './journal-store'

const RECOVERY_JOURNAL_CHANNEL = 'recovery-journal'
const RECOVERY_JOURNAL_FLUSH_CHANNEL = 'recovery-journal-flush'
/** The journal is cleaned up at boot and then once per hour */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000

/** A page (webContents) that has written at least one session */
interface TrackedPage {
  contents: WebContents
  /** Increases whenever the page is reloaded or its renderer process is gone */
  generation: number
}

/** Which page wrote a session, and which generation of the page it was */
interface SessionWriter {
  webContentsId: number
  generation: number
}

function isObject (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString (payload: Record<string, unknown>, property: string): string {
  const value = payload[property]
  if (typeof value !== 'string') {
    throw new Error(`The recovery journal expects the property ${property} to be a string`)
  }
  return value
}

export default class RecoveryJournalProvider extends ProviderContract {
  private readonly _store: RecoveryJournalStore
  private readonly _pages: Map<number, TrackedPage>
  private readonly _sessionWriters: Map<string, SessionWriter>
  private _cleanupTimer: NodeJS.Timeout|undefined

  constructor (private readonly _logger: LogProvider) {
    super()

    this._pages = new Map()
    this._sessionWriters = new Map()
    this._cleanupTimer = undefined
    // The journal stores the text and every step in the clear, so it lives in
    // the user data directory, next to the backups of unsaved changes
    this._store = new RecoveryJournalStore(
      path.join(app.getPath('userData'), 'recovery-journal'),
      this._logger,
      {
        now: () => Date.now(),
        isSessionLive: sessionId => this._isSessionLive(sessionId)
      }
    )
  }

  public async boot (): Promise<void> {
    this._logger.verbose('Recovery journal provider booting up ...')

    try {
      await this._store.boot()
    } catch (err) {
      // A journal that cannot be written must not keep the app from starting.
      // Every append will fail and be logged, and the editors report it.
      this._logger.error(`[Recovery Journal] Could not create the journal folders: ${err instanceof Error ? err.message : String(err)}`, err)
    }

    ipcMain.handle(RECOVERY_JOURNAL_CHANNEL, async (event, message: RecoveryJournalIPCAPI) => {
      return await this._handleCommand(event.sender, message)
    })

    ipcMain.on(RECOVERY_JOURNAL_FLUSH_CHANNEL, (event, payload: unknown) => {
      // Nobody waits for an answer; the store has logged the failure already
      this._append(event.sender, payload).catch(() => {})
    })

    // No session is live at this point, so every session without an end record
    // is recoverable, and the cleanup does not touch recoverable sessions.
    this._runCleanup()
    this._cleanupTimer = setInterval(() => { this._runCleanup() }, CLEANUP_INTERVAL_MS)
    this._cleanupTimer.unref()
  }

  public async shutdown (): Promise<void> {
    this._logger.verbose('Recovery journal provider shutting down ...')
    if (this._cleanupTimer !== undefined) {
      clearInterval(this._cleanupTimer)
      this._cleanupTimer = undefined
    }
    // The pages have sent their last records while they were unloaded; wait
    // until all of them are on disk.
    await this._store.idle()
  }

  /**
   * Answers one command of the channel `recovery-journal`.
   *
   * @param   {WebContents}            sender   The page that sent the command
   * @param   {RecoveryJournalIPCAPI}  message  The command and its payload
   *
   * @return  {Promise<unknown>}                The answer of the command
   */
  private async _handleCommand (sender: WebContents, message: RecoveryJournalIPCAPI): Promise<unknown> {
    const command: unknown = isObject(message) ? message.command : undefined
    const payload: unknown = isObject(message) ? message.payload : undefined

    if (command === 'append') {
      await this._append(sender, payload)
      return undefined
    }

    if (command === 'list-recoverable') {
      if (isObject(payload) && payload.filePath !== undefined) {
        return await this._store.listRecoverable(requireString(payload, 'filePath'))
      }
      return await this._store.listRecoverableSummaries()
    }

    if (!isObject(payload)) {
      throw new Error(`The recovery journal command ${String(command)} needs a payload`)
    }

    if (command === 'resolve') {
      // The store checks that the resolution is one of the four known ones
      const resolution = requireString(payload, 'resolution') as RecoveryJournalResolution
      return await this._store.resolve(requireString(payload, 'filePath'), requireString(payload, 'sessionId'), resolution)
    }

    if (command === 'preserve-text') {
      return await this._store.preserveText(
        requireString(payload, 'filePath'),
        requireString(payload, 'sessionId'),
        requireString(payload, 'text'),
        requireString(payload, 'reason')
      )
    }

    throw new Error(`Unknown recovery journal command: ${String(command)}`)
  }

  /**
   * Writes records into a session file and remembers which page wrote them.
   * Resolves once the records are on disk.
   *
   * @param   {WebContents}  sender   The page that sent the records
   * @param   {unknown}      payload  The payload of `append`
   */
  private async _append (sender: WebContents, payload: unknown): Promise<void> {
    if (!isObject(payload)) {
      this._logger.error('[Recovery Journal] Received records without a payload')
      throw new Error('The recovery journal command append needs a payload')
    }

    const { filePath, sessionId, records } = payload as unknown as RecoveryJournalAppendPayload
    if (typeof sessionId === 'string' && !this._sessionWriters.has(sessionId)) {
      const page = this._trackPage(sender)
      this._sessionWriters.set(sessionId, { webContentsId: sender.id, generation: page.generation })
    }

    await this._store.append(filePath, sessionId, records)

    // A session with an end record is never asked about again
    if (records.some((record: RecoveryJournalRecord) => record.type === 'end')) {
      this._sessionWriters.delete(sessionId)
    }
  }

  /**
   * Starts to watch a page, so that its sessions stop counting as live once
   * the page is destroyed, is reloaded, or loses its renderer process.
   *
   * @param   {WebContents}  contents  The page
   *
   * @return  {TrackedPage}            The page with its current generation
   */
  private _trackPage (contents: WebContents): TrackedPage {
    const existing = this._pages.get(contents.id)
    if (existing !== undefined) {
      return existing
    }

    const page: TrackedPage = { contents, generation: 0 }
    const webContentsId = contents.id
    this._pages.set(webContentsId, page)

    // `did-navigate` fires when a navigation of the main frame is committed,
    // which includes every reload, but not navigations within the page. The
    // sessions keep the generation of their first write, so records that the
    // old page sends while it is unloaded do not make its sessions live again.
    contents.on('did-navigate', () => { page.generation++ })
    contents.on('render-process-gone', () => { page.generation++ })
    contents.once('destroyed', () => {
      this._pages.delete(webContentsId)
      for (const [ sessionId, writer ] of this._sessionWriters) {
        if (writer.webContentsId === webContentsId) {
          this._sessionWriters.delete(sessionId)
        }
      }
    })

    return page
  }

  /**
   * A session is live if it was written during this run of the main process,
   * and the page that wrote it still exists, still has its renderer process,
   * and has not been reloaded since the first write.
   *
   * @param   {string}   sessionId  The session
   *
   * @return  {boolean}             Whether the session is live
   */
  private _isSessionLive (sessionId: string): boolean {
    const writer = this._sessionWriters.get(sessionId)
    if (writer === undefined) {
      return false
    }

    const page = this._pages.get(writer.webContentsId)
    if (page === undefined || page.contents.isDestroyed() || page.contents.isCrashed()) {
      return false
    }

    return page.generation === writer.generation
  }

  private _runCleanup (): void {
    this._store.cleanup().catch(err => {
      this._logger.error(`[Recovery Journal] Cleanup failed: ${err instanceof Error ? err.message : String(err)}`, err)
    })
  }
}
