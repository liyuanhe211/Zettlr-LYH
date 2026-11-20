/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        PdfBacklinkProvider class
 * CVM-Role:        Service Provider
 * License:         GNU GPL v3
 *
 * Description:     Serves the PDF backlink index of contract C11 (R62) to the
 *                  windows: answers `get-pdf-backlinks` on the IPC channel
 *                  `pdf-backlink-provider`, feeds FSAL events and changes of
 *                  the open workspaces into the index, and broadcasts
 *                  `pdf-backlinks-updated` whenever the index changes.
 *
 * END HEADER
 */

import { ipcMain } from 'electron'
import { promises as fs } from 'fs'
import broadcastIpcMessage from '@common/util/broadcast-ipc-message'
import { hasMarkdownExt } from '@common/util/file-extention-checks'
import { resolveBacklinkColor, resolvePdfLinkPath, scanPdfLinks } from '@common/modules/pdf-text'
import ProviderContract, { type IPCAPI } from '../provider-contract'
import type LogProvider from '@providers/log'
import type ConfigProvider from '@providers/config'
import type FSAL from '@providers/fsal'
import type { FSALEventPayload, FSALEventPayloadChange, FSALEventPayloadUnlink } from '../fsal'
import type { PdfBacklink, PdfBacklinksUpdatedMessage } from '@dts/common/pdf-viewer'
import { PdfBacklinkIndex } from './backlink-index'

interface PdfBacklinkProviderAPIMap {
  'get-pdf-backlinks': { pdfPath: string }
}

export type PdfBacklinkProviderAPI = IPCAPI<PdfBacklinkProviderAPIMap>

/**
 * True on Windows and macOS, whose file systems ignore case by default
 */
const PATHS_IGNORE_CASE = process.platform === 'win32' || process.platform === 'darwin'

export default class PdfBacklinkProvider extends ProviderContract {
  private readonly _index: PdfBacklinkIndex
  private readonly _onFsalEvent: (payload: FSALEventPayload) => void
  private readonly _onConfigUpdate: (which?: string) => void

  constructor (private readonly _logger: LogProvider, private readonly _config: ConfigProvider, private readonly _fsal: FSAL) {
    super()

    this._index = new PdfBacklinkIndex({
      workspaceRoots: this.openWorkspaces(),
      statFile: async (filePath) => {
        const stat = await fs.stat(filePath)
        return { modificationTime: stat.mtimeMs, size: stat.size }
      },
      readFile: async (filePath) => await fs.readFile(filePath, 'utf8'),
      // The same listing the editor gets through the FSAL's
      // read-path-recursively command, so both sides resolve wiki links alike
      listFiles: async (root) => {
        if (!await this._fsal.isDir(root)) {
          return []
        }
        return await this._fsal.readDirectoryRecursively(root)
      },
      fileExists: async (filePath) => await this._fsal.isFile(filePath),
      isMarkdownFile: hasMarkdownExt,
      scanPdfLinks,
      resolvePdfLinkPath,
      resolveBacklinkColor,
      ignoreCase: PATHS_IGNORE_CASE,
      logger: this._logger,
      onChange: (pdfPaths) => {
        const message: PdfBacklinksUpdatedMessage = { pdfPaths }
        broadcastIpcMessage('pdf-backlinks-updated', message)
      }
    })

    this._onFsalEvent = (payload: FSALEventPayload) => {
      if ('descriptor' in payload) {
        const change: FSALEventPayloadChange = payload
        this._index.handleFileEvent({ kind: change.event, path: change.descriptor.path })
      } else {
        const unlink: FSALEventPayloadUnlink = payload
        this._index.handleFileEvent({ kind: unlink.event, path: unlink.path })
      }
    }

    this._onConfigUpdate = (which?: string) => {
      // The ConfigProvider reports changes of app.openWorkspaces as
      // `openPaths`; a call without argument means the whole configuration
      if (which === undefined || which === 'openPaths' || which === 'app' || which === 'app.openWorkspaces') {
        this._index.setWorkspaceRoots(this.openWorkspaces())
      }
    }

    ipcMain.handle('pdf-backlink-provider', async (event, message: PdfBacklinkProviderAPI): Promise<PdfBacklink[]|undefined> => {
      if (message.command === 'get-pdf-backlinks') {
        const pdfPath = message.payload?.pdfPath
        if (typeof pdfPath !== 'string' || pdfPath === '') {
          return []
        }

        try {
          return await this._index.getBacklinks(pdfPath)
        } catch (err: unknown) {
          this._logger.error(`[PdfBacklinkProvider] Could not get the backlinks of ${pdfPath}: ${err instanceof Error ? err.message : String(err)}`, err)
          return []
        }
      }
    })
  }

  /**
   * The open workspaces, as configured
   */
  private openWorkspaces (): string[] {
    return [...this._config.get().app.openWorkspaces]
  }

  public async boot (): Promise<void> {
    // The index is built on the first request, not here, so booting stays fast
    this._fsal.on('fsal-event', this._onFsalEvent)
    this._config.on('update', this._onConfigUpdate)
    this._index.setWorkspaceRoots(this.openWorkspaces())
  }

  public async shutdown (): Promise<void> {
    this._logger.verbose('PDF backlink provider shutting down ...')
    this._fsal.off('fsal-event', this._onFsalEvent)
    this._config.off('update', this._onConfigUpdate)
    this._index.dispose()
  }
}
