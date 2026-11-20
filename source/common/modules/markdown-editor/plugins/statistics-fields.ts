/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Statistics Field
 * CVM-Role:        Extension
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file defines a set of StateFields that are used to keep
 *                  a few statistics such as word counts available to the
 *                  overlying MarkdownEditor instance.
 *
 * END HEADER
 */

import { ensureSyntaxTree } from '@codemirror/language'
import { StateEffect, StateField, type ChangeDesc, type EditorSelection, type EditorState, type Text } from '@codemirror/state'
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view'
import { extractTextnodes, markdownToAST } from '@common/modules/markdown-utils'
import { type ASTNode, type Document, type TextNode } from '@common/modules/markdown-utils/markdown-ast'
import { countAll } from '@common/util/counter'
import { estimateOfflineTokens, estimateOfflineTokensInRanges } from '@common/util/offline-token-estimate'

// The amount of time in milliseconds to wait before triggering word counting
const WORD_COUNT_DELAY = 750

interface CountValues {
  chars: number
  words: number
  tokens: number
}

interface DocumentCounts extends CountValues {
  document: Text
  ast: ASTNode
  textNodes: TextNode[]
  locale: string
  lineBreak: string
}

interface EditorCounts extends DocumentCounts {
  selected: CountValues | null
  pendingChanges: ChangeDesc | null
}

function count (state: EditorState): DocumentCounts {
  const source = state.sliceDoc()
  const ast = markdownToAST(source, ensureSyntaxTree(state, state.doc.length))
  const locale: string = window.config.get('appLang')
  return {
    ...countAll(ast, locale),
    tokens: estimateOfflineTokens(source),
    document: state.doc,
    ast,
    textNodes: extractTextnodes(ast),
    locale,
    lineBreak: state.lineBreak
  }
}

function countSelection (counts: DocumentCounts, selection: EditorSelection, pendingChanges: ChangeDesc | null = null): CountValues | null {
  const ranges = selection.ranges.filter(range => !range.empty)
  if (ranges.length === 0) {
    return null
  }

  // While typing is debounced, both sides of the ratio use the same snapshot.
  // Map current selection positions back into that snapshot until it refreshes.
  const inverseChanges = pendingChanges?.invertedDesc
  const selected = { words: 0, chars: 0, tokens: 0 }
  const sourceRanges: string[] = []
  // CodeMirror normalizes these ranges, so overlapping selections count once.
  for (const range of ranges) {
    const from = inverseChanges?.mapPos(range.from, 1) ?? range.from
    const to = Math.max(from, inverseChanges?.mapPos(range.to, -1) ?? range.to)
    if (from === to) {
      continue
    }
    // countAll clips node.value in place. Only give it copies of the visible
    // nodes intersecting this range, so repeated selections cannot corrupt AST.
    const selectedAST: Document = {
      ...counts.ast,
      type: 'Document',
      children: counts.textNodes
        .filter(node => node.to >= from && node.from <= to)
        .map(node => ({ ...node }))
    }
    const visible = countAll(selectedAST, counts.locale, from, to)
    selected.words += visible.words
    selected.chars += visible.chars
    sourceRanges.push(counts.document.sliceString(from, to, counts.lineBreak))
  }
  selected.tokens = estimateOfflineTokensInRanges(sourceRanges)
  return selected
}

export const updateWordCountEffect = StateEffect.define<DocumentCounts>()

export const countField = StateField.define<EditorCounts>({
  create (state: EditorState) {
    const counts = count(state)
    return { ...counts, selected: countSelection(counts, state.selection), pendingChanges: null }
  },

  update (value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(updateWordCountEffect) && effect.value.document === transaction.state.doc) {
        return {
          ...effect.value,
          selected: countSelection(effect.value, transaction.state.selection),
          pendingChanges: null
        }
      }
    }

    if (transaction.docChanged || transaction.selection !== undefined) {
      let pendingChanges = value.pendingChanges
      if (transaction.docChanged) {
        pendingChanges = pendingChanges === null
          ? transaction.changes.desc
          : pendingChanges.composeDesc(transaction.changes.desc)
      }
      if (!transaction.docChanged && value.selected === null && transaction.state.selection.ranges.every(range => range.empty)) {
        return value
      }
      return {
        ...value,
        selected: countSelection(value, transaction.state.selection, pendingChanges),
        pendingChanges
      }
    }

    return value
  }
})

export const countPlugin = ViewPlugin.fromClass(class {
  private timeout: number | null = null
  private delay = WORD_COUNT_DELAY

  update (update: ViewUpdate) {
    if (update.docChanged) {
      this.updateCounts(update.view)
    }
  }

  updateCounts (view: EditorView) {
    if (this.timeout != null) {
      window.clearTimeout(this.timeout)
    }

    this.timeout = window.setTimeout(() => {
      this.timeout = null

      const counts = count(view.state)

      view.dispatch({ effects: updateWordCountEffect.of(counts) })
    }, this.delay)
  }

  destroy () {
    if (this.timeout != null) {
      window.clearTimeout(this.timeout)
      this.timeout = null
    }
  }
})
