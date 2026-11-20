/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        MarkdownEditor class
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This module contains the functionality to spin up a fully
 *                  functioning CodeMirror editor containing all the additional
 *                  API calls and hooks that Zettlr makes use of for its
 *                  powerful internal editor. The class's API provides a
 *                  multitude of options to tweak the editor to the specific
 *                  needs of different environments.
 *
 * END HEADER
 */

// Import our additional styles we need to put here since we don't have a Vue
// component for the editor itself.
import './editor.css'

/**
 * APIs
 */
import EventEmitter from 'events'

// CodeMirror imports
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view'
import {
  ChangeSet,
  Compartment,
  EditorSelection,
  EditorState,
  StateEffect,
  Text,
  type Extension,
  type SelectionRange,
  type Transaction
} from '@codemirror/state'
import { foldEffect, foldState, syntaxTree } from '@codemirror/language'
// Zettlr-LYH undo history (R135): the history field, to carry the undo history
// of an editor over to the next one and to install a history that was rebuilt
// from the records on disk
import { history, historyField, invertedEffects, isolateHistory, redoDepth, undoDepth } from '@codemirror/commands'

// Keymaps/Input modes
import { emacs } from '@replit/codemirror-emacs'
import { vimPlugin } from './plugins/vim-mode'

import { type ToCEntry, tocField } from './plugins/toc-field'
import {
  citekeyUpdate,
  filesUpdate,
  tagsUpdate,
  snippetsUpdate
} from './autocomplete'

// Main configuration
import {
  type CoreExtensionOptions,
  getJSONExtensions,
  getJSONLExtensions,
  getTOMLExtensions,
  getFormattedTOMLExtensions,
  formattedTOMLPresentation,
  tomlPresentationCompartment,
  tomlTableOfContentsField,
  getMarkdownExtensions,
  getTexExtensions,
  getYAMLExtensions,
  inputModeCompartment,
  getMainEditorThemes,
} from './editor-extension-sets'

import {
  configField,
  configUpdateEffect,
  getDefaultConfig,
  type EditorConfigOptions,
  type EditorConfiguration
} from './util/configuration'

// Custom commands
import {
  applyTaskList,
  applyPandocDivOrSpan,
  applyPandocColumns
} from './commands/markdown'
import { FORMATTING_COMMANDS } from './commands/formatting-commands'
import { applyTextColor as applyTextColorToSelection, type ColorProperty } from './util/text-color-span'
import { addNewFootnote } from './commands/footnotes'
import { markLyhRevise } from './commands/mark-lyh-revise'
import { applyRevisionAction } from './renderers/render-revisions'

// Utilities
import { copyAsHTML, pasteAsPlain } from './util/copy-paste-cut'
import { highlightRangesEffect } from './plugins/highlight-ranges'

import safeAssign from '@common/util/safe-assign'
import { countAll } from '@common/util/counter'
import { DocumentType, type DocumentExternalStep } from '@dts/common/documents'
import { type TagRecord } from '@providers/tags'
import {
  PULL_FALLBACK_INTERVAL_MS,
  reloadStateEffect,
  type PullUpdateCallback,
  type PushUpdateCallback
} from './plugins/remote-doc'
import {
  getRecoveryJournalSnapshot,
  recoveryJournal,
  setRecoveryJournalEndReason,
  type RecoveryJournalSnapshot,
  type UnconfirmedLocalStep
} from './plugins/recovery-journal'
import { recoveryJournalIPCAPI, type RecoveryJournalAPI } from './util/recovery-journal-api'
import { clearSyncHealthReporter, reportSyncHealth, SYNC_STALL_REASON_DOCUMENT_FETCH_FAILED } from './util/sync-health'
import {
  decideReplacement,
  minimalReplacement,
  splitRecoverableSessions,
  type ReplacementVerdict
} from './util/replacement-guard'
import type { RecoverableSession } from '@providers/recovery-journal/journal-store'
import { markdownToAST } from '../markdown-utils'
import { countField, updateWordCountEffect } from './plugins/statistics-fields'
import { useDarkModeEditor, darkModeEffect } from './theme/dark-mode'
import { editorMetadataFacet } from './plugins/editor-metadata'
import { projectInfoUpdateEffect, type ProjectInfo } from './plugins/project-info-field'
import { moveSection } from './commands/move-section'
import { parsePandocAttributes } from 'source/common/pandoc-util/parse-pandoc-attributes'
import type { PandocAttributeTarget } from 'source/common/pandoc-util/pandoc-attribute-schema'
import { applyPandocAttributeUpdates, findPandocAttributeTargetsNear, type PandocAttributeKindUpdate } from './context-menu/pandoc-attribute-menu'
import { closeSearchPanel, openSearchPanel, searchPanelOpen } from '@codemirror/search'
import { clickListeners } from './plugins/click-listeners'
import { findViewportAnchor } from './plugins/preserve-scroll-anchor'
import type { TextReadingPosition } from '@providers/documents/text-reading-positions'

export interface DocumentWrapper {
  path: string
  state: EditorState
  type: DocumentType
}

/**
 * Zettlr-LYH (R112): the reading line is the line at this fraction of the
 * visible height of the editor, measured from the top of the visible area; the
 * same point as the one third used by the scroll anchor plugin.
 */
export const READING_LINE_FRACTION = 1 / 3

/**
 * Where a jump to a line places the target line: in the middle of the visible
 * area (the default), or with the top of the line at the reading line, so that
 * the table of contents highlights the heading that was clicked (R112).
 */
export type JumpPosition = 'center'|'reading-line'

/**
 * Zettlr-LYH (R112): the animation frame scheduler used to report the reading
 * line at most once per frame. A module level object, so that tests can run
 * the reported frames on their own. Environments without animation frames
 * (some test documents) fall back to a timer of one frame length.
 */
export const readingLineFrames = {
  request: (callback: () => void): number => {
    if (typeof window.requestAnimationFrame === 'function') {
      return window.requestAnimationFrame(() => { callback() })
    }
    return setTimeout(callback, 16) as unknown as number
  },
  cancel: (handle: number): void => {
    if (typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(handle)
    } else {
      clearTimeout(handle)
    }
  }
}

/**
 * This is basically the old Codemirror 5 way of representing positions. While
 * Codemirror 6 is way more efficient describing everything as a string offset,
 * the line/ch representation makes a lot of sense for the users, so we keep
 * offering that here.
 */
export interface UserReadablePosition {
  line: number
  ch: number
}

export interface DocumentInfo {
  words: number
  chars: number
  cursor: UserReadablePosition
  selections: Array<{
    anchor: UserReadablePosition
    head: UserReadablePosition
    words: number
    chars: number
  }>
}

/**
 * Zettlr-LYH undo history (R135, specification C20 section 7): besides the
 * content, the document authority may return the change that turned the
 * previous text of the document into this one after an external modification.
 */
export type FetchDoc = (filePath: string) => Promise<{ content: string, type: DocumentType, startVersion: number, externalStep?: DocumentExternalStep }>

/**
 * Zettlr-LYH undo history (R135): asks the document authority for the undo
 * history of a document, rebuilt from the records on disk, at the given
 * version. The answer is not typed on purpose: the editor checks its shape.
 */
export type FetchUndoHistory = (filePath: string, version: number) => Promise<unknown>

/**
 * This interface is used to provide the editor with an API of where to fetch
 * the documents from. The remote could be, e.g., either behind a websocket or
 * an IPC bridge.
 */
export interface DocumentAuthorityAPI {
  /**
   * Used to fetch the document from the document authority
   */
  fetchDoc: FetchDoc
  /**
   * Zettlr-LYH undo history (R135): used to fetch the undo history of a
   * document from the document authority. Optional: an authority without it
   * has no undo history on disk.
   */
  fetchUndoHistory?: FetchUndoHistory
  /**
   * Used to pull new updates from the document authority
   */
  pullUpdates: PullUpdateCallback
  /**
   * Used to push updates to the document authority
   */
  pushUpdates: PushUpdateCallback
  /**
   * Zettlr-LYH data loss prevention (R173, specification C21 section 6): how
   * the editor reaches the recovery journal. Optional: an authority without it
   * makes the editor use the recovery journal of the main process
   * (`recoveryJournalIPCAPI`).
   */
  recoveryJournal?: RecoveryJournalAPI
}

/**
 * Zettlr-LYH undo history (R135): the undo history of an editor, as it is kept
 * in the persistent state while the editor is not displayed.
 */
export interface EditorViewUndoHistory {
  /**
   * The value of the history field of CodeMirror. An immutable object that is
   * not serialized; the next editor of the same document installs it as is.
   */
  value: unknown
  /**
   * The text of the document at the time the history was taken. The history
   * only fits a document with this very text.
   */
  text: Text
  /**
   * An estimate of the memory the history occupies, in bytes: 200 bytes per
   * group plus two bytes per UTF-16 code unit that the inverse changes insert
   */
  estimatedBytes: number
}

/**
 * This interface describes a persistent state for the EditorView, meaning some
 * state that should survive destruction and re-instantiation of the same
 * EditorView. It holds information that should be restored during, e.g.,
 * switching tabs, which includes a scroll snapshot and the selection(s). By
 * passing this information to a new MarkdownEditor instance, the editor can
 * restore this quickly. The caller/manager of a set of MarkdownEditor instances
 * should keep track of these, and extract them from the MarkdownEditor instance
 * before unmounting it, e.g., via a Map.
 */
export interface EditorViewPersistentState {
  /**
   * A scroll snapshot from the editor. Used to properly restore the scroll
   * position.
   */
  scrollSnapshot: StateEffect<any>
  /**
   * A selection object. Used to properly restore the cursor position and any
   * selections within the editor.
   */
  selection: EditorSelection

  /**
   * A decoration set containing currently folded ranges.
   */
  foldedRanges: DecorationSet

  /**
   * Zettlr-LYH undo history (R135): the undo and redo stacks of the editor.
   * Optional: absent while the history is still being requested from disk, and
   * in states that were stored without it (older states, or states whose
   * history was dropped to stay within the memory limit of the window).
   */
  undoHistory?: EditorViewUndoHistory
}

/**
 * Zettlr-LYH (R98): how long the editor has to stay scrolled still, in
 * milliseconds, before it reports that the reading position may be stored.
 */
export const TEXT_READING_POSITION_IDLE_DELAY = 1000

/**
 * Zettlr-LYH (R98): by how many pixels the scroll position may differ from the
 * one at the time of the request before the reader counts as having scrolled
 * on their own, which cancels the restore of a stored reading position.
 */
const TEXT_READING_RESTORE_SCROLL_TOLERANCE = 2

/**
 * Zettlr-LYH (R98): how many times the restore may scroll again after it
 * applied the stored reading position. The first conversion from a line and an
 * offset to a scroll position uses estimated heights for every line that never
 * was on the screen; each correction uses the heights that were measured since,
 * so the lines that move into the viewport are the only ones whose height can
 * still change, and a handful of corrections is more than enough.
 */
export const TEXT_READING_RESTORE_MAXIMUM_CORRECTIONS = 5

/**
 * Zettlr-LYH (R98): a correction that would move the view by less than this
 * many pixels is not made (the view is as close as the browser can place it,
 * or the position lies beyond the scrollable range).
 */
const TEXT_READING_RESTORE_MINIMUM_CORRECTION = 0.5

/**
 * Zettlr-LYH (R98): a correction aims at least this many pixels below the top
 * of the line, so that a scroll position rounded to the device pixels cannot
 * end up in the line above when the stored offset is next to zero.
 */
const TEXT_READING_RESTORE_CORRECTION_OFFSET = 1

/**
 * Zettlr-LYH (R98): the timer that waits for the end of scrolling. A module
 * level object, so that tests can run the timers on their own.
 */
export const textReadingPositionTimers = {
  start: (callback: () => void, delay: number): number => {
    return setTimeout(callback, delay) as unknown as number
  },
  cancel: (handle: number): void => {
    clearTimeout(handle)
  }
}

/**
 * Zettlr-LYH data loss prevention (R173, specification C21 section 6): the
 * timer that waits before a reload whose document could not be fetched is
 * tried again. A module level object, so that tests can run the timer on
 * their own.
 */
export const documentReloadRetryTimers = {
  start: (callback: () => void, delay: number): number => {
    return setTimeout(callback, delay) as unknown as number
  },
  cancel: (handle: number): void => {
    clearTimeout(handle)
  }
}

/**
 * Zettlr-LYH data loss prevention (R173): how often a load fetches the
 * document at most before it replaces the editor state. The second fetch
 * happens only if a push was in flight when the first one returned.
 */
const REPLACEMENT_FETCH_ATTEMPTS = 2

/**
 * Zettlr-LYH data loss prevention (R173): every push of one editor state
 * passes through its gate. The gate knows which pushes are still unanswered,
 * and once it is closed, no further push of that state reaches the document
 * authority.
 */
interface PushGate {
  closed: boolean
  /** One promise per unanswered push; each resolves (never rejects) with the answer */
  inFlight: Set<Promise<void>>
}

/**
 * Zettlr-LYH (R98): what the editor looked like when the stored reading
 * position was requested. The answer is discarded as soon as one of the three
 * changed: it belongs to another load of the document, or something has
 * navigated within the document, or the reader has scrolled.
 */
interface TextReadingRestoreGuard {
  /** The load of the document the request was made for */
  generation: number
  /** The scroll position at the time of the request */
  scrollTop: number
  /** The number of explicit navigations at the time of the request */
  navigationCount: number
}

/**
 * Zettlr-LYH (R98): a restore of the stored reading position that is under
 * way, from the request until the editor shows the position, the corrections
 * are used up, or the restore is discarded.
 */
