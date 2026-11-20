import type { TabManagerJSON } from 'source/app/service-providers/documents/document-tree/tab-manager'

/**
 * A descriptor for some metadata that is associated to opened documents, such
 * as pinning status, or an icon.
 */
export interface OpenDocument {
  /**
   * The full path to the document
   */
  path: string
  /**
   * Indicates whether this document should be handled as pinned
   */
  pinned: boolean
  /**
   * An icon that will allow us to save space by associating icons to documents
   * instead of the filenames
   */
  icon?: string
}

/**
 * This enum describes supported file types that can be opened in an editor.
 */
export enum DocumentType {
  Markdown = 1,
  LaTeX,
  YAML,
  JSON,
  JSONL,
  TOML,
}

/**
 * A JSON serializable representation of a document tree leaf
 */
export interface LeafNodeJSON extends TabManagerJSON {
  /**
   * Indicates that this is a leaf
   */
  type: 'leaf'
  /**
   * The ID for this leaf (UUID)
   */
  id: string
}

/**
 * A JSON serializable representation of a document tree branch
 */
export interface BranchNodeJSON {
  /**
   * Indicates that this is a branch
   */
  type: 'branch'
  /**
   * The ID for this branch (UUID)
   */
  id: string
  /**
   * The direction into which this branch splits the tree
   */
  direction: 'horizontal'|'vertical'
  /**
   * A list of all child nodes for this branch
   */
  nodes: Array<LeafNodeJSON|BranchNodeJSON>
  /**
   * The sizes (in percent) of the individual child nodes
   */
  sizes: number[]
}

/** Metadata only: comparison contents remain private to the owning window. */
export interface ConflictReadOnlySession {
  filePath: string
  sessionId: string
  windowId: string
  leafId: string
}

/** One authority revision shared by live events and initial snapshots. */
export interface ConflictReadOnlySnapshot {
  revision: number
  sessions: ConflictReadOnlySession[]
}

/**
 * Zettlr-LYH undo history (R135, spec C20): a CodeMirror ChangeSet in its JSON
 * form, as the undo history store writes it.
 */
export type UndoChangeSetJSON = Array<number | [number, ...string[]]>

/**
 * Zettlr-LYH undo history (R135): an EditorSelection in its JSON form.
 */
export interface UndoSelectionJSON {
  ranges: Array<{ anchor: number, head: number }>
  main: number
}

/**
 * Zettlr-LYH undo history (R135, spec C20 section 7): the change that turned
 * the previous text of a document into the text it was reloaded with after an
 * external modification. get-document returns it as long as the document has
 * not changed since; the editor turns it into an undoable step.
 */
export interface DocumentExternalStep {
  forward: UndoChangeSetJSON
  inverse: UndoChangeSetJSON
  oldLength: number
  source: 'disk-reload'|'comparison'
}

/**
 * Zettlr-LYH undo history (R135): one event of the done branch of a CodeMirror
 * history, in its JSON form.
 */
export interface UndoHistoryEventJSON {
  changes: UndoChangeSetJSON
  startSelection: UndoSelectionJSON
  selectionsAfter: []
}

/**
 * Zettlr-LYH undo history (R135, spec C20 section 7): what the
 * get-undo-history command of the documents-provider returns (or null).
 * externalEventIndexes are the indexes in done of the events that stem from
 * external modifications.
 */
export interface UndoHistoryResult {
  version: number
  history: { done: UndoHistoryEventJSON[], undone: [] }
  externalEventIndexes: number[]
}

/**
 * This enumeration contains events emitted by the DocumentsProvider across main
 * and renderer processes
 */
export enum DP_EVENTS {
  // Opening/closing of files
  OPEN_FILE = 'file-opened',
  CLOSE_FILE = 'file-closed',
  FILE_PATH_CHANGED = 'file-path-changed',
  FILE_REMOTELY_CHANGED = 'file-remotely-changed',
  // Zettlr-LYH conflict merge (R47): the user chose "Compare and Merge…" in the
  // "file modified on disk" dialog; the main window should open the merge view
  FILE_CONFLICT_MERGE = 'file-conflict-merge',
  FILE_CONFLICT_MERGE_ENDED = 'file-conflict-merge-ended',
  // Zettlr-LYH disk conflicts (R138): a file without unsaved changes has been
  // reloaded from disk automatically; the pane showing it displays a notice
  FILE_RELOADED_FROM_DISK = 'file-reloaded-from-disk',
  // Zettlr-LYH disk conflicts (R138): the file being compared has changed on
  // disk again; the comparison view fetches the new disk version
  FILE_CONFLICT_DISK_CHANGED = 'file-conflict-disk-changed',
  FILES_SORTED = 'files-sorted',
  // File status (pinned, modified, ...)
  CHANGE_FILE_STATUS = 'file-status-changed',
  FILE_SAVED = 'file-saved',
  ACTIVE_FILE = 'active-file-changed',
  // Leafs (editor panes)
  NEW_LEAF = 'leaf-created',
  LEAF_CLOSED = 'leaf-deleted',
  // Windows
  NEW_WINDOW = 'window-created',
  WINDOW_CLOSED = 'window-deleted'
}
