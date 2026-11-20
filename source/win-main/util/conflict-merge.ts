/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Conflict merge view configuration, block synchronization and session helpers
 * CVM-Role:        Utility functions
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH conflict merge (R47, rewritten for R138): the
 *                  testable logic behind the comparison view of a file that was
 *                  modified on disk while the editor holds unsaved changes. The
 *                  view shows the version on disk on the left and the editor's
 *                  version on the right; both panes are editable. This module
 *                  builds the MergeView configuration, copies whole difference
 *                  blocks between the two panes (pure functions plus the column
 *                  of buttons between the panes, which is drawn here because the
 *                  revert controls of @codemirror/merge only work in one
 *                  direction), formats the version information under the pane
 *                  titles, validates the replies of the main process, builds the
 *                  documents-provider commands, and decides which pane of which
 *                  window shows the comparison of a session.
 *
 * END HEADER
 */

import { Compartment, EditorState, Prec, StateEffect, type Extension } from '@codemirror/state'
import { EditorView, type ViewUpdate } from '@codemirror/view'
import type { DirectMergeConfig, MergeConfig, MergeView } from '@codemirror/merge'
import type { DocumentManagerIPCAPI } from 'source/app/service-providers/documents'
import formatSize from '../../common/util/format-size'

/**
 * The two panes of the comparison view: the version on disk is on the left,
 * the editor's version on the right.
 */
export type PaneSide = 'left'|'right'

/**
 * The direction in which a block is copied: 'left-to-right' writes the block of
 * the version on disk into the editor's version, 'right-to-left' writes the
 * block of the editor's version into the version on disk.
 */
export type CopyDirection = 'left-to-right'|'right-to-left'

/**
 * What the three buttons below the panes submit: the left pane, the right
 * pane, or the left pane as the file and the right pane as a copy next to it.
 */
export type ConflictMergeChoice = 'keep-left'|'keep-right'|'save-both'

/**
 * The strings of the comparison view and its companions in the editor pane,
 * kept in one place so that the interface and its tests share the wording of
 * the specification (all user-visible text is English).
 */
export const CONFLICT_MERGE_TEXT = {
  diskTitle: 'Version on Disk',
  editorTitle: 'Your Version in Zettlr',
  description: 'This file was changed on disk while Zettlr holds unsaved changes. Copy blocks between the two versions, then keep one version or save both.',
  showOnlyDifferences: 'Show Only Differences',
  showOnlyDifferencesTooltip: 'Collapse unchanged stretches down to the changed blocks and 10 lines around each; click a collapsed stretch to expand it',
  keepThisVersion: 'Keep This Version',
  keepDiskAriaLabel: 'Keep the version on the left (disk)',
  keepEditorAriaLabel: 'Keep the version on the right (yours)',
  saveBoth: 'Keep Disk & Back Up Yours',
  saveBothDescription: 'Save the current contents of the left pane to the original file. Save the current contents of the right pane as a separate copy in the same folder, and open the copy after the original tab without switching to it.',
  copyBlockToRightAriaLabel: 'Copy this block from the disk version to your version',
  copyBlockToLeftAriaLabel: 'Copy this block from your version to the disk version',
  copySelectionToRight: 'Selection →',
  copySelectionToLeft: '← Selection',
  noDifferencesInSelection: 'The selection contains no differences',
  diskChangedAgainReplaced: 'The file changed on disk again. The left pane now shows the newest version.',
  diskChangedAgainWarning: 'The file changed on disk again after you started comparing.',
  loadNewestDiskVersion: 'Load Newest Disk Version',
  reloadedFromDisk: 'Reloaded from disk',
  conflictInOtherPane: 'This file has a disk conflict. Resolve it in the comparison view.',
  goToComparison: 'Go to Comparison',
  unknown: 'unknown'
} as const

/**
 * The names of the two events of the main process that the comparison view
 * listens to (their string values are fixed by the specification; the
 * DP_EVENTS enumeration of the main process may or may not list them).
 */
export const FILE_RELOADED_FROM_DISK_EVENT = 'file-reloaded-from-disk'
export const FILE_CONFLICT_DISK_CHANGED_EVENT = 'file-conflict-disk-changed'

/**
 * The width of the column between the two panes, which holds the buttons that
 * copy blocks, narrowed to 60 pixels by the approved interface revision.
 */
export const CONFLICT_MERGE_CENTER_COLUMN_WIDTH = 60

/**
 * The size of the two block buttons of a difference block. A pair stacks the
 * button that writes to the right on top of the button that writes to the left.
 */
export const CONFLICT_MERGE_SYNC_BUTTON_WIDTH = CONFLICT_MERGE_CENTER_COLUMN_WIDTH - 8
export const CONFLICT_MERGE_SYNC_BUTTON_HEIGHT = 26
export const CONFLICT_MERGE_SYNC_BUTTON_GAP = 2
const SYNC_PAIR_HEIGHT = 2 * CONFLICT_MERGE_SYNC_BUTTON_HEIGHT + CONFLICT_MERGE_SYNC_BUTTON_GAP
const SELECTION_BUTTON_HEIGHT = 40

/**
 * Both versions of a conflicted file, as returned by the documents-provider
 * command get-conflict-merge-contents. The times are milliseconds since the
 * epoch and the sizes are UTF-8 bytes; fields the main process could not
 * determine are absent.
 */
