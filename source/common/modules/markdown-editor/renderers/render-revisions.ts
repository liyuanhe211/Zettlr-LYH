/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        renderRevisions, revisionDecorationField,
 *                  revisionShowsSource, trackChangesFromConfiguration,
 *                  applyRevisionAction, revisionAcceptedCopyText,
 *                  revisionVisibleCopyText, revisionCopyText,
 *                  moveOverHiddenRevisions, protectHiddenRevisions
 * CVM-Role:        View
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH: displays tracked changes (spec C10, "Display").
 *                  With Show Revisions on, inserted text is coloured and
 *                  underlined and deleted text coloured and struck through,
 *                  while the brackets and attribute blocks are hidden; author
 *                  and date stay invisible. With Show Revisions off, the text
 *                  appears as if every revision had been accepted. Also links
 *                  the editor configuration to the Track Changes extension,
 *                  runs the toolbar commands Accept and Reject, and computes
 *                  the clipboard text with every revision accepted. Hidden
 *                  revision text is atomic for the cursor, arrow keys cross
 *                  it in one press, and with Track Changes off Backspace and
 *                  Delete do not remove it (Decision 107).
 *
 * END HEADER
 */

import { syntaxTree } from '@codemirror/language'
import {
  ChangeSet,
  EditorSelection,
  EditorState,
  type RangeSet,
  RangeSetBuilder,
  RangeValue,
  StateField,
  Transaction,
  findClusterBreak,
  type Extension,
  type Range,
  type SelectionRange,
  type Text,
  type TransactionSpec
} from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import type { Tree } from '@lezer/common'
import { configField } from '../util/configuration'
import { shouldRevealSource } from '../util/reveal-selection'
import {
  findRevisions,
  findRevisionsInTree,
  revisionActionAtSelection,
  revisionVisibleFrom,
  revisionVisibleTo,
  type RevisionRange
} from '../revisions/revision-model'
import { revisionTransaction, trackChangesConfig } from '../revisions/track-changes'

/**
 * Author name recorded while Track Changes is on but no author name is set
 * (for example when the option was ticked directly in the preferences)
 */
export const UNKNOWN_REVISION_AUTHOR = 'Unknown author'

/**
 * CSS classes of the visible text of revisions while Show Revisions is on
 */
export const REVISION_INSERTION_CLASS = 'cm-revision-insertion'
export const REVISION_DELETION_CLASS = 'cm-revision-deletion'

const insertionMark = Decoration.mark({ class: REVISION_INSERTION_CLASS })
const deletionMark = Decoration.mark({ class: REVISION_DELETION_CLASS })
const hiddenMarkup = Decoration.replace({})

const revisionCache = new WeakMap<Tree, { doc: Text, revisions: RevisionRange[] }>()

/**
 * All revisions of the document as far as the syntax tree has been parsed,
 * cached per syntax tree.
 *
 * @param   {EditorState}      state  The state
 *
 * @return  {RevisionRange[]}         The outer revisions, sorted
 */
function currentRevisions (state: EditorState): RevisionRange[] {
  const tree = syntaxTree(state)
  const cached = revisionCache.get(tree)
  if (cached !== undefined && cached.doc === state.doc) {
    return cached.revisions
  }

  const revisions = findRevisionsInTree(state, tree, 0, state.doc.length)
  revisionCache.set(tree, { doc: state.doc, revisions })
  return revisions
}

/**
 * Whether a revision currently shows its Markdown source (spec C10, display
 * items 3 and 4): always in raw mode; never while Track Changes is on, so that
 * the attribute block does not unfold on every keystroke; otherwise according
 * to the shared source display rule of spec C6 with the category `revisions`.
 *
 * @param   {EditorState}    state     The state
 * @param   {RevisionRange}  revision  The revision
 *
 * @return  {boolean}                  True if the source is shown
 */
export function revisionShowsSource (state: EditorState, revision: RevisionRange): boolean {
  const configuration = state.field(configField, false)
  if (configuration === undefined || configuration.renderingMode === 'raw') {
    return true
  }

  if (configuration.trackChanges) {
    return false
  }

  return shouldRevealSource(state, 'revisions', revision.from, revision.to, configuration.previewModeShowSyntaxWhenCursorIsAdjacent)
}

/**
 * Builds the decorations of all revisions of a state.
 *
 * @param   {EditorState}    state  The state
 *
 * @return  {DecorationSet}         The decorations
 */
