/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Markdown Paste and Drop handlers
 * CVM-Role:        CodeMirror Extension
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file contains a few handlers that make the main editor
 *                  react properly to paste and drop events, such as converting
 *                  HTML to Markdown before insertion, or handling image drops.
 *
 * END HEADER
 */

import { type DOMEventHandlers, type EditorView } from '@codemirror/view'
import html2md from '@common/util/html-to-md'
import { configField } from '../util/configuration'
import { rewritePdfLinksForNote } from '../util/pdf-quote-paste'
import { pathBasename, pathDirname, pathExtname, relativePath } from '@common/util/renderer-path-polyfill'
import { type SaveImageFromClipboardAPI } from 'source/app/service-providers/commands/save-image-from-clipboard'
import { hasMdOrCodeExt, hasPDFExt } from '@common/util/file-extention-checks'
import { buildExistingImageLink, buildSavedClipboardImageLink, isTemporaryImageLocation, parseClipboardFileUrls } from '@common/util/paste-image-path'
import { isScratchNoteTabPath } from 'source/win-main/file-manager/util/unsaved-tab-paths'
import type { DocumentManagerIPCAPI } from 'source/app/service-providers/documents'
import { canCompleteImagePaste, pastedImagePreviewEffect, trackImagePasteView } from '../util/pasted-image-preview'

const ipcRenderer = window.ipc

const imageRE = /\.(?:png|jpe?g|gif|bmp|svg|tiff?|webp|avif|ico)$/i

/**
 * Zettlr-LYH R126: checks whether a document is a draft of the Unsaved Files
 * folder, i.e. a Markdown file directly inside the configured scratch folder.
 * The scratch folder is read the same way the file manager reads it (the
 * configuration option scratchNotesDirectory). Images pasted or dropped into a
 * draft receive an absolute link, since the draft is moved when it is saved.
 * The configuration is read synchronously from main, so call this only when an
 * image is about to be inserted.
 *
 * @param   {string}   documentPath  The absolute path of the document
 *
 * @return  {boolean}                True if the document is a draft
 */
function isDraftDocument (documentPath: string): boolean {
  const configured: unknown = window.config.get('scratchNotesDirectory')
  return typeof configured === 'string' && isScratchNoteTabPath(documentPath, configured)
}

/**
 * This function normalizes an absolute path in a way that is suitable for the
 * main editor, i.e., it should be easily readable for humans and as short as
 * possible.
 *
 * @param   {string}  p         The path to be normalized
 * @param   {string}  basePath  The base path for turning `p` relative.
 *
 * @return  {string}            The normalized path.
 */
function normalizePathForInsertion (p: string, basePath: string): string {
  const relative = relativePath(basePath, p)
  let sanitizedPath = relative.replace(/\\/g, '/')
  if (!sanitizedPath.startsWith('./') && !sanitizedPath.startsWith('../')) {
    sanitizedPath = './' + sanitizedPath
  }
  return sanitizedPath
}

/**
 * Handles the code required to save an image from the clipboard. Main saves the
 * image into the "_Zettlr_Img" folder next to the document without asking (or
 * notifies the user why it could not, e.g. because the document has not been
 * saved yet). It returns the image tag as soon as the image has been saved to
 * disk: the relative tag, e.g. `![](_Zettlr_Img/name.png)`, or, in a draft (R126),
 * the tag with the absolute path of the saved file.
 *
 * @param   {string}           documentPath  The absolute path of the document
 * @param   {File|{ name: string }} file     The image object, or only the name
 *                                           of an image that main reads from
 *                                           the system clipboard itself
 * @param   {boolean}          isDraft       Whether the document is a draft
 *
 * @return  {Promise<string>}                Resolves with the image tag or undefined.
 */