interface TextReadingRestore {
  guard: TextReadingRestoreGuard
  /** The position the main process answered with; undefined until it did */
  position?: TextReadingPosition
  /**
   * How often the restore wrote the scroll position: once when it applied the
   * position, and once for every correction
   */
  writes: number
  /**
   * The scroll position right after the last write, as the browser kept it;
   * undefined until the position was applied. If the scroll position at the
   * start of a later measure cycle differs from it, the reader scrolled in
   * between: CodeMirror's own compensation and the scroll stabilization only
   * move the view inside a measure cycle or in the microtasks that follow it.
   */
  writtenScrollTop?: number
}

/**
 * Zettlr-LYH (R98): what the restore reads at the start of a measure cycle
 */
interface TextReadingRestoreMeasure {
  /** Whether the editor is displayed */
  visible: boolean
  /** The scroll position before this cycle changed anything */
  scrollTop: number
  /** The value of `TextReadingRestore.writes` at that time */
  writes: number
}

/**
 * Zettlr-LYH (R98): a restore that is over. As long as the reader does not
 * scroll and the document stays as it is, the position to store for the file
 * is the one that was restored, not the one the editor measures.
 */
interface TextReadingRestored {
  /** The position the main process answered with */
  position: TextReadingPosition
  /** The scroll position when the restore ended */
  scrollTop: number
  /** The load of the document the restore belongs to */
  generation: number
}

// The type of the effect created by `EditorView.scrollIntoView` (and
// `scrollSnapshot`) is internal to CodeMirror; its values are instances of an
// equally internal class, which identifies the effect.
const scrollTargetClass = (EditorView.scrollIntoView(0).value as object).constructor

/**
 * Zettlr-LYH (R98): whether a transaction asks the view to scroll, either with
 * the `scrollIntoView` flag or with an explicit scroll effect. Such a
 * transaction navigates within the document, and a stored reading position
 * must not override it.
 *
 * @param   {Transaction}  transaction  The transaction
 *
 * @return  {boolean}                   True if the transaction asks for scrolling
 */
function hasScrollRequest (transaction: Transaction): boolean {
  return transaction.scrollIntoView || transaction.effects.some(effect => effect.value instanceof scrollTargetClass)
}

/**
 * Zettlr-LYH (R98): accepts the answer of the main process only if it is an
 * object with a line and an offset that are finite numbers. `null` (no record),
 * an error object, and any other shape count as no record.
 *
 * @param   {unknown}                        answer  The answer
 *
 * @return  {TextReadingPosition|undefined}          The position, or undefined
 */
function parseTextReadingPosition (answer: unknown): TextReadingPosition|undefined {
  if (typeof answer !== 'object' || answer === null) {
    return undefined
  }
  const { line, offset } = answer as { line?: unknown, offset?: unknown }
  if (typeof line !== 'number' || typeof offset !== 'number' || !Number.isFinite(line) || !Number.isFinite(offset)) {
    return undefined
  }
  return { line, offset }
}

// ---------------------------------------------------------------------------
// Zettlr-LYH undo history (R135)
// ---------------------------------------------------------------------------

/**
 * The number of undo groups the editor keeps; equals the `minDepth` of the
 * history in editor-extension-sets.ts (CodeMirror trims at this plus 20) and
 * UNDO_HISTORY_MAX_EVENTS of the main process. Written out because the
 * renderer must not import main process modules at runtime.
 */
const UNDO_HISTORY_MIN_DEPTH = 10000

/** The estimate of the memory of one undo group, apart from the text it holds */
const UNDO_HISTORY_BYTES_PER_EVENT = 200

/** The estimate of the memory of one UTF-16 code unit of text that an undo group holds */
const UNDO_HISTORY_BYTES_PER_CODE_UNIT = 2

/**
 * The step that an external modification of the document leaves in the undo
 * history. A transaction that carries it replaced the text with the one from
 * disk; it is stored with the group (see externalReloadInversion).
 */
const externalReloadEffect = StateEffect.define<null>()

/**
 * The effect that undoing an external reload carries. The editor reports
 * `undid-external-reload` when an undo transaction carries it; a redo
 * transaction carries `externalReloadEffect` again and is not reported.
 */
const undidExternalReloadEffect = StateEffect.define<null>()

/**
 * Makes the history store the counterpart of the two effects with every group:
 * the group of a transaction that carries `externalReloadEffect` holds
 * `undidExternalReloadEffect` (so undoing it carries that effect), and the
 * group made by undoing it holds `externalReloadEffect` again, and so on. The
 * mark therefore goes with the group through undo and redo, and no user event
 * has to be inspected.
 */
const externalReloadInversion: Extension = invertedEffects.of(transaction => {
  const inverted: Array<StateEffect<null>> = []
  for (const effect of transaction.effects) {
    if (effect.is(externalReloadEffect)) {
      inverted.push(undidExternalReloadEffect.of(null))
    } else if (effect.is(undidExternalReloadEffect)) {
      inverted.push(externalReloadEffect.of(null))
    }
  }
  return inverted
})

/**
 * Holds the history field with a value from outside (the undo history of the
 * previous editor, or one rebuilt from disk). The history field takes a new
 * initial value whenever it meets a new `init` while the configuration is
 * reconfigured; nothing else is touched by that, in particular not the text,
 * the selection or the scroll position.
 */
const undoHistoryCompartment = new Compartment()

/** What was already warned about, so that a changed internal structure of CodeMirror is reported once */
const warnedAboutUndoHistoryShape = new Set<string>()

function warnAboutUndoHistoryShape (purpose: string): void {
  if (!warnedAboutUndoHistoryShape.has(purpose)) {
    warnedAboutUndoHistoryShape.add(purpose)
    console.warn(`The internal structure of the CodeMirror history is not the expected one (${purpose}); falling back.`)
  }
}

/**
 * The part of an event of the CodeMirror history (an internal class of
 * @codemirror/commands 6.11) that this module reads.
 */
interface UndoHistoryEventLike {
  changes: ChangeSet|undefined
  effects: readonly unknown[]
  mapped: unknown
  startSelection: unknown
  selectionsAfter: readonly unknown[]
}

/**
 * Checks that something looks like an event of the CodeMirror history: the
 * internal structure is not part of the public API of CodeMirror.
 *
 * @param   {unknown}  event  The candidate
 *
 * @return  {boolean}         True if it has the shape that this module relies on
 */
function isUndoHistoryEvent (event: unknown): event is UndoHistoryEventLike {
  if (typeof event !== 'object' || event === null) {
    return false
  }
  const candidate = event as Record<string, unknown>
  const changes = candidate.changes
  const changesOkay = changes === undefined ||
    (typeof changes === 'object' && changes !== null && typeof (changes as { iterChanges?: unknown }).iterChanges === 'function')
  return changesOkay &&
    Array.isArray(candidate.effects) &&
    Array.isArray(candidate.selectionsAfter) &&
    'mapped' in candidate &&
    'startSelection' in candidate &&
    typeof candidate.constructor === 'function'
}

/**
 * Reads the two branches of a value of the history field. Returns undefined if
 * the value does not have the expected structure.
 *
 * @param   {unknown}  value  The value of the history field
 *
 * @return  {object|undefined}  The events of the undo (`done`) and redo (`undone`) branch
 */
function readUndoHistoryBranches (value: unknown): { done: UndoHistoryEventLike[], undone: UndoHistoryEventLike[] }|undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const { done, undone } = value as { done?: unknown, undone?: unknown }
  if (!Array.isArray(done) || !Array.isArray(undone)) {
    return undefined
  }
  if (!done.every(isUndoHistoryEvent) || !undone.every(isUndoHistoryEvent)) {
    return undefined
  }
  return { done, undone }
}

// The estimate of an event never changes, and neither does the one of a whole
// history value (both are immutable), so every object is measured only once.
// Switching tabs therefore does not walk through the whole history again, and
// a history that gained one group measures only that group.
const undoHistoryEventBytes = new WeakMap<object, number>()
const undoHistoryValueBytes = new WeakMap<object, number>()

/**
 * Estimates the memory of one value of the history field in bytes: 200 bytes
 * for every group plus two bytes for every UTF-16 code unit of text that the
 * (inverse) changes of the groups insert; both branches count. If the internal
 * structure of the history is not the expected one, every group counts with
 * 200 bytes.
 *
 * @param   {unknown}      value  The value of the history field
 * @param   {EditorState}  state  The state the value belongs to (for the fallback)
 *
 * @return  {number}              The estimate
 */
export function estimateUndoHistoryBytes (value: unknown, state: EditorState): number {
  const isObject = typeof value === 'object' && value !== null
  if (isObject) {
    const cached = undoHistoryValueBytes.get(value)
    if (cached !== undefined) {
      return cached
    }
  }

  let bytes = 0
  const branches = readUndoHistoryBranches(value)
  if (branches === undefined) {
    warnAboutUndoHistoryShape('estimate')
    bytes = UNDO_HISTORY_BYTES_PER_EVENT * (undoDepth(state) + redoDepth(state))
  } else {
    for (const event of [ ...branches.done, ...branches.undone ]) {
      let eventBytes = undoHistoryEventBytes.get(event)
      if (eventBytes === undefined) {
        let codeUnits = 0
        event.changes?.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => { codeUnits += inserted.length })
        eventBytes = UNDO_HISTORY_BYTES_PER_EVENT + UNDO_HISTORY_BYTES_PER_CODE_UNIT * codeUnits
        undoHistoryEventBytes.set(event, eventBytes)
      }
      bytes += eventBytes
    }
  }

  if (isObject) {
    undoHistoryValueBytes.set(value, bytes)
  }
  return bytes
}

/**
 * An undo history from an earlier editor of the same document, together with
 * the text and the selection it belongs to.
 */
interface CarriedUndoHistory {
  value: unknown
  text: Text
  selection?: EditorSelection
}

/**
 * Takes the undo history out of a persistent state.
 *
 * @param   {EditorViewPersistentState}  persistentState  The persistent state
 *
 * @return  {CarriedUndoHistory|undefined}                The history, or undefined if there is none
 */
function carriedUndoHistory (persistentState: EditorViewPersistentState): CarriedUndoHistory|undefined {
  const { undoHistory, selection } = persistentState
  return undoHistory === undefined ? undefined : { value: undoHistory.value, text: undoHistory.text, selection }
}

/**
 * Checks the shape of the external step that the document authority returned
 * with a document (specification C20 section 7).
 *
 * @param   {unknown}  step  The value from the authority
 *
 * @return  {object|undefined}  The forward change (still JSON) and the length of the text it applies to
 */
function parseExternalStep (step: unknown): { forward: unknown[], oldLength: number }|undefined {
  if (typeof step !== 'object' || step === null || Array.isArray(step)) {
    return undefined
  }
  const { forward, oldLength } = step as { forward?: unknown, oldLength?: unknown }
  if (!Array.isArray(forward) || typeof oldLength !== 'number') {
    return undefined
  }
  return { forward, oldLength }
}

/**
 * Appends the external modification as one more group to an undo history: on a
 * temporary state without collab, with the history to extend, one transaction
 * with the forward change is dispatched, isolated from the groups around it and
 * marked as the reload of an external modification. Returns undefined if the
 * step does not fit (wrong length, or the change does not turn the text of the
 * history into the new text); throws if the step is malformed.
 *
 * @param   {CarriedUndoHistory}  carried       The history to extend
 * @param   {unknown}             externalStep  The step from the document authority
 * @param   {Text}                newDocument   The text the authority returned
 *
 * @return  {object|undefined}                  The extended value of the history field
 */
function appendExternalStep (carried: CarriedUndoHistory, externalStep: unknown, newDocument: Text): { value: unknown }|undefined {
  const step = parseExternalStep(externalStep)
  if (step === undefined || carried.text.length !== step.oldLength) {
    return undefined
  }
  const forward = ChangeSet.fromJSON(step.forward)
  if (!forward.apply(carried.text).eq(newDocument)) {
    return undefined
  }
  const temporary = EditorState.create({
    doc: carried.text,
    selection: carried.selection,
    extensions: [
      history({ minDepth: UNDO_HISTORY_MIN_DEPTH }),
      externalReloadInversion,
      historyField.init(() => carried.value)
    ]
  })
  const transaction = temporary.update({
    changes: forward,
    effects: externalReloadEffect.of(null),
    annotations: isolateHistory.of('full'),
    userEvent: 'external.reload'
  })
  return { value: transaction.state.field(historyField) }
}

/**
 * Steps 1 and 2 of installing an undo history that an earlier editor of the
 * same document left behind (requirement R135): the history fits as it is if
 * the text is the same, and fits with one more group if the text is the one
 * that the external step produced. Any exception counts as "does not fit".
 *
 * @param   {CarriedUndoHistory}  carried       The history of the earlier editor
 * @param   {Text}                newDocument   The text the authority returned
 * @param   {unknown}             externalStep  The external step, if the authority returned one
 *
 * @return  {object|undefined}                  The value to install, or undefined if the history does not fit
 */
function restoreCarriedUndoHistory (carried: CarriedUndoHistory, newDocument: Text, externalStep: unknown): { value: unknown }|undefined {
  try {
    if (carried.text.eq(newDocument)) {
      return { value: carried.value }
    }
    return appendExternalStep(carried, externalStep, newDocument)
  } catch (err) {
    console.error('Could not restore the undo history of the document from memory', err)
    return undefined
  }
}

/** The answer of the document authority to a request for the undo history, once its shape is checked */
interface UndoHistoryAnswer {
  version: number
  history: { done: unknown[], undone: unknown[] }
  externalEventIndexes: number[]
}

/**
 * Accepts the answer of the document authority only if it is an object with a
 * numeric `version`, a `history` whose `done` is an array and an
 * `externalEventIndexes` array. `null` (no history), an array, an error object
 * and any other shape count as no history.
 *
 * @param   {unknown}  answer  The answer
 *
 * @return  {UndoHistoryAnswer|undefined}  The checked answer, or undefined
 */
