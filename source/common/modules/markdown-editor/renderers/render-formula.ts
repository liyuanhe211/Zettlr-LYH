/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Formula renderer
 * CVM-Role:        View
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     This renderer displays physical-quantity formulas written
 *                  inside double square brackets, e.g.
 *                  `[[235.90 g/mol × 0.0500 mmol/mL × 4 × 4.00 mL]]`: when
 *                  the selection is not inside the span, the computed result
 *                  (e.g. `188.7 mg`) is displayed instead of the source.
 *                  Clicking the result places the cursor inside the span so
 *                  the original formula becomes visible again. Erroneous
 *                  formulas are displayed bold red as
 *                  `[[<error label>：<original formula>]]`. Bracket contents
 *                  that do not look like a formula (regular wiki links) are
 *                  left to the other extensions.
 *
 * END HEADER
 */

import { renderInlineWidgets } from './base-renderer'
import { type SyntaxNode, type SyntaxNodeRef } from '@lezer/common'
import { WidgetType, EditorView } from '@codemirror/view'
import { type EditorState } from '@codemirror/state'
import clickAndSelect from './click-and-select'
import { evaluateBracketedFormula, formatFormulaError, formatFormulaResult } from 'source/common/util/formula-quantity-calculator'

type FormulaDisplayKind = 'result'|'verbatim'|'error'

const DISPLAY_CLASSES: Record<FormulaDisplayKind, string> = {
  'result': 'formula-calculation-result',
  'verbatim': 'formula-calculation-verbatim',
  'error': 'formula-calculation-error'
}

class FormulaWidget extends WidgetType {
  constructor (readonly displayText: string, readonly displayKind: FormulaDisplayKind, readonly node: SyntaxNode) {
    super()
  }

  eq (other: FormulaWidget): boolean {
    return other.displayText === this.displayText &&
      other.displayKind === this.displayKind &&
      other.node.from === this.node.from &&
      other.node.to === this.node.to
  }

  toDOM (view: EditorView): HTMLElement {
    const elem = document.createElement('span')
    elem.classList.add(DISPLAY_CLASSES[this.displayKind])
    elem.textContent = this.displayText
    elem.addEventListener('click', clickAndSelect(view))
    return elem
  }

  ignoreEvent (event: Event): boolean {
    return true // By default ignore all events
  }
}

function shouldHandleNode (node: SyntaxNodeRef): boolean {
  return node.type.name === 'ZknLink'
}

function createWidget (state: EditorState, node: SyntaxNodeRef): FormulaWidget|undefined {
  const contentNode = node.node.getChild('ZknLinkContent')
  if (contentNode === null) {
    return undefined
  }

  // Piped spans ([[target|title]]) are always regular wiki links
  if (node.node.getChild('ZknLinkTitle') !== null) {
    return undefined
  }

  const content = state.sliceDoc(contentNode.from, contentNode.to)
  const outcome = evaluateBracketedFormula(content)

  if (outcome.kind === 'value') {
    return new FormulaWidget(formatFormulaResult(outcome.display), 'result', node.node)
  } else if (outcome.kind === 'verbatim') {
    return new FormulaWidget(outcome.display, 'verbatim', node.node)
  } else if (outcome.kind === 'error') {
    return new FormulaWidget(formatFormulaError(outcome.label, content), 'error', node.node)
  }

  return undefined // not-formula or unresolved: keep the span as-is
}

export const renderFormulas = [
  renderInlineWidgets(shouldHandleNode, createWidget),
  EditorView.baseTheme({
    '.formula-calculation-result': {
      color: 'rgb(44, 160, 44)', // matplotlib tab:green
      fontWeight: 'bold'
    },
    '.formula-calculation-error': {
      color: 'rgb(255, 0, 0)',
      fontWeight: 'bold'
    }
  })
]
