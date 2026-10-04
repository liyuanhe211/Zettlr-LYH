/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Raw HTML block classification
 * CVM-Role:        Utility Functions
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Pure helper functions that decide how a raw HTML block
 *                  (a `HTMLBlock` syntax node) is displayed in preview mode:
 *                  decorated in place (only inline formatting and simple block
 *                  elements), replaced as a whole with a sanitized rendering
 *                  (tables, links, images, lists, ...), or left as source
 *                  (anything else, e.g. `<script>` or `<iframe>`). This module
 *                  must not depend on the DOM, CodeMirror or Electron so that
 *                  it can be tested under Node.
 *
 * END HEADER
 */

import { INLINE_ELEMENTS, BLOCK_ELEMENTS, scanHtmlBlock } from './html-span-tags'

/**
 * Elements that can only be displayed by replacing the whole block with a
 * rendering, in addition to the inline and block elements that the in-place
 * renderer also understands.
 */
const WIDGET_ONLY_ELEMENTS = [
  // Tables
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  // Links and images
  'a', 'img',
  // Line breaks and horizontal rules
  'br', 'hr',
  // Lists
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  // Headings
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  // Quotations and code
  'blockquote', 'pre', 'code',
  // Figures
  'figure', 'figcaption',
  // Disclosure widgets
  'details', 'summary'
]

/**
 * All elements a raw HTML block may consist of to be rendered as a whole.
 */
export const WIDGET_RENDERABLE_ELEMENTS: ReadonlySet<string> = new Set([
  ...INLINE_ELEMENTS,
  ...BLOCK_ELEMENTS,
  ...WIDGET_ONLY_ELEMENTS
])

/**
 * How a raw HTML block is displayed:
 *
 * - `in-place`: every tag is understood by the in-place renderer, which keeps
 *   the text editable and only hides the tags.
 * - `widget`: the block is replaced as a whole with a sanitized rendering.
 * - `raw`: the block contains an element outside the renderable set and is
 *   left as source.
 */
export type HtmlBlockClassification = 'in-place'|'widget'|'raw'

/**
 * Returns the (lowercase) names of all elements whose tags occur in the text,
 * in document order, one entry per tag. HTML comments are skipped. Any `<` or
 * `</` followed by a letter counts as the start of a tag, regardless of how
 * the tag continues, so malformed tags such as `<script/src=x>` cannot slip
 * through.
 *
 * @param   {string}    text  The block's text
 *
 * @return  {string[]}        The element names
 */
export function findHtmlElementNames (text: string): string[] {
  const withoutComments = text.replace(/<!--[\s\S]*?-->/g, comment => ' '.repeat(comment.length))
  const names: string[] = []
  for (const match of withoutComments.matchAll(/<\/?([a-z][a-z0-9-]*)/gi)) {
    names.push(match[1].toLowerCase())
  }
  return names
}

/**
 * Decides how a raw HTML block is displayed (see `HtmlBlockClassification`).
 * A block without any tags (empty or plain text) counts as `in-place`, since
 * the in-place renderer then simply leaves it as it is.
 *
 * @param   {string}                   text  The block's text
 *
 * @return  {HtmlBlockClassification}        The classification
 */
export function classifyHtmlBlock (text: string): HtmlBlockClassification {
  if (scanHtmlBlock(text) !== undefined) {
    return 'in-place'
  }

  const names = findHtmlElementNames(text)
  return names.every(name => WIDGET_RENDERABLE_ELEMENTS.has(name)) ? 'widget' : 'raw'
}
