/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Hover popup of the PDF viewer's backlink highlights
 * CVM-Role:        Utility
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH R62 (contract C11, section "悬停"): when the
 *                  mouse rests on a backlink highlight, a tippy.js popup lists
 *                  the notes that quote the passage, one item per line of a
 *                  note: the note's file name with `line N`, then the quoted
 *                  text (or the link text) cut to 300 characters, and for a
 *                  link whose position could not be checked against its
 *                  quoted text a notice. Clicking an item opens the note like
 *                  a double click on the highlight. All text is inserted as
 *                  plain text, never parsed as HTML. The popup appears after
 *                  PDF_BACKLINK_HOVER_DELAY_MS and disappears 100 ms after the
 *                  mouse has left both the highlight and the popup.
 *
 * END HEADER
 */

import tippy, { type Instance } from 'tippy.js'
import { PDF_BACKLINK_HOVER_DELAY_MS } from 'source/types/common/pdf-viewer'
import type { PdfBacklinkHit } from './backlink-highlight'

/**
 * Longest quoted text shown per item, in characters (code points)
 */
export const PDF_BACKLINK_POPUP_TEXT_LIMIT = 300

/**
 * Time after leaving the highlight and the popup until the popup hides
 */
export const PDF_BACKLINK_POPUP_HIDE_DELAY_MS = 100

/**
 * Items shown before the list scrolls
 */
export const PDF_BACKLINK_POPUP_VISIBLE_ITEMS = 6

/**
 * Notice added to an item whose position is not verified (decision on
 * question 593)
 */
export const PDF_BACKLINK_FALLBACK_NOTICE = 'Position not verified against the quoted text.'

const POPUP_CLASS = 'zettlr-pdf-backlink-popup'
const POPUP_STYLE_ELEMENT_ID = 'zettlr-lyh-pdf-backlink-popup-styles'

/**
 * What one item of the popup shows
 */
export interface PdfBacklinkPopupItem {
  hit: PdfBacklinkHit
  /**
   * File name of the note, with extension
   */
  fileName: string
  /**
   * `line N`
   */
  lineLabel: string
  /**
   * The quoted text, or the link text if there is none, on one line and cut
   * to PDF_BACKLINK_POPUP_TEXT_LIMIT characters
   */
  text: string
  /**
   * PDF_BACKLINK_FALLBACK_NOTICE for an unverified position, otherwise null
   */
  notice: string|null
}

/**
 * The last segment of a path, with either kind of separator
 *
 * @param   {string}  path  An absolute path
 *
 * @return  {string}        The file name
 */
export function noteFileName (path: string): string {
  const segments = path.split(/[\\/]/)
  return segments[segments.length - 1]
}

/**
 * Cuts a text to a number of characters (code points, so that no surrogate
 * pair is split) and appends an ellipsis if anything was cut
 *
 * @param   {string}  text   The text
 * @param   {number}  limit  The most characters to keep
 *
 * @return  {string}         The text, at most limit characters plus `…`
 */
export function truncatePopupText (text: string, limit: number = PDF_BACKLINK_POPUP_TEXT_LIMIT): string {
  const characters = Array.from(text)
  if (characters.length <= limit) {
    return text
  }

  return characters.slice(0, limit).join('') + '…'
}

/**
 * Turns hits into the items of the popup, in the given order
 *
 * @param   {PdfBacklinkHit[]}        hits  The hits (from hitTest)
 *
 * @return  {PdfBacklinkPopupItem[]}        One item per hit
 */
export function buildBacklinkPopupItems (hits: PdfBacklinkHit[]): PdfBacklinkPopupItem[] {
  return hits.map(hit => {
    const sourceText = (hit.backlink.sourceText ?? '').replace(/\s+/g, ' ').trim()
    const text = sourceText !== '' ? sourceText : hit.backlink.displayText.replace(/\s+/g, ' ').trim()
    return {
      hit,
      fileName: noteFileName(hit.backlink.notePath),
      lineLabel: `line ${hit.backlink.line}`,
      text: truncatePopupText(text),
      notice: hit.fallback ? PDF_BACKLINK_FALLBACK_NOTICE : null
    }
  })
}

/**
 * Adds the popup's style rules to a document, once
 *
 * @param   {Document}  ownerDocument  The document the popup is shown in
 */
function ensurePopupStyles (ownerDocument: Document): void {
  if (ownerDocument.getElementById(POPUP_STYLE_ELEMENT_ID) !== null) {
    return
  }

  const style = ownerDocument.createElement('style')
  style.id = POPUP_STYLE_ELEMENT_ID
  style.textContent = [
    `.${POPUP_CLASS}-list { position: relative; margin: 0; padding: 0; }`,
    `.${POPUP_CLASS}-list.scrolling { overflow-y: auto; max-height: 50vh; }`,
    `.${POPUP_CLASS}-item { padding: 4px 6px; border-radius: 3px; cursor: pointer; }`,
    `.${POPUP_CLASS}-item:hover, .${POPUP_CLASS}-item:focus { background-color: rgba(255, 255, 255, 0.15); outline: none; }`,
    `.${POPUP_CLASS}-title { font-weight: bold; }`,
    `.${POPUP_CLASS}-line { font-weight: normal; opacity: 0.8; margin-left: 6px; }`,
    `.${POPUP_CLASS}-text { white-space: normal; overflow-wrap: anywhere; }`,
    `.${POPUP_CLASS}-notice { font-style: italic; opacity: 0.8; }`
  ].join('\n')
  ownerDocument.head.appendChild(style)
}

