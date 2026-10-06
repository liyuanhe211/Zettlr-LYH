/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ExportHTML command
 * CVM-Role:        <none>
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Writes the standalone HTML document assembled by the main
 *                  window's "Export to HTML" action next to the source file.
 *                  Local images are embedded as data URIs so that the result
 *                  is one self-contained file. Local images that cannot be
 *                  embedded (missing, unreadable, or of an unknown format)
 *                  are linked by their path relative to the HTML file
 *                  instead, or by an absolute file URL if no relative path
 *                  exists (e.g., the image is on another drive). Remote
 *                  images are left untouched. The target is <name>.html; an
 *                  existing file of that name is only overwritten if it was
 *                  produced by a previous export, otherwise a timestamped
 *                  name is used instead. Since images that could not be
 *                  embedded are missing once the HTML file is opened
 *                  elsewhere or uploaded on its own, a warning dialog then
 *                  lists each of them with the reason (file not found,
 *                  unsupported image format, or file could not be read).
 *                  With "Open after export" enabled, the file is opened in
 *                  the default application only after that warning has been
 *                  closed, so that the browser window cannot cover it.
 *
 * END HEADER
 */

import ZettlrCommand from './zettlr-command'
import path from 'path'
import { dialog, shell, type MessageBoxOptions } from 'electron'
import { promises as fs } from 'fs'
import { fileURLToPath } from 'url'
import { trans } from '@common/i18n-main'
import { formatTimestamp } from './export-formula-calculated'
import { relativeImageURL } from 'source/app/util/relative-image-url'
import {
  buildImageWarning,
  displayImagePath,
  type ImageEmbedFailureReason
} from 'source/app/util/export-html-image-warning'
import {
  EXPORT_HTML_GENERATOR_MARKER,
  imageMimeType,
  inlineLocalImages
} from '@common/modules/markdown-utils/standalone-html-export'
import type { AppServiceContainer } from 'source/app/app-service-container'

/**
 * Turns an image source from the exported HTML into an absolute local path,
 * or returns undefined for remote and already embedded sources.
 *
 * @param   {string}  source             The (entity-decoded) src attribute
 * @param   {string}  documentDirectory  The directory of the exported file
 *
 * @return  {string|undefined}           The absolute path, if local
 */
