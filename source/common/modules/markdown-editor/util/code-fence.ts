import { isolateHistory } from '@codemirror/commands'
import { ensureSyntaxTree } from '@codemirror/language'
import { type EditorState, type TransactionSpec } from '@codemirror/state'

export interface CodeFenceLine {
  indentation: string
  delimiter: string
  /** Offset of the info string within the line, after its leading whitespace. */
  infoFrom: number
  infoString: string
}

export interface CodeFenceOpening extends CodeFenceLine {
  lineFrom: number
  lineTo: number
  hasClosingFence: boolean
}

/** Parse a standalone fence line without accepting inline or mixed delimiters. */
export function parseCodeFenceLine (text: string): CodeFenceLine|undefined {
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(text)
  if (match === null) {
    return undefined
  }

  const [ , indentation, delimiter, remainder ] = match
  // A different fence character immediately after the run is not an info string.
  // Backtick info strings may not contain backticks anywhere (CommonMark).
  if (/^[`~]/.test(remainder) || (delimiter[0] === '`' && remainder.includes('`'))) {
    return undefined
  }

  const whitespace = /^[\t ]*/.exec(remainder)![0]
  return {
    indentation,
    delimiter,
    infoFrom: indentation.length + delimiter.length + whitespace.length,
    infoString: remainder.slice(whitespace.length)
  }
}

/**
 * Require both a standalone line and the first CodeMark of a Markdown block.
 * Resolving the outer tree avoids mistaking embedded language syntax for a
 * Markdown opener. If parsing has not reached this line, fail safely.
 */
export function findCodeFenceOpening (state: EditorState, position: number): CodeFenceOpening|undefined {
  const line = state.doc.lineAt(position)
  if (position !== line.to) {
    return undefined
  }

  const fence = parseCodeFenceLine(line.text)
  if (fence === undefined) {
    return undefined
  }

  const tree = ensureSyntaxTree(state, line.to, 50)
  if (tree === null) {
    return undefined
  }

  const delimiterFrom = line.from + fence.indentation.length
  let node = tree.resolve(delimiterFrom + 1, 1)
  while (node.name !== 'FencedCode') {
    if (node.parent === null) {
      return undefined
    }
    node = node.parent
  }

  const marks = node.getChildren('CodeMark')
  const openingMark = marks[0]
  if (openingMark === undefined || openingMark.from !== delimiterFrom || openingMark.to !== delimiterFrom + fence.delimiter.length) {
    return undefined
  }

  return {
    ...fence,
    lineFrom: line.from,
    lineTo: line.to,
    hasClosingFence: marks.length > 1
  }
}

/**
 * Build one ordinary, undo-isolated transaction for Enter or a language choice.
 * With closeFence false (the Code fences setting is off) only the info string is
 * rewritten and the cursor stays at its end: no content line and no closing fence.
 */
export function createCodeFenceTransaction (opening: CodeFenceOpening, infoString?: string, closeFence = true): TransactionSpec {
  const from = infoString === undefined ? opening.lineTo : opening.lineFrom + opening.infoFrom
  const replacement = infoString ?? ''
  if (!closeFence) {
    return {
      changes: { from, to: opening.lineTo, insert: replacement },
      selection: { anchor: from + replacement.length },
      annotations: isolateHistory.of('full'),
      userEvent: infoString === undefined ? 'input' : 'input.complete'
    }
  }
  const contentLine = '\n' + opening.indentation
  // Existing body and closing lines are never replaced. A single inserted
  // newline creates a content line before them when the block is already closed.
  const closingLine = opening.hasClosingFence ? '' : '\n' + opening.indentation + opening.delimiter
  return {
    changes: { from, to: opening.lineTo, insert: replacement + contentLine + closingLine },
    selection: { anchor: from + replacement.length + contentLine.length },
    annotations: isolateHistory.of('full'),
    userEvent: infoString === undefined ? 'input' : 'input.complete'
  }
}