function parseUndoHistoryAnswer (answer: unknown): UndoHistoryAnswer|undefined {
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) {
    return undefined
  }
  const { version, history, externalEventIndexes } = answer as { version?: unknown, history?: unknown, externalEventIndexes?: unknown }
  if (typeof version !== 'number' || typeof history !== 'object' || history === null || !Array.isArray(externalEventIndexes)) {
    return undefined
  }
  const { done, undone } = history as { done?: unknown, undone?: unknown }
  if (!Array.isArray(done)) {
    return undefined
  }
  return {
    version,
    history: { done, undone: Array.isArray(undone) ? undone : [] },
    externalEventIndexes: externalEventIndexes.filter((index): index is number => typeof index === 'number')
  }
}

/**
 * Gives the groups at the given indexes of the undo branch the mark of an
 * external reload. The JSON of the CodeMirror history does not contain effects,
 * so the groups are rebuilt: every listed group becomes an instance of the same
 * class with its own changes, selections and mapping and the effect that undoing
 * an external reload carries, and the history is rebuilt around them. This
 * relies on the internal structure of @codemirror/commands 6.11, so it checks
 * the shape of what it works on and of what it builds; if anything does not
 * match, it warns once and returns the history unmarked (undoing then still
 * works, only the notice that an external reload was undone is not shown).
 *
 * @param   {unknown}   value    The value of the history field
 * @param   {number[]}  indexes  The indexes of the groups of the undo branch
 *
 * @return  {unknown}            The marked value, or the given one
 */
function markExternalEvents (value: unknown, indexes: readonly number[]): unknown {
  if (indexes.length === 0) {
    return value
  }
  try {
    const branches = readUndoHistoryBranches(value)
    const historyClass = (value as { constructor?: unknown }).constructor
    if (branches === undefined || typeof historyClass !== 'function') {
      warnAboutUndoHistoryShape('mark')
      return value
    }

    const done = branches.done.slice()
    const marked: number[] = []
    for (const index of indexes) {
      const event = done[index]
      if (!Number.isInteger(index) || event === undefined || event.changes === undefined) {
        continue // Not a group of the branch (the import checks the indexes, too)
      }
      const eventClass = event.constructor as new (...parameters: unknown[]) => UndoHistoryEventLike
      done[index] = new eventClass(event.changes, [ ...event.effects, undidExternalReloadEffect.of(null) ], event.mapped, event.startSelection, event.selectionsAfter)
      marked.push(index)
    }
    if (marked.length === 0) {
      return value
    }

    const { prevTime, prevUserEvent } = value as { prevTime?: unknown, prevUserEvent?: unknown }
    const rebuilt = new (historyClass as new (...parameters: unknown[]) => unknown)(done, branches.undone, prevTime, prevUserEvent)

    // The result must be a history with the same groups, and the marked ones
    // must carry the effect; otherwise the structure is not the expected one
    const check = readUndoHistoryBranches(rebuilt)
    const markedCorrectly = check !== undefined &&
      check.done.length === done.length &&
      check.undone.length === branches.undone.length &&
      marked.every(index => check.done[index].effects.some(effect => effect instanceof StateEffect && effect.is(undidExternalReloadEffect)))
    if (!markedCorrectly) {
      warnAboutUndoHistoryShape('mark')
      return value
    }
    return rebuilt
  } catch (err) {
    warnAboutUndoHistoryShape('mark')
    console.error('Could not mark the external modifications in the undo history', err)
    return value
  }
}

/**
 * Turns the (checked) answer of the document authority into a value of the
 * history field: the JSON is decoded with the public decoder of the state, and
 * the groups that stem from external modifications get their mark.
 *
 * @param   {UndoHistoryAnswer}  answer  The answer
 *
 * @return  {unknown}                    The value of the history field
 */
function buildUndoHistoryFromAnswer (answer: UndoHistoryAnswer): unknown {
  // The decoding does not depend on the document, so an empty one does
  const decoded = EditorState.fromJSON(
    { doc: '', selection: { ranges: [{ anchor: 0, head: 0 }], main: 0 }, history: answer.history },
    {},
    { history: historyField }
  )
  const value = decoded.field(historyField)
  const indexes = answer.externalEventIndexes.filter(index => Number.isInteger(index) && index >= 0 && index < answer.history.done.length)
  return markExternalEvents(value, indexes)
}

export default class MarkdownEditor extends EventEmitter {
  /**
   * The underlying CodeMirror view
   *
   * @var {EditorView}
   */
  private readonly _instance: EditorView
  /**
   * The absolute path to the document represented by this MainEditor instance.
   *
   * @var {string}
   */
  private readonly representedDocument: string
  /**
   * The API method used to synchronize the document with an authority.
   *
   * @var {DocumentAuthorityAPI}
   */
  private readonly authority: DocumentAuthorityAPI
  /**
   * The full editor configuration
   *
   * @var {EditorConfiguration}
   */
  private config: EditorConfiguration

  private destroyed = false
  /**
   * Zettlr-LYH (R124): whether a TOML document shows the reading
   * presentation of the Formatted mode (true) or plain code (Raw Text mode).
   * Ignored for every other document type.
   */
  private formattedTOML = false
  private loadGeneration = 0
  private documentLoaded = false
  private pendingPersistentState?: EditorViewPersistentState
  /**
   * Zettlr-LYH undo history (R135): the load of the document for which the
   * undo history is being requested from the main process, or undefined while
   * no request is under way. As long as a request is under way, the undo
   * history of the editor is empty only because the answer is outstanding, so
   * it must not be taken over by the next editor.
   */
  private undoHistoryRequestGeneration: number|undefined = undefined
  /**
   * Zettlr-LYH data loss prevention (R173): how the editor reaches the
   * recovery journal; undefined if there is no recovery journal, in which case
   * the editor state is replaced without looking for unconfirmed modifications.
   */
  private readonly recoveryJournalAPI: RecoveryJournalAPI|undefined
  /**
   * Zettlr-LYH data loss prevention (R173): the name under which this editor
   * reports to the synchronization health registry that it cannot fetch its
   * document
   */
  private readonly documentFetchReporterId: string
  /**
   * Zettlr-LYH data loss prevention (R173): the push gate of the editor state
   * that the view shows; undefined until the first document has loaded
   */
  private pushGate: PushGate|undefined = undefined
  /**
   * Zettlr-LYH data loss prevention (R173): whether the view shows a state
   * that loadDocument created. It stays true while a later load is under way,
   * unlike documentLoaded.
   */
  private stateHoldsDocument = false
  /**
   * Zettlr-LYH data loss prevention (R173): since when (milliseconds
   * timestamp) the document cannot be fetched for a reload; undefined while
   * fetching works
   */
  private documentFetchFailingSince: number|undefined = undefined
  /**
   * Zettlr-LYH data loss prevention (R173): the pending timer that tries a
   * failed reload again, if any
   */
  private documentReloadRetryTimer: number|undefined = undefined
  /**
   * Zettlr-LYH data loss prevention (R173): whether the last
   * `recoverable-sessions` event of this editor announced at least one session
   */
  private recoverableSessionsAnnounced = false
  /**
   * Zettlr-LYH (R98): how often something navigated within the document
   * (jtl() and every transaction that asks for scrolling). The answer to a
   * request for the stored reading position is void after a navigation.
   */
  private explicitNavigationCount = 0
  /**
   * Zettlr-LYH (R98): the restore of the stored reading position that is under
   * way, if any
   */
  private textReadingRestore?: TextReadingRestore
  /**
   * Zettlr-LYH (R98): the restore that ended last, until the reader scrolls
   * or the document changes
   */
  private textReadingRestored?: TextReadingRestored
  /**
   * Zettlr-LYH (R98): the key under which the restore asks for a measure
   */
  private readonly textReadingRestoreKey = { purpose: 'text-reading-restore' }
  /**
   * Zettlr-LYH (R98): the pending timer that waits for the end of scrolling,
   * if any
   */
  private textReadingPositionTimer: number|undefined = undefined
  /**
   * Zettlr-LYH (R112): the pending animation frame that reports the reading
   * line, if any
   */
  private readingLineFrame: number|undefined = undefined
  /**
   * Zettlr-LYH (R112): reports the reading line after the editor scrolled.
   * Zettlr-LYH (R98): and starts waiting for the end of the scrolling.
   */
  private readonly onEditorScroll = (): void => {
    this.scheduleReadingLineReport()
    this.scheduleTextReadingPositionReport()
  }

  /**
   * The database cache for the various autocompletes.
   *
   * @var {any}
   */
  private readonly databaseCache: {
    tags: TagRecord[]
    citations: Array<{ citekey: string, displayText: string }>
    snippets: Array<{ name: string, content: string }>
    files: Array<{ filename: string, displayName: string, id: string }>
  }

  /**
   * Creates a new MarkdownEditor instance associated with the given leafId and
   * the representedDocument. Immediately after instantiation the editor will
   * pull the document from the given authorityAPI and set it up.
   *
   * NOTE that you will have to append the resulting editor DOM element onto the
   * DOM tree yourself in order for the editor to actually show up. Example:
   *
   * ```ts
   * const editor = new MarkdownEditor(leafId, filePath, api)
   * const container = document.getElementById('container')
   * container.appendChild(editor.dom)
   * ```
   *
   * @param  {string}                leafId               The ID of the leaf
   *                                                      this editor is part of
   * @param  {string}                windowId             The window's ID
   * @param  {string}                representedDocument  The absolute path to
   *                                                      the file that will be
   *                                                      loaded in this editor
   * @param  {DocumentAuthorityAPI}  authorityAPI         The authority API this
   *                                                      editor should use.
   *                                                      Should normally be the
   *                                                      IPC authority.
   * @param  {Function}              textReadingPositionSource  Zettlr-LYH (R98):
   *                                                      asks where the reader
   *                                                      stopped in this file the
   *                                                      last time (see
   *                                                      restoreTextReadingPosition).
   *                                                      Pass it only if there is
   *                                                      no persistentState.
   */
  constructor (
    readonly leafId: string,
    readonly windowId: string,
    representedDocument: string,
    authorityAPI: DocumentAuthorityAPI,
    configOverride?: Partial<EditorConfiguration>,
    persistentState?: EditorViewPersistentState,
    textReadingPositionSource?: () => Promise<unknown>
  ) {
    super() // Set up the event emitter

    this.authority = authorityAPI
    this.representedDocument = representedDocument
    // Zettlr-LYH data loss prevention (R173)
    this.recoveryJournalAPI = authorityAPI.recoveryJournal ?? recoveryJournalIPCAPI
    this.documentFetchReporterId = `document-fetch:${windowId}:${leafId}`

    // Since the editor state needs to be rebuilt from scratch sometimes, we
    // cache the autocomplete databases so that we don't have to re-fetch them
    // everytime.
    this.databaseCache = { tags: [], citations: [], snippets: [], files: [] }

    // Same goes for the config
    this.config = getDefaultConfig()
    // TODO: This is bad style imho
    this.config.metadata.path = representedDocument
    if (configOverride !== undefined) {
      this.setOptions(configOverride)
    }

    // Create the editor ...
    this._instance = new EditorView({
      state: undefined,
      parent: undefined
    })

    // Zettlr-LYH (R112): the scroller survives state changes, so one listener
    // suffices for the lifetime of the editor
    this._instance.scrollDOM.addEventListener('scroll', this.onEditorScroll, { passive: true })

    // ... and immediately begin loading the document
    this.loadDocument(persistentState).catch(err => console.error(err))

    // Zettlr-LYH (R98): without a remembered position, ask for the stored one
    if (textReadingPositionSource !== undefined) {
      this.restoreTextReadingPosition(textReadingPositionSource).catch(err => console.error(err))
    }
  }

