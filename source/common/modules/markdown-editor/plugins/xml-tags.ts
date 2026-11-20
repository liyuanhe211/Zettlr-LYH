import { syntaxTree } from '@codemirror/language'
import { isolateHistory } from '@codemirror/commands'
import type { EditorState } from '@codemirror/state'
import { EditorSelection, Prec, StateEffect, StateField, Transaction, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { configField } from '../util/configuration'
import { findXmlTagPairs, wholeLineSelection, xmlSelectionContainsCode, xmlWrapChanges, type XmlTagPair } from '../util/xml-tags'
import { openXmlTagDialog, type XmlTagDialog } from './xml-tag-dialog'

const toggleXmlFold = StateEffect.define<number>()
interface XmlDisplayState { pairs: XmlTagPair[], folded: XmlTagPair[], decorations: DecorationSet }

function rawMode (state: EditorState): boolean {
  return state.field(configField, false)?.renderingMode === 'raw'
}

class FoldedXmlContent extends WidgetType {
  toDOM (view: EditorView): HTMLElement {
    const element = view.dom.ownerDocument.createElement('span')
    element.className = 'cm-xml-folded-content'
    element.textContent = ' … '
    element.title = 'XML content folded; click either tag to expand'
    return element
  }
}

function decorationsFor (state: EditorState, pairs: XmlTagPair[], folded: XmlTagPair[]): DecorationSet {
  if (rawMode(state)) {return Decoration.none}
  const ranges: Array<Range<Decoration>> = []
  const outerFolds: XmlTagPair[] = []
  for (const pair of pairs) {
    const collapsed = folded.includes(pair)
    for (const tag of [ pair.open, pair.close ]) {
      ranges.push(Decoration.mark({
        class: 'cm-xml-tag-highlight' + (pair.foldable ? ' cm-xml-tag-control' : '') + (collapsed ? ' cm-xml-tag-collapsed' : ''),
        attributes: pair.foldable ? {
          'data-xml-open': String(pair.open.from),
          title: collapsed ? 'Expand XML content' : 'Fold XML content',
          'aria-label': `${collapsed ? 'Expand' : 'Fold'} ${pair.open.name} XML content`
        } : { title: 'XML tag' }
      }).range(tag.from, tag.to))
    }
    if (collapsed && !outerFolds.some(outer => outer.contentFrom <= pair.open.from && outer.contentTo >= pair.close.to)) {
      outerFolds.push(pair)
      ranges.push(Decoration.replace({ widget: new FoldedXmlContent() }).range(pair.contentFrom, pair.contentTo))
    }
  }
  return Decoration.set(ranges, true)
}

const xmlDisplayField = StateField.define<XmlDisplayState>({
  create (state) {
    const pairs = findXmlTagPairs(state)
    return { pairs, folded: [], decorations: decorationsFor(state, pairs, []) }
  },
  update (value, transaction) {
    const state = transaction.state
    if (!transaction.docChanged && transaction.effects.length === 0 &&
      syntaxTree(transaction.startState) === syntaxTree(state) &&
      transaction.startState.field(configField, false) === state.field(configField, false)) {return value}
    const previousPath = transaction.startState.field(configField, false)?.metadata.path
    const currentPath = state.field(configField, false)?.metadata.path
    const pairs = findXmlTagPairs(state)
    let folded = previousPath !== currentPath ? [] : value.folded.flatMap(previous => {
      const openFrom = transaction.changes.mapPos(previous.open.from, 1)
      const closeFrom = transaction.changes.mapPos(previous.close.from, 1)
      const pair = pairs.find(pair => pair.foldable && pair.open.from === openFrom && pair.close.from === closeFrom &&
        state.sliceDoc(pair.open.from, pair.open.to) === transaction.startState.sliceDoc(previous.open.from, previous.open.to) &&
        state.sliceDoc(pair.close.from, pair.close.to) === transaction.startState.sliceDoc(previous.close.from, previous.close.to))
      return pair === undefined ? [] : [pair]
    })
    for (const effect of transaction.effects) {
      if (!effect.is(toggleXmlFold) || rawMode(state)) {continue}
      const pair = pairs.find(pair => pair.foldable && pair.open.from === effect.value)
      if (pair !== undefined) {folded = folded.includes(pair) ? folded.filter(current => current !== pair) : [ ...folded, pair ]}
    }
    return { pairs, folded, decorations: decorationsFor(state, pairs, folded) }
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations)
})

class XmlTagInteractions {
  private dialog: XmlTagDialog|undefined
  private destroyed = false
  private pointer: { from: number, x: number, y: number }|undefined

  constructor (private readonly view: EditorView) {}

  update (update: ViewUpdate): void {
    if (this.dialog !== undefined && (update.docChanged || update.selectionSet || update.startState.field(configField, false) !== update.state.field(configField, false))) {
      this.dialog.close()
    }
    if (update.docChanged) {this.pointer = undefined}
  }

  destroy (): void {
    this.destroyed = true
    this.dialog?.close()
    this.pointer = undefined
  }

  requestTag (): void {
    if (this.dialog !== undefined) {return}
    const state = this.view.state
    const selection = state.selection
    const range = wholeLineSelection(state)
    if (range === null) {return}
    this.dialog = openXmlTagDialog(this.view.dom, name => {
      this.dialog = undefined
      if (this.destroyed) {return}
      // No optimistic edits or stale coordinates: even a remote change cancels.
      const current = this.view.state
      if (current.doc !== state.doc || !current.selection.eq(selection) || current.readOnly || current.field(configField, false)?.metadata.path !== state.field(configField, false)?.metadata.path) {return}
      if (name !== null) {
        const openingLength = name.length + 3
        this.view.dispatch({
          changes: xmlWrapChanges(current, range, name),
          selection: EditorSelection.range(selection.main.anchor + openingLength, selection.main.head + openingLength),
          annotations: [ Transaction.userEvent.of('input.xmlTag'), isolateHistory.of('full') ]
        })
      }
      this.view.focus()
    })
  }

  pointerDown (event: MouseEvent): boolean {
    this.pointer = undefined
    const from = this.control(event)
    if (from !== null) {this.pointer = { from, x: event.clientX, y: event.clientY }}
    return false // Let normal cursor placement and dragging continue.
  }

  pointerUp (event: MouseEvent): boolean {
    const pointer = this.pointer
    this.pointer = undefined
    const from = this.control(event)
    if (pointer === undefined || from !== pointer.from || Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 4 || event.detail > 1) {return false}
    this.view.dispatch({ effects: toggleXmlFold.of(pointer.from) })
    return true
  }

  private control (event: MouseEvent): number|null {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || rawMode(this.view.state)) {return null}
    const element = event.target instanceof Element ? event.target.closest('.cm-xml-tag-control') : null
    if (!(element instanceof HTMLElement) || !this.view.contentDOM.contains(element)) {return null}
    const from = Number(element.dataset.xmlOpen)
    return Number.isFinite(from) ? from : null
  }
}

