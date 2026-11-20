/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        renderConversationMarkdown, cleanConversationHtml
 * CVM-Role:        Utility function
 * License:         GNU GPL v3
 *
 * Description:     Turns the Markdown text of a conversation message into HTML
 *                  that is safe to show with v-html in the read-only
 *                  conversation viewer (Zettlr-LYH R79, contract C8 section
 *                  7). After md2html and sanitizeHTML, a second pass in a
 *                  template element that is never attached to the document
 *                  removes everything that could load an external resource
 *                  or navigate: media and embedding elements, URL-bearing
 *                  attributes and inline styles. Images become the text
 *                  "[Image: <alt>]"; links keep their text, their address
 *                  moves to the title, and they can no longer be followed.
 *
 * END HEADER
 */

import { md2html } from '@common/modules/markdown-utils'
import { sanitizeHTML } from '@common/util/sanitize-html'
import { CITEPROC_MAIN_DB } from '@dts/common/citeproc'

/**
 * Elements removed together with their content. The first ten are the ones
 * contract C8 names; the rest can load resources, run code, submit data or
 * draw outside the message as well.
 */
const REMOVED_ELEMENTS = [
  'iframe', 'video', 'audio', 'source', 'object', 'embed', 'link', 'meta', 'style',
  'track', 'picture', 'frame', 'frameset', 'svg', 'math', 'form', 'base',
  'script', 'noscript', 'template', 'canvas', 'applet', 'portal', 'image',
  'button', 'select', 'textarea'
]

/**
 * Attributes removed from every element. `srcset` is required by contract
 * C8; the others either carry an address the browser would load (`src`,
 * `poster`, `background`, `data`, ...) or can (`style` with `url()`).
 */
const REMOVED_ATTRIBUTES = [
  'srcset', 'src', 'style', 'background', 'poster', 'action', 'formaction',
  'data', 'ping', 'lowsrc', 'dynsrc', 'longdesc', 'manifest', 'codebase',
  'xlink:href', 'target'
]

/**
 * Applies the second cleaning pass of contract C8 section 7 to HTML that has
 * already gone through sanitizeHTML. The HTML is parsed into a template
 * element, whose content belongs to an inert document: nothing in it is
 * loaded or run while it is being cleaned.
 *
 * @param   {string}  html  The sanitized HTML
 *
 * @return  {string}        HTML without images, media, embeds, styles and
 *                          followable links
 */
export function cleanConversationHtml (html: string): string {
  const template = document.createElement('template')
  template.innerHTML = html
  const content = template.content

  for (const image of Array.from(content.querySelectorAll('img'))) {
    const alt = image.getAttribute('alt') ?? ''
    image.replaceWith(document.createTextNode(`[Image: ${alt}]`))
  }

  for (const element of Array.from(content.querySelectorAll(REMOVED_ELEMENTS.join(',')))) {
    element.remove()
  }

  for (const element of Array.from(content.querySelectorAll('*'))) {
    if (element.tagName.toLowerCase() === 'a') {
      const href = element.getAttribute('href')
      element.removeAttribute('href')
      if (href !== null && href.trim() !== '') {
        element.setAttribute('title', href)
      }
      element.classList.add('conversation-link')
    } else if (element.hasAttribute('href')) {
      element.removeAttribute('href')
    }

    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase()
      if (REMOVED_ATTRIBUTES.includes(name) || name.startsWith('on')) {
        element.removeAttribute(attribute.name)
      }
    }
  }

  return template.innerHTML
}

/**
 * Renders the Markdown text of a user, assistant or summary node to safe
 * HTML. The md2html options follow ToCTab.vue (contract C8 section 7).
 *
 * @param   {string}                    markdown       The node text
 * @param   {'link|title'|'title|link'} zknLinkFormat  The configured link format
 *
 * @return  {Promise<string>}                          Cleaned HTML
 */
export async function renderConversationMarkdown (markdown: string, zknLinkFormat: 'link|title'|'title|link'): Promise<string> {
  const html = await md2html(markdown, {
    onCitation: window.getCitationCallback(CITEPROC_MAIN_DB),
    zknLinkFormat
  })

  return cleanConversationHtml(sanitizeHTML(html))
}
