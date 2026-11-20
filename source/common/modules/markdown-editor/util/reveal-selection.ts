/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        revealSelection, freezeRevealDuringPointerSelection,
 *                  pointerSelectionEndEffect, PointerRelease, CLICK_TOLERANCE
 * CVM-Role:        CodeMirror Extension
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     The renderers reveal the Markdown source of an element as
 *                  soon as the selection touches it. While the user drags a
 *                  selection with the mouse, that would make elements such as
 *                  images collapse into their source under the pointer: the
 *                  content below moves, the pointer suddenly maps onto other
 *                  text, the selection jumps there, more elements switch, and
 *                  the scroll position drifts away. Therefore, from the
 *                  mousedown until the mouse button is released, the renderers
 *                  decide what to reveal based on the selection as it was
 *                  before the mousedown. On release, the real selection takes
 *                  over again. The release is detected on mouseup, never on
 *                  pointerup: pointerup fires first, before CodeMirror has
 *                  placed the cursor of a click inside an existing selection,
 *                  so ending there would reveal the stale selection. The
 *                  document position under the released pointer is measured
 *                  just before the real selection takes over, while the
 *                  layout is still the one the user saw, so that the viewport
 *                  can keep exactly that text under the pointer. The release
 *                  also tells whether the press was a click (released where
 *                  it was pressed) or a drag, since a click that switches a
 *                  block's display is stabilized differently (specification
 *                  C13, section 3).
 *
 *                  While Auto Show Code is off, Markdown marks the user is
 *                  typing (or deleting) from the keyboard stay visible as
 *                  long as the cursor remains on their line, or within their
 *                  block for fenced code, math, HTML and Pandoc div blocks.
 *                  Once the cursor leaves, the element renders again, and
 *                  entering it later by click or arrow key does not reveal it.
 *
 * END HEADER
 */

import { type EditorSelection, type EditorState, type Extension, StateEffect, StateField, type Transaction } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import type { ViewUpdate } from '@codemirror/view'
import { configField } from './configuration'
import { defaultCodeEditingExceptions, type CodeEditingCategory } from './code-editing-policy'
import { rangeInSelection } from './range-in-selection'
import type { SyntaxNode, SyntaxNodeRef } from '@lezer/common'

export const freezeRevealSelectionEffect = StateEffect.define<EditorSelection>()

/**
 * Where the mouse button was released at the end of a pointer selection.
 */
export interface PointerRelease {
  /** Client y coordinate of the pointer on release */
  clientY: number
  /** Document position under the pointer on release, measured before the
   *  renderers reveal the final selection, or null if unavailable */
  position: number|null
  /** True if the pointer was released where it was pressed (within
   *  `CLICK_TOLERANCE` pixels), i.e. the press was a click and not a drag.
   *  Absent means unknown and is treated like a drag. */
  click?: boolean
}

/**
 * The largest distance (in pixels) between the press and the release of the
 * mouse button for which the press still counts as a click rather than a drag.
 */
export const CLICK_TOLERANCE = 4

/**
 * Carried by the transaction that ends a pointer selection. Its value
 * describes the release of the mouse button; it is null if the selection
 * ended in any other way (a cancelled pointer, native drag and drop of the
 * selected text, the window losing focus), since the pointer is then not over
 * text the user selected or clicked. Plugins that stabilize the viewport can
 * use it to keep the text under the pointer in place while the source of the
 * selected elements is revealed.
 */
export const pointerSelectionEndEffect = StateEffect.define<PointerRelease|null>({
  map: (value, mapping) => value === null || value.position === null
    ? value
    : { ...value, position: mapping.mapPos(value.position) }
})

const frozenSelectionField = StateField.define<EditorSelection|null>({
  create () {
    return null
  },
  update (value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(freezeRevealSelectionEffect)) {
        return effect.value
      } else if (effect.is(pointerSelectionEndEffect)) {
        return null
      }
    }

    return value !== null && transaction.docChanged ? value.map(transaction.changes) : value
  }
})

