/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        sanitizeHTML
 * CVM-Role:        Utility Function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Provides a simple wrapper around DOMPurify with default configuration.
 *
 * END HEADER
 */
import DOMPurify, { type UponSanitizeAttributeHookEvent } from 'dompurify'

/**
 * Matches a Windows absolute path such as `E:/Figures/a.png` or `E:\a.png`.
 * DOMPurify reads the drive letter as an unknown URL scheme and removes such
 * image sources.
 */
const WINDOWS_ABSOLUTE_PATH = /^\s*[a-z]:[\\/]/i

/**
 * Options for sanitizeHTML.
 */
export interface SanitizeHTMLOptions {
  /**
   * Keep image sources that are Windows absolute paths, so that the caller can
   * resolve them into loadable URLs afterwards.
   */
  keepWindowsImagePaths?: boolean
}

/**
 * DOMPurify hook that keeps the source of an image if it is a Windows absolute
 * path.
 *
 * @param   {Element}                          node  The sanitized node
 * @param   {UponSanitizeAttributeHookEvent}   data  The attribute event
 */
function keepWindowsImagePath (node: Element, data: UponSanitizeAttributeHookEvent): void {
  if (node.nodeName === 'IMG' && data.attrName === 'src' && WINDOWS_ABSOLUTE_PATH.test(data.attrValue)) {
    data.forceKeepAttr = true
  }
}

/**
 * Sanitizes the provided HTML string and prepare it for insertion into the DOM.
 * This function uses DOMPurify, but configures it so that it works for the
 * context of Zettlr.
 *
 * @param   {string}               html     The dirty HTML
 * @param   {SanitizeHTMLOptions}  options  Optional behavior changes
 *
 * @return  {string}                        The cleaned HTML
 */
export function sanitizeHTML (html: string, options: SanitizeHTMLOptions = {}) {
  if (options.keepWindowsImagePaths !== true) {
    return DOMPurify.sanitize(html, {
      // Allow tags that Zettlr uses
      ADD_TAGS: ['cds-icon']
    })
  }

  // The hook is registered only for this synchronous call, so that other users
  // of the shared DOMPurify instance (e.g., the HTML export) are not affected.
  DOMPurify.addHook('uponSanitizeAttribute', keepWindowsImagePath)
  try {
    return DOMPurify.sanitize(html, { ADD_TAGS: ['cds-icon'] })
  } finally {
    DOMPurify.removeHook('uponSanitizeAttribute', keepWindowsImagePath)
  }
}