export interface ConflictMergeContents {
  sessionId: string
  /** The unsaved contents the editor held when the comparison began */
  editorContents: string
  /** The contents of the file on disk (the newest one the main process saw) */
  diskContents: string
  diskModifiedAt?: number
  diskSize?: number
  editorEditedAt?: number
  editorSize?: number
}

/**
 * A comparison of this window. The window and the pane are those the main
 * process named; the pane changes if the tab moves to another pane of the
 * window. The contents are undefined while they are being fetched.
 */
export interface ConflictMergeSession {
  filePath: string
  sessionId: string
  windowId: string
  leafId: string
  contents: ConflictMergeContents|undefined
}

/**
 * The window's list of comparisons, which App.vue provides and the editor
 * panes and editors inject: the pane that is the target of a session shows the
 * comparison, every other editor of the file becomes read-only and shows a
 * hint.
 */
export const CONFLICT_MERGE_REGISTRY_KEY = 'zettlr-lyh-conflict-merge-registry'

export interface ConflictMergeRegistry {
  /** The sessions of this window, oldest first */
  readonly sessions: readonly ConflictMergeSession[]
  /** Whether a comparison of the file is open in this window */
  hasSession: (filePath: string) => boolean
  /** Ends the session (after a commit, or if the main process rejected it) */
  finish: (filePath: string, sessionId: string) => void
  /** Fetches the contents of the session again (the disk may have changed) */
  refresh: (filePath: string, sessionId: string) => void
}

/**
 * Above this many changed characters in a scanned range, the diff falls back
 * to a faster but less precise algorithm (the MergeView default is 500).
 */
export const CONFLICT_MERGE_DIFF_SCAN_LIMIT = 1000

/**
 * After this many milliseconds, a detailed diff gives up and falls back to the
 * imprecise algorithm, so that very large, very different files cannot freeze
 * the window.
 */
export const CONFLICT_MERGE_DIFF_TIMEOUT_MILLISECONDS = 2000

/**
 * How many unchanged lines stay visible above and below every changed block
 * while the merge view shows only the differences (R55).
 */
export const CONFLICT_MERGE_COLLAPSE_MARGIN_LINES = 10

/**
 * Builds the reconfiguration that switches an existing MergeView between
 * showing the whole documents and showing only the changed blocks with
 * CONFLICT_MERGE_COLLAPSE_MARGIN_LINES unchanged lines around each (R55).
 * A collapsed stretch can still be expanded by clicking it; switching the
 * collapse off and on restores the collapsed state.
 *
 * @param   {boolean}      showOnlyDifferences  Whether to collapse unchanged stretches
 *
 * @return  {MergeConfig}                       The argument for MergeView.reconfigure
 */
export function buildCollapseUnchangedReconfiguration (showOnlyDifferences: boolean): MergeConfig {
  return {
    collapseUnchanged: showOnlyDifferences
      ? { margin: CONFLICT_MERGE_COLLAPSE_MARGIN_LINES }
      : undefined
  }
}

// ---------------------------------------------------------------------------
// Version information under the titles of the two panes
// ---------------------------------------------------------------------------

/**
 * Formats the time of a version as local "YYYY-MM-DD HH:MM:SS". A missing,
 * non-numeric or invalid time is "unknown"; the comparison never invents a
 * time.
 *
 * @param   {number|undefined}  timestamp  Milliseconds since the epoch
 *
 * @return  {string}                       The formatted time, or "unknown"
 */
export function formatVersionTime (timestamp: number|undefined): string {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) {
    return CONFLICT_MERGE_TEXT.unknown
  }
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) {
    return CONFLICT_MERGE_TEXT.unknown
  }
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * Formats the byte size of a version the way the main process does in its
 * dialogs: small sizes in bytes, larger ones as a rounded figure with the exact
 * byte count in parentheses. A missing, non-numeric or negative size is
 * "unknown"; a size of 0 bytes is a valid size.
 *
 * @param   {number|undefined}  size  The size in bytes
 *
 * @return  {string}                  The formatted size, or "unknown"
 */
export function formatVersionSize (size: number|undefined): string {
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
    return CONFLICT_MERGE_TEXT.unknown
  }
  const bytes = Math.round(size)
  if (bytes < 1024) {
    return bytes === 1 ? '1 byte' : `${bytes} bytes`
  }
  return `${formatSize(bytes, true)} (${bytes.toLocaleString('en-US')} bytes)`
}

/**
 * The line under the title of the left pane (the version on disk).
 *
 * @param   {number|undefined}  modifiedAt  The modification time of the file
 * @param   {number|undefined}  size        The size of the file in bytes
 *
 * @return  {string}                        "Modified <time> · <size>"
 */
export function buildDiskVersionInfo (modifiedAt: number|undefined, size: number|undefined): string {
  return `Modified ${formatVersionTime(modifiedAt)} · ${formatVersionSize(size)}`
}

/**
 * The line under the title of the right pane (the editor's version).
 *
 * @param   {number|undefined}  editedAt  The time of the last edit
 * @param   {number|undefined}  size      The serialized size in bytes
 *
 * @return  {string}                      "Unsaved changes · Last edited <time> · <size>"
 */
