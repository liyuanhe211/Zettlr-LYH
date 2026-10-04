/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Standalone HTML export helpers
 * CVM-Role:        Utility Functions
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Environment-independent parts of the "Export to HTML"
 *                  feature: the stylesheet that imitates the main editor's
 *                  rendered display, the assembly of the complete HTML
 *                  document, and the embedding of local images as data URIs.
 *                  The renderer supplies the converted body and the current
 *                  theme values; the main process embeds the images.
 *
 * END HEADER
 */

import { highlightTree } from '@lezer/highlight'
import markdownParser, { type MarkdownParserConfig } from '../markdown-editor/parser/markdown-parser'
import { tagHighlight } from '../markdown-editor/theme/syntax'

/**
 * Written into every exported document; the main process only overwrites an
 * existing HTML file if it carries this marker.
 */
export const EXPORT_HTML_GENERATOR_MARKER = 'Zettlr-LYH Export to HTML'

/**
 * The CSS custom properties of the editor theme (--zettlr-editor-*), plus the
 * resolved --export-* values read from the editor's scroller.
 */
export type EditorThemeVariables = Record<string, string>

export interface StandaloneHTMLOptions {
  /** The document title, shown in the browser's tab */
  title: string
  /** The rendered and sanitized document body */
  bodyHTML: string
  /** The theme variables currently active in the editor */
  themeVariables: EditorThemeVariables
  /** Whether the editor currently displays the dark theme */
  darkMode: boolean
  /** The maximum image width as a percentage of the text column */
  imageMaxWidthPercent: number
  /** The maximum image height as a percentage of the window height */
  imageMaxHeightPercent: number
  /** Additional stylesheets, such as the KaTeX rules */
  extraStylesheets: string[]
}

const IMAGE_MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  tif: 'image/tiff',
  tiff: 'image/tiff'
}

/**
 * Escapes the characters that are special in HTML text and attribute values.
 */
