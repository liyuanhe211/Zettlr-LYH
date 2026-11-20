/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        mathDollarInputExtension, tabOutOfMath, deleteDollarPair
 * CVM-Role:        Extension, CodeMirror Commands
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH (R175): input assistance for "$" math.
 *                  - Typing "$" or the full-width "￥" (which Chinese input
 *                    methods produce for Shift+4) over a selection wraps every
 *                    range as "$selection$" and keeps the inner text selected,
 *                    so typing it again yields "$$selection$$".
 *                  - Typing "$" at a cursor inserts the closing "$" as well;
 *                    typing it inside an empty pair widens it to "$$|$$", and
 *                    typing it in front of the closing "$" steps over it.
 *                  - Backspace between an empty pair deletes both halves.
 *                  - Tab anywhere inside a formula moves the cursor behind its
 *                    closing "$" (or "$$").
 *                  The parser represents inline math as an InlineCode node that
 *                  starts with "$" and block math as a FencedCode node that
 *                  starts with "$$"; real code is never touched.
 *
 * END HEADER
 */

import { syntaxTree } from '@codemirror/language'
import { EditorSelection, Prec, type EditorState, type Extension, type TransactionSpec } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

/** Characters that wrap a selection; each one wraps with a plain "$". */
export const dollarWrapTriggers: readonly string[] = Object.freeze([ '$', '￥' ])

const constructNames = new Set([ 'FencedCode', 'CodeBlock', 'IndentedCode', 'InlineCode', 'YAMLFrontmatter' ])

interface Construct { from: number, to: number, math: boolean }

/**
 * Returns the code or math construct that strictly contains `position`. A
 * position exactly on the outer edge of a construct counts as outside it.
 */
function constructAt (state: EditorState, position: number, side: -1|1): Construct|null {
  for (let node: ReturnType<ReturnType<typeof syntaxTree>['resolveInner']>|null = syntaxTree(state).resolveInner(position, side); node !== null; node = node.parent) {
    if (!constructNames.has(node.name)) {continue}
    // Indented code has no closing delimiter, so its end still belongs to it.
    const endIsInside = node.name === 'IndentedCode' || node.name === 'CodeBlock'
    if (position <= node.from || position > node.to || (position === node.to && !endIsInside)) {return null}
    const start = state.sliceDoc(node.from, node.to).trimStart()
    const math = (node.name === 'InlineCode' && start.startsWith('$')) || (node.name === 'FencedCode' && start.startsWith('$$'))
    return { from: node.from, to: node.to, math }
  }
  return null
}

function constructAround (state: EditorState, position: number): Construct|null {
  return constructAt(state, position, -1) ?? constructAt(state, position, 1)
}

function insideRealCode (state: EditorState, position: number): boolean {
  const construct = constructAround(state, position)
  return construct !== null && !construct.math
}

/** Counts the "$" between the line start and `position` that no backslash escapes. */
function unescapedDollarsBefore (state: EditorState, position: number): number {
  const text = state.sliceDoc(state.doc.lineAt(position).from, position)
  let count = 0
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '$') {continue}
    let backslashes = 0
    while (index - backslashes - 1 >= 0 && text[index - backslashes - 1] === '\\') {backslashes++}
    if (backslashes % 2 === 0) {count++}
  }
  return count
}

function dollarRunBefore (state: EditorState, position: number): number {
  let length = 0
  while (position - length > 0 && state.sliceDoc(position - length - 1, position - length) === '$') {length++}
  return length
}

function dollarRunAfter (state: EditorState, position: number): number {
  let length = 0
  while (state.sliceDoc(position + length, position + length + 1) === '$') {length++}
  return length
}

/** True when the cursor sits in the middle of an empty pair such as "$|$" or "$$|$$". */
function isBetweenEmptyPair (state: EditorState, position: number): boolean {
  const before = dollarRunBefore(state, position)
  if (before === 0 || before !== dollarRunAfter(state, position) ||
    state.sliceDoc(position - before - 1, position - before) === '\\' ||
    (unescapedDollarsBefore(state, position) - before) % 2 !== 0) {
    return false
  }
  // In "$$x$|$" the runs are the halves of a closing "$$", not an empty pair.
  const construct = constructAround(state, position)
  return construct === null || (construct.from === position - before && construct.to === position + before)
}

function canWrap (state: EditorState, from: number, to: number): boolean {
  const atFrom = constructAround(state, from)
  const atTo = constructAround(state, to)
  if (atFrom === null && atTo === null) {return true}
  // Selecting exactly the content of an inline formula widens its delimiters:
  // "$«x»$" becomes "$$«x»$$". Any other selection touching code is refused.
  if (atFrom === null || atTo === null || !atFrom.math || atFrom.from !== atTo.from) {return false}
  const opening = state.sliceDoc(atFrom.from, from)
  const closing = state.sliceDoc(to, atFrom.to)
  return /^\$+$/.test(opening) && opening === closing
}

