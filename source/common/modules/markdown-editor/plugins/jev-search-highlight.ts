/**
 * @ignore
 * BEGIN HEADER
 * Contains:        JEV search highlight
 * CVM-Role:        Extension
 * License:         GNU GPL v3
 * Description:     Shades the rendered rows touched by a JEV hit. A private
 *                  state field maps the hit through edits; a view plugin
 *                  measures text and paints equal-width rows behind it.
 * END HEADER
 */

import { EditorSelection, StateEffect, StateField, type Text } from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'

interface HighlightRange { from: number, to: number }
interface VisualRow { top: number, bottom: number }
interface HighlightMeasure { left: number, width: number, rows: VisualRow[] }

const setJevSearchHighlightEffect = StateEffect.define<HighlightRange|null>()

/** Retained for the JSON viewer and other callers needing source lines. */
export function jevHighlightLineRange (doc: Text, from: number, to: number): { firstLine: number, lastLine: number }|undefined {
  const start = Math.max(0, Math.min(doc.length, from))
  const end = Math.max(0, Math.min(doc.length, to))
  if (start >= end) {
    return undefined
  }

  const startLine = doc.lineAt(start)
  let firstLine = startLine.number
  if (start === startLine.to && firstLine < doc.lines) {
    firstLine++
  }

  const endLine = doc.lineAt(end)
  let lastLine = endLine.number
  if (end === endLine.from && lastLine > 1) {
    lastLine--
  }

  return firstLine > lastLine ? undefined : { firstLine, lastLine }
}

const jevSearchHighlightField = StateField.define<HighlightRange|null>({
  create () { return null },
  update (range, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setJevSearchHighlightEffect)) {
        return effect.value
      }
    }
    return range === null ? null : {
      from: transaction.changes.mapPos(range.from, -1),
      to: transaction.changes.mapPos(range.to, 1)
    }
  }
})

/** Group text rectangles by row, then fill normal line-height leading. */
export function jevHighlightVisualRows (rectangles: readonly VisualRow[], lineHeight: number): VisualRow[] {
  const rows: VisualRow[] = []
  for (const rectangle of [...rectangles].sort((first, second) => first.top - second.top)) {
    const previous = rows[rows.length - 1]
    if (previous !== undefined && rectangle.top < previous.bottom - 1 && rectangle.bottom > previous.top + 1 && Math.abs((rectangle.top + rectangle.bottom - previous.top - previous.bottom) / 2) < Math.max(lineHeight, rectangle.bottom - rectangle.top, previous.bottom - previous.top) / 2) {
      previous.top = Math.min(previous.top, rectangle.top)
      previous.bottom = Math.max(previous.bottom, rectangle.bottom)
    } else {
      rows.push({ top: rectangle.top, bottom: rectangle.bottom })
    }
  }
  for (const row of rows) {
    const leading = Math.max(0, lineHeight - (row.bottom - row.top)) / 2
    row.top -= leading
    row.bottom += leading
  }
  for (let index = 1; index < rows.length; index++) {
    const previous = rows[index - 1]
    const current = rows[index]
    const previousCentre = (previous.top + previous.bottom) / 2
    const currentCentre = (current.top + current.bottom) / 2
    const rowHeight = Math.max(lineHeight, previous.bottom - previous.top, current.bottom - current.top)
    if (currentCentre - previousCentre <= rowHeight * 1.5 && current.top - previous.bottom <= rowHeight * 0.3) {
      const boundary = (previous.bottom + current.top) / 2
      previous.bottom = boundary
      current.top = boundary
    }
  }
  return rows
}

class JevSearchHighlightView {
  private readonly layer: HTMLDivElement
  private readonly resizeObserver: ResizeObserver|undefined
  private readonly measureRequest = {
    read: (view: EditorView) => this.measure(view),
    write: (measurement: HighlightMeasure, view: EditorView) => this.paint(measurement, view),
    key: this
  }

