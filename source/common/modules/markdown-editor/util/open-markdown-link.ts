/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        openMarkdownLink function
 * CVM-Role:        Utility function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This function opens a Markdown link, performing necessary
 *                  transformations where applicable.
 *
 * END HEADER
 */

import tryMakeValidUri from '@common/util/try-make-valid-uri'
import { type EditorState, type Line } from '@codemirror/state'
import { configField } from './configuration'
import { EditorView } from '@codemirror/view'
import { tocField } from '../plugins/toc-field'
import { isAbsolutePath, pathDirname } from '@common/util/renderer-path-polyfill'
import type { DocumentManagerIPCAPI } from 'source/app/service-providers/documents'
import {
  PDF_LINK_LOCATE_EVENT,
  type PdfLinkLocateDetail,
  type PdfLinkSyntax,
  type PdfPathEnvironment
} from '@dts/common/pdf-viewer'
import {
  extractQuotedSourceText,
  parsePdfLinkTarget,
  type PdfLinkTarget
} from '@common/modules/pdf-text/pdf-link-target'
import { resolveMarkdownLinkPath, resolvePdfLinkPath } from '@common/modules/pdf-text/pdf-backlinks'

/**
 * Turns a link path (without fragment) into the absolute path of a local
 * file, relative to the directory of the current note, percent-decoded (see
 * resolveMarkdownLinkPath).
 *
 * @param   {string}            linkPath  The path as written in the link
 * @param   {EditorView}        view      The editor holding the link
 *
 * @return  {string|undefined}            The absolute path, or undefined if the link does not name a local file
 */
function resolveLocalFilePath (linkPath: string, view: EditorView): string|undefined {
  return resolveMarkdownLinkPath(linkPath, view.state.field(configField).metadata.path)
}

/**
 * @return  {Promise<string[]>}  The files below a directory (or the file itself if the path is one), via the FSAL
 */
async function listFiles (absolutePath: string): Promise<string[]> {
  const result: unknown = await window.ipc.invoke('fsal', { command: 'read-path-recursively', payload: absolutePath })
  return Array.isArray(result) ? result.filter((entry): entry is string => typeof entry === 'string') : []
}

/**
 * Describes the file system as the editor sees it, for resolvePdfLinkPath:
 * the open workspaces (configuration `app.openWorkspaces`), files listed via
 * the FSAL's read-path-recursively, a file counting as existing if listing
 * its path yields exactly that path, and case-insensitive paths on Windows
 * and macOS.
 *
 * @return  {PdfPathEnvironment}  The environment
 */
export function createEditorPdfPathEnvironment (): PdfPathEnvironment {
  const workspaces: unknown = window.config.get('app.openWorkspaces')
  return {
    workspaceRoots: (Array.isArray(workspaces) ? workspaces : [])
      .filter((root): root is string => typeof root === 'string' && root !== ''),
    exists: async (path: string): Promise<boolean> => {
      const found = await listFiles(path)
      return found.length === 1 && found[0] === path
    },
    listFiles,
    ignoreCase: process.platform === 'win32' || process.platform === 'darwin'
  }
}

/**
 * Finds the PDF a link written in a note refers to, the way the editor
 * follows it: resolvePdfLinkPath with the editor's environment. The backlink
 * index resolves links with the same function.
 *
 * @param   {PdfLinkSyntax}              syntax       Markdown links are resolved like other file links; wiki links are also looked up by file name
 * @param   {string}                     writtenPath  The path as written in the link
 * @param   {string}                     notePath     Absolute path of the note holding the link
 *
 * @return  {Promise<string|undefined>}               The absolute path of the PDF, or undefined
 */
export async function resolveEditorPdfLinkPath (syntax: PdfLinkSyntax, writtenPath: string, notePath: string): Promise<string|undefined> {
  return await resolvePdfLinkPath(syntax, writtenPath, notePath, createEditorPdfPathEnvironment())
}

/**
 * Opens the PDF a link points to and, if the link names a location, asks the
 * PDF viewer to go there: once the documents provider has opened the file in
 * Zettlr, a PDF_LINK_LOCATE_EVENT is dispatched on the window, carrying the
 * location and, for links with a selection, the quoted text below the link
 * (decision 071). Nothing is dispatched if the PDF is opened externally.
 *
 * @param   {PdfLinkTarget}       target        The link's path as written and its location
 * @param   {EditorView}          view          The editor holding the link
 * @param   {'markdown'|'wiki'}   syntax        Markdown links are resolved like other file links; wiki links are also looked up by file name
 * @param   {number|undefined}    linkPosition  A document position inside the link, used to read the text below it
 */
