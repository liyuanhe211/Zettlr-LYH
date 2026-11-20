/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        headingStyle
 * CVM-Role:        View
 * Maintainer:      Zettlr-LYH
 * License:         GNU GPL v3
 *
 * Description:     Applies the configured size and weight of the six heading
 *                  levels and draws a rule above first- and second-level
 *                  headings.
 *
 * END HEADER
 */

import { syntaxTree } from '@codemirror/language'
import { type EditorState, type Range, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view'
import { configField, type EditorConfiguration } from '../util/configuration'

/**
 * Class of the lines that carry a rule above them
 */
export const HEADING_RULE_CLASS = 'cm-heading-rule'

/**
 * Size of each heading level relative to the body text if the configuration
 * provides no usable value
 */
export const DEFAULT_HEADING_SIZES = [ 2, 1.8, 1.5, 1.3, 1, 1 ]

/**
 * Smallest and largest accepted heading size relative to the body text
 */
export const MINIMUM_HEADING_SIZE = 0.5
export const MAXIMUM_HEADING_SIZE = 5

const LEVELS = [ 1, 2, 3, 4, 5, 6 ] as const

const FIRST_OR_SECOND_LEVEL = [ 'ATXHeading1', 'ATXHeading2', 'SetextHeading1', 'SetextHeading2' ]

// Nodes that count as "nothing above" a heading: the YAML frontmatter at the
// start of a document
const DOCUMENT_START_NODES = ['YAMLFrontmatter']

type HeadingSettings = Partial<Pick<EditorConfiguration,
  'headingSize1'|'headingSize2'|'headingSize3'|'headingSize4'|'headingSize5'|'headingSize6'|
  'headingBold1'|'headingBold2'|'headingBold3'|'headingBold4'|'headingBold5'|'headingBold6'
>>

/**
 * Returns a usable heading size for one level.
 *
 * @param   {unknown}  value  The configured size
 * @param   {number}   level  The heading level (1 to 6)
 *
 * @return  {number}          The size relative to the body text
 */
function sanitizeSize (value: unknown, level: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_HEADING_SIZES[level - 1]
  }
  return Math.min(MAXIMUM_HEADING_SIZE, Math.max(MINIMUM_HEADING_SIZE, value))
}

/**
 * Computes the CSS custom properties that set the size and weight of the six
 * heading levels.
 *
 * @param   {HeadingSettings|undefined}  config  The configuration
 *
 * @return  {Record<string, string>}             Property values
 */
export function headingStyleProperties (config: HeadingSettings|undefined): Record<string, string> {
  const properties: Record<string, string> = {}
  for (const level of LEVELS) {
    const size = sanitizeSize(config?.[`headingSize${level}`], level)
    const bold = config?.[`headingBold${level}`] !== false
    properties[`--zettlr-editor-header-${level}-size`] = `${size}em`
    properties[`--zettlr-editor-header-${level}-style`] = bold ? 'bold' : 'normal'
  }
  return properties
}

/**
 * Finds the start positions of the lines of all top-level first- and
 * second-level headings that get a rule above them: every such heading
 * except one at the very start of the document (after the frontmatter, if
 * any) and one directly below another first- or second-level heading.
 *
 * @param   {EditorState}  state  The editor state
 *
 * @return  {number[]}            Line start positions
 */
export function headingRulePositions (state: EditorState): number[] {
  const positions: number[] = []
  const top = syntaxTree(state).topNode
  let previous: string|undefined
  for (let node = top.firstChild; node !== null; node = node.nextSibling) {
    if (FIRST_OR_SECOND_LEVEL.includes(node.name)) {
      const atStart = previous === undefined || DOCUMENT_START_NODES.includes(previous)
      const belowHeading = previous !== undefined && FIRST_OR_SECOND_LEVEL.includes(previous)
      if (!atStart && !belowHeading) {
        positions.push(state.doc.lineAt(node.from).from)
      }
    }
    previous = node.name
  }
  return positions
}

const ruleDecoration = Decoration.line({ class: HEADING_RULE_CLASS })

function ruleDecorations (state: EditorState): DecorationSet {
  const ranges: Array<Range<Decoration>> = headingRulePositions(state).map(pos => ruleDecoration.range(pos))
  return Decoration.set(ranges, true)
}

const headingRuleField = StateField.define<DecorationSet>({
  create: ruleDecorations,
  update (value, tr) {
    if (tr.docChanged || syntaxTree(tr.state) !== syntaxTree(tr.startState)) {
      return ruleDecorations(tr.state)
    }
    return value
  },
  provide: field => EditorView.decorations.from(field)
})

const headingStyleAttributes = EditorView.editorAttributes.compute([configField], state => {
  const style = Object.entries(headingStyleProperties(state.field(configField, false)))
    .map(([ property, value ]) => `${property}: ${value}`)
    .join('; ')
  return { style }
})

export const headingStyle = [
  headingRuleField,
  headingStyleAttributes,
  EditorView.baseTheme({
    // Margins on lines would upset CodeMirror's height measurements, so the
    // rule is a one-pixel background stripe inside a top padding
    [`.${HEADING_RULE_CLASS}`]: {
      paddingTop: '0.9em !important',
      backgroundImage: 'linear-gradient(color-mix(in srgb, currentColor 30%, transparent), color-mix(in srgb, currentColor 30%, transparent))',
      backgroundRepeat: 'no-repeat',
      backgroundSize: '100% 1px',
      backgroundPosition: '0 0.35em'
    }
  })
]