export function buildEditorVersionInfo (editedAt: number|undefined, size: number|undefined): string {
  return `Unsaved changes · Last edited ${formatVersionTime(editedAt)} · ${formatVersionSize(size)}`
}

// ---------------------------------------------------------------------------
// Copying blocks between the two panes (pure functions)
// ---------------------------------------------------------------------------

/**
 * The positions of a difference block, as @codemirror/merge reports them in
 * MergeView.chunks (its Chunk class has these four properties and more): a is
 * the left pane (the version on disk), b the right pane (the editor's
 * version). A bound pair of equal values means that the block is empty in that
 * pane; otherwise the end is one past the last line of the block (so it can
 * point past the end of the document).
 */
export interface ChunkRange {
  fromA: number
  toA: number
  fromB: number
  toB: number
}

/**
 * A change of one text: replace the characters from `from` to `to` by `insert`.
 */
export interface TextChange {
  from: number
  to: number
  insert: string
}

/**
 * The outcome of copying a block: which pane receives it, the change to apply
 * to the text of that pane, and the text of that pane after the change.
 */
export interface CopyChunkResult {
  target: PaneSide
  change: TextChange
  contents: string
}

/**
 * Copies one difference block as a whole from one pane to the other. The block
 * of the target pane (which may be empty) is replaced by the block of the
 * source pane (which may be empty, which deletes the block of the target). The
 * rules for the line break at the end of the block are those of
 * @codemirror/merge's own revert control, so that the result is identical to
 * what a single-direction revert button would produce. No other block of
 * either text changes.
 *
 * @param   {CopyDirection}  direction  'left-to-right' or 'right-to-left'
 * @param   {ChunkRange}     chunk      The block, in positions of the two texts
 * @param   {string}         left       The text of the left pane (the version on disk)
 * @param   {string}         right      The text of the right pane (the editor's version)
 *
 * @return  {CopyChunkResult}           The receiving pane, its change and its new text
 */
export function copyChunk (direction: CopyDirection, chunk: ChunkRange, left: string, right: string): CopyChunkResult {
  const toRight = direction === 'left-to-right'
  const source = toRight ? left : right
  const destination = toRight ? right : left
  const sourceFrom = toRight ? chunk.fromA : chunk.fromB
  const sourceTo = toRight ? chunk.toA : chunk.toB
  const destinationFrom = toRight ? chunk.fromB : chunk.fromA
  const destinationTo = toRight ? chunk.toB : chunk.toA

  let insert = source.slice(sourceFrom, Math.max(sourceFrom, sourceTo - 1))
  if (sourceFrom !== sourceTo && destinationTo <= destination.length) {
    insert += '\n'
  }
  const from = Math.min(destination.length, destinationFrom)
  const to = Math.min(destination.length, destinationTo)

  return {
    target: toRight ? 'right' : 'left',
    change: { from, to, insert },
    contents: destination.slice(0, from) + insert + destination.slice(to)
  }
}

/**
 * Returns the difference blocks that a selection in one pane intersects. A
 * block that has lines in the pane intersects if the selection covers at least
 * one character of it (the line break at its end counts); a block that is
 * empty in the pane (the other pane has lines the selected pane lacks) is
 * intersected if its insertion point lies strictly inside the selection, or,
 * when the length of the document is given, at the very start or very end of
 * the document while the selection reaches that end. An empty selection
 * intersects nothing.
 *
 * @param   {readonly ChunkRange[]}  chunks          The difference blocks, in document order
 * @param   {PaneSide}               side            The pane the selection is in
 * @param   {number}                 from            One end of the selection
 * @param   {number}                 to              The other end of the selection
 * @param   {number}                 documentLength  The length of the text of that pane, if known
 *
 * @return  {ChunkRange[]}                           The intersected blocks, in order
 */
export function chunksIntersectingSelection<T extends ChunkRange> (
  chunks: readonly T[],
  side: PaneSide,
  from: number,
  to: number,
  documentLength?: number
): T[] {
  const start = Math.min(from, to)
  const end = Math.max(from, to)
  if (start === end) {
    return []
  }

  return chunks.filter(chunk => {
    const chunkFrom = side === 'left' ? chunk.fromA : chunk.fromB
    const chunkTo = side === 'left' ? chunk.toA : chunk.toB
    if (chunkFrom === chunkTo) {
      if (start < chunkFrom && chunkFrom < end) {
        return true
      }
      if (documentLength === undefined) {
        return false
      }
      return (chunkFrom <= 0 && start <= 0) || (chunkFrom >= documentLength && end >= documentLength)
    }
    return start < chunkTo && end > chunkFrom
  })
}

/**
 * Finds the vertical positions of a stack of items that each want to sit at a
 * preferred position, without overlapping: an item that would overlap the
 * previous one moves down below it.
 *
 * @param   {readonly number[]}  preferredTops  The preferred tops, in ascending order
 * @param   {number}             height         The height of every item
 * @param   {number}             gap            The smallest distance between two items
 *
 * @return  {number[]}                          The tops to use
 */
export function layoutStackedTops (preferredTops: readonly number[], height: number, gap: number): number[] {
  let previousBottom = Number.NEGATIVE_INFINITY
  return preferredTops.map(preferred => {
    const top = Math.max(preferred, previousBottom + gap)
    previousBottom = top + height
    return top
  })
}

