/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        DocumentManager
 * CVM-Role:        Controller
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This controller represents all open files that are displayed
 *                  in the app. It will stay in sync with the configuration's
 *                  open files setting and emit events as necessary. The
 *                  renderer's equivalent is the editor and the tabs.
 *
 * END HEADER
 */

import EventEmitter from 'events'
import path from 'path'
import { constants as FSConstants, promises as fsPromises, watch as watchFileSystem, type FSWatcher } from 'fs'
import ProviderContract, { type IPCAPI } from '@providers/provider-contract'
import broadcastIpcMessage from '@common/util/broadcast-ipc-message'
import { type AppServiceContainer } from '../../app-service-container'
import { ipcMain, app, dialog, BrowserWindow, type MessageBoxOptions, type WebContents, shell } from 'electron'
import { DocumentTree, type DTLeaf } from './document-tree'
import PersistentDataContainer from '@common/modules/persistent-data-container'
import { type TabManager } from '@providers/documents/document-tree/tab-manager'
import { DP_EVENTS, DocumentType, type BranchNodeJSON, type LeafNodeJSON, type ConflictReadOnlySnapshot, type DocumentExternalStep, type UndoHistoryResult } from '@dts/common/documents'
import { v4 as uuid4 } from 'uuid'
import { type Update, rebaseUpdates } from '@codemirror/collab'
import { ChangeSet, Text } from '@codemirror/state'
import type { CodeFileDescriptor, MDFileDescriptor } from '@dts/common/fsal'
import { countAll } from '@common/util/counter'
import { markdownToAST } from '@common/modules/markdown-utils'
import isFile from '@common/util/is-file'
import formatSize from '@common/util/format-size'
import { trans } from '@common/i18n-main'
import type FSALWatchdog from '@providers/fsal/fsal-watchdog'
import { getDocumentTypeForExtension, hasImageExt, hasMdOrCodeExt, hasPDFExt } from 'source/common/util/file-extention-checks'
import isDir from 'source/common/util/is-dir'
import DocumentBackupManager from './backup-manager'
// Zettlr-LYH Windows dialog (R72)
import { batchCloseNeedsQuestion, decideBatchCloseAction, type BatchCloseMode } from './close-files-batch'
// Zettlr-LYH scratch notes (R40): Ctrl+N creates automatically written scratch notes
import {
  SCRATCH_AUTOSAVE_DELAY,
  isAutoNamedScratchFileName,
  isBlankScratchContent,
  isBlankScratchText,
  isScratchNotePath,
  resolveScratchDirectory,
  selectUnsavedScratchNotePaths,
  scratchHeadingFileName,
  scratchRenameFileName,
  suggestSaveFileName,
  uniqueScratchFileName
} from './scratch-notes'
import {
  createScratchNoteFile,
  deleteScratchNoteFile,
  ensureMarkdownExtension,
  isPathInsideDirectory,
  isSameFileOnDisk,
  isSamePath,
  moveScratchNoteToHistory,
  selectScratchNotesToReopen
} from './scratch-note-storage'
// Zettlr-LYH undo history (R135): the main process keeps a record of every
// change, so that undo works again after a document has been closed
import {
  UNDO_HISTORY_MAX_EVENTS,
  UNDO_HISTORY_RETENTION_DAYS,
  UndoHistoryStore,
  createNodeUndoHistoryFileSystem,
  resolveUndoHistoryDirectory,
  sha1Hash,
  undoHistoryAnchorPath,
  undoHistoryRecordPath,
  type ExternalStep,
  type UndoDescription
} from './undo-history-store'
import { createWorkerHasher, type WorkerHasher } from './undo-history-hash-worker'
// Zettlr-LYH undo history (R135): the scratch folder moves out of the documents folder
import { migrateLegacyScratchFolder, nodeScratchMigrationFileSystem, type MigrationResult } from './scratch-folder-migration'
// Zettlr-LYH reopen closed tab (R43): Ctrl+Shift+T reopens recently closed tabs
import { ClosedTabHistory, type ClosedTabJudgement, type ClosedTabRecord } from './closed-tab-history'
import { normalizeTabLimit, selectTabLimitCandidates, type TabLimitEntry, type TabLimitIdentity } from './tab-limit-policy'
// Zettlr-LYH backup restore choice (R50): ask which version to open instead of silently restoring
import { backupRestoreActionForResponse, buildBackupRestoreDialogOptions } from './backup-restore-choice'
// Zettlr-LYH disk conflicts (R138): what happens to a changed file depends on
// the three versions and on whether the document is in front of the user
import { routeRemoteChange, visibilityOf, type DocumentVisibility } from './remote-change-routing'
// Zettlr-LYH save as (R48): File > Save As… writes the editor contents to a new file
import { buildSaveAsDialogOptions, classifySaveAsTarget, resolveSaveAsTarget } from './save-as'
import { showNativeNotification } from '@common/util/show-notification'
// Zettlr-LYH external removal (R121): an open file that another program deletes,
// renames or moves away is not closed silently anymore
import {
  INTERNAL_OPERATION_IGNORE_MS,
  REMOVAL_PAIRING_WINDOW_AFTER_MS,
  REMOVAL_PAIRING_WINDOW_BEFORE_MS,
  buildRemovedFileDialogOptions,
  isWithinPairingWindow,
  normalizePathForComparison,
  pairRemovedFile,
  removedFileDialogAction,
  type RemovalCandidate,
  type RemovalFileIdentity,
  type RemovalPairingResult
} from './external-removal'
// Zettlr-LYH data loss prevention (R173, specification C21): what the editors
// report about input the document manager has not confirmed, and the failures
// that leave content or editing history only in memory. Both classes are only
// instantiated in the constructor; everything else goes through the two
// instance fields and is skipped while they are undefined (the main-process
// tests build the document manager without its constructor).
import { EditorSyncRegistry, type EditorSyncReport } from './editor-sync-registry'
import { DataSafetyIncidentReporter, type PushRejectionReason } from './data-safety-incidents'

type DocumentWindows = Record<string, DocumentTree>
type DocumentWindowsJSON = Record<string, BranchNodeJSON|LeafNodeJSON>

interface TabLimitWindowState {
  focused: Map<string, number>
  sequence: number
  generation: number
  scheduled: boolean
  requested: boolean
  running?: Promise<void>
}

interface TabLimitState {
  restoring: boolean
  closing: boolean
  windows: Map<string, TabLimitWindowState>
  busy: Map<string, number>
  busyDocuments: Map<Document, number>
  failed: Set<string>
  batches: Map<string, { windowId: string, sender: WebContents }>
  senders: Map<WebContents, () => void>
  configListener?: (option?: string) => void
}

// Zettlr-LYH scratch notes (R40): what closeFile has to do with a scratch note
// whose last tab is being closed. Undo history (R135): a scratch note that is
// not kept is moved into the undo history folder instead of being discarded;
// latestContent is what is written to disk, latestText the editor text that
// the undo history record is closed with.
type ScratchNoteCleanup = { action: 'delete', scratchPath: string }
  | { action: 'move-to-history', scratchPath: string, latestContent: string, latestText: string }
type ScratchNoteCloseDecision = { action: 'cancel' }
  | { action: 'plain' }
  | { action: 'saved', savedPath: string }
  | ScratchNoteCleanup

// Zettlr-LYH reopen closed tab (R43): where a closed tab is reopened, and from
// what. isOriginalPane is true if the tab returns to the pane it was closed in.
interface ReopenTarget { windowId: string, leafId: string, isOriginalPane: boolean }
// Zettlr-LYH disk conflicts (R138): one comparison of a file whose editor and
// disk versions have both changed. diskBaseline is the disk version the
// comparison shows (updated when the disk changes again), editorSnapshot the
// editor contents when the comparison opened; both are LF without BOM.
interface ConflictChoiceSession {
  document: Document
  sessionId: string
  target: { windowId: string, leafId: string }
  phase: 'merge'|'submitting'
  diskBaseline: string
  editorSnapshot: string
  diskModifiedAt: number|undefined
  diskSize: number|undefined
  preservedUpdates?: {
    startVersion: number
    minimumVersion: number
    history: Update[]
    requests: Map<string, Promise<boolean>>
    failures: Set<string>
    pending: Promise<boolean>
  }
}

/** Zettlr-LYH disk conflicts (R138): the outcome chosen in the comparison view */
export type ConflictMergeChoice = 'keep-left'|'keep-right'|'save-both'

/** Zettlr-LYH disk conflicts (R138): both versions shown by the comparison view */
export interface ConflictMergeContents {
  sessionId: string
  diskContents: string
  editorContents: string
  diskModifiedAt?: number
  diskSize?: number
  editorEditedAt?: number
  editorSize?: number
}

/** Zettlr-LYH disk conflicts (R138): the answer to commit-conflict-merge */
export type ConflictMergeCommitResult = { ok: true }
  | { ok: false, reason: 'stale'|'disk-changed'|'missing'|'backup-failed'|'copy-failed'|'write-failed', message?: string }

/** Zettlr-LYH disk conflicts (R138): a check of one file against the disk that is running */
interface RemoteChangeCheckInFlight {
  /** The watcher reported a change of the file while the check was running */
  changedDuringCheck: boolean
  /** Another trigger asked for a check of the file while the check was running */
  requestedDuringCheck: boolean
}

/** Zettlr-LYH disk conflicts (R138): a time that the comparison view can show */
function isKnownTimestamp (value: number|undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime())
}

/** Zettlr-LYH disk conflicts (R138): a byte size that the comparison view can show (zero is known) */
function isKnownByteSize (value: number|undefined): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Normalizes text the way the FSAL normalizes loaded files: LF linefeeds, no BOM */
function normalizeLoadedText (text: string): string {
  return text
    .replace(/^﻿/, '')
    .split(/\r\n|\n\r|\n|\r/g)
    .join('\n')
}
type ReopenPlan = { target: ReopenTarget, source: 'file' }
  | { target: ReopenTarget, source: 'backup', backupContent: string }

// Zettlr-LYH external removal (R121): what the document manager remembers in
// order to tell removals by other programs from its own file operations, and to
// recognize a removed file under a new name in the same folder.
interface ExternalRemovalBookkeeping {
  /** Paths that Zettlr itself is about to rename, move or delete */
  internalOperations: Array<{ path: string, registeredAt: number }>
  /** Files whose removal is being handled (waiting for the time window, or dialog shown) */
  pendingRemovals: Set<string>
  /** Files that recently appeared in a watched folder, with the time they were reported */
  recentAdditions: Array<{ path: string, time: number }>
}

// Zettlr-LYH external removal (R121): a file on disk as seen by the pairing
interface FileOnDisk { identity: RemovalFileIdentity|undefined, size: number }

// Zettlr-LYH external removal (R121): keep no more than this many recently
// appeared files (they are only needed for a few seconds anyway)
const MAX_RECENT_ADDITIONS = 200

// Keep no more than this many updates.
const MAX_VERSION_HISTORY = 100
// Delayed timeout means: Save after 5 seconds
const DELAYED_SAVE_TIMEOUT = 5000
// Even "immediate" should not save immediately to prevent race conditions on slower systems
const IMMEDIATE_SAVE_TIMEOUT = 500

/**
 * Formats a timestamp (ms since epoch) as a local "YYYY-MM-DD HH:MM:SS" string
 * for user-facing dialogs.
 */
function formatTimestamp (timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * Formats a byte count for user-facing dialogs: a rounded KB/MB figure with
 * the exact byte count in parentheses, so that two versions of similar size
 * remain distinguishable.
 */
function describeSize (bytes: number): string {
  if (bytes < 1024) {
    return bytes === 1 ? '1 byte' : `${bytes} bytes`
  }

  return `${formatSize(bytes, true)} (${bytes.toLocaleString('en-US')} bytes)`
}

export interface DocumentsUpdateContext {
  windowId?: string
  leafId?: string
  filePath?: string
  oldPath?: string
  newPath?: string
  direction?: 'horizontal'|'vertical'
  insertion?: 'after'|'before'
  newLeaf?: string
  originLeaf?: string
  key?: string
  status?: 'modification'|'pinned'
  sessionId?: string
  conflictState?: ConflictReadOnlySnapshot
}

/**
 * Holds all information associated with a document that is currently loaded
 */
interface Document {
  /**
   * The absolute path to the file
   */
  filePath: string
  /**
   * The descriptor for the file
   */
  descriptor: MDFileDescriptor|CodeFileDescriptor
  /**
   * The file type (e.g. Markdown, JSON, YAML)
   */
  type: DocumentType
  /**
   * The current version of the document in memory
   */
  currentVersion: number
  /**
   * The last version for which full updates are available. Editors with a
   * version less than minimumVersion will need to reload the document.
   */
  minimumVersion: number
  /**
   * The last version number that has been saved to disk. If lastSavedVersion
   * === currentVersion, the file is not modified. NOTE: DO NOT ASSUME THIS
   * VARIABLE TO ACCURATELY REFLECT THE PRECISE VERSION THAT HAS BEEN SAVED;
   * THIS VARIABLE MAY DIFFER, AND EVEN GET NEGATIVE! ONLY USE THIS TO COMPARE
   * AGAINST CURRENTVERSION!
   */
  lastSavedVersion: number
  /**
   * This is a duplicate of whatever has been last written to disk. It is used
   * to double check whether a change event actually changed the content of a
   * file or if the file remains the same on disk as in buffer.
   */
  lastSavedContent: string
  /**
   * Holds all updates between minimumVersion and currentVersion in a granular
   * form.
   */
  updates: Update[]
  /**
   * The actual document text in a CodeMirror format.
   */
  document: Text
  /**
   * Necessary for the word count statistics: The amount of words when the file
   * was last saved to disk.
   */
  lastSavedWordCount: number
  /**
   * Necessary for the word count statistics: The amount of characters when the
   * file was last saved to disk.
   */
  lastSavedCharCount: number
  /**
   * Holds an optional save timeout. This is for when users have indicated they
   * want autosaving.
   */
  saveTimeout: undefined|NodeJS.Timeout
  /**
   * Timestamp (ms since epoch) of the user's last edit to this document in the
   * editor. For a document restored from the backup cache this starts as the
   * time the backup was last written; undefined if the document has not been
   * edited yet.
   */
  lastEditedAt: number|undefined
  /** Snapshot of this editor version's disk time, independent of FSAL updates. */
  loadedOrSavedModifiedAt?: number
  /**
   * Zettlr-LYH external removal (R121): the volume and file index of the file
   * when it was last loaded or saved; they survive a rename and identify the
   * file under its new name. Undefined if the file system does not provide them.
   */
  fileIdentity?: RemovalFileIdentity
  /**
   * Zettlr-LYH undo history (R135): the change that turned the previous text
   * into this document's text when it was reloaded after an external
   * modification. getDocument hands it to the editor as long as the document
   * is still at loadedVersion.
   */
  undoExternalStep?: { step: ExternalStep, source: 'disk-reload'|'comparison', loadedVersion: number }
}

/**
 * Zettlr-LYH undo history (R135): an update as the editor pushes it, with the
 * optional description of the step that the undo history record needs.
 */
type PushedUpdate = Update & { undoDescription?: unknown }

/**
 * Zettlr-LYH undo history (R135): what getDocument returns to an editor.
 */
interface DocumentLoadResult {
  content: string
  type: DocumentType
  startVersion: number
  externalStep?: DocumentExternalStep
}

/**
 * Zettlr-LYH data loss prevention (R173, specification C21 section 3.3): the
 * answer to a push-updates message.
 */
export interface PushAnswer {
  accepted: boolean
  /** Why the updates were rejected; missing if they were accepted, or if preserving them during a comparison failed */
  reason?: PushRejectionReason
  /** The version of the document manager; only with the reason version-mismatch */
  currentVersion?: number
}

export type DocumentAuthorityIPCAPI = IPCAPI<{
  'get-document': { filePath: string }
  // Zettlr-LYH data loss prevention (R173, specification C21 section 3.2): an
  // editor reports its unconfirmed input with every pull; a renderer that has
  // not been reloaded yet sends no such field
  'pull-updates': { filePath: string, version: number, editor?: EditorSyncReport }
  'push-updates': { filePath: string, version: number, updates: PushedUpdate[] }
}>

// Zettlr-LYH undo history (R135): the first undo history cleanup runs one
// minute after the start, then once a day
const UNDO_HISTORY_FIRST_PRUNE_DELAY = 60000
const UNDO_HISTORY_PRUNE_INTERVAL = 86400000
// Zettlr-LYH undo history (R135): a message that arrives before the main window
// is open (the scratch folder migration at boot) waits for it, checking once a
// second for at most two minutes
const UNDO_HISTORY_MESSAGE_RETRY_DELAY = 1000
const UNDO_HISTORY_MESSAGE_RETRY_COUNT = 120

/**
 * Zettlr-LYH undo history (R135): checks the description that the editor
 * attached to an update. Returns undefined for anything malformed, so that the
 * undo history store uses its default description.
 *
 * @param   {unknown}                    value  The undoDescription of the update
 *
 * @return  {UndoDescription|undefined}         The description, or undefined
 */
function readUndoDescription (value: unknown): UndoDescription|undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const candidate = value as Record<string, unknown>
  if (candidate.kind !== 'edit' && candidate.kind !== 'undo' && candidate.kind !== 'redo') {
    return undefined
  }
  if (typeof candidate.joined !== 'boolean') {
    return undefined
  }
  const selection = candidate.selectionBefore as Record<string, unknown>|null|undefined
  if (typeof selection !== 'object' || selection === null || !Array.isArray(selection.ranges) || typeof selection.main !== 'number') {
    return undefined
  }
  const ranges: Array<{ anchor: number, head: number }> = []
  for (const range of selection.ranges as unknown[]) {
    if (typeof range !== 'object' || range === null) {
      return undefined
    }
    const { anchor, head } = range as Record<string, unknown>
    if (typeof anchor !== 'number' || typeof head !== 'number') {
      return undefined
    }
    ranges.push({ anchor, head })
  }
  const description: UndoDescription = {
    kind: candidate.kind,
    joined: candidate.joined,
    selectionBefore: { ranges, main: selection.main }
  }
  if (typeof candidate.userEvent === 'string') {
    description.userEvent = candidate.userEvent
  }
  return description
}

/**
 * Zettlr-LYH undo history (R135): where a path ended up after the scratch
 * folder migration. Each moved entry may be a file or a whole folder (such as
 * _Images), so a path inside a moved folder moves along with it.
 *
 * @param   {string}                              filePath  The old path
 * @param   {Array<{ from: string, to: string }>} moved     The moved entries
 *
 * @return  {string|undefined}                              The new path, or undefined if it did not move
 */
function mapMigratedPath (filePath: string, moved: Array<{ from: string, to: string }>): string|undefined {
  for (const entry of moved) {
    if (isSamePath(filePath, entry.from)) {
      return entry.to
    }
    if (isPathInsideDirectory(filePath, entry.from)) {
      return path.join(entry.to, path.relative(entry.from, filePath))
    }
  }
  return undefined
}

// Most document manager commands require a leaf location, described by the
// window and leaf IDs.
type LeafLoc = { windowId: string, leafId: string }

/**
 * Zettlr-LYH tab drag-out (R115): a tab that was released at the screen point
 * (screenX, screenY). offsetX and offsetY tell where the tab was grabbed,
 * relative to its window, and scrollTop is the reading position of its editor.
 */
export interface MoveFileToNewWindowRequest {
  originWindow: string
  originLeaf: string
  path: string
  screenX: number
  screenY: number
  offsetX?: number
  offsetY?: number
  scrollTop?: number
}
export type DocumentManagerIPCAPI = IPCAPI<{
  'set-pinned': LeafLoc & { path: string, pinned: boolean }
  'retrieve-tab-config': { windowId: string }
  // Zettlr-LYH scratch notes (R40): flushScratchOnly writes a scratch note back
  // to its scratch file instead of asking for a location
  'save-file': { path: string, flushScratchOnly?: boolean }
  // Zettlr-LYH save as (R48): writes the file under a new name chosen by the
  // user and lets its tabs follow; resolves to true if the file was saved
  'save-file-as': { path: string }
  // Zettlr-LYH open-with disk check (R51): checkAgainstDisk makes an explicit
  // open of an already loaded file (file manager click, external open) compare
  // the file with the disk, so that a change the watcher missed is caught
  'open-file': LeafLoc & { path: string, newTab: boolean, checkAgainstDisk?: boolean, preferInternalPDF?: boolean, insertAfterActiveTab?: boolean }
  'close-file': LeafLoc & { path: string }
  'close-file-everywhere': { path: string }
  // Zettlr-LYH Windows dialog (R72): closes every tab of each file in the
  // window, asking about unsaved changes with Keep All / Discard All Changes;
  // resolves to the paths that are still open in the window
  'close-files-batch': { windowId: string, paths: string[] }
  'get-open-workspace-files': { path: string }
  'sort-open-files': LeafLoc & { newOrder: string[] }
  'get-file-modification-status': unknown
  'move-file': {
    originWindow: string,
    targetWindow: string,
    originLeaf: string,
    targetLeaf: string,
    path: string
  }
  // Zettlr-LYH tab drag-out (R115): a tab released outside all main windows
  // opens in a new window; resolves to the new window's key, or undefined
  'move-file-to-new-window': MoveFileToNewWindowRequest
  'split-leaf': {
    originWindow: string,
    originLeaf: string,
    direction: 'horizontal'|'vertical',
    insertion: 'before'|'after',
    path?: string,
    fromWindow?: string,
    fromLeaf?: string,
    // Zettlr-LYH split view (R44): open a second view of path in the new pane
    // instead of moving the file there
    copy?: boolean
  }
  'close-leaf': LeafLoc
  'focus-leaf': LeafLoc
  'tab-limit-batch': { windowId: string, action: 'begin'|'end', token?: string, succeeded?: boolean }
  // Zettlr-LYH conflict merge (R47) and disk conflicts (R138): the comparison
  // view fetches both versions of a conflicted file and commits the outcome
  // of the identified comparison.
  'get-conflict-merge-contents': { path: string, sessionId: string }
  'get-conflict-read-only-state': undefined
  'focus-conflict-merge': { path: string, sessionId: string }
  'commit-conflict-merge': { path: string, sessionId: string, choice: ConflictMergeChoice, leftContents: string, rightContents: string }
  'set-branch-sizes': { windowId: string, branchId: string, sizes: number[] },
  'navigate-forward': LeafLoc
  'navigate-back': LeafLoc
  // Zettlr-LYH undo history (R135): the undo history of an open document at
  // the editor's version; resolves to an UndoHistoryResult or null
  'get-undo-history': { filePath: string, version: number }
}>

export default class DocumentManager extends ProviderContract {
  /**
   * This array holds all open windows, here represented as document trees
   *
   * @var {DocumentTree[]}
   */
  private readonly _windows: DocumentWindows
  /**
   * The event emitter helps broadcast events across the main process
   *
   * @var {EventEmitter}
   */
  private readonly _emitter: EventEmitter
  /**
   * The config file container persists the document tree data to disk so that
   * open editor panes & windows can be restored
   *
   * @var {PersistentDataContainer<DocumentWindowsJSON>}
   */
  private readonly _config: PersistentDataContainer<DocumentWindowsJSON>
  /**
   * The process that watches currently opened files for remote changes
   *
   * @var {chokidar.FSWatcher}
   */
  private readonly _watcher: FSALWatchdog

  /**
   * Holds a list of strings for files that have recently been saved by the
   * user. For those files, we need to ignore remote changes since they
   * originate here.
   *
   * @var {string[]}
   */
  private readonly _ignoreChanges: string[]

  /**
   * This array allows us to prevent showing multiple "Reload changes?" dialogs
   * for a single file open in the app.
   *
   * @var {string[]}
   */
  private readonly _remoteChangeDialogShownFor: string[]

  /**
   * Zettlr-LYH conflict merge (R47): files for which the user chose "Compare
   * and Merge…" and whose merge view has not reported back yet. Each of these
   * paths also stays in _remoteChangeDialogShownFor until the merge ends, which
   * keeps autosave suspended and prevents further conflict dialogs.
   *
   * @var {Set<string>}
   */
  private readonly _conflictMergePendingFor: Set<string>
  private readonly _conflictChoiceSessions: Map<string, ConflictChoiceSession>
  private _conflictReadOnlyRevision: number = 0
  private _conflictSiblingPaths: Set<string>|undefined

  /**
   * Zettlr-LYH disk conflicts (R138): full paths of open files that changed on
   * disk while they were not in front of the user (or could not be decided
   * then). They are checked against the disk when the user turns to them.
   * Created on first use (see remoteChangeCheckPending), because the
   * main-process tests build the document manager without its constructor.
   *
   * @var {Set<string>|undefined}
   */
  private _remoteChangeCheckPendingFor: Set<string>|undefined

  /**
   * Zettlr-LYH disk conflicts (R138): the checks against the disk that are
   * running, by full path, so that one file is never checked twice at once.
   * Created on first use (see remoteChangeChecksInFlight).
   *
   * @var {Map<string, RemoteChangeCheckInFlight>|undefined}
   */
  private _remoteChangeChecksInFlight: Map<string, RemoteChangeCheckInFlight>|undefined

  /**
   * Zettlr-LYH disk conflicts (R138): the pane that was focused last in each
   * window, so that the focused pane of a window that gains the focus is known
   * even if the last focused pane of the app is in another window. Created on
   * first use (see focusedLeafByWindow).
   *
   * @var {Map<string, string>|undefined}
   */
  private _focusedLeafByWindow: Map<string, string>|undefined

  /**
   * This holds all currently opened documents somewhere across the app.
   *
   * @var {Document[]}
   */
  private readonly documents: Document[]

  /**
   * Persists unsaved editing states across restarts (Notepad++-style backups)
   *
   * @var {DocumentBackupManager}
   */
  private readonly _backups: DocumentBackupManager

  /**
   * Holds in-flight getDocument calls so that concurrent requests for the
   * same file (e.g. the same file open in two panes during boot) share one
   * load instead of racing each other.
   *
   * @var {Map<string, Promise<DocumentLoadResult>>}
   */
  private readonly _pendingDocumentLoads: Map<string, Promise<DocumentLoadResult>>

  private _shuttingDown: boolean
  private _tabLimit: TabLimitState|undefined

  private readonly _lastEditor: {
    windowId: string|undefined
    leafId: string|undefined
  }

  /**
   * Zettlr-LYH scratch notes (R40): serializes the save dialogs and close
   * prompts of scratch notes, so that closing several scratch notes at once
   * asks about one after another instead of stacking dialogs.
   *
   * @var {Promise<void>}
   */
  private _scratchDialogQueue: Promise<void>

  /**
   * Zettlr-LYH reopen closed tab (R43): the recently closed tabs, kept in
   * memory only, which Ctrl+Shift+T reopens.
   *
   * @var {ClosedTabHistory}
   */
  private readonly _closedTabs: ClosedTabHistory

  /**
   * Zettlr-LYH reopen closed tab (R43): serializes reopening, so that pressing
   * Ctrl+Shift+T repeatedly reopens one tab after another in order.
   *
   * @var {Promise<void>}
   */
  private _reopenClosedTabQueue: Promise<void>

  /**
   * Zettlr-LYH reopen closed tab (R43): scratch notes restored from the backup
   * of a closed file that no longer exists, mapped to that file's path. Their
   * save dialog proposes this path. Kept in memory only.
   *
   * @var {Map<string, string>}
   */
  private readonly _scratchNoteOriginalPaths: Map<string, string>

  /**
   * Zettlr-LYH blank scratch notes (R165): whether the scratch notes open as
   * tabs but not loaded by any editor are blank on disk, and the reads of
   * that still running. Created on first use, because the main-process tests
   * build the document manager without running its constructor.
   *
   * @var {Map<string, boolean>|undefined}
   */
  private _scratchNoteBlankOnDisk?: Map<string, boolean>
  private _scratchNoteBlankReads?: Set<string>

  /**
   * Zettlr-LYH external removal (R121): the internal operations, pending
   * removals and recently appeared files. Created on first use (see
   * removalBookkeeping), because the main-process tests build the document
   * manager without running its constructor.
   *
   * @var {ExternalRemovalBookkeeping|undefined}
   */
  private _externalRemoval: ExternalRemovalBookkeeping|undefined

  /**
   * Zettlr-LYH external removal (R121): one non-recursive watcher per parent
   * folder of an open file, keyed by the comparison form of the folder path, so
   * that a file renamed in the same folder is seen even outside every
   * workspace. Undefined until boot, which keeps watchers out of the tests that
   * do not ask for them.
   *
   * @var {Map<string, { folder: string, watcher: FSWatcher }>|undefined}
   */
  private _parentFolderWatchers: Map<string, { folder: string, watcher: FSWatcher }>|undefined

  /**
   * Zettlr-LYH undo history (R135): the store that writes the undo history
   * records. Undefined in the main-process tests that build the document
   * manager without running its constructor; every use goes through
   * undoHistory() and is skipped then.
   *
   * @var {UndoHistoryStore|undefined}
   */
  private _undoHistory: UndoHistoryStore|undefined

  /**
   * Zettlr-LYH undo history (R135): the worker thread that calculates the check
   * values of long texts.
   *
   * @var {WorkerHasher|undefined}
   */
  private _undoHistoryHasher: WorkerHasher|undefined

  /**
   * Zettlr-LYH undo history (R135): the text of a document that notifyRemoteChange
   * has just dropped, keyed by its path, until _loadDocument records the
   * external step from it to the reloaded text. Created on first use.
   *
   * @var {Map<string, { oldText: string, source: 'disk-reload'|'comparison' }>|undefined}
   */
  private _pendingExternalChanges: Map<string, { oldText: string, source: 'disk-reload'|'comparison' }>|undefined

  /**
   * Zettlr-LYH undo history (R135): the timers of the 30-day cleanup.
   */
  private _undoHistoryPruneTimeout: NodeJS.Timeout|undefined
  private _undoHistoryPruneInterval: NodeJS.Timeout|undefined
  private _undoHistoryPruneRunning: boolean|undefined

  /**
   * Zettlr-LYH undo history (R135): true once before-quit has waited for the
   * undo history to be written.
   */
  private _undoHistoryQuitFlushDone: boolean|undefined

  /**
   * Zettlr-LYH data loss prevention (R173, specification C21 section 4): what
   * each editor last reported about its unconfirmed input. Undefined in the
   * tests that build the document manager without its constructor; every use
   * treats that as "no editor holds unconfirmed input".
   *
   * @var {EditorSyncRegistry|undefined}
   */
  private _editorSyncRegistry: EditorSyncRegistry|undefined

  /**
   * Zettlr-LYH data loss prevention (R173, specification C21 section 7): logs
   * and broadcasts the data safety incidents. Undefined in the tests that build
   * the document manager without its constructor; nothing is reported then.
   *
   * @var {DataSafetyIncidentReporter|undefined}
   */
  private _dataSafetyIncidents: DataSafetyIncidentReporter|undefined

  /**
   * Zettlr-LYH data loss prevention (R173): true once before-quit has waited
   * for the unconfirmed input of the editors.
   */
  private _quitDeliveryWaitDone: boolean|undefined

  /**
   * Zettlr-LYH data loss prevention (R173): the timers that check a file
   * against the disk again after a change on disk met unconfirmed input of an
   * editor, keyed by the file path. Created on first use.
   */
  private _deliveryRecheckTimers: Map<string, NodeJS.Timeout>|undefined

  /**
   * Zettlr-LYH data loss prevention (R173): the write errors for which a
   * save-failed incident has been reported, so that the automatic save does
   * not report the same failure a second time. Created on first use.
   */
  private _reportedSaveFailures: WeakSet<object>|undefined

  constructor (private readonly _app: AppServiceContainer) {
    super()

    const containerPath = path.join(app.getPath('userData'), 'documents.yaml')

    this._windows = {}
    this._emitter = new EventEmitter()
    this._config = new PersistentDataContainer(containerPath, 'yaml')
    this._ignoreChanges = []
    this._remoteChangeDialogShownFor = []
    this._conflictMergePendingFor = new Set() // Zettlr-LYH conflict merge (R47)
    this._conflictChoiceSessions = new Map()
    // Zettlr-LYH disk conflicts (R138)
    this._remoteChangeCheckPendingFor = new Set()
    this._remoteChangeChecksInFlight = new Map()
    this._focusedLeafByWindow = new Map()
    this.documents = []
    this._backups = new DocumentBackupManager(
      path.join(app.getPath('userData'), 'unsaved-changes'),
      this._app.log
    )
    // Zettlr-LYH data loss prevention (R173)
    this._editorSyncRegistry = new EditorSyncRegistry()
    this._dataSafetyIncidents = new DataSafetyIncidentReporter({
      broadcast: (channel, incident) => { broadcastIpcMessage(channel, incident) },
      log: this._app.log
    })
    // Zettlr-LYH undo history (R135)
    const undoHistoryHasher = createWorkerHasher()
    this._undoHistoryHasher = undoHistoryHasher
    this._undoHistory = new UndoHistoryStore({
      fs: createNodeUndoHistoryFileSystem(),
      getRoot: () => this.undoHistoryRoot() ?? '',
      getScratchDirectory: () => this.getScratchDirectory(),
      platform: process.platform,
      now: Date.now,
      setTimer: (callback, delay) => setTimeout(callback, delay),
      clearTimer: (handle) => { clearTimeout(handle as NodeJS.Timeout) },
      hashSync: sha1Hash,
      hashInWorker: async (text) => await undoHistoryHasher.hash(text),
      warn: (recordPath, size) => {
        this._app.log.warning(`[Undo History] The undo history record ${recordPath} has grown to ${size} bytes.`)
        const fileName = path.basename(recordPath).replace(/\.history\.jsonl$/, '')
        this.showUndoHistoryMessage(trans('The undo history of "%s" has grown beyond 200 MB. Zettlr keeps recording it.', fileName))
      },
      log: (message) => { this.handleUndoHistoryStoreMessage(message) }
    })
    this._pendingDocumentLoads = new Map()
    this._shuttingDown = false
    this.tabLimitState().restoring = true
    this._lastEditor = {
      windowId: undefined,
      leafId: undefined
    }
    this._scratchDialogQueue = Promise.resolve() // Zettlr-LYH scratch notes (R40)
    // Zettlr-LYH reopen closed tab (R43)
    this._closedTabs = new ClosedTabHistory()
    this._reopenClosedTabQueue = Promise.resolve()
    this._scratchNoteOriginalPaths = new Map()

    // Start up the chokidar process
    this._watcher = this._app.fsal.getWatchdog()

    this._watcher.on('change', (event, filePath) => {
      this.handleDocumentWatcherEvent(event, filePath)
    })

    // Zettlr-LYH disk conflicts (R138): a main window that gains the focus
    // checks the documents it shows against the disk
    app.on('browser-window-focus', (_event, focusedWindow) => {
      const windowId = this._app.windows.getMainWindowKey(focusedWindow)
      if (windowId !== undefined) {
        this.checkRemoteChangesOnWindowFocus(windowId)
      }
    })

    /**
     * Hook the event listener that directly communicates with the editors
     */
    ipcMain.handle('documents-authority', async (event, message: DocumentAuthorityIPCAPI) => {
      return await this.answerDocumentAuthority(message)
    })

    // Finally, listen to events from the renderer
    ipcMain.handle('documents-provider', async (event, message: DocumentManagerIPCAPI) => {
      const { command, payload } = message
      switch (command) {
        case 'tab-limit-batch': {
          const window = BrowserWindow.fromWebContents(event.sender)
          if (window === null || this._app.windows.getMainWindowKey(window) !== payload.windowId) { return false }
          return this.updateTabLimitBatch(payload, event.sender)
        }
        // A given tab should be set as pinned
        case 'set-pinned': {
          const { windowId, leafId, path, pinned } = payload
          this.setPinnedStatus(windowId, leafId, path, pinned)
          return
        }
        // Some main window has requested its tab/split view state
        case 'retrieve-tab-config': {
          return this._windows[payload.windowId].toJSON()
        }
        case 'save-file': {
          // Zettlr-LYH scratch notes (R40): saving a scratch note asks for a
          // location, unless it should merely be written back
          if (this.isScratchNote(payload.path)) {
            return payload.flushScratchOnly === true
              ? await this.flushScratchNote(payload.path)
              : (await this.saveScratchNoteAs(payload.path)) !== undefined
          }
          return await this.saveFile(payload.path)
        }
        // Zettlr-LYH save as (R48)
        case 'save-file-as': {
          return await this.saveFileAs(payload.path)
        }
        case 'open-file': {
          const { windowId, leafId, path, newTab } = payload
          const ret = await this.openFile(windowId, leafId, path, newTab, false, payload.preferInternalPDF, payload.insertAfterActiveTab)
          // Zettlr-LYH open-with disk check (R51): not awaited, so that a
          // conflict dialog does not hold up the click that opened the file
          if (payload.checkAgainstDisk === true && hasMdOrCodeExt(path)) {
            this.checkLoadedFileAgainstDisk(path).catch(err => {
              const message = err instanceof Error ? err.message : String(err)
              this._app.log.error(`[Document Provider] Could not check ${path} against the disk: ${message}`, err)
            })
          }
          return ret
        }
        case 'close-file': {
          const { windowId, leafId, path } = payload
          return await this.closeFile(windowId, leafId, path)
        }
        case 'close-file-everywhere': {
          const { path } = payload
          return this.closeFileEverywhere(path)
        }
        // Zettlr-LYH Windows dialog (R72)
        case 'close-files-batch': {
          const { windowId, paths } = payload
          return await this.closeFilesBatch(windowId, paths)
        }
        case 'get-open-workspace-files':
          const { path } = payload
          return this.getOpenFilesForWorkspace(path)
        case 'sort-open-files': {
          const { windowId, leafId, newOrder } = payload
          this.sortOpenFiles(windowId, leafId, newOrder)
          return
        }
        case 'get-file-modification-status': {
          // Zettlr-LYH scratch notes (R40): includes every open scratch note
          return this.getModifiedFilePaths()
        }
        case 'move-file': {
          const {
            originWindow, originLeaf, targetWindow, targetLeaf, path
          } = payload
          return await this.moveFile(
            originWindow, targetWindow, originLeaf, targetLeaf, path
          )
        }
        // Zettlr-LYH tab drag-out (R115)
        case 'move-file-to-new-window': {
          return this.moveFileToNewWindow(payload)
        }
        case 'split-leaf': {
          const {
            originWindow, originLeaf,
            direction, insertion,
            path,
            fromWindow, fromLeaf,
            copy
          } = payload

          return await this.splitLeaf(
            originWindow, originLeaf,
            direction, insertion,
            path,
            fromWindow, fromLeaf,
            copy
          )
        }
        case 'close-leaf': {
          return this.closeLeaf(payload.windowId, payload.leafId)
        }
        case 'focus-leaf': {
          return this._updateFocusLeaf(payload.windowId, payload.leafId)
        }
        // Zettlr-LYH conflict merge (R47): the merge view fetches both versions
        // and reports the outcome
        case 'get-conflict-read-only-state': {
          return this.conflictReadOnlySnapshot()
        }
        case 'focus-conflict-merge': {
          const session = this._conflictChoiceSessions.get(payload.path)
          if (session?.sessionId !== payload.sessionId) { return false }
          const target = this.activateConflictTarget(payload.path, session.target)
          if (target === undefined) { return false }
          this.mainWindowFor(target.windowId)?.focus()
          return true
        }
        case 'get-conflict-merge-contents': {
          const window = BrowserWindow.fromWebContents(event.sender)
          const windowId = window === null ? undefined : this._app.windows.getMainWindowKey(window)
          if (windowId === undefined) { return undefined }
          return this.getConflictMergeContents(payload.path, payload.sessionId, windowId)
        }
        case 'commit-conflict-merge': {
          const window = BrowserWindow.fromWebContents(event.sender)
          const windowId = window === null ? undefined : this._app.windows.getMainWindowKey(window)
          if (windowId === undefined) {
            const result: ConflictMergeCommitResult = { ok: false, reason: 'stale' }
            return result
          }
          return await this.commitConflictMerge(
            payload.path, payload.sessionId, payload.choice,
            payload.leftContents, payload.rightContents, windowId
          )
        }
        case 'set-branch-sizes': {
          // NOTE that in this particular instance we do not emit an event. The
          // reason is that we need to prevent frequent reloads during resizing.
          // For as long as the window is open, the window will have the correct
          // sizes, and will only update those sizes here in the main process.
          // As soon as the window is closed, however, it will automatically
          // grab the correct sizes again.
          const branch = this._windows[payload.windowId].findBranch(payload.branchId)
          if (branch !== undefined) {
            branch.sizes = payload.sizes
            this.syncToConfig()
          }
          return
        }
        case 'navigate-forward': {
          return await this.navigateForward(payload.windowId, payload.leafId)
        }
        case 'navigate-back': {
          return await this.navigateBack(payload.windowId, payload.leafId)
        }
        // Zettlr-LYH undo history (R135, spec C20 section 7)
        case 'get-undo-history': {
          return await this.getUndoHistory(payload.filePath, payload.version)
        }
      }
    })

    // Listen to the before-quit event. Since every unsaved editing state is
    // continuously mirrored into the backup cache, quitting must NOT prompt
    // the user to save: the app quits with the unsaved changes preserved in
    // the cache, and the next start restores them into the reopened tabs
    // (Notepad++-style session behavior). We only have to make sure that any
    // pending (debounced) backup write reaches the disk before quitting.
    app.on('before-quit', (event) => {
      this.handleBeforeQuit(event)
    })
  } // END constructor

