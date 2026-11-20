/** Categories shared by preferences, configuration, and Markdown renderers. */
export const codeEditingCategoryLabels = {
  math: 'Math ($...$ and $$...$$)',
  inlineCode: 'Inline code',
  checkboxes: 'Checkboxes in lists and tables',
  headings: 'Headings',
  codeBlocks: 'Fenced code blocks',
  images: 'Images',
  formatting: 'Bold, italic, strikethrough, and highlights',
  links: 'Links and wiki links',
  lists: 'Lists',
  blockquotes: 'Blockquotes',
  html: 'HTML blocks and inline tags',
  pandoc: 'Pandoc divs, spans, and attributes',
  admonitions: 'Admonitions and PDF quote callouts',
  citations: 'Citations and footnotes',
  horizontalRules: 'Horizontal rules',
  diagrams: 'Mermaid diagrams',
  embeddedFrames: 'Embedded frames',
  calculatedFormulas: 'Calculated formulas ([[...]])',
  revisions: 'Tracked changes'
} as const

export type CodeEditingCategory = keyof typeof codeEditingCategoryLabels
export type CodeEditingExceptions = Record<CodeEditingCategory, boolean>

export const defaultCodeEditingExceptions: Readonly<CodeEditingExceptions> = {
  math: true,
  inlineCode: true,
  checkboxes: true,
  headings: false,
  codeBlocks: false,
  images: false,
  formatting: false,
  links: false,
  lists: false,
  blockquotes: false,
  html: false,
  pandoc: false,
  admonitions: false,
  citations: false,
  horizontalRules: false,
  diagrams: false,
  embeddedFrames: false,
  calculatedFormulas: false,
  revisions: false
}
