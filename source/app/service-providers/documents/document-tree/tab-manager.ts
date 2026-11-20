/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TabManager
 * CVM-Role:        Model
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     The tab manager manages the open documents for a single
 *                  editor pane. Tab managers aren't instantiated standalone but
 *                  are meant to be contained within a document tree leaf.
 *
 * END HEADER
 */

import type { OpenDocument } from '@dts/common/documents'

export interface TabManagerJSON {
  openFiles: OpenDocument[]
  activeFile: OpenDocument|null
}

export class TabManager {
  private readonly _openFiles: OpenDocument[]
  private _activeFile: OpenDocument|null
  private readonly _sessionHistory: string[]
  private _sessionPointer: number
  // Zettlr-LYH (R90): The activation order of this pane, i.e. the paths of the
  // files that have been the active tab, with the most recent activation at
  // the end. Every path appears at most once. It is kept in memory only and is
  // independent of the session history (which serves back/forward navigation).
  private _activationOrder: string[]

  constructor () {
    this._openFiles = []
    this._activeFile = null
    this._sessionHistory = []
    this._sessionPointer = -1
    this._activationOrder = []
  }

  // GETTERS AND SETTERS

  /**
   * Returns the list of currently opened files in this tab manager
   *
   * @return  {OpenDocument[]}  The currently open documents
   */
  public get openFiles (): OpenDocument[] {
    return this._openFiles
  }

  /**
   * Sets the active file to the one given; can either be an OpenDocument or
   * a file path. Provide null to unset
   *
   * @param  {OpenDocument|string|null}  file  The new active file
   */
  public set activeFile (file: OpenDocument|string|null) {
    if (typeof file === 'string') {
      const doc = this._openFiles.find(doc => doc.path === file)
      if (doc === undefined) {
        return
      }
      file = doc
    }

    this._activeFile = file
  }

  /**
   * Returns the current active file
   *
   * @return  {OpenDocument|null}  The active file or null
   */
  public get activeFile (): OpenDocument|null {
    return this._activeFile
  }

  // PUBLIC METHODS

  /**
   * Sorts the openFiles according to pathArray.
   *
   * @param  {string[]}  pathArray  An array with absolute paths to sort with
   *
   * @return {boolean}              The new sorting
   */
  public sortOpenFiles (pathArray: string[]): boolean {
    // Only sort if something changed
    if (pathArray.length === this._openFiles.length) {
      let somethingChanged = false
      for (let i = 0; i < pathArray.length; i++) {
        if (this._openFiles[i].path !== pathArray[i]) {
          somethingChanged = true
          break
        }
      }

      if (!somethingChanged) {
        return false
      }
    }

    // Simply re-sort based on the new paths
    this._openFiles.sort((a, b) => {
      return pathArray.indexOf(a.path) - pathArray.indexOf(b.path)
    })

    this.movePinnedTabsLeft()

    return true
  }

  /**
   * This function (re)sorts the open files solely based on their pinned status
   */
  private movePinnedTabsLeft (): void {
    // Also make sure that pinned tabs are all grouped to the left before sync
    this._openFiles.sort((a, b) => {
      if (a.pinned && !b.pinned) {
        return -1
      }
      if (!a.pinned && b.pinned) {
        return 1
      }
      return 0
    })
  }