  /**
   * Handles before-quit: the pending backup writes and (R135) the undo history
   * records have to reach the disk before the app quits. The undo history
   * store does not tell whether it has anything pending, so the first quit
   * always waits for one flushAll.
   *
   * @param   {{ preventDefault: () => void }}  event  The before-quit event
   */
  private handleBeforeQuit (event: { preventDefault: () => void }): void {
    // Zettlr-LYH data loss prevention (R173, specification C21 section 4 item
    // 4): input that an editor holds and the document manager has not received
    // would be gone after the quit. Give it DELIVERY_WAIT_MS to arrive, then
    // quit again; the second pass runs the code below.
    const filesWithUnconfirmedInput = this._quitDeliveryWaitDone === true
      ? []
      : (this._editorSyncRegistry?.filesWithUnconfirmedInput() ?? [])
    if (filesWithUnconfirmedInput.length > 0) {
      event.preventDefault()
      Promise.all(filesWithUnconfirmedInput.map(async filePath => await this.waitForEditorDelivery(filePath)))
        .catch(err => {
          this._app.log.error('[Document Manager] Could not wait for the input of the editors on quit!', err)
        })
        .finally(() => {
          this._quitDeliveryWaitDone = true
          app.quit()
        })
        .catch(() => { /* The wait has caught its own errors */ })
      return
    }

    this._shuttingDown = true

    const store = this.undoHistory()
    const flushUndoHistory = store !== undefined && this._undoHistoryQuitFlushDone !== true
    if (!this._backups.hasPendingPersists() && !flushUndoHistory) {
      return
    }

    event.preventDefault()
    const backupFlush = this._backups.flushAll()
      .catch(err => {
        this._app.log.error('[DocumentManager] Could not flush unsaved-changes backups on quit!', err)
      })
    const undoHistoryFlush = flushUndoHistory
      ? store.flushAll().catch(err => {
        this._app.log.error('[Undo History] Could not write the undo history on quit!', err)
      })
      : Promise.resolve()
    Promise.all([ backupFlush, undoHistoryFlush ])
      .finally(() => {
        if (flushUndoHistory) {
          this._undoHistoryQuitFlushDone = true
        }
        app.quit()
      })
      .catch(() => { /* Both flushes catch their own errors */ })
  }

  /**
   * Zettlr-LYH undo history (R135): the undo history store, or undefined in
   * the tests that build the document manager without its constructor.
   *
   * @return  {UndoHistoryStore|undefined}  The store
   */
  private undoHistory (): UndoHistoryStore|undefined {
    return this._undoHistory
  }

  /**
   * Zettlr-LYH undo history (R135): the undo history root folder, read from the
   * configuration on every call. Undefined if there is no undo history store.
   *
   * @return  {string|undefined}  The absolute path of the folder
   */
  private undoHistoryRoot (): string|undefined {
    if (this.undoHistory() === undefined) {
      return undefined
    }
    const configured: unknown = this._app.config.get().undoHistoryDirectory
    return resolveUndoHistoryDirectory(typeof configured === 'string' ? configured : '', app.getPath('documents'))
  }

  /**
   * Zettlr-LYH undo history (R135): shows a warning message. windows.prompt
   * drops a message while there is no main window, and the scratch folder
   * migration runs before the first main window opens, so the message waits
   * for it (checked once a second, for at most two minutes, then shown anyway).
   *
   * @param   {string}  message  The message
   */
  private showUndoHistoryMessage (message: string, attempt = 0): void {
    const windows = this._app.windows
    if (windows.getFirstMainWindow?.() === undefined && attempt < UNDO_HISTORY_MESSAGE_RETRY_COUNT) {
      setTimeout(() => { this.showUndoHistoryMessage(message, attempt + 1) }, UNDO_HISTORY_MESSAGE_RETRY_DELAY)
      return
    }
    windows.prompt({ type: 'warning', message })
  }

  /**
   * Zettlr-LYH undo history (R135): records the updates of one editor push
   * before they are applied to the document. Errors are only logged.
   */
  private recordUndoUpdate (filePath: string, documentBefore: Text, changes: ChangeSet, update: PushedUpdate): void {
    const store = this.undoHistory()
    if (store === undefined) {
      return
    }
    try {
      store.recordUpdates(filePath, documentBefore, [{
        changes,
        description: readUndoDescription(update.undoDescription),
        // The push carries no window or pane ID, so the collab client ID
        // identifies the editor (spec C20 asks for <windowId>-<leafId>)
        client: String(update.clientID)
      }])
    } catch (err: unknown) {
      this._app.log.error(`[Undo History] Could not record the changes of ${filePath}`, err)
      // Zettlr-LYH data loss prevention (R173, specification C21 section 4
      // item 9): the change itself is applied, but it can no longer be undone
      // after the document has been closed. Tell the user.
      this._dataSafetyIncidents?.reportUndoHistoryFailed(filePath, err)
    }
  }

  /**
   * Zettlr-LYH data loss prevention (R173, specification C21 section 4 item
   * 9): receives what the undo history store writes to its log function. The
   * message goes to the log as before; if it means that a part of the history
   * could not be written, it also becomes a data safety incident.
   *
   * @param  {string}  message  The message of the store
   */
  private handleUndoHistoryStoreMessage (message: string): void {
    this._app.log.warning(`[Undo History] ${message}`)
    this._dataSafetyIncidents?.reportUndoHistoryStoreMessage(message)
  }

  /**
   * Zettlr-LYH data loss prevention (R173, specification C21 section 4 item
   * 2): whether an editor holds input for the file that the document manager
   * has not confirmed, according to the reports of the editors.
   *
   * @param   {string}   filePath  The file
   *
   * @return  {boolean}            False also if there is no registry
   */
  private editorHasUnconfirmedInput (filePath: string): boolean {
    return this._editorSyncRegistry?.hasUnconfirmedInput(filePath) === true
  }

  /**
   * Zettlr-LYH data loss prevention (R173, specification C21 section 4 item
   * 4): if an editor holds unconfirmed input for the file, waits until it has
   * arrived, but at most DELIVERY_WAIT_MS. If it has not arrived by then, a
   * delivery-timeout incident is reported and the caller continues anyway.
   *
   * @param   {string}            filePath  The file
   *
   * @return  {Promise<boolean>}            Whether the method had to wait
   */
  private async waitForEditorDelivery (filePath: string): Promise<boolean> {
    const registry = this._editorSyncRegistry
    if (registry === undefined || !registry.hasUnconfirmedInput(filePath)) {
      return false
    }

    const delivered = await registry.waitForDelivery(filePath)
    if (!delivered) {
      this._dataSafetyIncidents?.reportDeliveryTimeout(filePath)
    }
    return true
  }

  /**
   * Zettlr-LYH data loss prevention (R173, specification C21 section 4 item
   * 3): a change on disk met unconfirmed input of an editor. Checks the file
   * against the disk again after DELIVERY_WAIT_MS; one timer per file.
   *
   * @param  {string}  filePath  The file
   */
  private scheduleRemoteChangeRecheck (filePath: string): void {
    const registry = this._editorSyncRegistry
    if (registry === undefined) {
      return
    }

    if (this._deliveryRecheckTimers === undefined) {
      this._deliveryRecheckTimers = new Map()
    }
    const timers = this._deliveryRecheckTimers
    if (timers.has(filePath)) {
      return
    }

    timers.set(filePath, setTimeout(() => {
      timers.delete(filePath)
      if (this._shuttingDown || !this.documents.some(doc => doc.filePath === filePath)) {
        return
      }
      this.startRemoteChangeCheck(filePath, false)
    }, registry.deliveryWait))
  }

  /**
   * Zettlr-LYH data loss prevention (R173, specification C21 section 4 item
   * 7): reports a failed write as a save-failed incident, once per error.
   *
   * @param  {string}   filePath  The file that could not be written
   * @param  {unknown}  error     What the write threw
   */
  private reportSaveFailure (filePath: string, error: unknown): void {
    if (typeof error === 'object' && error !== null) {
      if (this._reportedSaveFailures === undefined) {
        this._reportedSaveFailures = new WeakSet()
      }
      if (this._reportedSaveFailures.has(error)) {
        return
      }
      this._reportedSaveFailures.add(error)
    }
    this._dataSafetyIncidents?.reportSaveFailed(filePath, error)
  }

  /**
   * Zettlr-LYH data loss prevention (R173, specification C21 section 3):
   * answers one message of an editor on the documents-authority channel.
   *
   * @param   {DocumentAuthorityIPCAPI}  message  The message
   *
   * @return  {Promise<Update[]|false|PushAnswer|DocumentLoadResult>}  The answer
   */
  private async answerDocumentAuthority (message: DocumentAuthorityIPCAPI): Promise<Update[]|false|PushAnswer|DocumentLoadResult> {
    const { command, payload } = message
    switch (command) {
      case 'pull-updates': {
        const answer = await this.pullUpdates(payload.filePath, payload.version)
        this.registerEditorSyncReport(payload.filePath, payload.editor, answer)
        return answer
      }
      case 'push-updates':
        return await this.answerPush(payload.filePath, payload.version, payload.updates)
      case 'get-document':
        return await this.getDocument(payload.filePath)
    }
  }

  /**
   * Zettlr-LYH data loss prevention (R173, specification C21 section 3.2):
   * registers what an editor reported with a pull request. The editor wrote
   * the report before it got the answer, so the updates of this editor that
   * the answer confirms no longer count as unconfirmed.
   *
   * @param  {string}          filePath  The file the editor shows
   * @param  {unknown}         report    The `editor` field of the request; undefined if the renderer sent none
   * @param  {Update[]|false}  answer    The answer to the pull request
   */
  private registerEditorSyncReport (filePath: string, report: unknown, answer: Update[]|false): void {
    const registry = this._editorSyncRegistry
    if (registry === undefined || report === undefined || report === null) {
      return
    }

    let confirmedUpdates = 0
    if (Array.isArray(answer) && typeof report === 'object') {
      const clientID = (report as { clientID?: unknown }).clientID
      confirmedUpdates = answer.filter(update => update.clientID === clientID).length
    }

    if (!registry.report(filePath, report, confirmedUpdates)) {
      this._app.log.warning(`[Document Manager] Ignored a malformed editor state report for ${filePath}.`)
    }
  }

  /**
   * Zettlr-LYH data loss prevention (R173, specification C21 section 3.3):
   * receives the updates an editor pushed and answers with the reason if they
   * are rejected. Each rejection is logged and reported as a push-rejected
   * incident (limited per file and reason).
   *
   * @param   {string}               filePath       The file
   * @param   {number}               clientVersion  The version the editor has synchronized
   * @param   {PushedUpdate[]}       clientUpdates  The updates, produced via "toJSON"
   *
   * @return  {Promise<PushAnswer>}                 The answer for the editor
   */
  private async answerPush (filePath: string, clientVersion: number, clientUpdates: PushedUpdate[]): Promise<PushAnswer> {
    const answer = await this.receivePushedUpdates(filePath, clientVersion, clientUpdates)
    if (!answer.accepted) {
      const currentVersion = this.documents.find(doc => doc.filePath === filePath)?.currentVersion
      this._dataSafetyIncidents?.reportPushRejected(filePath, answer.reason, clientVersion, currentVersion)
    }
    return answer
  }

  /**
   * Zettlr-LYH undo history (R135): records that Zettlr wrote a document to the
   * disk. Errors are only logged.
   */
  private recordUndoSave (filePath: string, length: number): void {
    const store = this.undoHistory()
    if (store === undefined) {
      return
    }
    try {
      store.recordSave(filePath, length)
    } catch (err: unknown) {
      this._app.log.error(`[Undo History] Could not record the save of ${filePath}`, err)
    }
  }

  /**
   * Zettlr-LYH undo history (R135): writes the undo history record of a
   * document that has been removed from this.documents, together with its
   * anchor file. Errors are only logged.
   */
  private async closeUndoHistory (doc: Document): Promise<void> {
    if (this.undoHistory() === undefined) {
      return
    }
    // Read path and text right away: the document object may change later
    await this.closeUndoHistoryText(doc.filePath, doc.document.toString())
  }

  /**
   * Zettlr-LYH undo history (R135): closes the undo history record of a path
   * with the given text and writes its anchor file. Errors are only logged.
   */
  private async closeUndoHistoryText (filePath: string, text: string): Promise<void> {
    const store = this.undoHistory()
    if (store === undefined) {
      return
    }
    try {
      await store.closeDocument(filePath, text, { writeAnchor: true })
    } catch (err: unknown) {
      this._app.log.error(`[Undo History] Could not close the undo history of ${filePath}`, err)
    }
  }

  /**
   * Zettlr-LYH undo history (R135): the text a document had before
   * notifyRemoteChange dropped it, kept until the document is loaded again.
   */
  private pendingExternalChanges (): Map<string, { oldText: string, source: 'disk-reload'|'comparison' }> {
    if (this._pendingExternalChanges === undefined) {
      this._pendingExternalChanges = new Map()
    }
    return this._pendingExternalChanges
  }

  /**
   * Zettlr-LYH undo history (R135): lets the undo history record, and a
   * pending external change, follow a file to its new path. Errors are only
   * logged.
   */
  private async renameUndoHistory (oldPath: string, newPath: string): Promise<void> {
    const store = this.undoHistory()
    if (store === undefined) {
      return
    }
    const pending = this.takePendingExternalChange(oldPath)
    if (pending !== undefined) {
      this.pendingExternalChanges().set(newPath, pending)
    }
    try {
      await store.rename(oldPath, newPath)
    } catch (err: unknown) {
      this._app.log.error(`[Undo History] Could not move the undo history of ${oldPath} to ${newPath}`, err)
    }
  }

  /**
   * Zettlr-LYH undo history (R135): takes the pending external change of a
   * path out of the map.
   */
  private takePendingExternalChange (filePath: string): { oldText: string, source: 'disk-reload'|'comparison' }|undefined {
    const pendingChanges = this._pendingExternalChanges
    if (pendingChanges === undefined) {
      return undefined
    }
    for (const [ key, value ] of pendingChanges) {
      if (isSamePath(key, filePath)) {
        pendingChanges.delete(key)
        return value
      }
    }
    return undefined
  }

  /**
   * Zettlr-LYH undo history (R135): a document that notifyRemoteChange dropped
   * is not loaded again (its tabs have been closed meanwhile), so its record is
   * closed with the text it had.
   */
  private async closePendingExternalChange (filePath: string): Promise<void> {
    const pending = this.takePendingExternalChange(filePath)
    if (pending !== undefined) {
      await this.closeUndoHistoryText(filePath, pending.oldText)
    }
  }

  /**
   * Zettlr-LYH undo history (R135): records the external step from the text a
   * document had before it was dropped by notifyRemoteChange to the text it
   * was reloaded with. Returns undefined if nothing was pending or nothing
   * changed.
   */
  private async recordPendingExternalChange (filePath: string, newText: string): Promise<{ step: ExternalStep, source: 'disk-reload'|'comparison' }|undefined> {
    const store = this.undoHistory()
    if (store === undefined) {
      return undefined
    }
    const pending = this.takePendingExternalChange(filePath)
    if (pending === undefined) {
      return undefined
    }
    try {
      const step = await store.recordExternal(filePath, pending.oldText, newText, pending.source)
      return step === null ? undefined : { step, source: pending.source }
    } catch (err: unknown) {
      this._app.log.error(`[Undo History] Could not record the external modification of ${filePath}`, err)
      return undefined
    }
  }

  /**
   * Zettlr-LYH undo history (R135): the get-undo-history command. Returns the
   * history of an open document at the given version, or null.
   *
   * @param   {string}                          filePath  The document
   * @param   {number}                          version   The editor's version
   *
   * @return  {Promise<UndoHistoryResult|null>}           The history
   */
  private async getUndoHistory (filePath: string, version: number): Promise<UndoHistoryResult|null> {
    const store = this.undoHistory()
    const root = this.undoHistoryRoot()
    const doc = this.documents.find(doc => doc.filePath === filePath)
    if (store === undefined || root === undefined || doc === undefined || doc.currentVersion !== version) {
      return null
    }

    const candidates: { anchorText?: string, backupText?: string } = {}
    try {
      const recordPath = undoHistoryRecordPath(filePath, {
        root,
        scratchDirectory: this.getScratchDirectory(),
        platform: process.platform
      })
      candidates.anchorText = await fsPromises.readFile(undoHistoryAnchorPath(recordPath), 'utf8')
    } catch (err: unknown) {
      // No anchor file: the record is anchored without it
      if ((err as NodeJS.ErrnoException|null)?.code !== 'ENOENT') {
        this._app.log.warning(`[Undo History] Could not read the anchor file of ${filePath}`, err)
      }
    }
    try {
      const backupText = (await this._backups.read(filePath))?.content
      if (backupText !== undefined) {
        candidates.backupText = backupText
      }
    } catch (err: unknown) {
      this._app.log.warning(`[Undo History] Could not read the backup of ${filePath}`, err)
    }

    // The editor may have pushed new changes while the files were read
    if (!this.documents.includes(doc) || doc.currentVersion !== version) {
      return null
    }
    try {
      const history = await store.getHistory(filePath, doc.document.toString(), candidates, UNDO_HISTORY_MAX_EVENTS)
      if (history === null) {
        return null
      }
      return {
        version,
        history: { done: history.done, undone: history.undone },
        externalEventIndexes: history.externalEventIndexes
      }
    } catch (err: unknown) {
      this._app.log.error(`[Undo History] Could not read the undo history of ${filePath}`, err)
      return null
    }
  }

  /**
   * Zettlr-LYH undo history (R135): moves the scratch notes out of the old
   * default folder in the documents folder, once, at boot. Returns the result,
   * or undefined if nothing could be done.
   *
   * @return  {Promise<MigrationResult|undefined>}  The migration result
   */
  private async migrateScratchFolderOnBoot (): Promise<MigrationResult|undefined> {
    const historyRoot = this.undoHistoryRoot()
    if (historyRoot === undefined) {
      return undefined
    }
    try {
      const configured: unknown = this._app.config.get().scratchNotesDirectory
      const result = await migrateLegacyScratchFolder({
        configured: typeof configured === 'string' ? configured : '',
        documentsPath: app.getPath('documents'),
        historyRoot,
        fs: nodeScratchMigrationFileSystem,
        now: Date.now
      })
      if (result.status === 'completed') {
        // The renderer tells scratch notes apart by the configured folder, so
        // the configuration has to name the new folder
        if (!this._app.config.set('scratchNotesDirectory', result.newDirectory)) {
          this._app.log.error(`[Undo History] Could not set the scratch folder to ${result.newDirectory}`)
        }
        this._app.log.info(`[Undo History] Moved ${result.moved.length} scratch folder entries to ${result.newDirectory}.`)
      } else if (result.status === 'partial') {
        const failures = result.failed.map(entry => `${entry.path} (${entry.reason})`).join(', ')
        this._app.log.warning(`[Undo History] Some scratch notes could not be moved to ${result.newDirectory}: ${failures}`)
        this.showUndoHistoryMessage(trans('Some unsaved notes could not be moved to the new folder. Zettlr will try again on the next start.'))
      }
      return result
    } catch (err: unknown) {
      this._app.log.error('[Undo History] Could not move the scratch folder', err)
      return undefined
    }
  }

  /**
   * Zettlr-LYH undo history (R135): after the scratch folder migration, the
   * tabs in documents.yaml, the backups of unsaved changes and the recent
   * documents have to name the new paths. Called before the document trees
   * are built from treedata and before the backups boot.
   *
   * @param   {DocumentWindowsJSON|undefined}        treedata  The data from documents.yaml, changed in place
   * @param   {Array<{ from: string, to: string }>}  moved     The moved entries
   */
  private async updateMigratedPaths (treedata: Partial<DocumentWindowsJSON>|undefined, moved: Array<{ from: string, to: string }>): Promise<void> {
    if (moved.length === 0) {
      return
    }

    const renamedTabs: Array<{ from: string, to: string }> = []
    const rewriteTab = (file: { path: string }): void => {
      const newPath = mapMigratedPath(file.path, moved)
      if (newPath !== undefined) {
        renamedTabs.push({ from: file.path, to: newPath })
        file.path = newPath
      }
    }
    const rewriteNode = (node: BranchNodeJSON|LeafNodeJSON): void => {
      if (node.type === 'branch') {
        for (const child of node.nodes) {
          rewriteNode(child)
        }
        return
      }
      for (const file of node.openFiles) {
        rewriteTab(file)
      }
      if (node.activeFile !== null && node.activeFile !== undefined) {
        rewriteTab(node.activeFile)
      }
    }
    if (treedata !== undefined && treedata !== null && typeof treedata === 'object') {
      for (const [ windowId, node ] of Object.entries(treedata)) {
        if (node === undefined) {
          continue
        }
        try {
          rewriteNode(node)
        } catch (err: unknown) {
          this._app.log.error(`[Undo History] Could not update the tabs of window ${windowId} after the scratch folder migration`, err)
        }
      }
    }

    // The backups have to follow before they boot: booting starts the
    // retention period of every backup that is marked open but not open in
    // this session, and such a backup would no longer be restored silently
    const backupRenames: Array<{ from: string, to: string }> = []
    for (const entry of [ ...moved, ...renamedTabs ]) {
      if (!backupRenames.some(known => isSamePath(known.from, entry.from))) {
        backupRenames.push(entry)
      }
    }
    for (const entry of backupRenames) {
      await this._backups.rename(entry.from, entry.to)
    }

    // The recent documents have no rename function: replace the list, keeping
    // its order, if any of its entries moved
    try {
      const recentDocuments = this._app.recentDocs.getAll()
      let changed = false
      const updatedPaths = recentDocuments.map(recentPath => {
        const newPath = mapMigratedPath(recentPath, moved)
        if (newPath === undefined) {
          return recentPath
        }
        changed = true
        return newPath
      })
      if (changed) {
        this._app.recentDocs.clear()
        for (const recentPath of [...updatedPaths].reverse()) {
          this._app.recentDocs.add(recentPath)
        }
      }
    } catch (err: unknown) {
      this._app.log.error('[Undo History] Could not update the recent documents after the scratch folder migration', err)
    }
  }

  /**
   * Zettlr-LYH undo history (R135): schedules the 30-day cleanup of the undo
   * history, one minute after the start and then once a day.
   */
  private scheduleUndoHistoryPrune (): void {
    if (this.undoHistory() === undefined) {
      return
    }
    this._undoHistoryPruneTimeout = setTimeout(() => {
      this._undoHistoryPruneTimeout = undefined
      void this.pruneUndoHistory()
      this._undoHistoryPruneInterval = setInterval(() => {
        void this.pruneUndoHistory()
      }, UNDO_HISTORY_PRUNE_INTERVAL)
    }, UNDO_HISTORY_FIRST_PRUNE_DELAY)
  }

  /**
   * Zettlr-LYH undo history (R135): removes the undo history older than 30
   * days. Skipped while the previous run has not finished.
   */
  private async pruneUndoHistory (): Promise<void> {
    const store = this.undoHistory()
    if (store === undefined || this._undoHistoryPruneRunning === true) {
      return
    }
    this._undoHistoryPruneRunning = true
    try {
      await store.pruneExpired({
        now: Date.now(),
        retentionDays: UNDO_HISTORY_RETENTION_DAYS,
        isOpen: filePath => this.documents.some(doc => isSamePath(doc.filePath, filePath))
      })
    } catch (err: unknown) {
      this._app.log.error('[Undo History] Could not clean up the undo history', err)
    } finally {
      this._undoHistoryPruneRunning = false
    }
  }

  /**
   * Zettlr-LYH undo history (R135): clears the timers of the cleanup.
   */
  private clearUndoHistoryPruneTimers (): void {
    if (this._undoHistoryPruneTimeout !== undefined) {
      clearTimeout(this._undoHistoryPruneTimeout)
      this._undoHistoryPruneTimeout = undefined
    }
    if (this._undoHistoryPruneInterval !== undefined) {
      clearInterval(this._undoHistoryPruneInterval)
      this._undoHistoryPruneInterval = undefined
    }
  }

  /**
   * Use this method to ask whether or not the window identified with the
   * windowId may be closed. Since every unsaved editing state is continuously
   * mirrored into the backup cache, the window may always be closed without
   * prompting the user; this method merely makes sure any pending backup
   * write reaches the disk first.
   *
   * @param   {string}            windowId  The window in question
   *
   * @return  {Promise<boolean>}            Returns false if the window may not be closed
   */
  public async askUserToCloseWindow (windowId: string): Promise<boolean> {
    // Zettlr-LYH data loss prevention (R173, specification C21 section 4 item
    // 4): first give input that the editors of this window still hold the
    // time to arrive. If before-quit has already waited, do not wait again.
    if (this._quitDeliveryWaitDone !== true && this._editorSyncRegistry !== undefined) {
      const filePaths = new Set(this._windows[windowId]?.getAllLeafs().flatMap(leaf => leaf.tabMan.openFiles.map(file => file.path)) ?? [])
      await Promise.all([...filePaths].map(async filePath => await this.waitForEditorDelivery(filePath)))
    }

    if (!this.isClean(windowId, 'window')) {
      await this._backups.flushAll()

      // Mark everything as clean so that the close can proceed; the actual
      // editing states are preserved in the backup cache.
      for (const document of this.documents) {
        document.lastSavedVersion = document.currentVersion
      }
    }

    // If we're not shutting down, this function will only be called for when
    // the user wants to actively close a window for good
    if (!this._shuttingDown) {
      this.closeWindow(windowId)
    }

    return true
  }

  async boot (): Promise<void> {
    const tabLimit = this.tabLimitState()
    tabLimit.restoring = true
    tabLimit.configListener = (option?: string): void => {
      if (option === undefined || option === 'system' || option === 'system.maxOpenTabs' || option === 'scratchNotesDirectory') {
        for (const windowId of Object.keys(this._windows)) { this.scheduleTabLimit(windowId) }
      }
    }
    this._app.config.on('update', tabLimit.configListener)
    // Loads in all openFiles
    this._app.log.verbose('Document Manager starting up ...')

    // Check if the data store is initialized
    if (!await this._config.isInitialized()) {
      this._app.log.info('[Document Manager] Initializing document storage ...')
      const tree = new DocumentTree()
      const key = uuid4()
      await this._config.init({ [key]: tree.toJSON() })
    }

    // Zettlr-LYH undo history (R135): move the scratch notes out of the old
    // default folder before the tabs are restored. The persistent reading
    // positions (R98) do not follow the moved notes for now; whether they
    // should is pending a decision.
    const migration = await this.migrateScratchFolderOnBoot()

    const treedata = await this._config.get()
    // Zettlr-LYH undo history (R135): the tabs of moved scratch notes have to
    // name the new paths before the trees are built, otherwise the access
    // check below closes them
    if (migration !== undefined && migration.moved.length > 0) {
      await this.updateMigratedPaths(treedata, migration.moved)
    }
    for (const key in treedata) {
      try {
        // Make sure to fish out invalid paths before mounting the tree
        const tree = DocumentTree.fromJSON(treedata[key])
        for (const leaf of tree.getAllLeafs()) {
          for (const file of leaf.tabMan.openFiles.map(x => x.path)) {
            if (!await this._app.fsal.testAccess(file, FSConstants.F_OK|FSConstants.W_OK|FSConstants.R_OK)) {
              leaf.tabMan.closeFile(file)
            }
          }
          if (leaf.tabMan.openFiles.length === 0) {
            leaf.parent.removeNode(leaf)
          }
        }
        this._windows[key] = tree
        this.broadcastEvent(DP_EVENTS.NEW_WINDOW, { key })
      } catch (err: unknown) {
        if (err instanceof Error) {
          this._app.log.error(`[Document Provider] Could not instantiate window ${key}: ${err.message}`, err)
        } else {
          this._app.log.error(`[Document Provider] Could not instantiate window ${key}: Unknown error`, err)
        }
      }
    }

    if (Object.keys(treedata).length === 0) {
      this._app.log.warning('[Document Manager] Creating new window since all are closed.')
      const key = uuid4()
      this._windows[key] = new DocumentTree()
      this.broadcastEvent(DP_EVENTS.NEW_WINDOW, { key })
    }

    // Prepare the unsaved-changes backup cache: create the directory, remove
    // expired backups (documents closed without saving more than two weeks
    // ago), and start the retention clock for backups whose documents are not
    // part of the restored session. This must happen before any editor
    // requests documents, because getDocument consults the backup cache.
    const sessionFilePaths: string[] = []
    for (const key in this._windows) {
      for (const leaf of this._windows[key].getAllLeafs()) {
        sessionFilePaths.push(...leaf.tabMan.openFiles.map(f => f.path))
      }
    }
    // Zettlr-LYH scratch notes (R40): reopen scratch notes that are not open
    // anymore; as part of the session, their backups are restored silently.
    sessionFilePaths.push(...await this.reopenScratchNotes(sessionFilePaths))
    await this._backups.boot([...new Set(sessionFilePaths)])

    // Zettlr-LYH external removal (R121): files that appear in a workspace, or
    // in the folder of an open file, are remembered for a few seconds, so that
    // a removed file can be recognized under its new name. The parent folders
    // are watched from now on (syncWatchedFilePaths below starts it).
    this._parentFolderWatchers = new Map()
    this._app.fsal.on('fsal-event', payload => {
      if (payload.event === 'add') {
        this.recordAddedFile(payload.descriptor.path)
      }
    })

    // Sync everything after boot
    this.syncWatchedFilePaths()
    await this.synchronizeDatabases()
    this.syncToConfig()

    // Zettlr-LYH session tabs in the Files section (R71): the restored tabs
    // count as opened files, so add the missing ones to the open history (in
    // window, pane and tab order) under the same rules as openFile: no scratch
    // notes, and nothing inside an open workspace.
    const { openWorkspaces } = this._app.config.get().app
    const restoredFilePaths = [...new Set(sessionFilePaths)].filter(filePath => {
      return !this.isScratchNote(filePath) && openWorkspaces.every(p => !filePath.startsWith(p))
    })
    this._app.config.recordSessionFiles(restoredFilePaths)

    this._app.log.info(`[Document Manager] Restored ${this.windowCount()} open windows.`)
    tabLimit.restoring = false
    for (const windowId of Object.keys(this._windows)) { this.scheduleTabLimit(windowId) }

    // Zettlr-LYH undo history (R135): the 30-day cleanup
    this.scheduleUndoHistoryPrune()
  }

  public windowCount (): number {
    return Object.keys(this._windows).length
  }

  public windowKeys (): string[] {
    return Object.keys(this._windows)
  }

  public leafIds (windowId: string): string[] {
    if (!(windowId in this._windows)) {
      return []
    }

    return this._windows[windowId].getAllLeafs().map(leaf => leaf.id)
  }

  /**
   * Adds a new, empty window and announces it, which makes the window manager
   * open it.
   *
   * @param   {Function}  prepare  Optional: called with the new key before the
   *                               window is announced (Zettlr-LYH R115 uses it
   *                               to place the window)
   *
   * @return  {string}             The key of the new window
   */
  public newWindow (prepare?: (key: string) => void): string {
    const newTree = new DocumentTree()
    const existingKeys = Object.keys(this._windows)
    let key = uuid4()
    while (existingKeys.includes(key)) {
      key = uuid4()
    }

    if (prepare !== undefined) {
      prepare(key)
    }

    this._windows[key] = newTree
    this.broadcastEvent(DP_EVENTS.NEW_WINDOW, { key })
    this.syncToConfig()
    return key
  }

  public closeWindow (windowId: string): void {
    if (this._shuttingDown) {
      return // During shutdown only the WindowManager should close windows
    }

    this.clearTabLimitWindow(windowId)

    const isLastWindow = Object.values(this._windows).length === 1

    if (windowId in this._windows && !isLastWindow) {
      // NOTE: By doing this, we always retain the window state of the last and
      // only window that is open. This means that, while additional windows
      // will be forgotten after closing, the last and final one will always
      // retain its state.
      // TODO: If we ever implement workspaces, etc., this safeguard won't be
      // necessary anymore.
      this._app.log.info(`[Documents Manager] Closing window ${windowId}!`)
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete this._windows[windowId]
      this.syncToConfig()
      this.followConflictMergeTargets()
    }
  }

