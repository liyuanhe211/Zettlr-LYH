/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Item Mixin
 * CVM-Role:        Utility Function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file contains a composable that manages a little bit of
 *                  state that is handled identically for both TreeItems and
 *                  FileItems.
 *
 * END HEADER
 */

import { displayFileContext } from './file-item-context'
import { displayDirContext } from './dir-item-context'
import { useConfigStore, useDocumentTreeStore, useWindowStateStore, useWorkspaceStore } from 'source/pinia'
import type { AnyDescriptor } from 'source/types/common/fsal'
import { ref, computed, type Ref, watch, nextTick, onBeforeUnmount } from 'vue'
import { hasImageExt, hasPDFExt } from 'source/common/util/file-extention-checks'
import makeValidUri from 'source/common/util/make-valid-uri'
import type { DocumentManagerIPCAPI } from 'source/app/service-providers/documents'
import { createSlowClickRename, SLOW_CLICK_RENAME_DELAY } from '../../util/slow-click-rename'

const ipcRenderer = window.ipc

// Zettlr-LYH slow click rename (R101): when the window last came to the front,
// since the click doing that does not count. One listener serves every item.
let lastWindowFocusTime = Number.NEGATIVE_INFINITY
let windowFocusTracked = false

function trackWindowFocus (): void {
  if (windowFocusTracked) {
    return
  }

  window.addEventListener('focus', () => { lastWindowFocusTime = Date.now() })
  windowFocusTracked = true
}

/**
 * Whether the window had the focus before the current press. The press that
 * brings the window to the front arrives right after the focus event, so a
 * press within the double click time of that event does not count.
 *
 * @return  {boolean}  True if the window was focused already
 */
function windowHadFocus (): boolean {
  return document.hasFocus() && Date.now() - lastWindowFocusTime >= SLOW_CLICK_RENAME_DELAY
}

/**
 * Close a file root path at `path`, including all open
 * instances of the file.
 *
 * @param {string}  path    The filepath to close
 */
export function closeFile (path: string): void {
  const workspaceStore = useWorkspaceStore()

  // First check if the path is actually a root path
  if (!workspaceStore.rootDescriptors.find(r => r.path === path)) {
    return
  }

  ipcRenderer.invoke('documents-provider', {
    command: 'close-file-everywhere',
    payload: { path }
  } as DocumentManagerIPCAPI)
    .catch(e => console.error(e))

  ipcRenderer.invoke('application', {
    command: 'root-close',
    payload: path
  })
    .catch(err => console.error(err))
}

/**
 * Close a workspace root path at `path`, including all open files
 * within the workspace
 *
 * @param {string}  path    The workspace path to close
 */
export function closeWorkspace (path: string): void {
  const workspaceStore = useWorkspaceStore()

  // First check if the path is actually a root path
  if (!workspaceStore.rootDescriptors.find(r => r.path === path)) {
    return
  }

  ipcRenderer.invoke('documents-provider', {
    command: 'get-open-workspace-files',
    payload: {
      path: path,
    }
  } as DocumentManagerIPCAPI)
    .then(openFiles => {
      for (const file of openFiles) {
        ipcRenderer.invoke('documents-provider', {
          command: 'close-file-everywhere',
          payload: { path: file }
        } as DocumentManagerIPCAPI)
          .catch(e => console.error(e))
      }
    })
    .catch(e => console.error(e))

  ipcRenderer.invoke('application', {
    command: 'root-close',
    payload: path
  })
    .catch(err => console.error(err))
}