  /**
   * Opens a file within this tab manager.
   *
   * @param   {string}   filePath       The absolute file path
   * @param   {boolean}  modifyHistory  Optional. Only used internally.
   * @param   {boolean}  insertAfterActiveTab  Place a file-manager request next to the active tab.
   *
   * @return  {Promise<boolean>}        True upon successful opening
   */
  public openFile (filePath: string, modifyHistory?: boolean, insertAfterActiveTab = false): boolean {
    if (this.activeFile?.path === filePath) {
      return false
    }
    const openFile = this._openFiles.find(file => file.path === filePath)

    // Zettlr-LYH (R90): Calls with modifyHistory === false that do not come
    // from back/forward navigation (restoring tabs on startup, temporarily
    // showing a scratch note) are no user activations, so they must not touch
    // the activation order. Back/forward navigation records its activations
    // itself in _moveThroughHistory().
    const recordActivation = modifyHistory !== false
    const previousActivePath = this._activeFile?.path ?? null

    // Remove the file from the session history if applicable
    if (modifyHistory !== false) {
      const sessionIndex = this._sessionHistory.indexOf(filePath)
      if (sessionIndex > -1) {
        this._sessionHistory.splice(sessionIndex, 1)
      }
    }

    // File-manager requests may reposition an existing tab before activating it.
    if (openFile !== undefined) {
      if (insertAfterActiveTab) {
        this.moveFileAfterActive(filePath)
      }
      if (modifyHistory !== false) {
        this._sessionHistory.push(filePath)
        this._sessionPointer = this._sessionHistory.length - 1
      }
      this.activeFile = openFile
      if (recordActivation) {
        this._recordActivation(filePath, previousActivePath)
      }
      return true
    }

    const file: OpenDocument = { path: filePath, pinned: false }

    // Other opening and restoration paths retain their existing append order.
    this._openFiles.push(file)
    if (insertAfterActiveTab) {
      this.moveFileAfterActive(filePath)
    }

    // Update all required states. Especially make sure to re-sort this to
    // ensure the new file (unpinned) doesn't end up in between several pinned
    // files.
    this.sortOpenFiles(this._openFiles.map(d => d.path))
    this.movePinnedTabsLeft()

    this.activeFile = file

    if (recordActivation) {
      this._recordActivation(filePath, previousActivePath)
    }

    if (modifyHistory !== false) {
      this._sessionHistory.push(filePath)
      this._sessionPointer = this._sessionHistory.length - 1
    }

    return true
  }

  /**
   * Positions an open tab after the previous active tab, within the existing
   * pinned grouping. Remove the target before finding the insertion index so
   * moving a tab from either side does not shift the anchor incorrectly.
   */
  private moveFileAfterActive (filePath: string): void {
    const activePath = this._activeFile?.path
    if (activePath === undefined || activePath === filePath) {
      return
    }
    const order = this._openFiles.map(file => file.path).filter(path => path !== filePath)
    const activeIndex = order.indexOf(activePath)
    if (activeIndex < 0) {
      return
    }
    order.splice(activeIndex + 1, 0, filePath)
    this.sortOpenFiles(order)
  }

  /**
   * Zettlr-LYH (R90): Records that the given file has just become the active
   * tab of this pane. A path appears only once in the activation order, so any
   * earlier record of it is removed first.
   *
   * If the file that was active before is not in the activation order yet (for
   * example because it was restored on startup), it is recorded first so that
   * closing the new active tab always switches back to the tab that was shown
   * before.
   *
   * @param  {string}       filePath          The file that became active
   * @param  {string|null}  previousFilePath  The file that was active before
   */
  private _recordActivation (filePath: string, previousFilePath: string|null = null): void {
    if (previousFilePath !== null && !this._activationOrder.includes(previousFilePath)) {
      this._activationOrder.push(previousFilePath)
    }

    this._removeFromActivationOrder(filePath)
    this._activationOrder.push(filePath)
  }

  /**
   * Zettlr-LYH (R90): Removes the given path from the activation order, if it
   * is in there.
   *
   * @param  {string}  filePath  The path to remove
   */
  private _removeFromActivationOrder (filePath: string): void {
    const index = this._activationOrder.indexOf(filePath)
    if (index > -1) {
      this._activationOrder.splice(index, 1)
    }
  }

  /**
   * Closes the given file if it's in fact open. This function deals with every
   * potential problem such as retrieving user consent to closing the file if it
   * is modified.
   *
   * @param   {MDFileDescriptor|CodeFileDescriptor}  file  The file to be closed
   *
   * @return  {boolean}                                    Whether or not the file was closed
   */
  public closeFile (file: OpenDocument|string): boolean {
    if (typeof file === 'string') {
      const doc = this._openFiles.find(doc => doc.path === file)
      if (doc !== undefined) {
        file = doc
      } else {
        return false
      }
    }
    if (!this._openFiles.includes(file)) {
      return false // All good, we didn't even have to close the file.
    }

    if (file.pinned) {
      // TODO this._app.log.warning(`[Document Provider] Refusing to close pinned file ${file.path}`)
      return false
    }

    // Retrieve the index of the active file and whether it's an active file
    const activeFileIdx = (this._activeFile === null) ? -1 : this._openFiles.indexOf(this._activeFile)
    const isActive = this._activeFile === file

    // Then remove the file from the list of open files
    this._openFiles.splice(this._openFiles.indexOf(file), 1)

    // Zettlr-LYH (R90): A closed tab is no longer a candidate to switch back to
    this._removeFromActivationOrder(file.path)

    // Now, if we just closed the active file, we need to make another file
    // active, or none, if there are no more open files active.
    if (!isActive) {
      return true
    } else {
      this.activeFile = null
    }

    // Zettlr-LYH (R90): Switch back to the tab that was activated most recently
    // and is still open, regardless of whether it is adjacent to the closed one.
    for (let i = this._activationOrder.length - 1; i >= 0; i--) {
      const candidate = this._openFiles.find(doc => doc.path === this._activationOrder[i])
      if (candidate !== undefined) {
        this.activeFile = candidate
        return true
      }
    }

    // Nothing recorded (e.g., after a restart, before any tab has been
    // switched): fall back to the neighbor on the left.
    if (this._openFiles.length > 0 && activeFileIdx > 0) {
      this.activeFile = this._openFiles[activeFileIdx - 1]
    } else if (this._openFiles.length > 0 && activeFileIdx === 0) {
      this.activeFile = this._openFiles[0]
    }

    return true
  }