const interactions = ViewPlugin.fromClass(XmlTagInteractions, {
  eventHandlers: {
    beforeinput (event, view) {
      if (event.inputType !== 'insertText' || event.data !== '<' || event.isComposing || !canWrapSelection(view)) {return false}
      event.preventDefault()
      this.requestTag()
      return true
    },
    mousedown (event) { return this.pointerDown(event) },
    mouseup (event) { return this.pointerUp(event) }
  }
})

function canWrapSelection (view: EditorView): boolean {
  if (view.composing || view.state.readOnly) {return false}
  const range = wholeLineSelection(view.state)
  return range !== null && !xmlSelectionContainsCode(view.state, range)
}

export const xmlTagsExtension: Extension = [
  xmlDisplayField,
  Prec.highest(interactions),
  Prec.highest(EditorView.inputHandler.of((view, from, to, text) => {
    if (text !== '<' || view.composing || view.state.readOnly) {return false}
    const range = wholeLineSelection(view.state)
    if (range === null || range.from !== from || range.to !== to || xmlSelectionContainsCode(view.state, range)) {return false}
    const plugin = view.plugin(interactions)
    if (plugin === null) {return false}
    plugin.requestTag()
    return true
  })),
  EditorView.baseTheme({
    '.cm-xml-tag-highlight': {
      // Same gray as comments, so the tags recede behind the content they wrap
      color: 'var(--zettlr-editor-code-base-00)',
      backgroundColor: 'rgba(128, 128, 128, 0.12)',
      borderRadius: '3px'
    },
    '.cm-xml-tag-control': {
      cursor: 'pointer',
      '&::after': { content: '" ▾"', opacity: '0.7' }
    },
    '.cm-xml-tag-collapsed::after': { content: '" ▸"' },
    '.cm-xml-folded-content': { opacity: '0.7' },
    '.cm-xml-tag-dialog': {
      color: 'inherit', backgroundColor: 'var(--zettlr-background-color, Canvas)',
      border: '1px solid currentColor', borderRadius: '6px', padding: '20px',
      width: 'min(420px, 80vw)', maxWidth: '80vw',
      '&::backdrop': { backgroundColor: 'rgba(0, 0, 0, 0.35)' },
      '& h2': { margin: '0 0 16px', fontSize: '1.2em' },
      '& label': { display: 'block' },
      '& input': { display: 'block', boxSizing: 'border-box', width: '100%', marginTop: '6px', padding: '7px', color: 'inherit', backgroundColor: 'transparent', border: '1px solid currentColor' },
      '& button': { padding: '6px 12px', font: 'inherit' },
      '& .cm-xml-tag-preview': { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', minHeight: '2em' },
      '& .cm-xml-tag-actions': { display: 'flex', justifyContent: 'flex-end', gap: '10px' }
    }
  })
]
