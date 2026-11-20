/** Ordinary copy uses visible text inside one hidden Markdown text object. */
import { syntaxTree } from '@codemirror/language'
import { type EditorState, type SelectionRange } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { markdownCopyBoundaries, markdownCopySelectionIntent, type SourceBoundary } from './markdown-source-selection'
import { configField } from '../util/configuration'
import { normalizeCopyVisibleTextCategories, type CopyVisibleTextCategories } from '../util/visible-copy-policy'
import { handleMarkdownImageCopy } from './markdown-image-copy'
import { revisionCopyText } from '../renderers/render-revisions'

function enabledBoundary (boundary: SourceBoundary, categories: CopyVisibleTextCategories): boolean {
  return boundary.copyCategory !== undefined && categories[boundary.copyCategory] && boundary.copyCategory !== 'images'
}

function copyRange (state: EditorState, range: SelectionRange, intent: SelectionRange, boundaries: SourceBoundary[], categories: CopyVisibleTextCategories): string {
  const original = state.sliceDoc(range.from, range.to)
  if (range.empty) {
    return original
  }
  // The smallest containing object is determined before source normalization
  // added outer heading/list prefixes. Disabled inner objects stay literal.
  const enclosing = boundaries.filter(boundary =>
    intent.from >= (boundary.objectFrom ?? boundary.from) && intent.to <= (boundary.objectTo ?? boundary.to))
    .sort((left, right) => ((left.objectTo ?? left.to) - (left.objectFrom ?? left.from)) -
      ((right.objectTo ?? right.to) - (right.objectFrom ?? right.from)))
  if (enclosing.length === 0) {
    return original
  }
  const object = enclosing[0]
  if (!enabledBoundary(object, categories)) {
    return original
  }
  const from = Math.max(range.from, object.objectFrom ?? object.from)
  const to = Math.min(range.to, object.objectTo ?? object.to)
  const codeObject = object.copyCategory === 'codeBlocks' || object.copyCategory === 'math' || object.copyCategory === 'inlineCode'
  // A fenced block is one object even when its selected body spans source
  // lines. Code and LaTeX bodies must never be parsed as nested Markdown.
  if (codeObject) {
    const contentFrom = Math.max(from, object.contentFrom)
    const contentTo = Math.min(to, object.contentTo)
    return contentFrom < contentTo ? state.sliceDoc(contentFrom, contentTo) : ''
  }
  if (state.sliceDoc(from, to).includes(state.lineBreak)) {
    return original
  }
  // A textual container does not turn embedded nontext widgets into text.
  let nontext = false
  syntaxTree(state).iterate({
    from, to,
    enter (node) {
      if (node.name === 'Image' || node.name === 'FencedCode' || node.name === 'Calculation' || node.name === 'Iframe') {
        nontext = true
        return false
      }
      if (node.name === 'InlineCode') {
        return false
      }
    }
  })
  if (nontext) {
    return original
  }
  const hidden: Array<{ from: number, to: number }> = []
  for (const boundary of boundaries) {
    if (!enabledBoundary(boundary, categories)) {
      continue
    }
    hidden.push({ from: boundary.from, to: boundary.contentFrom })
    if (boundary.prefix !== true) {
      hidden.push({ from: boundary.contentTo, to: boundary.to })
    }
  }
  hidden.sort((left, right) => left.from - right.from || left.to - right.to)
  let position = from
  let text = ''
  for (const interval of hidden) {
    if (interval.to <= position || interval.from >= to) {
      continue
    }
    text += state.sliceDoc(position, Math.max(position, interval.from))
    position = Math.min(to, interval.to)
  }
  return text + state.sliceDoc(position, to)
}

/** Shared by the native copy event and the editor's plain-copy command. */
export function markdownVisibleCopyText (state: EditorState): string {
  // Zettlr-LYH (R84): with Show Revisions off, the clipboard receives the text
  // with every tracked change accepted (spec C10, "Copy"); with Show Revisions
  // on, a tracked change cut by the selection gives its visible text only
  // (Decision 107)
  const revisionText = revisionCopyText(state)
  if (revisionText !== undefined) {
    return revisionText
  }
  const boundaries = markdownCopyBoundaries(state)
  const intent = markdownCopySelectionIntent(state)
  const categories = normalizeCopyVisibleTextCategories(state.field(configField, false)?.copyVisibleTextCategories)
  return state.selection.ranges.map((range, index) => range.empty ? undefined
    : copyRange(state, range, intent.ranges.length === state.selection.ranges.length ? intent.ranges[index] : range, boundaries, categories))
    .filter(text => text !== undefined).join(state.lineBreak)
}

/** Whether the DOM selection lies within the editor's content. */
function domSelectionInEditor (view: EditorView): boolean {
  const selection = view.dom.ownerDocument.getSelection()
  return selection !== null && selection.anchorNode !== null && selection.focusNode !== null &&
    view.contentDOM.contains(selection.anchorNode) && view.contentDOM.contains(selection.focusNode)
}

/**
 * Only ordinary copy is intercepted: cut and drag retain source characters
 * (except cutting hidden tracked changes, see handleRevisionCut).
 */
export function handleMarkdownVisibleCopy (event: ClipboardEvent, view: EditorView): boolean {
  if (handleMarkdownImageCopy(event, view)) {
    return true
  }
  if (event.clipboardData === null || view.state.selection.ranges.every(range => range.empty)) {
    return false
  }
  if (!domSelectionInEditor(view)) {
    return false
  }
  const original = view.state.selection.ranges.filter(range => !range.empty)
    .map(range => view.state.sliceDoc(range.from, range.to)).join(view.state.lineBreak)
  const text = markdownVisibleCopyText(view.state)
  if (text === original) {
    return false
  }
  event.clipboardData.clearData()
  event.clipboardData.setData('text/plain', text)
  event.preventDefault()
  return true
}

/**
 * Zettlr-LYH (R84): with Show Revisions off, cutting puts the text with every
 * tracked change accepted into the clipboard (spec C10, "Copy"), with Show
 * Revisions on the visible text of tracked changes the selection cuts through
 * (Decision 107); the selected source is removed as by an ordinary cut, so
 * that Track Changes can record it.
 */
export function handleRevisionCut (event: ClipboardEvent, view: EditorView): boolean {
  if (event.clipboardData === null) {
    return false
  }
  const text = revisionCopyText(view.state)
  if (text === undefined || !domSelectionInEditor(view)) {
    return false
  }
  event.clipboardData.clearData()
  event.clipboardData.setData('text/plain', text)
  event.preventDefault()
  if (!view.state.readOnly) {
    view.dispatch({
      changes: view.state.selection.ranges.filter(range => !range.empty).map(range => ({ from: range.from, to: range.to })),
      scrollIntoView: true,
      userEvent: 'delete.cut'
    })
  }
  return true
}

export const markdownVisibleCopy = EditorView.domEventHandlers({ copy: handleMarkdownVisibleCopy, cut: handleRevisionCut })
