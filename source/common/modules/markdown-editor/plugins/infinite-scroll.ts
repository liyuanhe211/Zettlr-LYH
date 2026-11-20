/**
 * View-only space after Markdown documents. Scrolling grows one padding value;
 * only a primary-button press in that space inserts real document lines.
 */

import { isolateHistory } from '@codemirror/commands'
import { Annotation, EditorSelection, Prec, Text, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { configField } from '../util/configuration'

const SPACE_PROPERTY = '--zettlr-infinite-scroll-space'
const virtualLineInsertion = Annotation.define<boolean>()

/** Compute padding without letting the current padding feed back into it. */
export function computeVirtualScrollPadding (
  documentBottom: number,
  requestedBottom: number,
  viewportHeight: number
): number {
  if (![ documentBottom, requestedBottom, viewportHeight ].every(Number.isFinite) || viewportHeight <= 0) {
    return 0
  }
  return Math.ceil(Math.max(viewportHeight, requestedBottom - documentBottom))
}

/**
 * The first virtual row starts at the bottom of the last real visual row.
 * Existing trailing blank lines already belong to that real document.
 * All three arguments use the same (possibly scaled) coordinate system.
 */
export function computeVirtualLineCount (clickY: number, documentBottom: number, lineHeight: number): number {
  if (![ clickY, documentBottom, lineHeight ].every(Number.isFinite) || lineHeight <= 0 || clickY <= documentBottom) {
    return 0
  }
  return Math.floor((clickY - documentBottom) / lineHeight) + 1
}

const activeScrollers = new WeakMap<EditorView, InfiniteScroller>()

class InfiniteScroller {
  private requestedBottom = 0
  private appliedPadding = 0
  private destroyed = false
  private documentPath: string|undefined
  public preserveClickScroll = false

  private readonly handleScroll = (): void => {
    // Only a scroll event advances this frontier. A layout update alone must
    // never ask for another screen, or measurement would grow without end.
    this.requestedBottom = Math.max(
      this.requestedBottom,
      this.view.scrollDOM.scrollTop + this.view.scrollDOM.clientHeight * 2
    )
    this.view.requestMeasure(this.measureRequest)
  }

  private readonly measureRequest = {
    key: this,
    read: (view: EditorView): number => {
      if (this.destroyed || !this.isEditable() || view.scrollDOM.clientHeight <= 0) {
        return 0
      }
      const scroller = view.scrollDOM
      const scale = view.scaleY
      if (!Number.isFinite(scale) || scale <= 0) {
        return 0
      }
      const viewportHeight = scroller.clientHeight
      if (this.requestedBottom === 0) {
        this.requestedBottom = viewportHeight * 2
      }
      // CodeMirror's block geometry includes wrapping and block widgets, and
      // excludes content padding. It cannot feed our own padding back in.
      const realBottom = view.documentTop + view.lineBlockAt(view.state.doc.length).bottom
      const viewportTop = scroller.getBoundingClientRect().top + scroller.clientTop * scale
      const documentBottom = (realBottom - viewportTop) / scale + scroller.scrollTop
      return computeVirtualScrollPadding(documentBottom, this.requestedBottom, viewportHeight)
    },
    write: (padding: number): void => {
      if (this.destroyed || padding === this.appliedPadding) {
        return
      }
      this.appliedPadding = padding
      if (padding === 0) {
        this.view.scrollDOM.style.removeProperty(SPACE_PROPERTY)
      } else {
        this.view.scrollDOM.style.setProperty(SPACE_PROPERTY, `${padding}px`)
      }
      // Re-measure changed content padding once. The next pass has the same
      // frontier and last real block, so it makes no further layout write.
      this.view.requestMeasure()
    }
  }

  private readonly handleMouseDown = (event: MouseEvent): void => {
    const view = this.view
    const scroller = view.scrollDOM
    if (event.defaultPrevented || event.button !== 0 || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || !this.isEditable()) {
      return
    }
    // Descendants are real lines or interactive widgets. In particular, never
    // steal presses on images, table cells, links, gutters or nested editors.
    if (event.target !== scroller && event.target !== view.contentDOM) {
      return
    }
    const scrollRect = scroller.getBoundingClientRect()
    const contentRect = view.contentDOM.getBoundingClientRect()
    const viewportLeft = scrollRect.left + scroller.clientLeft * view.scaleX
    const viewportTop = scrollRect.top + scroller.clientTop * view.scaleY
    if (event.clientX < Math.max(contentRect.left, viewportLeft) ||
        event.clientX >= Math.min(contentRect.right, viewportLeft + scroller.clientWidth * view.scaleX) ||
        event.clientY < viewportTop || event.clientY >= viewportTop + scroller.clientHeight * view.scaleY) {
      return
    }
    // DOM events run outside view updates. No coordinate-to-position scan is
    // necessary, even when the final block is a rendered image or table.
    const documentBottom = view.documentTop + view.lineBlockAt(view.state.doc.length).bottom
    const contentStyle = view.dom.ownerDocument.defaultView?.getComputedStyle(view.contentDOM)
    const plainLineHeight = parseFloat(contentStyle?.lineHeight ?? '') * view.scaleY
    // A short document consisting only of a heading can make CodeMirror's
    // defaultLineHeight estimate inherit the heading's larger font. New empty
    // paragraphs use the content's computed line-height instead.
    const lineHeight = Number.isFinite(plainLineHeight) && plainLineHeight > 0 ? plainLineHeight : view.defaultLineHeight
    const lineCount = computeVirtualLineCount(event.clientY, documentBottom, lineHeight)
    if (lineCount === 0) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    const end = view.state.doc.length
    // Text.of uses CodeMirror's logical line breaks, independent of the file's
    // configured line separator. The authority/save pipeline handles encoding.
    const insert = Text.of(Array<string>(lineCount + 1).fill(''))
    const insertion = view.state.update({
      changes: { from: end, insert },
      selection: EditorSelection.cursor(end + insert.length),
      // Appending leaves the original anchor's offset valid, including when
      // it was the old document end. Do not map it past the inserted lines.
      effects: view.scrollSnapshot(),
      annotations: [ virtualLineInsertion.of(true), isolateHistory.of('full') ],
      userEvent: 'input.addLines',
      scrollIntoView: false
    })
    // History normally derives redo's selection by mapping the selection from
    // before an edit. A click can append far away from that old selection.
    // Recording the resulting selection on the same history event makes redo
    // restore the clicked row instead. This selection-only transaction adds
    // no document undo step, and both transactions share one view update.
    const rememberSelection = insertion.state.update({
      selection: insertion.state.selection,
      userEvent: 'select.pointer'
    })
    view.dispatch([ insertion, rememberSelection ])
    view.focus() // CodeMirror focuses with preventScroll.
  }

  constructor (private readonly view: EditorView) {
    this.documentPath = view.state.field(configField, false)?.metadata.path
    // A replacement state belongs to a newly loaded document. Its initial
    // layout must not inherit the previous document's temporary empty space.
    view.scrollDOM.style.removeProperty(SPACE_PROPERTY)
    activeScrollers.set(view, this)
    view.scrollDOM.addEventListener('scroll', this.handleScroll, { passive: true })
    // Capture before CodeMirror's mousedown selection and source-reveal freeze.
    view.scrollDOM.addEventListener('mousedown', this.handleMouseDown, true)
    view.requestMeasure(this.measureRequest)
  }

  private isEditable (): boolean {
    return !this.view.state.readOnly && this.view.state.facet(EditorView.editable)
  }

  update (update: ViewUpdate): void {
    this.preserveClickScroll = update.transactions.some(transaction => transaction.annotation(virtualLineInsertion) === true)
    const path = update.state.field(configField, false)?.metadata.path
    if (path !== this.documentPath) {
      this.documentPath = path
      this.requestedBottom = 0
      this.appliedPadding = 0
      this.view.scrollDOM.style.removeProperty(SPACE_PROPERTY)
    }
    if (update.docChanged || update.geometryChanged || update.transactions.length > 0) {
      this.view.requestMeasure(this.measureRequest)
    }
  }

  destroy (): void {
    this.destroyed = true
    this.view.scrollDOM.removeEventListener('scroll', this.handleScroll)
    this.view.scrollDOM.removeEventListener('mousedown', this.handleMouseDown, true)
    if (activeScrollers.get(this.view) === this) {
      activeScrollers.delete(this.view)
      this.view.scrollDOM.style.removeProperty(SPACE_PROPERTY)
    }
  }
}

export const infiniteScrollPlugin = ViewPlugin.fromClass(InfiniteScroller)

export const infiniteScroll: Extension = [
  infiniteScrollPlugin,
  EditorView.theme({
    '& > .cm-scroller > .cm-content': {
      paddingBottom: `var(${SPACE_PROPERTY}, 4px)`
    }
  }),
  // Typewriter mode may request centering after any edit. A virtual-row click
  // already chose its visible destination and must keep that viewport.
  Prec.highest(EditorView.scrollHandler.of(view => view.plugin(infiniteScrollPlugin)?.preserveClickScroll === true))
]
