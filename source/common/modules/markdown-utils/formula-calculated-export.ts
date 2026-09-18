/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Formula-calculated Markdown export
 * CVM-Role:        Utility Function
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Transforms a Markdown document so that every double-bracket
 *                  physical-quantity formula is replaced by its rendered
 *                  outcome. The output is plain Markdown with inline HTML
 *                  spans, so any other Markdown viewer (which knows nothing
 *                  about the formula syntax) shows the same result as this
 *                  editor's preview: computed values as green bold 【…】,
 *                  errors as red bold [[<label>：<formula>]], single
 *                  quantities verbatim. Formulas containing the measured-value
 *                  symbol m, regular wiki links, and anything inside code
 *                  blocks are left untouched.
 *
 * END HEADER
 */

import { extractASTNodes, markdownToAST } from '.'
import type { ZettelkastenLink } from './markdown-ast'
import {
  evaluateBracketedFormula,
  formatFormulaError,
  formatFormulaResult,
  type FormulaOutcome
} from '@common/util/formula-quantity-calculator'

const RESULT_SPAN_STYLE = 'color: rgb(44, 160, 44); font-weight: bold'
const ERROR_SPAN_STYLE = 'color: rgb(255, 0, 0); font-weight: bold'

interface FormulaSpan {
  from: number
  to: number
  target: string
  outcome: FormulaOutcome
}

/**
 * Escapes square brackets so that other Markdown viewers display them
 * literally instead of parsing them as (wiki) link syntax.
 */
function escapeSquareBrackets (text: string): string {
  return text.replace(/\[/g, '\\[').replace(/\]/g, '\\]')
}

/**
 * Collects all double-bracket spans of the document whose contents the
 * formula evaluator recognizes (anything except regular wiki links). Spans
 * inside code blocks never appear here because the Markdown parser does not
 * produce Zettelkasten-link nodes there.
 */
function collectFormulaSpans (markdown: string): FormulaSpan[] {
  const ast = markdownToAST(markdown)
  const links = extractASTNodes(ast, 'ZettelkastenLink') as ZettelkastenLink[]
  const spans: FormulaSpan[] = []

  for (const link of links) {
    if (link.title !== undefined) {
      continue // Piped spans ([[target|title]]) are always regular wiki links
    }

    const outcome = evaluateBracketedFormula(link.target)
    if (outcome.kind !== 'not-formula') {
      spans.push({ from: link.from, to: link.to, target: link.target, outcome })
    }
  }

  return spans
}

/**
 * Returns true if the document contains at least one double-bracket span the
 * formula evaluator recognizes (computed formulas, single quantities,
 * erroneous formulas, or formulas awaiting the measured value m).
 *
 * @param   {string}   markdown  The Markdown source
 *
 * @return  {boolean}            Whether the document contains formulas
 */
export function markdownContainsFormulas (markdown: string): boolean {
  return collectFormulaSpans(markdown).length > 0
}

/**
 * Replaces every recognized double-bracket formula in the document with its
 * rendered outcome (see the file header for the mapping). The original
 * string is not modified.
 *
 * @param   {string}  markdown  The Markdown source
 *
 * @return  {{ result: string, replacedCount: number }}  The transformed
 *                    Markdown and the number of spans that were replaced
 */
export function calculateFormulasInMarkdown (markdown: string): { result: string, replacedCount: number } {
  const spans = collectFormulaSpans(markdown)
  let result = markdown
  let replacedCount = 0

  // Replace from the end so earlier offsets stay valid
  for (const span of spans.sort((a, b) => b.from - a.from)) {
    let replacement: string|undefined
    if (span.outcome.kind === 'value') {
      replacement = `<span style="${RESULT_SPAN_STYLE}">${formatFormulaResult(span.outcome.display)}</span>`
    } else if (span.outcome.kind === 'verbatim') {
      replacement = span.outcome.display
    } else if (span.outcome.kind === 'error') {
      replacement = `<span style="${ERROR_SPAN_STYLE}">${escapeSquareBrackets(formatFormulaError(span.outcome.label, span.target))}</span>`
    }

    if (replacement !== undefined) { // 'unresolved' (symbol m) stays as-is
      result = result.slice(0, span.from) + replacement + result.slice(span.to)
      replacedCount++
    }
  }

  return { result, replacedCount }
}