async function saveImageFromClipboard (documentPath: string, file: File|{ name: string }, isDraft: boolean): Promise<string|undefined> {
  const basePath = pathDirname(documentPath)
  const imageData = !(file instanceof File) ? '' : await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()

    // Hook event listeners
    reader.addEventListener('abort', () => reject(new Error('Image read was aborted')))
    reader.addEventListener('error', () => reject(new Error('Could not read image data')))
    reader.addEventListener('load', () => resolve(reader.result as string))

    // Start loading (as a data URL)
    reader.readAsDataURL(file)
  })

  const pathToInsert: string|undefined = await ipcRenderer.invoke('application', {
    command: 'save-image-from-clipboard',
    payload: { basePath, imageData, imageName: file.name } as SaveImageFromClipboardAPI
  })

  // If the image could not be saved (main has already told the user why), the
  // command returns undefined, so we have to check for this.
  if (pathToInsert !== undefined) {
    return buildSavedClipboardImageLink({ documentPath, imagePath: pathToInsert, isDraft })
  }
}

/**
 * Zettlr-LYH R60: pastes plain text whose Markdown links point to PDFs by
 * absolute path (as the PDF viewer's Copy as Quote writes them) with those
 * links made relative to the note. Leaves everything else to CodeMirror's
 * default paste.
 *
 * @param   {EditorView}  view  The editor
 * @param   {string}      text  The plain text in the clipboard
 *
 * @return  {boolean}           True if the text has been pasted here
 */
function pasteWithRelativePdfLinks (view: EditorView, text: string): boolean {
  const rewritten = rewritePdfLinksForNote(text, view.state.field(configField).metadata.path)
  if (rewritten === text) {
    return false
  }

  view.dispatch(view.state.replaceSelection(rewritten), { userEvent: 'input.paste', scrollIntoView: true })
  return true
}

/**
 * These handlers hook into the editor and attempt to intercept events that need
 * to be handled in a way different from the standard CodeMirror way.
 */