function buildRevisionDecorations (state: EditorState): DecorationSet {
  const configuration = state.field(configField, false)
  if (configuration === undefined || configuration.renderingMode === 'raw') {
    return Decoration.none
  }

  const showRevisions = configuration.showRevisions
  const ranges: Array<Range<Decoration>> = []
  for (const revision of currentRevisions(state)) {
    if (revisionShowsSource(state, revision)) {
      continue
    }

    const visibleFrom = revisionVisibleFrom(revision)
    const visibleTo = revisionVisibleTo(revision)

    if (!showRevisions && revision.kind === 'deletion') {
      // The accepted text does not contain deletions at all
      ranges.push(hiddenMarkup.range(revision.from, revision.to))
      continue
    }

    ranges.push(hiddenMarkup.range(revision.from, visibleFrom))
    if (showRevisions && visibleFrom < visibleTo) {
      ranges.push((revision.kind === 'insertion' ? insertionMark : deletionMark).range(visibleFrom, visibleTo))
    }
    ranges.push(hiddenMarkup.range(visibleTo, revision.to))
  }

  return Decoration.set(ranges, true)
}

/**
 * The revision decorations. A state field rather than a view plugin, since a
 * hidden deletion may contain soft line breaks, which only decorations from
 * the state may replace.
 */
export const revisionDecorationField = StateField.define<DecorationSet>({
  create (state) {
    return buildRevisionDecorations(state)
  },
  update (value, transaction) {
    const unchanged = !transaction.docChanged &&
      transaction.selection === undefined &&
      transaction.effects.length === 0 &&
      syntaxTree(transaction.state) === syntaxTree(transaction.startState) &&
      transaction.state.field(configField, false) === transaction.startState.field(configField, false)
    return unchanged ? value : buildRevisionDecorations(transaction.state)
  },
  provide: field => EditorView.decorations.from(field)
})

/**
 * Hidden revision text as plain range values
 */
class HiddenRevisionValue extends RangeValue {}

const hiddenRevisionValue = new HiddenRevisionValue()

const hiddenCache = new WeakMap<DecorationSet, Array<{ from: number, to: number }>>()

/**
 * The ranges that the revision decorations currently hide (markup, and with
 * Show Revisions off whole deletions), sorted and with touching ranges joined.
 *
 * @param   {EditorState}                         state  The state
 *
 * @return  {Array<{ from: number, to: number }>}        The hidden ranges
 */
function hiddenRevisionRanges (state: EditorState): Array<{ from: number, to: number }> {
  const decorations = state.field(revisionDecorationField, false)
  if (decorations === undefined) {
    return []
  }
  const cached = hiddenCache.get(decorations)
  if (cached !== undefined) {
    return cached
  }

  const ranges: Array<{ from: number, to: number }> = []
  decorations.between(0, state.doc.length, (from, to, value) => {
    if (value !== hiddenMarkup || from >= to) {
      return
    }
    const last = ranges[ranges.length - 1]
    if (last !== undefined && from <= last.to) {
      last.to = Math.max(last.to, to)
    } else {
      ranges.push({ from, to })
    }
  })
  hiddenCache.set(decorations, ranges)
  return ranges
}

const atomicCache = new WeakMap<Array<{ from: number, to: number }>, RangeSet<RangeValue>>()

/**
 * The hidden revision text as atomic ranges for the cursor (Decision 107,
 * problems 1 and 2): the cursor never stops inside hidden text, whether Track
 * Changes is on or off.
 */
function hiddenRevisionAtomicRanges (view: EditorView): RangeSet<RangeValue> {
  const ranges = hiddenRevisionRanges(view.state)
  const cached = atomicCache.get(ranges)
  if (cached !== undefined) {
    return cached
  }
  const builder = new RangeSetBuilder<RangeValue>()
  for (const { from, to } of ranges) {
    builder.add(from, to, hiddenRevisionValue)
  }
  const set = builder.finish()
  atomicCache.set(ranges, set)
  return set
}

/**
 * The hidden range that contains a position strictly or, with `side`, touches
 * it from that side
 */
function hiddenRangeAt (ranges: Array<{ from: number, to: number }>, position: number, side: -1|1): { from: number, to: number }|undefined {
  return ranges.find(range => side < 0 ? range.from < position && position <= range.to : range.from <= position && position < range.to)
}

/**
 * Whether [from, to] consists of hidden text only
 */
function isHidden (ranges: Array<{ from: number, to: number }>, from: number, to: number): boolean {
  return from < to && ranges.some(range => range.from <= from && to <= range.to)
}

