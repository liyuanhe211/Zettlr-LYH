/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Remote change routing
 * CVM-Role:        Utility
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH disk conflicts (R138): decides what happens when
 *                  the contents of an open file on disk differ from what
 *                  Zettlr knows, depending on the three versions and on
 *                  whether the document is in front of the user. This module
 *                  is pure (it depends on types only, not on Electron, the file
 *                  system or Vue) so that it can be tested in isolation.
 *
 * END HEADER
 */

/**
 * How prominently a document is shown:
 * - 'foreground': the active tab of the focused pane of a focused main window
 * - 'visible': the active tab of any pane of a main window that is not
 *   minimized, but not the foreground document
 * - 'background': every other open document
 */
export type DocumentVisibility = 'foreground' | 'visible' | 'background'

/**
 * What to do with a version on disk that has just been read:
 * - 'ignore': the disk holds the last saved contents, nothing has changed
 * - 'accept-equal': the disk holds exactly the editor contents, so the
 *   document counts as saved without asking
 * - 'auto-reload': the editor has no unsaved changes, so the disk version is
 *   loaded and the user is told about it
 * - 'compare': both sides have changed and the document is in front of the
 *   user, so the comparison view opens right away
 * - 'defer': the document is not in front of the user; it is only marked to
 *   be checked again when the user turns to it
 */
export type RemoteChangeRoute = 'ignore' | 'accept-equal' | 'auto-reload' | 'compare' | 'defer'

/**
 * Decides what to do with a version of a file read from disk. The checks run
 * in this order and the first match wins: equal to the last saved contents,
 * equal to the editor contents, no unsaved changes in a document that is not
 * in the background, unsaved changes in the foreground document, everything
 * else. All contents are compared as read and kept by Zettlr (LF linefeeds,
 * without BOM).
 *
 * @param   {string}              input.diskContents       The contents just read from disk
 * @param   {string}              input.lastSavedContent   The contents of the last save or load
 * @param   {string}              input.editorContents     The current editor contents
 * @param   {boolean}             input.hasUnsavedChanges  Whether the editor holds unsaved changes
 * @param   {DocumentVisibility}  input.visibility         How prominently the document is shown
 *
 * @return  {RemoteChangeRoute}                            What to do
 */
export function routeRemoteChange (input: {
  diskContents: string
  lastSavedContent: string
  editorContents: string
  hasUnsavedChanges: boolean
  visibility: DocumentVisibility
}): RemoteChangeRoute {
  if (input.diskContents === input.lastSavedContent) {
    return 'ignore'
  }

  if (input.diskContents === input.editorContents) {
    return 'accept-equal'
  }

  if (!input.hasUnsavedChanges && input.visibility !== 'background') {
    return 'auto-reload'
  }

  if (input.hasUnsavedChanges && input.visibility === 'foreground') {
    return 'compare'
  }

  return 'defer'
}

/**
 * Determines how prominently a document is shown from every place where it is
 * open (one entry per editor pane that has a tab for it). The most prominent
 * place wins: any place in the focused pane of a focused window, where the
 * document is the active tab, makes it the foreground document; otherwise any
 * place in a window that is not minimized, where it is the active tab, makes
 * it visible; otherwise it is in the background.
 *
 * @param   {Array}               occurrences  The places where the document is open
 *
 * @return  {DocumentVisibility}               The visibility of the document
 */
export function visibilityOf (occurrences: Array<{
  windowFocused: boolean
  windowMinimized: boolean
  isFocusedLeaf: boolean
  isActiveTab: boolean
}>): DocumentVisibility {
  if (occurrences.some(place => place.windowFocused && place.isFocusedLeaf && place.isActiveTab)) {
    return 'foreground'
  }

  if (occurrences.some(place => !place.windowMinimized && place.isActiveTab)) {
    return 'visible'
  }

  return 'background'
}