export function openPdfLink (target: PdfLinkTarget, view: EditorView, syntax: 'markdown'|'wiki', linkPosition?: number): void {
  // Read the text below the link now, before the document can change
  let sourceText: string|undefined
  if (target.location?.selection !== undefined && linkPosition !== undefined && linkPosition >= 0 && linkPosition <= view.state.doc.length) {
    sourceText = extractQuotedSourceText(view.state.doc, view.state.doc.lineAt(linkPosition).number)
  }

  const windowId = new URLSearchParams(window.location.search).get('window_id')

  const open = async (): Promise<void> => {
    const filePath = await resolveEditorPdfLinkPath(syntax, target.path, view.state.field(configField).metadata.path)
    if (filePath === undefined) {
      console.error(`Could not find the PDF file ${target.path}`)
      return
    }

    const opened: unknown = await window.ipc.invoke('documents-provider', {
      command: 'open-file',
      // Wiki links leave the choice of tab to the preferences, as force-open does
      payload: { path: filePath, newTab: syntax === 'wiki' ? undefined : false, windowId }
    } as DocumentManagerIPCAPI)

    if (opened !== true || target.location === null) {
      return
    }

    const detail: PdfLinkLocateDetail = { filePath, location: target.location }
    if (sourceText !== undefined) {
      detail.sourceText = sourceText
    }
    window.dispatchEvent(new CustomEvent<PdfLinkLocateDetail>(PDF_LINK_LOCATE_EVENT, { detail }))
  }

  open().catch(err => console.error(err))
}

/**
 * Uses the ToC field within the editor state to determine the line descriptor
 * for the given heading ID (if applicable)
 *
 * @param   {string}       headingId  The heading ID to search for
 * @param   {EditorState}  state      The state
 *
 * @return  {Line|undefined}          The line, or undefined
 */
function findMatchingHeading (headingId: string, state: EditorState): Line|undefined {
  headingId = headingId.toLowerCase()

  for (const entry of state.field(tocField)) {
    if (entry.id.toLowerCase() === headingId) {
      return state.doc.line(entry.line)
    }
  }
}

/**
 * Resolves and opens a link safely (= not inside Zettlr, except it's a local MD file)
 *
 * Links to local PDFs open without their fragment; a fragment naming a
 * location (`#page=8&selection=...`) is then handed to the PDF viewer, see
 * openPdfLink.
 *
 * @param   {string}      url           The URL to open
 * @param   {EditorView}  view          The instance to use if it's a heading link
 * @param   {number}      linkPosition  Optional document position inside the link; lets PDF links send the quoted text below them
 */
export default function (url: string, view: EditorView, linkPosition?: number): void {
  // Only links that resolve to a local file; e.g. `www.example.com/a.pdf`
  // still goes to the browser below
  const pdfTarget = url.startsWith('#') ? null : parsePdfLinkTarget(url)
  if (pdfTarget !== null && resolveLocalFilePath(pdfTarget.path, view) !== undefined) {
    openPdfLink(pdfTarget, view, 'markdown', linkPosition)
    return
  }

  if (url.startsWith('#')) {
    // We should open an internal link, i.e. "jump to line".
    const targetLine = findMatchingHeading(url.substring(1), view.state)
    if (targetLine !== undefined) {
      view.dispatch({
        selection: { anchor: targetLine.from, head: targetLine.to },
        effects: EditorView.scrollIntoView(targetLine.from, { y: 'center' })
      })
    }
  } else {
    const searchParams = new URLSearchParams(window.location.search)
    const windowId = searchParams.get('window_id')
    const base = pathDirname(view.state.field(configField).metadata.path)
    const validURI = tryMakeValidUri(url, base)
    if (validURI === null) {
      return // A link that cannot be turned into a valid URI opens nothing
    }

    // Create a path from the URL by stripping the protocol and decoding any
    // potential encoded characters.
    let localPath = decodeURIComponent(validURI.replace('safe-file://', ''))
    // Due to the colons in the drive letters on Windows, the pathname will
    // look like this: /C:/Users/Documents/test.jpg
    // See: https://github.com/Zettlr/Zettlr/issues/5489
    if (/^\/[A-Z]:/i.test(localPath)) {
      localPath = localPath.slice(1)
    }

    // It's a valid file we can open if it's an absolute path to a Markdown or
    // code file
    if (validURI.startsWith('safe-file://') && isAbsolutePath(localPath)) {
      window.ipc.invoke('documents-provider', {
        command: 'open-file',
        payload: { path: localPath, newTab: false, windowId }
      } as DocumentManagerIPCAPI)
        .catch(e => console.error(e))
    } else {
      // Handled by the event listener in the main process
      window.location.assign(validURI)
    }
  }
}
