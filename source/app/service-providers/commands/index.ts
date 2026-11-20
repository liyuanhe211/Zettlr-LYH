/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Command loader
 * CVM-Role:        Utility Function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file simply imports all commands, and exports them in
 *                  a unified object for easy instantiation by zettlr.ts.
 *
 * END HEADER
 */

import DirDelete from './dir-delete'
import DirNewProject from './dir-new-project'
import DirNew from './dir-new'
import DirProjectExport from './dir-project-export'
import DirRemoveProject from './dir-remove-project'
import DirRename from './dir-rename'
import DirRescan from './dir-rescan'
import DirSettings from './dir-settings'
import DirSort from './dir-sort'
import Export from './export'
import ExportFormulaCalculated from './export-formula-calculated'
import ExportHTML from './export-html'
import FetchLinkPreview from './fetch-link-preview'
import FileDelete from './file-delete'
import FileDuplicate from './file-duplicate'
import FileNew from './file-new'
import FileRename from './file-rename'
import FileSearch from './file-search'
import ForceOpen from './force-open'
import FileFindAndReturnMetaData from './file-find-and-return-meta-data'
import ImportLangFile from './import-lang-file'
import ImportFiles from './import'
import IncreasePomodoro from './increase-pomodoro'
import JevSearch from './jev-search'
import LanguageTool from './language-tool'
import ListScratchNotes from './list-scratch-notes'
import OpenAttachment from './open-attachment'
import OpenAuxWindow from './open-aux-window'
import PptxExport from './pptx-export'
import PptxPreview from './pptx-preview'
import Print from './print'
import RequestMove from './request-move'
import RootClose from './root-close'
import RootOpen from './root-open'
import SaveImageFromClipboard from './save-image-from-clipboard'
import TutorialOpen from './tutorial-open'
import UpdateProjectProperties from './update-project-properties'
import UpdateUserDictionary from './update-user-dictionary'
import ProviderContract from '@providers/provider-contract'
import { type AppServiceContainer } from 'source/app/app-service-container'
import type ZettlrCommand from './zettlr-command'
import { app, clipboard, ipcMain, nativeImage, shell } from 'electron'
// Zettlr-LYH R59: for the get-file-bytes command below
import path from 'path'
import { promises as fs } from 'fs'
import enumLangFiles from '@common/util/enum-lang-files'
import enumDictFiles from '@common/util/enum-dict-files'
import RenameTag from './rename-tag'
import WorkspaceSort from './ws-sort'
import { sortExplorerNames } from './sort-explorer-names'
import { getExplorerAppearance } from './explorer-appearance'
import { readImageFileBytes } from './read-image-bytes'
import { getAccountName } from './get-account-name'
import { checkPathKinds, revealPath } from './path-kinds'
import { createPersistentTextReadingPositionStore, TEXT_READING_POSITIONS_FILE_NAME } from '../documents/text-reading-positions'

export const commands = [
  DirDelete,
  DirNewProject,
  DirNew,
  DirProjectExport,
  DirRemoveProject,
  DirRename,
  DirRescan,
  DirSettings,
  DirSort,
  Export,
  ExportFormulaCalculated,
  ExportHTML,
  FetchLinkPreview,
  FileDelete,
  FileDuplicate,
  FileNew,
  FileRename,
  FileSearch,
  FileFindAndReturnMetaData,
  ForceOpen,
  ImportFiles,
  ImportLangFile,
  IncreasePomodoro,
  JevSearch,
  LanguageTool,
  ListScratchNotes,
  OpenAttachment,
  OpenAuxWindow,
  PptxExport,
  PptxPreview,
  Print,
  RenameTag,
  RequestMove,
  RootClose,
  RootOpen,
  SaveImageFromClipboard,
  TutorialOpen,
  UpdateProjectProperties,
  UpdateUserDictionary,
  WorkspaceSort
]

export default class CommandProvider extends ProviderContract {
  private readonly _commands: ZettlrCommand[]
  // Zettlr-LYH R98: persistent reading position of text files
  private readonly _textReadingPositions: ReturnType<typeof createPersistentTextReadingPositionStore>

  // TODO: Right now this just injects the full service container into the
  // commands, but it mayt be better to only provide those which are actually
  // required.
  constructor (private readonly _app: AppServiceContainer) {
    super()
    // Load available commands
    this._commands = commands.map(Command => new Command(this._app))
    this._textReadingPositions = createPersistentTextReadingPositionStore(path.join(app.getPath('userData'), TEXT_READING_POSITIONS_FILE_NAME))

    // Set up the command listener
    ipcMain.handle('application', async (event, { command, payload }) => {
      if (command === 'paste-native') {
        // Target the requesting window, even when another window is focused.
        // Chromium preserves native file lists in the resulting ClipboardEvent;
        // navigator.clipboard.read() only exposes their raster previews.
        event.sender.paste()
        return true
      }
      if (typeof command === 'string') {
        return await this.run(command, payload)
      } else {
        throw new Error(`[Commands] Could not run command "${String(command)}": Not a string`)
      }
    })
  }

