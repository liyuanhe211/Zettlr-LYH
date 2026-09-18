/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Formula quantity calculator
 * CVM-Role:        Utility Function
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Standalone module that evaluates physical-quantity formulas
 *                  written inside double square brackets, e.g.
 *                  `[[235.90 g/mol × 0.0500 mmol/mL × 4 × 4.00 mL]]`.
 *                  The module is pure (no editor dependencies) so that it can
 *                  be unit-tested in isolation and reused by both the
 *                  CodeMirror renderer and the Markdown-to-HTML converter.
 *
 *                  Supported unit atoms (whitelist): g, mg, mol, mmol, L, mL,
 *                  µL. Compound units are written with a slash directly
 *                  between two atoms (g/mol, mmol/mL, g/mL, ...). Supported
 *                  operators: × and * (multiplication), ÷ and / (division),
 *                  + and − / - (addition/subtraction), and parentheses. The
 *                  standalone letter `m` denotes a measured value that is
 *                  substituted later; formulas containing it are left
 *                  unevaluated. A formula (or single quantity) may carry a
 *                  leading comparison prefix (`>`, `>=`, `<`, `<=`, `≥`, `≤`)
 *                  which is kept in front of the result, with the ASCII
 *                  two-character forms normalized to ≥ / ≤.
 *
 * END HEADER
 */

/**
 * The three error categories a formula evaluation can produce. The associated
 * user-facing labels live in {@link FORMULA_ERROR_LABELS}.
 */
export type FormulaErrorType = 'syntax'|'unknown-unit'|'unknown-dimension'

/**
 * User-facing (Chinese) labels for the error categories. These strings were
 * specified verbatim by the user and must not be reworded.
 */
export const FORMULA_ERROR_LABELS: Record<FormulaErrorType, string> = {
  'syntax': '公式语法错误无法计算',
  'unknown-unit': '物理量计算未定义单位错误',
  'unknown-dimension': '未知物理量类型'
}

/**
 * The result of evaluating the contents of a double-bracket span.
 *
 * * `value`: A formula that was computed; `display` holds the formatted
 *   result including its output unit (e.g. `188.7 mg`).
 * * `verbatim`: A single quantity without any operator (e.g. `110 °C`,
 *   `1.00 mL`); `display` holds the trimmed original text. No unit
 *   validation is performed on single quantities.
 * * `unresolved`: The formula contains the measured-value symbol `m` and can
 *   only be computed after substitution; callers should leave the source
 *   untouched.
 * * `not-formula`: The contents do not look like a quantity or formula at
 *   all (e.g. a regular wiki link title); callers must fall back to their
 *   normal handling of `[[...]]`.
 * * `error`: The contents look like a formula but cannot be evaluated;
 *   `label` holds the user-facing error label.
 */
export type FormulaOutcome =
  | { kind: 'value', display: string }
  | { kind: 'verbatim', display: string }
  | { kind: 'unresolved' }
  | { kind: 'not-formula' }
  | { kind: 'error', errorType: FormulaErrorType, label: string }

/**
 * Builds the replacement text for a formula error: the double brackets are
 * kept and the error label is prepended to the original contents. Callers
 * are expected to style the whole string bold red (rgb(255, 0, 0)).
 *
 * @param   {string}  label            The error label (one of
 *                                     FORMULA_ERROR_LABELS)
 * @param   {string}  originalContent  The original text between the brackets
 *
 * @return  {string}                   E.g. `[[公式语法错误无法计算：1.0 mL × (2]]`
 */
export function formatFormulaError (label: string, originalContent: string): string {
  return `[[${label}：${originalContent}]]`
}

/**
 * Builds the replacement text for a successfully computed formula result:
 * the result is wrapped in 【】. Callers are expected to style the whole
 * string bold in the Tableau green (rgb(44, 160, 44), matplotlib
 * `tab:green`).
 *
 * @param   {string}  display  The formatted result (e.g. `528.8 mg`)
 *
 * @return  {string}           E.g. `【528.8 mg】`
 */
export function formatFormulaResult (display: string): string {
  return `【${display}】`
}

/**
 * A physical quantity: a numeric value in canonical units (mg, mmol, mL)
 * plus the exponents of the three base dimensions.
 */
interface Quantity {
  value: number
  mass: number
  amount: number
  volume: number
}