  /**
   * Returns the correct set of extensions for the given document
   *
   * @param   {string}        filePath      The file path
   * @param   {DocumentType}  type          The type of file we're dealing with
   * @param   {number}        startVersion  The initial synchronization number
   * @param   {PushGate}      pushGate      Zettlr-LYH data loss prevention
   *                                        (R173): the gate through which the
   *                                        pushes of the new state pass
   *
   * @return  {Extension[]}                 The extension set
   */
  private _getExtensions (filePath: string, type: DocumentType, startVersion: number, pushGate: PushGate): Extension[] {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const editorInstance = this

    // Zettlr-LYH data loss prevention (R173): every push of this state passes
    // its gate. The authority is called before this function returns, because
    // the last push of a state that is being destroyed has to be on its way by
    // then, and its answer is handed on as it is.
    const pushUpdates: PushUpdateCallback = (pushedFilePath, version, updates) => {
      if (pushGate.closed) {
        return Promise.resolve(false)
      }
      const push = this.authority.pushUpdates(pushedFilePath, version, updates)
      const answered: Promise<void> = Promise.resolve(push)
        .then(() => undefined, () => undefined)
        .then(() => { pushGate.inFlight.delete(answered) })
      pushGate.inFlight.add(answered)
      return push
    }

    // Zettlr-LYH data loss prevention (R173, specification C21 section 5.5):
    // every editor state writes its own session of the recovery journal
    const recoveryJournalExtension: Extension = this.recoveryJournalAPI === undefined
      ? []
      : recoveryJournal({ filePath, windowId: this.windowId, leafId: this.leafId, api: this.recoveryJournalAPI })

    const options: CoreExtensionOptions = {
      initialConfig: JSON.parse(JSON.stringify(this.config)),
      remoteConfig: {
        filePath,
        startVersion,
        pullUpdates: this.authority.pullUpdates,
        pushUpdates
      },
      updateListener: (update) => {
        if (this.pendingPersistentState !== undefined && update.geometryChanged) {
          this.completePersistentStateAfterMeasure(this.loadGeneration)
        }

        // Zettlr-LYH (R98): a navigation voids the answer to a request for the
        // stored reading position; a restore that waits for the editor to
        // become measurable tries again when the geometry changes
        if (update.transactions.some(hasScrollRequest)) {
          this.explicitNavigationCount++
        }
        if (this.textReadingRestore?.position !== undefined && update.geometryChanged) {
          this.scheduleTextReadingRestore()
        }
        // Zettlr-LYH (R98): after a change of the text, the line numbers of the
        // stored position may point elsewhere
        if (update.docChanged) {
          this.textReadingRestored = undefined
        }

        // Listen for changes and emit events appropriately
        if (update.docChanged) {
          this.emit('change')
        }

        // Zettlr-LYH (R112): edits and size changes can move the reading line
        // without a scroll event; selection changes alone cannot
        if (update.docChanged || update.geometryChanged) {
          this.scheduleReadingLineReport()
        }

        if (update.focusChanged && this._instance.hasFocus) {
          this.emit('focus')
        }

        if (update.selectionSet) {
          this.emit('cursorActivity')
          this.emit('docUpdate')
        }

        for (const transaction of update.transactions) {
          for (const effect of transaction.effects) {
            // Listen for word count updates
            if (effect.is(updateWordCountEffect)) {
              this.emit('docUpdate')
            }

            // Listen for config updates, and parse them into the internal cache. We
            // do it this way, because the editor itself is also capable of changing
            // its configuration (e.g., via the statusbar). This way we ensure that
            // both external updates (via setOptions) as well as internal updates
            // both end up in our cache.
            if (effect.is(reloadStateEffect)) {
              // ATTENTION: The document state is out of sync with the document
              // authority, so we must reload it.
              this.reload().catch(err => console.error('Could not reload document state', err))
              return
            }

            // Zettlr-LYH undo history (R135): an undo took back the reload of
            // an external modification. The mark travels with the group of the
            // history, so a redo (which carries the opposite mark) and the
            // groups around it do not report.
            if (effect.is(undidExternalReloadEffect) && transaction.isUserEvent('undo')) {
              this.emit('undid-external-reload')
            }
          }
        }
      },
      domEventsListeners: clickListeners({
        onWikiLink (url) {
          editorInstance.emit('zettelkasten-link', url)
        },
        onTag (tag) {
          editorInstance.emit('zettelkasten-tag', tag)
        }
      })
    }

    switch (type) {
      case DocumentType.Markdown:
        return [ ...getMarkdownExtensions(options), recoveryJournalExtension ]
      case DocumentType.LaTeX:
        return [ ...getTexExtensions(options), recoveryJournalExtension ]
      case DocumentType.YAML:
        return [ ...getYAMLExtensions(options), recoveryJournalExtension ]
      case DocumentType.JSON:
        return [ ...getJSONExtensions(options), recoveryJournalExtension ]
      case DocumentType.JSONL:
        return [ ...getJSONLExtensions(options), recoveryJournalExtension ]
      case DocumentType.TOML:
        return [ ...(this.formattedTOML ? getFormattedTOMLExtensions(options) : getTOMLExtensions(options)), recoveryJournalExtension ]
    }
  }

  /**
   * Zettlr-LYH (R124): switches a TOML document between the Formatted mode
   * (formatted is true) and the Raw Text mode. Only the presentation
   * compartment is reconfigured: the editor state, and with it the document,
   * the selection, the undo history and any unsaved changes, stays as it is,
   * and nothing is sent to the document authority. The source position at the
   * viewport anchor keeps its height on screen. Called before the document
   * has loaded, the mode applies once it loads; documents of other types
   * ignore the call.
   *
   * @param  {boolean}  formatted  Whether to show the Formatted mode
   */
  setTOMLPresentation (formatted: boolean): void {
    if (this.destroyed || this.formattedTOML === formatted) {
      return
    }
    this.formattedTOML = formatted
    if (!this.documentLoaded || tomlPresentationCompartment.get(this._instance.state) === undefined) {
      return
    }

    // A pending restore of the reading position must not be overridden
    const anchor = this.pendingPersistentState === undefined ? findViewportAnchor(this._instance) : null
    const effects: Array<StateEffect<any>> = [
      tomlPresentationCompartment.reconfigure(formatted ? formattedTOMLPresentation() : [])
    ]
    if (anchor !== null) {
      effects.push(EditorView.scrollIntoView(anchor.position, { y: 'start', yMargin: anchor.rowTop }))
    }
    this._instance.dispatch({ effects })
  }

  /**
   * Loads the document from main and sets up everything required to display and
   * edit it.
   *
   * Zettlr-LYH undo history (R135): the undo history of the document is
   * installed in four attempts, in this order. (1) The undo history of the
   * persistent state (or, with keepUndoHistory, of the editor as it is now) fits
   * if its text is the text that the authority returned. (2) It fits with one
   * more group if the authority returned the external step that turns its text
   * into the returned one. (3) Otherwise, if the authority can, the undo history
   * is requested from the records on disk, in the background, after the document
   * is displayed. (4) Otherwise it is empty. Installing it changes neither text
   * nor selection nor scroll position, and nothing is sent to the authority.
   *
   * Zettlr-LYH data loss prevention (R173, specification C21 section 6): this
   * method is the only place that replaces the editor state. A state that
   * holds a document is not replaced before its local modifications that the
   * authority has not confirmed are accounted for: the new content contains
   * them already (`replace`), or they are dispatched again onto the new state
   * (`replay`), or they stay behind in the recovery journal as a session that
   * can be recovered (`preserve`); see `decideReplacement`. If the document
   * cannot be fetched, a state that holds a document stays as it is, the file
   * is reported as stalled, and the reload is tried again after
   * PULL_FALLBACK_INTERVAL_MS. After every load the recoverable sessions of
   * the file are reviewed (see `reviewRecoverableSessions`).
   *
   * @param  {EditorViewPersistentState}  persistentState  Optional state to restore
   * @param  {boolean}                    focusAfterLoad   Whether to focus the editor once loaded
   * @param  {boolean}                    keepUndoHistory  Whether the undo history of the editor
   *                                                       as it is now is a candidate for the
   *                                                       new state (a reload); a persistent
   *                                                       state brings its own
   *
   * @return {Promise<boolean>}                            Whether the editor state was replaced
   */
  async loadDocument (persistentState?: EditorViewPersistentState, focusAfterLoad = true, keepUndoHistory = false): Promise<boolean> {
    if (this.destroyed) {
      return false
    }
    const generation = ++this.loadGeneration
    // Zettlr-LYH undo history (R135): what the editor knew before this load
    const wasLoaded = this.documentLoaded
    const previousPending = this.pendingPersistentState
    const historyRequestWasPending = this.undoHistoryRequestGeneration !== undefined
    this.undoHistoryRequestGeneration = undefined
    this.documentLoaded = false
    this.pendingPersistentState = persistentState

    // Zettlr-LYH data loss prevention (R173): fetch the new content, then
    // decide what happens to the unconfirmed local modifications. Nothing is
    // awaited between the decision that ends this loop and the replacement of
    // the state, so the decision is about the very state that is replaced.
    let fetched: Awaited<ReturnType<FetchDoc>>
    let snapshot: RecoveryJournalSnapshot|undefined
    let verdict: ReplacementVerdict = 'replace'
    for (let attempt = 1; ; attempt++) {
      try {
        fetched = await this.authority.fetchDoc(this.representedDocument)
      } catch (err) {
        if (this.destroyed || generation !== this.loadGeneration) {
          return false
        }
        if (!this.stateHoldsDocument) {
          // The first load: there is no state to keep
          throw err
        }
        // The editor keeps its state and its text. The next reload asks the
        // records on disk for the undo history again if this one would have.
        this.documentLoaded = true
        this.pendingPersistentState = previousPending
        this.undoHistoryRequestGeneration = historyRequestWasPending ? generation : undefined
        this.retryReloadAfterFailedFetch(err)
        return false
      }
      if (this.destroyed || generation !== this.loadGeneration) {
        return false
      }

      snapshot = this.recoveryJournalAPI === undefined ? undefined : getRecoveryJournalSnapshot(this._instance)
      if (snapshot === undefined) {
        // No recovery journal, or a view that does not show a document yet
        verdict = 'replace'
        break
      }

      const currentPushGate = this.pushGate
      const pushesInFlight = currentPushGate !== undefined && currentPushGate.inFlight.size > 0
      verdict = decideReplacement({
        hasUnconfirmedChanges: snapshot.unconfirmedLocalSteps.length > 0,
        newContent: fetched.content,
        currentContent: this._instance.state.doc.toString(),
        lastConfirmedContent: snapshot.lastConfirmedDocument.toString(),
        // A push in flight can still be accepted. A replay would then put the
        // steps it carries into the document a second time.
        canReplay: snapshot.replayable && !pushesInFlight
      })
      if (verdict === 'replace' || currentPushGate === undefined || !pushesInFlight || attempt >= REPLACEMENT_FETCH_ATTEMPTS) {
        break
      }

      // The answer to the push in flight tells how many of the unconfirmed
      // modifications the authority has. Wait for it, then fetch once more.
      await this.waitForPushesInFlight(currentPushGate)
      if (this.destroyed || generation !== this.loadGeneration) {
        return false
      }
    }
    const { content, type, startVersion, externalStep } = fetched

    // Zettlr-LYH undo history (R135): the candidate is taken now, from the state
    // that is about to be replaced (it may have changed while waiting)
    let carried: CarriedUndoHistory|undefined
    if (persistentState !== undefined) {
      carried = carriedUndoHistory(persistentState)
    } else if (keepUndoHistory) {
      if (!wasLoaded) {
        carried = previousPending === undefined ? undefined : carriedUndoHistory(previousPending)
      } else if (!historyRequestWasPending) {
        carried = this.currentUndoHistory()
      }
    }
    const newDocument = Text.of(content.split('\n'))
    const restored = carried === undefined ? undefined : restoreCarriedUndoHistory(carried, newDocument, externalStep)

    // The documents contents have changed, so we must recreate the state
    const pushGate: PushGate = { closed: false, inFlight: new Set() }
    const extensions = this._getExtensions(this.representedDocument, type, startVersion, pushGate)
    // This particular editor type needs access to the window and leaf IDs
    extensions.push(editorMetadataFacet.of({ windowId: this.windowId, leafId: this.leafId }))
    // Zettlr-LYH undo history (R135): the marks of external reloads travel with
    // the groups of the history, and the history may start with a value
    extensions.push(externalReloadInversion)
    extensions.push(undoHistoryCompartment.of(restored === undefined ? [] : historyField.init(() => restored.value)))

    const state = EditorState.create({
      doc: newDocument,
      extensions,
      selection: persistentState === undefined ? undefined : EditorSelection.create(
        persistentState.selection.ranges.map(range => EditorSelection.range(
          Math.min(range.anchor, content.length), Math.min(range.head, content.length)
        )), persistentState.selection.mainIndex
      )
    })

    // Zettlr-LYH data loss prevention (R173): replacing the state destroys the
    // plugins of the old one. That is when the old state sends its last push
    // and ends its session of the recovery journal, so both are told
    // beforehand what is happening.
    const previousDocument = this._instance.state.doc
    if (snapshot !== undefined) {
      // The end record names the reload and counts the unconfirmed steps
      setRecoveryJournalEndReason(this._instance, 'reload')
    }
    if (verdict === 'replay' && this.pushGate !== undefined) {
      // The new state sends the replayed steps. If the last push of the old
      // state were accepted as well, they would be in the document twice.
      this.pushGate.closed = true
    }

    this._instance.setState(state)
    this.documentLoaded = true
    this.stateHoldsDocument = true
    this.pushGate = pushGate
    this.cancelDocumentReloadRetry()
    this.withdrawDocumentFetchFailure()

    if (persistentState !== undefined) {
      // Now that the correct document has been loaded, there will be content
      // and we can restore the persisted information.
      const { scrollSnapshot, foldedRanges } = persistentState

      const effects: StateEffect<any>[] = [scrollSnapshot]

      const cursor = foldedRanges.iter()
      while (cursor.value) {
        if (cursor.from < cursor.to && cursor.to <= state.doc.length) {
          effects.push(foldEffect.of({ from: cursor.from, to: cursor.to }))
        }
        cursor.next()
      }

      this._instance.dispatch({ effects })
      this.completePersistentStateAfterMeasure(generation)
    }

    // Ensure the theme switcher picks the state change up; this somehow doesn't
    // properly work after the document has been mounted to the DOM.
    this._instance.dispatch({ effects: configUpdateEffect.of(this.config) })

    // Provide the cached databases to the state (can be overridden by the
    // caller afterwards by calling setCompletionDatabase)
    this._instance.dispatch({ effects: tagsUpdate.of(this.databaseCache.tags) })
    this._instance.dispatch({ effects: citekeyUpdate.of(this.databaseCache.citations) })
    this._instance.dispatch({ effects: snippetsUpdate.of(this.databaseCache.snippets) })
    this._instance.dispatch({ effects: filesUpdate.of(this.databaseCache.files) })

    // Determine if this is a code doc and add the corresponding class to the
    // outer content DOM so that we can style it.
    if (type !== DocumentType.Markdown) {
      this._instance.contentDOM.classList.add('code')
    }

    // Zettlr-LYH data loss prevention (R173): the new content is what the
    // unconfirmed modifications were made on, so they are made once more. They
    // enter the undo history, the new session of the recovery journal, and the
    // pushes of the new state.
    let replayedSessionId: string|undefined
    if (verdict === 'replay' && snapshot !== undefined && this.replayUnconfirmedSteps(snapshot.unconfirmedLocalSteps, previousDocument)) {
      replayedSessionId = snapshot.sessionId
    }

    if (focusAfterLoad) {
      this._instance.focus()
    }

    this.emit('loaded')
    this.scheduleReadingLineReport()

    // Zettlr-LYH (R98): the stored reading position may have arrived earlier
    this.scheduleTextReadingRestore()

    // Zettlr-LYH undo history (R135): nothing from memory fits, so the history
    // is requested from the records on disk. The document is displayed already;
    // the answer is installed when it arrives, if nothing happened meanwhile.
    if (restored === undefined && this.authority.fetchUndoHistory !== undefined) {
      this.installUndoHistoryFromDisk(generation, startVersion, state.doc)
        .catch(err => console.error('Could not restore the undo history from disk', err))
    }

    // Zettlr-LYH data loss prevention (R173): the document is displayed
    // already; whether input from an earlier session is missing in it turns
    // out in the background.
    if (this.recoveryJournalAPI !== undefined) {
      this.reviewRecoverableSessions(this.recoveryJournalAPI, generation, content, replayedSessionId)
        .catch(err => console.warn(`Could not review the recoverable sessions of ${this.representedDocument}`, err))
    }

    return true
  }