/**
 * Finds the top of the selection button: as close to the preferred top (the
 * vertical middle of the selection) as possible, inside the visible range, and
 * not on top of the block buttons.
 *
 * @param   {number}                                          preferredTop  The wanted top
 * @param   {number}                                          height        The height of the button
 * @param   {ReadonlyArray<{ top: number, bottom: number }>}  occupied      The vertical extents of the block buttons
 * @param   {number}                                          minimumTop    The smallest allowed top
 * @param   {number}                                          maximumTop    The largest allowed top
 *
 * @return  {number}                                                        The top to use
 */
export function placeSelectionButton (
  preferredTop: number,
  height: number,
  occupied: ReadonlyArray<{ top: number, bottom: number }>,
  minimumTop: number,
  maximumTop: number
): number {
  const upper = Math.max(minimumTop, maximumTop)
  const clamp = (value: number): number => Math.min(upper, Math.max(minimumTop, value))
  const overlaps = (top: number): boolean => occupied.some(extent => top < extent.bottom && top + height > extent.top)

  const wanted = clamp(preferredTop)
  if (!overlaps(wanted)) {
    return wanted
  }

  const candidates: number[] = []
  for (const extent of occupied) {
    candidates.push(clamp(extent.bottom + CONFLICT_MERGE_SYNC_BUTTON_GAP), clamp(extent.top - CONFLICT_MERGE_SYNC_BUTTON_GAP - height))
  }
  const free = candidates
    .filter(candidate => !overlaps(candidate))
    .sort((first, second) => Math.abs(first - wanted) - Math.abs(second - wanted))
  return free[0] ?? wanted
}

// ---------------------------------------------------------------------------
// The MergeView configuration
// ---------------------------------------------------------------------------

export interface ConflictMergeViewOptions {
  /** The version of the file on disk */
  diskContents: string
  /** The version the editor holds */
  editorContents: string
  /** Extensions both editors receive (line numbers, wrapping, theme, history, keymaps, …) */
  sharedExtensions?: Extension[]
}

/**
 * Builds the MergeView configuration (without the parent element) for a
 * conflicted file. Side a (shown on the left) holds the version on disk and
 * side b (shown on the right) the editor's version. Both sides are editable;
 * neither a read-only flag nor the single-direction revert controls of the
 * merge package are used, because the blocks are copied in both directions by
 * the buttons of a ConflictMergeSyncColumn. Changed blocks are highlighted with
 * gutter markers, and unchanged stretches stay visible so that the result can
 * be read as a whole.
 *
 * @param   {ConflictMergeViewOptions}  options  The texts and extensions
 *
 * @return  {DirectMergeConfig}                  The MergeView configuration
 */
export function buildConflictMergeViewConfig (options: ConflictMergeViewOptions): DirectMergeConfig {
  const sharedExtensions = options.sharedExtensions ?? []

  return {
    a: { doc: options.diskContents, extensions: [...sharedExtensions] },
    b: { doc: options.editorContents, extensions: [...sharedExtensions] },
    orientation: 'a-b',
    highlightChanges: true,
    gutter: true,
    diffConfig: {
      scanLimit: CONFLICT_MERGE_DIFF_SCAN_LIMIT,
      timeout: CONFLICT_MERGE_DIFF_TIMEOUT_MILLISECONDS
    }
  }
}

const readOnlyCompartment = new Compartment()

/**
 * Makes an editor read-only, or editable again. The editors of the other
 * panes that show a conflicted file use this for as long as the comparison is
 * open. The compartment is added to the state on first use, so the call also
 * works on a state that was created without it; after the state was recreated
 * (the editor reloaded its document), call it again.
 *
 * @param  {EditorView}  view      The editor
 * @param  {boolean}     readOnly  Whether the editor should be read-only
 */
export function setConflictReadOnly (view: EditorView, readOnly: boolean): void {
  const extension: Extension = readOnly
    ? [ EditorState.readOnly.of(true), Prec.highest(EditorView.editable.of(false)) ]
    : []

  if (readOnlyCompartment.get(view.state) === undefined) {
    if (readOnly) {
      view.dispatch({ effects: StateEffect.appendConfig.of(readOnlyCompartment.of(extension)) })
    }
    return
  }
  view.dispatch({ effects: readOnlyCompartment.reconfigure(extension) })
}

// ---------------------------------------------------------------------------
// The column of buttons between the two panes
// ---------------------------------------------------------------------------

export interface ConflictMergeSyncColumnOptions {
  /** Called after every redraw of the buttons (the layout may have changed) */
  onUpdate?: () => void
}

/**
 * The column between the two panes. It draws, next to every difference block,
 * a pair of buttons (→ writes the block of the left pane into the right pane,
 * ← the other way round), and, while one pane has a selection, a button in the
 * middle of the selection that copies every block the selection intersects. It
 * takes its blocks from MergeView.chunks, so it follows edits, collapsing and
 * scrolling. Create it first, put `extension` into the extensions of both
 * editors, then `attach` it to the MergeView that was built with them.
 */
export class ConflictMergeSyncColumn {
  /** The element that sits between the two panes */
  readonly element: HTMLElement
  /** The extension both editors need so that the column redraws on changes */
  readonly extension: Extension