  // Enable global event listening to updates of the config
  on (evt: string, callback: (...args: unknown[]) => void): void {
    this._emitter.on(evt, callback)
  }

  once (evt: string, callback: (...args: unknown[]) => void): void {
    this._emitter.once(evt, callback)
  }

  // Also do the same for the removal of listeners
  off (evt: string, callback: (...args: unknown[]) => void): void {
    this._emitter.off(evt, callback)
  }

  async shutdown (): Promise<void> {
    this._shuttingDown = true
    if (this._tabLimit !== undefined) {
      if (this._tabLimit.configListener !== undefined) { this._app.config.off('update', this._tabLimit.configListener) }
      for (const [ sender, listener ] of this._tabLimit.senders) { sender.removeListener('destroyed', listener) }
      this._tabLimit.batches.clear()
      this._tabLimit.senders.clear()
      this._tabLimit.windows.clear()
    }
    // Zettlr-LYH data loss prevention (R173): no check against the disk is
    // started anymore
    if (this._deliveryRecheckTimers !== undefined) {
      for (const timer of this._deliveryRecheckTimers.values()) { clearTimeout(timer) }
      this._deliveryRecheckTimers.clear()
    }
    // Belt and braces: Make sure no unsaved editing state is lost even if the
    // before-quit handler did not run (e.g. during an unusual shutdown path).
    await this.flushPendingScratchNoteWrites() // Zettlr-LYH scratch notes (R40)
    await this._backups.flushAll()
    // Zettlr-LYH undo history (R135): write the undo history records, too
    this.clearUndoHistoryPruneTimers()
    try {
      await this.undoHistory()?.flushAll()
    } catch (err: unknown) {
      this._app.log.error('[Undo History] Could not write the undo history on shutdown', err)
    }

    // We MUST under all circumstances properly call the close() function on
    // every chokidar process we utilize. Otherwise, the fsevents dylib will
    // still hold on to some memory after the Electron process itself shuts down
    // which will result in a crash report appearing on macOS.
    this.closeParentFolderWatchers() // Zettlr-LYH external removal (R121)
    await this._watcher.shutdown()
    this._config.shutdown()
    // Zettlr-LYH undo history (R135): stop the worker thread of the check values
    try {
      await this._undoHistoryHasher?.dispose()
    } catch (err: unknown) {
      this._app.log.error('[Undo History] Could not stop the check value worker', err)
    }
  }

  private broadcastEvent (event: DP_EVENTS, context?: DocumentsUpdateContext, recordRecentVisit: boolean = true): void {
    this.trackTabLimitEvent(event, context, recordRecentVisit)
    if (recordRecentVisit && event === DP_EVENTS.ACTIVE_FILE && context?.windowId !== undefined && context.leafId !== undefined) {
      const activeFile = this._windows[context.windowId]?.findLeaf(context.leafId)?.tabMan.activeFile
      if (activeFile != null && !this.isScratchNote(activeFile.path)) {
        this._app.recentDocs.add(activeFile.path)
      }
    }
    // Here we blast an event notification across every line of code of the app
    broadcastIpcMessage('documents-update', { event, context })
    this._emitter.emit(event, context)

    if ([ DP_EVENTS.CLOSE_FILE, DP_EVENTS.LEAF_CLOSED, DP_EVENTS.WINDOW_CLOSED, DP_EVENTS.OPEN_FILE, DP_EVENTS.NEW_LEAF ].includes(event)) {
      this.followConflictMergeTargets()
    }

    // Zettlr-LYH disk conflicts (R138): the user has turned to a tab or a pane
    // (switching tabs, the focus-leaf command, opening a file), so its active
    // tab is checked against the disk
    if (event === DP_EVENTS.ACTIVE_FILE && context?.windowId !== undefined && context.leafId !== undefined && this._tabLimit?.closing !== true) {
      this.checkActiveTabOfPane(context.windowId, context.leafId)
    }
  }

  // DOCUMENT AUTHORITY FUNCTIONS

  /** Lazy state keeps constructor-free provider fixtures compatible. */
  private tabLimitState (): TabLimitState {
    return this._tabLimit ??= {
      restoring: false, closing: false, windows: new Map(), busy: new Map(), busyDocuments: new Map(), failed: new Set(),
      batches: new Map(), senders: new Map()
    }
  }

  private tabLimitWindow (windowId: string): TabLimitWindowState {
    const state = this.tabLimitState()
    let window = state.windows.get(windowId)
    if (window === undefined) {
      window = { focused: new Map(), sequence: 0, generation: 0, scheduled: false, requested: false }
      state.windows.set(windowId, window)
    }
    return window
  }

  private tabLimitKey (leafId: string, filePath: string): string {
    return JSON.stringify([ leafId, filePath ])
  }

  private tabLimitPaused (windowId: string): boolean {
    const state = this.tabLimitState()
    return this._shuttingDown || state.restoring || !(windowId in this._windows) ||
      [...state.batches.values()].some(batch => batch.windowId === windowId)
  }

  private protectedTabForLimit (windowId: string): TabLimitIdentity|undefined {
    const tree = this._windows[windowId]
    const leafId = this.focusedLeafByWindow().get(windowId) ??
      (this._lastEditor?.windowId === windowId ? this._lastEditor.leafId : undefined)
    const leaf = (leafId === undefined ? undefined : tree?.findLeaf(leafId)) ?? tree?.getAllLeafs()[0]
    const filePath = leaf?.tabMan.activeFile?.path
    return leaf !== undefined && filePath !== undefined ? { leafId: leaf.id, filePath } : undefined
  }

  private entriesForTabLimit (windowId: string): TabLimitEntry[] {
    const state = this.tabLimitState()
    const window = this.tabLimitWindow(windowId)
    return this._windows[windowId]?.getAllLeafs().flatMap(leaf => leaf.tabMan.openFiles.map(file => {
      const document = this.documents.find(document => document.filePath === file.path)
      const loading = this._pendingDocumentLoads?.has(file.path)
      const ready = !loading && (document !== undefined || hasPDFExt(file.path) || hasImageExt(file.path))
      return {
        leafId: leaf.id, filePath: file.path, pinned: file.pinned, scratch: this.isScratchNote(file.path),
        modified: document !== undefined && document.currentVersion !== document.lastSavedVersion,
        ready,
        blocked: (state.busy.get(file.path) ?? 0) > 0 || (document !== undefined && (state.busyDocuments.get(document) ?? 0) > 0) || state.failed.has(file.path) ||
          (this._remoteChangeDialogShownFor?.includes(file.path)) ||
          (this._conflictChoiceSessions?.has(file.path)) || (this._conflictMergePendingFor?.has(file.path)) ||
          this._externalRemoval?.pendingRemovals.has(file.path) === true ||
          this._remoteChangeCheckPendingFor?.has(file.path) === true || this._remoteChangeChecksInFlight?.has(file.path) === true ||
          // Zettlr-LYH data loss prevention (R173, specification C21 section 4
          // item 5): closing the tab would discard input the editor still holds
          this.editorHasUnconfirmedInput(file.path),
        lastFocused: window.focused.get(this.tabLimitKey(leaf.id, file.path)) ?? 0
      }
    })) ?? []
  }

  private scheduleTabLimit (windowId: string): void {
    if (normalizeTabLimit(this._app.config.get().system?.maxOpenTabs) === 0 || this.tabLimitPaused(windowId)) { return }
    const window = this.tabLimitWindow(windowId)
    if (window.scheduled) { return }
    window.scheduled = true
    const generation = window.generation
    queueMicrotask(() => {
      window.scheduled = false
      if (generation !== window.generation || this.tabLimitPaused(windowId)) { return }
      this.enforceTabLimit(windowId).catch(error => {
        this._app.log.error('[Document Manager] Could not enforce the open tab limit.', error)
      })
    })
  }

  private scheduleTabLimitForPath (filePath: string): void {
    for (const [ windowId, tree ] of Object.entries(this._windows)) {
      if (tree.getAllLeafs().some(leaf => leaf.tabMan.openFiles.some(file => file.path === filePath))) {
        this.scheduleTabLimit(windowId)
      }
    }
  }

  private trackTabLimitEvent (event: DP_EVENTS, context: DocumentsUpdateContext|undefined, recordRecentVisit: boolean): void {
    if (event === DP_EVENTS.ACTIVE_FILE && recordRecentVisit && context?.windowId !== undefined && context.leafId !== undefined && this._tabLimit?.closing !== true) {
      const { windowId, leafId } = context
      const activeFile = this._windows[windowId]?.findLeaf(leafId)?.tabMan.activeFile
      if (activeFile != null) {
        this.focusedLeafByWindow().set(windowId, leafId)
        if (!this.tabLimitPaused(windowId)) {
          const window = this.tabLimitWindow(windowId)
          window.focused.set(this.tabLimitKey(leafId, activeFile.path), ++window.sequence)
        }
        this.scheduleTabLimit(windowId)
      }
    } else if (event === DP_EVENTS.CHANGE_FILE_STATUS && context?.filePath !== undefined && this._tabLimit?.closing !== true) {
      this.scheduleTabLimitForPath(context.filePath)
    } else if (event === DP_EVENTS.FILE_PATH_CHANGED && context?.oldPath !== undefined && context.newPath !== undefined) {
      this.migrateTabLimitPath(context.oldPath, context.newPath)
    } else if (event === DP_EVENTS.CLOSE_FILE && context?.windowId !== undefined && context.leafId !== undefined && context.filePath !== undefined) {
      this._tabLimit?.windows.get(context.windowId)?.focused.delete(this.tabLimitKey(context.leafId, context.filePath))
    } else if (event === DP_EVENTS.LEAF_CLOSED && context?.windowId !== undefined && context.leafId !== undefined) {
      const window = this._tabLimit?.windows.get(context.windowId)
      if (window !== undefined) {
        for (const key of window.focused.keys()) {
          if ((JSON.parse(key) as string[])[0] === context.leafId) { window.focused.delete(key) }
        }
      }
      if (this.focusedLeafByWindow().get(context.windowId) === context.leafId) { this.focusedLeafByWindow().delete(context.windowId) }
    }
  }

  /** Every await is followed by a fresh tree, configuration and focus check. */
  public async enforceTabLimit (windowId: string): Promise<void> {
    if (normalizeTabLimit(this._app.config.get().system?.maxOpenTabs) === 0 || this.tabLimitPaused(windowId)) { return }
    const window = this.tabLimitWindow(windowId)
    if (window.running !== undefined) {
      window.requested = true
      return await window.running
    }
    let generation = window.generation
    const operation = Promise.resolve().then(async () => {
      try {
        do {
          window.requested = false
          await this.runTabLimitPass(windowId, window, generation)
          generation = window.generation
        } while (window.requested && this._tabLimit?.windows.get(windowId) === window && !this.tabLimitPaused(windowId))
      } finally {
        // Release before this Promise settles: a later microtask must never
        // attach a new request to an already completed operation.
        if (window.running === operation) { window.running = undefined }
        if (window.requested && this._tabLimit?.windows.get(windowId) === window &&
          normalizeTabLimit(this._app.config.get().system?.maxOpenTabs) > 0 && !this.tabLimitPaused(windowId)) {
          this.scheduleTabLimit(windowId)
        }
      }
    })
    window.running = operation
    await operation
  }

  private async runTabLimitPass (windowId: string, window: TabLimitWindowState, generation: number): Promise<void> {
    if (generation !== window.generation || this._tabLimit?.windows.get(windowId) !== window || this.tabLimitPaused(windowId)) { return }
    const attempted = new Set<string>()
    const budget = this.entriesForTabLimit(windowId).length
    for (let attempt = 0; attempt < budget; attempt++) {
      if (generation !== window.generation || this._tabLimit?.windows.get(windowId) !== window || this.tabLimitPaused(windowId)) { return }
      const entries = this.entriesForTabLimit(windowId).map(entry => ({
        ...entry, blocked: entry.blocked || attempted.has(this.tabLimitKey(entry.leafId, entry.filePath))
      }))
      const candidate = selectTabLimitCandidates(entries, this._app.config.get().system?.maxOpenTabs, this.protectedTabForLimit(windowId))[0]
      if (candidate === undefined) { return }
      attempted.add(this.tabLimitKey(candidate.leafId, candidate.filePath))
      if (this.closeTabForLimit(windowId, candidate.leafId, candidate.filePath)) {
        await this.synchronizeDatabases()
      }
    }
  }

  /** Synchronous validation and commit. This path never touches source files or backups. */
  private closeTabForLimit (windowId: string, leafId: string, filePath: string): boolean {
    if (this.tabLimitPaused(windowId)) { return false }
    const leaf = this._windows[windowId]?.findLeaf(leafId)
    const tab = leaf?.tabMan.openFiles.find(file => file.path === filePath)
    const document = this.documents.find(document => document.filePath === filePath)
    const version = document?.currentVersion
    const candidates = selectTabLimitCandidates(this.entriesForTabLimit(windowId), this._app.config.get().system?.maxOpenTabs, this.protectedTabForLimit(windowId))
    if (leaf === undefined || tab === undefined || !candidates.some(candidate => candidate.leafId === leafId && candidate.filePath === filePath)) { return false }
    const closedTab = this.describeOpenTab(windowId, leafId, leaf.tabMan, filePath)
    // Do not let even a changed authority or tab identity reach the commit.
    if (this._windows[windowId]?.findLeaf(leafId) !== leaf || !leaf.tabMan.openFiles.includes(tab) || tab.pinned ||
      this.documents.find(current => current.filePath === filePath) !== document || document?.currentVersion !== version ||
      !selectTabLimitCandidates(this.entriesForTabLimit(windowId), this._app.config.get().system?.maxOpenTabs, this.protectedTabForLimit(windowId))
        .some(candidate => candidate.leafId === leafId && candidate.filePath === filePath) || this.tabLimitPaused(windowId)) { return false }
    if (!leaf.tabMan.closeFile(tab)) { return false }
    if (closedTab !== undefined) { this._closedTabs.push({ ...closedTab, pinned: false }) }
    if (document !== undefined && !this.isOpenInAnyLeaf(filePath)) {
      this.documents.splice(this.documents.indexOf(document), 1)
      void this.closeUndoHistory(document) // Zettlr-LYH undo history (R135)
    }
    const state = this.tabLimitState()
    state.closing = true
    try {
      this.syncToConfig()
      this.syncWatchedFilePaths()
      this.broadcastEvent(DP_EVENTS.CLOSE_FILE, { windowId, leafId, filePath }, false)
      this.broadcastEvent(DP_EVENTS.ACTIVE_FILE, { windowId, leafId, filePath: leaf.tabMan.activeFile?.path }, false)
      if (leaf.tabMan.openFiles.length === 0) {
        leaf.parent.removeNode(leaf)
        this.broadcastEvent(DP_EVENTS.LEAF_CLOSED, { windowId, leafId }, false)
        this.syncToConfig()
      }
    } finally { state.closing = false }
    return true
  }

  private clearTabLimitWindow (windowId: string): void {
    const state = this._tabLimit
    const window = state?.windows.get(windowId)
    if (window !== undefined) { window.generation++ }
    state?.windows.delete(windowId)
    this._focusedLeafByWindow?.delete(windowId)
    if (state !== undefined) {
      for (const [ token, batch ] of state.batches) { if (batch.windowId === windowId) { state.batches.delete(token) } }
      this.releaseUnusedTabLimitSenders()
    }
  }

  private releaseUnusedTabLimitSenders (): void {
    const state = this.tabLimitState()
    for (const [ sender, listener ] of state.senders) {
      if (![...state.batches.values()].some(batch => batch.sender === sender)) {
        sender.removeListener('destroyed', listener)
        state.senders.delete(sender)
      }
    }
  }

  private updateTabLimitBatch (payload: { windowId: string, action: 'begin'|'end', token?: string, succeeded?: boolean }, sender: WebContents): string|boolean {
    const state = this.tabLimitState()
    if (sender.isDestroyed() || this._windows[payload.windowId] === undefined) { return false }
    if (payload.action === 'begin') {
      const token = uuid4()
      const window = this.tabLimitWindow(payload.windowId)
      window.generation++
      window.scheduled = false
      window.requested = false
      state.batches.set(token, { windowId: payload.windowId, sender })
      if (!state.senders.has(sender)) {
        const listener = (): void => {
          for (const [ activeToken, batch ] of state.batches) {
            if (batch.sender === sender) {
              this.tabLimitWindow(batch.windowId).generation++
              state.windows.delete(batch.windowId)
              this._focusedLeafByWindow?.delete(batch.windowId)
              state.batches.delete(activeToken)
            }
          }
          state.senders.delete(sender)
        }
        state.senders.set(sender, listener)
        sender.once('destroyed', listener)
      }
      return token
    }
    const batch = payload.token === undefined ? undefined : state.batches.get(payload.token)
    if (payload.action !== 'end' || batch === undefined || batch.windowId !== payload.windowId || batch.sender !== sender) { return false }
    state.batches.delete(payload.token!)
    this.releaseUnusedTabLimitSenders()
    if (payload.succeeded === true && !this.tabLimitPaused(payload.windowId)) { this.scheduleTabLimit(payload.windowId) }
    return true
  }

  /** Reference counts cover concurrent saves and both names of a moving document. */
  private async protectTabLimitSave<Result> (
    filePath: string, operation: (protectPath: (path: string) => void) => Promise<Result>, succeeded: (result: Result) => boolean
  ): Promise<Result> {
    const state = this.tabLimitState()
    const paths = new Set<string>()
    const document = this.documents.find(document => document.filePath === filePath)
    const protectPath = (path: string): void => {
      if (paths.has(path)) { return }
      paths.add(path)
      state.busy.set(path, (state.busy.get(path) ?? 0) + 1)
    }
    protectPath(filePath)
    if (document !== undefined) { state.busyDocuments.set(document, (state.busyDocuments.get(document) ?? 0) + 1) }
    let success = false
    try {
      const result = await operation(protectPath)
      success = succeeded(result)
      return result
    } finally {
      if (document !== undefined) { protectPath(document.filePath) }
      if (document !== undefined) {
        const remaining = (state.busyDocuments.get(document) ?? 1) - 1
        if (remaining > 0) { state.busyDocuments.set(document, remaining) } else { state.busyDocuments.delete(document) }
      }
      for (const path of paths) {
        const remaining = (state.busy.get(path) ?? 1) - 1
        if (remaining > 0) { state.busy.set(path, remaining) } else { state.busy.delete(path) }
        if (!success) { state.failed.add(path) } else if (document !== undefined && this.documents.includes(document) && !this.isModified(document.filePath)) { state.failed.delete(path) }
      }
      if (success) { for (const path of paths) { this.scheduleTabLimitForPath(path) } }
    }
  }

  private migrateTabLimitPath (oldPath: string, newPath: string): void {
    const state = this.tabLimitState()
    if (state.failed.delete(oldPath)) { state.failed.add(newPath) }
    for (const window of state.windows.values()) {
      for (const [ key, sequence ] of [...window.focused]) {
        const [ leafId, filePath ] = JSON.parse(key) as string[]
        if (filePath === oldPath) {
          window.focused.delete(key)
          window.focused.set(this.tabLimitKey(leafId, newPath), sequence)
        }
      }
    }
  }

  public async getDocument (filePath: string): Promise<DocumentLoadResult> {
    const existingDocument = this.documents.find(doc => doc.filePath === filePath)
    if (existingDocument !== undefined) {
      const result: DocumentLoadResult = {
        content: existingDocument.document.toString(),
        type: existingDocument.type,
        startVersion: existingDocument.currentVersion
      }
      // Zettlr-LYH undo history (R135): the external step only fits the text
      // it was loaded with (spec C20, section 7)
      const external = existingDocument.undoExternalStep
      if (external !== undefined && external.loadedVersion === existingDocument.currentVersion) {
        result.externalStep = { ...external.step, source: external.source }
      }
      return result
    }

    // Deduplicate concurrent loads of the same file: The backup check below
    // may show a dialog, during which further requests for the same file
    // (e.g. from a second editor pane) could arrive.
    const pendingLoad = this._pendingDocumentLoads.get(filePath)
    if (pendingLoad !== undefined) {
      return await pendingLoad
    }

    const load = this._loadDocument(filePath)
    this._pendingDocumentLoads.set(filePath, load)
    let succeeded = false
    try {
      const result = await load
      succeeded = true
      return result
    } finally {
      this._pendingDocumentLoads.delete(filePath)
      if (succeeded && this.documents.some(document => document.filePath === filePath) && !this.isModified(filePath)) {
        this._tabLimit?.failed.delete(filePath)
      }
      this.scheduleTabLimitForPath(filePath)
    }
  }

  /**
   * Loads a document from disk into the document authority. If the backup
   * cache holds an unsaved editing state for the file that differs from the
   * disk contents, the user is always asked which version to open, both if
   * the document counts as still open (i.e. it is part of the restored
   * session) and if it had been closed without saving. Choosing the version
   * with unsaved changes restores the backup; choosing the file on disk
   * discards the backup. The contents are never replaced silently.
   *
   * @param   {string}  filePath  The absolute path of the file to load
   */
  private async _loadDocument (filePath: string): Promise<DocumentLoadResult> {
    // TODO: We also need to be able to load files not present in the file tree!
    const descriptor = await this._app.fsal.getDescriptorForAnySupportedFile(filePath)
    if (descriptor === undefined || descriptor.type === 'other') {
      throw new Error(`Cannot load file ${filePath}`) // TODO: Proper error handling & state recovery!
    }

    const diskContent = await this._app.fsal.loadAnySupportedFile(filePath)
    const loadedOrSavedModifiedAt = descriptor.modtime

    let type = DocumentType.Markdown

    if (descriptor.type === 'code') {
      const codeDocumentType = getDocumentTypeForExtension(descriptor.path)
      if (codeDocumentType !== undefined) {
        type = codeDocumentType
      }
    }

    // Only files open in some editor pane belong into the document authority.
    // A request for any other file comes from an editor that is being torn
    // down (e.g. right after its tab was closed); registering the file again
    // would leave an orphaned document behind and, worse, re-trigger the
    // backup restore prompt for a document the user has just closed.
    if (!this.isOpenInAnyLeaf(filePath)) {
      // Zettlr-LYH undo history (R135): a document that notifyRemoteChange
      // dropped and that is not reloaded anymore is closed in its record
      await this.closePendingExternalChange(filePath)
      return { content: diskContent, type, startVersion: 0 }
    }

    // Check the backup cache for an unsaved editing state of this file
    let content = diskContent
    let restoredFromBackup = false
    let lastEditedAt: number|undefined
    const backup = await this._backups.read(filePath)
    if (backup !== undefined) {
      if (backup.content === diskContent) {
        // The backup equals the disk state (e.g. the file has been saved by
        // other means in the meantime), so it holds no information anymore.
        await this._backups.remove(filePath)
      } else {
        // Zettlr-LYH backup restore choice (R50): The backup differs from the
        // disk contents, either because the document counts as open (part of
        // the restored session) or because it had been closed without saving
        // and its editing state was retained. In both cases, let the user
        // decide which version to open instead of replacing it silently.
        const isSessionRestore = backup.metadata.closedAt === null
        const options: MessageBoxOptions = buildBackupRestoreDialogOptions({
          situation: isSessionRestore ? 'session-restore' : 'reopened-after-close',
          fileName: path.basename(filePath),
          backupEditedAt: backup.metadata.updatedAt,
          diskModifiedAt: descriptor.modtime,
          backupSize: Buffer.byteLength(descriptor.type === 'file'
            ? descriptor.bom + backup.content.split('\n').join(descriptor.linefeed)
            : descriptor.bom + backup.content, 'utf-8'),
          diskSize: descriptor.size,
          formatTime: formatTimestamp,
          formatSize: describeSize
        })
        const { response } = await dialog.showMessageBox(options)
        if (backupRestoreActionForResponse(response) === 'restore') {
          content = backup.content
          restoredFromBackup = true
          lastEditedAt = backup.metadata.updatedAt
          // A backup of a closed document must count as open again; one from
          // the restored session already does.
          if (!isSessionRestore) {
            await this._backups.markOpen(filePath)
          }
        } else {
          await this._backups.remove(filePath)
        }
      }
    }

    // Zettlr-LYH undo history (R135): if notifyRemoteChange has just dropped
    // this document, record the step from its old text to the new one. This
    // happens before the document is registered, so that no edit can be
    // recorded before the external step.
    const externalChange = await this.recordPendingExternalChange(filePath, content)

    // The user may have closed the tab while the restore prompt was shown.
    if (!this.isOpenInAnyLeaf(filePath)) {
      if (restoredFromBackup) {
        await this._backups.markClosed(filePath)
      }
      if (externalChange !== undefined) {
        await this.closeUndoHistoryText(filePath, content)
      }
      return { content, type, startVersion: 0 }
    }

    const doc: Document = {
      filePath,
      type,
      descriptor,
      currentVersion: 0,
      minimumVersion: 0,
      // A document restored from a backup must immediately count as modified,
      // since its contents differ from what is stored on disk.
      lastSavedVersion: restoredFromBackup ? -1 : 0,
      lastSavedContent: diskContent,
      updates: [],
      document: Text.of(content.split('\n')),
      lastSavedCharCount: descriptor.type === 'file' ? descriptor.charCount : 0,
      lastSavedWordCount: descriptor.type === 'file' ? descriptor.wordCount : 0,
      saveTimeout: undefined,
      lastEditedAt,
      loadedOrSavedModifiedAt
    }

    this.documents.push(doc)
    this.syncWatchedFilePaths()
    // Zettlr-LYH external removal (R121): remember which file on disk this is,
    // so that it can be recognized after a rename. Not awaited: nothing needs
    // it before a removal is reported, which takes at least the pairing window.
    this.refreshFileIdentity(doc).catch(() => undefined)

    if (restoredFromBackup) {
      this.broadcastEvent(DP_EVENTS.CHANGE_FILE_STATUS, { filePath, status: 'modification' })
    }

    if (externalChange === undefined) {
      return { content, type, startVersion: 0 }
    }
    // Zettlr-LYH undo history (R135): the editor turns this into an undoable step
    doc.undoExternalStep = { step: externalChange.step, source: externalChange.source, loadedVersion: 0 }
    return { content, type, startVersion: 0, externalStep: { ...externalChange.step, source: externalChange.source } }
  }

  private async pullUpdates (filePath: string, clientVersion: number): Promise<Update[]|false> {
    const doc = this.documents.find(doc => doc.filePath === filePath)
    if (doc === undefined) {
      if (!this.isOpenInAnyLeaf(filePath)) {
        // The document has been closed. The requesting editor still had a
        // pending pull when closing the file broadcast its final status
        // change; it is about to be destroyed, so there is nothing to sync.
        // Returning false here would make it reload the closed document.
        return []
      }

      // Indicate to the editor that they should get the document (again). This
      // handles the case where the document has been remotely modified and thus
      // removed from the document array.
      return false
    }

    if (clientVersion < doc.minimumVersion || clientVersion > doc.currentVersion) {
      // The client is completely out of sync and has to reload the document.
      // If this happens because clientVersion < doc.minimumVersion, this means
      // that the lost connection somehow. If it happens because clientVersion
      // > doc.currentVersion, it means that we had to roll over the version in
      // pushUpdates below.
      return false
    } else if (clientVersion < doc.currentVersion) {
      return doc.updates.slice(clientVersion - doc.minimumVersion)
    } else {
      return [] // No updates available
    }
  }

  /**
   * Receives the updates an editor pushed. Returns whether they were accepted,
   * and throws if the document is not loaded.
   *
   * Zettlr-LYH data loss prevention (R173, specification C21 section 3.3 item
   * 4): signature and behavior of this method are unchanged. The editors do
   * not reach it anymore; their pushes go through answerPush, which answers
   * with the reason of a rejection instead.
   */
  private async pushUpdates (filePath: string, clientVersion: number, clientUpdates: PushedUpdate[]): Promise<boolean> { // clientUpdates must be produced via "toJSON"
    const answer = await this.receivePushedUpdates(filePath, clientVersion, clientUpdates)
    if (answer.reason === 'document-missing') {
      throw new Error(`Could not receive updates for file ${filePath}: Not found.`)
    }
    return answer.accepted
  }

  /**
   * Zettlr-LYH data loss prevention (R173, specification C21 section 3.3):
   * applies the updates an editor pushed to the document, or says why not.
   * Nothing is logged or reported here; answerPush does that.
   *
   * @param   {string}               filePath       The file
   * @param   {number}               clientVersion  The version the editor has synchronized
   * @param   {PushedUpdate[]}       clientUpdates  The updates, produced via "toJSON"
   *
   * @return  {Promise<PushAnswer>}                 Whether the updates were accepted, and if not, why
   */
  private async receivePushedUpdates (filePath: string, clientVersion: number, clientUpdates: PushedUpdate[]): Promise<PushAnswer> {
    const doc = this.documents.find(doc => doc.filePath === filePath)
    if (doc === undefined) {
      return { accepted: false, reason: 'document-missing' }
    }

    const comparison = this._conflictChoiceSessions.get(filePath)
    if (comparison !== undefined && comparison.document === doc) {
      // The same range check as in preserveUpdatesDuringComparison, evaluated
      // before the call, to tell an out-of-range version from a failed write
      const minimumVersion = comparison.preservedUpdates?.minimumVersion ?? doc.minimumVersion
      const versionOutOfRange = clientUpdates.length > 0 && (clientVersion < minimumVersion || clientVersion > doc.currentVersion)
      if (await this.preserveUpdatesDuringComparison(filePath, comparison, clientVersion, clientUpdates)) {
        return { accepted: true }
      }
      return versionOutOfRange ? { accepted: false, reason: 'comparison-version-out-of-range' } : { accepted: false }
    }

    if (clientVersion !== doc.currentVersion) {
      return { accepted: false, reason: 'version-mismatch', currentVersion: doc.currentVersion }
    }

    // Before applying any updates, we have to clear any potential timeout so
    // that it does not interfere with us updating the document. Otherwise, this
    // can lead to a faulty state where the provider cannot save the file
    // anymore.
    clearTimeout(doc.saveTimeout)

    for (const update of clientUpdates) {
      const changes = ChangeSet.fromJSON(update.changes)
      // Zettlr-LYH undo history (R135): the record needs the text before the change
      this.recordUndoUpdate(filePath, doc.document, changes, update)
      doc.updates.push(update)
      try {
        doc.document = changes.apply(doc.document)
      } catch (err: unknown) {
        dialog.showErrorBox(
          'Document out of sync',
          `Your modifications could not be applied to the document in memory.
This means that saving might fail. Please report this bug to us, copy the
current contents from the editor somewhere else, and restart the application.`
        )
        throw err
      }
      doc.currentVersion = doc.minimumVersion + doc.updates.length
      // People are lazy, and hence there is a non-zero chance that in a few
      // instances the currentVersion will get dangerously close to
      // Number.MAX_SAFE_INTEGER. In that case, we need to perform a rollback to
      // version 0 and notify all editors that have the document in question
      // open to simply re-load it. That will cause a screen-flicker, but
      // honestly better like this than otherwise.
      if (doc.currentVersion === Number.MAX_SAFE_INTEGER - 1) {
        console.warn(`Document ${filePath} has reached MAX_SAFE_INTEGER. Performing rollback ...`)
        doc.minimumVersion = 0
        doc.currentVersion = doc.updates.length
        // Zettlr-LYH data loss prevention (R173, specification C21 section 4
        // item 6): tell all editor instances right away. Their next pull
        // carries a version beyond the new current version and is answered
        // with false, which makes them reload the document.
        this.broadcastEvent(DP_EVENTS.CHANGE_FILE_STATUS, { filePath, status: 'modification' })
      }
    }

    doc.lastEditedAt = Date.now()

    // Notify all clients, they will then request the update
    this.broadcastEvent(DP_EVENTS.CHANGE_FILE_STATUS, { filePath, status: 'modification' })

    // Mirror the new editing state into the backup cache (debounced) so that
    // unsaved changes survive a restart or crash without touching the source
    // file. The content is computed lazily when the backup is written.
    this._backups.schedulePersist(filePath, () => doc.document.toString())

    // Drop all updates that exceed the amount of updates we allow.
    // Zettlr-LYH input loss fix (R135): never drop past the version the pushing
    // editor started from. While pushes are rejected, an editor can pile up more
    // unconfirmed updates than the history holds; if the history were cut down
    // to the limit after such a push, the version the editor has synchronized
    // would lie below minimumVersion, its next pull would return false, and it
    // would reload the document and lose the input it has not yet seen
    // confirmed. Keeping everything after clientVersion lets that pull return
    // the editor's own updates. The next push cuts the history down again.
    while (doc.updates.length > MAX_VERSION_HISTORY && doc.minimumVersion < clientVersion) {
      doc.updates.shift()
      doc.minimumVersion += 1
    }

    const autoSave = this._app.config.get().editor.autoSave
    // Zettlr-LYH scratch notes (R40): scratch notes are always written
    // automatically, whatever the autosave setting
    const isScratchNote = this.isScratchNote(filePath)

    // No autosave
    if (autoSave === 'off' && !isScratchNote) {
      return { accepted: true }
    }

    // While the "file changed on disk" dialog is open for this file, an
    // autosave would overwrite the newer disk contents before the user has
    // decided how to resolve the conflict. handleRemoteChange cleared the
    // pending timeout; do not arm a new one until the dialog is resolved.
    // Zettlr-LYH external removal (R121): the same holds while the removal of
    // the file is being handled, so that it is not recreated at its old path.
    if (this._remoteChangeDialogShownFor.includes(filePath) || this._externalRemoval?.pendingRemovals.has(filePath) === true) {
      return { accepted: true }
    }

    let saveDelay = autoSave === 'delayed' ? DELAYED_SAVE_TIMEOUT : IMMEDIATE_SAVE_TIMEOUT
    if (isScratchNote) {
      saveDelay = SCRATCH_AUTOSAVE_DELAY // Zettlr-LYH scratch notes (R40)
    }

    doc.saveTimeout = setTimeout(() => {
      this.writeDocumentAutomatically(doc)
        .catch(err => {
          this._app.log.error(`[Document Provider] Could not save file ${doc.filePath}: ${err.message as string}`, err)
          // Zettlr-LYH data loss prevention (R173): nobody waits for an
          // automatic save, so its failure must reach the user another way.
          // A failed write has been reported by saveFile already.
          this.reportSaveFailure(doc.filePath, err)
        })
    }, saveDelay)

    return { accepted: true }
  }

  /**
   * Preserve late input without modifying the frozen document or the source file.
   * Zettlr-LYH undo history (R135): nothing is recorded here, because none of
   * these updates is applied to doc.document; the preserved input only goes
   * into the backup copy.
   */
  private async preserveUpdatesDuringComparison (filePath: string, session: ConflictChoiceSession, clientVersion: number, clientUpdates: Update[]): Promise<boolean> {
    if (clientUpdates.length === 0) { return true }
    const doc = session.document
    const state = session.preservedUpdates ??= {
      startVersion: doc.currentVersion,
      minimumVersion: doc.minimumVersion,
      history: [...doc.updates],
      requests: new Map(),
      failures: new Set(),
      pending: Promise.resolve(true)
    }
    if (clientVersion < state.minimumVersion || clientVersion > doc.currentVersion) { return false }
    const requestKey = JSON.stringify([ clientVersion, clientUpdates ])
    const previous = state.requests.get(requestKey)
    if (previous !== undefined) { return await previous }
    const preservation = state.pending.catch(() => false).then(async () => {
      const updates = clientUpdates.map(update => ({ clientID: update.clientID, changes: ChangeSet.fromJSON(update.changes) }))
      const history = clientVersion < state.startVersion
        ? state.history.slice(clientVersion - state.minimumVersion).map(update => ({ clientID: update.clientID, changes: ChangeSet.fromJSON(update.changes) }))
        : []
      let preservedDocument = doc.document
      for (const update of rebaseUpdates(updates, history)) {
        preservedDocument = update.changes.apply(preservedDocument)
      }
      const backupPath = this.conflictSiblingPath(filePath, 'Backup')
      await this._app.fsal.writeTextFile(backupPath, this.serializeContentsForDisk(doc, preservedDocument.toString()))
      state.failures.delete(requestKey)
      this._app.log.info(`[Document Provider] Input received during the comparison of ${filePath} was preserved in ${backupPath}.`)
      if (state.pending === preservation && state.failures.size === 0 &&
        this._conflictChoiceSessions.get(filePath) === session && this.isCurrentConflictDocument(filePath, doc)) {
        // pullUpdates(false) is the existing reload protocol. Only retire the
        // pending client updates AFTER their complete text is safely written.
        // New editors load this version and do not enter a reload loop.
        doc.currentVersion++
        doc.minimumVersion = doc.currentVersion
        doc.updates = []
        this.broadcastEvent(DP_EVENTS.CHANGE_FILE_STATUS, { filePath, status: 'modification' })
      }
      return true
    }).catch((error: unknown) => {
      state.requests.delete(requestKey)
      state.failures.add(requestKey)
      this._app.log.error(`[Document Provider] Could not preserve input received during the comparison of ${filePath}.`, error)
      return false
    })
    state.requests.set(requestKey, preservation)
    state.pending = preservation
    return await preservation
  }