interface UnitDefinition {
  /** Conversion factor into the canonical units mg / mmol / mL */
  factor: number
  mass: number
  amount: number
  volume: number
}

/**
 * The unit whitelist. Everything else is reported as an unknown unit when it
 * appears in a computation. NOTE: matching is case-sensitive (`ml` or `ML`
 * are NOT recognized).
 */
const UNIT_ATOMS: Record<string, UnitDefinition> = {
  'g': { factor: 1000, mass: 1, amount: 0, volume: 0 },
  'mg': { factor: 1, mass: 1, amount: 0, volume: 0 },
  'mol': { factor: 1000, mass: 0, amount: 1, volume: 0 },
  'mmol': { factor: 1, mass: 0, amount: 1, volume: 0 },
  'L': { factor: 1000, mass: 0, amount: 0, volume: 1 },
  'mL': { factor: 1, mass: 0, amount: 0, volume: 1 },
  // Micro liters: U+00B5 (micro sign), U+03BC (Greek mu), and the ASCII
  // fallback spelling
  'µL': { factor: 0.001, mass: 0, amount: 0, volume: 1 },
  'μL': { factor: 0.001, mass: 0, amount: 0, volume: 1 },
  'uL': { factor: 0.001, mass: 0, amount: 0, volume: 1 }
}

/** Characters that may appear in anything we treat as a formula/quantity */
const ALLOWED_CHARS_RE = /^[0-9A-Za-z%µμ°.\s×*÷/+−()-]+$/

/**
 * A formula must start (after optional signs/parentheses) with a number or
 * with the standalone measured-value symbol `m`.
 */
