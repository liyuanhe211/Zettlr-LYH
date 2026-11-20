/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        External removal handling
 * CVM-Role:        Utility
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH external removal (R121): The pure part of what
 *                  happens when an open file is deleted or moved away by
 *                  another program. It decides whether a newly appeared file
 *                  in the same folder is the renamed version of the removed
 *                  file, which events fall into the pairing time window, and
 *                  which buttons the "File Removed from Disk" dialog offers
 *                  and what they mean. This module is pure (no Electron and
 *                  no file system imports) so it can be tested in isolation;
 *                  file identities and the result of content comparisons are
 *                  passed in by the caller.
 *
 * END HEADER
 */

import path from 'path'

/**
 * How long before the removal event a newly appeared file still counts as a
 * candidate for the renamed file. On Windows, chokidar may report the "add" of
 * a rename before the "unlink".
 */
export const REMOVAL_PAIRING_WINDOW_BEFORE_MS = 3000

/**
 * How long after the removal event a newly appeared file still counts as a
 * candidate for the renamed file. Polling file watchers delay "add" events.
 */
export const REMOVAL_PAIRING_WINDOW_AFTER_MS = 3000

/**
 * How long a path registered as being touched by Zettlr itself is ignored when
 * the corresponding removal event arrives.
 */
export const INTERNAL_OPERATION_IGNORE_MS = 5000

/**
 * The identity of a file on disk that survives renaming: the volume and the
 * file index (on Windows NTFS, the values of fs.stat with bigint: true).
 */
export interface RemovalFileIdentity {
  dev: bigint
  ino: bigint
}

/**
 * A file that appeared in the time window around the removal event and might
 * be the renamed version of the removed file.
 */
export interface RemovalCandidate {
  /** The absolute path of the new file */
  path: string
  /** The identity of the new file; undefined if it could not be determined */
  identity?: RemovalFileIdentity
  /**
   * Whether the content of the new file is byte-identical to the last saved
   * content of the removed file; undefined if it was not compared
   */
  contentEqualsLastSaved?: boolean
  /** Whether the new path is already open as another document in Zettlr */
  isOpenElsewhere: boolean
}

/**
 * The outcome of pairing a removed file with the candidates:
 * - 'renamed': exactly one candidate was recognized as the renamed file.
 *   openElsewhere is true if that path is already open as another document.
 * - 'ambiguous': several candidates qualify; none is chosen automatically
 * - 'not-found': no candidate qualifies
 */
export type RemovalPairingResult =
  { kind: 'renamed', path: string, openElsewhere: boolean } |
  { kind: 'ambiguous', paths: string[] } |
  { kind: 'not-found' }

/**
 * Returns the path module whose rules apply on the given platform: Windows
 * paths accept both separators, other platforms only the forward slash.
 */
function getPathModule (platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix
}

/**
 * Brings a path into a form in which two paths pointing to the same file are
 * equal strings: resolved and normalized, and on Windows lowercased, because
 * Windows does not distinguish letter case and treats "\" and "/" alike. The
 * result is only meant for comparison, never for display or file access.
 *
 * @param   {string}           filePath  The path to normalize
 * @param   {NodeJS.Platform}  platform  The platform whose rules apply
 *
 * @return  {string}                     The comparison form of the path
 */