  private mergeView: MergeView|null = null
  private frame: number|undefined
  private lastSelectionSide: PaneSide|undefined
  private selectionButton: HTMLButtonElement|null = null
  private readonly pairs: HTMLElement[] = []
  private readonly options: ConflictMergeSyncColumnOptions
  private readonly handleScroll = (): void => { this.scheduleUpdate() }

  constructor (options: ConflictMergeSyncColumnOptions = {}) {
    this.options = options
    this.element = document.createElement('div')
    this.element.className = 'conflict-merge-sync-column'
    this.element.style.width = `${CONFLICT_MERGE_CENTER_COLUMN_WIDTH}px`
    this.element.style.flex = `0 0 ${CONFLICT_MERGE_CENTER_COLUMN_WIDTH}px`
    this.element.style.position = 'relative'

    // A mouse press on a button must not move the focus (and with it the
    // visible selection) out of the editor; the keyboard still reaches them
    this.element.addEventListener('mousedown', event => {
      if (event.target instanceof Element && event.target.closest('button') !== null) {
        event.preventDefault()
      }
    })
    this.element.addEventListener('click', event => { this.handleClick(event) })

    this.extension = EditorView.updateListener.of(update => { this.handleEditorUpdate(update) })
  }

  /**
   * Puts the column between the two panes of the MergeView, which must have
   * been created with orientation 'a-b' (version on disk left).
   *
   * @param  {MergeView}  mergeView  The merge view
   */
  attach (mergeView: MergeView): void {
    this.mergeView = mergeView
    const editors = mergeView.dom.querySelector('.cm-mergeViewEditors')
    const rightPane = mergeView.b.dom.parentNode
    if (editors !== null && rightPane !== null) {
      editors.insertBefore(this.element, rightPane)
    }
    mergeView.dom.addEventListener('scroll', this.handleScroll)
    this.scheduleUpdate()
  }

  /**
   * Removes the column and stops all pending work.
   */
  destroy (): void {
    if (this.frame !== undefined) {
      if (typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(this.frame)
      } else {
        window.clearTimeout(this.frame)
      }
      this.frame = undefined
    }
    this.mergeView?.dom.removeEventListener('scroll', this.handleScroll)
    this.element.remove()
    this.mergeView = null
  }

  /**
   * Redraws the buttons in the next animation frame; several requests before
   * that frame result in one redraw.
   */
  scheduleUpdate (): void {
    if (this.frame !== undefined || this.mergeView === null) {
      return
    }
    const run = (): void => {
      this.frame = undefined
      this.update()
    }
    this.frame = typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame(run)
      : window.setTimeout(run, 0)
  }

