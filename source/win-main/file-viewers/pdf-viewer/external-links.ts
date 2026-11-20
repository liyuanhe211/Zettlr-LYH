/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Link clicks inside the PDF viewer
 * CVM-Role:        Utility
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH R59: pdf.js renders a PDF's links as anchors in
 *                  the annotation layer. Internal links have an `href` that
 *                  starts with `#` and an onclick handler with which pdf.js'
 *                  PDFLinkService jumps to the destination; they are left
 *                  alone. External web and mail links are opened by
 *                  navigating the window to them: the main process' will-
 *                  navigate handler (source/app/util/attach-app-navigation-
 *                  handlers.ts) cancels such navigations and hands the URL to
 *                  the system. Every other link, and links back to the
 *                  window's own origin (which the development server would
 *                  load in place of Zettlr), is ignored.
 *
 * END HEADER
 */

const EXTERNAL_LINK_PROTOCOLS = [ 'http:', 'https:', 'mailto:' ]

/**
 * Click listener for the viewer container, registered in the capture phase
 *
 * @param   {MouseEvent}  event  The click event
 */
export function handlePdfLinkClick (event: MouseEvent): void {
  const target = event.target
  if (!(target instanceof Element)) {
    return
  }

  const anchor = target.closest('a[href]')
  if (anchor === null) {
    return
  }

  const href = anchor.getAttribute('href') ?? ''
  if (href.startsWith('#')) {
    // Internal link: handled by pdf.js
    return
  }

  event.preventDefault()

  const url = URL.parse(href, window.location.href)
  if (url === null || !EXTERNAL_LINK_PROTOCOLS.includes(url.protocol)) {
    return
  }

  if (url.protocol !== 'mailto:' && url.origin === window.location.origin) {
    return
  }

  window.location.assign(url.href)
}
