/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Unopened directory contents
 * CVM-Role:        Utility Function
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     The open history tree can display, on demand, the files and
 *                  folders of a directory that have never been opened. This
 *                  module holds the window-wide cache of those directory
 *                  listings, reads them from disk when a directory is expanded
 *                  for the first time, and derives both the grey child rows and
 *                  the flat list of visible rows from that cache. Both
 *                  HistoryTree.vue (which needs the flat list for the arrow key
 *                  navigation) and HistoryTreeItem.vue (which renders the rows)
 *                  use the functions in here so that the two always agree on
 *                  what is currently visible.
 *
 * END HEADER
 */

import { ref } from 'vue'
import type { AnyDescriptor } from 'source/types/common/fsal'
import type {
  HistoryTreeFileNode,
  HistoryTreeFolderNode,
  HistoryTreeNode
} from 'source/common/util/open-history-tree'
import { isWin32Path, pathDirname } from 'source/common/util/renderer-path-polyfill'
import type { FSALEventPayload, FSALEventPayloadChange } from 'source/app/service-providers/fsal'

const ipcRenderer = window.ipc

/**
 * A grey row: the synthesised history tree node that is being rendered plus the
 * descriptor it originates from. The descriptor is required for the file
 * context menu and to tell Markdown files from code files.
 */
export interface UnopenedChild {
  node: HistoryTreeNode
  descriptor: AnyDescriptor
}

/**
 * Directory listings read from disk, keyed by the absolute directory path. The
 * cache is never cleared when a directory is collapsed again -- re-expanding a
 * directory must not hit the disk a second time. Entries are only dropped when
 * the file system watcher reports a change inside the directory.
 */
const directoryContents = ref(new Map<string, AnyDescriptor[]>())

/**
 * Directories whose listing is currently being read, so that a second request
 * arriving before the first one resolves does not read the disk twice.
 */
const directoriesBeingRead = new Set<string>()

/**
 * The grey file the user has selected with a single click. Grey files only open
 * on a double click, so a single click merely marks them.
 */
export const selectedUnopenedPath = ref<string|undefined>(undefined)

/**
 * Joins a directory path and the name of one of its children.
 *
 * @param   {string}  directoryPath  The absolute path of the directory
 * @param   {string}  childName      The name of the child
 *
 * @return  {string}                 The absolute path of the child
 */
export function joinDirectoryPath (directoryPath: string, childName: string): string {
  const separator = isWin32Path(directoryPath) ? '\\' : '/'
  return directoryPath.endsWith(separator)
    ? `${directoryPath}${childName}`
    : `${directoryPath}${separator}${childName}`
}

/**
 * Returns true if the contents of the given directory are already cached.
 *
 * @param   {string}   directoryPath  The absolute path of the directory
 *
 * @return  {boolean}                 Whether the listing is available
 */
export function hasDirectoryContents (directoryPath: string): boolean {
  return directoryContents.value.has(directoryPath)
}

/**
 * Reads the contents of the given directory from disk, unless they are already
 * cached or currently being read.
 *
 * @param  {string}  directoryPath  The absolute path of the directory
 */
export function loadDirectoryContents (directoryPath: string): void {
  if (directoryContents.value.has(directoryPath) || directoriesBeingRead.has(directoryPath)) {
    return
  }

  directoriesBeingRead.add(directoryPath)

  ipcRenderer.invoke('fsal', { command: 'read-directory', payload: directoryPath })
    .then((children: AnyDescriptor[]) => {
      directoryContents.value.set(directoryPath, children)
    })
    .catch(error => {
      console.error(`[HistoryTree] Could not read the contents of "${directoryPath}"`, error)
    })
    .finally(() => {
      directoriesBeingRead.delete(directoryPath)
    })
}

/**
 * Returns the set of absolute paths that the history children of the given
 * folder node occupy directly inside that folder. For a merged single chain
 * child (a child folder node whose label spans several path segments) this is
 * the first of those segments, because that is the entry the directory listing
 * will contain.
 *
 * @param   {HistoryTreeFolderNode}  node  The folder node
 *
 * @return  {Set<string>}                  The direct child paths
 */
export function getHistoryChildPaths (node: HistoryTreeFolderNode): Set<string> {
  const result = new Set<string>()

  for (const child of node.children) {
    if (child.type === 'file') {
      result.add(child.path)
    } else {
      result.add(joinDirectoryPath(node.path, child.segments[0]))
    }
  }

  return result
}

/**
 * Returns the grey children of the given directory: every subdirectory that is
 * not already represented by a history node, plus every Markdown or code file
 * that is not in the open history. Anything else is dropped. Directories are
 * listed before files, both sorted by name.
 *
 * @param   {string}            directoryPath      The absolute directory path
 * @param   {Set<string>}       historyChildPaths  Paths already shown as history rows
 * @param   {Set<string>}       openHistoryPaths   The entire open history
 *
 * @return  {UnopenedChild[]}                      The grey children
 */