export function useItemComposable (
  object: AnyDescriptor,
  rootElement: Ref<HTMLElement|null>,
  windowId: string,
  nameEditingInput: Ref<HTMLInputElement|null>
) {
  const obj = ref(object)
  const nameEditing = ref<boolean>(false)
  const showPopover = ref<boolean>(false)
  const operationType = ref<'createFile'|'createDir'|undefined>(undefined)

  const configStore = useConfigStore()
  const documentTreeStore = useDocumentTreeStore()
  const windowStateStore = useWindowStateStore()

  const isDirectory = computed(() => obj.value.type === 'directory')
  const selectedFile = computed(() => documentTreeStore.lastLeafActiveFile)
  const selectedDir = computed(() => configStore.config.openDirectory)

  // Zettlr-LYH slow click rename (R101): clicking the name of the selected
  // file once more opens the inline rename field. Directories are left alone.
  const isSelectedFile = computed(() => obj.value.type !== 'directory' && selectedFile.value?.path === obj.value.path)
  // The name element of the latest press
  let slowClickNameElement: HTMLElement|null = null

  const slowClickRename = createSlowClickRename({
    onRename: () => {
      if (isSelectedFile.value && !nameEditing.value) {
        nameEditing.value = true
      }
    },
    onActiveChange: followWindowDuringSlowClick
  })

  trackWindowFocus()

  // Losing the selection ends a slow click
  watch(isSelectedFile, selected => {
    if (!selected) {
      slowClickRename.cancel()
    }
  })

  onBeforeUnmount(() => {
    slowClickRename.cancel()
  })

  watch(nameEditing, (newVal) => {
    if (!newVal) {
      return // No need to select
    }

    nextTick().then(() => {
      if (nameEditingInput.value === null) {
        return
      }
      nameEditingInput.value.focus()
      const lastDot = nameEditingInput.value.value.lastIndexOf('.')
      nameEditingInput.value.setSelectionRange(0, lastDot)
    })
      .catch(err => console.error(err))
  })

  /**
   * Requests a file or directory to be selected and sends an appropriate
   * request to main.
   *
   * @param   {KeyboardEvent|MouseEvent}  event  The triggering event
   */
  function requestSelection (event: MouseEvent): void {
    // Dead directories can't be opened, so stop the propagation to
    // the file manager and don't do a thing.
    if (obj.value.type === 'directory' && obj.value.dirNotFoundFlag === true) {
      return event.stopPropagation()
    }

    if (event.button === 2) {
      return // The user requested a context menu
    }

    // Determine if we have a middle (wheel) click. The event-type check is
    // necessary since the left mouse button will have index 1 on click events,
    // whereas the middle mouse button will also have index 1, but on auxclick
    // events.
    const middleClick = (event.type === 'auxclick' && event.button === 1)
    const alt = event.altKey
    const type = obj.value.type

    if (middleClick) {
      event.preventDefault() // Otherwise, on Windows we'd have a middle-click-scroll
    }

    if ([ 'file', 'code' ].includes(type)) {
      // Request the clicked file
      ipcRenderer.invoke('documents-provider', {
        command: 'open-file',
        payload: {
          path: obj.value.path,
          windowId,
          leafId: documentTreeStore.lastLeafId,
          newTab: middleClick || (alt && type === 'file'), // Force a new tab in this case.
          // Zettlr-LYH open-with disk check (R51): an explicit open from the
          // file manager catches external changes the watcher missed
          checkAgainstDisk: true,
          insertAfterActiveTab: true
        }
      } as DocumentManagerIPCAPI)
        .then(() => {
          configStore.setConfigValue('openDirectory', obj.value.dir)
          // Finally, since it's a directory, uncollapse it.
          if (!windowStateStore.uncollapsedDirectories.includes(obj.value.dir)) {
            windowStateStore.uncollapsedDirectories.push(obj.value.dir)
          }
        })
        .catch(e => console.error(e))
    } else if (type === 'other') {
      const { files } = configStore.config
      // Determine if we can open the file in Zettlr
      if (
        (hasImageExt(obj.value.path) && files.images.openWith === 'zettlr') ||
        (hasPDFExt(obj.value.path) && files.pdf.openWith === 'zettlr')
      ) {
        ipcRenderer.invoke('documents-provider', {
          command: 'open-file',
          // We leave leafId undefined
          payload: { path: obj.value.path, windowId, insertAfterActiveTab: true }
        })
          .then(() => {
            configStore.setConfigValue('openDirectory', obj.value.dir)
            // Finally, since it's a directory, uncollapse it.
            if (!windowStateStore.uncollapsedDirectories.includes(obj.value.dir)) {
              windowStateStore.uncollapsedDirectories.push(obj.value.dir)
            }
          })
          .catch(e => console.error(e))
      } else {
        // Open the file externally (again, NOTE, this only works because main
        // intercepts every navigation attempt).
        window.location.href = makeValidUri(obj.value.path)
      }
    } else if (alt) {
      // Select the parent directory
      configStore.setConfigValue('openDirectory', obj.value.dir)
    } else if (type === 'directory') {
      configStore.setConfigValue('openDirectory', obj.value.path)
      // Finally, since it's a directory, uncollapse it.
      if (!windowStateStore.uncollapsedDirectories.includes(obj.value.path)) {
        windowStateStore.uncollapsedDirectories.push(obj.value.path)
      }
    }
  }

  /**
   * Handles a context menu on a file or directory item.
   *
   * @param   {MouseEvent}  event  The triggering contextmenu event
   */
  function handleContextMenu (event: MouseEvent): void {
    if (rootElement.value === null) {
      return
    }

    if (obj.value.type === 'directory') {
      displayDirContext(event, obj.value, rootElement.value, clickedID => {
        if (clickedID === 'menu.rename_dir') {
          nameEditing.value = true
        } else if (clickedID === 'menu.new_file') {
          operationType.value = 'createFile'
        } else if (clickedID === 'menu.new_dir') {
          operationType.value = 'createDir'
        } else if (clickedID === 'menu.delete_dir') {
          ipcRenderer.invoke('application', {
            command: 'dir-delete',
            payload: { path: obj.value.path }
          })
            .catch(err => console.error(err))
        } else if (clickedID === 'menu.close_workspace') {
          closeWorkspace(obj.value.path)
        } else if (clickedID === 'menu.project_build') {
          // We should trigger an export of this project.
          ipcRenderer.invoke('application', {
            command: 'dir-project-export',
            payload: obj.value.path
          })
            .catch(err => console.error(err))
        } else if (clickedID === 'menu.properties') {
          showPopover.value = true
        }
      })
    } else {
      displayFileContext(event, obj.value, rootElement.value, clickedID => {
        if (clickedID === 'new-tab') {
          // Request the clicked file, explicitly in a new tab
          ipcRenderer.invoke('documents-provider', {
            command: 'open-file',
            payload: {
              path: obj.value.path,
              windowId,
              newTab: true,
              checkAgainstDisk: true, // Zettlr-LYH open-with disk check (R51)
              insertAfterActiveTab: true
            }
          } as DocumentManagerIPCAPI)
            .catch(e => console.error(e))
        } else if (clickedID === 'menu.rename_file') {
          nameEditing.value = true
        } else if (clickedID === 'menu.duplicate_file') {
          ipcRenderer.invoke('application', {
            command: 'file-duplicate',
            payload: {
              path: obj.value.path,
              windowId,
              leafId: documentTreeStore.lastLeafId
            }
          })
            .catch(err => console.error(err))
        } else if (clickedID === 'menu.delete_file') {
          ipcRenderer.invoke('application', {
            command: 'file-delete',
            payload: { path: obj.value.path }
          })
            .catch(err => console.error(err))
        } else if (clickedID === 'properties') {
          showPopover.value = true
        } else if (clickedID === 'menu.close_file') {
          closeFile(obj.value.path)
        }
      })
    }
  }

  /**
   * Is called during drag operations.
   *
   * @param   {DragEvent}  event  The drag event.
   */
  function onDragHandler (event: DragEvent): void {
    if (obj.value.type === 'directory') {
      return // Directories cannot be dragged out of the app
    }

    // If the drag x/y-coordinates are about to leave the window, we
    // have to continue the drag in the main process (as it's being
    // dragged out of the window)
    const x = Number(event.x)
    const y = Number(event.y)
    const w = window.innerWidth
    const h = window.innerHeight

    if (x === 0 || y === 0 || x === w || y === h) {
      event.stopPropagation()
      event.preventDefault()

      ipcRenderer.send('window-controls', {
        command: 'drag-start',
        payload: { filePath: obj.value.path }
      })
    }
  }

  /**
   * Called when the user finishes renaming the represented item
   *
   * @param   {string}  newName  The new name given to the file or directory
   */
  function finishNameEditing (newName: string): void {
    if (newName === obj.value.name) {
      return // Not changed
    }

    const command = (obj.value.type === 'directory') ? 'dir-rename' : 'file-rename'

    ipcRenderer.invoke('application', {
      command,
      payload: {
        path: obj.value.path,
        name: newName
      }
    })
      .catch(e => console.error(e))
      .finally(() => { nameEditing.value = false })
  }

  function updateObject (newObject: AnyDescriptor): void {
    if (newObject.path !== obj.value.path) {
      // A recycled list item now shows another file (R101)
      slowClickRename.cancel()
    }
    obj.value = newObject
  }

  /**
   * A press on the name of a file may become a slow click rename if the file
   * was selected already (R101).
   *
   * @param  {MouseEvent}  event  The mousedown event on the name element
   */
  function handleNameMouseDown (event: MouseEvent): void {
    if (obj.value.type === 'directory' || nameEditing.value) {
      return
    }

    slowClickNameElement = event.currentTarget as HTMLElement|null
    slowClickRename.pointerDown({
      button: event.button,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      x: event.clientX,
      y: event.clientY,
      wasSelected: isSelectedFile.value,
      windowFocused: windowHadFocus()
    })
  }

  function handleSlowClickMouseMove (event: MouseEvent): void {
    slowClickRename.pointerMove(event.clientX, event.clientY)
  }

  /**
   * Hands the release of the left button to the slow click; it counts as
   * inside only on the pressed name element.
   *
   * @param  {MouseEvent}  event  The mouseup event anywhere in the window
   */
  function handleSlowClickMouseUp (event: MouseEvent): void {
    if (event.button !== 0) {
      return
    }

    const inside = slowClickNameElement !== null && slowClickNameElement.contains(event.target as Node|null)
    slowClickRename.pointerUp(event.clientX, event.clientY, inside)
  }

  function cancelSlowClickRename (): void {
    slowClickRename.cancel()
  }

  /**
   * Listens to the window while a slow click is being followed: pointer moves
   * and the release, plus everything that ends it, namely another press, a
   * key, the start of a drag and the window losing the focus. The press, key
   * and drag listeners capture, so that a press elsewhere is seen even if it
   * stops propagation, and so that they do not see the press that has just
   * added them.
   *
   * @param  {boolean}  active  True to start listening, false to stop
   */
  function followWindowDuringSlowClick (active: boolean): void {
    if (active) {
      window.addEventListener('mousemove', handleSlowClickMouseMove)
      window.addEventListener('mouseup', handleSlowClickMouseUp)
      window.addEventListener('mousedown', cancelSlowClickRename, true)
      window.addEventListener('keydown', cancelSlowClickRename, true)
      window.addEventListener('dragstart', cancelSlowClickRename, true)
      window.addEventListener('blur', cancelSlowClickRename)
    } else {
      window.removeEventListener('mousemove', handleSlowClickMouseMove)
      window.removeEventListener('mouseup', handleSlowClickMouseUp)
      window.removeEventListener('mousedown', cancelSlowClickRename, true)
      window.removeEventListener('keydown', cancelSlowClickRename, true)
      window.removeEventListener('dragstart', cancelSlowClickRename, true)
      window.removeEventListener('blur', cancelSlowClickRename)
    }
  }

  return {
    nameEditing,
    showPopover,
    operationType,
    onDragHandler,
    handleContextMenu,
    requestSelection,
    handleNameMouseDown,
    finishNameEditing,
    isDirectory,
    selectedFile,
    selectedDir,
    updateObject
  }
}