  /**
   * Runs a command through the application pipeline
   *
   * @param   {string}  command  The command to run
   * @param   {any}     payload  Any payload, as required depending on the command.
   *
   * @return  {Promise<any>}     The return from running the command
   */
  async run (command: string, payload: unknown): Promise<unknown> {
    // FIRST: Try to run a minimal command for which its own custom function
    // wouldn't make sense.
    if (command === 'get-explorer-appearance') {
      return await getExplorerAppearance(payload)
    } else if (command === 'sort-explorer-names') {
      return await sortExplorerNames(payload)
    } else if (command === 'get-account-name') {
      // Zettlr-LYH (R84, decision 107): default name of the revision author dialog
      return await getAccountName()
    } else if (command === 'check-path-kinds') {
      // Zettlr-LYH R100 (specification C12): which paths in the editor exist.
      // The same fs.stat function is passed on every call, so the concurrency
      // limit and the request merging of path-kinds.ts apply across calls.
      return await checkPathKinds(payload, { stat: fs.stat, shell })
    } else if (command === 'reveal-path') {
      // Zettlr-LYH R100 (specification C12): the folder button behind a path
      return await revealPath(payload, {
        stat: fs.stat,
        shell,
        log: (message: string) => { this._app.log.warning(message) }
      })
    } else if (command === 'get-text-reading-position') {
      // Zettlr-LYH R98: persistent reading position of text files
      return await this._textReadingPositions.store.getPosition(payload)
    } else if (command === 'set-text-reading-position') {
      // Zettlr-LYH R98: persistent reading position of text files
      return await this._textReadingPositions.store.setPosition(payload)
    } else if (command === 'next-file') {
      // Trigger a "forward" command on the document manager
      // await this._app.documents.forward()
      // TODO!!!
      return true
    } else if (command === 'previous-file') {
      // Trigger a "back" command on the document manager
      // await this._app.documents.back()
      // TODO!!!
      return true
    } else if (command === 'copy-img-to-clipboard') {
      // We should copy the contents of an image file to clipboard. Payload
      // contains the image path. We can rely on the Electron framework here.
      if (typeof payload !== 'string') {
        return false
      }

      let imgPath = payload
      if (imgPath.startsWith('safe-file://')) {
        imgPath = imgPath.replace('safe-file://', '')
      } else if (imgPath.startsWith('file://')) {
        imgPath = imgPath.replace('file://', '')
      }

      // Due to the colons in the drive letters on Windows, the pathname will
      // look like this: /C:/Users/Documents/test.jpg
      // See: https://github.com/Zettlr/Zettlr/issues/5489
      if (/^\/[A-Z]:/i.test(imgPath)) {
        imgPath = imgPath.slice(1)
      }

      const img = nativeImage.createFromPath(imgPath)

      if (!img.isEmpty()) {
        clipboard.writeImage(img)
      }
      return true
    } else if (command === 'get-image-file-bytes') {
      return await readImageFileBytes(payload)
    } else if (command === 'get-file-bytes') {
      // Zettlr-LYH R59: the pdf.js-based PDF viewer cannot load safe-file://
      // URLs in the renderer (fetch does not support the scheme, and
      // XMLHttpRequest refuses it as cross-origin), so it requests the bytes
      // of the PDF here. The Buffer arrives in the renderer as a Uint8Array.
      // Only absolute paths of PDF files are served; anything else, and any
      // read error, yields null.
      if (typeof payload !== 'string') {
        return null
      }

      let pdfPath = payload
      if (pdfPath.startsWith('safe-file://') || pdfPath.startsWith('file://')) {
        // A URL: drop the scheme, any query or fragment, and the encoding
        pdfPath = pdfPath.replace(/^(safe-)?file:\/\//, '').replace(/[?#].*$/, '')
        try {
          pdfPath = decodeURIComponent(pdfPath)
        } catch (err: unknown) {
          return null
        }

        // Due to the colons in the drive letters on Windows, the pathname will
        // look like this: /C:/Users/Documents/test.pdf
        if (/^\/[A-Z]:/i.test(pdfPath)) {
          pdfPath = pdfPath.slice(1)
        }
      }

      if (!path.isAbsolute(pdfPath) || path.extname(pdfPath).toLowerCase() !== '.pdf') {
        return null
      }

      try {
        return await fs.readFile(pdfPath)
      } catch (err: unknown) {
        this._app.log.warning(`[Application] Could not read the bytes of PDF file ${pdfPath}: ${err instanceof Error ? err.message : String(err)}`)
        return null
      }
    } else if (command === 'get-file-contents' && typeof payload === 'string') {
      // Some renderer's editor has requested a file
      return await this._app.fsal.loadAnySupportedFile(payload)
    } else if (command === 'open-preferences') {
      this._app.windows.showPreferences()
      return true
    } else if (command === 'open-stats-window') {
      this._app.windows.showStatsWindow()
      return true
    } else if (command === 'open-update-window') {
      this._app.windows.showUpdateWindow()
    } else if (command === 'open-project-preferences' && typeof payload === 'string') {
      this._app.windows.showProjectPropertiesWindow(payload)
    } else {
      // ELSE: If the command has not yet been found, try to run one of the
      // bigger commands
      const cmd: ZettlrCommand|undefined = this._commands.find((elem: ZettlrCommand) => elem.respondsTo(command))
      if (cmd !== undefined) {
        // Return the return value of the command, if there is any
        try {
          return await cmd.run(command, payload)
        } catch (err: unknown) {
          this._app.log.error('[Application] Error received while running command: ' + (err instanceof Error ? err.message : 'Unknown error'), err)
          return false
        }
      } else if (command === 'get-available-languages') {
        return enumLangFiles().map(elem => elem.tag)
      } else if (command === 'get-available-dictionaries') {
        return enumDictFiles().map(elem => elem.tag)
      } else {
        this._app.log.warning(`[Application] Received a request to run command ${command}, but it's not registered.`)
      }
    }
  }

  async shutdown (): Promise<void> {
    // Zettlr-LYH R98: write the pending reading positions to disk
    this._textReadingPositions.flush()
    this._app.log.verbose('Command Provider shutting down ...')
  }
}
