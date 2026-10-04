/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        PptxPreview command
 * CVM-Role:        <none>
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     This command drives the pandoc PPTX live preview: it opens,
 *                  refreshes, and closes preview sessions on the orchestrator,
 *                  which converts the document's page chunks into PNG slide
 *                  renderings through a resident Python worker and publishes
 *                  the preview state to every window over the
 *                  PPTX_PREVIEW_EVENT_CHANNEL broadcast channel. This file
 *                  only assembles the injected pieces (worker client, content
 *                  fetching, broadcasting, cache location) and prunes the
 *                  image cache in the background.
 *
 * END HEADER
 */

import ZettlrCommand from './zettlr-command'
import { app, dialog } from 'electron'
import path from 'path'
import { promises as fs } from 'fs'
import { parse as parseYAML, stringify as stringifyYAML } from 'yaml'
import broadcastIpcMessage from '@common/util/broadcast-ipc-message'
import isFile from '@common/util/is-file'
import { showNativeNotification } from '@common/util/show-notification'
import { PPTX_PREVIEW_EVENT_CHANNEL } from '@dts/common/pptx-preview'
import type { PptxPreviewCommandArg } from '@dts/common/pptx-preview'
import { PptxPreviewWorkerClient } from './pptx-preview/worker-client'
import { PptxPreviewOrchestrator } from './pptx-preview/preview-orchestrator'
import type { AppServiceContainer } from 'source/app/app-service-container'

/**
 * The Python interpreter that runs the conversion worker (also used by the
 * pptx-export command)
 */
export const PYTHON_PATH = 'C:\\Anaconda_3_13\\python.exe'

/**
 * The settings key under which the default slide template is stored: the
 * template used for documents that do not name one of their own in a
 * `Pandoc_PPTX_Configuration` comment. It is configured per machine -- the
 * first time a preview is opened, the user is asked to select a .potx file,
 * and the choice is persisted in the private settings file below.
 */
const DEFAULT_TEMPLATE_SETTINGS_KEY = 'pptxDefaultTemplatePath'

/**
 * The per-machine private settings file of this fork. In development mode it
 * lives in the repository folder, where the *Private* .gitignore pattern
 * keeps it out of version control; packaged builds use the user data
 * directory instead.
 */
const PRIVATE_SETTINGS_FILE_NAME = 'Settings_Private.yaml'

/**
 * Resolves the private settings file (see PRIVATE_SETTINGS_FILE_NAME).
 */
function resolvePrivateSettingsPath (): string {
  if (app.isPackaged) {
    return path.join(app.getPath('userData'), PRIVATE_SETTINGS_FILE_NAME)
  }
  // Same repository-root derivation as resolveWorkerScriptPath below
  return path.join(__dirname, '../..', PRIVATE_SETTINGS_FILE_NAME)
}

/**
 * Reads the private settings file. A missing or unreadable file counts as an
 * empty settings object.
 */
async function readPrivateSettings (): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = parseYAML(await fs.readFile(resolvePrivateSettingsPath(), 'utf-8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
  } catch (error) {
    return {}
  }
}

/**
 * Writes the private settings file, preserving every key it was read with.
 */
async function writePrivateSettings (settings: Record<string, unknown>): Promise<void> {
  const header = '# Zettlr-LYH per-machine private settings. Not under version control.\n'
  await fs.writeFile(resolvePrivateSettingsPath(), header + stringifyYAML(settings), 'utf-8')
}

/**
 * Bump when the conversion pipeline changes behaviour, to invalidate every
 * cached rendering. Version 2: the template is chosen per document from its
 * configuration comment and travels with every conversion request. Version 3:
 * the renderer distributes table column widths automatically by default.
 * Version 4: the renderer writes $…$ math as native PowerPoint equations.
 * Version 5: second-level bullet indentation inherits from the template
 * instead of being hard-coded by the renderer.
 */
const PIPELINE_VERSION = 5

/**
 * Export width of the rendered slide images
 */
const WIDTH_PIXELS = 1600

/**
 * When the cache holds more than CACHE_PRUNE_THRESHOLD images, the oldest ones
 * (and their sidecars) are deleted until CACHE_PRUNE_TARGET remain
 */
const CACHE_PRUNE_THRESHOLD = 3000
const CACHE_PRUNE_TARGET = 2000