// Focus alone is deliberately not activation: CodeMirror focuses the old
// cursor before a pointer press has finished determining its real selection.
const revealInteractionField = StateField.define<{ active: boolean, frozen: boolean|null }>({
  create (state) {
    return { active: state.selection.ranges.some(range => range.head !== 0 || !range.empty), frozen: null }
  },
  update (value, transaction) {
    let { active, frozen } = value
    for (const effect of transaction.effects) {
      if (effect.is(freezeRevealSelectionEffect)) {
        frozen = active
      } else if (effect.is(pointerSelectionEndEffect)) {
        frozen = null
        active = true
      }
    }
    if (transaction.selection !== undefined || transaction.isUserEvent('input')) {
      active = true
    }
    return { active, frozen }
  }
})

/**
 * Syntax nodes besides the `...Mark` nodes whose characters count as Markdown
 * marks when the user types or deletes them.
 */
const TYPED_MARK_NODES = new Set([
  'CodeInfo', 'PandocDivInfo', 'PandocAttribute', 'HorizontalRule', 'TaskMarker', 'HTMLTag', 'Comment'
])

/**
 * Blocks whose tags are not separate syntax nodes. Within them, only typing
 * or deleting angle brackets counts as typing marks: the visible text of a
 * rendered HTML block stays directly editable (requirement R65).
 */
const TAG_BLOCKS = new Set([ 'HTMLBlock', 'CommentBlock' ])

/**
 * Blocks within which typed marks stay visible across lines. Outside of them,
 * typed marks stay visible only on their own line.
 */
const TYPING_REVEAL_BLOCKS = new Set([ 'FencedCode', 'HTMLBlock', 'PandocDiv', 'CommentBlock' ])

function isMarkNode (name: string): boolean {
  return name.endsWith('Mark') || TYPED_MARK_NODES.has(name)
}

/**
 * Returns the start (clamped into the range) of every Markdown mark that
 * overlaps the given non-empty range.
 */
function markPositionsIn (state: EditorState, from: number, to: number): number[] {
  const positions: number[] = []
  syntaxTree(state).iterate({
    from,
    to,
    enter (node) {
      if (isMarkNode(node.name) && node.from < to && node.to > from) {
        positions.push(Math.max(node.from, from))
      }
    }
  })
  return positions
}

/**
 * Only keyboard input, autocompletion and deletion count as typing marks.
 * Pasting, cutting, toolbar commands and automatic continuations do not.
 */
function isTypingTransaction (transaction: Transaction): boolean {
  return transaction.isUserEvent('input.type') || transaction.isUserEvent('input.complete') ||
    (transaction.isUserEvent('delete') && !transaction.isUserEvent('delete.cut'))
}

/** Whether the position lies within one of the `TAG_BLOCKS`. */
function inTagBlock (state: EditorState, position: number): boolean {
  for (let node: SyntaxNode|null = syntaxTree(state).resolveInner(position, 1); node !== null; node = node.parent) {
    if (TAG_BLOCKS.has(node.name)) {
      return true
    }
  }
  return false
}

/**
 * Returns the positions of the marks a typing transaction inserted into or
 * deleted from, in the new document.
 */
function typedMarkPositions (transaction: Transaction): number[] {
  const positions: number[] = []
  transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (toB > fromB) {
      positions.push(...markPositionsIn(transaction.state, fromB, toB))
      if (/[<>]/.test(transaction.state.sliceDoc(fromB, toB)) && inTagBlock(transaction.state, fromB)) {
        positions.push(fromB)
      }
    }
    if (toA > fromA && (markPositionsIn(transaction.startState, fromA, toA).length > 0 ||
      (/[<>]/.test(transaction.startState.sliceDoc(fromA, toA)) && inTagBlock(transaction.startState, fromA)))) {
      positions.push(fromB)
    }
  })
  return positions
}

/**
 * The range within which the cursor keeps a typed mark visible: the block
 * from `TYPING_REVEAL_BLOCKS` containing the mark, otherwise its line.
 */
function typingRevealRegion (state: EditorState, anchor: number): { from: number, to: number } {
  for (let node: SyntaxNode|null = syntaxTree(state).resolveInner(anchor, 1); node !== null; node = node.parent) {
    if (TYPING_REVEAL_BLOCKS.has(node.name)) {
      return { from: node.from, to: node.to }
    }
  }
  const line = state.doc.lineAt(anchor)
  return { from: line.from, to: line.to }
}