const FORMULA_START_RE = /^[+−(\s-]*(?:\d|\.\d|m(?![A-Za-z0-9µμ°]))/

/** Detects the standalone measured-value symbol `m` */
const MEASURED_SYMBOL_RE = /(?<![A-Za-z0-9µμ°])m(?![A-Za-z0-9µμ°])/

/**
 * A single quantity: one (optionally signed) number, optionally followed by
 * one unit-like token (possibly with one slash). Such spans are displayed
 * verbatim without validation, so units outside the whitelist (°C, h, kDa,
 * mg/mL, ...) remain usable as plain annotated values.
 */
const SINGLE_QUANTITY_RE = /^[+−-]?(?:\d+(?:\.\d+)?|\.\d+)(?:\s*[A-Za-z%µμ°][A-Za-z0-9µμ°]*(?:\/[A-Za-z%µμ°][A-Za-z0-9µμ°]*)?)?$/

/**
 * Optional comparison prefixes in front of a formula or single quantity,
 * mapped onto their display form. Longer prefixes must come first so that
 * `>=` wins over `>`.
 */
const COMPARISON_PREFIXES: Array<[ string, string ]> = [
  [ '>=', '≥' ],
  [ '<=', '≤' ],
  [ '≥', '≥' ],
  [ '≤', '≤' ],
  [ '>', '>' ],
  [ '<', '<' ]
]

class FormulaError extends Error {
  constructor (public readonly errorType: FormulaErrorType, public readonly offendingUnit?: string) {
    super(errorType)
  }
}

type Token =
  | { kind: 'number', value: number }
  | { kind: 'unit', unit: UnitDefinition }
  | { kind: 'op', op: '+'|'-'|'*'|'/' }
  | { kind: 'open' }
  | { kind: 'close' }

const LETTER_RUN_RE = /[A-Za-z%µμ°]+/y
const NUMBER_RE = /\d+(?:\.\d+)?|\.\d+/y

function tokenize (text: string): Token[] {
  const tokens: Token[] = []
  let i = 0

  while (i < text.length) {
    const char = text[i]

    if (/\s/.test(char)) {
      i++
      continue
    }

    NUMBER_RE.lastIndex = i
    const numberMatch = NUMBER_RE.exec(text)
    if (numberMatch !== null) {
      tokens.push({ kind: 'number', value: parseFloat(numberMatch[0]) })
      i = NUMBER_RE.lastIndex
      continue
    }

    if (char === '×' || char === '*') {
      tokens.push({ kind: 'op', op: '*' })
      i++
      continue
    }
    if (char === '÷') {
      tokens.push({ kind: 'op', op: '/' })
      i++
      continue
    }
    if (char === '+') {
      tokens.push({ kind: 'op', op: '+' })
      i++
      continue
    }
    if (char === '-' || char === '−') { // ASCII hyphen or true minus sign
      tokens.push({ kind: 'op', op: '-' })
      i++
      continue
    }
    if (char === '(') {
      tokens.push({ kind: 'open' })
      i++
      continue
    }
    if (char === ')') {
      tokens.push({ kind: 'close' })
      i++
      continue
    }

    LETTER_RUN_RE.lastIndex = i
    const letterMatch = LETTER_RUN_RE.exec(text)
    if (letterMatch !== null) {
      const numerator = letterMatch[0]
      i = LETTER_RUN_RE.lastIndex
      const numeratorUnit = UNIT_ATOMS[numerator]
      if (numeratorUnit === undefined) {
        throw new FormulaError('unknown-unit', numerator)
      }

      // A slash directly followed by letters denotes a compound unit
      // (g/mol); a slash in any other position is the division operator.
      let denominatorMatch = null
      if (text[i] === '/') {
        LETTER_RUN_RE.lastIndex = i + 1
        denominatorMatch = LETTER_RUN_RE.exec(text) // Sticky: matches at i + 1 or not at all
      }
      if (denominatorMatch !== null) {
        const denominator = denominatorMatch[0]
        const denominatorUnit = UNIT_ATOMS[denominator]
        if (denominatorUnit === undefined) {
          throw new FormulaError('unknown-unit', `${numerator}/${denominator}`)
        }
        tokens.push({
          kind: 'unit',
          unit: {
            factor: numeratorUnit.factor / denominatorUnit.factor,
            mass: numeratorUnit.mass - denominatorUnit.mass,
            amount: numeratorUnit.amount - denominatorUnit.amount,
            volume: numeratorUnit.volume - denominatorUnit.volume
          }
        })
        i = LETTER_RUN_RE.lastIndex
      } else {
        tokens.push({ kind: 'unit', unit: numeratorUnit })
      }
      continue
    }

    if (char === '/') {
      tokens.push({ kind: 'op', op: '/' })
      i++
      continue
    }

    throw new FormulaError('syntax')
  }

  return tokens
}

/**
 * A small recursive-descent parser implementing:
 *
 *     expression := term  (('+'|'-') term)*
 *     term       := factor (('*'|'/') factor)*
 *     factor     := ('+'|'-')* (number unit? | '(' expression ')' unit?)
 *
 * Addition and subtraction require both operands to have the same dimension;
 * a mismatch counts as a syntax (formula) error.
 */
class Parser {
  private position = 0

  constructor (private readonly tokens: Token[]) {}

  parse (): Quantity {
    const result = this.parseExpression()
    if (this.position !== this.tokens.length) {
      throw new FormulaError('syntax')
    }
    return result
  }

  private peek (): Token|undefined {
    return this.tokens[this.position]
  }

  private parseExpression (): Quantity {
    let left = this.parseTerm()
    let next = this.peek()
    while (next !== undefined && next.kind === 'op' && (next.op === '+' || next.op === '-')) {
      this.position++
      const right = this.parseTerm()
      if (left.mass !== right.mass || left.amount !== right.amount || left.volume !== right.volume) {
        throw new FormulaError('syntax') // Adding quantities of different dimensions
      }
      left = { ...left, value: next.op === '+' ? left.value + right.value : left.value - right.value }
      next = this.peek()
    }
    return left
  }

  private parseTerm (): Quantity {
    let left = this.parseFactor()
    let next = this.peek()
    while (next !== undefined && next.kind === 'op' && (next.op === '*' || next.op === '/')) {
      const op = next.op
      this.position++
      const right = this.parseFactor()
      if (op === '*') {
        left = {
          value: left.value * right.value,
          mass: left.mass + right.mass,
          amount: left.amount + right.amount,
          volume: left.volume + right.volume
        }
      } else {
        left = {
          value: left.value / right.value,
          mass: left.mass - right.mass,
          amount: left.amount - right.amount,
          volume: left.volume - right.volume
        }
      }
      next = this.peek()
    }
    return left
  }

  private parseFactor (): Quantity {
    let sign = 1
    let next = this.peek()
    while (next !== undefined && next.kind === 'op' && (next.op === '+' || next.op === '-')) {
      if (next.op === '-') {
        sign = -sign
      }
      this.position++
      next = this.peek()
    }

    if (next === undefined) {
      throw new FormulaError('syntax')
    }

    let quantity: Quantity
    if (next.kind === 'number') {
      this.position++
      quantity = { value: next.value, mass: 0, amount: 0, volume: 0 }
    } else if (next.kind === 'open') {
      this.position++
      quantity = this.parseExpression()
      const closing = this.peek()
      if (closing === undefined || closing.kind !== 'close') {
        throw new FormulaError('syntax')
      }
      this.position++
    } else {
      throw new FormulaError('syntax')
    }

    // An optional unit may follow both a bare number and a parenthesized
    // group, as in `(1.00 + 1.00) mL`.
    const maybeUnit = this.peek()
    if (maybeUnit !== undefined && maybeUnit.kind === 'unit') {
      this.position++
      quantity = {
        value: quantity.value * maybeUnit.unit.factor,
        mass: quantity.mass + maybeUnit.unit.mass,
        amount: quantity.amount + maybeUnit.unit.amount,
        volume: quantity.volume + maybeUnit.unit.volume
      }
    }

    return { ...quantity, value: sign * quantity.value }
  }
}

/**
 * Formats a value with at most four significant digits, dropping trailing
 * zeros (float noise such as 9.999999999999998 becomes 10).
 */
function formatSignificant (value: number): string {
  return String(Number(value.toPrecision(4)))
}

/**
 * Formats a value with a fixed number of decimals (per the user's ruling:
 * volumes to 0.001 mL, masses to 0.1 mg). If that would round a non-zero
 * value to zero, falls back to four significant digits.
 */
function formatFixed (value: number, decimals: number): string {
  const fixed = value.toFixed(decimals)
  if (Number(fixed) === 0 && value !== 0) {
    return formatSignificant(value)
  }
  return fixed
}

/**
 * Maps a result dimension onto its display unit and formatting. Dimensions
 * missing from this table produce the unknown-dimension error.
 */
const OUTPUT_FORMATS: Record<string, (value: number) => string> = {
  '0|0|0': value => formatSignificant(value),
  '1|0|0': value => `${formatFixed(value, 1)} mg`,
  '0|1|0': value => `${formatSignificant(value)} mmol`,
  '0|0|1': value => `${formatFixed(value, 3)} mL`,
  '0|1|-1': value => `${formatSignificant(value)} mmol/mL`,
  '1|0|-1': value => `${formatSignificant(value)} mg/mL`,
  '1|-1|0': value => `${formatSignificant(value)} g/mol` // canonical mg/mmol equals g/mol numerically
}

/**
 * Evaluates the contents of a double-bracket span. See
 * {@link FormulaOutcome} for the possible results. The passed string must be
 * the text BETWEEN the brackets (without the `[[` and `]]`).
 *
 * @param   {string}          content  The text between the double brackets
 *
 * @return  {FormulaOutcome}           The evaluation outcome
 */
export function evaluateBracketedFormula (content: string): FormulaOutcome {
  let text = content.trim()

  let comparisonPrefix = ''
  for (const [ raw, display ] of COMPARISON_PREFIXES) {
    if (text.startsWith(raw)) {
      comparisonPrefix = display
      text = text.slice(raw.length).trimStart()
      break
    }
  }

  if (text === '' || !ALLOWED_CHARS_RE.test(text) || !FORMULA_START_RE.test(text)) {
    return { kind: 'not-formula' }
  }

  if (SINGLE_QUANTITY_RE.test(text)) {
    return { kind: 'verbatim', display: comparisonPrefix + text }
  }

  if (MEASURED_SYMBOL_RE.test(text)) {
    return { kind: 'unresolved' }
  }

  try {
    const quantity = new Parser(tokenize(text)).parse()

    if (!Number.isFinite(quantity.value)) {
      throw new FormulaError('syntax') // e.g. division by zero
    }

    const dimensionKey = `${quantity.mass}|${quantity.amount}|${quantity.volume}`
    const format = OUTPUT_FORMATS[dimensionKey]
    if (format === undefined) {
      throw new FormulaError('unknown-dimension')
    }

    return { kind: 'value', display: comparisonPrefix + format(quantity.value) }
  } catch (err) {
    const errorType = err instanceof FormulaError ? err.errorType : 'syntax'
    return { kind: 'error', errorType, label: FORMULA_ERROR_LABELS[errorType] }
  }
}