export function getUnopenedChildren (
  directoryPath: string,
  historyChildPaths: Set<string>,
  openHistoryPaths: Set<string>
): UnopenedChild[] {
  const contents = directoryContents.value.get(directoryPath)

  if (contents === undefined) {
    return []
  }

  const directories: AnyDescriptor[] = []
  const files: AnyDescriptor[] = []

  for (const child of contents) {
    if (child.type === 'directory') {
      if (!historyChildPaths.has(child.path)) {
        directories.push(child)
      }
    } else if (child.type === 'file' || child.type === 'code') {
      if (!historyChildPaths.has(child.path) && !openHistoryPaths.has(child.path)) {
        files.push(child)
      }
    }
    // Descriptors of type "other" are never displayed in the open history tree.
  }

  const byName = (one: AnyDescriptor, other: AnyDescriptor): number => {
    return one.name.localeCompare(other.name, undefined, { numeric: true, sensitivity: 'base' })
  }

  directories.sort(byName)
  files.sort(byName)

  return [ ...directories, ...files ].map(descriptor => ({
    node: descriptorToHistoryTreeNode(descriptor),
    descriptor
  }))
}

/**
 * Turns a descriptor read from disk into the history tree node shape that
 * HistoryTreeItem renders. Grey rows have no meaningful recency, so they sort
 * last everywhere.
 *
 * @param   {AnyDescriptor}    descriptor  The descriptor
 *
 * @return  {HistoryTreeNode}              The synthesised node
 */
function descriptorToHistoryTreeNode (descriptor: AnyDescriptor): HistoryTreeNode {
  if (descriptor.type === 'directory') {
    const folderNode: HistoryTreeFolderNode = {
      type: 'folder',
      path: descriptor.path,
      label: descriptor.name,
      segments: [descriptor.name],
      children: [],
      recency: Number.MAX_SAFE_INTEGER
    }
    return folderNode
  }

  const fileNode: HistoryTreeFileNode = {
    type: 'file',
    path: descriptor.path,
    name: descriptor.name,
    recency: Number.MAX_SAFE_INTEGER
  }
  return fileNode
}

/**
 * Walks the open history tree exactly as HistoryTreeItem renders it and returns
 * every currently visible row as a `[path, type]` pair. FileTree.vue feeds this
 * into the flat list that drives the arrow key navigation of the entire file
 * manager, so the walk must follow the same collapse and grey content rules as
 * the components do.
 *
 * @param   {HistoryTreeNode[]}  nodes                             The root nodes
 * @param   {string[]}           uncollapsedDirectories            Uncollapsed folders
 * @param   {string[]}           directoriesShowingUnopenedContent Folders showing grey rows
 * @param   {Set<string>}        openHistoryPaths                  The entire open history
 * @param   {boolean}            filterActive                      Whether a filter query is active
 *
 * @return  {Array<[string, string]>}                              The visible rows
 */
export function collectVisibleRows (
  nodes: HistoryTreeNode[],
  uncollapsedDirectories: string[],
  directoriesShowingUnopenedContent: string[],
  openHistoryPaths: Set<string>,
  filterActive: boolean
): Array<[string, string]> {
  const rows: Array<[string, string]> = []

  const walk = (node: HistoryTreeNode, descriptorType?: string): void => {
    if (node.type === 'file') {
      rows.push([ node.path, descriptorType ?? 'file' ])
      return
    }

    rows.push([ node.path, 'directory' ])

    const collapsed = !filterActive && !uncollapsedDirectories.includes(node.path)
    if (collapsed) {
      return
    }

    for (const child of node.children) {
      walk(child)
    }

    // While a filter query is active, the tree only shows matching history
    // files, so no grey rows are rendered at all.
    if (filterActive || !directoriesShowingUnopenedContent.includes(node.path)) {
      return
    }

    const unopenedChildren = getUnopenedChildren(
      node.path,
      getHistoryChildPaths(node),
      openHistoryPaths
    )

    for (const child of unopenedChildren) {
      walk(child.node, child.descriptor.type)
    }
  }

  for (const node of nodes) {
    walk(node)
  }

  return rows
}

// Drop cached listings whenever the file system watcher reports a change, so
// that the grey rows do not go stale over a long running session.
ipcRenderer.on('fsal-event', (_event, payload: FSALEventPayload) => {
  const affectedPath = payload.event === 'unlink' || payload.event === 'unlinkDir'
    ? payload.path
    : (payload as FSALEventPayloadChange).descriptor.path

  directoryContents.value.delete(affectedPath)
  directoryContents.value.delete(pathDirname(affectedPath))
})