  /**
   * This function is a convenience when the path of a file has changed without
   * the file being deleted or otherwise removed from the app. NOTE that you
   * still have to emit any events to notify the editors of this change.
   *
   * @param   {string}  oldPath  The old path
   * @param   {string}  newPath  The new path
   *
   * @return  {boolean}          False if the file was not open here
   */
  public replaceFilePath (oldPath: string, newPath: string): boolean {
    const file = this.openFiles.find(doc => doc.path === oldPath)
    if (file === undefined) {
      console.log(`Didnt find file for path ${oldPath} -- nothing has changed.`, this.openFiles.map(doc => doc.path))
      return false
    }

    // Zettlr-LYH (R90): The activation order follows the renamed file; should
    // the new path already be in there, only its latest position is kept.
    const renamedOrder = this._activationOrder.map(path => path === oldPath ? newPath : path)
    this._activationOrder = renamedOrder.filter((path, index) => renamedOrder.lastIndexOf(path) === index)

    file.path = newPath
    if (this.activeFile?.path === oldPath) {
      this.activeFile = file
    }

    return true
  }

  /**
   * Goes back in the session history and opens the previous file
   */
  public back (): void {
    this._moveThroughHistory(-1)
  }

  /**
   * Goes forward in the session history and opens the next file
   */
  public forward (): void {
    this._moveThroughHistory(1)
  }

  /**
   * Moves through history using the specified direction
   *
   * @param   {number}  direction  The direction to take. Negative = back, positive = forward
   */
  private _moveThroughHistory (direction: number): void {
    // Always make sure the session pointer is valid
    if (this._sessionPointer < 0 || this._sessionPointer > this._sessionHistory.length - 1) {
      this._sessionPointer = this._sessionHistory.length - 1
    }

    const targetIndex = this._sessionPointer + direction

    if (targetIndex > this._sessionHistory.length - 1 || targetIndex < 0) {
      return console.log('Out of bounds') // Cannot move: Out of bounds
    }

    // Move the pointer
    this._sessionPointer = targetIndex
    const pathToOpen = this._sessionHistory[this._sessionPointer]

    // Open that file, but tell the opener explicitly not to modify the state
    const previousActivePath = this._activeFile?.path ?? null
    if (this.openFile(pathToOpen, false)) {
      // Zettlr-LYH (R90): Navigating back or forward does not change the
      // session history, but it is a user activation of that tab
      this._recordActivation(pathToOpen, previousActivePath)
    }
  }

  /**
   * Sets the pinned status for the given file.
   *
   * @param   {string}   filePath        The absolute path to the file
   * @param   {boolean}  shouldBePinned  Whether the file should be pinned.
   */
  public setPinnedStatus (filePath: string, shouldBePinned: boolean): void {
    const idx = this._openFiles.findIndex(doc => doc.path === filePath)
    if (idx > -1) {
      this._openFiles[idx].pinned = shouldBePinned
      this.movePinnedTabsLeft()
    }
  }

  // API METHODS

  /**
   * Returns a JSON serializable representation of the tab manager instance
   *
   * @return  {TabManagerJSON}     The JSON data
   */
  public toJSON (): TabManagerJSON {
    return {
      openFiles: this._openFiles,
      activeFile: this._activeFile
    }
  }
}