function handleMarkdownPaste (event: ClipboardEvent, view: EditorView, imageSeparator = '\n'): boolean {
  const data = event.clipboardData
  if (data === null) {
    return false // Let the default handler take over
  }

  // A native copied-file entry (Windows CF_HDROP, Finder, etc.) has a real
  // path. Clipboard image previews do not. Preserve the whole original file
  // list even if the same clipboard also supplies text or a raster preview.
  const files = Array.from(data.files)
  const existingFiles = files.map(file => ({ file, path: window.getPathForFile(file) }))
    .filter((entry): entry is { file: File, path: string } => typeof entry.path === 'string' && entry.path !== '')
  const fileUrls = parseClipboardFileUrls(data.getData('text/uri-list'))
  const hasFileIdentity = existingFiles.length > 0 || fileUrls.length > 0

  if (!hasFileIdentity && data.types.length === 1 && data.types[0] === 'text/plain') {
    // Only plain text: the default handler takes over, unless the text
    // contains absolute links to PDFs that are to become relative (R60)
    return pasteWithRelativePdfLinks(view, data.getData('text/plain'))
  }

  // Now that we have proper clipboardData to access, we have to determine if
  // this is an image or a text call. Here, we have a set of problems.
  //
  // 1. OS images (and other files) will be represented as file items, so
  //    data.types only includes "Files"
  // 2. Firefox and Chrome will, if the user copies an image, have both the
  //    type "Files" and "text/html", the latter of which often includes the
  //    URL or the image data as a string.
  // 3. Microsoft Office is a POS and will just write EVERYTHING to the
  //    clipboard, i.e. "text/plain", "text/html", "text/rtf", and "image/png"
  // 4. LibreOffice will also write plain, HTML, and RTF, but no image.
  //
  // In effect, we cannot rely on the presence of a "Files" type in the
  // clipboard data to tell us whether we should initiate a paste image or
  // paste text action.
  //
  // BUT, what I found out is that whenever the intention is to paste text,
  // and an image only serves as a fallback, there will be "text/plain" in the
  // clipboard. In other words, as long as there is "text/plain" in the
  // clipboard, the user intends to paste text, not an image.

  const textIntention = !hasFileIdentity && data.types.includes('text/plain')
  if (!textIntention) {
    trackImagePasteView(view)
  }
  const pasteState = view.state
  const documentPath = view.state.field(configField).metadata.path

  // Each entry owns a slot so asynchronous saves cannot reorder images.
  const insertions: Array<Promise<string|undefined>> = []
  if (textIntention && data.types.includes('text/html')) {
    // The user intends to paste text, and there is formatted HTML in the
    // clipboard that we need to turn into HTML.
    const html = data.getData('text/html')
    const { boldFormatting, italicFormatting } = view.state.field(configField)
    const emphasis = italicFormatting
    const strong = boldFormatting.includes('*') ? '*' : '_'
    const promise = html2md(html, true, { emphasis, strong })
      .catch(err => {
        console.error(err)
        // On error, fall back to the plain text
        return data.getData('text/plain')
      })
    insertions.push(promise)
  } else if (textIntention) {
    // The user intends to paste text, but there's only plain text in the
    // clipboard.
    const text = data.getData('text/plain')
    insertions.push(Promise.resolve(rewritePdfLinksForNote(text, documentPath)))
  } else {
    // The user intends to paste an image or a series of files. In a draft
    // of the Unsaved Files folder, the links are absolute (R126).
    const isDraft = isDraftDocument(documentPath)
    if (hasFileIdentity) {
      const originals: Array<{ name: string, path: string, file?: File }> = existingFiles.length > 0
        ? existingFiles.map(entry => ({ name: entry.file.name, path: entry.path, file: entry.file }))
        : fileUrls.map(filePath => ({ name: pathBasename(filePath), path: filePath }))
      for (const original of originals) {
        if (imageRE.test(original.path) && isTemporaryImageLocation(original.path)) {
          // A screenshot tool's temporary file is no lasting original: save it
          // into "_Zettlr_Img" like image data. Without a readable file object,
          // main reads the image from the system clipboard.
          insertions.push(saveImageFromClipboard(documentPath, original.file ?? { name: original.name }, isDraft))
        } else if (imageRE.test(original.path)) {
          insertions.push(Promise.resolve(buildExistingImageLink(original.name, {
            documentPath, imagePath: original.path, isDraft
          })))
        }
      }
    } else {
      for (const file of files) {
        if (imageRE.test(file.name) || file.type.startsWith('image/')) {
          insertions.push(saveImageFromClipboard(documentPath, file, isDraft))
        }
      }
    }
  }

  Promise.allSettled(insertions)
    .then(results => {
      const tags: string[] = []
      for (const result of results) {
        if (result.status === 'rejected') {
          console.error(result.reason)
        } else if (result.value !== undefined) {
          tags.push(result.value)
        }
      }
      if (!textIntention && (!canCompleteImagePaste(view) ||
        view.state.doc !== pasteState.doc || !view.state.selection.eq(pasteState.selection) ||
        view.state.field(configField).metadata.path !== documentPath)) {
        // Saving is asynchronous. Do not replace a later selection or input,
        // or dispatch into an editor that has since been destroyed.
        return
      }
      if (tags.length === 0) {
        return // Failed/unsupported images must not delete the selection.
      }
      const insertion = view.state.replaceSelection(tags.join(textIntention ? '\n' : imageSeparator))
      if (textIntention) {
        view.dispatch(insertion)
      } else {
        const transaction = view.state.update(insertion)
        const ranges: Array<{ from: number, to: number }> = []
        transaction.changes.iterChangedRanges((_from, _to, from, to) => {
          if (from < to) {
            ranges.push({ from, to })
          }
        })
        view.dispatch({ ...insertion, effects: pastedImagePreviewEffect.of(ranges), userEvent: 'input.paste' })
      }
    })
    .catch(err => console.error(err))

  return true
}

/**
 * A cell keeps its own text/HTML handling and drop behavior. Only image data
 * and native file references enter the shared image routing; separate images
 * use cell line breaks instead of splitting a Markdown table into new rows.
 */
export const mdTableImagePasteHandlers: DOMEventHandlers<any> = {
  paste (event, view) {
    const data = event.clipboardData
    if (data === null) {
      return false
    }
    const files = Array.from(data.files)
    const hasFileIdentity = files.some(file => (window.getPathForFile(file) ?? '') !== '') ||
      parseClipboardFileUrls(data.getData('text/uri-list')).length > 0
    const hasImageData = !data.types.includes('text/plain') &&
      files.some(file => imageRE.test(file.name) || file.type.startsWith('image/'))
    return hasFileIdentity || hasImageData ? handleMarkdownPaste(event, view, '<br>') : false
  }
}