  /**
   * Redraws the buttons now: one pair for every block in view, and the
   * selection button if a pane has a selection.
   */
  update (): void {
    const mergeView = this.mergeView
    if (mergeView === null) {
      return
    }

    const chunks = mergeView.chunks
    const viewportA = mergeView.a.viewport
    const viewportB = mergeView.b.viewport
    const indexes: number[] = []
    const preferredTops: number[] = []
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index]
      const inViewA = chunk.toA >= viewportA.from && chunk.fromA <= viewportA.to
      const inViewB = chunk.toB >= viewportB.from && chunk.fromB <= viewportB.to
      if (!inViewA && !inViewB) {
        if (chunk.fromA > viewportA.to && chunk.fromB > viewportB.to) {
          break
        }
        continue
      }
      indexes.push(index)
      preferredTops.push(mergeView.a.lineBlockAt(Math.min(chunk.fromA, mergeView.a.state.doc.length)).top)
    }
    const tops = layoutStackedTops(preferredTops, SYNC_PAIR_HEIGHT, CONFLICT_MERGE_SYNC_BUTTON_GAP * 2)

    while (this.pairs.length < indexes.length) {
      const pair = this.createPair()
      this.pairs.push(pair)
      this.element.insertBefore(pair, this.selectionButton)
    }
    while (this.pairs.length > indexes.length) {
      this.pairs.pop()?.remove()
    }
    indexes.forEach((chunkIndex, position) => {
      const pair = this.pairs[position]
      pair.dataset.chunk = String(chunkIndex)
      pair.style.top = `${tops[position]}px`
      pair.style.display = ''
    })

    this.updateSelectionButton(tops.map(top => ({ top, bottom: top + SYNC_PAIR_HEIGHT })))
    this.options.onUpdate?.()
  }

  /**
   * Copies one block to the other pane, as one undoable change of that pane.
   *
   * @param  {number}         chunkIndex  The index into MergeView.chunks
   * @param  {CopyDirection}  direction   The direction
   */
  copyBlock (chunkIndex: number, direction: CopyDirection): void {
    const mergeView = this.mergeView
    const chunk = mergeView?.chunks[chunkIndex]
    if (mergeView === null || chunk === undefined) {
      return
    }
    const result = copyChunk(direction, chunk, mergeView.a.state.doc.toString(), mergeView.b.state.doc.toString())
    const target = result.target === 'left' ? mergeView.a : mergeView.b
    target.dispatch({ changes: result.change, userEvent: 'revert' })
  }

  /**
   * Copies every block that the selection intersects from the pane of the
   * selection to the other pane, as one undoable change of that pane.
   */
  copySelection (): void {
    const mergeView = this.mergeView
    const side = this.selectedSide()
    if (mergeView === null || side === undefined) {
      return
    }
    const source = side === 'left' ? mergeView.a : mergeView.b
    const selection = source.state.selection.main
    const chunks = chunksIntersectingSelection(mergeView.chunks, side, selection.from, selection.to, source.state.doc.length)
    if (chunks.length === 0) {
      return
    }

    const direction: CopyDirection = side === 'left' ? 'left-to-right' : 'right-to-left'
    const left = mergeView.a.state.doc.toString()
    const right = mergeView.b.state.doc.toString()
    const target = side === 'left' ? mergeView.b : mergeView.a
    target.dispatch({
      changes: chunks.map(chunk => copyChunk(direction, chunk, left, right).change),
      userEvent: 'revert'
    })
  }

  private createPair (): HTMLElement {
    const pair = document.createElement('div')
    pair.className = 'conflict-merge-sync-pair'
    pair.appendChild(this.createBlockButton('left-to-right'))
    pair.appendChild(this.createBlockButton('right-to-left'))
    return pair
  }

  private createBlockButton (direction: CopyDirection): HTMLButtonElement {
    const button = document.createElement('button')
    const label = direction === 'left-to-right'
      ? CONFLICT_MERGE_TEXT.copyBlockToRightAriaLabel
      : CONFLICT_MERGE_TEXT.copyBlockToLeftAriaLabel
    button.type = 'button'
    button.className = 'conflict-merge-sync-button'
    button.dataset.direction = direction
    button.textContent = direction === 'left-to-right' ? '→' : '←'
    button.title = label
    button.setAttribute('aria-label', label)
    return button
  }

  /**
   * The pane whose selection the selection button acts on: the pane whose
   * selection changed most recently if it still has one, else a pane that has
   * a selection, else none.
   */
  private selectedSide (): PaneSide|undefined {
    const mergeView = this.mergeView
    if (mergeView === null) {
      return undefined
    }
    const hasSelection = (side: PaneSide): boolean => {
      return !(side === 'left' ? mergeView.a : mergeView.b).state.selection.main.empty
    }
    if (this.lastSelectionSide !== undefined && hasSelection(this.lastSelectionSide)) {
      return this.lastSelectionSide
    }
    if (hasSelection('left')) {
      return 'left'
    }
    if (hasSelection('right')) {
      return 'right'
    }
    return undefined
  }

  private updateSelectionButton (occupied: ReadonlyArray<{ top: number, bottom: number }>): void {
    const mergeView = this.mergeView
    const side = this.selectedSide()
    if (mergeView === null || side === undefined) {
      this.selectionButton?.remove()
      this.selectionButton = null
      return
    }

    const view = side === 'left' ? mergeView.a : mergeView.b
    const selection = view.state.selection.main
    const intersected = chunksIntersectingSelection(mergeView.chunks, side, selection.from, selection.to, view.state.doc.length)
    const selectedChunks = new Set(intersected)
    const selectedExtents: Array<{ top: number, bottom: number }> = []
    const remainingExtents = occupied.filter((extent, index) => {
      const pair = this.pairs[index]
      const chunk = mergeView.chunks[Number(pair.dataset.chunk)]
      if (!selectedChunks.has(chunk)) {
        return true
      }
      // Leave the other block controls where they were, and replace only the
      // controls belonging to the selected blocks with the selection action.
      pair.style.display = 'none'
      selectedExtents.push(extent)
      return false
    })

    if (this.selectionButton === null) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'conflict-merge-selection-button'
      this.element.appendChild(button)
      this.selectionButton = button
    }
    const button = this.selectionButton
    button.dataset.side = side
    button.textContent = side === 'left'
      ? CONFLICT_MERGE_TEXT.copySelectionToRight
      : CONFLICT_MERGE_TEXT.copySelectionToLeft
    button.disabled = intersected.length === 0
    const description = intersected.length === 0
      ? CONFLICT_MERGE_TEXT.noDifferencesInSelection
      : side === 'left'
        ? 'Copy every difference block intersecting the selection from the left pane to the right pane'
        : 'Copy every difference block intersecting the selection from the right pane to the left pane'
    button.title = description
    button.setAttribute('aria-label', description)

    // In the middle of the selection, kept inside the part of the column that
    // is currently scrolled into view
    const middle = (view.lineBlockAt(selection.from).top + view.lineBlockAt(selection.to).bottom) / 2
    const scroller = mergeView.dom
    const visibleHeight = scroller.clientHeight
    const minimumTop = visibleHeight > 0 ? scroller.scrollTop + 4 : 0
    const maximumTop = visibleHeight > 0
      ? scroller.scrollTop + visibleHeight - SELECTION_BUTTON_HEIGHT - 4
      : Number.POSITIVE_INFINITY
    let preferredTop = middle - SELECTION_BUTTON_HEIGHT / 2
    if (selectedExtents.length > 0) {
      const firstTop = selectedExtents[0].top
      const lastBottom = selectedExtents[selectedExtents.length - 1].bottom
      preferredTop = Math.max(firstTop, Math.min(preferredTop, lastBottom - SELECTION_BUTTON_HEIGHT))
    }
    button.style.top = `${placeSelectionButton(preferredTop, SELECTION_BUTTON_HEIGHT, remainingExtents, minimumTop, maximumTop)}px`
  }

  private handleEditorUpdate (update: ViewUpdate): void {
    const mergeView = this.mergeView
    if (mergeView === null) {
      return
    }
    if (update.selectionSet && !update.state.selection.main.empty) {
      this.lastSelectionSide = update.view === mergeView.a ? 'left' : 'right'
    }
    if (update.docChanged || update.selectionSet || update.heightChanged || update.viewportChanged || update.geometryChanged) {
      this.scheduleUpdate()
    }
  }

  private handleClick (event: MouseEvent): void {
    if (!(event.target instanceof Element)) {
      return
    }
    const button = event.target.closest('button')
    if (button === null || button.disabled) {
      return
    }
    if (button.classList.contains('conflict-merge-selection-button')) {
      this.copySelection()
      return
    }
    const chunkIndex = Number(button.parentElement?.dataset.chunk)
    const direction = button.dataset.direction
    if (Number.isInteger(chunkIndex) && (direction === 'left-to-right' || direction === 'right-to-left')) {
      this.copyBlock(chunkIndex, direction)
    }
  }
}