/**
 * The positions of the marks the user is typing. While a mouse button is held
 * down, the frozen selection decides whether the cursor is still within their
 * region, so that the layout only changes once the button is released.
 */
const typingRevealField = StateField.define<readonly number[]>({
  create () {
    return []
  },
  update (value, transaction) {
    let anchors = transaction.docChanged ? value.map(anchor => transaction.changes.mapPos(anchor)) : value
    if (isTypingTransaction(transaction)) {
      const typed = typedMarkPositions(transaction)
      if (typed.length > 0) {
        anchors = [ ...anchors, ...typed ]
      }
    }
    if (anchors.length === 0) {
      return value.length === 0 ? value : []
    }
    const state = transaction.state
    const head = revealSelection(state).main.head
    const remaining = anchors.filter(anchor => {
      const region = typingRevealRegion(state, anchor)
      return head >= region.from && head <= region.to
    })
    return anchors === value && remaining.length === value.length ? value : remaining
  }
})

/** Whether an element spanning the given range contains a mark being typed. */
function typingRevealCovers (state: EditorState, from: number, to: number): boolean {
  return (state.field(typingRevealField, false) ?? []).some(anchor => anchor >= from && anchor <= to)
}

/** Whether this category may enter source editing, independently of selection. */
export function sourceEditingAllowed (state: EditorState, category: CodeEditingCategory): boolean {
  const configuration = state.field(configField, false)
  // Minimal parser states used by utilities retain their historical behavior.
  if (configuration === undefined || configuration.renderingMode === 'raw') {
    return true
  }
  return configuration.editCodeWhenClicked ||
    (configuration.codeEditingExceptions?.[category] ?? defaultCodeEditingExceptions[category])
}

/** One policy for widgets and hidden syntax; never substitutes a fake selection. */
export function shouldRevealSource (
  state: EditorState,
  category: CodeEditingCategory,
  from: number,
  to: number,
  includeAdjacent = false
): boolean {
  const configuration = state.field(configField, false)
  if (configuration?.renderingMode === 'raw') {
    return true
  }
  if (configuration === undefined) {
    return rangeInSelection(revealSelection(state), from, to, includeAdjacent)
  }
  const interaction = state.field(revealInteractionField, false)
  if (interaction !== undefined && !(interaction.frozen ?? interaction.active)) {
    return false
  }
  if (configuration.editCodeWhenClicked) {
    return rangeInSelection(revealSelection(state), from, to, includeAdjacent)
  }
  // Marks being typed stay visible regardless of the category exceptions
  if (typingRevealCovers(state, from, to)) {
    return true
  }
  if (!sourceEditingAllowed(state, category)) {
    return false
  }
  // In exception mode a selection crossing the element is insufficient: its
  // moving cursor must actually be inside. Adjacent cursors count only in the
  // global mode above; otherwise a neighboring element would unfold as well.
  // A heading spans its whole line, so the end of that line is inside it.
  return revealSelection(state).ranges.some(range => range.head > from &&
    (range.head < to || (category === 'headings' && range.head === to)))
}

/** Classifies shared code nodes from their actual delimiters, not node names. */
export function codeNodeCategory (state: EditorState, node: SyntaxNodeRef): CodeEditingCategory {
  const mark = node.node.getChild('CodeMark')
  if (mark !== null && /^\$\$?$/.test(state.sliceDoc(mark.from, mark.to).trim())) {
    return 'math'
  }
  if (node.name === 'FencedCode') {
    const information = node.node.getChild('CodeInfo')
    const text = information === null ? '' : state.sliceDoc(information.from, information.to)
    if (text === 'mermaid' || /^\{.*\.mermaid.*\}$/i.test(text)) {
      return 'diagrams'
    }
    return 'codeBlocks'
  }
  return 'inlineCode'
}

/** Configuration and activation effects can change decorations without a move. */
export function sourceRevealChanged (update: ViewUpdate): boolean {
  return update.state.field(configField, false) !== update.startState.field(configField, false) ||
    update.state.field(typingRevealField, false) !== update.startState.field(typingRevealField, false) ||
    update.transactions.some(transaction => transaction.effects.some(effect =>
      effect.is(freezeRevealSelectionEffect) || effect.is(pointerSelectionEndEffect)))
}

