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
 *                  is one self-contained file. The target is <name>.html; an
 *                  existing file of that name is only overwritten if it was
 *                  produced by a previous export, otherwise a timestamped
 *                  name is used instead. With "Open after export" enabled,
 *                  the file is then opened in the default application.
 *
 * END HEADER
 */

import ZettlrCommand from './zettlr-command'
import path from 'path'
import { shell } from 'electron'
import { promises as fs } from 'fs'
import { fileURLToPath } from 'url'
import { formatTimestamp } from './export-formula-calculated'
import {
  EXPORT_HTML_GENERATOR_MARKER,
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

    const documentDirectory = path.dirname(arg.path)
    const { html, inlinedCount, failedSources } = await inlineLocalImages(
      arg.html,
      source => resolveImageSource(source, documentDirectory),
      async imagePath => await fs.readFile(imagePath)
    )

    for (const source of failedSources) {
      this._app.log.warning(`[ExportHTML] Could not embed image ${source}; it is kept as a link`)
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
    this._app.log.info(`[ExportHTML] Embedded ${inlinedCount} image(s); written ${targetPath}`)

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
}