// ---------------------------------------------------------------------------
// Messages with the main process
// ---------------------------------------------------------------------------

/**
 * Checks the reply of get-conflict-merge-contents. Anything but an object
 * with two string properties and a session identifier (including undefined,
 * which the main process returns when it holds no comparison for the file) is
 * rejected.
 *
 * @param   {unknown}  value  The reply
 *
 * @return  {boolean}         Whether the reply holds both versions
 */
export function isConflictMergeContents (value: unknown): value is ConflictMergeContents {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return typeof candidate.editorContents === 'string' && typeof candidate.diskContents === 'string' &&
    typeof candidate.sessionId === 'string' && candidate.sessionId !== ''
}

/**
 * Builds the command that fetches both versions of a conflicted file, with the
 * times and sizes shown under the titles of the panes.
 *
 * @param   {string}                 filePath   The conflicted file
 * @param   {string}                 sessionId  The comparison
 *
 * @return  {DocumentManagerIPCAPI}             The documents-provider command
 */
export function buildGetConflictMergeContentsCommand (filePath: string, sessionId: string): DocumentManagerIPCAPI {
  return { command: 'get-conflict-merge-contents', payload: { path: filePath, sessionId } }
}

/**
 * The command that submits the comparison: the file and the session, which of
 * the three buttons was pressed, and the current texts of both panes.
 */
export interface CommitConflictMergeCommand {
  command: 'commit-conflict-merge'
  payload: {
    path: string
    sessionId: string
    choice: ConflictMergeChoice
    leftContents: string
    rightContents: string
  }
}

/**
 * Builds the command that submits the comparison. Both texts are always sent,
 * whatever the choice, because the main process decides what to write, what to
 * back up and what to compare against.
 *
 * @param   {string}               filePath       The conflicted file
 * @param   {string}               sessionId      The comparison
 * @param   {ConflictMergeChoice}  choice         The button that was pressed
 * @param   {string}               leftContents   The current text of the left pane (disk)
 * @param   {string}               rightContents  The current text of the right pane (yours)
 *
 * @return  {CommitConflictMergeCommand}          The documents-provider command
 */
export function buildCommitConflictMergeCommand (
  filePath: string,
  sessionId: string,
  choice: ConflictMergeChoice,
  leftContents: string,
  rightContents: string
): CommitConflictMergeCommand {
  return { command: 'commit-conflict-merge', payload: { path: filePath, sessionId, choice, leftContents, rightContents } }
}

export type CommitConflictMergeFailureReason = 'stale'|'disk-changed'|'missing'|'backup-failed'|'copy-failed'|'write-failed'

/**
 * The reply of commit-conflict-merge.
 */
export type CommitConflictMergeResult =
  | { ok: true }
  | { ok: false, reason: CommitConflictMergeFailureReason, message?: string }

const COMMIT_FAILURE_REASONS: readonly string[] = [ 'stale', 'disk-changed', 'missing', 'backup-failed', 'copy-failed', 'write-failed' ]

/**
 * Reads the reply of commit-conflict-merge. A reply that is not one of the two
 * documented shapes (including the false of the former command) counts as a
 * failure to write, so that the comparison stays open with both texts intact.
 *
 * @param   {unknown}  value  The reply
 *
 * @return  {CommitConflictMergeResult}  The reply as a typed value
 */
export function parseCommitConflictMergeResult (value: unknown): CommitConflictMergeResult {
  if (typeof value === 'object' && value !== null) {
    const candidate = value as Record<string, unknown>
    if (candidate.ok === true) {
      return { ok: true }
    }
    if (candidate.ok === false && typeof candidate.reason === 'string' && COMMIT_FAILURE_REASONS.includes(candidate.reason)) {
      return {
        ok: false,
        reason: candidate.reason as CommitConflictMergeFailureReason,
        message: typeof candidate.message === 'string' ? candidate.message : undefined
      }
    }
  }
  return { ok: false, reason: 'write-failed', message: 'The main process sent an unexpected reply' }
}

/**
 * What the comparison view does about a failed commit: show a message and stay
 * open, wait for the newest disk version (the main process announces it with
 * file-conflict-disk-changed; the view asks for it as well), or close because
 * the session no longer exists.
 */