export function normalizePathForComparison (filePath: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = getPathModule(platform).resolve(filePath)
  return platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * Tells whether a file event falls into the time window in which an appearing
 * file is considered a candidate for the renamed version of a removed file:
 * from REMOVAL_PAIRING_WINDOW_BEFORE_MS before to REMOVAL_PAIRING_WINDOW_AFTER_MS
 * after the removal, both ends included.
 *
 * @param   {number}   eventTime    When the event arrived (ms since epoch)
 * @param   {number}   removalTime  When the removal arrived (ms since epoch)
 *
 * @return  {boolean}               True if the event is inside the window
 */
export function isWithinPairingWindow (eventTime: number, removalTime: number): boolean {
  return eventTime >= removalTime - REMOVAL_PAIRING_WINDOW_BEFORE_MS &&
    eventTime <= removalTime + REMOVAL_PAIRING_WINDOW_AFTER_MS
}

/**
 * A file index of 0 means that the file system does not provide a usable
 * index (for example some network drives), so such an identity proves nothing.
 */
function hasUsableIdentity (identity: RemovalFileIdentity|undefined): identity is RemovalFileIdentity {
  return identity !== undefined && identity.ino !== 0n
}

function identitiesMatch (first: RemovalFileIdentity|undefined, second: RemovalFileIdentity|undefined): boolean {
  return hasUsableIdentity(first) &&
    hasUsableIdentity(second) &&
    first.dev === second.dev &&
    first.ino === second.ino
}

/**
 * Combines two candidates with the same path (for example the same "add" event
 * reported by two file watchers) into one, so that a single new file is never
 * mistaken for several candidates.
 */
function mergeCandidates (first: RemovalCandidate, second: RemovalCandidate): RemovalCandidate {
  const contentEqualsLastSaved = first.contentEqualsLastSaved === true || second.contentEqualsLastSaved === true
    ? true
    : first.contentEqualsLastSaved ?? second.contentEqualsLastSaved

  return {
    path: first.path,
    identity: hasUsableIdentity(first.identity) ? first.identity : second.identity ?? first.identity,
    contentEqualsLastSaved,
    isOpenElsewhere: first.isOpenElsewhere || second.isOpenElsewhere
  }
}

/**
 * Turns the list of candidates that satisfy one criterion into the result: one
 * match is a rename, several are ambiguous, none means that the criterion did
 * not decide anything (undefined).
 */
function resultOfMatches (matches: RemovalCandidate[]): RemovalPairingResult|undefined {
  if (matches.length === 1) {
    return { kind: 'renamed', path: matches[0].path, openElsewhere: matches[0].isOpenElsewhere }
  } else if (matches.length > 1) {
    return { kind: 'ambiguous', paths: matches.map(candidate => candidate.path) }
  }

  return undefined
}

/**
 * Decides whether one of the candidates is the removed file under a new name.
 * Only candidates in the same folder as the removed file take part (a file
 * moved to another folder counts as deleted), and never the removed path
 * itself. The main criterion is that volume and file index equal those that
 * were recorded for the removed file. Only if no candidate satisfies it, the
 * auxiliary criterion applies: the candidate's content equals the last saved
 * content (this covers renaming by copying the file under the new name and
 * deleting the old one). Exactly one match is a rename; several matches are
 * ambiguous and none of them is chosen automatically.
 *
 * Time windows are not considered here: the caller passes only candidates that
 * isWithinPairingWindow accepted.
 *
 * @param   {string}                          removedPath      The path of the removed file
 * @param   {RemovalFileIdentity|undefined}   removedIdentity  The identity recorded for the removed file
 * @param   {RemovalCandidate[]}              candidates       The files that appeared around the removal
 *
 * @return  {RemovalPairingResult}                             The outcome of the pairing
 */
export function pairRemovedFile (
  removedPath: string,
  removedIdentity: RemovalFileIdentity|undefined,
  candidates: RemovalCandidate[]
): RemovalPairingResult {
  const platform = process.platform
  const pathModule = getPathModule(platform)
  const removedKey = normalizePathForComparison(removedPath, platform)
  const removedFolder = pathModule.dirname(removedKey)

  // Keep only the candidates in the same folder, and merge duplicates of the
  // same path. A Map keeps the order in which the paths first appeared.
  const eligible = new Map<string, RemovalCandidate>()
  for (const candidate of candidates) {
    const candidateKey = normalizePathForComparison(candidate.path, platform)
    if (candidateKey === removedKey || pathModule.dirname(candidateKey) !== removedFolder) {
      continue
    }

    const known = eligible.get(candidateKey)
    eligible.set(candidateKey, known === undefined ? candidate : mergeCandidates(known, candidate))
  }
  const remaining = [...eligible.values()]

  if (hasUsableIdentity(removedIdentity)) {
    const byIdentity = resultOfMatches(remaining.filter(candidate => identitiesMatch(candidate.identity, removedIdentity)))
    if (byIdentity !== undefined) {
      return byIdentity
    }
  }

  const byContent = resultOfMatches(remaining.filter(candidate => candidate.contentEqualsLastSaved === true))
  return byContent ?? { kind: 'not-found' }
}

/** What to do after the "File Removed from Disk" dialog */
export type RemovedFileDialogAction = 'open-renamed'|'move-to-unsaved'|'recover-cached'|'discard-and-close'

export interface RemovedFileDialogInput {
  /** The file name (without directory) of the removed file */
  fileName: string
  /** The path the file had before it was removed */
  originalPath: string
  /** The absolute path of the folder for unsaved files (scratch notes) */
  scratchDirectory: string
  /** Whether the editor holds changes that are not yet saved */
  hasUnsavedChanges: boolean
  /** Whether the folder of the original path still exists */
  canRecover: boolean
  /** The path of the file recognized as the renamed file, if it can be opened */
  renamedPath?: string
  /** The path of the file recognized as the renamed file, if it is already open */
  renamedPathOpenElsewhere?: string
}

/**
 * The subset of Electron's MessageBoxOptions this dialog uses. Structurally
 * compatible with MessageBoxOptions, so it can be passed to
 * dialog.showMessageBox directly.
 */
export interface RemovedFileDialogOptions {
  type: 'question'
  title: string
  message: string
  detail: string
  buttons: string[]
  defaultId: number
  cancelId: number
  noLink: boolean
}

const OPEN_RENAMED_FILE_BUTTON = 'Open Renamed File'
const MOVE_TO_UNSAVED_FILES_BUTTON = 'Move to Unsaved Files'
const RECOVER_CACHED_BUTTON = 'Recover Cached'
const DISCARD_AND_CLOSE_BUTTON = 'Discard and Close'

const ACTION_OF_BUTTON: ReadonlyMap<string, RemovedFileDialogAction> = new Map<string, RemovedFileDialogAction>([
  [ OPEN_RENAMED_FILE_BUTTON, 'open-renamed' ],
  [ MOVE_TO_UNSAVED_FILES_BUTTON, 'move-to-unsaved' ],
  [ RECOVER_CACHED_BUTTON, 'recover-cached' ],
  [ DISCARD_AND_CLOSE_BUTTON, 'discard-and-close' ]
])

/**
 * Builds the options of the dialog shown when an open file was deleted or
 * moved away outside of Zettlr. The buttons are, in this order and as far as
 * they apply: Open Renamed File (only if a rename was recognized and the new
 * path is not open yet), Move to Unsaved Files, Recover Cached (only if the
 * folder of the original path still exists), Discard and Close. Escape
 * (cancelId) always selects Move to Unsaved Files, so that dismissing the
 * dialog never loses data.
 *
 * @param   {RemovedFileDialogInput}    input  The removed file and the findings about it
 *
 * @return  {RemovedFileDialogOptions}         The dialog options
 */
export function buildRemovedFileDialogOptions (input: RemovedFileDialogInput): RemovedFileDialogOptions {
  // The file names of the recognized rename; an empty path counts as absent
  const renamedFileName = input.renamedPath !== undefined && input.renamedPath !== ''
    ? path.basename(input.renamedPath)
    : undefined
  const renamedOpenElsewhereFileName = input.renamedPathOpenElsewhere !== undefined && input.renamedPathOpenElsewhere !== ''
    ? path.basename(input.renamedPathOpenElsewhere)
    : undefined
  const offerOpenRenamed = renamedFileName !== undefined

  const buttons: string[] = []
  if (offerOpenRenamed) {
    buttons.push(OPEN_RENAMED_FILE_BUTTON)
  }
  buttons.push(MOVE_TO_UNSAVED_FILES_BUTTON)
  if (input.canRecover) {
    buttons.push(RECOVER_CACHED_BUTTON)
  }
  buttons.push(DISCARD_AND_CLOSE_BUTTON)

  const sections: string[] = []
  if (input.hasUnsavedChanges) {
    sections.push('The editor still contains unsaved changes.')
  }

  sections.push(`Move to Unsaved Files keeps the editor contents as a new unsaved file in: ${input.scratchDirectory}`)

  if (input.canRecover) {
    sections.push(
      `Recover Cached restores the last saved version to: ${input.originalPath}` +
      (input.hasUnsavedChanges ? ' Your unsaved changes stay in the editor.' : '')
    )
  } else {
    sections.push(`Recover Cached is not available because the folder no longer exists: ${path.dirname(input.originalPath)}`)
  }

  sections.push('Discard and Close closes the document without keeping a backup.')

  if (renamedFileName !== undefined) {
    sections.push(
      `It looks like "${input.fileName}" was renamed to "${renamedFileName}" in the same folder. ` +
      'Open the document as the renamed file?'
    )
  }

  if (renamedOpenElsewhereFileName !== undefined) {
    sections.push(
      `It looks like "${input.fileName}" was renamed to "${renamedOpenElsewhereFileName}" in the same folder, ` +
      'but that file is already open in Zettlr.'
    )
  }

  const moveToUnsavedIndex = buttons.indexOf(MOVE_TO_UNSAVED_FILES_BUTTON)

  return {
    type: 'question',
    title: 'File Removed from Disk',
    message: `"${input.fileName}" was deleted or moved outside of Zettlr`,
    detail: sections.join('\n\n'),
    buttons,
    defaultId: offerOpenRenamed ? buttons.indexOf(OPEN_RENAMED_FILE_BUTTON) : moveToUnsavedIndex,
    cancelId: moveToUnsavedIndex,
    noLink: true
  }
}

/**
 * Maps the index of the clicked dialog button to the action to perform. The
 * mapping goes by the text of the button, because the buttons present depend on
 * the situation. Any unexpected response (out of range, not an integer, or a
 * button text that is not known) moves the editor contents to Unsaved Files,
 * which never loses data.
 *
 * @param   {RemovedFileDialogOptions}  options   The options the dialog was shown with
 * @param   {number}                    response  The button index from the dialog
 *
 * @return  {RemovedFileDialogAction}             The action to perform
 */
export function removedFileDialogAction (options: Pick<RemovedFileDialogOptions, 'buttons'>, response: number): RemovedFileDialogAction {
  if (!Number.isInteger(response) || response < 0 || response >= options.buttons.length) {
    return 'move-to-unsaved'
  }

  return ACTION_OF_BUTTON.get(options.buttons[response]) ?? 'move-to-unsaved'
}