/**
 * Resolves the worker script the same way the pandoc binary is resolved in
 * environment-check.ts: packaged builds carry it in process.resourcesPath,
 * development mode falls back to the repository's resources directory.
 */
function resolveWorkerScriptPath (): string {
  const relativeScriptPath = path.join('pptx-preview', 'pptx_preview_worker.py')
  const packagedPath = path.join(process.resourcesPath, relativeScriptPath)
  if (isFile(packagedPath)) {
    return packagedPath
  }
  return path.join(__dirname, '../../resources', relativeScriptPath)
}

export default class PptxPreview extends ZettlrCommand {
  private workerClient: PptxPreviewWorkerClient|undefined
  private orchestrator: PptxPreviewOrchestrator|undefined
  private cacheDirectory: string|undefined
  private cachePruneRunning: boolean
  /** The in-flight default-template prompt, shared by concurrent opens */
  private templatePrompt: Promise<string|undefined>|undefined

  constructor (app: AppServiceContainer) {
    super(app, 'pptx-preview')
    this.cachePruneRunning = false
  }

  /**
   * Opens, refreshes, or closes a PPTX preview session.
   *
   * @param   {string}                 evt  The event name
   * @param   {PptxPreviewCommandArg}  arg  The action and the file path
   *
   * @return  {Promise<boolean>}            Whether the request was accepted
   */
  async run (evt: string, arg: PptxPreviewCommandArg): Promise<boolean> {
    if (typeof arg?.filePath !== 'string' || arg.filePath === '') {
      this._app.log.error('[PptxPreview] Cannot run: no file path provided')
      return false
    }

    // Only 'open' may assemble the orchestrator (which may ask the user for
    // the default template on first use); 'refresh' and 'close' are
    // meaningless while no session has ever been opened.
    const orchestrator = arg.action === 'open' ? await this.ensureOrchestrator() : this.orchestrator
    if (orchestrator === undefined) {
      if (arg.action === 'open') {
        this._app.log.warning('[PptxPreview] Not opening a preview: no default template is configured.')
      }
      return false
    }

    switch (arg.action) {
      case 'open':
        orchestrator.openSession(arg.filePath)
        void this.pruneCache()
        return true
      case 'refresh':
        orchestrator.refreshSession(arg.filePath)
        return true
      case 'close':
        orchestrator.closeSession(arg.filePath)
        return true
      default:
        this._app.log.error(`[PptxPreview] Unknown action: ${String(arg.action)}`)
        return false
    }
  }

  /**
   * Returns the default template path from the private settings file, asking
   * the user to select one (and persisting the choice) when no valid path is
   * configured yet. Returns undefined if the user cancels the selection.
   * Concurrent calls share one prompt.
   */
  private async resolveDefaultTemplatePath (): Promise<string|undefined> {
    if (this.templatePrompt !== undefined) {
      return await this.templatePrompt
    }

    const prompt = this.promptForDefaultTemplateIfNeeded()
    this.templatePrompt = prompt
    try {
      return await prompt
    } finally {
      this.templatePrompt = undefined
    }
  }

  private async promptForDefaultTemplateIfNeeded (): Promise<string|undefined> {
    const settings = await readPrivateSettings()
    const configured = settings[DEFAULT_TEMPLATE_SETTINGS_KEY]
    if (typeof configured === 'string' && isFile(configured)) {
      return configured
    }

    const result = await dialog.showOpenDialog({
      title: 'Select the default PPTX template',
      message: 'Select the PowerPoint template used for documents that do not name a template of their own. ' +
        `The choice is stored in ${PRIVATE_SETTINGS_FILE_NAME} and can be changed there.`,
      filters: [{ name: 'PowerPoint templates', extensions: [ 'potx', 'pptx' ] }],
      properties: ['openFile']
    })

    if (result.canceled || result.filePaths.length === 0) {
      showNativeNotification('The PPTX preview needs a default template. Toggle the preview again to select one.')
      return undefined
    }

    const chosen = result.filePaths[0]
    settings[DEFAULT_TEMPLATE_SETTINGS_KEY] = chosen
    try {
      await writePrivateSettings(settings)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this._app.log.error(`[PptxPreview] Could not save the default template choice: ${message}`)
    }
    return chosen
  }