export type CommitFailureHandling =
  | { action: 'show-error', text: string }
  | { action: 'refresh' }
  | { action: 'close' }

/**
 * Decides what to do about a failed commit and words the error message.
 *
 * @param   {CommitConflictMergeResult}  failure   The failed reply
 * @param   {string}                     fileName  The name of the file, for the message
 *
 * @return  {CommitFailureHandling}                What to do
 */
export function handleCommitFailure (failure: { reason: CommitConflictMergeFailureReason, message?: string }, fileName: string): CommitFailureHandling {
  const message = failure.message ?? 'unknown error'
  switch (failure.reason) {
    case 'backup-failed':
      return { action: 'show-error', text: `Could not back up your unsaved changes: ${message}. Nothing was changed.` }
    case 'copy-failed':
      return { action: 'show-error', text: `Could not save the copy: ${message}. Nothing was changed.` }
    case 'write-failed':
      return { action: 'show-error', text: `Could not save "${fileName}": ${message}. Your versions are still here; try again.` }
    case 'disk-changed':
      return { action: 'refresh' }
    case 'stale':
    case 'missing':
      return { action: 'close' }
  }
}

// ---------------------------------------------------------------------------
// Which window and pane show a comparison
// ---------------------------------------------------------------------------

/**
 * Decides whether a main window handles a request for a comparison. A request
 * addressed to another window is ignored; a request without an address is
 * handled by every window that has the file open in one of its panes.
 *
 * @param   {string|undefined}  requestWindowId  The window the request names, if any
 * @param   {string}            ownWindowId      This window
 * @param   {string}            filePath         The conflicted file
 * @param   {string[]}          openFilePaths    The files open in this window
 *
 * @return  {boolean}                            Whether this window handles it
 */
export function shouldHandleConflictMerge (
  requestWindowId: string|undefined,
  ownWindowId: string,
  filePath: string,
  openFilePaths: string[]
): boolean {
  if (requestWindowId !== undefined) {
    return requestWindowId === ownWindowId
  }
  return openFilePaths.includes(filePath)
}

/**
 * What the window knows of one of its panes: the files open in it and the
 * active one.
 */
export interface ConflictMergePaneSummary {
  id: string
  openFiles: string[]
  activeFile?: string
}

/**
 * Chooses the pane that shows the comparison of a file: the pane the main
 * process named if it still has the file open, else the pane that shows the
 * file as its active tab, else the first pane that has it open. Without any
 * such pane, there is nothing to show the comparison in.
 *
 * @param   {string|undefined}                       requestedLeafId  The pane the main process named, if any
 * @param   {readonly ConflictMergePaneSummary[]}    panes            The panes of this window
 * @param   {string}                                 filePath         The conflicted file
 *
 * @return  {string|undefined}                                        The identifier of the pane
 */
export function resolveConflictMergeLeaf (
  requestedLeafId: string|undefined,
  panes: readonly ConflictMergePaneSummary[],
  filePath: string
): string|undefined {
  const holding = panes.filter(pane => pane.openFiles.includes(filePath))
  if (holding.length === 0) {
    return undefined
  }
  if (requestedLeafId !== undefined && holding.some(pane => pane.id === requestedLeafId)) {
    return requestedLeafId
  }
  return (holding.find(pane => pane.activeFile === filePath) ?? holding[0]).id
}

/**
 * Keeps the merge requests of a window in a first come, first served queue,
 * so that only one is current at a time. A request for a file that is already
 * current or waiting is dropped. (The comparison view of R138 shows every
 * session in its own pane and no longer needs the queue; the class stays for
 * callers that serialize requests.)
 */
export class ConflictMergeQueue {
  private readonly filePaths: string[] = []
  private readonly sessionIds = new Map<string, string>()

  /**
   * The file whose merge view is shown, if any
   */
  get current (): string|undefined {
    return this.filePaths[0]
  }

  get currentSessionId (): string|undefined {
    return this.current === undefined ? undefined : this.sessionIds.get(this.current)
  }

  /**
   * The files waiting for their merge view, oldest first
   */
  get waiting (): string[] {
    return this.filePaths.slice(1)
  }

  /**
   * How many requests the queue holds, including the current one
   */
  get size (): number {
    return this.filePaths.length
  }

  /**
   * Adds a request.
   *
   * @param   {string}   filePath  The conflicted file
   *
   * @return  {boolean}            Whether the request became current at once
   */
  enqueue (filePath: string, sessionId = ''): boolean {
    if (this.filePaths.includes(filePath)) {
      return false
    }
    this.filePaths.push(filePath)
    this.sessionIds.set(filePath, sessionId)
    return this.filePaths.length === 1
  }

  /**
   * Finishes the current request. Does nothing when the given file is not
   * current, so that a late or repeated finish cannot skip a waiting request.
   *
   * @param   {string}            filePath  The file whose merge view closed
   *
   * @return  {string|undefined}            The new current file, if any
   */
  finish (filePath: string, sessionId?: string): string|undefined {
    if (this.filePaths[0] === filePath && (sessionId === undefined || this.sessionIds.get(filePath) === sessionId)) {
      this.filePaths.shift()
      this.sessionIds.delete(filePath)
    }
    return this.current
  }
}