  /**
   * Performs the automatic write that pushUpdates schedules after the last edit
   * of a document. Zettlr-LYH scratch note names (R132): after the automatic
   * write of a scratch note, the note is renamed after the level-1 heading it
   * starts with. Saving a scratch note to a location of the user's choice, or
   * writing it for any other reason, does not go through here.
   *
   * @param   {Document}       doc  The document to write
   *
   * @return  {Promise<void>}       Resolves once the write (and a rename) is done
   */
  private async writeDocumentAutomatically (doc: Document): Promise<void> {
    // saveFile replaces lastSavedContent with the content it writes, so this is
    // the content that was written to the file the last time, i.e. the content
    // that the current file name has been derived from
    const contentBeforeWrite = doc.lastSavedContent

    const written = await this.saveFile(doc.filePath)

    // If the user has typed in the meantime, a new automatic write is already
    // scheduled and will name the scratch note after the newer content. The
    // path is read again, since the file may have been moved in the meantime.
    if (!written || doc.currentVersion !== doc.lastSavedVersion || !this.isScratchNote(doc.filePath)) {
      return
    }

    try {
      await this.autoNameScratchNote(doc.filePath, contentBeforeWrite, doc.lastSavedContent)
    } catch (err: unknown) {
      this._app.log.error(`[DocumentManager] Could not name scratch note ${doc.filePath} after its heading`, err)
    }
  }

  // END DOCUMENT AUTHORITY FUNCTIONS

  /**
   * This function searches all currently opened documents for files that have
   * databases attached to them, and announces to the citeproc provider that it
   * should keep those available. Resolves once the citeproc provider finishes
   * synchronizing.
   */
  private async synchronizeDatabases (): Promise<void> {
    const libraries: string[] = []

    for (const doc of this.documents) {
      if (doc.descriptor.type !== 'file') {
        continue
      }

      if (doc.descriptor.frontmatter !== null && 'bibliography' in doc.descriptor.frontmatter) {
        const bib = doc.descriptor.frontmatter.bibliography
        if (typeof bib === 'string' && path.isAbsolute(bib)) {
          libraries.push(bib)
        }
      }
    }

    await this._app.citeproc.synchronizeDatabases(libraries)
  }

  /**
   * Opens a file in a specific leaf in a given window. If windowId or leafId is not specified
   * it will open the file in the last focused leaf, in the last focused window.
   *
   * @param  {string|undefined} windowId  The windowId to open the document in
   * @param  {string|undefined} leafId    The leafId of the window to open the document in
   * @param  {string}  filePath   The absolute file path
   * @param  {boolean} newTab Optional. If true, will always prevent exchanging the currently active file.
   * @param  {boolean} moveToEnd Optional. Zettlr-LYH: if the file is already
   *                             open, move its tab to the end of the tab bar
   *                             (a file opened again from Explorer).
   *
   * @param {boolean} preferInternalPDF Open this PDF internally for an explicit
   *                             drop or external request, without saving a preference.
   * @param {boolean} insertAfterActiveTab Position a file-manager request after the active tab.
   *
   * @return {Promise<boolean>} True if it successfully opens the file
   */
  public async openFile (windowId: string|undefined, leafId: string|undefined, filePath: string, newTab?: boolean, moveToEnd?: boolean, preferInternalPDF?: boolean, insertAfterActiveTab?: boolean): Promise<boolean> {
    if (!isFile(filePath)) {
      // The renderer process essentially just throws paths at the documents
      // provider when the user intents to open them. Users can also link
      // folders, so we just quickly check for that, and open them (similar to
      // non-Markdown files a few lines below).
      if (isDir(filePath)) {
        await shell.openPath(filePath)
        return false
      }

      // Else: Whatever this is, it was not a proper path.
      throw new Error(`Could not open file ${filePath}: Not an existing file.`)
    }

    // Check if we can, and should, actually open the file in Zettlr. If not, we
    // need to open it via the shell externally. NOTE: This check is, to varying
    // degrees, implemented at the sources of opening-requests (read: mostly in
    // the renderers). If you see this comment, and spot a place where we
    // implemented this guard somewhere else, please refactor to simply attempt
    // to open a file path with the documents provider and defer to this check
    // here. Amend with any additional necessary checks from the other guards.
    if (!hasMdOrCodeExt(filePath)) {
      const { files } = this._app.config.get()
      let shouldOpenExternally = true
      if (hasImageExt(filePath) && files.images.openWith === 'zettlr') {
        shouldOpenExternally = false
      } else if (hasPDFExt(filePath) && (preferInternalPDF === true || files.pdf.openWith === 'zettlr')) {
        shouldOpenExternally = false
      }

      if (shouldOpenExternally) {
        await shell.openPath(filePath)
        return false
      }
    }

    // If windowId is not provided, then use the last focused window
    if (windowId === undefined) {
      const mainWindow: BrowserWindow|undefined = this._app.windows.getFirstMainWindow()
      const key = (mainWindow !== undefined) ? this._app.windows.getMainWindowKey(mainWindow) : undefined
      if (key !== undefined) {
        windowId = key
      }
    }

    if (windowId === undefined) {
      this._app.log.warning(`Could not open file ${filePath}: windowId was undefined.`)
      return false
    }

    let leaf: DTLeaf|undefined
    if (leafId === undefined) {
      if (this._lastEditor.leafId !== undefined) {
        leaf = this._windows[windowId].findLeaf(this._lastEditor.leafId)
      }
      if (leaf === undefined) {
        leaf = this._windows[windowId].getAllLeafs()[0]
      }
    } else {
      leaf = this._windows[windowId].findLeaf(leafId)
    }

    if (leaf === undefined) {
      this._app.log.warning(`Could not open file ${filePath}: leaf was undefined.`)
      return false
    }

    // Now we definitely know the leaf ID if it was undefined
    if (leafId === undefined) {
      leafId = leaf.id
    }

    // Keep the focus notification while excluding the old tab from history
    // until the requested file has actually become active.
    this._updateFocusLeaf(windowId, leafId, false)

    // After here, the document will in some way be opened.
    // Zettlr-LYH scratch notes (R40): scratch notes stay out of the recent
    // documents and out of the open files list of the file manager
    const isScratchNote = this.isScratchNote(filePath)
    const { openWorkspaces } = this._app.config.get().app
    if (!isScratchNote && openWorkspaces.every(p => !filePath.startsWith(p))) {
      // The file just opened is outside the current opened workspaces -> record
      // it in the open history. NOTE that we do this unconditionally: files
      // already contained in the history must be moved back to the front so
      // that the most recently opened file is listed first.
      this._app.config.recordOpenedFile(filePath)
    }

    if (leaf.tabMan.openFiles.map(x => x.path).includes(filePath)) {
      // File is already open -> simply set it as active
      // leaf.tabMan.activeFile = filePath
      if (!leaf.tabMan.openFile(filePath, undefined, insertAfterActiveTab) && leaf.tabMan.activeFile?.path !== filePath) {
        return false
      }
      if (moveToEnd === true) {
        const order = leaf.tabMan.openFiles.map(file => file.path).filter(openPath => openPath !== filePath)
        this.sortOpenFiles(windowId, leafId, [ ...order, filePath ])
      }
      this._updateFocusLeaf(windowId, leafId)
      this.syncToConfig()
      return true
    }

    // NOTE: Since openFile will set filePath as active, we have to retrieve the
    // (previously) active file *before* opening the new one. See bug #5065 for
    // context.
    const activeFile = leaf.tabMan.activeFile
    const ret = leaf.tabMan.openFile(filePath, undefined, insertAfterActiveTab)
    if (!ret) {
      return false
    }
    if (ret) {
      this.broadcastEvent(DP_EVENTS.OPEN_FILE, { windowId, leafId, filePath })
    }

    // Zettlr-LYH scratch notes (R40): a scratch note counts as unsaved from
    // the start, but the renderers only re-read the unsaved files on a status
    // change, so its tab would lack the "* " until the first edit
    if (ret && isScratchNote) {
      this.broadcastEvent(DP_EVENTS.CHANGE_FILE_STATUS, { filePath, status: 'modification' })
    }

    // Close the (formerly active) file if we should avoid new tabs and have not
    // gotten a specific request to open it in a *new* tab
    const { avoidNewTabs } = this._app.config.get().system
    if (activeFile !== null && avoidNewTabs && newTab !== true && !this.isModified(activeFile.path)) {
      // Zettlr-LYH reopen closed tab (R43): the replaced tab counts as closed
      const replacedTab = this.describeOpenTab(windowId, leafId, leaf.tabMan, activeFile.path)
      if (leaf.tabMan.closeFile(activeFile) && replacedTab !== undefined) {
        this._closedTabs.push(replacedTab)
      }
      this.syncWatchedFilePaths()
      this.broadcastEvent(DP_EVENTS.CLOSE_FILE, { windowId, leafId, filePath: activeFile.path })
    }

    this._updateFocusLeaf(windowId, leafId)
    await this.synchronizeDatabases()
    this.syncToConfig()
    return ret
  }

  /**
   * Closes the given file if it's in fact open. This function deals with every
   * potential problem such as retrieving user consent to closing the file if it
   * is modified.
   *
   * @param   {MDFileDescriptor|CodeFileDescriptor}  file  The file to be closed
   *
   * @return  {boolean}                                    Whether or not the file was closed
   */
  public async closeFile (windowId: string, leafId: string, filePath: string, unsavedResponse?: 0|1): Promise<boolean> {
    // Zettlr-LYH Windows dialog (R72): unsavedResponse answers the
    // unsaved-changes question in advance (0 = Save, 1 = Don't save), for a
    // batch close that has already asked with its own question

    // Zettlr-LYH data loss prevention (R173, specification C21 section 4 item
    // 4): closing the tab destroys its editor. If that editor still holds
    // input the document manager has not received, the checks below would not
    // know about it; give it DELIVERY_WAIT_MS to arrive first.
    if (await this.waitForEditorDelivery(filePath) && this._windows[windowId] === undefined) {
      this._app.log.info(`[Document Manager] Not closing file ${filePath}: Its window was closed while waiting for the input of its editor.`)
      return false
    }

    const leaf = this._windows[windowId].findLeaf(leafId)
    if (leaf === undefined) {
      this._app.log.error(`[Document Manager] Could not close file ${filePath}: Editor pane not found.`)
      return false
    }

    let numOpenInstances = 0
    await this.forEachLeaf(async tabMan => {
      const file = tabMan.openFiles.find(f => f.path === filePath)
      if (file !== undefined) {
        numOpenInstances++
      }
      return false
    })

    // Zettlr-LYH scratch notes (R40): closing the last tab of a scratch note
    // deletes it (if blank), saves it under a new name, or discards it.
    let scratchNoteCleanup: ScratchNoteCleanup|undefined
    if (numOpenInstances === 1 && this.isScratchNote(filePath)) {
      const decision = await this.decideScratchNoteClose(windowId, leafId, filePath)
      if (decision.action === 'cancel') {
        return false
      } else if (decision.action === 'saved') {
        // The tab now shows the saved file, which is closed like any clean file
        filePath = decision.savedPath
      } else if (decision.action === 'plain') {
        numOpenInstances = this.countOpenInstances(filePath)
      } else {
        scratchNoteCleanup = decision
      }
    }

    // If we were to completely remove the file from our buffer, we have to ask
    // first. If there's at least another instance open that means that we won't
    // lose the file. NOTE: openFile will be undefined if the file has not been
    // opened in this session of Zettlr, hence it will not be modified, hence we
    // don't have to do anything.
    const openFile = this.documents.find(doc => doc.filePath === filePath)
    if (openFile !== undefined && this.isModified(filePath) && numOpenInstances === 1) {
      const detail = trans('File: %s', openFile.descriptor.name)
      const result = unsavedResponse !== undefined
        ? { response: unsavedResponse }
        : await this._app.windows.askSaveChanges(detail)
      // 0 = Save, 1 = Don't save, 2 = Cancel
      if (result.response === 1) {
        // The user closed the document without saving. Retain the unsaved
        // editing state in the backup cache (for two weeks) in case the
        // close was a mistake; reopening the file will offer to restore it.
        await this._backups.markClosed(filePath)
        // Clear the modification flag
        openFile.lastSavedVersion = openFile.currentVersion
        this.broadcastEvent(DP_EVENTS.CHANGE_FILE_STATUS, { filePath, status: 'modification' })
      } else if (result.response === 0) {
        const saved = await this.saveFile(filePath)
        // Zettlr-LYH save-time conflict check (R52): the save may not have
        // happened because the file was changed on disk in the meantime; the
        // conflict flow has taken over. Closing now would drop the document
        // while it still carries the unsaved changes, so keep the tab open.
        if (!saved) {
          // Zettlr-LYH disk conflicts (R138): the save of a document that is
          // not in front of the user only marked it, because the disk has
          // changed. Closing is an explicit action on this tab, so activate
          // it and open the comparison right away (this is not stealing the
          // focus); the tab stays open.
          if (this.remoteChangeCheckPending().has(filePath) && this.documents.includes(openFile) &&
            !this.hasPendingExternalDecision(filePath) && leaf.tabMan.openFiles.some(file => file.path === filePath)) {
            leaf.tabMan.activeFile = filePath
            this._lastEditor.windowId = windowId
            this._lastEditor.leafId = leafId
            try {
              await this.handleRemoteChange(filePath, true, 'foreground')
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : String(err)
              this._app.log.error(`[Document Manager] Could not check ${filePath} against the disk: ${message}`, err)
            }
            this._updateFocusLeaf(windowId, leafId)
          }
          this._app.log.info(`[Document Manager] Not closing file ${filePath}: It could not be saved.`)
          return false
        }
      } else {
        // Don't close the file
        this._app.log.info('[Document Manager] Not closing file, as the user did not want that.')
        return false
      }

      // Remove the file
      const comparison = this._conflictChoiceSessions.get(filePath)
      if (comparison !== undefined && !await this.waitForConflictInputPreservation(comparison)) {
        openFile.lastSavedVersion--
        return false
      }
      this.documents.splice(this.documents.indexOf(openFile), 1)
      this.endConflictMerge(filePath) // Zettlr-LYH conflict merge (R47)
      await this.closeUndoHistory(openFile) // Zettlr-LYH undo history (R135)
    } else if (openFile !== undefined && numOpenInstances === 1) {
      // The file is not modified, but this is still the last instance, so we
      // can close it without having to ask. A clean document needs no backup,
      // so remove any stray one.
      const comparison = this._conflictChoiceSessions.get(filePath)
      if (comparison !== undefined && !await this.waitForConflictInputPreservation(comparison)) {
        return false
      }
      await this._backups.remove(filePath)
      // Input can arrive while the backup removal yields to the event loop.
      if (comparison !== undefined && !await this.waitForConflictInputPreservation(comparison)) {
        return false
      }
      this.documents.splice(this.documents.indexOf(openFile), 1)
      this.endConflictMerge(filePath) // Zettlr-LYH conflict merge (R47)
      await this.closeUndoHistory(openFile) // Zettlr-LYH undo history (R135)
    }

    // Zettlr-LYH reopen closed tab (R43): remember where the tab sat, so that
    // Ctrl+Shift+T can put it back there
    // Unpin only after every save/close decision has succeeded. Cancellation
    // above keeps the original pinned tab intact; reopening must stay unpinned.
    leaf.tabMan.setPinnedStatus(filePath, false)
    const closedTab = this.describeOpenTab(windowId, leafId, leaf.tabMan, filePath)
    const ret = leaf.tabMan.closeFile(filePath)
    if (ret) {
      if (closedTab !== undefined) {
        this._closedTabs.push(closedTab)
      }
      this.syncToConfig()
      this.syncWatchedFilePaths()
      this.broadcastEvent(DP_EVENTS.CLOSE_FILE, { windowId, leafId, filePath })
      this.broadcastEvent(DP_EVENTS.ACTIVE_FILE, { windowId, leafId, filePath: leaf.tabMan.activeFile?.path })
      if (leaf.tabMan.openFiles.length === 0) {
        // Remove this leaf
        leaf.parent.removeNode(leaf)
        this.broadcastEvent(DP_EVENTS.LEAF_CLOSED, { windowId, leafId })
        this.syncToConfig()
      }

      await this.synchronizeDatabases()
    }

    // Zettlr-LYH scratch notes (R40): delete or discard the scratch file only
    // now that its tab is closed and the file is no longer being watched
    if (scratchNoteCleanup !== undefined) {
      await this.cleanUpClosedScratchNote(scratchNoteCleanup, ret)
    }
    return ret
  }

  /**
   * Zettlr-LYH Windows dialog (R72): closes several files of a window at once,
   * each in every pane of the window that shows it. A file whose last tabs
   * would go while it has unsaved changes is asked about with the batch
   * question (Save, Don't Save, Cancel, Keep All, Discard All Changes):
   * Cancel keeps that file and goes on with the next one; Keep All keeps it
   * and every later file with unsaved changes, Discard All Changes closes
   * them all without saving (into the backup cache like Don't Save), without
   * asking again. A file that cannot be saved (the conflict flow takes over)
   * stays open. Pinned tabs are never closed; a file only open in pinned tabs
   * is skipped. Scratch notes keep their own close flow, file by file. With
   * a single file, the regular three-button question is asked instead, and
   * Cancel keeps the file in all its panes.
   *
   * @param   {string}    windowId   The window
   * @param   {string[]}  filePaths  The files to close, in the order to ask
   *
   * @return  {Promise<string[]>}    The given files still open in the window
   */
  public async closeFilesBatch (windowId: string, filePaths: string[]): Promise<string[]> {
    const tree = this._windows[windowId]
    const uniquePaths = [...new Set(filePaths)]
    if (tree === undefined) {
      this._app.log.error(`[Document Manager] Could not close files: Window ${windowId} not found.`)
      return uniquePaths
    }

    let mode: BatchCloseMode = 'none'
    for (const filePath of uniquePaths) {
      const leaves = tree.getAllLeafs().filter(leaf => leaf.tabMan.openFiles.some(file => file.path === filePath))
      const closableLeafIds = leaves
        .filter(leaf => leaf.tabMan.openFiles.some(file => file.path === filePath && !file.pinned))
        .map(leaf => leaf.id)
      if (closableLeafIds.length === 0) {
        continue // Not open, or only in pinned tabs
      }

      if (this.isScratchNote(filePath)) {
        for (const leafId of closableLeafIds) {
          await this.closeFile(windowId, leafId, filePath)
        }
        continue
      }

      const openFile = this.documents.find(doc => doc.filePath === filePath)
      const closesDocument = closableLeafIds.length === this.countOpenInstances(filePath)
      const fileState = {
        allTabsPinned: false,
        needsQuestion: closesDocument && openFile !== undefined && this.isModified(filePath)
      }

      // A single file gets the regular three-button question, whose buttons
      // 0 to 2 mean the same as those of the batch question
      let response: number|undefined
      if (batchCloseNeedsQuestion(mode, fileState) && openFile !== undefined) {
        const detail = trans('File: %s', openFile.descriptor.name)
        response = uniquePaths.length > 1
          ? (await this._app.windows.askSaveChangesInBatch(detail)).response
          : (await this._app.windows.askSaveChanges(detail)).response
      }
      const decision = decideBatchCloseAction(mode, fileState, response)
      mode = decision.mode

      if (decision.action === 'keep' || decision.action === 'skip') {
        this._app.log.info(`[Document Manager] Not closing file ${filePath}, as the user did not want that.`)
        continue
      }
      if (decision.action === 'save') {
        const saved = await this.saveFile(filePath)
        // Zettlr-LYH save-time conflict check (R52): the conflict flow has
        // taken over, so the file keeps its tabs
        if (!saved) {
          this._app.log.info(`[Document Manager] Not closing file ${filePath}: It could not be saved.`)
          continue
        }
      }
      const unsavedResponse = decision.action === 'discard' ? 1 : undefined
      for (const leafId of closableLeafIds) {
        await this.closeFile(windowId, leafId, filePath, unsavedResponse)
      }
    }

    const stillOpen = new Set<string>()
    for (const leaf of tree.getAllLeafs()) {
      for (const file of leaf.tabMan.openFiles) {
        stillOpen.add(file.path)
      }
    }
    return uniquePaths.filter(filePath => stillOpen.has(filePath))
  }

  /**
   * Directs every open leaf to close a given file. This function even
   * overwrites potential stati such as modification or pinned to ensure files
   * are definitely closed. This will be called from within the watcher callback
   * on an `unlink` event.
   *
   * @param   {string}  filePath  The file path in question
   */
  public async closeFileEverywhere (filePath: string): Promise<void> {
    // Zettlr-LYH reopen closed tab (R43): the closed tabs are remembered only
    // if the document carries unsaved changes, which go into the backup cache
    // below (and can then be reopened from there)
    const closedTabs = await this.closeTabsEverywhere(filePath)

    // We also must splice the document out of our provider
    const idx = this.documents.findIndex(doc => doc.filePath === filePath)
    if (idx > -1) {
      const doc = this.documents[idx]
      if (doc.currentVersion !== doc.lastSavedVersion) {
        // The document is force-closed (e.g. it was deleted on disk) while
        // carrying unsaved changes. Retain those in the backup cache as a
        // safety net -- it is the only remaining copy of the edits.
        await this._backups.persistNow(filePath, doc.document.toString())
        await this._backups.markClosed(filePath)
        for (const closedTab of closedTabs) {
          this._closedTabs.push(closedTab) // Zettlr-LYH reopen closed tab (R43)
        }
      } else {
        await this._backups.remove(filePath)
      }
      this.documents.splice(idx, 1)
      await this.closeUndoHistory(doc) // Zettlr-LYH undo history (R135)
    }

    // Zettlr-LYH conflict merge (R47): a force-closed file cannot be merged
    this.endConflictMerge(filePath)

    this.syncWatchedFilePaths()
  }

  /**
   * Closes every tab of the given file in every editor pane of every window
   * (even pinned ones), and closes panes that become empty. The document
   * itself, its backup and the closed-tab history are left alone.
   *
   * @param   {string}                      filePath  The file whose tabs to close
   *
   * @return  {Promise<ClosedTabRecord[]>}            Descriptions of the closed tabs
   */
  private async closeTabsEverywhere (filePath: string): Promise<ClosedTabRecord[]> {
    const closedTabs: ClosedTabRecord[] = []
    await this.forEachLeaf(async (tabMan, windowId, leafId) => {
      if (tabMan.openFiles.map(x => x.path).includes(filePath)) {
        const closedTab = this.describeOpenTab(windowId, leafId, tabMan, filePath)
        tabMan.setPinnedStatus(filePath, false)
        const success = tabMan.closeFile(filePath)

        if (!success) {
          return false
        }

        if (closedTab !== undefined) {
          closedTabs.push(closedTab)
        }

        this.broadcastEvent(DP_EVENTS.CLOSE_FILE, { windowId, leafId, filePath })

        if (tabMan.openFiles.length === 0) {
          this.closeLeaf(windowId, leafId)
        }
      }

      return true
    })

    return closedTabs
  }

  /**
   * For the provided root workspace directory at `filePath`,
   * retrieve a list of filepaths representing every open file
   * within the workspace.
   *
   * @param {string}      filePath  Path of the workspace directory
   *
   * @returns {string[]}            A list of file paths representing the
   *                                open files within `filePath`.
   */
  public async getOpenFilesForWorkspace (workspacePath: string): Promise<string[]> {
    const openFiles: string[] = []

    await this.forEachLeaf(async (tabMan) => {
      openFiles.push(
        ...tabMan.openFiles
          .filter(doc => doc.path.startsWith(workspacePath))
          .map(doc => doc.path)
      )

      return false
    })

    return openFiles
  }

  /**
   * Zettlr-LYH open-with disk check (R51): checks a file that is opened again
   * explicitly (Explorer's "Open with", drag and drop, a click in the file
   * manager) against the disk.
   * If the file is already loaded and its disk contents differ from the last
   * saved state, this is treated exactly like a change reported by the
   * watcher, so that a change the watcher missed (or one whose modification
   * time is not newer) is not silently ignored. A file that is not loaded yet
   * needs no check: its editor will read the current disk contents.
   *
   * @param   {string}  filePath  The file that has been opened
   */
  public async checkLoadedFileAgainstDisk (filePath: string): Promise<void> {
    if (this.documents.find(doc => doc.filePath === filePath) === undefined) {
      return
    }

    await this.handleRemoteChange(filePath, true)
  }

  /**
   * This function handles a remote change, i.e. where the watcher has reported
   * that the file has been changed remotely, or where the file is checked
   * against the disk for another reason (opening it again, saving it, turning
   * to its tab).
   *
   * Zettlr-LYH disk conflicts (R138): after reading the disk, routeRemoteChange
   * decides what happens; no dialog is shown anymore. The disk may hold the
   * last saved contents (nothing to do) or exactly the editor contents (the
   * document counts as saved). Otherwise, a document without unsaved changes
   * that is shown is reloaded automatically, a document with unsaved changes
   * in the foreground opens the comparison view, and every other document is
   * only marked to be checked again when the user turns to it. While the
   * comparison of the file is open, a new disk version only updates it.
   *
   * @param   {string}              filePath            The file in question
   * @param   {boolean}             ignoreModtime       Zettlr-LYH open-with disk check (R51):
   *                                                    compare the contents even if the file
   *                                                    on disk is not newer
   * @param   {DocumentVisibility}  visibilityOverride  Zettlr-LYH disk conflicts (R138): route
   *                                                    as if the document were this visible
   *                                                    (used when the user closes its tab)
   */
  private async handleRemoteChange (filePath: string, ignoreModtime = false, visibilityOverride?: DocumentVisibility): Promise<void> {
    const doc = this.documents.find(doc => doc.filePath === filePath)

    if (doc === undefined) {
      throw new Error(`Could not handle remote change for file ${filePath}: Could not find corresponding file!`)
    }

    // Zettlr-LYH disk conflicts (R138): the comparison of this file is open,
    // so a new disk version goes into the comparison
    const session = this._conflictChoiceSessions.get(filePath)
    if (session !== undefined && session.document === doc) {
      await this.handleDiskChangeDuringComparison(filePath, session)
      return
    }

    const metadata = await this._app.fsal.getFilesystemMetadata(filePath)
    if (!this.isCurrentConflictDocument(filePath, doc)) { return }
    const modtime = metadata.modtime
    const ourModtime = doc.descriptor.modtime

    // In response to issue #1621: We will not check for equal modtime but only
    // for newer modtime to prevent sluggish cloud synchronization services
    // (e.g. OneDrive and Box) from having text appear to "jump" from time to time.
    // Zettlr-LYH open-with disk check (R51): an explicit open always compares
    // the contents below, which is safe since equal contents are skipped.
    if (!ignoreModtime && modtime <= ourModtime) {
      return // Nothing to do
    }

    // ... however, some cloud services may still emit additional change events
    // that merely change attributes, but not the content. We handle this case
    // next
    const diskContents = await this._app.fsal.loadAnySupportedFile(doc.descriptor.path)
    if (!this.isCurrentConflictDocument(filePath, doc)) { return }

    // Zettlr-LYH disk conflicts (R138): the newest disk version has been read,
    // which is all a mark asked for; routing marks the file again if needed
    this.remoteChangeCheckPending().delete(filePath)

    // Keep remote updates out of an existing comparison, removal or restore
    if (this.hasPendingExternalDecision(filePath)) {
      return
    }

    // Zettlr-LYH data loss prevention (R173, specification C21 section 4 item
    // 3): an editor holds input the document manager has not received. To the
    // routing below the document would look unmodified, and an automatic
    // reload would discard that input. Do not route; mark the file and check
    // it again once the input had the time to arrive.
    if (this.editorHasUnconfirmedInput(filePath)) {
      this.remoteChangeCheckPending().add(filePath)
      this._app.log.info(`[Document Provider] ${filePath} was modified outside of Zettlr while an editor holds input that has not reached the document manager yet. It will be checked again shortly.`)
      this.scheduleRemoteChangeRecheck(filePath)
      return
    }

    // The disk version is read LF-normalized and without BOM, so it is
    // compared with the LF text of the editor, exactly as saveFile writes it.
    // The saved versions are compared rather than the modification marker:
    // scratch tabs also display it after their contents have been written to
    // their scratch file. All of this runs after reading the disk, so that
    // edits received during that read count as unsaved changes.
    const editorContents = [...doc.document.iterLines()].join('\n')
    const route = routeRemoteChange({
      diskContents,
      lastSavedContent: doc.lastSavedContent,
      editorContents,
      hasUnsavedChanges: doc.currentVersion !== doc.lastSavedVersion,
      visibility: visibilityOverride ?? this.documentVisibility(filePath)
    })

    switch (route) {
      case 'ignore':
        return
      case 'accept-equal':
        // Zettlr-LYH remote change dialog (R122): another program saved the
        // same text, or the unsaved changes equal what has just been written
        await this.acceptDiskVersionEqualToEditor(doc, diskContents)
        return
      case 'auto-reload':
        await this.reloadFromDiskAutomatically(filePath, doc)
        return
      case 'compare':
        this.openConflictComparison(filePath, doc, diskContents, editorContents, metadata)
        return
      case 'defer':
        this.remoteChangeCheckPending().add(filePath)
        this._app.log.info(`[Document Provider] ${filePath} was modified outside of Zettlr while it is not in front of the user. It will be checked again when the user turns to it.`)
    }
  }

  /**
   * Zettlr-LYH disk conflicts (R138): loads the disk version of a document
   * without unsaved changes into every editor and tells each pane that shows
   * it as its active tab, so that the pane can show a notice. The reload is
   * given up if a local edit arrives while the old backup is being removed;
   * the document then has unsaved changes and is routed again.
   *
   * @param   {string}    filePath  The changed file
   * @param   {Document}  doc       Its document, without unsaved changes
   */
  private async reloadFromDiskAutomatically (filePath: string, doc: Document): Promise<void> {
    if (await this.notifyRemoteChange(filePath, doc, doc.currentVersion)) {
      this._app.log.info(`[Document Provider] ${filePath} was modified outside of Zettlr and had no unsaved changes; reloaded it from disk.`)
      this.broadcastReloadedFromDisk(filePath)
      return
    }

    if (this.isCurrentConflictDocument(filePath, doc) && !this.hasPendingExternalDecision(filePath)) {
      // Editing resumed during the reload: read the latest disk version and
      // route it again (comparison in the foreground, a mark otherwise)
      await this.handleRemoteChange(filePath, true)
    }
  }

  /**
   * Zettlr-LYH disk conflicts (R138): broadcasts FILE_RELOADED_FROM_DISK once
   * for every pane whose active tab is the given file.
   *
   * @param   {string}  filePath  The file that has been reloaded from disk
   */
  private broadcastReloadedFromDisk (filePath: string): void {
    for (const windowId in this._windows) {
      for (const leaf of this._windows[windowId].getAllLeafs()) {
        if (leaf.tabMan.activeFile?.path === filePath) {
          this.broadcastEvent(DP_EVENTS.FILE_RELOADED_FROM_DISK, { filePath, windowId, leafId: leaf.id })
        }
      }
    }
  }

  /**
   * Zettlr-LYH disk conflicts (R138): opens the comparison view for a document
   * whose editor and disk versions have both changed, without any dialog. Both
   * save guards are set until the comparison ends, and a pending autosave is
   * cancelled, so that nothing overwrites the disk version meanwhile.
   *
   * @param   {string}    filePath        The conflicted file
   * @param   {Document}  doc             Its document
   * @param   {string}    diskContents    The disk version just read (LF, no BOM)
   * @param   {string}    editorContents  The editor contents now (LF, no BOM)
   * @param   {Object}    metadata        Modification time and byte size of the disk version
   */
  private openConflictComparison (
    filePath: string,
    doc: Document,
    diskContents: string,
    editorContents: string,
    metadata: { modtime: number|undefined, size: number|undefined }
  ): void {
    if (this.hasPendingExternalDecision(filePath)) { return }
    const target = this.findConflictTarget(filePath)
    if (target === undefined) { return }

    const session: ConflictChoiceSession = {
      document: doc,
      target,
      sessionId: uuid4(),
      phase: 'merge',
      diskBaseline: diskContents,
      editorSnapshot: editorContents,
      diskModifiedAt: metadata.modtime,
      diskSize: metadata.size
    }
    this._remoteChangeDialogShownFor.push(filePath)
    this._conflictMergePendingFor.add(filePath)
    this._conflictChoiceSessions.set(filePath, session)
    this.remoteChangeCheckPending().delete(filePath)

    // A pending autosave would overwrite the (newer) disk contents while the
    // comparison is open, silently destroying the very changes the user is
    // comparing. Suspend it; pushUpdates will not re-arm it while the file is
    // registered in _remoteChangeDialogShownFor.
    clearTimeout(doc.saveTimeout)
    doc.saveTimeout = undefined

    this._app.log.info(`[Document Provider] ${filePath} was modified outside of Zettlr while the editor holds unsaved changes. Opening the comparison view.`)
    this.publishConflictReadOnlyState(DP_EVENTS.FILE_CONFLICT_MERGE, filePath, session)
  }

  /**
   * Zettlr-LYH disk conflicts (R138): reads the disk while the comparison of
   * the file is open. A disk version that differs from the one the comparison
   * shows becomes its new disk version, and the comparison view is told.
   *
   * @param   {string}                 filePath  The compared file
   * @param   {ConflictChoiceSession}  session   Its comparison
   */
  private async handleDiskChangeDuringComparison (filePath: string, session: ConflictChoiceSession): Promise<void> {
    const doc = session.document
    let metadata: { modtime: number|undefined, size: number|undefined }
    let diskContents: string
    try {
      metadata = await this._app.fsal.getFilesystemMetadata(filePath)
      diskContents = await this._app.fsal.loadAnySupportedFile(doc.descriptor.path)
    } catch (err: unknown) {
      // A removed file goes through the removal handling of the watcher
      const message = err instanceof Error ? err.message : String(err)
      this._app.log.warning(`[Document Provider] Could not read ${filePath} while it is being compared: ${message}`)
      return
    }

    if (this._conflictChoiceSessions.get(filePath) !== session || !this.isCurrentConflictDocument(filePath, doc)) {
      return
    }

    this.updateConflictDiskBaseline(filePath, session, diskContents, metadata)
  }

  /**
   * Zettlr-LYH disk conflicts (R138): makes the given disk version the one the
   * comparison shows, if it differs, and broadcasts FILE_CONFLICT_DISK_CHANGED
   * so that the comparison view fetches it.
   *
   * @param   {string}                 filePath      The compared file
   * @param   {ConflictChoiceSession}  session       Its comparison
   * @param   {string}                 diskContents  The disk version just read (LF, no BOM)
   * @param   {Object}                 metadata      Its modification time and byte size
   *
   * @return  {boolean}                              True if the disk version has changed
   */
  private updateConflictDiskBaseline (
    filePath: string,
    session: ConflictChoiceSession,
    diskContents: string,
    metadata: { modtime: number|undefined, size: number|undefined }
  ): boolean {
    if (diskContents === session.diskBaseline) {
      return false
    }

    session.diskBaseline = diskContents
    session.diskModifiedAt = metadata.modtime
    session.diskSize = metadata.size
    this._app.log.info(`[Document Provider] ${filePath} was modified outside of Zettlr again while it is being compared.`)
    this.broadcastEvent(DP_EVENTS.FILE_CONFLICT_DISK_CHANGED, { filePath, sessionId: session.sessionId })
    return true
  }

  /** Rechecks the same authority object and full path after every asynchronous step. */
  private isCurrentConflictDocument (filePath: string, document: Document): boolean {
    return document.filePath === filePath && document.descriptor.path === filePath &&
      this.documents.includes(document) && this.isOpenInAnyLeaf(filePath)
  }