  /**
   * Zettlr-LYH data loss prevention (R173): resolves once every push that the
   * gate has let through is answered, but after PULL_FALLBACK_INTERVAL_MS at
   * the latest.
   *
   * @param  {PushGate}  pushGate  The gate of the editor state whose pushes to wait for
   */
  private async waitForPushesInFlight (pushGate: PushGate): Promise<void> {
    let timer: ReturnType<typeof setTimeout>|undefined
    const timeout = new Promise<void>(resolve => { timer = setTimeout(resolve, PULL_FALLBACK_INTERVAL_MS) })
    await Promise.race([ Promise.all([...pushGate.inFlight]), timeout ])
    clearTimeout(timer)
  }

  /**
   * Zettlr-LYH data loss prevention (R173): a reload could not fetch the
   * document. Reports the file as stalled and tries the reload again after
   * PULL_FALLBACK_INTERVAL_MS; the report is withdrawn by the load that
   * succeeds (or when the editor is unmounted).
   *
   * @param  {unknown}  error  Why the document could not be fetched
   */
  private retryReloadAfterFailedFetch (error: unknown): void {
    const now = Date.now()
    if (this.documentFetchFailingSince === undefined) {
      this.documentFetchFailingSince = now
    }
    reportSyncHealth(this.representedDocument, this.documentFetchReporterId, {
      status: 'stalled',
      stalledForMs: now - this.documentFetchFailingSince,
      stalledSince: this.documentFetchFailingSince,
      reason: SYNC_STALL_REASON_DOCUMENT_FETCH_FAILED
    })
    console.error(`Could not fetch ${this.representedDocument} to reload it; the editor keeps its state and tries again in ${PULL_FALLBACK_INTERVAL_MS} ms`, error)

    this.cancelDocumentReloadRetry()
    this.documentReloadRetryTimer = documentReloadRetryTimers.start(() => {
      this.documentReloadRetryTimer = undefined
      this.reload().catch(err => console.error('Could not reload document state', err))
    }, PULL_FALLBACK_INTERVAL_MS)
  }

  /**
   * Zettlr-LYH data loss prevention (R173): cancels the pending retry of a
   * failed reload, if any.
   */
  private cancelDocumentReloadRetry (): void {
    if (this.documentReloadRetryTimer !== undefined) {
      documentReloadRetryTimers.cancel(this.documentReloadRetryTimer)
      this.documentReloadRetryTimer = undefined
    }
  }

  /**
   * Zettlr-LYH data loss prevention (R173): withdraws the report that the
   * document cannot be fetched, if this editor has made one.
   */
  private withdrawDocumentFetchFailure (): void {
    if (this.documentFetchFailingSince !== undefined) {
      this.documentFetchFailingSince = undefined
      clearSyncHealthReporter(this.representedDocument, this.documentFetchReporterId)
    }
  }

  /**
   * Zettlr-LYH data loss prevention (R173, specification C21 section 6):
   * dispatches the unconfirmed local modifications of the replaced state onto
   * the new one, in their order and with their user events. Every step forms
   * an undo group of its own.
   *
   * @param   {UnconfirmedLocalStep[]}  steps             The modifications; the first one applies
   *                                                      to the document of the new state
   * @param   {Text}                    expectedDocument  The document of the replaced state
   *
   * @return  {boolean}                                   Whether the editor now shows the expected
   *                                                      document. If not, the session of the
   *                                                      replaced state has to stay recoverable.
   */
  private replayUnconfirmedSteps (steps: readonly UnconfirmedLocalStep[], expectedDocument: Text): boolean {
    try {
      for (const step of steps) {
        this._instance.dispatch({ changes: step.changes, annotations: isolateHistory.of('full'), userEvent: step.userEvent })
      }
    } catch (err) {
      console.error(`Could not replay the unconfirmed modifications of ${this.representedDocument}; they stay in the recovery journal`, err)
      return false
    }

    if (!this._instance.state.doc.eq(expectedDocument)) {
      console.error(`Replaying the unconfirmed modifications of ${this.representedDocument} did not lead to the text from before the reload; they stay in the recovery journal`)
      return false
    }

    return true
  }

  /**
   * Zettlr-LYH data loss prevention (R173, specification C21 section 6): looks
   * for sessions of this file that ended with unconfirmed modifications. A
   * session whose text is the loaded content misses nothing and is settled as
   * `delivered`. The others are announced with the event
   * `recoverable-sessions` (the newest first), for the user to decide. A
   * recovery journal that cannot be reached only leaves a warning on the
   * console.
   *
   * @param  {RecoveryJournalAPI}  api                How the recovery journal is reached
   * @param  {number}              generation         The load after which this review runs
   * @param  {string}              loadedContent      The content that the load fetched
   * @param  {string|undefined}    replayedSessionId  The session whose unconfirmed modifications
   *                                                  the load has replayed, if any. They are part
   *                                                  of the new session now.
   */
  private async reviewRecoverableSessions (
    api: RecoveryJournalAPI,
    generation: number,
    loadedContent: string,
    replayedSessionId: string|undefined
  ): Promise<void> {
    let sessions: RecoverableSession[]
    try {
      if (replayedSessionId !== undefined) {
        await api.resolve(this.representedDocument, replayedSessionId, 'delivered')
      }
      sessions = await api.listRecoverable(this.representedDocument)
    } catch (err) {
      console.warn(`Could not ask the recovery journal for the recoverable sessions of ${this.representedDocument}`, err)
      return
    }

    const { delivered, undecided } = splitRecoverableSessions(sessions, loadedContent)
    for (const session of delivered) {
      try {
        await api.resolve(this.representedDocument, session.sessionId, 'delivered')
      } catch (err) {
        console.warn(`Could not settle the recovery journal session ${session.sessionId} of ${this.representedDocument}`, err)
      }
    }

    if (this.destroyed || generation !== this.loadGeneration) {
      return // Whoever loads the document next reviews the sessions again
    }

    // An empty list is only announced to take back an earlier announcement
    if (undecided.length > 0 || this.recoverableSessionsAnnounced) {
      this.recoverableSessionsAnnounced = undecided.length > 0
      this.emit('recoverable-sessions', undecided)
    }
  }

  /**
   * Zettlr-LYH data loss prevention (R173): returns the way to the recovery
   * journal for the methods that settle a recoverable session.
   *
   * @return  {RecoveryJournalAPI}  How the recovery journal is reached
   */
  private requireRecoveryJournalAPI (): RecoveryJournalAPI {
    if (this.recoveryJournalAPI === undefined) {
      throw new Error('This editor has no recovery journal')
    }
    return this.recoveryJournalAPI
  }

  /**
   * Zettlr-LYH data loss prevention (R173, specification C21 section 6), the
   * choice "Restore": makes the text of the session the text of the document,
   * as one modification that the user can undo, then settles the session as
   * `restored`.
   *
   * @param  {RecoverableSession}  session  A session that `recoverable-sessions` announced
   */
  public async restoreRecoverableSession (session: RecoverableSession): Promise<void> {
    const api = this.requireRecoveryJournalAPI()
    if (this.destroyed || !this.documentLoaded) {
      throw new Error(`Cannot restore the session ${session.sessionId}: the editor shows no document`)
    }

    const replacement = minimalReplacement(this._instance.state.doc.toString(), session.finalText)
    if (replacement !== undefined) {
      this._instance.dispatch({
        // As a Text, so that the lines are the ones of the session, whatever
        // line separator the state uses to split inserted strings
        changes: { from: replacement.from, to: replacement.to, insert: Text.of(replacement.insert.split('\n')) },
        annotations: isolateHistory.of('full'),
        userEvent: 'input.recover'
      })
    }
    if (this._instance.state.doc.toString() !== session.finalText) {
      throw new Error(`Could not write the text of the session ${session.sessionId} into the document`)
    }

    await api.resolve(this.representedDocument, session.sessionId, 'restored')
  }

  /**
   * Zettlr-LYH data loss prevention (R173, specification C21 section 6), the
   * choice "Keep as File": settles the session as `kept-as-file`, which writes
   * its text into a recovery copy, and opens that copy. The text of the editor
   * stays as it is.
   *
   * @param   {RecoverableSession}  session   A session that `recoverable-sessions` announced
   * @param   {Function}            openFile  Opens the file at the given absolute path
   *
   * @return  {Promise<string|undefined>}     The path of the recovery copy; undefined if the
   *                                          session had been settled elsewhere already, so
   *                                          there was nothing to keep
   */
  public async keepRecoverableSessionAsFile (session: RecoverableSession, openFile: (path: string) => Promise<unknown>): Promise<string|undefined> {
    const api = this.requireRecoveryJournalAPI()
    const result = await api.resolve(this.representedDocument, session.sessionId, 'kept-as-file')
    if (!result.resolved) {
      return undefined
    }
    if (result.copyPath === undefined) {
      throw new Error(`The recovery journal returned no recovery copy for the session ${session.sessionId}`)
    }

    await openFile(result.copyPath)
    return result.copyPath
  }

  /**
   * Zettlr-LYH data loss prevention (R173, specification C21 section 6), the
   * choice "Discard": settles the session as `discarded`. The text of the
   * editor stays as it is.
   *
   * @param  {RecoverableSession}  session  A session that `recoverable-sessions` announced
   */
  public async discardRecoverableSession (session: RecoverableSession): Promise<void> {
    const api = this.requireRecoveryJournalAPI()
    await api.resolve(this.representedDocument, session.sessionId, 'discarded')
  }

  /**
   * Zettlr-LYH undo history (R135): requests the undo history of the document
   * from the records on disk and installs it. The answer counts only if it is
   * well-formed, is for the version the editor loaded, and the editor is still
   * what it was when the request was made: not destroyed, not loaded again,
   * still showing the very same text object and without any undo or redo group.
   * Otherwise the answer is dropped. Installing is a reconfiguration that
   * carries the history and nothing else: no change, no selection, no scrolling,
   * no update for the authority.
   *
   * @param   {number}         generation     The load of the document the request belongs to
   * @param   {number}         startVersion   The version of the loaded document
   * @param   {Text}           loadedDocument The text object of the state the load created
   */
  private async installUndoHistoryFromDisk (generation: number, startVersion: number, loadedDocument: Text): Promise<void> {
    const fetchUndoHistory = this.authority.fetchUndoHistory
    if (fetchUndoHistory === undefined) {
      return
    }
    this.undoHistoryRequestGeneration = generation
    try {
      const answer = parseUndoHistoryAnswer(await fetchUndoHistory.call(this.authority, this.representedDocument, startVersion))
      if (this.destroyed || generation !== this.loadGeneration) {
        return
      }
      if (answer === undefined || answer.version !== startVersion) {
        return
      }
      const state = this._instance.state
      if (state.doc !== loadedDocument || undoDepth(state) !== 0 || redoDepth(state) !== 0) {
        return // The reader has edited since: the history of the disk no longer fits
      }
      const value = buildUndoHistoryFromAnswer(answer)
      this._instance.dispatch({ effects: undoHistoryCompartment.reconfigure(historyField.init(() => value)) })
    } finally {
      if (this.undoHistoryRequestGeneration === generation) {
        this.undoHistoryRequestGeneration = undefined
      }
    }
  }

  /**
   * Zettlr-LYH undo history (R135): the undo history of the editor as it is
   * now, with the text and the selection it belongs to.
   *
   * @return  {CarriedUndoHistory|undefined}  The history, or undefined if the state has none
   */
  private currentUndoHistory (): CarriedUndoHistory|undefined {
    const state = this._instance.state
    const value = state.field(historyField, false)
    return value === undefined ? undefined : { value, text: state.doc, selection: state.selection }
  }

  /**
   * Zettlr-LYH (R112): the one-indexed line at one third of the visible height
   * of the editor, measured from the top of its visible area. When the
   * document ends above that point, this is the last line. Undefined while no
   * document is loaded or the editor is not visible.
   *
   * @return  {number|undefined}  The reading line
   */
  get readingLine (): number|undefined {
    if (this.destroyed || !this.documentLoaded) {
      return undefined
    }
    const view = this._instance
    const scroller = view.scrollDOM
    const visibleHeight = scroller.clientHeight
    if (visibleHeight <= 0) {
      return undefined
    }
    const anchorY = scroller.getBoundingClientRect().top + visibleHeight * READING_LINE_FRACTION
    const contentRect = view.contentDOM.getBoundingClientRect()
    let position: number
    try {
      position = view.posAtCoords({ x: contentRect.left + 1, y: anchorY }, false)
    } catch (err) {
      // CodeMirror's coordinate scan can throw while its height map and its
      // rendered lines are out of sync (see the scroll anchor plugin); the
      // height map alone still knows the line block at that height.
      position = view.lineBlockAtHeight(anchorY - view.documentTop).from
    }
    const clamped = Math.max(0, Math.min(position, view.state.doc.length))
    return view.state.doc.lineAt(clamped).number
  }

