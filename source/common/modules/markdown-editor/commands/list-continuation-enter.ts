/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        insertNewlineInListContinuation
 * CVM-Role:        CodeMirror Command
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Enter at the end of a continuation line of a loose list
 *                  item (the second or a later line of the item, including
 *                  lazy continuation lines without indentation) inserts a
 *                  single line break. The stock `insertNewlineContinueMarkup`
 *                  of `@codemirror/lang-markdown` adds no list marker on such
 *                  lines but always prepends a blank line in loose lists, so
 *                  that one Enter produced a line break plus an empty line.
 *                  The indentation of the new line is computed exactly as
 *                  `insertNewlineContinueMarkup` computes it for continued
 *                  lines; only the extra blank line is left out. Every other
 *                  situation (first line of an item, tight lists, quotes,
 *                  plain paragraphs, text after the cursor, selections) is
 *                  declined so that the regular Enter chain handles it.
 *
 * END HEADER
 */

import { indentUnit, syntaxTree } from '@codemirror/language'
import { countColumn, EditorSelection, type EditorState, type Text } from '@codemirror/state'
import { type EditorView } from '@codemirror/view'
import { markdownLanguage } from '@codemirror/lang-markdown'
import type { SyntaxNode, Tree } from '@lezer/common'
import { handleReplacement } from './autocorrect'

/**
 * One level of list or blockquote markup around the cursor line, mirroring the
 * `Context` class of `@codemirror/lang-markdown`.
 */
interface MarkupContext {
  /** The `BulletList`, `OrderedList` or `Blockquote` node */
  node: SyntaxNode
  /** Column where the markup starts on the first line of the node */
  from: number
  /** Column where the markup (marker plus following spaces) ends */
  to: number
  spaceBefore: string
  spaceAfter: string
  /** The `ListItem` node for lists, `null` for blockquotes */
  item: SyntaxNode|null
}

/**
 * The change one Enter press makes for one cursor: replace `from` to `to` with
 * `insert`.
 */
export interface ContinuationNewline {
  from: number
  to: number
  insert: string
}

/**
 * The whitespace (and `>` for quotes) that continues this markup level on a
 * new line without a marker; same as `Context.blank` in lang-markdown.
 */
function blankMarkup (context: MarkupContext, maximumWidth: number|null): string {
  let result = context.spaceBefore + (context.node.name === 'Blockquote' ? '>' : '')
  if (maximumWidth !== null) {
    while (result.length < maximumWidth) {
      result += ' '
    }
    return result
  }
  for (let i = context.to - context.from - result.length - context.spaceAfter.length; i > 0; i--) {
    result += ' '
  }
  return result + context.spaceAfter
}

/**
 * Collects the list and blockquote markup levels around `node`, outermost
 * first; same as `getContext` in lang-markdown. Returns an empty array inside
 * fenced code.
 */
function getMarkupContexts (node: SyntaxNode, document: Text): MarkupContext[] {
  const nodes: SyntaxNode[] = []
  for (let current: SyntaxNode|null = node; current !== null; current = current.parent) {
    if (current.name === 'FencedCode') {
      return []
    }
    if (current.name === 'ListItem' || current.name === 'Blockquote') {
      nodes.push(current)
    }
  }

  const contexts: MarkupContext[] = []
  for (let i = nodes.length - 1; i >= 0; i--) {
    const current = nodes[i]
    const line = document.lineAt(current.from)
    const start = current.from - line.from
    const text = line.text.slice(start)
    const parentName = current.parent?.name
    let match: RegExpExecArray|null
    if (current.name === 'Blockquote' && (match = /^ *>( ?)/.exec(text)) !== null) {
      contexts.push({ node: current, from: start, to: start + match[0].length, spaceBefore: '', spaceAfter: match[1], item: null })
    } else if (current.name === 'ListItem' && current.parent !== null && parentName === 'OrderedList' &&
      (match = /^( *)\d+([.)])( *)/.exec(text)) !== null) {
      let after = match[3]
      let length = match[0].length
      if (after.length >= 4) {
        after = after.slice(0, after.length - 4)
        length -= 4
      }
      contexts.push({ node: current.parent, from: start, to: start + length, spaceBefore: match[1], spaceAfter: after, item: current })
    } else if (current.name === 'ListItem' && current.parent !== null && parentName === 'BulletList' &&
      (match = /^( *)([-+*])( {1,4}\[[ xX]\])?( +)/.exec(text)) !== null) {
      let after = match[4]
      let length = match[0].length
      if (after.length > 4) {
        after = after.slice(0, after.length - 4)
        length -= 4
      }
      contexts.push({ node: current.parent, from: start, to: start + length, spaceBefore: match[1], spaceAfter: after, item: current })
    }
  }
  return contexts
}

/**
 * Whether the list has blank lines between its items; same as `nonTightList`
 * in lang-markdown.
 */
