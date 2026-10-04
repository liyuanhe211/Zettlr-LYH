/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ExportFormulaCalculated command
 * CVM-Role:        <none>
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     This command exports a copy of a Markdown file in which
 *                  every double-bracket physical-quantity formula has been
 *                  replaced by its computed outcome, so that any other
 *                  Markdown viewer shows the same result as this editor's
 *                  preview. The copy is written next to the original as
 *                  <name>__LYH_Formula_Calculated_<yyyymmdd_hhmmss>.md and
 *                  the new path is returned to the caller.
 *
 * END HEADER
 */

import ZettlrCommand from './zettlr-command'
import path from 'path'
import { calculateFormulasInMarkdown } from '@common/modules/markdown-utils/formula-calculated-export'
import type { AppServiceContainer } from 'source/app/app-service-container'

/**
 * Formats the current local time as yyyymmdd_hhmmss for the export file name.
 */
export function formatTimestamp (now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${date}_${time}`
}

export default class ExportFormulaCalculated extends ZettlrCommand {
  constructor (app: AppServiceContainer) {
    super(app, 'export-formula-calculated')
  }

  /**
   * Exports a formula-calculated copy of the given (saved) Markdown file.
   *
   * @param   {string}  evt  The event name
   * @param   {{ path: string }}  arg  The path of the source file
   *
   * @return  {Promise<string|false>}  The path of the written copy, or false
   */
  async run (evt: string, arg: { path: string }): Promise<string|false> {
    if (typeof arg?.path !== 'string') {
      this._app.log.error('[ExportFormulaCalculated] Cannot export: no file path provided')
      return false
    }

    const contents = await this._app.fsal.loadAnySupportedFile(arg.path)
    const { result, replacedCount } = calculateFormulasInMarkdown(contents)

    const baseName = path.basename(arg.path, path.extname(arg.path))
    const targetName = `${baseName}__LYH_Formula_Calculated_${formatTimestamp(new Date())}.md`
    const targetPath = path.join(path.dirname(arg.path), targetName)

    await this._app.fsal.writeTextFile(targetPath, result)
    this._app.log.info(`[ExportFormulaCalculated] Replaced ${replacedCount} formula(s); written ${targetPath}`)
    return targetPath
  }
}