export const mdPasteDropHandlers: DOMEventHandlers<any> = {
  paste: handleMarkdownPaste,
  drop (event, view) {
    const dataTransfer = event.dataTransfer

    if (dataTransfer === null) {
      return false
    }

    if (dataTransfer.getData('zettlr/document-tab') !== '') {
      return false // There's a document being dragged, let the MainEditor capture the event
    }

    const zettlrFile = dataTransfer.getData('text/x-zettlr-file')

    if (dataTransfer.files.length === 0 && zettlrFile === '') {
      return false
    }

    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
    if (pos === null) {
      return false
    }

    event.preventDefault()
    event.stopPropagation()

    const documentPath = view.state.field(configField).metadata.path
    const cwd = pathDirname(documentPath)

    // First: Do we have a fileList of files to drop here?
    if (dataTransfer.files.length > 0) {
      const allPromises: Promise<void>[] = []
      const insertions: string[] = []
      // In a draft of the Unsaved Files folder, image links are absolute (R126)
      const isDraft = isDraftDocument(documentPath)
      // We have a list of files being dropped onto the editor --> handle them
      for (const file of dataTransfer.files) {
        const filePath = window.getPathForFile(file)
        const isImage = imageRE.test(file.name)

        if (isImage && filePath !== undefined) {
          // The image resides somewhere on disk -> directly insert (a relative
          // path, or an absolute one in a draft)
          insertions.push(buildExistingImageLink(file.name, { documentPath, imagePath: filePath, isDraft }))
        } else if (isImage && filePath === undefined) {
          // It's an image without a file on disk --> save it into "_Zettlr_Img"
          allPromises.push(new Promise((resolve, reject) => {
            saveImageFromClipboard(documentPath, file, isDraft)
              .then(tag => {
                if (tag !== undefined) {
                  insertions.push(tag)
                }
                resolve()
              })
              .catch(err => reject(err))
          }))
        } else if ((hasMdOrCodeExt(file.name) || hasPDFExt(file.name)) && filePath !== undefined) {
          // TODO: We should absolutely here provide the leafId, because
          // otherwise main will simply decide for us instead of us telling
          // which editor pane the user has dropped the file onto.
          // Open supported text and PDF files; PDFs use the built-in viewer for this drop.
          ipcRenderer.invoke('documents-provider', {
            command: 'open-file',
            payload: {
              path: filePath,
              newTab: true,
              preferInternalPDF: hasPDFExt(filePath)
            }
          } as DocumentManagerIPCAPI)
            .catch(e => console.error(e))
        } else {
          // Unsupported file type -> ignore
        }
      }

      Promise.allSettled(allPromises).then(() => {
        if (insertions.length > 0) {
          view.dispatch({ changes: { from: pos, insert: insertions.join('\n') } })
        }
      }).catch(err => console.error(err))

      return true
    } else if (zettlrFile !== '') {
      // We have a Markdown/Code file to insert
      const data = JSON.parse(zettlrFile) as { type: 'code'|'file'|'directory'|'other', path: string, id?: string }
      const name = pathBasename(data.path, pathExtname(data.path))
      const pathToInsert = normalizePathForInsertion(data.path, cwd)
      if (data.type === 'file') {
        // Insert as Zkn link
        view.dispatch({ changes: { from: pos, insert: `[[${name}]]` } })
      } else if (data.type === 'code') {
        // Insert as Md link
        view.dispatch({ changes: { from: pos, insert: `[${name}](${pathToInsert})` } })
      } else if (data.type === 'other') {
        if (imageRE.test(data.path)) {
          // An image dragged from the file tree: in a draft of the Unsaved
          // Files folder the link is absolute, since the draft is moved when it
          // is saved (R126); in every other document it stays relative.
          const insertion = isDraftDocument(documentPath)
            ? buildExistingImageLink(name, { documentPath, imagePath: data.path, isDraft: true })
            : `![${name}](${pathToInsert})`
          view.dispatch({ changes: { from: pos, insert: insertion } })
        } else {
          view.dispatch({ changes: { from: pos, insert: `[${name}](${pathToInsert})` } })
        }
      }
      return true
    }

    return false
  }
}