/**
 * The position behind (or in front of) the hidden text that touches a position
 */
function skipHidden (ranges: Array<{ from: number, to: number }>, position: number, forward: boolean): number {
  const range = hiddenRangeAt(ranges, position, forward ? 1 : -1)
  return range === undefined ? position : (forward ? range.to : range.from)
}

/**
 * The position one character (grapheme cluster or line break) before or after
 * a position
 */
function characterStep (state: EditorState, position: number, forward: boolean): number {
  const line = state.doc.lineAt(position)
  if (forward) {
    return position === line.to ? position + 1 : line.from + findClusterBreak(line.text, position - line.from, true)
  }
  return position === line.from ? position - 1 : line.from + findClusterBreak(line.text, position - line.from, false)
}

/**
 * Keeps a keyboard cursor motion from ending on the same spot of the screen
 * (Decision 107, problem 2): when a motion only crossed hidden revision text,
 * the cursor moves on by one visible character in the same direction. Mouse
 * selections and document changes pass unchanged.
 *
 * @param   {Transaction}                  transaction  The transaction
 *
 * @return  {Transaction|TransactionSpec}               The adjusted transaction
 */
export function moveOverHiddenRevisions (transaction: Transaction): Transaction|TransactionSpec {
  if (
    transaction.docChanged || transaction.selection === undefined ||
    !transaction.isUserEvent('select') || transaction.isUserEvent('select.pointer')
  ) {
    return transaction
  }

  const startState = transaction.startState
  const before = hiddenRevisionRanges(startState)
  if (before.length === 0) {
    return transaction
  }
  const oldRanges = startState.selection.ranges
  const newSelection = transaction.newSelection
  if (oldRanges.length !== newSelection.ranges.length) {
    return transaction
  }

  let after: Array<{ from: number, to: number }>|undefined
  let changed = false
  const ranges = newSelection.ranges.map((range, index): SelectionRange => {
    const oldHead = oldRanges[index].head
    const head = range.head
    const from = Math.min(oldHead, head)
    const to = Math.max(oldHead, head)
    if (!isHidden(before, from, to)) {
      return range
    }
    after = after ?? hiddenRevisionRanges(transaction.state)
    if (!isHidden(after, from, to)) {
      return range
    }

    const forward = head > oldHead
    let target = skipHidden(after, head, forward)
    if (forward ? target >= startState.doc.length : target <= 0) {
      return range
    }
    target = characterStep(startState, target, forward)
    const inside = after.find(hidden => hidden.from < target && target < hidden.to)
    if (inside !== undefined) {
      target = forward ? inside.to : inside.from
    }
    changed = true
    return range.empty
      ? EditorSelection.cursor(target, forward ? -1 : 1)
      : EditorSelection.range(range.anchor, target)
  })

  if (!changed) {
    return transaction
  }

  const userEvent = transaction.annotation(Transaction.userEvent)
  return {
    selection: EditorSelection.create(ranges, newSelection.mainIndex),
    effects: transaction.effects,
    annotations: userEvent !== undefined ? Transaction.userEvent.of(userEvent) : [],
    scrollIntoView: transaction.scrollIntoView
  }
}

/**
 * While Track Changes is off, keeps Backspace and Delete from removing hidden
 * revision text (Decision 107, problem 1): a deletion that would only remove
 * hidden text removes the neighbouring visible character instead, and one
 * that removes the last visible character of a revision whose markup is
 * hidden removes the whole revision. While Track Changes is on, its own filter
 * handles deletions next to revisions.
 *
 * @param   {Transaction}                  transaction  The transaction
 *
 * @return  {Transaction|TransactionSpec}               The adjusted transaction
 */
