/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Save As helpers
 * CVM-Role:        Utility
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH save as (R48): Pure helpers for "File > Save
 *                  As…": the options of the save dialog, the resolution of
 *                  the path the user chose into the path that is written, and
 *                  the classification of that path against the documents and
 *                  tabs that are currently open. This module is pure (no
 *                  Electron imports) so it can be tested in isolation.
 *
 * END HEADER
 */

import path from 'path'
import { getDocumentTypeForExtension, hasMarkdownExt, hasMdOrCodeExt, MD_EXT } from '@common/util/file-extention-checks'
import { DocumentType } from '@dts/common/documents'
import { ensureMarkdownExtension, isSamePath } from './scratch-note-storage'

/**
 * The subset of Electron's SaveDialogOptions that Save As uses. Kept as a
 * local type so that this module does not import Electron.
 */
export interface SaveAsDialogOptions {
  title: string
  defaultPath: string
  buttonLabel: string
  filters: Array<{ name: string, extensions: string[] }>
  properties: Array<'createDirectory'|'showOverwriteConfirmation'>
}

/**
 * The outcome of resolving the path chosen in the save dialog: either the
 * path to write (extensionAppended is true if ".md" had to be appended to the
 * chosen name), or a refusal because the chosen name would turn the document
 * into a different file type.
 */
export type SaveAsTargetResolution = { kind: 'resolved', targetPath: string, extensionAppended: boolean }
  | { kind: 'type-mismatch' }

/**
 * How the resolved target relates to the open files: the current file itself
 * (Save As degrades to a plain save), a file that is open as a document or in
 * a tab (must not be overwritten), or any other path (a new file is written).
 */
export type SaveAsTargetClassification = { kind: 'same-file' }
  | { kind: 'open-conflict', conflictingPath: string }
  | { kind: 'new-file' }

/**
 * Builds the options of the Save As dialog for the given file: the dialog
 * starts in the file's folder with its current name, and offers a filter for
 * the file's own type plus "All Files". Markdown files get the Markdown
 * filter, so that a name typed without extension receives ".md".
 *
 * @param   {string}               currentPath  The path of the file being saved
 *
 * @return  {SaveAsDialogOptions}               The dialog options
 */
export function buildSaveAsDialogOptions (currentPath: string): SaveAsDialogOptions {
  const filters: Array<{ name: string, extensions: string[] }> = []

  if (hasMarkdownExt(currentPath)) {
    filters.push({ name: 'Markdown', extensions: MD_EXT.map(extension => extension.slice(1)) })
  } else {
    const extension = path.extname(currentPath).slice(1)
    if (extension !== '') {
      filters.push({ name: `${extension.toUpperCase()} Files`, extensions: [extension] })
    }
  }

  filters.push({ name: 'All Files', extensions: ['*'] })

  return {
    title: 'Save As',
    defaultPath: currentPath,
    buttonLabel: 'Save',
    filters,
    properties: [ 'createDirectory', 'showOverwriteConfirmation' ]
  }
}

/**
 * Resolves the path chosen in the save dialog into the path that is written.
 * A Markdown document saved under a name without a Markdown or code extension
 * receives ".md" (like a saved scratch note), so that it is loaded as Markdown
 * again. Otherwise the chosen name must keep the document type of the current
 * file, because the open editor cannot switch its type: a Markdown file may
 * become ".txt", but not ".json". Files of a type without an editor mode keep
 * their extension.
 *
 * @param   {string}                   currentPath  The path of the file being saved
 * @param   {string}                   chosenPath   The path chosen in the dialog
 *
 * @return  {SaveAsTargetResolution}                The path to write, or a refusal
 */
export function resolveSaveAsTarget (currentPath: string, chosenPath: string): SaveAsTargetResolution {
  const currentType = getDocumentTypeForExtension(currentPath)

  if (currentType === DocumentType.Markdown && !hasMdOrCodeExt(chosenPath)) {
    const targetPath = ensureMarkdownExtension(chosenPath)
    return { kind: 'resolved', targetPath, extensionAppended: targetPath !== chosenPath }
  }

  if (currentType === undefined) {
    const isSameExtension = path.extname(currentPath).toLowerCase() === path.extname(chosenPath).toLowerCase()
    return isSameExtension
      ? { kind: 'resolved', targetPath: chosenPath, extensionAppended: false }
      : { kind: 'type-mismatch' }
  }

  return getDocumentTypeForExtension(chosenPath) === currentType
    ? { kind: 'resolved', targetPath: chosenPath, extensionAppended: false }
    : { kind: 'type-mismatch' }
}

/**
 * Returns the first of the given open paths that points to the same file as
 * the target path, or undefined if none does. On Windows the comparison
 * ignores case and separator differences.
 *
 * @param   {string}            targetPath       The path about to be written
 * @param   {string[]}          openPaths        The paths of open documents and tabs
 * @param   {boolean}           caseInsensitive  Whether to ignore case (default: on Windows)
 *
 * @return  {string|undefined}                   The conflicting open path, if any
 */
export function findOpenPathConflict (targetPath: string, openPaths: string[], caseInsensitive = process.platform === 'win32'): string|undefined {
  return openPaths.find(openPath => isSamePath(openPath, targetPath, caseInsensitive))
}

/**
 * Classifies the resolved target of a Save As against the open files. The
 * current file itself is checked first, so that it does not count as a
 * conflict with its own open document or tab.
 *
 * @param   {string}                      currentPath        The path of the file being saved
 * @param   {string}                      targetPath         The resolved target path
 * @param   {string[]}                    openDocumentPaths  The paths of all loaded documents
 * @param   {string[]}                    openTabPaths       The paths of all open tabs, in every pane
 * @param   {boolean}                     caseInsensitive    Whether to ignore case (default: on Windows)
 *
 * @return  {SaveAsTargetClassification}                     How the target relates to the open files
 */
export function classifySaveAsTarget (
  currentPath: string,
  targetPath: string,
  openDocumentPaths: string[],
  openTabPaths: string[],
  caseInsensitive = process.platform === 'win32'
): SaveAsTargetClassification {
  if (isSamePath(currentPath, targetPath, caseInsensitive)) {
    return { kind: 'same-file' }
  }

  const conflictingPath = findOpenPathConflict(targetPath, [ ...openDocumentPaths, ...openTabPaths ], caseInsensitive)
  if (conflictingPath !== undefined) {
    return { kind: 'open-conflict', conflictingPath }
  }

  return { kind: 'new-file' }
}
