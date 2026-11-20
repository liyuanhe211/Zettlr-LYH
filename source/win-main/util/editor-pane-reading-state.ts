import type { EditorViewPersistentState } from 'source/common/modules/markdown-editor'

type ReadingStates = Map<string, EditorViewPersistentState>
interface PaneReadingState {
  states: ReadingStates
  capture?: () => void
  capturePath?: string
  writers: Map<string, () => void>
  revisions: Map<string, number>
  revision: number
}

/** Renderer-local state survives pane component replacement, but is never
 * shared between panes or windows. CodeMirror snapshots and ranges are
 * immutable; copied panes receive separate maps and state wrappers. */
const windows = new Map<string, Map<string, PaneReadingState>>()

/** The default limit for the undo histories that the stored states of one
 * window hold together: 256 MB (requirement R135) */
export const UNDO_HISTORY_MEMORY_LIMIT_BYTES = 268435456

/** The limit in force. A writable object so that tests can inject a small
 * value; restore the default afterwards. */
export const undoHistoryMemoryLimit = { bytes: UNDO_HISTORY_MEMORY_LIMIT_BYTES }

/** Counts every store, copy and migration of a state, across all panes, so that
 * the revisions of the states of different panes can be compared with each
 * other (the older a revision, the longer ago the state was last displayed).
 * Within one pane the numbers still rise with every store, as before. */
let revisionClock = 0

function paneState (windowId: string, leafId: string): PaneReadingState {
  let panes = windows.get(windowId)
  if (panes === undefined) {
    panes = new Map()
    windows.set(windowId, panes)
  }
  let pane = panes.get(leafId)
  if (pane === undefined) {
    pane = { states: new Map(), writers: new Map(), revisions: new Map(), revision: 0 }
    panes.set(leafId, pane)
  }
  return pane
}

export function editorPaneReadingStates (windowId: string, leafId: string): ReadingStates {
  return paneState(windowId, leafId).states
}

/** Identity-aware removal protects a newly mounted editor from a late
 * unmount of its predecessor. Captures use MarkdownEditor's loading-aware
 * persistentState getter, preserving pending snapshots before measurement. */
export function registerEditorPaneReadingCapture (windowId: string, leafId: string, capture: () => void, filePath?: string): () => void {
  const pane = paneState(windowId, leafId)
  pane.capture = capture
  pane.capturePath = filePath
  if (filePath !== undefined) {
    pane.writers.set(filePath, capture)
  }
  return () => {
    if (pane.capture === capture) {
      pane.capture = undefined
      pane.capturePath = undefined
    }
  }
}

/** Only the latest editor for this path may update its cache. Editors of
 * other tabs can still finish capturing while their replacement mounts. */
export function storeEditorPaneReadingState (windowId: string, leafId: string, capture: () => void, filePath: string, state: EditorViewPersistentState): void {
  const pane = windows.get(windowId)?.get(leafId)
  if (pane === undefined || pane.writers.get(filePath) !== capture) {
    return
  }
  pane.states.set(filePath, state)
  pane.revision = ++revisionClock
  pane.revisions.set(filePath, pane.revision)
  limitUndoHistoryMemory(windowId, leafId, filePath)
}

/** Returns a copy of a state without its undo history */
function withoutUndoHistory (state: EditorViewPersistentState): EditorViewPersistentState {
  const copy = { ...state }
  delete copy.undoHistory
  return copy
}

/** Keeps the undo histories that the stored states of one window hold together
 * within the memory limit (requirement R135). If the estimates add up to more,
 * the states lose their undo history, the one that was displayed longest ago
 * first (by revision) and the one stored just now last, until the limit is
 * kept. Only the copy in the store changes: an editor that is displayed keeps
 * its history, and the records on disk are not touched; a tab that is shown
 * again without a stored history asks the main process for it.
 *
 * @param  {string}  windowId        The window
 * @param  {string}  latestLeafId    The pane of the state that was stored just now
 * @param  {string}  latestFilePath  The file of the state that was stored just now
 */
function limitUndoHistoryMemory (windowId: string, latestLeafId: string, latestFilePath: string): void {
  const panes = windows.get(windowId)
  if (panes === undefined) {
    return
  }
  const holders: Array<{ pane: PaneReadingState, filePath: string, bytes: number, revision: number, latest: boolean }> = []
  let total = 0
  for (const [ leafId, pane ] of panes) {
    for (const [ filePath, state ] of pane.states) {
      const estimate = state.undoHistory?.estimatedBytes
      if (estimate === undefined) {
        continue
      }
      const bytes = Number.isFinite(estimate) ? estimate : 0
      total += bytes
      holders.push({
        pane,
        filePath,
        bytes,
        revision: pane.revisions.get(filePath) ?? 0,
        latest: leafId === latestLeafId && filePath === latestFilePath
      })
    }
  }
  if (total <= undoHistoryMemoryLimit.bytes) {
    return
  }
  holders.sort((left, right) => {
    if (left.latest !== right.latest) {
      return left.latest ? 1 : -1
    }
    return left.revision - right.revision
  })
  for (const holder of holders) {
    if (total <= undoHistoryMemoryLimit.bytes) {
      break
    }
    const state = holder.pane.states.get(holder.filePath)
    if (state !== undefined) {
      holder.pane.states.set(holder.filePath, withoutUndoHistory(state))
    }
    total -= holder.bytes
  }
}

/** Capture and re-key one pane synchronously, keeping the complete immutable
 * snapshot and preserving a destination that has since received newer state. */
export function migrateEditorPaneReadingState (windowId: string, leafId: string, oldPath: string, newPath: string): void {
  if (oldPath === newPath) {
    return
  }
  const pane = paneState(windowId, leafId)
  if (pane.capturePath === oldPath) {
    try {
      pane.capture?.()
    } catch (error) {
      console.error('Could not capture editor pane reading position.', error)
    }
    pane.capture = undefined
    pane.capturePath = undefined
  }
  pane.writers.delete(oldPath)
  const state = pane.states.get(oldPath)
  if (state === undefined) {
    return
  }
  const revision = pane.revisions.get(oldPath) ?? 0
  if (!pane.states.has(newPath) || revision > (pane.revisions.get(newPath) ?? 0)) {
    pane.states.set(newPath, state)
    pane.revisions.set(newPath, revision)
  }
  pane.states.delete(oldPath)
  pane.revisions.delete(oldPath)
}

export function captureWindowEditorReadingStates (windowId: string): void {
  for (const pane of windows.get(windowId)?.values() ?? []) {
    try {
      pane.capture?.()
    } catch (error) {
      console.error('Could not capture editor pane reading position.', error)
    }
  }
}

export function copyEditorPaneReadingStates (windowId: string, originLeaf: string, newLeaf: string): void {
  if (originLeaf === newLeaf) {
    return
  }
  const source = paneState(windowId, originLeaf)
  const target = paneState(windowId, newLeaf)
  for (const [ filePath, state ] of source.states) {
    target.states.set(filePath, { ...state })
    target.revision = ++revisionClock
    target.revisions.set(filePath, target.revision)
  }
}

export function forgetEditorPaneReadingStates (windowId: string, leafId: string): void {
  const panes = windows.get(windowId)
  panes?.delete(leafId)
  if (panes?.size === 0) {
    windows.delete(windowId)
  }
}