  /** Keeps remote updates out of an existing comparison, removal or restore. */
  private hasPendingExternalDecision (filePath: string): boolean {
    return this._remoteChangeDialogShownFor.includes(filePath) ||
      this._conflictChoiceSessions.has(filePath) || this._conflictMergePendingFor.has(filePath) ||
      this._externalRemoval?.pendingRemovals.has(filePath) === true || this._pendingDocumentLoads.has(filePath)
  }

  /** Prefers the original pane, then its window, then a stable existing window. */
  private findConflictTarget (filePath: string, preferred = this._lastEditor): { windowId: string, leafId: string }|undefined {
    const windowIds = Object.keys(this._windows).sort()
    if (preferred.windowId !== undefined && windowIds.includes(preferred.windowId)) {
      windowIds.splice(windowIds.indexOf(preferred.windowId), 1)
      windowIds.unshift(preferred.windowId)
    }
    for (const windowId of windowIds) {
      const leafs = this._windows[windowId].getAllLeafs()
      const original = windowId === preferred.windowId ? leafs.find(leaf => leaf.id === preferred.leafId) : undefined
      const candidates = original === undefined ? leafs : [ original, ...leafs.filter(leaf => leaf !== original) ]
      const leaf = candidates.find(leaf => leaf.tabMan.openFiles.some(file => file.path === filePath))
      if (leaf !== undefined) { return { windowId, leafId: leaf.id } }
    }
    return undefined
  }

  /** Selects an existing tab without opening a file or checking its disk version. */
  private activateConflictTarget (filePath: string, preferred: { windowId: string, leafId: string }): { windowId: string, leafId: string }|undefined {
    const target = this.findConflictTarget(filePath, preferred)
    if (target !== undefined) {
      const leaf = this._windows[target.windowId].findLeaf(target.leafId)
      if (leaf === undefined) { return undefined }
      leaf.tabMan.activeFile = filePath
      this._updateFocusLeaf(target.windowId, target.leafId)
    }
    return target
  }

  /**
   * Zettlr-LYH remote change dialog (R122): treats the document as saved because
   * the file on disk now holds exactly the editor contents. The last saved
   * contents become the disk version, the modified status is cleared and all
   * windows are told, so that the tab no longer shows the "* ". Nothing is
   * written to disk and no dialog is shown.
   *
   * @param   {Document}       doc           The document whose editor contents equal the disk version
   * @param   {string}         diskContents  The disk version (LF-normalized, without BOM)
   */
  private async acceptDiskVersionEqualToEditor (doc: Document, diskContents: string): Promise<void> {
    // A pending autosave would only write the same text again
    clearTimeout(doc.saveTimeout)
    doc.saveTimeout = undefined

    doc.lastSavedVersion = doc.currentVersion
    doc.lastSavedContent = diskContents
    // Zettlr-LYH external removal (R121): the other program may have written a
    // new file in place of the old one (for example by an atomic save), so the
    // file identity is read again
    this.refreshFileIdentity(doc).catch(() => undefined)
    this._app.log.info(`[Document Provider] ${doc.filePath} was modified outside of Zettlr, but the new contents equal the editor contents. Marking the document as saved.`)
    this.broadcastEvent(DP_EVENTS.CHANGE_FILE_STATUS, { filePath: doc.filePath, status: 'modification' })

    // Like saveFile: the backup of the unsaved editing state has served its
    // purpose, since the source file now holds the same contents
    await this._backups.remove(doc.filePath)
    this._tabLimit?.failed.delete(doc.filePath)
    this.scheduleTabLimitForPath(doc.filePath)
  }

  /**
   * Zettlr-LYH conflict merge (R47): removes the given file from the list of
   * files with an open comparison. Does nothing if the file is not registered,
   * instead of removing an unrelated entry.
   *
   * @param   {string}  filePath  The file in question
   */
  private removeRemoteChangeDialogEntry (filePath: string): void {
    const index = this._remoteChangeDialogShownFor.indexOf(filePath)
    if (index > -1) {
      this._remoteChangeDialogShownFor.splice(index, 1)
    }
  }

  /**
   * Zettlr-LYH conflict merge (R47): ends the pending comparison of the given
   * file, if any, so that autosave and the conflict handling work again.
   * Called after a successful commit and by every path that drops the
   * document (closing it, moving it), so that no comparison stays pending
   * forever.
   *
   * @param   {string}  filePath  The file in question
   */
  private endConflictMerge (filePath: string, sessionId?: string): void {
    if (sessionId !== undefined && this._conflictChoiceSessions.get(filePath)?.sessionId !== sessionId) {
      return
    }
    const session = this._conflictChoiceSessions.get(filePath)
    this._conflictChoiceSessions.delete(filePath)
    this._conflictMergePendingFor.delete(filePath)
    this.removeRemoteChangeDialogEntry(filePath)
    if (session !== undefined) {
      this.publishConflictReadOnlyState(DP_EVENTS.FILE_CONFLICT_MERGE_ENDED, filePath, session)
    }
  }

  private conflictReadOnlySnapshot (): ConflictReadOnlySnapshot {
    return {
      revision: this._conflictReadOnlyRevision ?? 0,
      sessions: [...(this._conflictChoiceSessions ?? [])].map(([ filePath, session ]) => ({
        filePath, sessionId: session.sessionId, ...session.target
      }))
    }
  }

  /** Pane replacement cannot end a session; genuine tab/window closure can. */
  private followConflictMergeTargets (): void {
    for (const [ filePath, session ] of this._conflictChoiceSessions ?? []) {
      if (!this.isCurrentConflictDocument(filePath, session.document)) {
        this.endConflictMerge(filePath, session.sessionId)
        continue
      }
      const target = this.findConflictTarget(filePath, session.target)
      if (target === undefined) {
        this.endConflictMerge(filePath, session.sessionId)
      } else if (target.windowId !== session.target.windowId || target.leafId !== session.target.leafId) {
        session.target = target
        this.publishConflictReadOnlyState(DP_EVENTS.FILE_CONFLICT_MERGE, filePath, session)
      }
    }
  }

  /** Wait for every preservation already queued, including work added while waiting. */
  private async waitForConflictInputPreservation (session: ConflictChoiceSession): Promise<boolean> {
    const state = session.preservedUpdates
    if (state === undefined) { return true }
    let pending: Promise<boolean>
    do {
      pending = state.pending
      await pending
    } while (pending !== state.pending)
    return state.failures.size === 0
  }

  private publishConflictReadOnlyState (event: DP_EVENTS, filePath: string, session: ConflictChoiceSession): void {
    this._conflictReadOnlyRevision = (this._conflictReadOnlyRevision ?? 0) + 1
    this.broadcastEvent(event, { filePath, sessionId: session.sessionId, ...session.target, conflictState: this.conflictReadOnlySnapshot() })
  }

  /**
   * Zettlr-LYH conflict merge (R47): keeps the editor contents after a
   * comparison had to end without a result: the file stays marked as
   * modified.
   *
   * @param   {Document}  doc  The conflicted document
   */
  private keepEditorContentsAfterConflictMerge (doc: Document): void {
    doc.lastSavedVersion--
    this.broadcastEvent(DP_EVENTS.CHANGE_FILE_STATUS, { filePath: doc.filePath, status: 'modification' })
  }

  /**
   * Zettlr-LYH disk conflicts (R138): returns both versions shown by the
   * current comparison of a file: the disk version the comparison holds (it
   * follows later changes on disk) and the editor contents when the
   * comparison opened, with the modification time and the byte size of each.
   * Times and sizes that are not known are left out; the editor size is the
   * UTF-8 byte count of the editor version serialized as a save would write it.
   *
   * @param   {string}  filePath   The conflicted file
   * @param   {string}  sessionId  The identifier of the comparison
   * @param   {string}  windowId   The window asking (only the target window may)
   *
   * @return  {ConflictMergeContents|undefined}  Both versions, or undefined if the comparison is not current
   */
  private getConflictMergeContents (filePath: string, sessionId: string, windowId?: string): ConflictMergeContents|undefined {
    const session = this.currentConflictMerge(filePath, sessionId, windowId, true)
    if (session === undefined) { return undefined }
    const doc = session.document

    const contents: ConflictMergeContents = {
      sessionId: session.sessionId,
      diskContents: session.diskBaseline,
      editorContents: session.editorSnapshot
    }
    if (isKnownTimestamp(session.diskModifiedAt)) {
      contents.diskModifiedAt = session.diskModifiedAt
    }
    if (isKnownByteSize(session.diskSize)) {
      contents.diskSize = session.diskSize
    }
    if (isKnownTimestamp(doc.lastEditedAt)) {
      contents.editorEditedAt = doc.lastEditedAt
    }
    contents.editorSize = Buffer.byteLength(this.serializeContentsForDisk(doc, session.editorSnapshot), 'utf-8')
    return contents
  }

  /**
   * Rejects old comparisons, duplicate submissions and responses from other
   * windows. A comparison that is being committed counts as current only if
   * allowSubmitting is true (reading its versions is harmless).
   */
  private currentConflictMerge (filePath: string, sessionId: string, windowId?: string, allowSubmitting = false): ConflictChoiceSession|undefined {
    const session = this._conflictChoiceSessions.get(filePath)
    if (session?.sessionId === sessionId && !this.isCurrentConflictDocument(filePath, session.document)) {
      this.endConflictMerge(filePath, sessionId)
      return undefined
    }
    if (session === undefined || session.sessionId !== sessionId ||
      (session.phase !== 'merge' && !(allowSubmitting && session.phase === 'submitting')) ||
      (windowId !== undefined && session.target.windowId !== windowId) ||
      !this._conflictMergePendingFor.has(filePath) || !this.isCurrentConflictDocument(filePath, session.document)) {
      return undefined
    }
    return session
  }

  private async sourceFileExistsForConflict (filePath: string, session: ConflictChoiceSession): Promise<boolean> {
    if (isFile(filePath)) { return true }
    if (this._conflictChoiceSessions.get(filePath) === session && this.isCurrentConflictDocument(filePath, session.document)) {
      await this.closeFileEverywhere(filePath)
    }
    return false
  }

  /**
   * Zettlr-LYH disk conflicts (R138): commits the outcome chosen in the
   * comparison view. The left pane shows the disk version, the right pane the
   * editor version; both may have been edited.
   * - 'keep-left' writes the left pane to the file,
   * - 'keep-right' writes the right pane to the file,
   * - 'save-both' writes the left pane to the file and the right pane to a
   *   copy next to it, which opens in a new tab after the original one.
   *
   * Nothing is written unless the comparison is still current, the file still
   * exists and still holds the disk version the comparison shows. Unsaved
   * editor contents that none of the written files holds are first backed up
   * into a conflict backup file (R49). Any failure leaves the file, the editor
   * contents and the last saved contents alone and keeps the comparison open.
   * After success, every editor reloads the file from disk, the comparison
   * ends and the original tab is activated.
   *
   * @param   {string}               filePath       The conflicted file
   * @param   {string}               sessionId      The identifier of the comparison
   * @param   {ConflictMergeChoice}  choice         The chosen outcome
   * @param   {string}               leftContents   The current contents of the left pane
   * @param   {string}               rightContents  The current contents of the right pane
   * @param   {string}               windowId       The window committing (only the target window may)
   *
   * @return  {Promise<ConflictMergeCommitResult>}  Whether the outcome has been applied, and why not
   */
  private async commitConflictMerge (
    filePath: string,
    sessionId: string,
    choice: ConflictMergeChoice,
    leftContents: string,
    rightContents: string,
    windowId?: string
  ): Promise<ConflictMergeCommitResult> {
    const stale: ConflictMergeCommitResult = { ok: false, reason: 'stale' }

    // 1. Only the current comparison, from its own window, can be committed
    const session = this.currentConflictMerge(filePath, sessionId, windowId)
    if (session === undefined) { return stale }
    const validChoices: ConflictMergeChoice[] = [ 'keep-left', 'keep-right', 'save-both' ]
    if (!validChoices.includes(choice) || typeof leftContents !== 'string' || typeof rightContents !== 'string') {
      return { ok: false, reason: 'write-failed', message: 'The comparison view sent an incomplete result' }
    }

    const doc = session.document
    const isCurrent = (): boolean => this._conflictChoiceSessions.get(filePath) === session && this.isCurrentConflictDocument(filePath, doc)
    const errorMessage = (err: unknown): string => err instanceof Error ? err.message : String(err)
    session.phase = 'submitting'
    let committed = false

    try {
      if (!await this.waitForConflictInputPreservation(session)) {
        return { ok: false, reason: 'backup-failed', message: 'Input received while the comparison opened could not be backed up. Please retry.' }
      }
      // 2. A vanished file goes through the removal handling instead of being
      // recreated at its old path
      if (!(await this.sourceFileExistsForConflict(filePath, session))) {
        return { ok: false, reason: 'missing' }
      }
      if (!isCurrent()) { return stale }

      // 3. The file must still hold the disk version the user has compared
      let metadata: { modtime: number|undefined, size: number|undefined }
      let diskContents: string
      try {
        metadata = await this._app.fsal.getFilesystemMetadata(filePath)
        diskContents = await this._app.fsal.loadAnySupportedFile(doc.descriptor.path)
      } catch (err: unknown) {
        if (!isCurrent()) { return stale }
        if (!(await this.sourceFileExistsForConflict(filePath, session))) {
          return { ok: false, reason: 'missing' }
        }
        this._app.log.error(`[Document Provider] Could not read ${filePath} before committing the comparison: ${errorMessage(err)}`, err)
        return { ok: false, reason: 'write-failed', message: `Could not read the file on disk: ${errorMessage(err)}` }
      }
      if (!isCurrent()) { return stale }
      if (this.updateConflictDiskBaseline(filePath, session, diskContents, metadata)) {
        return { ok: false, reason: 'disk-changed' }
      }
      const comparedDiskVersion = session.diskBaseline

      // 4. What ends up where, normalized like a loaded file (LF, no BOM) so
      // that serializing re-applies the original BOM and linefeeds like a save
      const originalContents = normalizeLoadedText(choice === 'keep-right' ? rightContents : leftContents)
      const copyContents = choice === 'save-both' ? normalizeLoadedText(rightContents) : undefined

      // 5. Unsaved editor contents that no written file holds are backed up.
      // They are compared in the same normalized form as the contents above,
      // so that a BOM character at the start cannot make equal text differ.
      const editorContents = normalizeLoadedText([...doc.document.iterLines()].join('\n'))
      if (doc.currentVersion !== doc.lastSavedVersion && originalContents !== editorContents && copyContents !== editorContents) {
        try {
          const backupPath = await this.writeEditorBackupFile(doc)
          this._app.log.info(`[Document Provider] Editor contents of ${filePath} backed up to ${backupPath} before committing the comparison.`)
        } catch (err: unknown) {
          this._app.log.error(`[Document Provider] Could not back up the editor contents of ${filePath}: ${errorMessage(err)}`, err)
          return { ok: false, reason: 'backup-failed', message: errorMessage(err) }
        }
        if (!isCurrent()) { return stale }
      }

      // 6. Save Both writes the copy first
      let copyPath: string|undefined
      if (copyContents !== undefined) {
        copyPath = this.conflictSiblingPath(filePath, 'Copy')
        this.registerInternalFileOperation([copyPath])
        try {
          await this._app.fsal.writeTextFile(copyPath, this.serializeContentsForDisk(doc, copyContents))
        } catch (err: unknown) {
          this._app.log.error(`[Document Provider] Could not write the conflict copy ${copyPath}: ${errorMessage(err)}`, err)
          return { ok: false, reason: 'copy-failed', message: errorMessage(err) }
        }
        this._app.log.info(`[Document Provider] Saved the right version of the comparison of ${filePath} as ${copyPath}.`)
        if (!isCurrent()) { return stale }
      }

      // The disk may have changed again while backing up or writing the copy
      if (session.diskBaseline !== comparedDiskVersion) {
        return { ok: false, reason: 'disk-changed' }
      }
      if (!await this.waitForConflictInputPreservation(session)) {
        return copyPath === undefined
          ? { ok: false, reason: 'backup-failed', message: 'Input received during the comparison could not be backed up. Please retry.' }
          : { ok: false, reason: 'write-failed', message: `The comparison copy was saved as ${copyPath}, but late editor input could not be backed up. The original file was not changed. Please retry` }
      }
      if (!isCurrent()) { return stale }

      // 7. The file itself is written only if its contents change
      if (originalContents !== comparedDiskVersion) {
        // Like saveFile: our own write must not be reported back as a remote change
        this._ignoreChanges.push(filePath)
        try {
          await this._app.fsal.writeTextFile(doc.descriptor.path, this.serializeContentsForDisk(doc, originalContents))
        } catch (err: unknown) {
          // Nothing was saved, so no change event is to be expected; drop the
          // ignore entry again so it cannot swallow a later genuine change.
          const ignoreIndex = this._ignoreChanges.indexOf(filePath)
          if (ignoreIndex > -1) {
            this._ignoreChanges.splice(ignoreIndex, 1)
          }
          this._app.log.error(`[Document Provider] Could not write the result of the comparison to ${filePath}: ${errorMessage(err)}`, err)
          const message = copyPath === undefined
            ? errorMessage(err)
            : `${errorMessage(err)} (the copy was saved as ${copyPath})`
          return { ok: false, reason: 'write-failed', message }
        }
      }
      const appliedResultMessage = originalContents !== comparedDiskVersion
        ? 'The selected result has already been written to the original file.'
        : 'The original file already contains the selected result.'
      const copyResultMessage = copyPath === undefined ? '' : ` The comparison copy was saved as ${copyPath}.`
      // Late updates queued during the file write must finish before reload can
      // retire the original document. Failed writes leave their client pending.
      if (!await this.waitForConflictInputPreservation(session)) {
        return { ok: false, reason: 'write-failed', message: `${appliedResultMessage}${copyResultMessage} Late editor input could not be backed up, so the editors have not been reloaded. Please retry` }
      }
      committed = true
      this._app.log.info(`[Document Provider] Committed the comparison of ${filePath} (${choice}); reloading it in all editors.`)

      // 8. The comparison stays registered until the document has been
      // removed from the authority, so that a change event racing the reload
      // cannot open another comparison for the outdated document.
      let reloaded = false
      try {
        if (isCurrent()) { reloaded = await this.notifyRemoteChange(filePath, doc, undefined, 'comparison') }
      } catch (error: unknown) {
        committed = false
        return { ok: false, reason: 'write-failed', message: `${appliedResultMessage}${copyResultMessage} The editors could not be reloaded: ${errorMessage(error)}` }
      }
      if (reloaded) {
        if (copyPath !== undefined) {
          this.openConflictCopyBesideOriginal(filePath, copyPath, session.target)
        }
        this.activateConflictTarget(filePath, session.target)
      } else if (isCurrent()) {
        committed = false
        return { ok: false, reason: 'write-failed', message: `${appliedResultMessage}${copyResultMessage} Late editor input could not be backed up, so the editors have not been reloaded. Please retry` }
      }
      this.endConflictMerge(filePath, sessionId)
      return { ok: true }
    } finally {
      if (!committed && isCurrent()) {
        session.phase = 'merge'
      }
    }
  }

  /**
   * Zettlr-LYH disk conflicts (R138): opens the copy written by Save Both in a
   * new tab right after the tab of the original file, without making it the
   * active tab.
   *
   * @param   {string}  filePath   The original file
   * @param   {string}  copyPath   The copy
   * @param   {Object}  preferred  The pane of the comparison
   */
  private openConflictCopyBesideOriginal (filePath: string, copyPath: string, preferred: { windowId: string, leafId: string }): void {
    const target = this.findConflictTarget(filePath, preferred)
    if (target === undefined) { return }
    const leaf = this._windows[target.windowId].findLeaf(target.leafId)
    if (leaf === undefined) { return }

    const activePath = leaf.tabMan.activeFile?.path
    if (!leaf.tabMan.openFile(copyPath, false)) { return }
    if (activePath !== undefined) {
      leaf.tabMan.activeFile = activePath
    }
    const order = leaf.tabMan.openFiles.map(file => file.path).filter(openPath => openPath !== copyPath)
    order.splice(order.indexOf(filePath) + 1, 0, copyPath)
    leaf.tabMan.sortOpenFiles(order)

    this.broadcastEvent(DP_EVENTS.OPEN_FILE, { windowId: target.windowId, leafId: target.leafId, filePath: copyPath })
    this.broadcastEvent(DP_EVENTS.FILES_SORTED, { windowId: target.windowId, leafId: target.leafId })
    this.syncWatchedFilePaths()
    this.syncToConfig()
  }

  /**
   * Zettlr-LYH conflict backup (R49) and disk conflicts (R138): returns a free
   * path next to the given file for a conflict backup or a conflict copy,
   * named <name>_Zettlr_Conflict_<kind>_<yyyymmdd-hhmmss><extension>, with
   * _2, _3, ... appended if that file exists already. The name tells a user
   * who has never seen the comparison which program created the file and why.
   *
   * @param   {string}            filePath  The original file
   * @param   {'Backup'|'Copy'}   kind      Which file is about to be written
   *
   * @return  {string}                      The absolute path of the new file
   */
  private conflictSiblingPath (filePath: string, kind: 'Backup'|'Copy'): string {
    const reserved = this._conflictSiblingPaths ??= new Set<string>()
    const now = new Date()
    const pad = (value: number): string => String(value).padStart(2, '0')
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    const extension = path.extname(filePath)
    const base = path.basename(filePath, extension)
    const directory = path.dirname(filePath)

    let siblingPath = path.join(directory, `${base}_Zettlr_Conflict_${kind}_${stamp}${extension}`)
    let counter = 2
    while (isFile(siblingPath) || reserved.has(siblingPath)) {
      siblingPath = path.join(directory, `${base}_Zettlr_Conflict_${kind}_${stamp}_${counter}${extension}`)
      counter++
    }
    reserved.add(siblingPath)
    return siblingPath
  }

  // ZETTLR-LYH DISK CONFLICTS (R138): WHEN OPEN FILES ARE CHECKED AGAINST THE DISK
  //
  // A change on disk is handled right away only for a document in front of the
  // user. A document in the background, or one with unsaved changes that is not
  // the foreground document, is only marked (no dialog, no comparison, no tab
  // switch, no window focus). Its active tab is checked when the user switches
  // to a tab, focuses a pane (both broadcast ACTIVE_FILE) or focuses a window.

  /**
   * Returns the files marked to be checked against the disk, creating the set
   * on first use: the main-process tests build the document manager without
   * its constructor.
   *
   * @return  {Set<string>}  The full paths of the marked files
   */
  private remoteChangeCheckPending (): Set<string> {
    if (this._remoteChangeCheckPendingFor === undefined) {
      this._remoteChangeCheckPendingFor = new Set()
    }
    return this._remoteChangeCheckPendingFor
  }

  /**
   * Returns the running checks against the disk, creating the map on first use.
   *
   * @return  {Map<string, RemoteChangeCheckInFlight>}  The running checks by full path
   */
  private remoteChangeChecksInFlight (): Map<string, RemoteChangeCheckInFlight> {
    if (this._remoteChangeChecksInFlight === undefined) {
      this._remoteChangeChecksInFlight = new Map()
    }
    return this._remoteChangeChecksInFlight
  }

  /**
   * Returns the pane focused last in each window, creating the map on first use.
   *
   * @return  {Map<string, string>}  Pane IDs by window ID
   */
  private focusedLeafByWindow (): Map<string, string> {
    if (this._focusedLeafByWindow === undefined) {
      this._focusedLeafByWindow = new Map()
    }
    return this._focusedLeafByWindow
  }

  /**
   * Returns the main window that shows the given window of the document
   * manager. The main-process tests replace this method with a double.
   *
   * @param   {string}                    windowId  The window key
   *
   * @return  {BrowserWindow|undefined}             The main window, if it exists
   */
  private mainWindowFor (windowId: string): BrowserWindow|undefined {
    return BrowserWindow.getAllWindows().find(window => {
      return !window.isDestroyed() && this._app.windows.getMainWindowKey(window) === windowId
    })
  }

  /**
   * Determines how prominently a file is shown right now: the foreground
   * document is the active tab of the focused pane (_lastEditor) in a focused
   * window; a visible document is the active tab of any pane in a window that
   * is neither minimized nor hidden; everything else is in the background.
   *
   * @param   {string}              filePath  The file in question
   *
   * @return  {DocumentVisibility}            Its visibility
   */
  private documentVisibility (filePath: string): DocumentVisibility {
    const occurrences: Parameters<typeof visibilityOf>[0] = []
    for (const windowId in this._windows) {
      const leaves = this._windows[windowId].getAllLeafs().filter(leaf => leaf.tabMan.openFiles.some(file => file.path === filePath))
      if (leaves.length === 0) {
        continue
      }
      const window = this.mainWindowFor(windowId)
      const windowFocused = window?.isFocused() === true
      const windowMinimized = window === undefined || window.isMinimized() || !window.isVisible()
      for (const leaf of leaves) {
        occurrences.push({
          windowFocused,
          windowMinimized,
          isFocusedLeaf: this._lastEditor.windowId === windowId && this._lastEditor.leafId === leaf.id,
          isActiveTab: leaf.tabMan.activeFile?.path === filePath
        })
      }
    }
    return visibilityOf(occurrences)
  }

  /**
   * Checks the active tab of the given pane against the disk. Called after
   * every ACTIVE_FILE broadcast, which covers switching tabs, the focus-leaf
   * command and opening files.
   *
   * @param   {string}  windowId  The window
   * @param   {string}  leafId    The pane
   */
  private checkActiveTabOfPane (windowId: string, leafId: string): void {
    const filePath = this._windows[windowId]?.findLeaf(leafId)?.tabMan.activeFile?.path
    if (filePath !== undefined) {
      this.startRemoteChangeCheck(filePath, false)
    }
  }

  /**
   * Checks the documents of a main window that has gained the focus: the
   * active tab of its focused pane, and the active tabs of its other panes
   * that have no unsaved changes. The pane focused last in this window
   * becomes the focused pane of the app, as the user is working there now.
   *
   * @param   {string}  windowId  The window that has gained the focus
   */
  private checkRemoteChangesOnWindowFocus (windowId: string): void {
    const tree = this._windows[windowId]
    if (tree === undefined) {
      return
    }
    const leaves = tree.getAllLeafs()
    if (leaves.length === 0) {
      return
    }

    const rememberedLeafId = this._lastEditor.windowId === windowId
      ? this._lastEditor.leafId
      : this.focusedLeafByWindow().get(windowId)
    const focusedLeaf = leaves.find(leaf => leaf.id === rememberedLeafId) ?? leaves[0]
    this._lastEditor.windowId = windowId
    this._lastEditor.leafId = focusedLeaf.id
    this.focusedLeafByWindow().set(windowId, focusedLeaf.id)

    for (const leaf of leaves) {
      const filePath = leaf.tabMan.activeFile?.path
      if (filePath === undefined) {
        continue
      }
      if (leaf !== focusedLeaf) {
        const doc = this.documents.find(doc => doc.filePath === filePath)
        if (doc === undefined || doc.currentVersion !== doc.lastSavedVersion) {
          continue
        }
      }
      this.startRemoteChangeCheck(filePath, false)
    }
  }

