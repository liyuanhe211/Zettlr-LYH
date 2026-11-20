/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ListScratchNotes command
 * CVM-Role:        <none>
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Lists the scratch notes (R40, R102) that lie in the scratch
 *                  folder on disk, whether or not they are open as tabs. The
 *                  Unsaved Files folder of the Files section lists every scratch
 *                  note with content, also those whose tab is gone, for example
 *                  because the editor pane that showed them was closed (R144).
 *                  Only the files directly in the scratch folder count, so the
 *                  discarded notes in the _Discarded subfolder never appear.
 *
 * END HEADER
 */

import { app } from 'electron'
import type { AppServiceContainer } from 'source/app/app-service-container'
import ZettlrCommand from './zettlr-command'
import { resolveScratchDirectory } from '../documents/scratch-notes'
import { readScratchNotes, type ScratchNoteOnDiskEntry } from './scratch-notes-on-disk'

/**
 * The answer of the list-scratch-notes command.
 */
export interface ListScratchNotesResult {
  /** The resolved absolute scratch folder */
  directory: string
  /** The scratch notes directly in that folder, sorted by file name */
  notes: ScratchNoteOnDiskEntry[]
}

export default class ListScratchNotes extends ZettlrCommand {
  constructor (container: AppServiceContainer) {
    super(container, 'list-scratch-notes')
  }

  /**
   * Lists the scratch notes in the scratch folder.
   *
   * @return  {Promise<ListScratchNotesResult>}  The folder and the notes in it
   */
  async run (): Promise<ListScratchNotesResult> {
    const configured: unknown = this._app.config.get().scratchNotesDirectory
    const directory = resolveScratchDirectory(
      typeof configured === 'string' ? configured : '',
      app.getPath('documents')
    )
    const notes = await readScratchNotes(directory, (message, error) => {
      this._app.log.error(`[ListScratchNotes] ${message}`, error)
    })

    return { directory, notes }
  }
}
