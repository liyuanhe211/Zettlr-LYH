/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Pandoc PPTX preview heading pins
 * CVM-Role:        CodeMirror Plugin
 * License:         GNU GPL v3
 *
 * Description:     Adds a pin button to the left of every level-one heading.
 *                  Clicking it asks the pandoc PPTX preview pane next to the
 *                  editor to scroll the page containing that heading to the
 *                  top of the preview (a one-off alignment, not a lock). The
 *                  editor knows nothing about the preview: the pin merely
 *                  dispatches a bubbling PPTX_EDITOR_PIN_EVENT DOM event from
 *                  the editor element, which the preview pane of the same
 *                  editor pane picks up.
 *
 *                  The pin gutter is hidden by default. The preview pane's
 *                  stylesheet reveals it only inside an editor pane that
 *                  currently contains an open preview, so the pins appear
 *                  exactly while the document's PPTX preview is shown,
 *                  without the editor having to track the preview's state.
 *
 * END HEADER
 */

import { type Extension } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { EditorView, gutter, GutterMarker } from '@codemirror/view'
import { configField } from '../util/configuration'
import { PPTX_EDITOR_PIN_EVENT, type PptxEditorPinDetail } from '@common/util/pptx-preview-link'

/**
 * A push pin, drawn in the current text colour
 */
const PIN_ICON_SVG = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">' +
  '<path fill="currentColor" d="M10.1 1.2a.8.8 0 0 1 1.1 0l3.6 3.6a.8.8 0 0 1 0 1.1l-.6.6a.8.8 0 0 1-.9.2l-2.4 2.4.3 2.3a.8.8 0 0 1-.2.7l-.8.8a.5.5 0 0 1-.7 0L6.8 9.2l-4 4a.5.5 0 0 1-.7-.7l4-4-3.7-3.7a.5.5 0 0 1 0-.7l.8-.8a.8.8 0 0 1 .7-.2l2.3.3 2.4-2.4a.8.8 0 0 1 .2-.9z"/>' +
  '</svg>'

/**
 * Class of the pin gutter; the preview pane's stylesheet refers to it
 */
export const PPTX_PIN_GUTTER_CLASS = 'cm-pptx-pin-gutter'

class PptxPinMarker extends GutterMarker {
  eq (other: GutterMarker): boolean {
    return other instanceof PptxPinMarker
  }

  toDOM (): Node {
    const pin = document.createElement('div')
    pin.className = 'cm-pptx-pin-marker'
    pin.title = 'Scroll the PPTX preview to this page'
    pin.setAttribute('role', 'button')
    pin.setAttribute('aria-label', 'Scroll the PPTX preview to this page')
    pin.innerHTML = PIN_ICON_SVG
    return pin
  }
}

const pinMarker = new PptxPinMarker()

/**
 * Whether the line starting at the given position is a level-one ATX heading
 */
function isLevelOneHeadingAt (view: EditorView, lineStart: number): boolean {
  const node = syntaxTree(view.state).resolve(lineStart, 1)
  return node.name === 'HeaderMark' && node.parent?.name === 'ATXHeading1'
}

function isPinTarget (event: Event): boolean {
  return event.target instanceof Element && event.target.closest('.cm-pptx-pin-marker') !== null
}

export const pptxPreviewPins: Extension[] = [
  gutter({
    class: PPTX_PIN_GUTTER_CLASS,
    renderEmptyElements: false,
    initialSpacer: () => pinMarker,
    lineMarker (view, line) {
      return isLevelOneHeadingAt(view, line.from) ? pinMarker : null
    },
    // Headings can appear once the background parser catches up, without the
    // document or the viewport changing
    lineMarkerChange: update => syntaxTree(update.startState) !== syntaxTree(update.state),
    domEventHandlers: {
      mousedown (_view, _line, event) {
        if (!isPinTarget(event)) {
          return false
        }
        // Keep the editor's focus and selection where they are
        event.preventDefault()
        return true
      },
      click (view, line, event) {
        if (!isPinTarget(event) || !isLevelOneHeadingAt(view, line.from)) {
          return false
        }

        const detail: PptxEditorPinDetail = {
          filePath: view.state.field(configField, false)?.metadata.path ?? '',
          line: view.state.doc.lineAt(line.from).number - 1
        }
        view.dom.dispatchEvent(new CustomEvent<PptxEditorPinDetail>(PPTX_EDITOR_PIN_EVENT, { bubbles: true, detail }))
        return true
      }
    }
  }),
  EditorView.baseTheme({
    // CodeMirror declares every gutter `display: flex !important`, so hiding
    // needs the same weight. The preview pane's stylesheet overrides this
    // with a more specific selector while a preview is open.
    [`.cm-gutter.${PPTX_PIN_GUTTER_CLASS}`]: {
      display: 'none !important'
    },
    [`.${PPTX_PIN_GUTTER_CLASS} .cm-gutterElement`]: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '0 3px'
    },
    '.cm-pptx-pin-marker': {
      display: 'flex',
      cursor: 'pointer',
      color: '#3b78d1',
      opacity: '0.45'
    },
    '.cm-pptx-pin-marker:hover': {
      opacity: '1'
    }
  })
]