  /**
   * Lazily assembles the worker client and the orchestrator with their
   * injected dependencies. Returns undefined when no default template is
   * configured and the user declined to select one.
   */
  private async ensureOrchestrator (): Promise<PptxPreviewOrchestrator|undefined> {
    if (this.orchestrator !== undefined) {
      return this.orchestrator
    }

    const defaultTemplatePath = await this.resolveDefaultTemplatePath()
    if (defaultTemplatePath === undefined) {
      return undefined
    }

    this.cacheDirectory = path.join(app.getPath('userData'), 'pptx-preview-cache')

    this.workerClient = new PptxPreviewWorkerClient({
      pythonPath: PYTHON_PATH,
      workerScriptPath: resolveWorkerScriptPath(),
      logger: this.makeLogger()
    })

    this.orchestrator = new PptxPreviewOrchestrator({
      workerClient: this.workerClient,
      fetchContent: async (filePath) => await this.fetchContent(filePath),
      publish: (state) => { broadcastIpcMessage(PPTX_PREVIEW_EVENT_CHANNEL, { state }) },
      logger: this.makeLogger(),
      cacheDirectory: this.cacheDirectory,
      defaultTemplatePath,
      pipelineVersion: PIPELINE_VERSION,
      widthPixels: WIDTH_PIXELS
    })

    // Last line of defense: never leave the worker (and its hidden PowerPoint
    // instance) behind when the application quits.
    app.on('will-quit', () => { this.workerClient?.killSync() })

    return this.orchestrator
  }

  private makeLogger (): { info: (message: string) => void, error: (message: string) => void } {
    return {
      info: (message: string) => { this._app.log.info(message) },
      error: (message: string) => { this._app.log.error(message) }
    }
  }

  /**
   * Returns the document's current text: the in-memory editor state when the
   * file is open and modified (same approach as the export command), otherwise
   * the content on disk.
   */
  private async fetchContent (filePath: string): Promise<string> {
    if (this._app.documents.isModified(filePath)) {
      const cachedVersion = await this._app.documents.getDocument(filePath)
      return cachedVersion.content
    }
    return await this._app.fsal.loadAnySupportedFile(filePath)
  }

  /**
   * Deletes the oldest cached images (and their sidecars) when the cache has
   * grown beyond CACHE_PRUNE_THRESHOLD images. Runs in the background on
   * every 'open'; re-entry is skipped.
   */
  private async pruneCache (): Promise<void> {
    if (this.cachePruneRunning || this.cacheDirectory === undefined) {
      return
    }
    this.cachePruneRunning = true
    try {
      const cacheDirectory = this.cacheDirectory
      let entries: string[]
      try {
        entries = await fs.readdir(cacheDirectory)
      } catch (error) {
        return // The cache directory does not exist yet
      }

      const imageFileNames = entries.filter(name => name.endsWith('.png'))
      if (imageFileNames.length <= CACHE_PRUNE_THRESHOLD) {
        return
      }

      const withModificationTimes: Array<{ fileName: string, mtimeMs: number }> = []
      for (const fileName of imageFileNames) {
        try {
          const stat = await fs.stat(path.join(cacheDirectory, fileName))
          withModificationTimes.push({ fileName, mtimeMs: stat.mtimeMs })
        } catch (error) {
          // Deleted in the meantime
        }
      }
      withModificationTimes.sort((a, b) => a.mtimeMs - b.mtimeMs)

      const deleteCount = withModificationTimes.length - CACHE_PRUNE_TARGET
      let deletedImages = 0
      for (const entry of withModificationTimes.slice(0, deleteCount)) {
        try {
          await fs.unlink(path.join(cacheDirectory, entry.fileName))
          deletedImages++
        } catch (error) {
          continue
        }
        const keyMatch = /^(.+)_\d{2}\.png$/.exec(entry.fileName)
        if (keyMatch !== null) {
          try {
            await fs.unlink(path.join(cacheDirectory, `${keyMatch[1]}.json`))
          } catch (error) {
            // The sidecar is already gone
          }
        }
      }
      this._app.log.info(`[PptxPreview] Cache pruned: deleted ${deletedImages} old image(s)`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this._app.log.error(`[PptxPreview] Cache pruning failed: ${message}`)
    } finally {
      this.cachePruneRunning = false
    }
  }
}