export function protectHiddenRevisions (transaction: Transaction): Transaction|TransactionSpec {
  if (!transaction.docChanged || transaction.annotation(revisionTransaction) === true) {
    return transaction
  }
  const backward = transaction.isUserEvent('delete.backward')
  if (!backward && !transaction.isUserEvent('delete.forward')) {
    return transaction
  }
  const state = transaction.startState
  if (state.facet(trackChangesConfig).enabled) {
    return transaction
  }
  const hidden = hiddenRevisionRanges(state)
  if (hidden.length === 0) {
    return transaction
  }

  const original: Array<{ fromA: number, toA: number, inserted: number }> = []
  transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    original.push({ fromA, toA, inserted: inserted.length })
  })
  if (original.some(change => change.inserted > 0)) {
    return transaction
  }

  const revisions = currentRevisions(state).filter(revision => !revisionShowsSource(state, revision))
  const changes: Array<{ from: number, to: number }> = []
  let changed = false
  for (const { fromA, toA } of original) {
    let from = fromA
    let to = toA
    if (isHidden(hidden, from, to)) {
      if (backward) {
        to = skipHidden(hidden, from, false)
        from = to > 0 ? characterStep(state, to, false) : to
      } else {
        from = skipHidden(hidden, to, true)
        to = from < state.doc.length ? characterStep(state, from, true) : from
      }
    }

    // A revision whose visible text disappears completely goes as a whole
    const emptied = revisions.find(revision => {
      const visibleFrom = revisionVisibleFrom(revision)
      const visibleTo = revisionVisibleTo(revision)
      return visibleFrom < visibleTo && from <= visibleFrom && visibleTo <= to && revision.from <= from && to <= revision.to
    })
    if (emptied !== undefined) {
      from = emptied.from
      to = emptied.to
    }

    if (from !== fromA || to !== toA) {
      changed = true
    }
    if (from < to) {
      changes.push({ from, to })
    }
  }

  if (!changed) {
    return transaction
  }
  for (let index = 1; index < changes.length; index++) {
    if (changes[index].from < changes[index - 1].to) {
      return transaction
    }
  }

  const changeSet = ChangeSet.of(changes, state.doc.length)
  const cursors = changes.length > 0
    ? changes.map(change => EditorSelection.cursor(changeSet.mapPos(change.from, -1)))
    : state.selection.ranges.map(range => EditorSelection.cursor(range.head))
  const userEvent = transaction.annotation(Transaction.userEvent)
  return {
    changes: changeSet,
    selection: EditorSelection.create(cursors, Math.min(state.selection.mainIndex, cursors.length - 1)),
    effects: transaction.effects,
    annotations: userEvent !== undefined ? Transaction.userEvent.of(userEvent) : [],
    scrollIntoView: transaction.scrollIntoView
  }
}

/**
 * The revision renderer with its light and dark colours, the atomic ranges
 * over hidden revision text and the filters that keep the cursor and deletions
 * out of it
 */
export const renderRevisions: Extension = [
  revisionDecorationField,
  EditorView.atomicRanges.of(hiddenRevisionAtomicRanges),
  EditorState.transactionFilter.of(moveOverHiddenRevisions),
  EditorState.transactionFilter.of(protectHiddenRevisions),
  EditorView.baseTheme({
    [`.${REVISION_INSERTION_CLASS}`]: {
      color: '#1a7f37',
      textDecoration: 'underline',
      textDecorationColor: '#1a7f37'
    },
    [`.${REVISION_DELETION_CLASS}`]: {
      color: '#cf222e',
      textDecoration: 'line-through',
      textDecorationColor: '#cf222e'
    },
    [`&dark .${REVISION_INSERTION_CLASS}`]: {
      color: '#56d364',
      textDecorationColor: '#56d364'
    },
    [`&dark .${REVISION_DELETION_CLASS}`]: {
      color: '#ff7b72',
      textDecorationColor: '#ff7b72'
    }
  })
]

const currentTime = (): Date => new Date()

/**
 * Feeds the Track Changes extension from the editor configuration
 * (`trackChanges` and `revisionAuthor`), so that a configuration update takes
 * effect immediately. An empty author name is recorded as "Unknown author".
 */
export const trackChangesFromConfiguration: Extension = trackChangesConfig.compute([configField], state => {
  const configuration = state.field(configField)
  const author = configuration.revisionAuthor.trim() === '' ? UNKNOWN_REVISION_AUTHOR : configuration.revisionAuthor
  return { enabled: configuration.trackChanges, author, now: currentTime }
})

/**
 * Runs the toolbar command Accept or Reject on an editor (spec C10, accept and
 * reject item 4) and returns the focus to the editor.
 *
 * @param   {EditorView}           view    The editor
 * @param   {'accept'|'reject'}    action  The action
 *
 * @return  {boolean}                      True if a transaction was dispatched
 */
export function applyRevisionAction (view: EditorView, action: 'accept'|'reject'): boolean {
  const transaction = view.state.readOnly ? null : revisionActionAtSelection(view.state, action)
  if (transaction !== null) {
    view.dispatch(transaction)
  }
  view.focus()
  return transaction !== null
}