/**
 * Returns the selection the renderers use to decide which elements show their
 * Markdown source: while a mouse button is held down in the editor, the
 * selection from before the mousedown; otherwise the editor's selection.
 *
 * @param   {EditorState}      state  The editor state
 *
 * @return  {EditorSelection}         The selection to test against
 */
export function revealSelection (state: EditorState): EditorSelection {
  return state.field(frozenSelectionField, false) ?? state.selection
}

/**
 * Events that end a pointer selection. A release outside the window still
 * arrives as mouseup while the button is held; the others cover native drag
 * and drop of selected text and the window losing focus mid-drag. pointerup
 * must not end it: it fires before mouseup, that is, before CodeMirror's
 * mouseup handler places the cursor of a click inside the selection, so the
 * end transaction would carry the stale selection, and revealing that one
 * moves the text under the pointer just before CodeMirror maps the pointer
 * onto a document position.
 */
const END_EVENTS = [ 'mouseup', 'pointercancel', 'dragend', 'drop', 'blur' ]

/**
 * Returns the document position under the given client coordinates, clamped
 * into the visible part of the editor's content, or null if the editor has no
 * layout (e.g., it is hidden) or the coordinates cannot be mapped.
 *
 * @param   {EditorView}   view     The editor view
 * @param   {number}       clientX  The client x coordinate
 * @param   {number}       clientY  The client y coordinate
 *
 * @return  {number|null}           The document position, or null
 */
function positionUnderPointer (view: EditorView, clientX: number, clientY: number): number|null {
  try {
    const scroller = view.scrollDOM
    if (scroller.clientHeight <= 0) {
      return null
    }
    const scrollerTop = scroller.getBoundingClientRect().top
    const contentRect = view.contentDOM.getBoundingClientRect()
    const x = Math.min(Math.max(clientX, contentRect.left), contentRect.right)
    const y = Math.min(Math.max(clientY, scrollerTop), scrollerTop + scroller.clientHeight)
    return view.posAtCoords({ x, y }, false)
  } catch (err) {
    // CodeMirror's inline coordinate scan can throw while its height map and
    // its rendered lines are momentarily out of sync. The position is only a
    // refinement: without it, the viewport keeps the selection head instead.
    return null
  }
}

/**
 * Freezes the renderers' reveal decisions from a primary-button mousedown in
 * the editor until the button is released.
 */
export const freezeRevealDuringPointerSelection: Extension = [
  frozenSelectionField,
  revealInteractionField,
  typingRevealField,
  EditorView.domEventHandlers({
    mousedown (event, view) {
      if (event.button !== 0) {
        return false
      }

      view.dispatch({ effects: freezeRevealSelectionEffect.of(view.state.selection) })

      const pressX = event.clientX
      const pressY = event.clientY
      const end = (endEvent: Event): void => {
        for (const name of END_EVENTS) {
          window.removeEventListener(name, end)
        }

        if (!view.dom.isConnected || view.state.field(frozenSelectionField, false) === null) {
          return
        }

        // Only a released mouse button leaves the pointer over the text the
        // user selected or clicked. Measure the position under it now, while
        // the renderers still show the frozen selection's layout.
        let release: PointerRelease|null = null
        if (endEvent.type === 'mouseup') {
          const { clientX, clientY } = endEvent as MouseEvent
          release = {
            clientY,
            position: positionUnderPointer(view, clientX, clientY),
            click: Math.hypot(clientX - pressX, clientY - pressY) <= CLICK_TOLERANCE
          }
        }

        // Re-setting the current selection marks the update as selectionSet,
        // which all renderers rebuild on.
        view.dispatch({
          selection: view.state.selection,
          effects: pointerSelectionEndEffect.of(release),
          userEvent: 'select.pointer'
        })
      }

      // Listening on the window (bubbling) runs after CodeMirror's own mouseup
      // handler on the document has applied the final selection.
      for (const name of END_EVENTS) {
        window.addEventListener(name, end)
      }
      return false
    }
  })
]