function isLooseList (node: SyntaxNode, document: Text): boolean {
  if (node.name !== 'OrderedList' && node.name !== 'BulletList') {
    return false
  }
  const first = node.firstChild
  const second = node.getChild('ListItem', 'ListItem')
  if (first === null || second === null) {
    return false
  }
  const firstLine = document.lineAt(first.to)
  const secondLine = document.lineAt(second.from)
  const empty = /^[\s>]*$/.test(firstLine.text)
  return firstLine.number + (empty ? 0 : 1) < secondLine.number
}

/**
 * Converts leading spaces to tabs when the indent unit is a tab; same as
 * `normalizeIndent` in lang-markdown.
 */
function normalizeIndent (content: string, state: EditorState): string {
  const blank = /^[ \t]*/.exec(content)?.[0].length ?? 0
  if (blank === 0 || state.facet(indentUnit) !== '\t') {
    return content
  }
  const column = countColumn(content, 4, blank)
  let space = ''
  for (let i = column; i > 0;) {
    if (i >= 4) {
      space += '\t'
      i -= 4
    } else {
      space += ' '
      i--
    }
  }
  return space + content.slice(blank)
}

/**
 * Computes the single line break Enter inserts at `position` when that cursor
 * is at the end of a continuation line of a loose list item. Returns `null`
 * whenever the regular Enter chain should handle the cursor instead.
 *
 * @param   {EditorState}  state     The editor state
 * @param   {Tree}         tree      The syntax tree of the state
 * @param   {number}       position  The cursor position
 *
 * @return  {ContinuationNewline|null}  The change, or `null` to decline
 */
export function continuationNewline (state: EditorState, tree: Tree, position: number): ContinuationNewline|null {
  if (!markdownLanguage.isActiveAt(state, position, -1) && !markdownLanguage.isActiveAt(state, position, 1)) {
    return null
  }

  const document = state.doc
  const line = document.lineAt(position)
  const column = position - line.from
  // Only at the end of the line (trailing whitespace allowed)
  if (/\S/.test(line.text.slice(column))) {
    return null
  }

  const contexts = getMarkupContexts(tree.resolveInner(position, -1), document)
  while (contexts.length > 0 && contexts[contexts.length - 1].from > column) {
    contexts.pop()
  }
  if (contexts.length === 0) {
    return null
  }

  const inner = contexts[contexts.length - 1]
  if (inner.item === null) {
    return null
  }
  // Cursor inside the markup itself
  if (inner.to - inner.spaceAfter.length > column) {
    return null
  }
  // Lines that are empty after the markup keep the stock handling
  if (!/\S/.test(line.text.slice(inner.to))) {
    return null
  }
  // The first line of the item (the one with the marker) keeps the stock handling
  if (inner.item.from >= line.from) {
    return null
  }
  if (!isLooseList(inner.node, document)) {
    return null
  }

  let indentation = ''
  // Lines dedented below the item content (such as lazy continuation lines)
  // get no indentation, exactly as in `insertNewlineContinueMarkup`.
  const leadingMarkup = /^[\s\d.)\-+*>]*/.exec(line.text)?.[0].length ?? 0
  if (leadingMarkup >= inner.to) {
    for (let i = 0, last = contexts.length - 1; i <= last; i++) {
      indentation += blankMarkup(contexts[i], i < last ? countColumn(line.text, 4, contexts[i + 1].from) - indentation.length : null)
    }
  }

  let from = position
  while (from > line.from && /\s/.test(line.text.charAt(from - line.from - 1))) {
    from--
  }

  return { from, to: position, insert: state.lineBreak + normalizeIndent(indentation, state) }
}

/**
 * Enter command for continuation lines of loose list items: inserts one line
 * break (plus the continuation indentation) instead of a line break and an
 * empty line. Declines (returns `false`) unless every selection range is an
 * empty cursor at the end of such a line. Like `handleAutocorrectEnter`, it
 * applies autocorrect replacements after inserting the line break.
 *
 * @param   {EditorView}  view  The editor view
 *
 * @return  {boolean}           Whether the command has handled the key
 */
export function insertNewlineInListContinuation (view: EditorView): boolean {
  const { state } = view
  const tree = syntaxTree(state)
  const newlines: ContinuationNewline[] = []
  for (const range of state.selection.ranges) {
    if (!range.empty) {
      return false
    }
    const newline = continuationNewline(state, tree, range.from)
    if (newline === null) {
      return false
    }
    newlines.push(newline)
  }

  let index = 0
  const transaction = state.changeByRange(() => {
    const newline = newlines[index]
    index++
    return {
      range: EditorSelection.cursor(newline.from + newline.insert.length),
      changes: newline
    }
  })
  view.dispatch(state.update(transaction, { scrollIntoView: true, userEvent: 'input' }))
  handleReplacement(view)
  return true
}