export function escapeHTML (text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Reverses the entity escaping that the DOM applies to attribute values.
 */
function decodeAttributeValue (value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/**
 * Returns the MIME type for an image path, or undefined for unknown formats.
 */
export function imageMimeType (imagePath: string): string|undefined {
  const match = /\.([a-z0-9]+)$/i.exec(imagePath.replace(/[?#].*$/, ''))
  return match !== null ? IMAGE_MIME_TYPES[match[1].toLowerCase()] : undefined
}

/**
 * Replaces the src attribute of every image that points to a local file by a
 * data URI holding the file's contents. Images that cannot be read keep their
 * original source.
 *
 * @param   {string}    html           The HTML document
 * @param   {Function}  resolveSource  Maps a src value to an absolute local
 *                                     path, or undefined for remote sources
 * @param   {Function}  readFile       Reads a file's bytes
 *
 * @return  {Promise}                  The new HTML, the number of embedded
 *                                     images, and the sources that failed
 */
export async function inlineLocalImages (
  html: string,
  resolveSource: (source: string) => string|undefined,
  readFile: (absolutePath: string) => Promise<Uint8Array>
): Promise<{ html: string, inlinedCount: number, failedSources: string[] }> {
  const pattern = /(<img\b[^>]*?\ssrc=")([^"]*)(")/gi
  const dataURIs = new Map<string, string|undefined>()
  const failedSources: string[] = []

  for (const match of html.matchAll(pattern)) {
    const rawSource = match[2]
    if (dataURIs.has(rawSource)) {
      continue
    }

    const source = decodeAttributeValue(rawSource)
    const absolutePath = resolveSource(source)
    const mimeType = absolutePath !== undefined ? imageMimeType(absolutePath) : undefined
    if (absolutePath === undefined || mimeType === undefined) {
      dataURIs.set(rawSource, undefined)
      if (absolutePath !== undefined) {
        failedSources.push(source)
      }
      continue
    }

    try {
      const bytes = await readFile(absolutePath)
      dataURIs.set(rawSource, `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`)
    } catch {
      dataURIs.set(rawSource, undefined)
      failedSources.push(source)
    }
  }

  let inlinedCount = 0
  const result = html.replace(pattern, (whole, before: string, rawSource: string, after: string) => {
    const dataURI = dataURIs.get(rawSource)
    if (dataURI === undefined) {
      return whole
    }
    inlinedCount++
    return `${before}${dataURI}${after}`
  })

  return { html: result, inlinedCount, failedSources }
}

/**
 * Normalizes line endings the way an HTML parser does.
 */
function normalizeLineEndings (text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/**
 * Highlights every fenced code block of a Markdown document with the same
 * parser and the same tag-to-class mapping as the editor, so that the editor's
 * code colors can be applied to the exported blocks.
 *
 * @param   {string}  markdown  The Markdown source
 * @param   {MarkdownParserConfig}  config  The parser configuration
 *
 * @return  {Array}             Per code block, in document order: its plain
 *                              text and its highlighted HTML
 */
export function highlightFencedCodeBlocks (markdown: string, config?: MarkdownParserConfig): Array<{ text: string, html: string }> {
  const tree = markdownParser(config).language.parser.parse(markdown)
  const blocks: Array<{ text: string, html: string }> = []

  tree.iterate({
    enter (node) {
      if (node.name !== 'FencedCode') {
        return undefined
      }

      const codeText = node.node.getChild('CodeText')
      if (codeText === null) {
        return false
      }

      let html = ''
      let position = codeText.from
      highlightTree(tree, tagHighlight, (from, to, classes) => {
        if (from > position) {
          html += escapeHTML(markdown.slice(position, from))
        }
        html += `<span class="${classes}">${escapeHTML(markdown.slice(from, to))}</span>`
        position = to
      }, codeText.from, codeText.to)

      if (position < codeText.to) {
        html += escapeHTML(markdown.slice(position, codeText.to))
      }

      blocks.push({
        text: normalizeLineEndings(markdown.slice(codeText.from, codeText.to)),
        html: normalizeLineEndings(html)
      })
      return false
    }
  })

  return blocks
}

/**
 * Replaces the contents of the document's code blocks with their highlighted
 * versions. A block is only replaced if its text matches the next highlighted
 * block, so blocks the converter treated differently are left as they are.
 *
 * @param   {ParentNode}  container  The converted document
 * @param   {Array}       blocks     The result of highlightFencedCodeBlocks
 */
export function applyCodeHighlighting (container: ParentNode, blocks: Array<{ text: string, html: string }>): void {
  let next = 0
  for (const code of Array.from(container.querySelectorAll('pre > code'))) {
    const text = normalizeLineEndings(code.textContent ?? '')
    const index = blocks.findIndex((block, i) => i >= next && block.text === text)
    if (index < 0) {
      continue
    }
    code.innerHTML = blocks[index].html
    next = index + 1
  }
}

const NO_LINE_BREAK_ANCESTORS = 'pre, code, script, style, svg, math, textarea, .katex, .html-block-preview, .mermaid-chart'

/**
 * The editor shows every line of a paragraph on a line of its own, whereas
 * HTML joins them. This turns the soft line breaks inside running text into
 * <br> elements. Whitespace-only text between elements is left alone.
 *
 * @param   {Document}  container  The converted document
 */
export function convertSoftLineBreaks (container: Document): void {
  const walker = container.createTreeWalker(container.body, 0x4 /* NodeFilter.SHOW_TEXT */)
  const textNodes: Text[] = []
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node as Text
    if (!text.data.includes('\n') || text.data.trim() === '') {
      continue
    }
    if (text.parentElement?.closest(NO_LINE_BREAK_ANCESTORS) != null) {
      continue
    }
    textNodes.push(text)
  }

  for (const text of textNodes) {
    const parts = text.data.split(/[ \t]*\r?\n\s*/)
    const hasContentBefore = text.previousSibling !== null
    const hasContentAfter = text.nextSibling !== null
    const fragment = container.createDocumentFragment()

    parts.forEach((part, index) => {
      if (index > 0) {
        const before = hasContentBefore || parts.slice(0, index).some(previous => previous.trim() !== '')
        const after = hasContentAfter || parts.slice(index).some(following => following.trim() !== '')
        fragment.appendChild(before && after ? container.createElement('br') : container.createTextNode(' '))
      }
      if (part !== '') {
        fragment.appendChild(container.createTextNode(part))
      }
    })

    text.replaceWith(fragment)
  }
}

/**
 * Bracketed text that is not a link, such as citation numbers like [27,N1],
 * keeps its brackets in the editor, drawn in the code font. This wraps the two
 * brackets so the stylesheet can do the same.
 *
 * @param   {Document}  container  The converted document
 */
export function markBracketLinkMarks (container: Document): void {
  for (const span of Array.from(container.querySelectorAll('span.link'))) {
    const TEXT_NODE = 3
    if (span.firstChild?.nodeType !== TEXT_NODE || span.lastChild?.nodeType !== TEXT_NODE) {
      continue
    }
    const first = span.firstChild as Text
    const last = span.lastChild as Text
    if (!first.data.startsWith('[') || !last.data.endsWith(']')) {
      continue
    }

    const open = container.createElement('span')
    open.className = 'link-mark'
    open.textContent = '['
    const close = container.createElement('span')
    close.className = 'link-mark'
    close.textContent = ']'

    if (first === last) {
      first.data = first.data.slice(1, -1)
    } else {
      first.data = first.data.slice(1)
      last.data = last.data.slice(0, -1)
    }
    span.insertBefore(open, span.firstChild)
    span.appendChild(close)
  }
}

/**
 * The editor centers lines that hold nothing but images. This marks the
 * top-level paragraphs that consist of images and whitespace only, so the
 * stylesheet can center them as well. Paragraphs inside lists, blockquotes,
 * and HTML blocks are left alone, as in the editor.
 *
 * @param   {Document}  container  The converted document
 */
export function markImageOnlyParagraphs (container: Document): void {
  const TEXT_NODE = 3
  for (const paragraph of Array.from(container.body.children)) {
    if (paragraph.nodeName !== 'P') {
      continue
    }

    const children = Array.from(paragraph.childNodes)
    const imagesOnly = children.every(child => child.nodeName === 'IMG' || (child.nodeType === TEXT_NODE && (child.textContent ?? '').trim() === ''))

    if (imagesOnly && children.some(child => child.nodeName === 'IMG')) {
      paragraph.classList.add('image-paragraph')
    }
  }
}

/**
 * Makes the task list checkboxes look like the editor's (enabled rather than
 * greyed out), while keeping them read-only.
 *
 * @param   {ParentNode}  container  The converted document
 */
export function enableTaskCheckboxes (container: ParentNode): void {
  for (const checkbox of Array.from(container.querySelectorAll('li > input[type="checkbox"]'))) {
    checkbox.removeAttribute('disabled')
    checkbox.setAttribute('onclick', 'return false')
  }
}

/**
 * Renders the theme variables as the declarations of a :root rule. Values
 * that could break out of the style element are dropped.
 */
function renderThemeVariables (variables: EditorThemeVariables): string {
  return Object.entries(variables)
    .filter(([ name, value ]) => /^--[a-z0-9-]+$/i.test(name) && !/[<>{};]/.test(value))
    .map(([ name, value ]) => `  ${name}: ${value};`)
    .join('\n')
}

/**
 * Returns the stylesheet that imitates the main editor's rendered display.
 */
export function getExportStylesheet (imageMaxWidthPercent: number, imageMaxHeightPercent: number): string {
  const imageWidth = Number.isFinite(imageMaxWidthPercent) && imageMaxWidthPercent > 0 ? imageMaxWidthPercent : 100
  const imageHeight = Number.isFinite(imageMaxHeightPercent) && imageMaxHeightPercent > 0 && imageMaxHeightPercent < 100
    ? `${imageMaxHeightPercent}vh`
    : 'none'

  return EXPORT_STYLESHEET
    .replace('__IMAGE_MAX_WIDTH__', `${imageWidth}%`)
    .replace('__IMAGE_MAX_HEIGHT__', imageHeight)
}

/**
 * Assembles the complete, self-contained HTML document.
 */
export function buildStandaloneHTMLDocument (options: StandaloneHTMLOptions): string {
  const colorScheme = options.darkMode ? 'dark' : 'light'
  const styles = [
    `:root {\n  color-scheme: ${colorScheme};\n${renderThemeVariables(options.themeVariables)}\n}`,
    getExportStylesheet(options.imageMaxWidthPercent, options.imageMaxHeightPercent),
    ...options.extraStylesheets.filter(sheet => sheet.trim() !== '')
  ].map(sheet => sheet.replace(/<\/style/gi, '<\\/style'))

  return [
    '<!DOCTYPE html>',
    `<html class="${colorScheme}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta name="generator" content="${EXPORT_HTML_GENERATOR_MARKER}">`,
    `<title>${escapeHTML(options.title)}</title>`,
    ...styles.map(sheet => `<style>\n${sheet}\n</style>`),
    '</head>',
    '<body>',
    '<main id="document">',
    options.bodyHTML,
    '</main>',
    '</body>',
    '</html>',
    ''
  ].join('\n')
}

// The values follow the main editor's rendered display (theme/editor.ts,
// MainEditor.vue, the renderers, and the table editor). Unlike the editor, the
// text column is limited in width, and the blank lines between blocks become
// margins of one line height.
const EXPORT_STYLESHEET = `
:root {
  --export-line: calc(var(--zettlr-editor-line-height, 1.4) * var(--export-font-size, 18px));
  --export-table-color: #3a3a3a;
  --export-table-border: #bdbdbd;
}

html.dark {
  --export-table-color: #d6d6d6;
  --export-table-border: #4a4a4a;
}

* {
  box-sizing: border-box;
}

html {
  background-color: var(--export-background-color, var(--zettlr-editor-scroller-bg));
}

body {
  margin: 0;
  background-color: var(--export-background-color, var(--zettlr-editor-scroller-bg));
  color: var(--export-text-color, var(--zettlr-editor-scroller-color));
  font-family: var(--zettlr-editor-font);
  font-size: var(--export-font-size, 18px);
  line-height: var(--zettlr-editor-line-height, 1.4);
}

#document {
  max-width: calc(47em + 100px);
  margin: 0 auto;
  padding: 50px;
  overflow-wrap: break-word;
}

/* Running text is justified, as in the editor */
#document :is(p:not(.image-paragraph), li, blockquote, dd, #footnote-container) {
  text-align: justify;
}

/* Paragraphs holding nothing but images are centered, as in the editor */
#document p.image-paragraph {
  text-align: center;
}

/* Bracketed text without a link target, e.g. citation numbers like [27,N1] */
#document span.link {
  color: var(--zettlr-editor-primary-color);
  text-decoration: var(--zettlr-editor-line-decoration, none);
}

#document span.link > .link-mark {
  font-family: var(--zettlr-editor-code-font);
  color: var(--export-text-color, var(--zettlr-editor-scroller-color));
}

@media (max-width: 700px) {
  #document {
    padding: 20px;
  }
}

::selection {
  background: var(--zettlr-editor-selection-color);
}

/* Blocks are separated by one empty line, as in the editor */
#document p, #document ul, #document ol, #document dl, #document blockquote,
#document pre, #document table, #document figure, #document hr,
#document .html-block-preview, #document .mermaid-chart,
#document .katex-display, #document h1, #document h2, #document h3,
#document h4, #document h5, #document h6 {
  margin-top: 0;
  margin-bottom: var(--export-line);
}

#document > :last-child {
  margin-bottom: 0;
}

/* Headings */
#document h1, #document h2, #document h3, #document h4, #document h5, #document h6 {
  font-weight: var(--zettlr-editor-header-style, bold);
  font-family: var(--zettlr-editor-font);
  line-height: normal;
  color: inherit;
  text-decoration: var(--zettlr-editor-line-decoration, none);
}

#document * + h1, #document * + h2, #document * + h3,
#document * + h4, #document * + h5, #document * + h6 {
  margin-top: var(--export-line);
}

#document h1 { font-size: var(--zettlr-editor-header-1-size, 2em); }
#document h2 { font-size: var(--zettlr-editor-header-2-size, 1.8em); }
#document h3 { font-size: var(--zettlr-editor-header-3-size, 1.5em); }
#document h4 { font-size: var(--zettlr-editor-header-4-size, 1.3em); }
#document h5 { font-size: var(--zettlr-editor-header-5-size, 1em); }
#document h6 { font-size: var(--zettlr-editor-header-6-size, 1em); }

#document blockquote :is(h1, h2, h3, h4, h5, h6) {
  font-size: 1em;
}

/* Inline formatting */
#document em {
  font-style: var(--zettlr-editor-emphasis-style, italic);
}

#document strong, #document b {
  font-weight: var(--zettlr-editor-strong-style, bold);
}

#document mark {
  background-color: var(--zettlr-editor-highlight-color);
  color: inherit;
}

#document s, #document del, #document strike {
  text-decoration: line-through;
  text-decoration-thickness: 2px;
}

#document a {
  color: var(--zettlr-editor-primary-color);
  text-decoration: var(--zettlr-editor-line-decoration, none);
}

#document .html-block-preview a {
  text-decoration: underline;
}

#document sup, #document sub {
  line-height: 0;
}

#document sup.footnote-ref-label, #document a.footnote {
  font-size: 0.8rem;
}

#document .citation {
  background-color: var(--zettlr-editor-citation-bg);
}

/* Code */
#document code {
  font-family: var(--zettlr-editor-code-font);
  color: var(--zettlr-editor-code-color);
  font-size: 1em;
}

#document :not(pre) > code {
  background-color: var(--zettlr-editor-code-bg);
  border-radius: 2px;
  padding: 0 2px;
}

/* The editor keeps the backticks of inline code visible */
#document :not(pre) > code::before,
#document :not(pre) > code::after {
  content: "\`";
}

#document pre {
  background-color: var(--zettlr-editor-code-bg);
  border-radius: 4px;
  padding: 0 6px;
  overflow-x: auto;
  line-height: var(--zettlr-editor-line-height, 1.4);
}

#document pre code {
  white-space: pre;
  background: none;
  padding: 0;
}

/* Syntax colors of the editor's code theme (Solarized) */
#document pre code :is(.cm-comment, .cm-line-comment, .cm-block-comment) { color: #657b83; }
#document pre code :is(.cm-keyword, .cm-inserted, .cm-positive) { color: #859900; }
#document pre code .cm-string { color: var(--zettlr-editor-secondary-color); }
#document pre code :is(.cm-control-keyword, .cm-atom, .cm-color, .cm-number, .cm-integer, .cm-bool) { color: #6c71c4; }
#document pre code :is(.cm-property, .cm-operator, .cm-compare-operator, .cm-arithmetic-operator, .cm-self) { color: #d33682; }
#document pre code :is(.cm-operator-keyword, .cm-definition-keyword, .cm-module-keyword, .cm-null, .cm-meta, .cm-unit, .cm-qualifier, .cm-builtin, .cm-property-name) { color: #268bd2; }
#document pre code :is(.cm-tag-name, .cm-modifier, .cm-variable-name, .cm-variable) { color: #2aa198; }
#document pre code :is(.cm-attribute-name, .cm-regexp) { color: #cb4b16; }
#document pre code :is(.cm-name, .cm-class-name, .cm-type-name, .cm-changed) { color: #b58900; }
#document pre code :is(.cm-deleted, .cm-negative, .cm-invalid) { color: #dc322f; }

/* Blockquotes */
#document blockquote {
  border-left: 0.25em solid var(--zettlr-editor-primary-color);
  padding-left: 0.5em;
  margin-left: 0.25em;
  margin-right: 0;
}

#document blockquote > * {
  opacity: 0.7;
}

#document blockquote > blockquote {
  opacity: 1;
}

#document blockquote > :last-child {
  margin-bottom: 0;
}

/* Lists: tight like the editor's lines, with the marker in the accent color */
#document ul, #document ol {
  padding-left: 1.3em;
}

#document li > p {
  margin: 0;
}

#document li > ul, #document li > ol {
  margin-bottom: 0;
}

#document ul > li::marker {
  content: "\\2022  ";
}

#document ol > li::marker {
  color: var(--zettlr-editor-primary-color);
}

#document li > input[type="checkbox"] {
  transform: scale(1.2);
  margin: 0.2em 0.3em 0.2em 0.2em;
  vertical-align: middle;
}

/* Horizontal rules */
#document hr {
  border: none;
  border-top: 1px solid var(--zettlr-editor-escape-color);
}

/* Markdown tables, as drawn by the table editor */
#document table {
  border-collapse: collapse;
  display: block;
  width: max-content;
  max-width: 100%;
  overflow-x: auto;
}

#document th, #document td {
  text-align: left;
  color: var(--export-table-color);
  border: 1px solid var(--export-table-border);
  padding: 4px 6px;
  min-width: 96px;
  vertical-align: top;
}

#document th {
  font-weight: bold;
}

/* Raw HTML blocks, as drawn by the editor's HTML block preview */
#document .html-block-preview {
  overflow-x: auto;
}

#document .html-block-preview :is(h1, h2, h3, h4, h5, h6, p, ul, ol, dl, figure) {
  margin: 0;
}

#document .html-block-preview table {
  display: table;
  width: auto;
  margin: 4px 0;
}

#document .html-block-preview :is(th, td) {
  color: inherit;
  border: 1px solid rgba(128, 128, 128, 0.5);
  padding: 4px 8px;
  min-width: 0;
  text-align: inherit;
}

#document .html-block-preview th {
  background: rgba(128, 128, 128, 0.12);
}

/* Images */
#document img {
  max-width: __IMAGE_MAX_WIDTH__;
  max-height: __IMAGE_MAX_HEIGHT__;
  vertical-align: bottom;
}

#document .html-block-preview img, #document p > img[width] {
  max-height: none;
}

#document img[width] {
  height: auto;
}

/* Formulas and charts */
#document .katex {
  font-size: 1.1em;
}

#document .katex-display {
  overflow-x: auto;
  overflow-y: hidden;
}

#document .mermaid-chart {
  display: block;
}

#document .mermaid-chart svg {
  max-width: 100%;
  height: auto;
}

#document .mermaid-chart.error {
  font-family: var(--zettlr-editor-code-font);
  color: var(--zettlr-editor-error-color);
  white-space: pre-wrap;
}

/* Pandoc bracketed spans and fenced divs */
#document .mark {
  background-color: var(--zettlr-editor-highlight-color);
}

#document .underline {
  text-decoration: underline;
}

#document .smallcaps {
  font-variant-caps: small-caps;
}

/* Footnotes */
#footnote-container {
  font-size: 0.9em;
}

#footnote-container .footnote-ref > p:first-of-type {
  display: inline;
}

@media print {
  html, body {
    background: none;
  }

  #document {
    max-width: none;
    padding: 0;
  }
}
`