  /**
   * Zettlr-LYH (R112): emits the reading line as a `reading-line` event in the
   * next animation frame. Further calls before that frame do not schedule
   * another one, so the event fires at most once per frame.
   */
  private scheduleReadingLineReport (): void {
    if (this.destroyed || this.readingLineFrame !== undefined) {
      return
    }
    this.readingLineFrame = readingLineFrames.request(() => {
      this.readingLineFrame = undefined
      if (this.destroyed) {
        return
      }
      const line = this.readingLine
      if (line !== undefined) {
        this.emit('reading-line', line)
      }
    })
  }

  /** Keep the original snapshot until CodeMirror has applied its scroll target. */
  private completePersistentStateAfterMeasure (generation: number): void {
    this._instance.requestMeasure({
      key: this,
      read: view => view.inView && view.scrollDOM.clientHeight > 0,
      write: visible => {
        if (visible) {
          // Measure writes precede CodeMirror's native scrolling in the same
          // cycle. A microtask runs after that cycle, including its scrolling.
          queueMicrotask(() => {
            if (!this.destroyed && generation === this.loadGeneration && this.pendingPersistentState !== undefined) {
              this.pendingPersistentState = undefined
              // Zettlr-LYH: the remembered scroll position may lie in the empty
              // space after the document
              this.keepDocumentTextInView()
            }
          })
        }
      }
    })
  }

  /**
   * Returns an object containing information needed to refresh the entire
   * editor instance after it being unmounted. Request this once before
   * unmounting this instance, and provide it back to a new instance when you
   * re-instantiate the same document again.
   *
   * @return  {EditorViewPersistentState}  The persistent state object.
   */
  public get persistentState (): EditorViewPersistentState|undefined {
    if (this.destroyed) {
      return undefined
    }
    if (!this.documentLoaded) {
      // Zettlr-LYH undo history (R135): the undo history that the pending state
      // brought stays in it, so that it survives leaving before the load ends
      return this.pendingPersistentState
    }
    const persistentState: EditorViewPersistentState = {
      scrollSnapshot: this.pendingPersistentState?.scrollSnapshot ?? this._instance.scrollSnapshot(),
      selection: this._instance.state.selection,
      foldedRanges: this._instance.state.field(foldState, false) ?? Decoration.set([])
    }
    // Zettlr-LYH undo history (R135): the undo and redo stacks go along with
    // the text they belong to. While the history is still being requested from
    // disk, the stacks are empty only because the answer is outstanding; taking
    // them over would keep the next editor from asking again.
    if (this.undoHistoryRequestGeneration === undefined) {
      const current = this.currentUndoHistory()
      if (current !== undefined) {
        persistentState.undoHistory = {
          value: current.value,
          text: current.text,
          estimatedBytes: estimateUndoHistoryBytes(current.value, this._instance.state)
        }
      }
    }
    return persistentState
  }

  /**
   * Zettlr-LYH (R98): the reading position of a text file: the line at the top
   * of the viewport (counted from 1) and how many pixels the top of the
   * viewport lies below the top of that line. After a change of the font size
   * or of the window width, the pair still points to the same piece of text.
   * Undefined if no document is loaded, the editor was destroyed, or it has no
   * measurable geometry (it is not displayed).
   *
   * @return  {TextReadingPosition|undefined}  The reading position
   */
  get textReadingPosition (): TextReadingPosition|undefined {
    if (this.destroyed || !this.documentLoaded) {
      return undefined
    }
    const view = this._instance
    const scroller = view.scrollDOM
    if (scroller.clientHeight <= 0) {
      return undefined
    }
    // The height of the top of the viewport, measured from the top of the
    // document (the same conversion as in readingLine and findViewportAnchor)
    const viewportTop = scroller.getBoundingClientRect().top - view.documentTop
    if (!Number.isFinite(viewportTop)) {
      return undefined
    }
    const height = Math.max(0, viewportTop)
    const block = view.lineBlockAtHeight(height)
    return {
      line: view.state.doc.lineAt(block.from).number,
      offset: Math.max(0, height - block.top)
    }
  }

  /**
   * Zettlr-LYH (R98): the reading position that may be stored for the file. It
   * is the reading position, except while the viewport does not show the place
   * where the reader stopped yet, because a stored position or a remembered
   * one (R75) still waits to be applied (or to be checked and corrected);
   * storing the top of the document, or a position that is still off, then
   * would overwrite the very position that is being restored.
   *
   * After a restore and until the reader scrolls (the scroll position differs
   * from the one at the end of the restore by more than 2 pixels) or the text
   * changes, it is the position that was restored: the record the main process
   * holds is exactly what the reader last saw there, however close or far the
   * measured position is, and the scrolling that the restore and the scroll
   * stabilization caused is no reason to change it.
   *
   * @return  {TextReadingPosition|undefined}  The position to store
   */
  get persistableTextReadingPosition (): TextReadingPosition|undefined {
    if (this.textReadingRestore !== undefined || this.pendingPersistentState !== undefined) {
      return undefined
    }
    const position = this.textReadingPosition
    const restored = this.textReadingRestored
    if (
      position !== undefined && restored !== undefined && restored.generation === this.loadGeneration &&
      Math.abs(this._instance.scrollDOM.scrollTop - restored.scrollTop) <= TEXT_READING_RESTORE_SCROLL_TOLERANCE
    ) {
      return { line: restored.position.line, offset: restored.position.offset }
    }
    return position
  }

  /**
   * Zettlr-LYH (R98): asks for the position where the reader stopped in this
   * file the last time, and scrolls there once the document is loaded and
   * measured. Does nothing else: the document, the cursor, the selection, the
   * folds and the undo history stay as they are, and the old cursor is not
   * scrolled into view. The position is applied at most once.
   *
   * The answer is void if it is not an object with a finite line and a finite
   * offset (no record, an error object, anything else), if it is a rejection
   * (which is printed to the console), or if, by the time it arrives, the
   * editor is destroyed or loaded another document, something navigated within
   * the document (jtl() or a transaction that asks for scrolling), or the
   * reader scrolled by more than 2 pixels.
   *
   * The position is applied once. The heights of the lines that never were on
   * the screen are estimates until they are measured, so the scroll position
   * that follows from a line and an offset is only a first guess. The editor
   * therefore checks after every later measure whether it shows the position,
   * and scrolls again with the measured heights if it does not (at most
   * TEXT_READING_RESTORE_MAXIMUM_CORRECTIONS times; see
   * applyTextReadingRestore). Until that is over, persistableTextReadingPosition
   * is undefined.
   *
   * @param  {Function}  request  Asks for the position; resolves to the record
   *                              of the main process
   */
  async restoreTextReadingPosition (request: () => Promise<unknown>): Promise<void> {
    if (this.destroyed) {
      return
    }
    const restore: TextReadingRestore = {
      guard: {
        generation: this.loadGeneration,
        scrollTop: this._instance.scrollDOM.scrollTop,
        navigationCount: this.explicitNavigationCount
      },
      writes: 0
    }
    this.textReadingRestore = restore
    this.textReadingRestored = undefined

    let answer: unknown
    try {
      answer = await request()
    } catch (err) {
      console.error(err)
    }
    if (this.textReadingRestore !== restore) {
      return // The editor was destroyed, or a newer request took over
    }

    const position = parseTextReadingPosition(answer)
    if (position === undefined || this.isTextReadingRestoreVoid(restore.guard)) {
      this.textReadingRestore = undefined
      return
    }
    restore.position = position
    this.scheduleTextReadingRestore()
  }

  /**
   * Zettlr-LYH (R98): whether the answer to a request for the stored reading
   * position must be discarded (see restoreTextReadingPosition).
   *
   * @param   {TextReadingRestoreGuard}  guard  The state at the time of the request
   *
   * @return  {boolean}                         True if the answer is void
   */
  private isTextReadingRestoreVoid (guard: TextReadingRestoreGuard): boolean {
    return this.isTextReadingRestoreOverruled(guard) ||
      Math.abs(this._instance.scrollDOM.scrollTop - guard.scrollTop) > TEXT_READING_RESTORE_SCROLL_TOLERANCE
  }

  /**
   * Zettlr-LYH (R98): whether a restore must give way to something else, apart
   * from the reader's scrolling: the editor is gone, it loaded another
   * document, or something navigated within the document (see
   * restoreTextReadingPosition).
   *
   * @param   {TextReadingRestoreGuard}  guard  The state at the time of the request
   *
   * @return  {boolean}                         True if the restore is overruled
   */
  private isTextReadingRestoreOverruled (guard: TextReadingRestoreGuard): boolean {
    return this.destroyed ||
      guard.generation !== this.loadGeneration ||
      guard.navigationCount !== this.explicitNavigationCount
  }

  /**
   * Zettlr-LYH (R98): asks for the next step of the restore after the next
   * measure, once the document is loaded and the position is known: the first
   * step applies the stored reading position, every later step checks and
   * corrects it (see applyTextReadingRestore). If the editor is not displayed
   * at that measure, nothing happens, and the next change of the geometry
   * tries again.
   */
  private scheduleTextReadingRestore (): void {
    const restore = this.textReadingRestore
    if (restore?.position === undefined || this.destroyed || !this.documentLoaded) {
      return
    }
    // The restore scrolls the view itself once it applied the position, so the
    // scroll position at the time of the request no longer tells whether the
    // reader scrolled; correctTextReadingRestore decides that at the next measure
    const applied = restore.writtenScrollTop !== undefined
    if (applied ? this.isTextReadingRestoreOverruled(restore.guard) : this.isTextReadingRestoreVoid(restore.guard)) {
      this.textReadingRestore = undefined
      return
    }
    const generation = this.loadGeneration
    this._instance.requestMeasure({
      key: this.textReadingRestoreKey,
      read: (view): TextReadingRestoreMeasure => ({
        visible: view.inView && view.scrollDOM.clientHeight > 0,
        scrollTop: view.scrollDOM.scrollTop,
        writes: restore.writes
      }),
      write: measure => {
        if (measure.visible) {
          // The measure has updated the heights of the lines; a microtask runs
          // after the measure cycle, including CodeMirror's own scrolling.
          queueMicrotask(() => { this.applyTextReadingRestore(restore, generation, measure) })
        }
      }
    })
  }

  /**
   * Zettlr-LYH (R98): the step of the restore that follows a measure. Only
   * scrollTop changes: no transaction is dispatched, so neither the document,
   * nor the selection, the folds or the undo history are touched, and
   * CodeMirror does not scroll the old cursor into view (specification C13,
   * section 5).
   *
   * The first step converts the stored line and offset to a scroll position
   * with the heights that CodeMirror has by then, which are estimates for every
   * line that never was on the screen, and scrolls there. Every later step
   * belongs to a measure that started after the last scroll of the restore, so
   * the lines that moved into the viewport are measured by then, and
   * CodeMirror and the scroll stabilization have done their compensation. It
   * reads the reading position of the editor (the same formula as in
   * textReadingPosition) and, if it is not the stored one, converts the stored
   * position again with the heights that are known now and scrolls again.
   *
   * @param  {TextReadingRestore}         restore     The restore
   * @param  {number}                     generation  The load of the document the measure was requested for
   * @param  {TextReadingRestoreMeasure}  measure     What the measure read
   */
  private applyTextReadingRestore (restore: TextReadingRestore, generation: number, measure: TextReadingRestoreMeasure): void {
    const position = restore.position
    if (
      this.destroyed || generation !== this.loadGeneration ||
      this.textReadingRestore !== restore || position === undefined
    ) {
      return
    }
    if (restore.writtenScrollTop !== undefined) {
      this.correctTextReadingRestore(restore, position, restore.writtenScrollTop, measure)
      return
    }
    if (this.isTextReadingRestoreVoid(restore.guard)) {
      this.textReadingRestore = undefined
      return
    }
    const scrollTop = this.scrollTopForTextReadingPosition(position)
    if (scrollTop === undefined) {
      return // Not measurable yet: stays pending until the geometry changes
    }
    this.writeTextReadingRestoreScrollTop(restore, scrollTop)
  }

  /**
   * Zettlr-LYH (R98): checks whether the editor shows the stored position after
   * the last scroll of the restore, and scrolls again if it does not. The
   * restore ends (and the editor may store reading positions again) when
   *
   * - the editor shows the position: the line is the stored one, and the
   *   offset differs by no more than 2 pixels,
   * - TEXT_READING_RESTORE_MAXIMUM_CORRECTIONS corrections were made,
   * - a correction would not move the view (it already is as close as the
   *   browser can place it, or the position lies beyond the scrollable range),
   * - or the reader took over: the measure found a scroll position other than
   *   the one the restore left (a change between two measure cycles is not
   *   CodeMirror's or the scroll stabilization's compensation, which happens
   *   within a cycle and after its start), or something navigated within the
   *   document, or the document was loaded again. The restore then leaves the
   *   scroll position alone.
   *
   * @param  {TextReadingRestore}         restore   The restore
   * @param  {TextReadingPosition}        position  The stored position
   * @param  {number}                     written   The scroll position after the last scroll of the restore
   * @param  {TextReadingRestoreMeasure}  measure   What the measure read
   */
  private correctTextReadingRestore (
    restore: TextReadingRestore,
    position: TextReadingPosition,
    written: number,
    measure: TextReadingRestoreMeasure
  ): void {
    if (measure.writes !== restore.writes) {
      return // The restore scrolled after this measure started; a later measure checks the result
    }
    if (
      this.isTextReadingRestoreOverruled(restore.guard) ||
      Math.abs(measure.scrollTop - written) > TEXT_READING_RESTORE_SCROLL_TOLERANCE
    ) {
      this.textReadingRestore = undefined
      return
    }

    const target = this.textReadingTarget(position)
    const reading = this.textReadingPosition
    if (target === undefined || reading === undefined) {
      return // Not measurable now: the next change of the geometry checks again
    }
    if (reading.line === target.line && Math.abs(reading.offset - target.offset) <= TEXT_READING_RESTORE_SCROLL_TOLERANCE) {
      this.endTextReadingRestore(position)
      return
    }
    if (restore.writes > TEXT_READING_RESTORE_MAXIMUM_CORRECTIONS) {
      this.endTextReadingRestore(position) // The first write is no correction
      return
    }

    const scroller = this._instance.scrollDOM
    const wanted = this.scrollTopForTextReadingPosition(position, TEXT_READING_RESTORE_CORRECTION_OFFSET)
    if (wanted === undefined) {
      return
    }
    const scrollTop = Math.min(wanted, Math.max(0, scroller.scrollHeight - scroller.clientHeight))
    if (Math.abs(scrollTop - scroller.scrollTop) < TEXT_READING_RESTORE_MINIMUM_CORRECTION) {
      this.endTextReadingRestore(position)
      return
    }
    this.writeTextReadingRestoreScrollTop(restore, scrollTop)
  }

