/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        SaveImage command
 * CVM-Role:        <none>
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This command saves an image from clipboard into the
 *                  "_Images" folder next to the document, without asking.
 *
 * END HEADER
 */

import ZettlrCommand from './zettlr-command'
import { trans } from '@common/i18n-main'
import path from 'path'
import md5 from 'md5'
import { promises as fs } from 'fs'
import { clipboard, nativeImage } from 'electron'
import { showNativeNotification } from '@common/util/show-notification'
import {
  buildCandidateFileName,
  buildPastedImageDirectory,
  derivePastedImageFileName
} from '@common/util/paste-image-path'
import type { AppServiceContainer } from 'source/app/app-service-container'

export interface SaveImageFromClipboardAPI {
  basePath: string
  imageName?: string
  imageData: string // base64 encoded image data
}

/**
 * The payload the editor context menu's "Paste" action sends (see
 * copy-paste-cut.ts): it only names the document directory as `startPath` and
 * leaves reading the image to main.
 */
interface ContextMenuPastePayload {
  startPath?: string
}

/**
 * The result of the (no longer used) paste image dialog. It is kept because
 * the window manager's showPasteImageModal still references this type.
 */
export interface PasteModalResult {
  targetDir: string
  name: string
  width: string
  height: string
}

/**
 * Upper bound of numbered alternatives tried when the file name is taken.
 */
const MAXIMUM_NAME_ATTEMPTS = 10000

export default class SaveImage extends ZettlrCommand {
  constructor (app: AppServiceContainer) {
    super(app, 'save-image-from-clipboard')
  }

  /**
   * Takes an image provided for by the renderer (or, if none is provided, the
   * image in the clipboard) and saves it into the "_Images" folder next to the
   * document, creating the folder if necessary. Returns the absolute path to
   * the saved image, or undefined if nothing was saved (the reason is then
   * shown to the user as a notification).
   *
   * @param   {string}  evt  The event name
   * @param   {any}     arg  Options on the image
   * @return  {string}       The absolute path to the saved image
   */
  async run (evt: string, arg: Partial<SaveImageFromClipboardAPI> & ContextMenuPastePayload): Promise<string|undefined> {
    const documentDirectory = arg.basePath ?? arg.startPath ?? ''

    // A document that has never been saved has no directory to save into.
    if (!path.isAbsolute(documentDirectory)) {
      this.notify(trans('Please save the document before pasting an image.'))
      return undefined
    }

    try {
      const directoryStat = await fs.stat(documentDirectory)
      if (!directoryStat.isDirectory()) {
        throw new Error(`Not a directory: ${documentDirectory}`)
      }
    } catch (err: any) {
      this._app.log.error(`[Application] Cannot paste image: The document directory ${documentDirectory} was not found.`, err)
      this.notify(trans('Could not paste the image: The folder of the document was not found.'))
      return undefined
    }

    const hasImageData = arg.imageData !== undefined && arg.imageData !== ''
    const image = hasImageData
      ? nativeImage.createFromDataURL(arg.imageData as string)
      : clipboard.readImage()

    if (image.isEmpty()) {
      this.notify(trans('Could not paste the image: The clipboard does not contain a readable image.'))
      return undefined
    }

    const dataUrl = hasImageData ? arg.imageData as string : image.toDataURL()

    // Same naming rules as the former paste image dialog. Hashing the data URL
    // gives identical images identical names, so pasting the same image twice
    // reuses the existing file (see below).
    const fileName = derivePastedImageFileName({
      providedName: arg.imageName,
      clipboardText: clipboard.readText(),
      contentHash: md5('img' + dataUrl)
    })

    const imageDirectory = buildPastedImageDirectory(documentDirectory)
    const imageBuffer = path.extname(fileName).toLowerCase() === '.jpg'
      ? image.toJPEG(100)
      : image.toPNG()

    try {
      await fs.mkdir(imageDirectory, { recursive: true })

      for (let attempt = 0; attempt < MAXIMUM_NAME_ATTEMPTS; attempt++) {
        const candidatePath = path.join(imageDirectory, buildCandidateFileName(fileName, attempt))
        const existing = await this.readExistingFile(candidatePath)

        if (existing === 'free') {
          // The "wx" flag fails instead of overwriting if another paste has
          // claimed the name in the meantime; then simply try the next one.
          try {
            await fs.writeFile(candidatePath, imageBuffer, { flag: 'wx' })
          } catch (err: any) {
            if (err?.code === 'EEXIST') {
              continue
            }
            throw err
          }
          this._app.log.info(`[Application] Saved pasted image to ${candidatePath}`)
          return candidatePath
        } else if (existing !== 'occupied' && existing.equals(imageBuffer)) {
          // The very same image already exists under this name: reuse it.
          this._app.log.info(`[Application] Pasted image already exists at ${candidatePath}; reusing it.`)
          return candidatePath
        }
        // Otherwise the name is taken by a different file: try the next one.
      }

      throw new Error(`No free file name found for ${fileName} in ${imageDirectory}`)
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err)
      this._app.log.error(`[Application] Could not save pasted image: ${message}`, err)
      this.notify(trans('Could not save the pasted image: %s', message))
      return undefined
    }
  }

  /**
   * Checks what currently exists at the given path.
   *
   * @param   {string}  filePath  The path to check
   *
   * @return  {Promise<Buffer|'free'|'occupied'>}  "free" if nothing exists
   *                                               there, the file contents if
   *                                               it is a file, and "occupied"
   *                                               if it is something else.
   */
  private async readExistingFile (filePath: string): Promise<Buffer|'free'|'occupied'> {
    const stat = await fs.lstat(filePath).catch((err: any) => {
      if (err?.code === 'ENOENT') {
        return undefined
      }
      throw err
    })

    if (stat === undefined) {
      return 'free'
    } else if (!stat.isFile()) {
      return 'occupied'
    } else {
      return await fs.readFile(filePath)
    }
  }

  /**
   * Shows a notification to the user, falling back to the log if the platform
   * does not support notifications.
   *
   * @param   {string}  message  The message to show
   */
  private notify (message: string): void {
    if (!showNativeNotification(message)) {
      this._app.log.warning(`[Application] ${message}`)
    }
  }
}