  /**
   * Starts a check of the given file against the disk and logs its errors.
   *
   * @param   {string}   filePath     The file to check
   * @param   {boolean}  fromWatcher  True if the watcher has reported a change of the file
   */
  private startRemoteChangeCheck (filePath: string, fromWatcher: boolean): void {
    this.runRemoteChangeCheck(filePath, fromWatcher).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      this._app.log.error(`[Document Provider] Could not check ${filePath} against the disk: ${message}`, err)
    })
  }

  /**
   * Checks a loaded file against the disk, unless it is not in front of the
   * user: a document in the background, or one with unsaved changes that is
   * not the foreground document, is only marked if the watcher reported the
   * change, and is left alone otherwise. A marked file is compared by its
   * contents right away; an unmarked file only if its modification time is
   * newer, which catches changes the watcher has missed. One file is checked
   * once at a time; if the watcher reports it again, or another trigger asks
   * for it while the check runs, it is checked once more afterwards as long as
   * it is marked and not in the background.
   *
   * @param   {string}   filePath     The file to check
   * @param   {boolean}  fromWatcher  True if the watcher has reported a change of the file
   */
  private async runRemoteChangeCheck (filePath: string, fromWatcher: boolean): Promise<void> {
    const doc = this.documents.find(doc => doc.filePath === filePath)
    if (doc === undefined) {
      return // Not loaded: its editor will read the current disk contents
    }
    if (this.hasPendingExternalDecision(filePath)) {
      return
    }

    const pending = this.remoteChangeCheckPending()
    const running = this.remoteChangeChecksInFlight().get(filePath)
    if (running !== undefined) {
      if (fromWatcher) {
        running.changedDuringCheck = true
        pending.add(filePath)
      } else {
        running.requestedDuringCheck = true
      }
      return
    }

    const visibility = this.documentVisibility(filePath)
    const hasUnsavedChanges = doc.currentVersion !== doc.lastSavedVersion
    if (visibility === 'background' || (hasUnsavedChanges && visibility !== 'foreground')) {
      if (fromWatcher) {
        pending.add(filePath)
        this._app.log.info(`[Document Provider] ${filePath} changed on disk while it is not in front of the user. It will be checked when the user turns to it.`)
      }
      return
    }

    const state: RemoteChangeCheckInFlight = { changedDuringCheck: false, requestedDuringCheck: false }
    this.remoteChangeChecksInFlight().set(filePath, state)
    try {
      await this.handleRemoteChange(filePath, pending.has(filePath))
    } finally {
      this.remoteChangeChecksInFlight().delete(filePath)
      this.scheduleTabLimitForPath(filePath)
    }

    if ((state.changedDuringCheck || state.requestedDuringCheck) && pending.has(filePath) &&
      this.documentVisibility(filePath) !== 'background') {
      await this.runRemoteChangeCheck(filePath, false)
    }
  }

  /**
   * Writes the current (unsaved) editor contents of the given document to a
   * timestamped backup file next to the original, so that the editing state
   * survives a subsequent reload of the file from disk.
   *
   * @param   {Document}         doc  The document whose contents to back up
   *
   * @return  {Promise<string>}       The absolute path of the backup file
   */
  private async writeEditorBackupFile (doc: Document): Promise<string> {
    // The file name must tell a user who has never seen the comparison which
    // program created the file and why (R49), so it carries the program name
    // and the word "Conflict" rather than a bare "Backup".
    const backupPath = this.conflictSiblingPath(doc.filePath, 'Backup')
    await this._app.fsal.writeTextFile(backupPath, this.serializeEditorContents(doc))
    return backupPath
  }

  /**
   * Serializes the current editor contents of the given document exactly as a
   * regular save would write them to disk (BOM for every file, original
   * linefeeds for Markdown files, plain LF contents for code files).
   *
   * @param   {Document}  doc  The document to serialize
   *
   * @return  {string}         The serialized file contents
   */
  private serializeEditorContents (doc: Document): string {
    return this.serializeContentsForDisk(doc, [...doc.document.iterLines()].join('\n'))
  }

  /**
   * Serializes LF-normalized contents for the given document exactly as a
   * regular save would write them to disk (BOM for every file, original
   * linefeeds for Markdown files, plain LF contents for code files). The
   * editor never holds the BOM: the FSAL cuts it off when it loads the file
   * and keeps it in the descriptor, so every write puts it back from there.
   *
   * @param   {Document}  doc      The document whose file is written
   * @param   {string}    content  The contents, with LF linefeeds and no BOM
   *
   * @return  {string}             The serialized file contents
   */
  private serializeContentsForDisk (doc: Document, content: string): string {
    return doc.descriptor.type === 'file'
      ? doc.descriptor.bom + content.split('\n').join(doc.descriptor.linefeed)
      : doc.descriptor.bom + content
  }

  /**
   * This function can be called from within the FSAL or programmatically, if a
   * file has been programmatically been moved (either by renaming or moving).
   * This makes it easier for the user to not even notice this inside the open
   * documents.
   *
   * @param  {string}  oldPath  The old path
   * @param  {string}  newPath  The path it'll be afterwards
   */
  public async hasMovedFile (oldPath: string, newPath: string): Promise<void> {
    const state = this.tabLimitState()
    const paths = [...new Set([ oldPath, newPath ])]
    for (const path of paths) { state.busy.set(path, (state.busy.get(path) ?? 0) + 1) }
    let succeeded = false
    try {
      await this.hasMovedFileProtected(oldPath, newPath)
      this.migrateTabLimitPath(oldPath, newPath)
      succeeded = true
    } finally {
      for (const path of paths) {
        const remaining = (state.busy.get(path) ?? 1) - 1
        if (remaining > 0) { state.busy.set(path, remaining) } else { state.busy.delete(path) }
        if (!succeeded) { state.failed.add(path) }
      }
      if (succeeded) { this.scheduleTabLimitForPath(newPath) }
    }
  }

  private async hasMovedFileProtected (oldPath: string, newPath: string): Promise<void> {
    if (oldPath === newPath) {
      return
    }
    // Let any backed-up editing state follow the file to its new path. This
    // also covers retained backups of currently closed documents.
    await this._backups.rename(oldPath, newPath)

    // Zettlr-LYH conflict merge (R47): the merge view addresses the file by its
    // old path, so a pending merge cannot be completed anymore. End it while
    // keeping the editor contents, so the file stays marked as modified.
    if (this._conflictMergePendingFor.has(oldPath)) {
      const mergedDoc = this.documents.find(doc => doc.filePath === oldPath)
      if (mergedDoc !== undefined) {
        this.keepEditorContentsAfterConflictMerge(mergedDoc)
      }
      this.endConflictMerge(oldPath)
      this._app.log.info(`[Document Provider] Ended the pending merge of ${oldPath} because the file was moved to ${newPath}.`)
    }

    // Zettlr-LYH undo history (R135, spec C20 section 8): the undo history
    // record follows the file, also when the file is not open
    await this.renameUndoHistory(oldPath, newPath)

    // Basically we just have to close the oldPath, and "open" the new path.
    const openDoc = this.documents.find(doc => doc.filePath === oldPath)
    if (openDoc === undefined) {
      return // Nothing to do
    }

    openDoc.filePath = newPath
    openDoc.descriptor.path = newPath
    openDoc.descriptor.dir = path.dirname(newPath)
    openDoc.descriptor.name = path.basename(newPath)
    openDoc.descriptor.ext = path.extname(newPath)

    // Edits that arrived while the backup was being re-keyed may have been
    // scheduled under the old path; drop those and re-schedule under the new
    // path so the backup always mirrors the newest state.
    await this._backups.remove(oldPath)
    if (openDoc.currentVersion !== openDoc.lastSavedVersion) {
      this._backups.schedulePersist(newPath, () => openDoc.document.toString())
    }

    const leafsToNotify: Array<[string, string]> = []
    await this.forEachLeaf(async (tabMan, windowId, leafId) => {
      const res = tabMan.replaceFilePath(oldPath, newPath)
      if (res) {
        leafsToNotify.push([ windowId, leafId ])
      }
      return res
    })

    this.syncWatchedFilePaths()

    // Emit the necessary events to each window
    for (const [ windowId, leafId ] of leafsToNotify) {
      this.broadcastEvent(DP_EVENTS.FILE_PATH_CHANGED, { oldPath, newPath, windowId, leafId })
      this.broadcastEvent(DP_EVENTS.CLOSE_FILE, { filePath: oldPath, windowId, leafId })
      this.broadcastEvent(DP_EVENTS.OPEN_FILE, { filePath: newPath, windowId, leafId })
      // Ensure the renderer picks up the correct (new) active file path, if
      // that has changed (noop in othe cases; see #5574).
      this.broadcastEvent(DP_EVENTS.ACTIVE_FILE, { windowId, leafId }, false)
    }
  }

  /**
   * Convenience function, can be called in case of moving a directory around.
   * Will internally call hasMovedFile for every affected file to ensure a
   * smooth user experience.
   *
   * @param  {string}  oldPath  The old path
   * @param  {string}  newPath  The new path
   */
  public async hasMovedDir (oldPath: string, newPath: string): Promise<void> {
    // Similar as hasMovedFile, but triggers the command for every affected file
    const docs = this.documents.filter(doc => doc.filePath.startsWith(oldPath))

    // Zettlr-LYH undo history (R135, spec C20 section 8): the records of all
    // files in the folder follow it, also those of files that are not open
    const store = this.undoHistory()
    if (store !== undefined) {
      try {
        await store.renameDirectory(oldPath, newPath)
      } catch (err: unknown) {
        this._app.log.error(`[Undo History] Could not move the undo history of ${oldPath} to ${newPath}`, err)
      }
    }

    for (const doc of docs) {
      this._app.log.info('Replacing file path for doc ' + doc.filePath + ' with ' + doc.filePath.replace(oldPath, newPath))
      await this.hasMovedFile(doc.filePath, doc.filePath.replace(oldPath, newPath))
    }
  }

  /**
   * This function ensures that our watcher keeps watching the correct files
   */
  private syncWatchedFilePaths (): void {
    // First, get the files currently watched
    const watchedFiles: string[] = []
    const watched = this._watcher.getWatched()
    for (const dir in watched) {
      for (const filename of watched[dir]) {
        watchedFiles.push(path.join(dir, filename))
      }
    }

    // Second, get all open files. NOTE: This does not mean "open open", but
    // rather paths that are "open" somewhere in a leaf. Not actively viewed.
    let openFiles: string[] = []
    for (const windowId in this._windows) {
      for (const leaf of this._windows[windowId].getAllLeafs()) {
        openFiles.push(...leaf.tabMan.openFiles.map(f => f.path))
      }
    }

    openFiles = [...new Set(openFiles)] // Remove duplicates

    // Third, remove those watched files which are no longer open
    for (const watchedFile of watchedFiles) {
      if (!openFiles.includes(watchedFile)) {
        this._watcher.unwatchPath(watchedFile)
      }
    }

    // Fourth, add those open files not yet watched
    for (const openFile of openFiles) {
      if (!watchedFiles.includes(openFile)) {
        this._watcher.watchPath(openFile)
      }
    }

    // Zettlr-LYH external removal (R121): and their parent folders
    this.syncWatchedParentFolders(openFiles)
  }

  /**
   * This is a convenience function meant for operations that affect every
   * editor pane across the whole application, such as renaming files, removing
   * directories, and other things. It will iterate over every open editor pane
   * and call the provided callback function, providing the tab manager for the
   * pane in question. Since some operations require async, the whole function
   * works asynchronously.
   *
   * The callback function MUST return a boolean indicating whether the state of
   * any pane has changed. If it has, the function will make sure to emit
   * appropriate events. If you do not honor this, any changes to the internal
   * state will not be picked up by the appropriate places.
   *
   * @param   {(tabMan: TabManager) => Promise<boolean>}  callback  The callback
   */
  public async forEachLeaf (callback: (tabMan: TabManager, windowId: string, leafId: string) => Promise<boolean>): Promise<void> {
    for (const windowId in this._windows) {
      for (const leaf of this._windows[windowId].getAllLeafs()) {
        const stateHasChanged = await callback(leaf.tabMan, windowId, leaf.id)
        if (stateHasChanged) {
          this.syncToConfig()
        }
      }
    }
  }

  /**
   * This method synchronizes the state of the loadedDocuments array into the
   * configuration. It also makes sure to announce changes to whomever it may
   * concern.
   */
  private syncToConfig (): void {
    const toSave: DocumentWindowsJSON = {}
    for (const key in this._windows) {
      toSave[key] = this._windows[key].toJSON()
    }
    this._config.set(toSave)
  }

  /**
   * Sets the pinned status for the given file.
   *
   * @param   {string}   filePath        The absolute path to the file
   * @param   {boolean}  shouldBePinned  Whether the file should be pinned.
   */
  private setPinnedStatus (windowId: string, leafId: string, filePath: string, shouldBePinned: boolean): void {
    const leaf = this._windows[windowId].findLeaf(leafId)
    if (leaf === undefined) {
      return
    }

    leaf.tabMan.setPinnedStatus(filePath, shouldBePinned)
    this.broadcastEvent(DP_EVENTS.CHANGE_FILE_STATUS, { windowId, leafId, filePath, status: 'pinned' })
    this.syncToConfig()
  }

  /**
   * Broadcasts a remote changed event across the app to notify everyone that a
   * file has been remotely changed.
   *
   * @param {string} filePath The file in question
   * @param {string} source   Zettlr-LYH undo history (R135): what caused the
   *                          reload; comparison for the outcome of a comparison
   */
  public async notifyRemoteChange (filePath: string, expectedDocument?: Document, expectedUnmodifiedVersion?: number, source: 'disk-reload'|'comparison' = 'disk-reload'): Promise<boolean> {
    const document = expectedDocument ?? this.documents.find(document => document.filePath === filePath)
    if (document === undefined || !this.isCurrentConflictDocument(filePath, document)) { return false }
    // Zettlr-LYH data loss prevention (R173, specification C21 section 4 item
    // 3): dropping the document makes every editor reload it, which discards
    // input the document manager has not received. The outcome of a comparison
    // is exempt: the user has decided, and input that arrives during a
    // comparison is preserved by the comparison itself.
    const canReload = (): boolean => this.isCurrentConflictDocument(filePath, document) &&
      (source === 'comparison' || !this.editorHasUnconfirmedInput(filePath)) &&
      (expectedUnmodifiedVersion === undefined ||
        (document.currentVersion === expectedUnmodifiedVersion && document.lastSavedVersion === expectedUnmodifiedVersion &&
          !this.hasPendingExternalDecision(filePath)))
    if (!canReload()) { return false }
    // Loading disk contents replaces the old editing state. Remove its backup
    // BEFORE the editors reload the file,
    // since getDocument would otherwise restore the backup again.
    const comparison = this._conflictChoiceSessions.get(filePath)
    if (comparison?.document === document && !await this.waitForConflictInputPreservation(comparison)) {
      return false
    }
    await this._backups.remove(filePath)
    if (comparison?.document === document && !await this.waitForConflictInputPreservation(comparison)) {
      return false
    }
    if (!canReload()) {
      // An automatic reload must not discard edits received while removing
      // the old backup, including their newly scheduled backup state.
      if (expectedUnmodifiedVersion !== undefined && this.isCurrentConflictDocument(filePath, document) &&
        document.currentVersion !== document.lastSavedVersion) {
        this._backups.schedulePersist(filePath, () => document.document.toString())
      }
      return false
    }

    // Here we basically only need to close the document and wait for the
    // renderers to reload themselves with getDocument, which will automatically
    // open the new document.
    const idx = this.documents.indexOf(document)
    if (idx === -1) { return false }
    // Zettlr-LYH undo history (R135): _loadDocument records the step from this
    // text to the reloaded one
    if (this.undoHistory() !== undefined) {
      this.pendingExternalChanges().set(filePath, { oldText: document.document.toString(), source })
    }
    this.documents.splice(idx, 1)
    // Indicate to all affected editors that they should reload the file
    this.broadcastEvent(DP_EVENTS.FILE_REMOTELY_CHANGED, { filePath })
    return true
  }

  public sortOpenFiles (windowId: string, leafId: string, newOrder: string[]): void {
    const leaf = this._windows[windowId].findLeaf(leafId)
    if (leaf === undefined) {
      return
    }

    const res = leaf.tabMan.sortOpenFiles(newOrder)
    if (res) {
      this.broadcastEvent(DP_EVENTS.FILES_SORTED, { windowId, leafId })
      this.syncToConfig()
    }
  }

  /**
   * Using this function, one can move a given file from one editor pane to
   * another -- even across windows.
   *
   * @param {number} originWindow The originating window
   * @param {number} targetWindow The target window
   * @param {string} originLeaf   The origin pane in the origin window
   * @param {string} targetLeaf   The target pane in the target window
   * @param {string} filePath     The file to be moved
   */
  public async moveFile (
    originWindow: string,
    targetWindow: string,
    originLeaf: string,
    targetLeaf: string,
    filePath: string
  ): Promise<void> {
    // The user has requested to move a file. This basically just means closing
    // the file in the origin, and opening it in the target
    const origin = this._windows[originWindow].findLeaf(originLeaf)
    const target = this._windows[targetWindow].findLeaf(targetLeaf)

    if (origin === undefined || target === undefined) {
      this._app.log.error(`[Document Manager] Received a move request from ${originLeaf} to ${targetLeaf} but one of those was undefined.`)
      return
    }

    // First open the file in the target
    let success = target.tabMan.openFile(filePath)
    if (success) {
      this.broadcastEvent(DP_EVENTS.OPEN_FILE, { windowId: targetWindow, leafId: targetLeaf, filePath })
      this.broadcastEvent(DP_EVENTS.ACTIVE_FILE, { windowId: targetWindow, leafId: targetLeaf })
      this.syncToConfig()
    }

    // Then decide if we should close the leaf ...
    if (origin.tabMan.openFiles.length === 1) {
      // Close the leaf instead
      this.closeLeaf(originWindow, originLeaf)
      this.syncToConfig()
    } else {
      // ... or rather just close the file
      success = origin.tabMan.closeFile(filePath)
      if (!success) {
        this._app.log.error(`[Document Manager] Could not fulfill move request for file ${filePath}: Could not close it.`)
        return
      }

      this.broadcastEvent(DP_EVENTS.CLOSE_FILE, { windowId: originWindow, leafId: originLeaf, filePath })
      this.broadcastEvent(DP_EVENTS.ACTIVE_FILE, { windowId: originWindow, leafId: originLeaf })
      this.syncToConfig()
    }
  }

  /**
   * Zettlr-LYH tab drag-out (R115): moves a tab that was released outside all
   * main windows into a new window, where it becomes the only, active tab.
   * The new window opens near the release point with the size of the origin
   * window. The open document itself stays loaded, so unsaved changes remain,
   * and the pinned status goes along. If the tab was the last one of a pane
   * among several, the pane closes; the last tab of a window leaves the
   * window open with an empty pane. A release over a main window does
   * nothing, since that window's own drop handling applies.
   *
   * @param   {MoveFileToNewWindowRequest}  request  The released tab
   *
   * @return  {string|undefined}                     The key of the new window,
   *                                                 or undefined if none opened
   */
  public moveFileToNewWindow (request: MoveFileToNewWindowRequest): string|undefined {
    const { originWindow, originLeaf, path: filePath, screenX, screenY } = request
    if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) {
      this._app.log.warning(`[Document Manager] Cannot move ${filePath} to a new window: invalid release point.`)
      return undefined
    }

    const originTree = this._windows[originWindow] as DocumentTree|undefined
    const origin = originTree?.findLeaf(originLeaf)
    const openFile = origin?.tabMan.openFiles.find(file => file.path === filePath)
    if (originTree === undefined || origin === undefined || openFile === undefined) {
      this._app.log.warning(`[Document Manager] Cannot move ${filePath} to a new window: it is not open in pane ${originLeaf}.`)
      return undefined
    }

    const releasePoint = { x: screenX, y: screenY }
    if (this._app.windows.isScreenPointInsideMainWindow(releasePoint)) {
      return undefined
    }

    const grabOffset = {
      x: Number.isFinite(request.offsetX) ? request.offsetX! : 0,
      y: Number.isFinite(request.offsetY) ? request.offsetY! : 0
    }
    const pinned = openFile.pinned
    const key = this.newWindow(newKey => {
      this._app.windows.placeNextMainWindow(newKey, originWindow, releasePoint, grabOffset)
    })

    // Open the file in the only pane of the new window ...
    const target = this._windows[key].getAllLeafs()[0]
    target.tabMan.openFile(filePath)
    if (pinned) {
      target.tabMan.setPinnedStatus(filePath, true)
    }
    this.broadcastEvent(DP_EVENTS.OPEN_FILE, { windowId: key, leafId: target.id, filePath })
    this.broadcastEvent(DP_EVENTS.ACTIVE_FILE, { windowId: key, leafId: target.id })

    // ... then remove it from the origin
    if (origin.tabMan.openFiles.length === 1 && originTree.getAllLeafs().length > 1) {
      this.closeLeaf(originWindow, originLeaf)
    } else {
      if (pinned) {
        origin.tabMan.setPinnedStatus(filePath, false) // Pinned tabs refuse to close
      }
      origin.tabMan.closeFile(filePath)
      this.broadcastEvent(DP_EVENTS.CLOSE_FILE, { windowId: originWindow, leafId: originLeaf, filePath })
      this.broadcastEvent(DP_EVENTS.ACTIVE_FILE, { windowId: originWindow, leafId: originLeaf })
    }
    this.syncToConfig()

    if (request.scrollTop !== undefined) {
      this._app.windows.restoreEditorScrollTop(key, request.scrollTop)
    }

    this._app.log.info(`[Document Manager] Moved ${filePath} from window ${originWindow} into new window ${key}.`)
    return key
  }

  /**
   * Splits the given origin leaf along the direction. Optionally, you can also
   * direct the document manager to immediately move a file from the origin to
   * the to-be-created leaf to fill it with content.
   *
   * @param {number} originWindow   The originating window
   * @param {string} originLeaf     The origin pane in the origin window
   * @param {string} splitDirection The direction of the split (horizontal or vertical)
   * @param {string} insertion      Where to insert the new leaf (defaults to after)
   * @param {string} filePath       Optional: the file to be moved
   * @param {number} fromWindow     Optional: If the file doesn't come from origin
   * @param {string} fromLeaf       Optional: If the file doesn't come from origin
   * @param {boolean} copy          Optional: Open a second view of the file in
   *                                the new leaf instead of moving it there
   */
  public async splitLeaf (
    originWindow: string,
    originLeaf: string,
    splitDirection: 'horizontal'|'vertical',
    insertion: 'before'|'after' = 'after',
    filePath?: string,
    fromWindow?: string,
    fromLeaf?: string,
    copy?: boolean
  ): Promise<void> {
    // The user has requested a split and following move of a file
    const origin = this._windows[originWindow].findLeaf(originLeaf)

    if (origin === undefined) {
      this._app.log.error(`[Document Manager] Received a split request from ${originLeaf} but could not find it.`)
      return
    }

    const target = origin.split(splitDirection, insertion)
    this.broadcastEvent(DP_EVENTS.NEW_LEAF, {
      windowId: originWindow,
      originLeaf,
      newLeaf: target.id,
      direction: splitDirection,
      insertion
    })

    this.syncToConfig()

    // Zettlr-LYH split view (R44): a copy leaves the file where it is and
    // opens it once more in the new leaf (the open document is shared)
    if (filePath !== undefined && copy === true) {
      const success = target.tabMan.openFile(filePath)
      if (success) {
        this.broadcastEvent(DP_EVENTS.OPEN_FILE, { windowId: originWindow, leafId: target.id, filePath })
        this.broadcastEvent(DP_EVENTS.ACTIVE_FILE, { windowId: originWindow, leafId: target.id, filePath })
        this.syncToConfig()
      }
      return
    }

    if (filePath !== undefined) {
      const win = fromWindow ?? originWindow
      const leaf = fromLeaf ?? originLeaf
      await this.moveFile(win, originWindow, leaf, target.id, filePath)
    }
  }

  public closeLeaf (windowId: string, leafId: string): void {
    const leaf = this._windows[windowId].findLeaf(leafId)

    if (leaf !== undefined) {
      leaf.parent.removeNode(leaf)
      this.broadcastEvent(DP_EVENTS.LEAF_CLOSED, { windowId, leafId })
      this._updateFocusLeaf(windowId, this._windows[windowId].getAllLeafs()[0].id)
    }
  }

  /**
   * Returns the hash of the currently active file.
   * @returns {number|null} The hash of the active file.
   */
  public getActiveFile (leafId: string): string|null {
    for (const windowId in this._windows) {
      const leaf = this._windows[windowId].findLeaf(leafId)
      if (leaf !== undefined) {
        return leaf.tabMan.activeFile?.path ?? null
      }
    }
    return null
  }

  /**
   * Zettlr-LYH close tab from the command line: closes every tab of the given
   * file in every window, but only if it has no unsaved changes. Nothing
   * happens if no tab of the file is open, if it is a draft from Unsaved Files
   * (which always counts as unsaved), or if a disk-change conflict for it is
   * still awaiting the user's decision. Pinned tabs are closed as well, since
   * the caller names the file explicitly. On Windows the path is matched
   * case-insensitively and regardless of the slash direction.
   *
   * @param   {string}            filePath  The absolute path of the file
   *
   * @return  {Promise<boolean>}            True if tabs were closed
   */
  public async closeFileIfUnmodified (filePath: string): Promise<boolean> {
    const normalize = (p: string): string => {
      const resolved = path.resolve(p)
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved
    }
    const wanted = normalize(filePath)

    let openPath: string|undefined
    for (const windowId in this._windows) {
      for (const leaf of this._windows[windowId].getAllLeafs()) {
        const match = leaf.tabMan.openFiles.find(file => normalize(file.path) === wanted)
        if (match !== undefined) {
          openPath = match.path
          break
        }
      }
      if (openPath !== undefined) {
        break
      }
    }

    if (openPath === undefined || this.isModified(openPath) || this._conflictChoiceSessions.has(openPath)) {
      return false
    }

    await this.closeFileEverywhere(openPath)
    return true
  }

  /**
   * Returns true if the given file is open in at least one editor pane in any
   * window.
   *
   * @param   {string}   filePath  The absolute path to the file
   *
   * @return  {boolean}            Whether a tab for the file exists anywhere
   */
  private isOpenInAnyLeaf (filePath: string): boolean {
    for (const windowId in this._windows) {
      for (const leaf of this._windows[windowId].getAllLeafs()) {
        if (leaf.tabMan.openFiles.some(file => file.path === filePath)) {
          return true
        }
      }
    }
    return false
  }

  public isModified (filePath: string): boolean {
    // Zettlr-LYH scratch notes (R40): a scratch note always counts as unsaved
    if (this.isScratchNote(filePath)) {
      return true
    }

    const doc = this.documents.find(doc => doc.filePath === filePath)
    if (doc !== undefined) {
      return doc.currentVersion !== doc.lastSavedVersion
    } else {
      return false // None existing files aren't modified
    }
  }

  /**
   * Returns true if none of the open files have their modified flag set.
   *
   * @param  {string|number}  leafId  Can either contain a leafId or a window
   *                                  index, and returns the clean state only
   *                                  for that. If undefined, returns the total
   *                                  clean state.
   */
  public isClean (id?: string, which?: 'window'|'leaf'): boolean {
    // Zettlr-LYH scratch notes (R40): compare versions directly instead of
    // calling isModified, which always reports scratch notes as unsaved. The
    // window manager re-closes a window once askUserToCloseWindow has marked
    // every document as saved; counting scratch notes here would make it
    // retry closing that window forever.
    const modPaths = this.documents.filter(x => x.currentVersion !== x.lastSavedVersion).map(x => x.filePath)

    if (id === undefined) {
      // Total clean state
      return modPaths.length === 0
    } else if (which === 'window') {
      // window-specific clean state
      const allLeafs = this._windows[id].getAllLeafs()
      for (const leaf of allLeafs) {
        for (const file of leaf.tabMan.openFiles) {
          if (modPaths.includes(file.path)) {
            return false
          }
        }
      }
    } else {
      // leaf-specific clean state
      for (const key in this._windows) {
        const leaf = this._windows[key].findLeaf(id)
        if (leaf !== undefined) {
          for (const file of leaf.tabMan.openFiles) {
            if (modPaths.includes(file.path)) {
              return false
            }
          }
        }
      }
    }

    return true
  }

  public async navigateForward (windowId: string, leafId: string): Promise<void> {
    const leaf = this._windows[windowId].findLeaf(leafId)
    if (leaf === undefined) {
      return
    }

    leaf.tabMan.forward()
    this.broadcastEvent(DP_EVENTS.OPEN_FILE, { windowId, leafId })
    this.broadcastEvent(DP_EVENTS.ACTIVE_FILE, { windowId, leafId })
  }

  public async navigateBack (windowId: string, leafId: string): Promise<void> {
    const leaf = this._windows[windowId].findLeaf(leafId)
    if (leaf === undefined) {
      return
    }

    leaf.tabMan.back()
    this.broadcastEvent(DP_EVENTS.OPEN_FILE, { windowId, leafId })
    this.broadcastEvent(DP_EVENTS.ACTIVE_FILE, { windowId, leafId })
  }

  /**
   * Zettlr-LYH save-time conflict check (R52): determines whether the file on
   * disk still matches the state of the last save or load of the document,
   * i.e. whether writing it cannot destroy changes made by another program.
   * Zettlr-LYH external removal (R121): a file that no longer exists is
   * reported as 'missing', so that saving does not recreate it at its old
   * path. A file that exists but cannot be read (e.g. no permission) still
   * counts as matching, as before.
   *
   * @param   {Document}  doc  The document about to be saved
   *
   * @return  {Promise<'match'|'differs'|'missing'>}  'differs' if the disk holds unseen changes
   */
  private async diskMatchesLastSavedState (doc: Document): Promise<'match'|'differs'|'missing'> {
    let diskContents: string
    try {
      diskContents = await this._app.fsal.loadAnySupportedFile(doc.filePath)
    } catch (err: unknown) {
      // The error of loadAnySupportedFile carries no error code, so ask the
      // file system directly whether the file is gone
      return await this.isMissingOnDisk(doc.filePath) ? 'missing' : 'match'
    }

    return diskContents === doc.lastSavedContent ? 'match' : 'differs'
  }

  public async saveFile (filePath: string): Promise<boolean> {
    return await this.protectTabLimitSave(filePath, async () => await this.saveFileProtected(filePath), result => result)
  }

  private async saveFileProtected (filePath: string): Promise<boolean> {
    const doc = this.documents.find(doc => doc.filePath === filePath)

    if (doc === undefined) {
      this._app.log.error(`[Document Provider] Could not save file ${filePath}: Not found in loaded documents!`)
      return false
    }

    // If saveFile was called from a timeout, clearTimeout does nothing but the
    // timeout is reset to undefined. However, implementing this check here
    // ensures that we can programmatically call saveFile anywhere else and
    // still have everything work as intended.
    if (doc.saveTimeout !== undefined) {
      clearTimeout(doc.saveTimeout)
      doc.saveTimeout = undefined
    }

    // Every choice and comparison shares this guard, including cancellation
    // while the disk may have changed back to the last saved contents.
    if (this._remoteChangeDialogShownFor.includes(filePath)) {
      // Zettlr-LYH data loss prevention (R173, specification C21 section 4
      // item 8): a save that is skipped leaves a trace
      this._app.log.info(`[Document Provider] Not saving ${filePath}: A comparison or a decision about its version on disk is pending.`)
      return false
    }

    // Zettlr-LYH external removal (R121): while the removal of the file is being
    // handled (waiting for the pairing window, or asking the user), nothing is
    // written, so that the file is not recreated at its old path
    if (this._externalRemoval?.pendingRemovals.has(filePath) === true) {
      this._app.log.info(`[Document Provider] Not saving ${filePath}: Its removal from disk is being handled.`)
      return false
    }

    // Zettlr-LYH save-time conflict check (R52): never overwrite changes made
    // by another program unknowingly. If the file on disk no longer matches
    // the state of the last save or load, somebody else has written it in the
    // meantime and the watcher has missed it (a reported change would already
    // have run the conflict flow). Do not write; run the same conflict flow as
    // for a watcher-reported change instead and report the save as not done.
    const diskState = await this.diskMatchesLastSavedState(doc)
    if (diskState === 'missing') {
      // Zettlr-LYH external removal (R121): the file has vanished and the
      // watcher has not reported it (yet). Do not recreate it; ask the user
      // what to do with it, exactly as for a reported removal.
      this._app.log.warning(`[Document Provider] Not saving ${filePath}: The file no longer exists on disk. Asking what to do with it instead.`)
      this.handleRemoteRemoval(filePath).catch(err => {
        const message = err instanceof Error ? err.message : String(err)
        this._app.log.error(`[Document Provider] Could not handle the removal of ${filePath}: ${message}`, err)
      })
      return false
    } else if (diskState === 'differs') {
      // Zettlr-LYH disk conflicts (R138): only the foreground document is
      // routed right away (into the comparison if it has unsaved changes).
      // Any other document is not written and shows nothing; it is marked and
      // checked when the user turns to it.
      if (this.documentVisibility(filePath) === 'foreground') {
        this._app.log.warning(`[Document Provider] Not saving ${filePath}: The file has been changed on disk since it was last saved or loaded. Checking it against the disk instead.`)
        await this.handleRemoteChange(filePath, true)
      } else {
        this.remoteChangeCheckPending().add(filePath)
        this._app.log.warning(`[Document Provider] Not saving ${filePath}: The file has been changed on disk since it was last saved or loaded. It will be checked when the user turns to it.`)
      }
      return false
    }
    if (this._remoteChangeDialogShownFor.includes(filePath) || this._externalRemoval?.pendingRemovals.has(filePath) === true ||
      !this.isCurrentConflictDocument(filePath, doc)) {
      // Zettlr-LYH data loss prevention (R173, specification C21 section 4
      // item 8): the state changed while the disk was read
      let reason = 'The document has been replaced while the file on disk was being checked.'
      if (this._remoteChangeDialogShownFor.includes(filePath)) {
        reason = 'A comparison or a decision about its version on disk is pending.'
      } else if (this._externalRemoval?.pendingRemovals.has(filePath) === true) {
        reason = 'Its removal from disk is being handled.'
      }
      this._app.log.info(`[Document Provider] Not saving ${filePath}: ${reason}`)
      return false
    }

    // NOTE: Remember that we MUST under any circumstances adapt the document
    // descriptor BEFORE attempting to save. The reason is that if we don't do
    // that, we can run into the following race condition:
    // 1. User changes the document
    // 2. The save commences
    // 3. The user adds more changes
    // 4. The save finishes and undos the modifications

    // NOTE: Zettlr internally always uses regular LF linefeeds. The FSAL load
    // and FSAL save methods will take care to actually use the proper linefeeds
    // and BOMs. So here we will always use newlines. This should fix and in the
    // future prevent bugs like #4959
    const docLines = [...doc.document.iterLines()]
    const content = docLines.join('\n')
    // Zettlr-LYH data loss prevention (R173, specification C21 section 4 item
    // 7): remembered so that a failed write can take the two assignments back
    const savedVersionBeforeWrite = doc.lastSavedVersion
    const savedContentBeforeWrite = doc.lastSavedContent
    const versionToWrite = doc.currentVersion
    let fileWritten = false
    doc.lastSavedVersion = versionToWrite
    doc.lastSavedContent = content

    if (doc.descriptor.type === 'file') {
      // In case of an MD File increase the word or char count
      const locale: string = this._app.config.get().appLang
      const ast = markdownToAST(content)
      const counts = countAll(ast, locale)
      const newWordCount = counts.words
      const newCharCount = counts.chars

      this._app.stats.updateCounts(
        newWordCount - doc.lastSavedWordCount,
        newCharCount - doc.lastSavedCharCount
      )

      doc.lastSavedWordCount = newWordCount
      doc.lastSavedCharCount = newCharCount
    }

    this._ignoreChanges.push(filePath)

    try {
      if (doc.descriptor.type === 'file') {
        const fileContents = this.serializeContentsForDisk(doc, content)
        await this._app.fsal.writeTextFile(doc.descriptor.path, fileContents)
        fileWritten = true
        this.recordUndoSave(doc.filePath, content.length) // Zettlr-LYH undo history (R135)
        doc.descriptor = await this._app.fsal.getDescriptorFor(doc.descriptor.path, false) as MDFileDescriptor
        await this.synchronizeDatabases() // The file may have gotten a library
      } else {
        await this._app.fsal.writeTextFile(doc.descriptor.path, this.serializeContentsForDisk(doc, content))
        fileWritten = true
        this.recordUndoSave(doc.filePath, content.length) // Zettlr-LYH undo history (R135)
        doc.descriptor = await this._app.fsal.getDescriptorFor(doc.descriptor.path, false) as CodeFileDescriptor
      }
      doc.loadedOrSavedModifiedAt = doc.descriptor.modtime
    } catch (err: unknown) {
      // Zettlr-LYH data loss prevention (R173, specification C21 section 4
      // item 7): nothing reached the disk, so the document is not saved. Take
      // back what was set before the write (unless something else has changed
      // it since), so that the document counts as modified again, and tell
      // the user even if nobody waits for this save. An error after the write
      // itself (reading the descriptor, the databases) does not get here: the
      // contents are on disk then.
      if (!fileWritten) {
        if (doc.lastSavedVersion === versionToWrite && doc.lastSavedContent === content) {
          doc.lastSavedVersion = savedVersionBeforeWrite
          doc.lastSavedContent = savedContentBeforeWrite
        }
        this.reportSaveFailure(filePath, err)
      }

      if (err instanceof Error) {
        dialog.showErrorBox(trans('Could not save file'), trans('Could not save file %s: %s', doc.descriptor.name, err.message))
      }

      throw err
    }

    this._app.log.info(`[DocumentManager] File ${filePath} saved.`)
    this.refreshFileIdentity(doc).catch(() => undefined) // Zettlr-LYH external removal (R121)

    // The user's changes now live in the source file, so the backup of the
    // unsaved editing state has served its purpose -- unless new edits have
    // arrived while the save was running, in which case the backup (which
    // mirrors the newest state) must stay.
    if (doc.currentVersion === doc.lastSavedVersion) {
      await this._backups.remove(filePath)
    }

    this.broadcastEvent(DP_EVENTS.CHANGE_FILE_STATUS, { filePath, status: 'modification' })
    this.broadcastEvent(DP_EVENTS.FILE_SAVED, { filePath })

    return true
  }

  /**
   * Zettlr-LYH save as (R48): saves the given file under a new name chosen by
   * the user. The current editor contents (including unsaved changes) are
   * written to the new file exactly as a regular save would write them (same
   * BOM and linefeeds), the document and every tab showing the file follow it
   * to the new path, and the new file counts as saved. The original file is
   * not touched: it keeps the contents it was last saved with. Scratch notes
   * already ask for a location whenever they are saved, so they take that
   * route. Cancelling the dialog leaves everything as it is.
   *
   * @param   {string}            filePath  The file to save under a new name
   *
   * @return  {Promise<boolean>}            True if the file has been saved
   */
  public async saveFileAs (filePath: string): Promise<boolean> {
    return await this.protectTabLimitSave(filePath, async protectPath => await this.saveFileAsProtected(filePath, protectPath), result => result)
  }

  private async saveFileAsProtected (filePath: string, protectPath: (path: string) => void): Promise<boolean> {
    if (this.isScratchNote(filePath)) {
      return (await this.saveScratchNoteAs(filePath)) !== undefined
    }

    const doc = this.documents.find(doc => doc.filePath === filePath)
    if (doc === undefined) {
      this._app.log.error(`[Document Provider] Could not save file ${filePath} under a new name: Not found in loaded documents!`)
      return false
    }

    if (this.refuseSaveAsDuringConflictMerge(filePath)) {
      return false
    }

    const options = buildSaveAsDialogOptions(filePath)
    const parentWindow = this._app.windows.getFirstMainWindow()
    const response = parentWindow !== undefined
      ? await dialog.showSaveDialog(parentWindow, options)
      : await dialog.showSaveDialog(options)
    if (response.canceled || response.filePath === undefined || response.filePath === '') {
      return false // Cancelled: everything stays as it is
    }

    const resolution = resolveSaveAsTarget(filePath, response.filePath)
    if (resolution.kind === 'type-mismatch') {
      this._app.windows.prompt({
        type: 'error',
        title: trans('Cannot change the file type'),
        message: trans('Save As cannot change the type of %s. Please choose a name ending in %s.', path.basename(filePath), path.extname(filePath))
      })
      return false
    }

    const targetPath = resolution.targetPath
    protectPath(targetPath)
    // Zettlr-LYH undo history (R135): nor inside the undo history folder
    if (this.isInsideScratchOrUndoHistoryFolder(targetPath)) {
      this._app.windows.prompt({
        type: 'error',
        title: trans('Cannot save the file here'),
        message: trans('Files cannot be saved inside the scratch folder or the undo history folder. Please choose another folder.')
      })
      return false
    }

    // The save dialog has only confirmed overwriting the name the user typed
    if (resolution.extensionAppended && await this._app.fsal.pathExists(targetPath)) {
      if (!await this._app.windows.shouldOverwriteFile(path.basename(targetPath))) {
        return false
      }
    }

    // The document may have been closed, moved or put into a merge while the
    // dialogs were open
    if (!this.documents.includes(doc) || doc.filePath !== filePath) {
      return false
    }
    if (this.refuseSaveAsDuringConflictMerge(filePath)) {
      return false
    }

    const openTabPaths: string[] = []
    for (const windowId in this._windows) {
      for (const leaf of this._windows[windowId].getAllLeafs()) {
        openTabPaths.push(...leaf.tabMan.openFiles.map(file => file.path))
      }
    }
    const classification = classifySaveAsTarget(
      filePath,
      targetPath,
      this.documents.map(document => document.filePath),
      openTabPaths
    )

    if (classification.kind === 'same-file') {
      return await this.saveFile(filePath)
    } else if (classification.kind === 'open-conflict') {
      // Never silently overwrite a document that is being edited
      this._app.windows.prompt({
        type: 'error',
        title: trans('File is open'),
        message: trans('%s is currently open for editing. Please choose a different name, or close that file first.', path.basename(classification.conflictingPath))
      })
      return false
    }

    // Like saveFile: our own write must not be reported back as a change. The
    // target is not watched yet (it is not open anywhere), so no change event
    // is expected for this write; the entry is dropped again below so that it
    // cannot swallow a later genuine change of the new file.
    const savedVersion = doc.currentVersion
    const savedContent = [...doc.document.iterLines()].join('\n')
    this._ignoreChanges.push(targetPath)
    const dropIgnoreEntry = (): void => {
      const ignoreIndex = this._ignoreChanges.indexOf(targetPath)
      if (ignoreIndex > -1) {
        this._ignoreChanges.splice(ignoreIndex, 1)
      }
    }

    try {
      await this._app.fsal.writeTextFile(targetPath, this.serializeEditorContents(doc))
    } catch (err: unknown) {
      dropIgnoreEntry()
      const message = err instanceof Error ? err.message : String(err)
      this._app.log.error(`[Document Provider] Could not save ${filePath} as ${targetPath}: ${message}`, err)
      this._app.windows.prompt({
        type: 'error',
        title: trans('Could not save file'),
        message: trans('Could not save file %s: %s', path.basename(targetPath), message)
      })
      return false // The document stays as it is
    }

    // The editor contents now live in the new file. Marking them as saved
    // before the document moves ensures that the original file is never
    // treated as "closed with unsaved changes": nothing asks to save it, and
    // no backup of it is retained.
    clearTimeout(doc.saveTimeout)
    doc.saveTimeout = undefined
    doc.lastSavedVersion = savedVersion
    doc.lastSavedContent = savedContent

    // hasMovedFile renames the descriptor in place. Unlike a move, the
    // original file still exists, so detach the document from a descriptor
    // object that may be shared with the file system cache.
    doc.descriptor = { ...doc.descriptor }

    // Let the document, every tab and the backup follow to the new path. This
    // also drops the backup entry of the original path.
    await this.hasMovedFile(filePath, targetPath)
    // Zettlr-LYH undo history (R135): the record has followed to the new path
    this.recordUndoSave(targetPath, savedContent.length)
    this.syncToConfig() // Restore the tabs with the new file after a restart

    try {
      doc.descriptor = await this._app.fsal.getDescriptorFor(targetPath, false) as MDFileDescriptor|CodeFileDescriptor
      await this.synchronizeDatabases() // The file may have gotten a library
    } catch (err: unknown) {
      this._app.log.error(`[Document Provider] Could not refresh the descriptor of ${targetPath}`, err)
    }
    dropIgnoreEntry()
    this.refreshFileIdentity(doc).catch(() => undefined) // Zettlr-LYH external removal (R121)

    // Edits that arrived during the write keep the backup that mirrors them
    if (doc.currentVersion === doc.lastSavedVersion) {
      await this._backups.remove(targetPath)
    }

    this.broadcastEvent(DP_EVENTS.CHANGE_FILE_STATUS, { filePath: targetPath, status: 'modification' })
    this.broadcastEvent(DP_EVENTS.FILE_SAVED, { filePath: targetPath })

    // Like newly created files, files outside every open workspace are added
    // to the open files list
    const { openWorkspaces } = this._app.config.get().app
    if (!openWorkspaces.some(workspace => isPathInsideDirectory(targetPath, workspace))) {
      this._app.config.addPath(targetPath)
    }
    this._app.recentDocs.add(targetPath)

    this._app.log.info(`[Document Provider] Saved ${filePath} as ${targetPath}`)
    return true
  }

  /**
   * Zettlr-LYH save as (R48): refuses Save As while the file is being compared
   * and merged, since the merge view addresses the file by its current path.
   *
   * @param   {string}   filePath  The file to save under a new name
   *
   * @return  {boolean}            True if Save As was refused
   */
  private refuseSaveAsDuringConflictMerge (filePath: string): boolean {
    if (!this._conflictMergePendingFor.has(filePath)) {
      return false
    }

    this._app.windows.prompt({
      type: 'error',
      title: trans('Cannot save as a new file'),
      message: trans('%s is being compared with the version on disk. Please keep one version or save both first.', path.basename(filePath))
    })
    return true
  }

  // ZETTLR-LYH EXTERNAL REMOVAL (R121)
  //
  // An open file that another program deletes, renames or moves away is not
  // closed silently anymore. The removal is held back for the pairing window,
  // during which nothing is written to the old path. If a file is at the old
  // path again by then (an atomic save), this is handled as an external change.
  // Otherwise the "File Removed from Disk" dialog lets the user choose between
  // Open Renamed File (if the file was renamed within its folder), Move to
  // Unsaved Files, Recover Cached and Discard and Close. Zettlr's own renames,
  // moves and deletions register their paths beforehand and are ignored.

  /**
   * Dispatches an event that the watcher of the open files has reported.
   *
   * @param   {string}  event     The event name (unlink, change, ...)
   * @param   {string}  filePath  The file concerned
   */
  private handleDocumentWatcherEvent (event: string, filePath: string): void {
    if (this._ignoreChanges.includes(filePath) && event === 'change') {
      this._app.log.info(`[DocumentManager] Ignoring change for ${filePath}`)
      this._ignoreChanges.splice(this._ignoreChanges.indexOf(filePath), 1)
      return
    } else {
      this._app.log.info(`[DocumentManager] Processing ${event} for ${filePath}`)
    }

    if (event === 'unlink') {
      this.handleRemoteRemoval(filePath).catch(err => {
        const message = err instanceof Error ? err.message : String(err)
        this._app.log.error(`[DocumentManager] Could not handle the removal of ${filePath}: ${message}`, err)
      })
    } else if (event === 'change') {
      this.handleWatcherChange(filePath)
    } else {
      this._app.log.warning(`[DocumentManager] Received unexpected event ${event} for ${filePath}.`)
    }
  }

  /**
   * Zettlr-LYH disk conflicts (R138): handles a change of an open file
   * reported by the watcher. While the file is being compared, the new disk
   * version goes into the comparison. Otherwise the file is checked right away
   * only if it is in front of the user; else it is only marked (nothing is
   * read, no dialog, no comparison, no tab switch and no window focus).
   *
   * @param   {string}  filePath  The changed file
   */
  private handleWatcherChange (filePath: string): void {
    const doc = this.documents.find(doc => doc.filePath === filePath)
    if (doc === undefined) {
      // Not loaded: its editor will read the current disk contents
      this._app.log.info(`[DocumentManager] ${filePath} changed on disk, but it is not loaded; nothing to check.`)
      return
    }

    const session = this._conflictChoiceSessions.get(filePath)
    if (session !== undefined && session.document === doc) {
      this.handleDiskChangeDuringComparison(filePath, session).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        this._app.log.error(`[DocumentManager] Could not read ${filePath} while it is being compared: ${message}`, err)
      })
      return
    }

    this.startRemoteChangeCheck(filePath, true)
  }

  /**
   * Registers files that Zettlr itself is about to rename, move or delete, so
   * that a removal reported for them within INTERNAL_OPERATION_IGNORE_MS is not
   * taken for a removal by another program. Must be called before anything on
   * disk is touched.
   *
   * @param   {string[]}  paths  The paths of the files concerned
   */
  public registerInternalFileOperation (paths: string[]): void {
    const now = Date.now()
    const bookkeeping = this.removalBookkeeping()
    this.dropExpiredInternalOperations(bookkeeping, now)
    for (const filePath of paths) {
      // The original path is kept; it is normalized only for comparisons
      bookkeeping.internalOperations.push({ path: filePath, registeredAt: now })
    }
  }

  /**
   * Returns every file inside the given folder (at any depth) that is open in
   * a tab or loaded as a document, so that a command that renames, moves or
   * deletes the folder can register them as internal file operations.
   *
   * @param   {string}    directoryPath  The folder
   *
   * @return  {string[]}                 The open files inside it, without duplicates
   */
  public getOpenFilesInDirectory (directoryPath: string): string[] {
    const filePaths = new Set<string>()
    for (const windowId in this._windows) {
      for (const leaf of this._windows[windowId].getAllLeafs()) {
        for (const file of leaf.tabMan.openFiles) {
          if (isPathInsideDirectory(file.path, directoryPath)) {
            filePaths.add(file.path)
          }
        }
      }
    }

    for (const doc of this.documents) {
      if (isPathInsideDirectory(doc.filePath, directoryPath)) {
        filePaths.add(doc.filePath)
      }
    }

    return [...filePaths]
  }

  /**
   * Returns the bookkeeping of external removals, creating it on first use: the
   * main-process tests build the document manager without its constructor.
   *
   * @return  {ExternalRemovalBookkeeping}  The bookkeeping
   */
  private removalBookkeeping (): ExternalRemovalBookkeeping {
    if (this._externalRemoval === undefined) {
      this._externalRemoval = { internalOperations: [], pendingRemovals: new Set(), recentAdditions: [] }
    }
    return this._externalRemoval
  }

  /**
   * Forgets the internal file operations registered more than
   * INTERNAL_OPERATION_IGNORE_MS ago.
   *
   * @param   {ExternalRemovalBookkeeping}  bookkeeping  The bookkeeping
   * @param   {number}                      now          The current time (ms since epoch)
   */
  private dropExpiredInternalOperations (bookkeeping: ExternalRemovalBookkeeping, now: number): void {
    bookkeeping.internalOperations = bookkeeping.internalOperations.filter(operation => {
      return now - operation.registeredAt <= INTERNAL_OPERATION_IGNORE_MS
    })
  }

  /**
   * Tells whether a removed file was registered as an internal file operation.
   * Windows paths are compared without regard to letter case and separators.
   *
   * @param   {string}   filePath  The removed file
   * @param   {number}   now       The time of the removal (ms since epoch)
   *
   * @return  {boolean}            True if Zettlr itself has removed the file
   */
  private isInternalFileOperation (filePath: string, now: number): boolean {
    const bookkeeping = this.removalBookkeeping()
    this.dropExpiredInternalOperations(bookkeeping, now)
    const comparisonPath = normalizePathForComparison(filePath)
    return bookkeeping.internalOperations.some(operation => normalizePathForComparison(operation.path) === comparisonPath)
  }

  /**
   * Tells whether a file is open in some tab or loaded as a document. Windows
   * paths are compared without regard to letter case and separators.
   *
   * @param   {string}   filePath  The file
   *
   * @return  {boolean}            True if the file is open in Zettlr
   */
  private isOpenAnywhere (filePath: string): boolean {
    const comparisonPath = normalizePathForComparison(filePath)
    const isSame = (otherPath: string): boolean => normalizePathForComparison(otherPath) === comparisonPath
    if (this.documents.some(doc => isSame(doc.filePath))) {
      return true
    }

    for (const windowId in this._windows) {
      for (const leaf of this._windows[windowId].getAllLeafs()) {
        if (leaf.tabMan.openFiles.some(file => isSame(file.path))) {
          return true
        }
      }
    }
    return false
  }

  /**
   * Remembers a file that has just appeared in a workspace or in the folder of
   * an open file, as a candidate for the new name of a removed file. Only the
   * last few seconds (and at most MAX_RECENT_ADDITIONS files) are kept.
   *
   * @param   {string}  filePath  The file that has appeared
   * @param   {number}  time      When it was reported (ms since epoch)
   */
  private recordAddedFile (filePath: string, time: number = Date.now()): void {
    const bookkeeping = this.removalBookkeeping()
    bookkeeping.recentAdditions.push({ path: filePath, time })

    // A removal is paired once its pairing window has passed, so an addition
    // is needed for at most both windows (plus a margin for slow processing)
    const oldestNeeded = time - REMOVAL_PAIRING_WINDOW_BEFORE_MS - REMOVAL_PAIRING_WINDOW_AFTER_MS - 2000
    bookkeeping.recentAdditions = bookkeeping.recentAdditions.filter(addition => addition.time >= oldestNeeded)
    while (bookkeeping.recentAdditions.length > MAX_RECENT_ADDITIONS) {
      bookkeeping.recentAdditions.shift()
    }
  }

  /**
   * Reads the identity (volume and file index) and the size of a file. NTFS
   * file indices exceed the integers that a double represents exactly, so
   * they are read as bigint.
   *
   * @param   {string}                       filePath  The file
   *
   * @return  {Promise<FileOnDisk|undefined>}          Undefined if there is no such file
   */
  private async statFileOnDisk (filePath: string): Promise<FileOnDisk|undefined> {
    try {
      const stats = await fsPromises.stat(filePath, { bigint: true })
      if (!stats.isFile()) {
        return undefined
      }

      // A file index of 0 means that the file system has no usable index
      const identity = stats.ino === 0n ? undefined : { dev: stats.dev, ino: stats.ino }
      return { identity, size: Number(stats.size) }
    } catch (err: unknown) {
      return undefined
    }
  }

  /**
   * Reads the identity of a file on disk.
   *
   * @param   {string}                                filePath  The file
   *
   * @return  {Promise<RemovalFileIdentity|undefined>}          Undefined if it cannot be determined
   */
  private async readFileIdentity (filePath: string): Promise<RemovalFileIdentity|undefined> {
    return (await this.statFileOnDisk(filePath))?.identity
  }

  /**
   * Reads the identity of the file of a document anew, after it has been
   * loaded, saved, recovered or opened under a new name. The result is
   * discarded if the document has moved to another path in the meantime.
   *
   * @param   {Document}       doc  The document
   */
  private async refreshFileIdentity (doc: Document): Promise<void> {
    const filePath = doc.filePath
    const identity = await this.readFileIdentity(filePath)
    if (doc.filePath === filePath) {
      doc.fileIdentity = identity
    }
  }

  /**
   * Tells whether a file no longer exists. Other errors (for example a missing
   * permission) do not count as missing.
   *
   * @param   {string}            filePath  The file
   *
   * @return  {Promise<boolean>}            True if the file does not exist
   */
  private async isMissingOnDisk (filePath: string): Promise<boolean> {
    try {
      await fsPromises.stat(filePath)
      return false
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException|undefined)?.code
      return code === 'ENOENT' || code === 'ENOTDIR'
    }
  }

  /**
   * Tells whether a folder exists.
   *
   * @param   {string}            folderPath  The folder
   *
   * @return  {Promise<boolean>}              True if it exists and is a folder
   */
  private async isFolderOnDisk (folderPath: string): Promise<boolean> {
    try {
      return (await fsPromises.stat(folderPath)).isDirectory()
    } catch (err: unknown) {
      return false
    }
  }

  /**
   * Watches the parent folder of every open file, without subfolders and each
   * folder only once, whether or not it belongs to a workspace, so that a file
   * renamed within its folder is seen. Folders without open files are not
   * watched anymore. Does nothing before boot. Node's fs.watch is used (it is
   * not recursive by default) because chokidar cannot be given a depth through
   * the file system abstraction.
   *
   * @param   {string[]}  openFiles  The files open in some tab
   */
  private syncWatchedParentFolders (openFiles: string[]): void {
    const watchers = this._parentFolderWatchers
    if (watchers === undefined) {
      return
    }

    const wantedFolders = new Map<string, string>()
    for (const filePath of openFiles) {
      const folder = path.dirname(filePath)
      wantedFolders.set(normalizePathForComparison(folder), folder)
    }

    for (const [ key, entry ] of [...watchers.entries()]) {
      if (!wantedFolders.has(key)) {
        entry.watcher.close()
        watchers.delete(key)
      }
    }

    for (const [ key, folder ] of wantedFolders) {
      if (watchers.has(key)) {
        continue
      }

      const watcher = this.watchParentFolder(folder, key)
      if (watcher !== undefined) {
        watchers.set(key, { folder, watcher })
      }
    }
  }

  /**
   * Starts watching one folder for files that appear in it.
   *
   * @param   {string}                  folder  The folder
   * @param   {string}                  key     The comparison form of its path
   *
   * @return  {FSWatcher|undefined}             The watcher, or undefined if the folder cannot be watched
   */
  private watchParentFolder (folder: string, key: string): FSWatcher|undefined {
    try {
      const watcher = watchFileSystem(folder, { persistent: false }, (eventType, fileName) => {
        // A "rename" is reported both for files that appear and for files that
        // disappear; only those that exist now are candidates
        if (eventType !== 'rename' || fileName === null) {
          return
        }

        const filePath = path.join(folder, fileName)
        const time = Date.now()
        this.statFileOnDisk(filePath)
          .then(file => {
            if (file !== undefined) {
              this.recordAddedFile(filePath, time)
            }
          })
          .catch(() => undefined)
      })

      watcher.on('error', (err: Error) => {
        // E.g. the folder itself has been deleted. The next synchronization
        // watches it again if it still holds open files and exists.
        this._app.log.warning(`[DocumentManager] Stopped watching the folder ${folder}: ${err.message}`)
        watcher.close()
        if (this._parentFolderWatchers?.get(key)?.watcher === watcher) {
          this._parentFolderWatchers.delete(key)
        }
      })

      return watcher
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      this._app.log.warning(`[DocumentManager] Could not watch the folder ${folder}: ${message}`)
      return undefined
    }
  }

  /**
   * Stops watching every parent folder, for good (called on shutdown).
   */
  private closeParentFolderWatchers (): void {
    if (this._parentFolderWatchers === undefined) {
      return
    }

    for (const { watcher } of this._parentFolderWatchers.values()) {
      watcher.close()
    }
    this._parentFolderWatchers = undefined
  }

  /**
   * Waits until the pairing window after the removal has passed, so that a
   * delayed report of the new file (or of the file at the old path) is in.
   *
   * @param   {number}         removalTime  When the removal was reported (ms since epoch)
   */
  private async waitForPairingWindow (removalTime: number): Promise<void> {
    const remaining = removalTime + REMOVAL_PAIRING_WINDOW_AFTER_MS - Date.now()
    if (remaining > 0) {
      await new Promise(resolve => setTimeout(resolve, remaining))
    }
  }

  /**
   * Handles the removal of an open file by another program: a deletion, a
   * rename or a move, as reported by the watcher (or found when saving). From
   * the report until the user has decided, the file is neither saved
   * automatically nor manually, and only one removal of the file is handled at
   * a time.
   *
   * @param   {string}         filePath     The removed file
   * @param   {number}         removalTime  When the removal was reported (ms since epoch)
   */
  private async handleRemoteRemoval (filePath: string, removalTime: number = Date.now()): Promise<void> {
    // Everything up to the first await happens at once, so that two reports of
    // the same removal cannot both pass the checks
    if (this.isInternalFileOperation(filePath, removalTime)) {
      this._app.log.info(`[DocumentManager] Ignoring the removal of ${filePath}: Zettlr itself has renamed, moved or deleted it.`)
      // hasMovedFile lets only loaded documents follow a rename or move. Tabs
      // of a file that has never been loaded are closed, as they were before.
      if (!this.documents.some(doc => doc.filePath === filePath) && this.isOpenInAnyLeaf(filePath)) {
        await this.closeFileEverywhere(filePath)
      }
      return
    }

    if (!this.isOpenInAnyLeaf(filePath) && !this.documents.some(doc => doc.filePath === filePath)) {
      return // Not open (anymore), so there is nothing to decide
    }

    const bookkeeping = this.removalBookkeeping()
    if (bookkeeping.pendingRemovals.has(filePath)) {
      return // This removal is being handled already
    }

    bookkeeping.pendingRemovals.add(filePath)
    const pendingDoc = this.documents.find(doc => doc.filePath === filePath)
    if (pendingDoc !== undefined) {
      clearTimeout(pendingDoc.saveTimeout)
      pendingDoc.saveTimeout = undefined
    }

    let reappeared = false
    try {
      await this.waitForPairingWindow(removalTime)
      reappeared = await this.statFileOnDisk(filePath) !== undefined
      if (!reappeared) {
        await this.askAboutRemovedFile(filePath, removalTime)
      }
    } finally {
      bookkeeping.pendingRemovals.delete(filePath)
    }

    if (!reappeared) {
      return
    }

    // A file is at the old path again, typically after an editor has saved it
    // by deleting and recreating it: this is a change, not a removal
    this._app.log.info(`[DocumentManager] ${filePath} exists again after its removal was reported; handling it as an external change.`)
    this.syncWatchedFilePaths()
    const doc = this.documents.find(doc => doc.filePath === filePath)
    if (doc !== undefined) {
      await this.refreshFileIdentity(doc)
      await this.handleRemoteChange(filePath, true)
    }
  }

  /**
   * Shows the "File Removed from Disk" dialog for a removed file and performs
   * the chosen action. A tab whose file has never been loaded holds no
   * contents that could be lost, so it is closed without asking, as before.
   *
   * @param   {string}         filePath     The removed file
   * @param   {number}         removalTime  When the removal was reported (ms since epoch)
   */
  private async askAboutRemovedFile (filePath: string, removalTime: number): Promise<void> {
    const doc = this.documents.find(doc => doc.filePath === filePath)
    if (doc === undefined) {
      if (this.isOpenInAnyLeaf(filePath)) {
        await this.closeFileEverywhere(filePath)
      }
      return
    }

    if (!this.isOpenInAnyLeaf(filePath)) {
      return // The tabs have been closed in the meantime
    }

    const pairing = await this.pairRemovedDocument(doc, removalTime)
    const canRecover = await this.isFolderOnDisk(path.dirname(filePath))
    if (!this.documents.includes(doc) || doc.filePath !== filePath) {
      return
    }

    const options = buildRemovedFileDialogOptions({
      fileName: path.basename(filePath),
      originalPath: filePath,
      scratchDirectory: this.getScratchDirectory(),
      hasUnsavedChanges: doc.currentVersion !== doc.lastSavedVersion,
      canRecover,
      renamedPath: pairing.kind === 'renamed' && !pairing.openElsewhere ? pairing.path : undefined,
      renamedPathOpenElsewhere: pairing.kind === 'renamed' && pairing.openElsewhere ? pairing.path : undefined
    })
    const { response } = await dialog.showMessageBox(options)
    const action = removedFileDialogAction(options, response)

    // Like the dialog for external changes: if the document has been closed
    // (or has moved) while the dialog was shown, no answer is applied
    if (!this.documents.includes(doc) || doc.filePath !== filePath || !this.isOpenInAnyLeaf(filePath)) {
      this._app.log.info(`[DocumentManager] Not applying the answer for the removed file ${filePath}: The document was closed while the dialog was shown.`)
      return
    }

    this._app.log.info(`[DocumentManager] ${filePath} was removed from disk; the user chose ${action}.`)
    if (action === 'open-renamed' && pairing.kind === 'renamed') {
      await this.openRemovedDocumentAsRenamed(doc, filePath, pairing.path)
    } else if (action === 'recover-cached') {
      await this.recoverRemovedDocument(doc, filePath)
    } else if (action === 'discard-and-close') {
      await this.discardRemovedDocument(doc, filePath)
    } else {
      await this.moveRemovedDocumentToUnsavedFiles(doc, filePath)
    }
  }

  /**
   * Looks for the removed file under a new name in its folder: among the files
   * that appeared there within the pairing window, the one with the recorded
   * volume and file index; failing that, the one whose contents equal the last
   * saved contents (a rename by copying and deleting).
   *
   * @param   {Document}                       doc          The document of the removed file
   * @param   {number}                         removalTime  When the removal was reported (ms since epoch)
   *
   * @return  {Promise<RemovalPairingResult>}               The outcome of the pairing
   */
  private async pairRemovedDocument (doc: Document, removalTime: number): Promise<RemovalPairingResult> {
    const removedPath = doc.filePath
    const removedKey = normalizePathForComparison(removedPath)
    const folderKey = normalizePathForComparison(path.dirname(removedPath))

    const candidatePaths = new Map<string, string>()
    for (const addition of this.removalBookkeeping().recentAdditions) {
      if (!isWithinPairingWindow(addition.time, removalTime)) {
        continue
      }

      const key = normalizePathForComparison(addition.path)
      if (key !== removedKey && normalizePathForComparison(path.dirname(addition.path)) === folderKey && !candidatePaths.has(key)) {
        candidatePaths.set(key, addition.path)
      }
    }

    const candidates: Array<RemovalCandidate & { size: number }> = []
    for (const candidatePath of candidatePaths.values()) {
      const file = await this.statFileOnDisk(candidatePath)
      if (file === undefined) {
        continue // Gone again
      }

      candidates.push({
        path: candidatePath,
        identity: file.identity,
        isOpenElsewhere: this.isOpenAnywhere(candidatePath),
        size: file.size
      })
    }

    const byIdentity = pairRemovedFile(removedPath, doc.fileIdentity, candidates)
    if (byIdentity.kind !== 'not-found') {
      return byIdentity
    }

    // The contents are only read for files of the right size: the last saved
    // contents as Zettlr holds them, or as a save writes them (BOM, linefeeds)
    const expectedSizes = new Set([
      Buffer.byteLength(doc.lastSavedContent, 'utf-8'),
      Buffer.byteLength(this.serializeContentsForDisk(doc, doc.lastSavedContent), 'utf-8')
    ])
    let hasCompared = false
    for (const candidate of candidates) {
      if (!expectedSizes.has(candidate.size)) {
        continue
      }

      hasCompared = true
      try {
        // Read like every load: without BOM and with LF linefeeds
        candidate.contentEqualsLastSaved = await this._app.fsal.loadAnySupportedFile(candidate.path) === doc.lastSavedContent
      } catch (err: unknown) {
        candidate.contentEqualsLastSaved = false
      }
    }

    return hasCompared ? pairRemovedFile(removedPath, doc.fileIdentity, candidates) : byIdentity
  }

  /**
   * Open Renamed File: the document, its tabs and its backup follow the file to
   * its new name. If the contents there differ from the last saved contents,
   * this is then handled as a change of the renamed file.
   *
   * @param   {Document}       doc       The document of the removed file
   * @param   {string}         filePath  The old path
   * @param   {string}         newPath   The new path
   */
  private async openRemovedDocumentAsRenamed (doc: Document, filePath: string, newPath: string): Promise<void> {
    let newContents: string
    try {
      newContents = await this._app.fsal.loadAnySupportedFile(newPath)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      this._app.log.error(`[DocumentManager] Could not read the renamed file ${newPath}: ${message}`, err)
      dialog.showErrorBox(`Could not open "${path.basename(newPath)}"`, message)
      if (this.documents.includes(doc) && doc.filePath === filePath) {
        await this.moveRemovedDocumentToUnsavedFiles(doc, filePath)
      }
      return
    }

    if (!this.documents.includes(doc) || doc.filePath !== filePath) {
      return
    }

    // hasMovedFile renames the descriptor in place; detach it from a descriptor
    // object that the file system cache may still hold for the old path
    doc.descriptor = { ...doc.descriptor }
    await this.hasMovedFile(filePath, newPath)
    this.syncToConfig() // Restore the tabs with the new name after a restart
    await this.refreshFileIdentity(doc)

    if (newContents === doc.lastSavedContent) {
      try {
        doc.descriptor = await this._app.fsal.getDescriptorFor(newPath, false) as MDFileDescriptor|CodeFileDescriptor
        doc.loadedOrSavedModifiedAt = doc.descriptor.modtime
      } catch (err: unknown) {
        this._app.log.error(`[DocumentManager] Could not refresh the descriptor of ${newPath}`, err)
      }
      this._app.log.info(`[DocumentManager] Opened ${filePath} as the renamed file ${newPath}.`)
      return
    }

    // The renamed file has other contents than the last saved ones: the same
    // as a change of the file on disk (conflict dialog, or no dialog at all if
    // the disk contents equal the editor contents)
    this._app.log.info(`[DocumentManager] Opened ${filePath} as the renamed file ${newPath}, whose contents differ; handling them as an external change.`)
    // Activating the renamed tab may already have started a disk check. Share
    // its scheduler so a completed reload is not checked again through this doc.
    if (this.documents.includes(doc)) {
      this.remoteChangeCheckPending().add(newPath)
      await this.runRemoteChangeCheck(newPath, true)
    }
  }

  /**
   * Move to Unsaved Files: the editor contents (including unsaved changes) are
   * written to a new scratch note, which takes the place of the removed file in
   * every tab. Saving the scratch note proposes the original folder and name.
   * If the scratch note cannot be written, the document stays as it is and
   * counts as modified, so that closing it asks first.
   *
   * @param   {Document}       doc       The document of the removed file
   * @param   {string}         filePath  The removed file
   */
  private async moveRemovedDocumentToUnsavedFiles (doc: Document, filePath: string): Promise<void> {
    const fileName = path.basename(filePath)
    const savedVersion = doc.currentVersion
    const savedContent = [...doc.document.iterLines()].join('\n')
    // A removed scratch note has no location of its own to return to
    const originalPath = this._scratchNoteOriginalPaths.get(filePath) ?? (this.isScratchNote(filePath) ? undefined : filePath)

    let scratchPath: string|undefined
    try {
      scratchPath = await createScratchNoteFile(this.getScratchDirectory(), new Date())
      await this._app.fsal.writeTextFile(scratchPath, this.serializeEditorContents(doc))
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      this._app.log.error(`[DocumentManager] Could not move the contents of the removed file ${filePath} to Unsaved Files: ${message}`, err)
      if (scratchPath !== undefined) {
        await deleteScratchNoteFile(scratchPath).catch(() => undefined)
      }
      dialog.showErrorBox(`Could not move "${fileName}" to Unsaved Files`, message)
      if (this.documents.includes(doc) && doc.currentVersion === doc.lastSavedVersion) {
        doc.lastSavedVersion--
        this.broadcastEvent(DP_EVENTS.CHANGE_FILE_STATUS, { filePath: doc.filePath, status: 'modification' })
      }
      return
    }

    if (!this.documents.includes(doc) || doc.filePath !== filePath) {
      // Closed in the meantime; the scratch note is reopened on the next start
      this._app.log.info(`[DocumentManager] ${filePath} was closed while its contents were moved to ${scratchPath}.`)
      return
    }

    // The scratch file now holds exactly these contents
    doc.lastSavedVersion = savedVersion
    doc.lastSavedContent = savedContent
    doc.descriptor = { ...doc.descriptor }

    // Let the document, every tab (in place) and the backup follow
    await this.hasMovedFile(filePath, scratchPath)
    this.recordUndoSave(scratchPath, savedContent.length) // Zettlr-LYH undo history (R135)
    this._scratchNoteOriginalPaths.delete(filePath)
    if (originalPath !== undefined) {
      this._scratchNoteOriginalPaths.set(scratchPath, originalPath)
    }
    await this.refreshFileIdentity(doc)
    if (doc.currentVersion === doc.lastSavedVersion) {
      await this._backups.remove(scratchPath)
    }
    this.syncToConfig()

    // A scratch note counts as unsaved, so its tabs show the "* "
    this.broadcastEvent(DP_EVENTS.CHANGE_FILE_STATUS, { filePath: scratchPath, status: 'modification' })
    this._app.log.info(`[DocumentManager] Moved the contents of the removed file ${filePath} to the scratch note ${scratchPath}.`)
    showNativeNotification(`"${fileName}" was removed from disk; its contents were moved to Unsaved Files.`, 'Move to Unsaved Files')
  }

  /**
   * Recover Cached: the last saved contents are written back to the original
   * path, which recreates the file. The editor contents, versions and the
   * modified state stay as they are. If the file cannot be written, the editor
   * contents are moved to Unsaved Files instead.
   *
   * @param   {Document}       doc       The document of the removed file
   * @param   {string}         filePath  The removed file
   */
  private async recoverRemovedDocument (doc: Document, filePath: string): Promise<void> {
    const fileName = path.basename(filePath)
    this.registerInternalFileOperation([filePath])

    try {
      await this._app.fsal.writeTextFile(filePath, this.serializeContentsForDisk(doc, doc.lastSavedContent))
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      this._app.log.error(`[DocumentManager] Could not restore the removed file ${filePath}: ${message}`, err)
      dialog.showErrorBox(`Could not restore "${fileName}"`, message)
      if (this.documents.includes(doc) && doc.filePath === filePath) {
        await this.moveRemovedDocumentToUnsavedFiles(doc, filePath)
      }
      return
    }

    // A change reported for the recreated file must not look newer than the
    // document, and the file has a new identity
    try {
      doc.descriptor = await this._app.fsal.getDescriptorFor(filePath, false) as MDFileDescriptor|CodeFileDescriptor
      doc.loadedOrSavedModifiedAt = doc.descriptor.modtime
    } catch (err: unknown) {
      this._app.log.error(`[DocumentManager] Could not refresh the descriptor of ${filePath}`, err)
    }
    await this.refreshFileIdentity(doc)
    this.syncWatchedFilePaths()

    this._app.log.info(`[DocumentManager] Restored the removed file ${filePath} from its last saved version.`)
    showNativeNotification(`"${fileName}" was restored from the last saved version.`, 'Recover Cached')
  }

  /**
   * Discard and Close: closes the file in every pane of every window and
   * forgets its unsaved changes, without a backup and without an entry in the
   * closed-tab history.
   *
   * @param   {Document}       doc       The document of the removed file
   * @param   {string}         filePath  The removed file
   */
  private async discardRemovedDocument (doc: Document, filePath: string): Promise<void> {
    await this.closeTabsEverywhere(filePath)
    this.forgetDocument(doc)
    await this._backups.remove(filePath)
    this._closedTabs.removeWhere(closedPath => closedPath === filePath)
    this._scratchNoteOriginalPaths.delete(filePath)
    this.syncWatchedFilePaths()
    this._app.log.info(`[DocumentManager] Discarded and closed the removed file ${filePath}.`)
  }

  // ZETTLR-LYH SCRATCH NOTES (R40)
  //
  // Ctrl+N creates a scratch note in the scratch folder without asking for a
  // location. Scratch notes are written automatically, always count as unsaved,
  // ask for a location when they are saved, and are deleted (if blank and
  // without recorded undo steps) or (R135) moved into the __Unsaved subfolder
  // of the undo history folder when their last tab is closed without saving.

  /**
   * Returns the absolute scratch folder: the configured one, or the default
   * folder inside the documents folder.
   *
   * @return  {string}  The scratch folder
   */
  public getScratchDirectory (): string {
    const configured: unknown = this._app.config.get().scratchNotesDirectory
    return resolveScratchDirectory(typeof configured === 'string' ? configured : '', app.getPath('documents'))
  }

  /**
   * Checks whether a path points to a scratch note in the current scratch
   * folder.
   *
   * @param   {string}   filePath  The path to check
   *
   * @return  {boolean}            True if the file is a scratch note
   */
  public isScratchNote (filePath: string): boolean {
    return isScratchNotePath(filePath, this.getScratchDirectory())
  }

  /**
   * Renames a scratch note in place (R102). The note stays a scratch note: it
   * stays in the scratch folder, still counts as unsaved and is still written
   * automatically. The latest editor contents are written to the old scratch
   * file first; then the file is renamed, and the document, every tab in every
   * window, and the backup follow it to the new path. A name that is already
   * taken is never overwritten. The open history is not touched.
   *
   * With the silent option (R132, automatic naming after the heading), no
   * dialog is shown in any case: a name without valid characters, or a name
   * that is already taken, simply leaves the scratch note as it is.
   *
   * @param   {string}            scratchPath    The scratch note to rename
   * @param   {string}            requestedName  The new name as the user typed it
   * @param   {object}            options        Optional. silent: show no dialogs
   *
   * @return  {Promise<boolean>}                 True if the scratch note has been renamed
   */
  public async renameScratchNote (scratchPath: string, requestedName: string, options?: { silent?: boolean }): Promise<boolean> {
    const isSilent = options?.silent === true

    const newFileName = scratchRenameFileName(requestedName)
    if (newFileName === null) {
      if (isSilent) {
        this._app.log.info(`[DocumentManager] Didn't rename scratch note ${scratchPath} to "${requestedName}" since no valid file name remains`)
      } else {
        this._app.windows.prompt('Cannot rename file: No valid characters')
      }
      return false
    }

    const oldFileName = path.basename(scratchPath)
    if (newFileName === oldFileName) {
      this._app.log.info(`[DocumentManager] Didn't rename scratch note ${scratchPath} to ${newFileName} since it's the same name`)
      return false
    }

    // Never overwrite another note. A name that merely differs in letter case
    // from the old one "exists" on a case-insensitive file system because it is
    // this very file, which is fine.
    const targetPath = path.join(path.dirname(scratchPath), newFileName)
    if (await this._app.fsal.pathExists(targetPath, FSConstants.F_OK)) {
      const isCaseChangeOnly = newFileName.toLowerCase() === oldFileName.toLowerCase() &&
        await isSameFileOnDisk(scratchPath, targetPath)
      if (!isCaseChangeOnly) {
        if (isSilent) {
          this._app.log.info(`[DocumentManager] Didn't rename scratch note ${scratchPath} to ${newFileName} since that name is already taken`)
        } else {
          this._app.windows.prompt({
            type: 'error',
            title: trans('Cannot rename the note'),
            message: trans('A note named %s already exists in the scratch folder.', newFileName)
          })
        }
        return false
      }
    }

    // Zettlr-LYH internal file operations (C16, R121): the rename is registered
    // before anything on disk is touched, so that it is not taken for a removal
    // by another program. The silent rename of the automatic naming (R132)
    // passes through this very spot as well.
    this.registerInternalFileOperation([scratchPath])

    try {
      // hasMovedFile can only let the tabs follow a document that is loaded
      if (this.isOpenInAnyLeaf(scratchPath) && await this.loadOpenDocument(scratchPath) === undefined) {
        throw new Error('The scratch note could not be loaded')
      }

      // Write the latest editor contents to the old scratch file first, exactly
      // as save-file with flushScratchOnly does (which also cancels the pending
      // automatic write). False means that the write has not happened.
      if (!await this.flushScratchNote(scratchPath)) {
        return false
      }

      await this._app.fsal.rename(scratchPath, targetPath)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      this._app.log.error(`[DocumentManager] Could not rename scratch note ${scratchPath} to ${targetPath}: ${message}`, err)
      return false
    }

    // Let the document, every tab and the backup follow the file to its new path
    await this.hasMovedFile(scratchPath, targetPath)

    const originalPath = this._scratchNoteOriginalPaths.get(scratchPath) // Zettlr-LYH reopen closed tab (R43)
    if (originalPath !== undefined) {
      this._scratchNoteOriginalPaths.delete(scratchPath)
      this._scratchNoteOriginalPaths.set(targetPath, originalPath)
    }

    this.syncToConfig() // Restore the tabs with the new name after a restart

    // The new path is still a scratch note, so its tabs keep their "* "
    this.broadcastEvent(DP_EVENTS.CHANGE_FILE_STATUS, { filePath: targetPath, status: 'modification' })

    this._app.log.info(`[DocumentManager] Renamed scratch note ${scratchPath} to ${targetPath}`)
    return true
  }

  /**
   * Zettlr-LYH scratch note names (R132): renames a scratch note after the
   * level-1 heading (# Title) its content starts with. Called after the
   * automatic write of a scratch note, never after a save to a location of the
   * user's choice. The scratch note stays a scratch note, is renamed silently
   * (no dialog, no entry in the open history), and takes the first free name
   * of Title.md, Title_2.md, Title_3.md, ...
   *
   * The note is only renamed if the user has not named it themselves: its name
   * must be a generated one, or the name that the heading of the previous
   * content produces. Without a heading, nothing happens (the name is not
   * changed back after the heading has been deleted).
   *
   * @param   {string}         scratchPath      The scratch note that has just been written
   * @param   {string}         previousContent  The content written to the note the time
   *                                            before, which its current name derives from
   * @param   {string}         newContent       The content that has just been written
   *
   * @return  {Promise<void>}                   Resolves once the note is renamed or left alone
   */
  public async autoNameScratchNote (scratchPath: string, previousContent: string, newContent: string): Promise<void> {
    const targetName = scratchHeadingFileName(newContent)
    if (targetName === null) {
      return
    }

    const currentName = path.basename(scratchPath)
    if (!isAutoNamedScratchFileName(currentName, previousContent)) {
      return // The user has given the scratch note a name of their own
    }

    let entryNames: string[]
    try {
      entryNames = await this._app.fsal.readdir(path.dirname(scratchPath))
    } catch (err: unknown) {
      this._app.log.error(`[DocumentManager] Could not read the scratch folder to name ${scratchPath} after its heading`, err)
      return
    }

    // The note itself does not count as taken, so that a note that already has
    // the wanted name (or its numbered form) is not renamed back and forth
    const finalName = uniqueScratchFileName(targetName, entryNames.filter(name => name !== currentName))
    if (finalName === currentName) {
      return
    }

    if (!await this.renameScratchNote(scratchPath, finalName, { silent: true })) {
      return
    }

    // renameScratchNote writes the latest editor contents before it renames the
    // file. If the user has typed in the meantime, the file now holds newer
    // content than the name was derived from, so name it once more.
    const renamedPath = path.join(path.dirname(scratchPath), finalName)
    const renamedDocument = this.documents.find(doc => doc.filePath === renamedPath)
    if (renamedDocument !== undefined && renamedDocument.lastSavedContent !== newContent) {
      await this.autoNameScratchNote(renamedPath, newContent, renamedDocument.lastSavedContent)
    }
  }

  /**
   * Creates a new, empty scratch note and opens it in a new tab. The scratch
   * note is deliberately not added to the open files list.
   *
   * @param   {string|undefined}  windowId  The window to open the scratch note in
   * @param   {string|undefined}  leafId    The editor pane to open the scratch note in
   *
   * @return  {Promise<string>}             The path of the new scratch note
   */
  public async newScratchNote (windowId: string|undefined, leafId: string|undefined): Promise<string> {
    const scratchPath = await createScratchNoteFile(this.getScratchDirectory(), new Date())
    this._app.log.info(`[DocumentManager] Created scratch note ${scratchPath}`)
    await this.openFile(windowId, leafId, scratchPath, true)
    return scratchPath
  }

  /**
   * Returns the paths of all scratch notes open in any editor pane, whether or
   * not an editor has loaded them already.
   *
   * @return  {string[]}  The open scratch notes
   */
  private getOpenScratchNotePaths (): string[] {
    const scratchDirectory = this.getScratchDirectory()
    const scratchPaths = new Set<string>()
    for (const windowId in this._windows) {
      for (const leaf of this._windows[windowId].getAllLeafs()) {
        for (const file of leaf.tabMan.openFiles) {
          if (isScratchNotePath(file.path, scratchDirectory)) {
            scratchPaths.add(file.path)
          }
        }
      }
    }
    return [...scratchPaths]
  }

  /**
   * Returns the paths of all files the editors should mark as unsaved: the
   * modified documents plus every open scratch note that is not blank (R165).
   *
   * @return  {string[]}  The paths to mark as unsaved
   */
  private getModifiedFilePaths (): string[] {
    const modifiedPaths = this.documents
      .filter(doc => !this.isScratchNote(doc.filePath) && this.isModified(doc.filePath))
      .map(doc => doc.filePath)

    const openScratchPaths = this.getOpenScratchNotePaths()
    for (const doc of this.documents) {
      if (this.isScratchNote(doc.filePath) && !openScratchPaths.includes(doc.filePath)) {
        openScratchPaths.push(doc.filePath)
      }
    }

    // Blank on disk is only asked for scratch notes no editor has loaded; a
    // loaded one is judged by its current content. Entries of notes that are
    // loaded or no longer open are dropped, so a later read sees the disk anew.
    const blankOnDisk = this._scratchNoteBlankOnDisk ??= new Map()
    for (const cachedPath of [...blankOnDisk.keys()]) {
      if (!openScratchPaths.includes(cachedPath) || this.documents.some(doc => doc.filePath === cachedPath)) {
        blankOnDisk.delete(cachedPath)
      }
    }

    const unsavedScratchPaths = selectUnsavedScratchNotePaths(openScratchPaths, scratchPath => {
      const doc = this.documents.find(doc => doc.filePath === scratchPath)
      if (doc !== undefined) {
        return isBlankScratchText(doc.document.iter())
      }
      return this.isScratchNoteBlankOnDisk(scratchPath)
    })

    for (const scratchPath of unsavedScratchPaths) {
      if (!modifiedPaths.includes(scratchPath)) {
        modifiedPaths.push(scratchPath)
      }
    }
    return modifiedPaths
  }

  /**
   * Zettlr-LYH blank scratch notes (R165): tells whether a scratch note that
   * no editor has loaded is blank on disk. The first call starts reading the
   * file and answers undefined (unknown, which counts as unsaved); once the
   * file turns out blank, the renderers are told to fetch the unsaved files
   * again, so that its tab and its row drop the unsaved mark.
   *
   * @param   {string}             scratchPath  The scratch note
   *
   * @return  {boolean|undefined}               Whether it is blank, undefined while unknown
   */
  private isScratchNoteBlankOnDisk (scratchPath: string): boolean|undefined {
    const blankOnDisk = this._scratchNoteBlankOnDisk ??= new Map()
    const known = blankOnDisk.get(scratchPath)
    if (known !== undefined) {
      return known
    }

    const reads = this._scratchNoteBlankReads ??= new Set()
    if (reads.has(scratchPath)) {
      return undefined
    }

    reads.add(scratchPath)
    fsPromises.readFile(scratchPath, 'utf8')
      .then(content => {
        const blank = isBlankScratchContent(content)
        blankOnDisk.set(scratchPath, blank)
        if (blank) {
          this.broadcastEvent(DP_EVENTS.CHANGE_FILE_STATUS, { filePath: scratchPath, status: 'modification' })
        }
      })
      .catch(() => undefined) // E.g. the file has vanished: it stays marked as unsaved
      .finally(() => { reads.delete(scratchPath) })

    return undefined
  }

  /**
   * Counts the editor panes in which a file is open.
   *
   * @param   {string}  filePath  The file
   *
   * @return  {number}            The number of editor panes showing the file
   */
  private countOpenInstances (filePath: string): number {
    let count = 0
    for (const windowId in this._windows) {
      for (const leaf of this._windows[windowId].getAllLeafs()) {
        if (leaf.tabMan.openFiles.some(file => file.path === filePath)) {
          count++
        }
      }
    }
    return count
  }

  /**
   * Returns the loaded document for a file that is open in some editor pane,
   * loading it first (including any backed-up editing state) if no editor has
   * done so yet.
   *
   * @param   {string}                         filePath  The file
   *
   * @return  {Promise<Document|undefined>}              The document, if loaded
   */
  private async loadOpenDocument (filePath: string): Promise<Document|undefined> {
    await this.getDocument(filePath)
    return this.documents.find(doc => doc.filePath === filePath)
  }

  /**
   * Removes a document from memory and cancels its pending automatic write.
   *
   * @param   {Document}  doc               The document to forget
   * @param   {boolean}   closeUndoHistory  Zettlr-LYH undo history (R135):
   *                                        false if the caller closes the undo
   *                                        history record itself (scratch notes)
   */
  private forgetDocument (doc: Document, closeUndoHistory = true): void {
    clearTimeout(doc.saveTimeout)
    doc.saveTimeout = undefined
    const index = this.documents.indexOf(doc)
    if (index > -1) {
      this.documents.splice(index, 1)
      if (closeUndoHistory) {
        void this.closeUndoHistory(doc) // Zettlr-LYH undo history (R135)
      }
    }
    this.endConflictMerge(doc.filePath) // Zettlr-LYH conflict merge (R47)
  }

  /**
   * Writes a scratch note back to its scratch file, without any dialog.
   *
   * @param   {string}            scratchPath  The scratch note
   *
   * @return  {Promise<boolean>}               True if the scratch file is up to date
   */
  private async flushScratchNote (scratchPath: string): Promise<boolean> {
    if (!this.documents.some(doc => doc.filePath === scratchPath)) {
      return true // Not loaded, so nothing newer than the scratch file exists
    }
    return await this.saveFile(scratchPath)
  }

  /**
   * Immediately performs all pending automatic writes of scratch notes. Called
   * on shutdown, so that the last second of typing is not lost.
   */
  private async flushPendingScratchNoteWrites (): Promise<void> {
    const pendingDocuments = this.documents.filter(doc => {
      return doc.saveTimeout !== undefined &&
        this.isScratchNote(doc.filePath) &&
        !this._remoteChangeDialogShownFor.includes(doc.filePath)
    })

    for (const doc of pendingDocuments) {
      try {
        await this.saveFile(doc.filePath)
      } catch (err: unknown) {
        this._app.log.error(`[DocumentManager] Could not write scratch note ${doc.filePath} on shutdown`, err)
      }
    }
  }

  /**
   * Opens the scratch notes in the scratch folder that are not open yet in the
   * first editor pane of the first window. The scratch folder is not created
   * if it does not exist, and discarded notes are never reopened.
   *
   * @param   {string[]}           openFilePaths  The files that are open already
   *
   * @return  {Promise<string[]>}                 The reopened scratch notes
   */
  private async reopenScratchNotes (openFilePaths: string[]): Promise<string[]> {
    const scratchDirectory = this.getScratchDirectory()
    if (!await this._app.fsal.isDir(scratchDirectory)) {
      return []
    }

    const windowIds = Object.keys(this._windows)
    if (windowIds.length === 0) {
      return []
    }

    const leaf: DTLeaf|undefined = this._windows[windowIds[0]].getAllLeafs()[0]
    if (leaf === undefined) {
      return []
    }

    let entryNames: string[]
    try {
      entryNames = await this._app.fsal.readdir(scratchDirectory)
    } catch (err: unknown) {
      this._app.log.error(`[DocumentManager] Could not read the scratch folder ${scratchDirectory}`, err)
      return []
    }

    // Keep the tab the user had active; the reopened notes are added after it
    const previousActiveFile = leaf.tabMan.activeFile
    const reopenedPaths: string[] = []
    for (const scratchPath of selectScratchNotesToReopen(entryNames, openFilePaths, scratchDirectory)) {
      if (!await this._app.fsal.isFile(scratchPath)) {
        continue
      }
      leaf.tabMan.openFile(scratchPath, false)
      reopenedPaths.push(scratchPath)
    }

    if (previousActiveFile !== null) {
      leaf.tabMan.activeFile = previousActiveFile.path
    }

    if (reopenedPaths.length > 0) {
      this._app.log.info(`[DocumentManager] Reopened ${reopenedPaths.length} scratch note(s) from ${scratchDirectory}`)
    }

    return reopenedPaths
  }

  /**
   * Runs a task once all previously queued scratch note dialogs have finished.
   *
   * @param   {() => Promise<T>}  task  The task, which may show dialogs
   *
   * @return  {Promise<T>}              The result of the task
   */
  private async runScratchDialogExclusively<T> (task: () => Promise<T>): Promise<T> {
    const result = this._scratchDialogQueue.then(task)
    this._scratchDialogQueue = result.then(() => undefined, () => undefined)
    return await result
  }

  /**
   * Saves a scratch note under a location chosen by the user: the content is
   * written to the new file, every tab follows it, and the scratch file is
   * deleted. Cancelling the dialog leaves everything as it is.
   *
   * @param   {string}                       scratchPath  The scratch note
   *
   * @return  {Promise<string|undefined>}                 The new path, or undefined if not saved
   */
  public async saveScratchNoteAs (scratchPath: string): Promise<string|undefined> {
    return await this.runScratchDialogExclusively(async () => await this.saveScratchNoteAsUnqueued(scratchPath))
  }

  /**
   * Implements saveScratchNoteAs. Must only be called from within the scratch
   * dialog queue.
   *
   * @param   {string}                       scratchPath  The scratch note
   *
   * @return  {Promise<string|undefined>}                 The new path, or undefined if not saved
   */
  private async saveScratchNoteAsUnqueued (scratchPath: string): Promise<string|undefined> {
    return await this.protectTabLimitSave(scratchPath, async protectPath => await this.saveScratchNoteAsProtected(scratchPath, protectPath), result => result !== undefined)
  }

  private async saveScratchNoteAsProtected (scratchPath: string, protectPath: (path: string) => void): Promise<string|undefined> {
    // The scratch note may have been saved or closed while waiting in the queue
    if (!this.isScratchNote(scratchPath) || !this.isOpenInAnyLeaf(scratchPath)) {
      return undefined
    }

    const doc = await this.loadOpenDocument(scratchPath)
    if (doc === undefined) {
      return undefined
    }

    const suggestedName = suggestSaveFileName(doc.document.toString(), path.basename(scratchPath))
    const { openDirectory } = this._app.config.get()
    const startDirectory = openDirectory !== null && await this._app.fsal.isDir(openDirectory)
      ? openDirectory
      : app.getPath('documents')

    // Zettlr-LYH reopen closed tab (R43): a scratch note restored from the
    // backup of a vanished file proposes that file's folder and name, and
    // keeps a non-Markdown extension the user saves it with
    let defaultPath = path.join(startDirectory, suggestedName)
    const originalPath = this._scratchNoteOriginalPaths.get(scratchPath)
    if (originalPath !== undefined) {
      defaultPath = await this._app.fsal.isDir(path.dirname(originalPath))
        ? originalPath
        : path.join(startDirectory, path.basename(originalPath))
    }

    const chosenPath = await this._app.windows.saveFile(defaultPath)
    if (chosenPath === undefined) {
      return undefined // Cancelled: the scratch note stays as it is
    }

    const targetPath = originalPath !== undefined && hasMdOrCodeExt(chosenPath)
      ? chosenPath
      : ensureMarkdownExtension(chosenPath)
    protectPath(targetPath)
    // Zettlr-LYH undo history (R135): nor inside the undo history folder
    if (this.isInsideScratchOrUndoHistoryFolder(targetPath)) {
      this._app.windows.prompt({
        type: 'error',
        title: trans('Cannot save the note here'),
        message: trans('Notes cannot be saved inside the scratch folder or the undo history folder. Please choose another folder.')
      })
      return undefined
    }

    // The save dialog has only confirmed overwriting the name the user typed
    if (targetPath !== chosenPath && await this._app.fsal.pathExists(targetPath)) {
      if (!await this._app.windows.shouldOverwriteFile(path.basename(targetPath))) {
        return undefined
      }
    }

    // The scratch note may have been closed or moved while the dialogs were open
    if (!this.documents.includes(doc) || doc.filePath !== scratchPath) {
      return undefined
    }

    // A file that is about to be overwritten must not stay open anywhere
    const pathsToClose = new Set<string>()
    for (const document of this.documents) {
      if (isSamePath(document.filePath, targetPath)) {
        pathsToClose.add(document.filePath)
      }
    }
    for (const windowId in this._windows) {
      for (const leaf of this._windows[windowId].getAllLeafs()) {
        for (const file of leaf.tabMan.openFiles) {
          if (isSamePath(file.path, targetPath)) {
            pathsToClose.add(file.path)
          }
        }
      }
    }
    for (const pathToClose of pathsToClose) {
      await this.closeFileEverywhere(pathToClose)
    }

    if (!this.documents.includes(doc) || doc.filePath !== scratchPath) {
      return undefined
    }

    // Write the target before it is watched, so that the watcher does not
    // report this write as a remote change.
    const savedVersion = doc.currentVersion
    const savedContent = [...doc.document.iterLines()].join('\n')
    try {
      await this._app.fsal.writeTextFile(targetPath, this.serializeEditorContents(doc))
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      this._app.log.error(`[DocumentManager] Could not save scratch note ${scratchPath} as ${targetPath}: ${message}`, err)
      this._app.windows.prompt({
        type: 'error',
        title: trans('Could not save file'),
        message: trans('Could not save file %s: %s', path.basename(targetPath), message)
      })
      return undefined // The scratch note stays as it is
    }

    // The automatic write of the scratch file is obsolete now
    clearTimeout(doc.saveTimeout)
    doc.saveTimeout = undefined
    doc.lastSavedVersion = savedVersion
    doc.lastSavedContent = savedContent

    // Let the document, every tab and the backup follow the file to its new path
    await this.hasMovedFile(scratchPath, targetPath)
    this.recordUndoSave(targetPath, savedContent.length) // Zettlr-LYH undo history (R135)
    this._scratchNoteOriginalPaths.delete(scratchPath) // Zettlr-LYH reopen closed tab (R43)

    try {
      doc.descriptor = await this._app.fsal.getDescriptorFor(targetPath, false) as MDFileDescriptor|CodeFileDescriptor
      await this.synchronizeDatabases() // The file may have gotten a library
    } catch (err: unknown) {
      this._app.log.error(`[DocumentManager] Could not refresh the descriptor of ${targetPath}`, err)
    }
    this.refreshFileIdentity(doc).catch(() => undefined) // Zettlr-LYH external removal (R121)

    if (doc.currentVersion === doc.lastSavedVersion) {
      await this._backups.remove(targetPath)
    }

    this.broadcastEvent(DP_EVENTS.CHANGE_FILE_STATUS, { filePath: targetPath, status: 'modification' })
    this.broadcastEvent(DP_EVENTS.FILE_SAVED, { filePath: targetPath })

    // Zettlr-LYH internal file operations (C16, R121): deleting the scratch file
    // is Zettlr's own doing, not a removal by another program
    this.registerInternalFileOperation([scratchPath])
    try {
      await deleteScratchNoteFile(scratchPath)
    } catch (err: unknown) {
      // The leftover scratch note will be reopened on the next start
      this._app.log.error(`[DocumentManager] Could not delete the saved scratch note ${scratchPath}`, err)
    }

    // Like newly created files, files outside every open workspace are added
    // to the open files list
    const { openWorkspaces } = this._app.config.get().app
    if (!openWorkspaces.some(workspace => isPathInsideDirectory(targetPath, workspace))) {
      this._app.config.addPath(targetPath)
    }
    this._app.recentDocs.add(targetPath)

    this._app.log.info(`[DocumentManager] Saved scratch note ${scratchPath} as ${targetPath}`)
    return targetPath
  }

  /**
   * Decides what happens when the last tab of a scratch note is closed: a
   * blank scratch note is deleted without asking, or (R135) moved into the
   * undo history folder without asking if its undo history record holds
   * steps; otherwise the user chooses between saving it, not saving it (it is
   * moved into the undo history folder), and keeping the tab open.
   *
   * @param   {string}                             windowId     The window of the tab
   * @param   {string}                             leafId       The editor pane of the tab
   * @param   {string}                             scratchPath  The scratch note
   *
   * @return  {Promise<ScratchNoteCloseDecision>}               What closeFile has to do
   */
  private async decideScratchNoteClose (windowId: string, leafId: string, scratchPath: string): Promise<ScratchNoteCloseDecision> {
    return await this.runScratchDialogExclusively(async (): Promise<ScratchNoteCloseDecision> => {
      // The situation may have changed while waiting in the queue
      const leaf = windowId in this._windows ? this._windows[windowId].findLeaf(leafId) : undefined
      const tab = leaf?.tabMan.openFiles.find(file => file.path === scratchPath)
      if (tab === undefined || this.countOpenInstances(scratchPath) !== 1) {
        return { action: 'plain' }
      }

      let doc: Document|undefined
      try {
        doc = await this.loadOpenDocument(scratchPath)
      } catch (err: unknown) {
        // E.g. the file has vanished from disk: close the tab as usual
        this._app.log.warning(`[DocumentManager] Could not load scratch note ${scratchPath}; closing its tab as usual.`, err)
        return { action: 'plain' }
      }

      if (doc === undefined) {
        return { action: 'plain' }
      }

      if (isBlankScratchContent(doc.document.toString())) {
        // Zettlr-LYH undo history (R135): a blank scratch note with recorded
        // steps once had content, which undo can bring back; it is moved into
        // the undo history folder instead of being deleted, without asking
        const hasSteps = await this.scratchNoteHasUndoSteps(scratchPath)
        if (!this.documents.includes(doc) || this.countOpenInstances(scratchPath) !== 1) {
          return { action: 'plain' } // Closed elsewhere in the meantime
        }
        if (isBlankScratchContent(doc.document.toString())) {
          if (!hasSteps) {
            this.forgetDocument(doc, false)
            return { action: 'delete', scratchPath }
          }
          const latestContent = this.serializeEditorContents(doc)
          const latestText = doc.document.toString()
          this.forgetDocument(doc, false)
          return { action: 'move-to-history', scratchPath, latestContent, latestText }
        }
        // Text has arrived while the record was checked: ask as usual
      }

      const result = await this._app.windows.askSaveChanges(trans('File: %s', doc.descriptor.name))
      // 0 = Save, 1 = Don't save, 2 = Cancel
      if (result.response === 0) {
        try {
          const savedPath = await this.saveScratchNoteAsUnqueued(scratchPath)
          return savedPath === undefined ? { action: 'cancel' } : { action: 'saved', savedPath }
        } catch (err: unknown) {
          this._app.log.error(`[DocumentManager] Could not save scratch note ${scratchPath}`, err)
          return { action: 'cancel' }
        }
      } else if (result.response === 1) {
        if (!this.documents.includes(doc)) {
          return { action: 'plain' } // Closed elsewhere in the meantime
        }
        // Zettlr-LYH undo history (R135): the note is moved into the undo
        // history folder, where it stays for 30 days
        const latestContent = this.serializeEditorContents(doc)
        const latestText = doc.document.toString()
        this.forgetDocument(doc, false)
        return { action: 'move-to-history', scratchPath, latestContent, latestText }
      }

      this._app.log.info('[Document Manager] Not closing scratch note, as the user did not want that.')
      return { action: 'cancel' }
    })
  }

  /**
   * Zettlr-LYH undo history (R135): Save As must not put a file into the
   * scratch folder or into the undo history folder.
   *
   * @param   {string}   targetPath  The chosen path
   *
   * @return  {boolean}              True if the path is inside one of them
   */
  private isInsideScratchOrUndoHistoryFolder (targetPath: string): boolean {
    if (isPathInsideDirectory(targetPath, this.getScratchDirectory())) {
      return true
    }
    const historyRoot = this.undoHistoryRoot()
    return historyRoot !== undefined && isPathInsideDirectory(targetPath, historyRoot)
  }

  /**
   * Zettlr-LYH undo history (R135): whether the undo history record of a
   * scratch note holds steps. If that cannot be found out, the answer is true,
   * so that the note is moved into the undo history folder rather than deleted.
   *
   * @param   {string}            scratchPath  The scratch note
   *
   * @return  {Promise<boolean>}               True if there are recorded steps
   */
  private async scratchNoteHasUndoSteps (scratchPath: string): Promise<boolean> {
    const store = this.undoHistory()
    if (store === undefined) {
      return false
    }
    try {
      return await store.hasSteps(scratchPath)
    } catch (err: unknown) {
      this._app.log.error(`[Undo History] Could not check the undo history of ${scratchPath}; keeping the scratch note.`, err)
      return true
    }
  }

  /**
   * Deletes a blank scratch note without recorded steps, or (R135) moves a
   * scratch note that is not kept into the __Unsaved subfolder of the undo
   * history folder, together with its undo history record, after its last tab
   * has been closed. Errors are only logged: the scratch note then stays in
   * the scratch folder and is reopened on the next start, so nothing is lost.
   *
   * @param   {ScratchNoteCleanup}  cleanup    What to do with the scratch note
   * @param   {boolean}             tabClosed  Whether the tab has actually been closed
   */
  private async cleanUpClosedScratchNote (cleanup: ScratchNoteCleanup, tabClosed: boolean): Promise<void> {
    try {
      if (!tabClosed) {
        // The tab stayed open after all: keep the scratch note, but make sure
        // its latest content is on disk
        if (cleanup.action === 'move-to-history') {
          this._ignoreChanges.push(cleanup.scratchPath)
          await this._app.fsal.writeTextFile(cleanup.scratchPath, cleanup.latestContent)
        }
        return
      }

      this._scratchNoteOriginalPaths.delete(cleanup.scratchPath) // Zettlr-LYH reopen closed tab (R43)

      // Zettlr-LYH internal file operations (C16, R121): deleting the scratch
      // note or moving it into the undo history folder is Zettlr's own doing
      this.registerInternalFileOperation([cleanup.scratchPath])

      if (cleanup.action === 'delete') {
        await deleteScratchNoteFile(cleanup.scratchPath)
        this._app.log.info(`[DocumentManager] Deleted blank scratch note ${cleanup.scratchPath}`)
        try {
          await this.undoHistory()?.deleteRecord(cleanup.scratchPath)
        } catch (err: unknown) {
          this._app.log.error(`[Undo History] Could not delete the undo history of ${cleanup.scratchPath}`, err)
        }
      } else {
        await this.moveScratchNoteIntoUndoHistory(cleanup)
      }

      await this._backups.remove(cleanup.scratchPath)
    } catch (err: unknown) {
      this._app.log.error(`[DocumentManager] Could not clean up scratch note ${cleanup.scratchPath}`, err)
    }
  }

  /**
   * Zettlr-LYH undo history (R135, spec C3 R135 revision): closes the undo
   * history record of a scratch note without an anchor file, moves the note
   * into the __Unsaved subfolder of the undo history folder and lets the record
   * follow it. Without an undo history store, the note only gets its latest
   * contents written and stays where it is.
   *
   * @param   {ScratchNoteCleanup}  cleanup  The move-to-history cleanup
   */
  private async moveScratchNoteIntoUndoHistory (cleanup: ScratchNoteCleanup & { action: 'move-to-history' }): Promise<void> {
    const store = this.undoHistory()
    const historyRoot = this.undoHistoryRoot()
    if (store === undefined || historyRoot === undefined) {
      this._ignoreChanges.push(cleanup.scratchPath)
      await this._app.fsal.writeTextFile(cleanup.scratchPath, cleanup.latestContent)
      this._app.log.warning(`[DocumentManager] There is no undo history; the scratch note ${cleanup.scratchPath} stays in the scratch folder.`)
      return
    }

    try {
      await store.closeDocument(cleanup.scratchPath, cleanup.latestText, { writeAnchor: false })
    } catch (err: unknown) {
      // The note is moved all the same: it must not stay in the scratch folder
      this._app.log.error(`[Undo History] Could not close the undo history of ${cleanup.scratchPath}`, err)
    }

    const historyPath = await moveScratchNoteToHistory(cleanup.scratchPath, cleanup.latestContent, new Date(), historyRoot)
    try {
      await store.rename(cleanup.scratchPath, historyPath)
    } catch (err: unknown) {
      this._app.log.error(`[Undo History] Could not move the undo history of ${cleanup.scratchPath} to ${historyPath}`, err)
    }
    this._app.log.info(`[DocumentManager] Moved closed scratch note ${cleanup.scratchPath} to ${historyPath}`)
  }

  // ZETTLR-LYH REOPEN CLOSED TAB (R43)
  //
  // Ctrl+Shift+T reopens the most recently closed tab: in its original pane at
  // its original position if that pane still exists, otherwise in the most
  // recently used pane of the focused window. A closed file that no longer
  // exists, but whose unsaved changes are in the backup cache, comes back as a
  // scratch note whose save dialog proposes the original location.

  /**
   * Describes an open tab as a closed-tab record, to be pushed once the tab
   * has actually been closed.
   *
   * @param   {string}      windowId  The window of the tab
   * @param   {string}      leafId    The editor pane of the tab
   * @param   {TabManager}  tabMan    The tab manager of that editor pane
   * @param   {string}      filePath  The file the tab shows
   *
   * @return  {ClosedTabRecord|undefined}  The record, or undefined if the file is not open there
   */
  private describeOpenTab (windowId: string, leafId: string, tabMan: TabManager, filePath: string): ClosedTabRecord|undefined {
    const index = tabMan.openFiles.findIndex(file => file.path === filePath)
    if (index < 0) {
      return undefined
    }
    return { windowId, leafId, filePath, index, pinned: tabMan.openFiles[index].pinned, closedAt: Date.now() }
  }

  /**
   * Reopens the most recently closed tab that can still be restored. Calls are
   * processed one after another, so that pressing the shortcut repeatedly
   * reopens one tab per press.
   *
   * @param   {string|undefined}  windowId  The focused main window, if any
   *
   * @return  {Promise<boolean>}            True if a tab has been reopened
   */
  public async reopenClosedTab (windowId?: string): Promise<boolean> {
    const result = this._reopenClosedTabQueue.then(async () => await this.reopenClosedTabUnqueued(windowId))
    this._reopenClosedTabQueue = result.then(() => undefined, () => undefined)
    return await result
  }

  private async reopenClosedTabUnqueued (focusedWindowId?: string): Promise<boolean> {
    if (this._closedTabs.size === 0) {
      return false // Nothing to reopen: deliberately no message
    }

    // The window to fall back to if a record's original pane is gone
    let fallbackWindowId: string|undefined
    if (focusedWindowId !== undefined && focusedWindowId in this._windows) {
      fallbackWindowId = focusedWindowId
    } else {
      const firstMainWindow = this._app.windows.getFirstMainWindow()
      const key = firstMainWindow !== undefined ? this._app.windows.getMainWindowKey(firstMainWindow) : undefined
      if (key !== undefined && key in this._windows) {
        fallbackWindowId = key
      }
    }

    if (fallbackWindowId === undefined) {
      return false // No main window to reopen the tab in; keep the records
    }
    const targetWindowId: string = fallbackWindowId

    const result = await this._closedTabs.popFirstRestorable<ReopenPlan>(async (record): Promise<ClosedTabJudgement<ReopenPlan>> => {
      const target = this.findReopenTarget(record, targetWindowId)
      if (target === undefined) {
        return { restorable: false, reason: 'missing' }
      }

      const targetLeaf = this._windows[target.windowId].findLeaf(target.leafId)
      if (targetLeaf?.tabMan.openFiles.some(file => file.path === record.filePath) === true) {
        return { restorable: false, reason: 'already-open' }
      }

      if (isFile(record.filePath)) {
        return { restorable: true, plan: { target, source: 'file' } }
      }

      const backup = await this._backups.read(record.filePath)
      if (backup !== undefined) {
        return { restorable: true, plan: { target, source: 'backup', backupContent: backup.content } }
      }

      return { restorable: false, reason: 'missing' }
    })

    // Tell the user once about every closed tab that could not be reopened
    // because its file is gone. Tabs that are already open again are skipped
    // silently.
    const missingNames = [...new Set(
      result.skipped
        .filter(skipped => skipped.reason === 'missing')
        .map(skipped => path.basename(skipped.record.filePath))
    )]
    if (missingNames.length > 0) {
      this._app.log.info(`[DocumentManager] Reopen closed tab: skipped ${missingNames.length} closed tab(s) whose files no longer exist: ${missingNames.join(', ')}`)
      const message = missingNames.length === 1
        ? trans('Skipped a closed tab: %s no longer exists and has no backup.', missingNames[0])
        : trans('Skipped %s closed tabs whose files no longer exist and have no backup: %s', missingNames.length, missingNames.join(', '))
      showNativeNotification(message, trans('Reopen Closed Tab'))
    }

    if (result.restorable === undefined) {
      return false
    }

    const { record, plan } = result.restorable
    if (plan.source === 'backup') {
      return await this.restoreClosedTabFromBackup(record, plan.target, plan.backupContent)
    }

    // The pane may have disappeared while the record was judged
    const leafId = this.findExistingLeafId(plan.target)
    const opened = await this.openFile(plan.target.windowId, leafId, record.filePath, true)
    if (!opened) {
      return false
    }

    this.restoreTabPlacement(plan.target.windowId, leafId, record.filePath, record, plan.target.isOriginalPane && leafId !== undefined)
    this._app.log.info(`[DocumentManager] Reopened closed tab ${record.filePath}`)
    return true
  }

  /**
   * Determines where a closed tab is reopened: in its original pane if that
   * still exists, otherwise in the most recently used pane of the fallback
   * window.
   *
   * @param   {ClosedTabRecord}  record            The closed tab
   * @param   {string}           fallbackWindowId  The window to fall back to
   *
   * @return  {ReopenTarget|undefined}             The target, or undefined if the fallback window has no pane
   */
  private findReopenTarget (record: ClosedTabRecord, fallbackWindowId: string): ReopenTarget|undefined {
    const originalWindow = this._windows[record.windowId] as DocumentTree|undefined
    if (originalWindow?.findLeaf(record.leafId) !== undefined) {
      return { windowId: record.windowId, leafId: record.leafId, isOriginalPane: true }
    }

    const fallbackWindow = this._windows[fallbackWindowId] as DocumentTree|undefined
    if (fallbackWindow === undefined) {
      return undefined
    }

    if (this._lastEditor.leafId !== undefined && fallbackWindow.findLeaf(this._lastEditor.leafId) !== undefined) {
      return { windowId: fallbackWindowId, leafId: this._lastEditor.leafId, isOriginalPane: false }
    }

    const firstLeaf = fallbackWindow.getAllLeafs()[0] as DTLeaf|undefined
    if (firstLeaf === undefined) {
      return undefined
    }
    return { windowId: fallbackWindowId, leafId: firstLeaf.id, isOriginalPane: false }
  }

  /**
   * Returns the target's pane ID if the pane still exists, so that openFile
   * can otherwise pick a pane of the target window itself.
   *
   * @param   {ReopenTarget}  target  The target
   *
   * @return  {string|undefined}      The pane ID, or undefined if it is gone
   */
  private findExistingLeafId (target: ReopenTarget): string|undefined {
    const tree = this._windows[target.windowId] as DocumentTree|undefined
    return tree?.findLeaf(target.leafId) !== undefined ? target.leafId : undefined
  }

  /**
   * Restores the pinned status and, in the original pane, the position of a
   * reopened tab.
   *
   * @param   {string}            windowId    The window the tab has been reopened in
   * @param   {string|undefined}  leafId      The pane the tab has been reopened in
   * @param   {string}            filePath    The file the reopened tab shows
   * @param   {ClosedTabRecord}   record      The closed tab
   * @param   {boolean}           applyIndex  Whether to move the tab back to its old position
   */
  private restoreTabPlacement (windowId: string, leafId: string|undefined, filePath: string, record: ClosedTabRecord, applyIndex: boolean): void {
    const tree = this._windows[windowId] as DocumentTree|undefined
    if (tree === undefined) {
      return
    }

    // If openFile picked the pane itself, find the pane that now shows the file
    const leaf = leafId !== undefined
      ? tree.findLeaf(leafId)
      : tree.getAllLeafs().find(candidate => candidate.tabMan.openFiles.some(file => file.path === filePath))
    if (leaf === undefined || !leaf.tabMan.openFiles.some(file => file.path === filePath)) {
      return
    }

    if (record.pinned) {
      this.setPinnedStatus(windowId, leaf.id, filePath, true)
    }

    if (applyIndex) {
      const order = leaf.tabMan.openFiles.map(file => file.path).filter(openPath => openPath !== filePath)
      order.splice(Math.min(record.index, order.length), 0, filePath)
      this.sortOpenFiles(windowId, leaf.id, order)
    }
  }

  /**
   * Reopens a closed tab whose file no longer exists from the backup of its
   * unsaved changes: the content becomes a new scratch note, whose save dialog
   * proposes the original location. The backup is only removed once the
   * scratch note has been written.
   *
   * @param   {ClosedTabRecord}  record   The closed tab
   * @param   {ReopenTarget}     target   Where to reopen it
   * @param   {string}           content  The backed-up content
   *
   * @return  {Promise<boolean>}          True if the scratch note has been opened
   */
  private async restoreClosedTabFromBackup (record: ClosedTabRecord, target: ReopenTarget, content: string): Promise<boolean> {
    let scratchPath: string|undefined
    try {
      scratchPath = await createScratchNoteFile(this.getScratchDirectory(), new Date())
      await this._app.fsal.writeTextFile(scratchPath, content)
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      this._app.log.error(`[DocumentManager] Could not restore ${record.filePath} from its backup: ${errorMessage}`, err)
      if (scratchPath !== undefined) {
        await deleteScratchNoteFile(scratchPath).catch(() => undefined)
      }
      this._app.windows.prompt({
        type: 'error',
        title: trans('Could not reopen the closed tab'),
        message: trans('The content of %s could not be restored from the backup: %s', path.basename(record.filePath), errorMessage)
      })
      // The backup is still there, so the user can try again
      this._closedTabs.push(record)
      return false
    }

    this._scratchNoteOriginalPaths.set(scratchPath, record.filePath)
    await this._backups.remove(record.filePath)
    // Other records of the same file have nothing left to restore from
    this._closedTabs.removeWhere(filePath => filePath === record.filePath)

    const leafId = this.findExistingLeafId(target)
    const opened = await this.openFile(target.windowId, leafId, scratchPath, true)
    if (opened) {
      this.restoreTabPlacement(target.windowId, leafId, scratchPath, record, target.isOriginalPane && leafId !== undefined)
    }

    this._app.log.info(`[DocumentManager] Restored the vanished file ${record.filePath} from its backup as scratch note ${scratchPath}`)
    showNativeNotification(
      trans('%s no longer exists. Its content has been restored from the backup as an unsaved note.', path.basename(record.filePath)),
      trans('Reopen Closed Tab')
    )
    return opened
  }

  private _updateFocusLeaf (windowId: string, leafId: string, recordRecentVisit: boolean = true): void {
    this._lastEditor.windowId = windowId
    this._lastEditor.leafId = leafId
    this.focusedLeafByWindow().set(windowId, leafId) // Zettlr-LYH disk conflicts (R138)
    this.broadcastEvent(DP_EVENTS.ACTIVE_FILE, {
      windowId,
      leafId,
      filePath: this.getActiveFile(leafId) ?? undefined
    }, recordRecentVisit)
  }
}