  constructor (private readonly view: EditorView) {
    this.layer = view.dom.ownerDocument.createElement('div')
    this.layer.className = 'cm-jev-search-highlight-layer'
    view.scrollDOM.appendChild(this.layer)
    view.scrollDOM.addEventListener('scroll', this.schedule, { passive: true })
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(this.schedule)
      this.resizeObserver.observe(view.contentDOM)
      this.resizeObserver.observe(view.scrollDOM)
    }
    this.schedule()
  }

  update (update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged || update.geometryChanged || update.transactions.some(transaction => transaction.effects.some(effect => effect.is(setJevSearchHighlightEffect)))) {
      this.schedule()
    }
  }

  private readonly schedule = (): void => { this.view.requestMeasure(this.measureRequest) }

  private measure (view: EditorView): HighlightMeasure {
    const contentBounds = view.contentDOM.getBoundingClientRect()
    const scrollBounds = view.scrollDOM.getBoundingClientRect()
    const measurement: HighlightMeasure = {
      left: (contentBounds.left - scrollBounds.left) / view.scaleX + view.scrollDOM.scrollLeft,
      width: contentBounds.width / view.scaleX,
      rows: []
    }
    const highlight = view.state.field(jevSearchHighlightField)
    if (highlight === null || highlight.from >= highlight.to) {
      return measurement
    }

    const rectangles: VisualRow[] = []
    for (const visibleRange of view.visibleRanges) {
      const from = Math.max(highlight.from, visibleRange.from)
      const to = Math.min(highlight.to, visibleRange.to)
      if (from >= to) {
        continue
      }
      const start = view.domAtPos(from)
      const end = view.domAtPos(to)
      const domRange = view.dom.ownerDocument.createRange()
      domRange.setStart(start.node, start.offset)
      domRange.setEnd(end.node, end.offset)
      const walker = view.dom.ownerDocument.createTreeWalker(view.contentDOM, NodeFilter.SHOW_TEXT)
      let node = walker.nextNode()
      while (node !== null) {
        const parent = node.parentElement
        const readOnlyElement = parent?.closest('[contenteditable="false"]')
        if (parent?.closest('.cm-line') !== null && (readOnlyElement === null || readOnlyElement === view.contentDOM) && domRange.intersectsNode(node)) {
          const textRange = view.dom.ownerDocument.createRange()
          textRange.setStart(node, node === start.node ? start.offset : 0)
          textRange.setEnd(node, node === end.node ? end.offset : node.textContent?.length ?? 0)
          for (const rectangle of textRange.getClientRects()) {
            if (rectangle.width >= view.scaleX && rectangle.height >= view.scaleY && rectangle.right >= contentBounds.left && rectangle.left <= contentBounds.right) {
              rectangles.push({ top: (rectangle.top - scrollBounds.top) / view.scaleY + view.scrollDOM.scrollTop, bottom: (rectangle.bottom - scrollBounds.top) / view.scaleY + view.scrollDOM.scrollTop })
            }
          }
        }
        node = walker.nextNode()
      }
    }
    measurement.rows = jevHighlightVisualRows(rectangles, view.defaultLineHeight)
    return measurement
  }

  private paint (measurement: HighlightMeasure, view: EditorView): void {
    this.layer.style.left = `${measurement.left}px`
    this.layer.style.width = `${measurement.width}px`
    this.layer.replaceChildren(...measurement.rows.map(row => {
      const element = view.dom.ownerDocument.createElement('div')
      element.className = 'cm-jev-search-highlight-row'
      element.style.top = `${row.top}px`
      element.style.height = `${row.bottom - row.top}px`
      return element
    }))
  }

  destroy (): void {
    this.view.scrollDOM.removeEventListener('scroll', this.schedule)
    this.resizeObserver?.disconnect()
    this.layer.remove()
  }
}

const jevSearchHighlightPlugin = ViewPlugin.fromClass(JevSearchHighlightView)
const jevSearchHighlightTheme = EditorView.baseTheme({
  '.cm-content': { position: 'relative', zIndex: '1' },
  '.cm-jev-search-highlight-layer': { position: 'absolute', top: '0', height: '0', zIndex: '0', pointerEvents: 'none' },
  '.cm-jev-search-highlight-row': {
    position: 'absolute', left: '0', width: '100%',
    backgroundColor: 'rgb(246, 246, 240)', boxShadow: 'inset 3px 0 0 rgb(224, 160, 0)'
  },
  '&dark .cm-jev-search-highlight-row': { backgroundColor: 'rgba(255, 255, 240, 0.07)' }
})

/** Highlight a JEV hit, scrolling its start to the centre unless disabled. */
export function showJevSearchHighlight (view: EditorView, from: number, to: number, scroll: boolean = true): void {
  const length = view.state.doc.length
  const start = Math.max(0, Math.min(length, from))
  const end = Math.max(start, Math.min(length, to))
  // A field added by appendConfig starts with its create value. Dispatch the
  // actual hit after the field exists, so the first hit is not discarded.
  if (view.state.field(jevSearchHighlightField, false) === undefined) {
    view.dispatch({ effects: StateEffect.appendConfig.of([ jevSearchHighlightField, jevSearchHighlightPlugin, jevSearchHighlightTheme ]) })
  }
  const effects: Array<StateEffect<unknown>> = [setJevSearchHighlightEffect.of({ from: start, to: end })]
  if (scroll) {
    effects.push(EditorView.scrollIntoView(EditorSelection.range(end, start), { y: 'center' }))
  }
  view.dispatch({ effects })
}

/** Remove the JEV hit from this editor, if present. */
export function clearJevSearchHighlight (view: EditorView): void {
  const highlight = view.state.field(jevSearchHighlightField, false)
  if (highlight !== null && highlight !== undefined) {
    view.dispatch({ effects: setJevSearchHighlightEffect.of(null) })
  }
}