  /**
   * Zettlr-LYH (R98): scrolls for the restore, remembers the scroll position the
   * browser kept, and asks for the measure that checks the result. Checking
   * right away would only compare the height map with itself: the lines that
   * move into the viewport are not measured before the next measure cycle.
   *
   * @param  {TextReadingRestore}  restore    The restore
   * @param  {number}              scrollTop  The scroll position
   */
  private writeTextReadingRestoreScrollTop (restore: TextReadingRestore, scrollTop: number): void {
    const scroller = this._instance.scrollDOM
    scroller.scrollTop = scrollTop
    // The browser rounds the scroll position and limits it to the scrollable range
    restore.writtenScrollTop = scroller.scrollTop
    restore.writes++
    this.scheduleTextReadingRestore()
  }

  /**
   * Zettlr-LYH (R98): ends the restore. Until the reader scrolls or the text
   * changes, the position to store is the stored one (see
   * persistableTextReadingPosition).
   *
   * @param  {TextReadingPosition}  position  The stored position
   */
  private endTextReadingRestore (position: TextReadingPosition): void {
    this.textReadingRestore = undefined
    if (this.keepDocumentTextInView()) {
      // The stored position lay in the empty space after the document; the
      // position the editor shows now is the one to store
      this.textReadingRestored = undefined
      return
    }
    this.textReadingRestored = {
      position: { line: position.line, offset: position.offset },
      scrollTop: this._instance.scrollDOM.scrollTop,
      generation: this.loadGeneration
    }
  }

  /**
   * Zettlr-LYH: after a restored position (a stored reading position or the
   * reading state in memory), the viewport must show the text of the document,
   * not the empty space that the editor offers after its end. If the document
   * ends above the reading line (one third of the visible height), the editor
   * scrolls up until the end of the document sits at the bottom of the visible
   * area, or to the top if the whole document fits. Only scrollTop changes.
   *
   * @return  {boolean}  True if the editor scrolled
   */
  private keepDocumentTextInView (): boolean {
    if (this.destroyed || !this.documentLoaded) {
      return false
    }
    const view = this._instance
    const scroller = view.scrollDOM
    const visibleHeight = scroller.clientHeight
    if (visibleHeight <= 0) {
      return false
    }
    // Heights measured from the top of the document, as in textReadingPosition
    const viewportTop = scroller.getBoundingClientRect().top - view.documentTop
    const documentBottom = view.lineBlockAt(view.state.doc.length).bottom
    if (!Number.isFinite(viewportTop) || !Number.isFinite(documentBottom)) {
      return false
    }
    if (documentBottom >= viewportTop + visibleHeight * READING_LINE_FRACTION) {
      return false
    }
    const scrollTop = Math.max(0, scroller.scrollTop - (viewportTop + visibleHeight - documentBottom))
    if (scroller.scrollTop - scrollTop < 1) {
      return false
    }
    scroller.scrollTop = scrollTop
    return true
  }

  /**
   * Zettlr-LYH (R98): where a reading position points to in the editor as it is
   * now: the first line of the line block that contains the line (a line that
   * a folded range or a block widget hides counts as the line the block starts
   * with, the line a measurement reports for it), the offset limited to the
   * height of the block, and the top of the block.
   *
   * @param   {TextReadingPosition}  position       The reading position
   * @param   {number}               minimumOffset  The smallest offset to use
   *
   * @return  {object|undefined}                    The line, the offset and the
   *                                                top of the block, or undefined
   *                                                if the editor cannot be measured
   */
  private textReadingTarget (position: TextReadingPosition, minimumOffset = 0): { line: number, offset: number, top: number }|undefined {
    const view = this._instance
    if (view.scrollDOM.clientHeight <= 0) {
      return undefined
    }
    const doc = view.state.doc
    const lineNumber = Math.max(1, Math.min(Math.floor(position.line), doc.lines))
    const block = view.lineBlockAt(doc.line(lineNumber).from)
    return {
      line: doc.lineAt(block.from).number,
      offset: Math.max(0, Math.min(Math.max(position.offset, minimumOffset), block.height - 1)),
      top: block.top
    }
  }

  /**
   * Zettlr-LYH (R98): the scroll position that puts the top of the viewport
   * where the reading position says, with the heights of the lines as they are
   * known now. A line number beyond the last line counts as the last line, and
   * the offset in pixels stays within the line block.
   *
   * @param   {TextReadingPosition}  position       The reading position
   * @param   {number}               minimumOffset  The smallest offset to use
   *
   * @return  {number|undefined}                    The scroll position, or undefined
   *                                                if the editor cannot be measured
   */
  private scrollTopForTextReadingPosition (position: TextReadingPosition, minimumOffset = 0): number|undefined {
    const target = this.textReadingTarget(position, minimumOffset)
    if (target === undefined) {
      return undefined
    }
    const view = this._instance
    const scroller = view.scrollDOM
    // Move the viewport from where it is now to the wanted height
    const viewportTop = scroller.getBoundingClientRect().top - view.documentTop
    const scrollTop = scroller.scrollTop + target.top + target.offset - viewportTop
    return Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : undefined
  }

  /**
   * Zettlr-LYH (R98): emits `scroll-idle` once the editor stayed scrolled still
   * for a second. Every scroll starts the second anew. A scroll by which the
   * editor leaves the scroll position of the last restore also ends the claim
   * of that restore on the position to store.
   */
  private scheduleTextReadingPositionReport (): void {
    if (this.destroyed) {
      return
    }
    const restored = this.textReadingRestored
    if (
      restored !== undefined &&
      Math.abs(this._instance.scrollDOM.scrollTop - restored.scrollTop) > TEXT_READING_RESTORE_SCROLL_TOLERANCE
    ) {
      this.textReadingRestored = undefined
    }
    if (this.textReadingPositionTimer !== undefined) {
      textReadingPositionTimers.cancel(this.textReadingPositionTimer)
    }
    this.textReadingPositionTimer = textReadingPositionTimers.start(() => {
      this.textReadingPositionTimer = undefined
      if (!this.destroyed) {
        this.emit('scroll-idle')
      }
    }, TEXT_READING_POSITION_IDLE_DELAY)
  }

  /**
   * This function allows to reload the full editor contents. This is useful if
   * a setting has changed that requires extensions to be fully reloaded, or if
   * the document has been changed on disk. Since this recreates the entire
   * editor state, the scroll position would normally be lost; therefore this
   * method restores the cursor and keeps the viewport visually stable: if the
   * cursor was visible before the reload, it is kept at the same height on
   * screen; otherwise, the line at one third of the viewport height is kept
   * stationary.
   */
  async reload (): Promise<void> {
    if (this.destroyed) {
      return
    }
    // Capture the cursor and the viewport anchor (line/column based, since the
    // new state may contain different content and character offsets would be
    // meaningless).
    const oldDocument = this._instance.state.doc
    const toLineAndColumn = (position: number): { line: number, column: number } => {
      const line = oldDocument.lineAt(position)
      return { line: line.number, column: position - line.from }
    }

    const cursor = toLineAndColumn(this._instance.state.selection.main.head)
    const viewportAnchor = findViewportAnchor(this._instance)
    const anchor = viewportAnchor !== null
      ? { ...toLineAndColumn(viewportAnchor.position), rowTop: viewportAnchor.rowTop }
      : null

    // An automatic reload must never steal the focus (Requirement R138): only
    // refocus the editor if it already had the focus before the reload.
    const hadFocus = this._instance.hasFocus

    const generation = this.loadGeneration + 1
    // Zettlr-LYH undo history (R135): the undo history of the editor stays when
    // the reloaded text is the same, or follows from the old one by the external
    // modification that the authority reports (the load decides)
    // Zettlr-LYH data loss prevention (R173): the load is also the one place
    // that decides what happens to unconfirmed local modifications. If it did
    // not replace the state (it could not fetch the document and tries again
    // later, or another load took over), there is nothing to restore here.
    const replaced = await this.loadDocument(undefined, hadFocus, true)
    if (!replaced || this.destroyed || generation !== this.loadGeneration) {
      return
    }

    // Restore the cursor and the viewport anchor onto the new state, clamping
    // line and column into the bounds of the new content.
    const newDocument = this._instance.state.doc
    const toPosition = (target: { line: number, column: number }): number => {
      const line = newDocument.line(Math.max(1, Math.min(target.line, newDocument.lines)))
      return line.from + Math.min(target.column, line.length)
    }

    const effects: Array<StateEffect<any>> = []
    if (anchor !== null) {
      effects.push(EditorView.scrollIntoView(toPosition(anchor), { y: 'start', yMargin: anchor.rowTop }))
    }

    this._instance.dispatch({ selection: { anchor: toPosition(cursor) }, effects })
  }

  /**
   * Unmount the editor instance entirely. NOTE: After calling this, DO NO
   * LONGER USE THIS CLASS INSTANCE! Instantiate it anew!
   */
  public unmount (): void {
    this.destroyed = true
    this.loadGeneration++
    if (this.readingLineFrame !== undefined) {
      readingLineFrames.cancel(this.readingLineFrame)
      this.readingLineFrame = undefined
    }
    // Zettlr-LYH (R98): nothing is reported or restored after this
    if (this.textReadingPositionTimer !== undefined) {
      textReadingPositionTimers.cancel(this.textReadingPositionTimer)
      this.textReadingPositionTimer = undefined
    }
    this.textReadingRestore = undefined
    this.textReadingRestored = undefined
    // Zettlr-LYH data loss prevention (R173): no reload is tried again after
    // this, and this editor no longer reports on fetching its document
    this.cancelDocumentReloadRetry()
    this.withdrawDocumentFetchFailure()
    this._instance.scrollDOM.removeEventListener('scroll', this.onEditorScroll)
    // Zettlr-LYH data loss prevention (R173, specification C21 section 6):
    // destroying the view destroys the plugins of its state, synchronously.
    // The document authority plugin sends the unconfirmed modifications in one
    // last push, and the recovery journal plugin writes them out and ends its
    // session with the reason `unmount`.
    this.instance.destroy()
    this.removeAllListeners()
  }

  /**
   * Allows highlighting of arbitrary ranges independent of a search
   *
   * @param  {SelectionRange[]}  ranges  The ranges to highlight
   */
  highlightRanges (ranges: SelectionRange[]): void {
    this._instance.dispatch({ effects: highlightRangesEffect.of(ranges) })
  }

  /**
   * Pastes the clipboard contents as plain text, regardless of any formatted
   * text present.
   */
  pasteAsPlainText (): void {
    pasteAsPlain(this._instance)
  }

  /**
   * Copies the current editor contents into the clipboard as HTML
   */
  copyAsHTML (): void {
    copyAsHTML(this._instance)
  }

  /**
   * Small function that jumps to a specific line in the editor.
   *
   * @param  {number}  line        The line to pull into view
   * @param  {boolean} selectLine  Whether to select the whole line (default).
   *                               If false, only place the cursor at the start
   *                               of the line (Zettlr-LYH R62, PDF backlinks).
   * @param  {JumpPosition} position  Where to place the line: in the middle
   *                               (default), or with its top at the reading
   *                               line (Zettlr-LYH R112, table of contents).
   */
  jtl (line: number, selectLine: boolean = true, position: JumpPosition = 'center'): void {
    // Zettlr-LYH (R98): a jump beats the stored reading position
    this.explicitNavigationCount++
    if (line > 0 && line <= this._instance.state.doc.lines) {
      const lineDesc = this._instance.state.doc.line(line)
      const visibleHeight = this._instance.scrollDOM.clientHeight
      // The top of the line goes one pixel above the reading line, so that the
      // reading line falls inside the target line despite rounding.
      const scrollEffect = position === 'reading-line' && visibleHeight > 0
        ? EditorView.scrollIntoView(lineDesc.from, {
          y: 'start',
          yMargin: Math.max(0, Math.floor(visibleHeight * READING_LINE_FRACTION) - 1)
        })
        : EditorView.scrollIntoView(lineDesc.from, { y: 'center' })
      this._instance.dispatch({
        selection: { anchor: lineDesc.from, head: selectLine ? lineDesc.to : lineDesc.from },
        effects: scrollEffect
      })
    }
    this._instance.focus()
  }

  /**
   * Moves the section that starts with an ATX heading on the from-line to the
   * line identified by to
   *
   * @param   {number}  from  The starting line (including the section heading)
   * @param   {number}  to    The target line for the section (is -1 if it should be moved to the end)
   */
  moveSection (from: number, to: number): void {
    // Zettlr-LYH (R124): only Markdown documents have sections to move; the
    // table of contents of a TOML document lists its table headers.
    const toc = this._instance.state.field(tocField, false)
    if (toc === undefined) {
      return
    }
    const toLineNumber = to !== -1 ? to : this._instance.state.doc.lines
    moveSection(toc, from, toLineNumber)(this._instance)
  }

  /**
   * Toggles the visibility of the search panel in this editor state.
   */
  toggleSearchPanel () {
    if (searchPanelOpen(this.instance.state)) {
      closeSearchPanel(this.instance)
    } else {
      openSearchPanel(this.instance)
    }
  }