/**
 * The text of a range with every revision accepted: insertions keep their
 * content, deletions and all markup disappear.
 */
function acceptedText (state: EditorState, revisions: RevisionRange[], from: number, to: number): string {
  let text = ''
  let position = from
  for (const revision of revisions) {
    if (revision.to <= from || revision.from >= to) {
      continue
    }

    text += state.sliceDoc(position, Math.max(position, revision.from))
    if (revision.kind === 'insertion') {
      const contentFrom = Math.max(from, revision.contentFrom)
      const contentTo = Math.min(to, revision.contentTo)
      if (contentFrom < contentTo) {
        text += state.sliceDoc(contentFrom, contentTo)
      }
    }
    position = Math.max(position, Math.min(to, revision.to))
  }

  return text + state.sliceDoc(position, to)
}

/**
 * The clipboard text of the selection while Show Revisions is off (spec C10,
 * "Copy"): the text with every revision accepted. Revisions that currently
 * show their source are copied as they are.
 *
 * @param   {EditorState}       state  The state
 *
 * @return  {string|undefined}         The text, or undefined if the ordinary
 *                                     copy rules apply (Show Revisions on, raw
 *                                     mode, or no hidden revision selected)
 */
export function revisionAcceptedCopyText (state: EditorState): string|undefined {
  const configuration = state.field(configField, false)
  if (configuration === undefined || configuration.showRevisions || configuration.renderingMode === 'raw') {
    return undefined
  }

  const ranges = state.selection.ranges.filter(range => !range.empty)
  if (ranges.length === 0) {
    return undefined
  }

  let affected = false
  const texts = ranges.map(range => {
    const revisions = findRevisions(state, range.from, range.to).filter(revision => {
      return revision.from < range.to && range.from < revision.to && !revisionShowsSource(state, revision)
    })
    if (revisions.length === 0) {
      return state.sliceDoc(range.from, range.to)
    }
    affected = true
    return acceptedText(state, revisions, range.from, range.to)
  })

  return affected ? texts.join(state.lineBreak) : undefined
}

/**
 * The clipboard text of the selection while Show Revisions is on, when the
 * selection cuts through a rendered revision (Decision 107, problem 4): the
 * cut revisions contribute only their selected visible text, without brackets
 * and attribute block, as on screen. Revisions the selection contains as a
 * whole keep their Markdown (spec C10, "Copy").
 *
 * @param   {EditorState}       state  The state
 *
 * @return  {string|undefined}         The text, or undefined if the ordinary
 *                                     copy rules apply (Show Revisions off,
 *                                     raw mode, or no revision cut through)
 */
export function revisionVisibleCopyText (state: EditorState): string|undefined {
  const configuration = state.field(configField, false)
  if (configuration === undefined || !configuration.showRevisions || configuration.renderingMode === 'raw') {
    return undefined
  }

  const ranges = state.selection.ranges.filter(range => !range.empty)
  if (ranges.length === 0) {
    return undefined
  }

  let affected = false
  const texts = ranges.map(range => {
    const cut = findRevisions(state, range.from, range.to).filter(revision => {
      return revision.from < range.to && range.from < revision.to &&
        !(range.from <= revision.from && revision.to <= range.to) &&
        !revisionShowsSource(state, revision)
    })
    if (cut.length === 0) {
      return state.sliceDoc(range.from, range.to)
    }

    affected = true
    let text = ''
    let position = range.from
    for (const revision of cut) {
      text += state.sliceDoc(position, Math.max(position, revision.from))
      const visibleFrom = Math.max(range.from, revisionVisibleFrom(revision))
      const visibleTo = Math.min(range.to, revisionVisibleTo(revision))
      if (visibleFrom < visibleTo) {
        text += state.sliceDoc(visibleFrom, visibleTo)
      }
      position = Math.max(position, Math.min(range.to, revision.to))
    }
    return text + state.sliceDoc(position, range.to)
  })

  return affected ? texts.join(state.lineBreak) : undefined
}

/**
 * The clipboard text of the selection as far as tracked changes decide it:
 * with Show Revisions off the accepted text, with Show Revisions on the
 * visible text of revisions the selection cuts through.
 *
 * @param   {EditorState}       state  The state
 *
 * @return  {string|undefined}         The text, or undefined if the ordinary
 *                                     copy rules apply
 */
export function revisionCopyText (state: EditorState): string|undefined {
  return revisionAcceptedCopyText(state) ?? revisionVisibleCopyText(state)
}
