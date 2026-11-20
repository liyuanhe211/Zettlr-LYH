/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Copy, Paste, and Cut actions
 * CVM-Role:        Utility Functions
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Contains a set of utility functions that can be utilitzed
 *                  for copying, cutting, and pasting Markdown and HTML
 *
 * END HEADER
 */

import { type ChangeSpec } from '@codemirror/state'
import { type EditorView } from '@codemirror/view'
import { md2html } from '@common/modules/markdown-utils'
import { configField } from './configuration'
import { markdownVisibleCopyText } from '../plugins/markdown-visible-copy'
import { revisionCopyText } from '../renderers/render-revisions'
import { cancelMarkdownImageCopy, copyMarkdownImage } from '../plugins/markdown-image-copy'

const ipcRenderer = window.ipc

/**
 * Copies whatever is currently selected into the clipboard as HTML (with plain
 * text fallback)
 *
 * @param   {EditorView}  view  The view
 */
export function copyAsHTML (view: EditorView): void {
  cancelMarkdownImageCopy(view)
  const { library } = view.state.field(configField).metadata
  const selections: string[] = []

  for (const { from, to } of view.state.selection.ranges) {
    selections.push(view.state.sliceDoc(from, to))
  }

  const { zknLinkFormat } = view.state.field(configField)

  const plainText = selections.join('\n')
  md2html(plainText, { onCitation: window.getCitationCallback(library), zknLinkFormat })
    .then(html => {
      navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([plainText], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' })
        })
      ]).catch(err => console.error(err))
    })
    .catch(err => console.error(err))

}

/**
 * Copies visible content of one enabled hidden Markdown object, otherwise source.
 *
 * @param   {EditorView}  view  The view
 */
export function copyAsPlain (view: EditorView): void {
  if (copyMarkdownImage(view)) {
    return
  }
  writePlainClipboard(markdownVisibleCopyText(view.state))
}

function writePlainClipboard (text: string): void {
  navigator.clipboard.write([
    new ClipboardItem({
      'text/plain': new Blob([text], { type: 'text/plain' })
    })
  ])
    .catch(err => console.error(err))
}

/**
 * Cuts the text which is currently selected. Can write the text to clipboard as
 * either plain text or HTML
 *
 * @param   {EditorView}  view    The view
 * @param   {boolean}     asHTML  Optional, if set to true copies as HTML
 */
export function cut (view: EditorView, asHTML?: boolean): void {
  // Cut is basically just copy + delete
  if (asHTML === true) {
    copyAsHTML(view)
  } else {
    // Zettlr-LYH (R84): with Show Revisions off, the text with every tracked
    // change accepted (spec C10, "Copy"); with Show Revisions on, the visible
    // text of tracked changes the selection cuts through (Decision 107)
    writePlainClipboard(revisionCopyText(view.state) ??
      view.state.selection.ranges.map(range => view.state.sliceDoc(range.from, range.to)).join('\n'))
  }

  const changes: ChangeSpec[] = []
  for (const { from, to } of view.state.selection.ranges) {
    changes.push({ from, to, insert: '' })
  }

  // The user event lets Track Changes record the cut as a deletion (R84)
  view.dispatch({ changes, userEvent: 'delete.cut' })
}

/**
 * Pastes whatever is in the clipboard as plain text, converting potential HTML
 * to Markdown if applicable
 *
 * @param   {EditorView}  view  The view
 */
export function paste (view: EditorView): void {
  // The web Clipboard API exposes image previews but loses native copied-file
  // identity (notably Windows CF_HDROP). Ask this window to perform a native
  // paste instead, so keyboard, Edit and context-menu Paste share the same
  // ClipboardEvent and image/file routing. Restore this editor's focus after
  // the menu before requesting the event; do not recursively call paste here.
  view.focus()
  ipcRenderer.invoke('application', { command: 'paste-native' })
    .catch(err => console.error(err))
}

/**
 * Explicitly paste the plain text from the clipboard.
 *
 * @param   {EditorView}  view  The view
 */
export function pasteAsPlain (view: EditorView): void {
  navigator.clipboard.readText()
    .then(text => {
      if (text !== '') {
        view.dispatch(view.state.replaceSelection(text), { scrollIntoView: true })
      }
    })
    .catch(err => console.error(err))
}