function resolveImageSource (source: string, documentDirectory: string): string|undefined {
  const trimmed = source.trim()
  if (trimmed === '' || /^(?:https?|data|blob|mailto):/i.test(trimmed)) {
    return undefined
  }

  try {
    if (/^file:/i.test(trimmed)) {
      return fileURLToPath(trimmed)
    }

    const withoutProtocol = trimmed.replace(/^safe-file:\/\//i, '')
    let decoded = withoutProtocol
    try {
      decoded = decodeURI(withoutProtocol)
    } catch {
      // Keep the raw source if it is not valid percent-encoding
    }

    return path.isAbsolute(decoded) ? decoded : path.resolve(documentDirectory, decoded)
  } catch {
    return undefined
  }
}

/**
 * Checks whether a file exists on disk.
 */
async function fileExists (filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

export default class ExportHTML extends ZettlrCommand {
  constructor (app: AppServiceContainer) {
    super(app, 'export-html')
  }

  /**
   * Writes the standalone HTML for the given source file.
   *
   * @param   {string}  evt  The event name
   * @param   {{ path: string, html: string }}  arg  The source file and the assembled HTML
   *
   * @return  {Promise<string|false>}  The path of the written HTML file, or false
   */
  async run (evt: string, arg: { path: string, html: string }): Promise<{ path: string, opened: boolean }|false> {
    if (typeof arg?.path !== 'string' || typeof arg?.html !== 'string') {
      this._app.log.error('[ExportHTML] Cannot export: missing file path or HTML contents')
      return false
    }

    // The HTML file is always written to the document's directory, so the
    // images that cannot be embedded are linked relative to that directory.
    // They are also collected for the warning shown after writing the file;
    // the callback runs once per distinct src.
    const documentDirectory = path.dirname(arg.path)
    const unembeddedImages: Array<{ source: string, absolutePath: string }> = []
    const { html, inlinedCount, linkedCount, failedSources } = await inlineLocalImages(
      arg.html,
      source => resolveImageSource(source, documentDirectory),
      async imagePath => await fs.readFile(imagePath),
      (source, absolutePath) => {
        unembeddedImages.push({ source, absolutePath })
        return relativeImageURL(absolutePath, documentDirectory)
      }
    )

    for (const source of failedSources) {
      this._app.log.warning(`[ExportHTML] Could not embed image ${source}; it is linked by its relative path instead (by its file URL if no relative path exists)`)
    }

    const baseName = path.basename(arg.path, path.extname(arg.path))
    let targetPath = path.join(documentDirectory, `${baseName}.html`)
    if (await fileExists(targetPath)) {
      const existing = await fs.readFile(targetPath, 'utf-8')
      if (!existing.includes(EXPORT_HTML_GENERATOR_MARKER)) {
        targetPath = path.join(documentDirectory, `${baseName}__LYH_HTML_${formatTimestamp(new Date())}.html`)
      }
    }

    await fs.writeFile(targetPath, html, 'utf-8')
    this._app.log.info(`[ExportHTML] Embedded ${inlinedCount} image(s), linked ${linkedCount} image(s) by relative path; written ${targetPath}`)

    // The user must learn about every image that will be missing from the
    // file. The warning is awaited so that the opened file cannot cover it.
    if (unembeddedImages.length > 0) {
      await this.warnAboutUnembeddedImages(unembeddedImages, documentDirectory, targetPath)
    }

    // Like the regular exporter, honor the "Open after export" setting
    let opened = false
    if (this._app.config.get().export.autoOpenExportedFiles) {
      const potentialError = await shell.openPath(targetPath)
      opened = potentialError === ''
      if (!opened) {
        this._app.log.error(`[ExportHTML] Could not open ${targetPath}: ${potentialError}`)
      }
    }

    return { path: targetPath, opened }
  }

  /**
   * Shows a warning that lists the local images that could not be embedded
   * into the HTML file, each with the reason, and resolves once the user has
   * closed it. The reason is determined after the fact: an image whose format
   * cannot be embedded is reported as such; otherwise, it is reported as not
   * found if the file does not exist, and as unreadable if it does. An image
   * reached through several different sources is listed only once. If the
   * dialog fails, the error is logged and the export is not affected.
   *
   * @param   {Array}   images             The images that could not be
   *                                       embedded, as passed to the
   *                                       linkFailedImage callback
   * @param   {string}  documentDirectory  The folder of the Markdown file
   * @param   {string}  targetPath         The path of the written HTML file
   */
  private async warnAboutUnembeddedImages (
    images: Array<{ source: string, absolutePath: string }>,
    documentDirectory: string,
    targetPath: string
  ): Promise<void> {
    const failures: Array<{ displayPath: string, reason: ImageEmbedFailureReason }> = []
    const reportedPaths = new Set<string>()

    for (const image of images) {
      if (reportedPaths.has(image.absolutePath)) {
        continue
      }
      reportedPaths.add(image.absolutePath)

      let reason: ImageEmbedFailureReason
      if (imageMimeType(image.absolutePath) === undefined) {
        reason = 'unsupported-format'
      } else if (!(await fileExists(image.absolutePath))) {
        reason = 'not-found'
      } else {
        reason = 'unreadable'
      }

      failures.push({ displayPath: displayImagePath(image.absolutePath, documentDirectory), reason })
    }

    const { message, detail } = buildImageWarning(failures, path.basename(targetPath))
    const options: MessageBoxOptions = {
      type: 'warning',
      title: 'Export to HTML',
      message,
      detail,
      buttons: [trans('Ok')],
      defaultId: 0
    }

    try {
      const parentWindow = this._app.windows.getFirstMainWindow()
      if (parentWindow !== undefined) {
        await dialog.showMessageBox(parentWindow, options)
      } else {
        await dialog.showMessageBox(options)
      }
    } catch (error) {
      this._app.log.error('[ExportHTML] Could not show the warning about the images that could not be embedded', error)
    }
  }
}
