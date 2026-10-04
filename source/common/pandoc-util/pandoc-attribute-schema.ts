/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Contract module of the Pandoc attribute editor: the kinds
 *                  of objects whose attributes can be edited, the catalog of
 *                  attribute keys per kind (mirroring the keys the PPTX
 *                  renderer Markdown_Modified_Pandoc_to_PPTX.py understands,
 *                  see Style_Attributes_Reference.md of the skill
 *                  PPT-Maker-NotesInTheScales-Pandoc), and the shapes that the
 *                  target finder (pandoc-attribute-targets.ts) hands to the
 *                  user interface (context menu section, toolbar popover).
 *
 * Description:     Pure data and types, no logic. Keys written as braces
 *                  (`[text]{size=19}`, `![](p){w=300pt}`,
 *                  `::: {.column width="55%"}`) and keys written as directive
 *                  comments (`<!-- table: col-widths=equal -->`) share one
 *                  catalog; `PandocAttributeTargetKind` decides the syntax.
 *
 * END HEADER
 */

/**
 * The kinds of objects whose attributes can be edited.
 *
 * - span:   inline text; an existing bracketed span `[text]{…}` or a plain
 *           selection that will be wrapped into one (brace syntax)
 * - image:  an image `![](path){…}` (brace syntax)
 * - column: a fenced column div `::: {.column width="55%"}` (brace syntax)
 * - table:  a table (directive comment `<!-- table: … -->`)
 * - block:  the top-level block around the cursor -- paragraph, list, heading
 *           or table (directive comment `<!-- style: … -->`)
 * - page:   the slide around the cursor (directive comment `<!-- page: … -->`
 *           before the first block of the slide, normally the heading)
 */
export type PandocAttributeTargetKind = 'span' | 'image' | 'column' | 'table' | 'block' | 'page'

/**
 * How a key's value is edited and written.
 *
 * - text:    free text; written as `key=value` (quoted when needed)
 * - number:  a number without unit, e.g. font-size=22
 * - length:  a length, `300`, `300pt`, `2cm`, and for images also `50%`
 * - size:    absolute (`19`) or relative (`-3`, `+2`) font size
 * - color:   six hexadecimal digits RRGGBB, written without `#`
 * - boolean: `true` / `false`; unset means the renderer default
 * - choice:  one of `choices`; `choices[0]` is the default and is written by
 *            removing the key
 * - flag:    a bare key without value (`allow-overflow`); present or absent
 * - class:   a class `.key` inside braces (`.citation`); present or absent
 */
export type PandocAttributeValueType = 'text' | 'number' | 'length' | 'size' | 'color' | 'boolean' | 'choice' | 'flag' | 'class'

export interface PandocAttributeKey {
  /** The key exactly as written in the Markdown source */
  key: string
  /** English label shown in the user interface */
  label: string
  type: PandocAttributeValueType
  /** For type 'choice' only; the first entry is the default */
  choices?: string[]
  /**
   * For type 'choice' only: when true, any other free text is also accepted
   * (col-widths takes `auto`, `equal`, `source` or a list of point values)
   */
  allowFreeText?: boolean
  /** Short English hint shown next to the input, e.g. the unit */
  hint?: string
}

const TEXT_STYLE_KEYS: PandocAttributeKey[] = [
  { key: 'size', label: 'Font Size', type: 'size', hint: 'pt; -3 or +2 is relative' },
  { key: 'color', label: 'Color', type: 'color', hint: 'RRGGBB' },
  { key: 'bold', label: 'Bold', type: 'boolean' },
  { key: 'italic', label: 'Italic', type: 'boolean' },
  { key: 'underline', label: 'Underline', type: 'boolean' },
  { key: 'font', label: 'Font', type: 'text' }
]

export const PANDOC_ATTRIBUTE_SCHEMA: Record<PandocAttributeTargetKind, PandocAttributeKey[]> = {
  span: [
    ...TEXT_STYLE_KEYS,
    { key: 'citation', label: 'Citation', type: 'class' }
  ],
  image: [
    { key: 'w', label: 'Width', type: 'length', hint: 'pt, cm, or % of the box' },
    { key: 'h', label: 'Height', type: 'length', hint: 'pt, cm, or % of the box' },
    { key: 'x', label: 'Left', type: 'length', hint: 'from the page corner' },
    { key: 'y', label: 'Top', type: 'length', hint: 'from the page corner' },
    { key: 'no-upscale', label: 'No Upscale', type: 'boolean' }
  ],
  column: [
    { key: 'width', label: 'Column Width', type: 'text', hint: 'e.g. 55%' }
  ],
  table: [
    { key: 'col-widths', label: 'Column Widths', type: 'choice', choices: [ 'auto', 'equal', 'source' ], allowFreeText: true, hint: 'or point values: 244,144,179' },
    { key: 'row-heights', label: 'Row Heights', type: 'choice', choices: [ 'auto', 'equal' ], hint: 'equal leaves the header row alone' },
    { key: 'row-height', label: 'Minimum Row Height', type: 'length' },
    { key: 'font-size', label: 'Font Size', type: 'number', hint: 'pt' },
    { key: 'header-fill', label: 'Header Fill', type: 'color', hint: 'RRGGBB' }
  ],
  block: [
    ...TEXT_STYLE_KEYS,
    { key: 'line-spacing', label: 'Line Spacing', type: 'text', hint: '1.15 or 20pt' },
    { key: 'space-before', label: 'Space Before', type: 'length' },
    { key: 'space-after', label: 'Space After', type: 'length' },
    { key: 'align', label: 'Alignment', type: 'choice', choices: [ 'left', 'center', 'right', 'justify' ] },
    { key: 'bullet', label: 'Bullet', type: 'text', hint: 'none or one character' },
    { key: 'indent', label: 'Indent', type: 'length' }
  ],
  page: [
    { key: 'layout', label: 'Layout', type: 'choice', choices: [ '', 'Title Slide', 'Title and Content', 'Section Header', 'Two Content', 'Comparison', 'Content with Caption', 'Blank' ] },
    { key: 'allow-overflow', label: 'Allow Overflow', type: 'flag' },
    { key: 'no-title', label: 'No Title', type: 'flag' },
    { key: 'id', label: 'Page ID', type: 'text' }
  ]
}

/** The directive prefix per directive-comment kind */
export const PANDOC_DIRECTIVE_PREFIX: Partial<Record<PandocAttributeTargetKind, string>> = {
  table: 'table',
  block: 'style',
  page: 'page'
}

/**
 * One editable object found around the cursor or selection.
 */
export interface PandocAttributeTarget {
  kind: PandocAttributeTargetKind
  /** English label for menus and popover sections, e.g. 'Table', 'Selected Text' */
  label: string
  /** Document range of the object itself (not including its directive comment) */
  from: number
  to: number
  /**
   * Current values keyed by catalog key. Keys of type 'flag' and 'class' map
   * to '' when present; absent keys are missing from the record.
   */
  values: Record<string, string>
  /**
   * For span only: true when the selection is not yet a bracketed span and
   * applying attributes will wrap it as `[selection]{…}`
   */
  wrapsSelection?: boolean
}

/**
 * The attribute changes to apply to one target. A key mapped to a string
 * sets that value ('' for flags and classes); a key mapped to undefined
 * removes it. Keys not mentioned stay exactly as written, including keys the
 * catalog does not know.
 */
export type PandocAttributeUpdate = Record<string, string|undefined>