/**
 * Builds the popup's content. Every text is set through textContent.
 *
 * @param   {PdfBacklinkPopupItem[]}  items          The items
 * @param   {Document}                ownerDocument  The document to create the nodes in
 * @param   {Function}                onOpen         Called with the hit of a clicked item
 *
 * @return  {HTMLElement}                            The content element
 */
export function createBacklinkPopupContent (
  items: PdfBacklinkPopupItem[],
  ownerDocument: Document,
  onOpen: (hit: PdfBacklinkHit) => void
): HTMLElement {
  const content = ownerDocument.createElement('div')
  content.className = POPUP_CLASS

  const list = ownerDocument.createElement('div')
  list.className = `${POPUP_CLASS}-list`
  list.setAttribute('role', 'list')
  if (items.length > PDF_BACKLINK_POPUP_VISIBLE_ITEMS) {
    list.classList.add('scrolling')
  }
  content.appendChild(list)

  for (const item of items) {
    const element = ownerDocument.createElement('div')
    element.className = `${POPUP_CLASS}-item`
    element.setAttribute('role', 'listitem')
    element.tabIndex = 0

    const title = ownerDocument.createElement('div')
    title.className = `${POPUP_CLASS}-title`
    const fileName = ownerDocument.createElement('span')
    fileName.className = `${POPUP_CLASS}-file`
    fileName.textContent = item.fileName
    const lineLabel = ownerDocument.createElement('span')
    lineLabel.className = `${POPUP_CLASS}-line`
    lineLabel.textContent = item.lineLabel
    title.append(fileName, lineLabel)
    element.appendChild(title)

    if (item.text !== '') {
      const text = ownerDocument.createElement('div')
      text.className = `${POPUP_CLASS}-text`
      text.textContent = item.text
      element.appendChild(text)
    }

    if (item.notice !== null) {
      const notice = ownerDocument.createElement('div')
      notice.className = `${POPUP_CLASS}-notice`
      notice.textContent = item.notice
      element.appendChild(notice)
    }

    element.addEventListener('click', () => { onOpen(item.hit) })
    element.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        onOpen(item.hit)
      }
    })

    list.appendChild(element)
  }

  return content
}

/**
 * Limits the list of a shown popup to PDF_BACKLINK_POPUP_VISIBLE_ITEMS items
 * by measuring where the next item starts; the stylesheet's max-height stays
 * in force where nothing can be measured
 *
 * @param   {HTMLElement}  popper  The tippy popper element
 */
function limitPopupListHeight (popper: HTMLElement): void {
  const list = popper.querySelector(`.${POPUP_CLASS}-list`)
  if (!(list instanceof HTMLElement) || list.children.length <= PDF_BACKLINK_POPUP_VISIBLE_ITEMS) {
    return
  }

  const first = list.children[0] as HTMLElement
  const firstHidden = list.children[PDF_BACKLINK_POPUP_VISIBLE_ITEMS] as HTMLElement
  const height = firstHidden.offsetTop - first.offsetTop
  if (height > 0) {
    list.style.maxHeight = `${height}px`
  }
}

/**
 * A key that tells two lists of hits apart
 */
function hitsKey (hits: PdfBacklinkHit[]): string {
  return hits.map(hit => `${hit.backlink.notePath}\n${hit.backlink.line}`).join('\n\n')
}

/**
 * What PdfBacklinkPopup needs from its viewer
 */
export interface PdfBacklinkPopupOptions {
  /**
   * The element the tippy instance is attached to, e.g. the viewer's pages
   * container; the popup itself is placed at the mouse
   */
  reference: HTMLElement
  /**
   * Called with the hit of a clicked item, after the popup has been hidden
   */
  onOpen: (hit: PdfBacklinkHit) => void
}

/**
 * The hover popup of one viewer. The viewer reports every mouse move over the
 * pages with the hits there (hover), and the mouse leaving the pages (leave).
 */
export class PdfBacklinkPopup {
  private readonly options: PdfBacklinkPopupOptions
  private instance: Instance|null = null
  private shownKey: string|null = null
  private pendingKey: string|null = null
  private pendingHits: PdfBacklinkHit[] = []
  private point = { x: 0, y: 0 }
  private showTimer: ReturnType<typeof setTimeout>|undefined = undefined
  private hideTimer: ReturnType<typeof setTimeout>|undefined = undefined
  private pointerInPopup = false

