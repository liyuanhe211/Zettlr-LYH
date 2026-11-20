/**
 * Highlights matched square-bracket ranges in ordinary Markdown text, even
 * when they cross paragraphs. Existing semantic nodes keep their own styling.
 */

import { syntaxTree } from '@codemirror/language'
import { StateField, type EditorState } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'

export const BRACKET_CONTENT_CLASS = 'cm-bracket-content'

export interface BracketRange { from: number, to: number }

const bracketMark = Decoration.mark({ class: BRACKET_CONTENT_CLASS })

// Structural containers such as Paragraph and Blockquote are deliberately
// absent: their ordinary text can participate in a pair across block edges.
const semanticNodes = new Set([
  'InlineCode', 'FencedCode', 'CodeBlock', 'URL', 'Autolink',
  'LinkReference', 'HTMLTag', 'HTMLBlock', 'Comment', 'CommentBlock',
  'YAMLFrontmatter', 'ZknLink', 'ZknTag', 'Citation', 'PandocSpan',
  'Footnote', 'FootnoteRef',
  'InlineMath', 'BlockMath', 'Math', 'Image'
])

function isSemanticNode (node: SyntaxNode): boolean {
  if (node.type.name === 'Link') {
    // The Markdown parser also wraps plain text such as `[1]` in a Link node.
    return node.getChild('URL') !== null || node.getChild('LinkLabel') !== null
  }
  return semanticNodes.has(node.type.name)
}

function semanticRanges (state: EditorState): BracketRange[] {
  const ranges: BracketRange[] = []
  syntaxTree(state).iterate({
    enter (node) {
      if (!isSemanticNode(node.node)) {
        return
      }
      ranges.push({ from: node.from, to: node.to })
      return false
    }
  })
  return ranges
}

/** Return the visible portions of all matched pairs, with semantic nodes cut out. */
export function bracketContentRanges (text: string, excluded: readonly BracketRange[] = []): BracketRange[] {
  const openings: number[] = []
  const matches: BracketRange[] = []
  let excludedIndex = 0
  let backslashes = 0

  for (let position = 0; position < text.length; position++) {
    while (excludedIndex < excluded.length && position >= excluded[excludedIndex].to) {
      excludedIndex++
    }
    if (excludedIndex < excluded.length && position >= excluded[excludedIndex].from) {
      position = excluded[excludedIndex].to - 1
      backslashes = 0
      continue
    }
    const character = text[position]
    if (character === '\\') {
      backslashes++
      continue
    }
    const escaped = backslashes % 2 === 1
    backslashes = 0
    if (escaped) {
      continue
    }
    if (character === '[') {
      openings.push(position)
    } else if (character === ']' && openings.length > 0) {
      matches.push({ from: openings.pop()!, to: position + 1 })
    }
  }

  // An unmatched outer opening must not consume the document, while any
  // completed inner pair still has a visible range of its own.
  matches.sort((first, second) => first.from - second.from)
  const merged: BracketRange[] = []
  for (const match of matches) {
    const previous = merged[merged.length - 1]
    if (previous !== undefined && match.from < previous.to) {
      previous.to = Math.max(previous.to, match.to)
    } else {
      merged.push({ ...match })
    }
  }

  const visible: BracketRange[] = []
  excludedIndex = 0
  for (const match of merged) {
    let from = match.from
    while (excludedIndex < excluded.length && excluded[excludedIndex].to <= from) {
      excludedIndex++
    }
    let index = excludedIndex
    while (index < excluded.length && excluded[index].from < match.to) {
      if (from < excluded[index].from) {
        visible.push({ from, to: excluded[index].from })
      }
      from = Math.max(from, excluded[index].to)
      index++
    }
    if (from < match.to) {
      visible.push({ from, to: match.to })
    }
  }
  return visible
}

function decorations (state: EditorState): DecorationSet {
  const ranges = bracketContentRanges(state.doc.toString(), semanticRanges(state))
  return Decoration.set(ranges.map(range => bracketMark.range(range.from, range.to)))
}

export const bracketContentHighlight = StateField.define<DecorationSet>({
  create: decorations,
  update (value, transaction) {
    return transaction.docChanged || syntaxTree(transaction.state) !== syntaxTree(transaction.startState)
      ? decorations(transaction.state)
      : value
  },
  provide: field => EditorView.decorations.from(field)
})