function wrapSelection (state: EditorState): TransactionSpec|null {
  const ranges = state.selection.ranges
  if (ranges.some(range => range.empty || !canWrap(state, range.from, range.to))) {
    return null
  }
  return state.changeByRange(range => ({
    changes: [{ from: range.from, insert: '$' }, { from: range.to, insert: '$' }],
    range: EditorSelection.range(range.anchor + 1, range.head + 1)
  }))
}

/** What typing "$" at an empty cursor does, or null for a plain insertion. */
function dollarAtCursor (state: EditorState, position: number): { insert: string, cursor: number }|null {
  if (insideRealCode(state, position) || state.sliceDoc(position - 1, position) === '\\') {return null}
  const after = state.sliceDoc(position, position + 1)
  const dollarsBefore = unescapedDollarsBefore(state, position)
  if (after === '$') {
    if (dollarRunBefore(state, position) === 1 && dollarRunAfter(state, position) === 1 && isBetweenEmptyPair(state, position)) {
      return { insert: '$$', cursor: position + 1 } // "$|$" → "$$|$$"
    }
    const construct = constructAround(state, position)
    if (dollarsBefore % 2 === 1 || construct?.math === true) {
      return { insert: '', cursor: position + 1 } // Step over the closing "$"
    }
    return null
  }
  // An odd count means this "$" closes a formula opened earlier on the line.
  if (dollarsBefore % 2 === 1 || /[\p{L}\p{N}]/u.test(after)) {return null}
  return { insert: '$$', cursor: position + 1 }
}

/**
 * Returns the transaction for typed `text`, or null when the input should be
 * handled normally (other text, read-only document, code, mixed selections).
 */
export function mathDollarTransaction (state: EditorState, text: string): TransactionSpec|null {
  if (state.readOnly || !dollarWrapTriggers.includes(text)) {return null}
  const ranges = state.selection.ranges
  let transaction: TransactionSpec|null = null
  if (ranges.every(range => !range.empty)) {
    transaction = wrapSelection(state)
  } else if (text === '$' && ranges.every(range => range.empty)) {
    const actions = ranges.map(range => dollarAtCursor(state, range.head))
    if (actions.every(action => action !== null)) {
      let index = 0
      transaction = state.changeByRange(range => {
        const action = actions[index++]!
        return {
          changes: action.insert === '' ? [] : [{ from: range.head, insert: action.insert }],
          range: EditorSelection.cursor(action.cursor)
        }
      })
    }
  }
  return transaction === null ? null : { ...transaction, scrollIntoView: true, userEvent: 'input.type' }
}

/** Where each cursor goes when Tab leaves a formula, or undefined if Tab does not apply. */
export function mathTabOutTargets (state: EditorState): number[]|undefined {
  const targets: number[] = []
  for (const range of state.selection.ranges) {
    if (!range.empty) {return undefined}
    const position = range.head
    const construct = constructAround(state, position)
    if (construct?.math === true) {
      targets.push(construct.to)
      continue
    }
    if (construct !== null) {return undefined}
    // Formulas the parser does not recognize yet, such as the fresh pair "$|$"
    const runAfter = dollarRunAfter(state, position)
    if (runAfter > 0 && (unescapedDollarsBefore(state, position) % 2 === 1 || isBetweenEmptyPair(state, position))) {
      targets.push(position + runAfter)
      continue
    }
    return undefined
  }
  return targets
}

export function tabOutOfMath (view: EditorView): boolean {
  if (view.composing || view.compositionStarted) {return false}
  const targets = mathTabOutTargets(view.state)
  if (targets === undefined) {return false}
  view.dispatch({
    selection: EditorSelection.create(targets.map(target => EditorSelection.cursor(target)), view.state.selection.mainIndex),
    scrollIntoView: true,
    userEvent: 'select'
  })
  return true
}

export function deleteDollarPair (view: EditorView): boolean {
  const state = view.state
  if (state.readOnly || state.selection.ranges.some(range => !range.empty || insideRealCode(state, range.head) || !isBetweenEmptyPair(state, range.head))) {
    return false
  }
  view.dispatch(state.changeByRange(range => ({
    changes: { from: range.head - 1, to: range.head + 1 },
    range: EditorSelection.cursor(range.head - 1)
  })), { scrollIntoView: true, userEvent: 'delete.backward' })
  return true
}

export const mathDollarInputExtension: Extension = Prec.highest(EditorView.inputHandler.of((view, from, to, text) => {
  // Only the plain replacement of the main selection by the typed character
  // qualifies. Pairing waits for composition to finish, as closeBrackets does;
  // wrapping does not, because "￥" usually arrives through an input method.
  const main = view.state.selection.main
  if (from !== main.from || to !== main.to) {return false}
  if (main.empty && (view.composing || view.compositionStarted)) {return false}
  const transaction = mathDollarTransaction(view.state, text)
  if (transaction === null) {return false}
  view.dispatch(transaction)
  return true
}))