  constructor (options: PdfBacklinkPopupOptions) {
    this.options = options
  }

  /**
   * Whether the popup is shown
   */
  get isShown (): boolean {
    return this.shownKey !== null
  }

  /**
   * Reports the mouse at a point over the pages and the hits there. With
   * hits, the popup appears once the mouse has rested on the same hits for
   * PDF_BACKLINK_HOVER_DELAY_MS, or changes its content at once if it is
   * already shown; without hits, a shown popup hides after
   * PDF_BACKLINK_POPUP_HIDE_DELAY_MS unless the mouse enters it.
   *
   * @param   {PdfBacklinkHit[]}  hits     The hits at the point (hitTest)
   * @param   {number}            clientX  The point's clientX
   * @param   {number}            clientY  The point's clientY
   */
  hover (hits: PdfBacklinkHit[], clientX: number, clientY: number): void {
    this.point = { x: clientX, y: clientY }

    if (hits.length === 0) {
      this.cancelShow()
      this.scheduleHide()
      return
    }

    this.cancelHide()
    const key = hitsKey(hits)
    if (this.shownKey !== null) {
      if (key !== this.shownKey) {
        this.show(hits, key)
      }
      return
    }

    if (key === this.pendingKey) {
      return // Still resting on the same highlight
    }

    this.cancelShow()
    this.pendingKey = key
    this.pendingHits = hits
    this.showTimer = setTimeout(() => {
      this.showTimer = undefined
      const pendingKey = this.pendingKey
      const pendingHits = this.pendingHits
      this.pendingKey = null
      this.pendingHits = []
      if (pendingKey !== null) {
        this.show(pendingHits, pendingKey)
      }
    }, PDF_BACKLINK_HOVER_DELAY_MS)
  }

  /**
   * Reports that the mouse has left the pages
   */
  leave (): void {
    this.cancelShow()
    this.scheduleHide()
  }

  /**
   * Hides the popup at once and drops a pending one, e.g. on scrolling, on a
   * double click or when the highlights are switched off
   */
  hide (): void {
    this.cancelShow()
    this.cancelHide()
    this.pointerInPopup = false
    this.shownKey = null
    this.instance?.hide()
  }

  /**
   * Hides the popup and removes the tippy instance
   */
  destroy (): void {
    this.hide()
    this.instance?.destroy()
    this.instance = null
  }

  private show (hits: PdfBacklinkHit[], key: string): void {
    const instance = this.ensureInstance()
    const ownerDocument = this.options.reference.ownerDocument
    ensurePopupStyles(ownerDocument)

    const content = createBacklinkPopupContent(buildBacklinkPopupItems(hits), ownerDocument, hit => {
      this.hide()
      this.options.onOpen(hit)
    })

    const { x, y } = this.point
    instance.setProps({
      getReferenceClientRect: () => ({
        x, y, left: x, right: x, top: y, bottom: y, width: 0, height: 0, toJSON: () => ({})
      }) as DOMRect
    })
    instance.setContent(content)
    this.shownKey = key

    if (instance.state.isMounted) {
      limitPopupListHeight(instance.popper)
      instance.popperInstance?.update().catch((error: unknown) => console.error(error))
    } else {
      instance.show()
    }
  }

  private ensureInstance (): Instance {
    if (this.instance !== null) {
      return this.instance
    }

    const ownerDocument = this.options.reference.ownerDocument
    const instance = tippy(this.options.reference, {
      trigger: 'manual',
      interactive: true,
      appendTo: () => ownerDocument.body,
      placement: 'bottom-start',
      // Close to the mouse, so that it can reach the popup before it hides
      offset: [ 0, 6 ],
      maxWidth: 440,
      arrow: false,
      hideOnClick: true,
      duration: [ 100, 100 ],
      onMount: (mounted) => {
        limitPopupListHeight(mounted.popper)
        mounted.popperInstance?.update().catch((error: unknown) => console.error(error))
      },
      onHide: () => {
        // Also reached when tippy hides the popup by itself (click outside)
        this.shownKey = null
        this.pointerInPopup = false
      }
    })

    instance.popper.addEventListener('mouseenter', () => {
      this.pointerInPopup = true
      this.cancelHide()
    })
    instance.popper.addEventListener('mouseleave', () => {
      this.pointerInPopup = false
      this.scheduleHide()
    })

    this.instance = instance
    return instance
  }

  private scheduleHide (): void {
    if (this.shownKey === null || this.pointerInPopup || this.hideTimer !== undefined) {
      return
    }

    this.hideTimer = setTimeout(() => {
      this.hideTimer = undefined
      if (!this.pointerInPopup) {
        this.hide()
      }
    }, PDF_BACKLINK_POPUP_HIDE_DELAY_MS)
  }

  private cancelShow (): void {
    clearTimeout(this.showTimer)
    this.showTimer = undefined
    this.pendingKey = null
    this.pendingHits = []
  }

  private cancelHide (): void {
    clearTimeout(this.hideTimer)
    this.hideTimer = undefined
  }
}