  /**
   * Updates the provided options for all currently loaded documents.
   *
   * @param   {Object}  newOptions  The new options
   */
  setOptions (newOptions: EditorConfigOptions): void {
    // Here, we only trigger an update in the state itself. Then, we grab the
    // update via an effect to ensure we can cache the final, correct
    // configuration. However, in case there's no state (initial update), we
    // still need to cache the config here, as the updateListener won't be
    // firing yet.

    // Cache the current config first, and then apply it
    this.onConfigUpdate(newOptions)

    this.config = safeAssign(newOptions, this.config)

    this._instance.dispatch({ effects: configUpdateEffect.of(this.config) })
  }

  /**
   * This function is called by an updateListener that listens for changes to
   * the main configuration. We do so to ensure that the editor state is the
   * main source of truth, but that the editor class can cache the config in
   * case we need to exchange the states.
   *
   * @param   {Partial<EditorConfiguration>}  newOptions  The new options passed via the effect
   */
  private onConfigUpdate (newOptions: Partial<EditorConfiguration>): void {
    const inputModeChanged = newOptions.inputMode !== undefined && newOptions.inputMode !== this.config.inputMode
    const darkModeChanged = newOptions.darkMode !== undefined && newOptions.darkMode !== this.config.darkMode
    const editorModeChanged = newOptions.darkModeEditor !== undefined && newOptions.darkModeEditor !== this.config.darkModeEditor
    const themeChanged = newOptions.theme !== undefined && newOptions.theme !== this.config.theme

    // Third: The input mode, if applicable
    if (inputModeChanged) {
      if (newOptions.inputMode === 'emacs') {
        this._instance.dispatch({ effects: inputModeCompartment.reconfigure(emacs()) })
      } else if (newOptions.inputMode === 'vim') {
        this._instance.dispatch({ effects: inputModeCompartment.reconfigure(vimPlugin()) })
      } else {
        this._instance.dispatch({ effects: inputModeCompartment.reconfigure([]) })
      }
    }

    // Fourth: Switch theme, if applicable
    if (darkModeChanged || editorModeChanged || themeChanged) {
      const themes = getMainEditorThemes()

      const darkMode = newOptions.darkMode ?? this.config.darkMode
      const darkModeEditor = newOptions.darkModeEditor ?? this.config.darkModeEditor

      this._instance.dispatch({
        effects: darkModeEffect.of({
          darkMode: useDarkModeEditor(darkMode, darkModeEditor),
          ...themes[newOptions.theme ?? this.config.theme]
        })
      })
    }
  }

  /**
   * Returns an option with the given name as it is configured on the instance.
   *
   * @param   {string}  name  The name of the key to request
   *
   * @return  {any}           The value of the key
   */
  getOption (name: string) {
    const config = this._instance.state.field(configField)
    if (name in config) {
      return config[name as keyof EditorConfiguration]
    }
  }

  /**
   * Runs a command on the underlying CodeMirror instance
   *
   * @param   {String}  cmd  The command to run
   */
  runCommand (cmd: string): void {
    // Zettlr-LYH (R174): the nine formatting commands (Bold, Italics,
    // Underline, Highlight, Strikethrough, Link, Image, Comment, Code) come
    // from the main toolbar and from the formatting bar
    const formattingCommand = FORMATTING_COMMANDS.get(cmd)
    if (formattingCommand !== undefined) {
      formattingCommand(this._instance)
      return
    }

    switch (cmd) {
      case 'insertFootnote':
        addNewFootnote(this._instance)
        break
      case 'markdownMakeTaskList':
        applyTaskList(this._instance)
        break
      case 'markdownPandocColumns':
        applyPandocColumns(this._instance)
        break
      case 'markLyhRevise':
        // Zettlr-LYH: toolbar button Revise Comment; inserts [{}] at the
        // cursor without a selection (R108)
        markLyhRevise(this._instance)
        break
      case 'acceptRevision':
      case 'rejectRevision':
        // Zettlr-LYH (R84): toolbar buttons Accept and Reject; process the
        // tracked changes at the cursor or in the selection, then move on to
        // the next one
        applyRevisionAction(this._instance, cmd === 'acceptRevision' ? 'accept' : 'reject')
        break
      default:
        console.warn('Unimplemented command:', cmd)
    }
  }

  /**
   * Zettlr-LYH (R174, R131): colors the selection of the editor, or removes the
   * color from it, in one transaction that one undo takes back. This is what the
   * Text Color and Background Color buttons of the formatting bar call. An empty
   * selection and a document that is not Markdown stay unchanged.
   *
   * @param   {ColorProperty}  property  `color` for the text, `background-color`
   *                                     for the background
   * @param   {string|null}    color     The color as `#rgb` or `#rrggbb`, or null
   *                                     to remove the property
   *
   * @return  {boolean}                  Whether the document changed
   */
  applyTextColor (property: ColorProperty, color: string|null): boolean {
    return applyTextColorToSelection(this._instance, property, color)
  }

  /**
   * Replaces the main selection with arbitrary text
   *
   * @param   {string}  text  The text to replace the selection with
   */
  replaceSelection (text: string): void {
    const transaction = this._instance.state.replaceSelection(text)
    this._instance.dispatch(transaction)
    this._instance.focus()
  }

  /**
   * Insert a fenced div, `::: {#id}`,
   * or bracketed span, `[my text]{#id}`
   * around the main selection.
   *
   * @param   {string}  type        The type of div to insert
   * @param   {string}  identifier  Identifier attribute. Spaces are replaced with a hyphen `-`
   * @param   {string}  classes     Class attributes. Words are prepended with `.`
   * @param   {string}  attributes  Key=Value attributes.
   */
  insertPandocDivOrSpan (type: 'div'|'span', attributes: string): void {
    applyPandocDivOrSpan(this._instance, type, parsePandocAttributes(attributes))
  }

  /**
   * Returns the objects whose Pandoc attributes can be edited around the given
   * range (default: the main selection), innermost first, together with the
   * range they were found for.
   *
   * @param   {number}  from  Optional range start
   * @param   {number}  to    Optional range end
   *
   * @return  {{ from: number, to: number, targets: PandocAttributeTarget[] }}
   */
  getPandocAttributeTargets (from?: number, to?: number): { from: number, to: number, targets: PandocAttributeTarget[] } {
    const main = this._instance.state.selection.main
    const rangeFrom = Math.min(from ?? main.from, this._instance.state.doc.length)
    const rangeTo = Math.min(to ?? main.to, this._instance.state.doc.length)
    return {
      from: rangeFrom,
      to: rangeTo,
      targets: findPandocAttributeTargetsNear(this._instance.state, rangeFrom, rangeTo)
    }
  }

  /**
   * Writes Pandoc attribute updates for the objects around the range back into
   * the document in one transaction.
   *
   * @param   {number}                       from     Range start
   * @param   {number}                       to       Range end
   * @param   {PandocAttributeKindUpdate[]}  updates  At most one update per kind
   */
  applyPandocAttributeUpdates (from: number, to: number, updates: PandocAttributeKindUpdate[]): void {
    applyPandocAttributeUpdates(this._instance, from, to, updates)
  }

  /**
   * Issues a focus command to the underlying instance
   */
  focus (): void {
    this._instance.focus()
  }

  /**
   * Whether the underlying Codemirror instance is currently focused
   *
   * @return  {boolean} The focus status
   */
  hasFocus (): boolean {
    return this._instance.hasFocus
  }

  /**
   * Whether any element (including the editor, but also any widgets or other
   * elements inside the entire editor DOM element) has currently focus.
   *
   * @return  {boolean} The focus status
   */
  hasFocusWithin (): boolean {
    return this._instance.dom.contains(document.activeElement)
  }

  /* Sets the project info field of the editor state to the provided value.
   *
   * @param   {ProjectInfo|null}  info  The data
   */
  set projectInfo (info: ProjectInfo|null) {
    this._instance.dispatch({ effects: projectInfoUpdateEffect.of(info) })
  }

  /**
   * Sets an autocomplete database of given type to a new value
   *
   * @param   {String}  type      The type of the database
   * @param   {Object}  database  The show-hint-addon compatible database
   */
  setCompletionDatabase (type: 'tags', database: TagRecord[]): void
  setCompletionDatabase (type: 'citations', database: Array<{ citekey: string, displayText: string }>): void
  setCompletionDatabase (type: 'snippets', database: Array<{ name: string, content: string }>): void
  setCompletionDatabase (type: 'files', database: Array<{ filename: string, displayName: string, id: string }>): void
  setCompletionDatabase (type: string, database: any): void {
    switch (type) {
      case 'tags':
        this.databaseCache.tags = database
        this._instance.dispatch({ effects: tagsUpdate.of(database as TagRecord[]) })
        break
      case 'citations':
        this.databaseCache.citations = database
        this._instance.dispatch({ effects: citekeyUpdate.of(database as Array<{ citekey: string, displayText: string }>) })
        break
      case 'snippets':
        this.databaseCache.snippets = database
        this._instance.dispatch({ effects: snippetsUpdate.of(database as Array<{ name: string, content: string }>) })
        break
      case 'files':
        this.databaseCache.files = database
        this._instance.dispatch({ effects: filesUpdate.of(database as Array<{ filename: string, displayName: string, id: string }>) })
        break
    }
  }

  /* * * * * * * * * * * *
   * GETTERS AND SETTERS *
   * * * * * * * * * * * */

  /**
   * This function builds a table of contents based on the editor contents.
   * Zettlr-LYH (R124): for TOML documents, these are the table headers, whose
   * line numbers point to the source in both view modes.
   *
   * @return {Array} An array containing objects with all headings
   */
  get tableOfContents (): ToCEntry[]|undefined {
    return this._instance.state.field(tocField, false) ?? this._instance.state.field(tomlTableOfContentsField, false)
  }

  /**
   * Returns info about the editor instance
   *
   * @return  {Object}  An object containing, e.g., words, chars, selections.
   */
  get documentInfo (): DocumentInfo {
    // First, we need the main selection's main offset in the document and
    // compute the correct line number for that offset, in order to arrive at
    // a cursor position.
    const mainOffset = this._instance.state.selection.main.head
    const line = this._instance.state.doc.lineAt(mainOffset)
    const ast = markdownToAST(this._instance.state.sliceDoc(), syntaxTree(this._instance.state))
    const locale: string = window.config.get('appLang')
    return {
      words: this.wordCount ?? 0,
      chars: this.charCount ?? 0,
      cursor: { line: line.number, ch: mainOffset - line.from + 1 }, // Chars are still zero-based
      selections: this._instance.state.selection.ranges
      // Remove cursor-only positions
        .filter(sel => !sel.empty)
        // Then map to user readable ranges
        .map(sel => {
          // Analogous to how we determine the cursor position we do it here for
          // each selection present.
          const anchorLine = this._instance.state.doc.lineAt(sel.anchor)
          const headLine = this._instance.state.doc.lineAt(sel.head)
          const { words, chars } = countAll(ast, locale, sel.from, sel.to)
          return {
            anchor: { line: anchorLine.number, ch: sel.from - anchorLine.from + 1 },
            head: { line: headLine.number, ch: sel.to - headLine.from + 1 },
            words,
            chars
          }
        })
    }
  }

  /**
   * Whether the editor is currently in typewriter
   *
   * @return  {Boolean}  True if typewriter mode is active
   */
  get hasTypewriterMode (): boolean {
    return this.config.typewriterMode
  }

  /**
   * Activates or deactivates typewriter mode
   *
   * @param   {Boolean}  shouldBeTypewriter  True or False
   */
  set hasTypewriterMode (shouldBeTypewriter: boolean) {
    this.config.typewriterMode = shouldBeTypewriter
    this._instance.dispatch({
      effects: configUpdateEffect.of({ typewriterMode: shouldBeTypewriter })
    })
  }

  /**
   * Determines whether the editor is in distraction free mode
   *
   * @return  {boolean}  True or false
   */
  get distractionFree (): boolean {
    return this._instance.state.field(configField, false)?.distractionFree ?? false
  }

  /**
   * Sets the editor into or out of distraction free
   *
   * @param   {boolean}  shouldBeFullscreen  Whether the editor should be in distraction free
   */
  set distractionFree (shouldBeFullscreen: boolean) {
  }

  /**
   * Returns whether or not the readability mode is currently active
   *
   * @return  {boolean}  True if the readability mode is active
   */
  get readabilityMode (): boolean {
    return this._instance.state.field(configField).readabilityMode
  }

  /**
   * Sets the readability mode
   *
   * @param   {boolean}  shouldBeReadability  Whether or not the mode should be active
   */
  set readabilityMode (shouldBeReadability: boolean) {
    this.config.readabilityMode = shouldBeReadability
    this._instance.dispatch({ effects: configUpdateEffect.of(this.config) })
  }

  /**
   * Returns the current contents of the editor
   *
   * @return  {String}  The editor contents
   */
  get value (): string {
    return [...this._instance.state.doc.iterLines()].join('\n')
  }

  /**
   * Returns the outer DOM element for the editor instance
   *
   * @return  {HTMLElement}The editor wrapper
   */
  get dom (): HTMLElement {
    return this._instance.dom
  }

  /**
   * Returns the word count of the editor contents
   *
   * @return  {Number}  The word count
   */
  get wordCount (): number|undefined {
    return this._instance.state.field(countField, false)?.words
  }

  /**
   * Returns the char count of the editor contents
   *
   * @return  {Number}  The number of characters
   */
  get charCount (): number|undefined {
    return this._instance.state.field(countField, false)?.chars
  }

  /**
   * Returns the underlying Codemirror instance
   *
   * @return  {EditorView}  The instance
   */
  get instance (): EditorView {
    return this._instance
  }

  /**
   * Retrieves the document represented by this editor instance.
   *
   * @return  {string}  the absolute path to the document.
   */
  get documentPath (): string {
    return this.representedDocument
  }
}
