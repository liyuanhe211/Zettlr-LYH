/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        buildOpenHistoryTree
 * CVM-Role:        Utility Function
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Turns the flat open history (an array of absolute paths,
 *                  most recently opened first) into the folder tree that the
 *                  Files section of the file manager displays. Folders that
 *                  form a single chain are merged into one row, and every
 *                  folder is sorted by how recently one of its files has been
 *                  opened. This module is a pure function: it neither talks to
 *                  IPC or Vue nor touches the filesystem, so it can be
 *                  unit-tested directly.
 *
 * END HEADER
 */

/**
 * A file that appears in the open history.
 */
export interface HistoryTreeFileNode {
  type: 'file'
  /** 文件的绝对路径 */
  path: string
  /** 文件名，含扩展名 */
  name: string
  /** 该文件在打开历史数组里的下标；0 表示最近打开 */
  recency: number
}

/**
 * A folder row of the tree. A row may stand for several nested folders at once
 * whenever those folders form a single chain (see the merging rule below).
 */
export interface HistoryTreeFolderNode {
  type: 'folder'
  /** 本行代表的文件夹的绝对路径；合并单链时取链条末端那个文件夹的路径 */
  path: string
  /** 界面上显示的文字；合并单链时是用路径分隔符连起来的若干段 */
  label: string
  /** 组成 label 的各段，从浅到深 */
  segments: string[]
  /** 子节点，已按本规范的排序规则排好 */
  children: HistoryTreeNode[]
  /** 本分支内全部文件节点 recency 的最小值 */
  recency: number
}

export type HistoryTreeNode = HistoryTreeFileNode | HistoryTreeFolderNode

/**
 * The mutable counterpart of HistoryTreeFolderNode that is used while the
 * prefix tree is being assembled. It keeps folder and file children apart so
 * that inserting a path is a plain map lookup.
 */
interface FolderNodeBuilder {
  segments: string[]
  path: string
  folderChildren: Map<string, FolderNodeBuilder>
  fileChildren: Map<string, HistoryTreeFileNode>
}

/**
 * Determines which path separator the given history uses: as soon as a single
 * path contains a backslash, the whole history is treated as Windows paths.
 *
 * @param   {string[]}  historyPaths  The open history
 *
 * @return  {string}                  Either a backslash or a forward slash
 */
function detectSeparator (historyPaths: string[]): string {
  return historyPaths.some(historyPath => historyPath.includes('\\')) ? '\\' : '/'
}

/**
 * Splits a path into its segments, with the first segment being the root of
 * the path. POSIX roots yield an empty first segment (standing for "/"),
 * Windows roots yield a drive segment such as "E:", and UNC paths yield two
 * empty segments up front which are folded into a single "\\server\share"
 * segment.
 *
 * @param   {string}  fullPath   The path to split
 * @param   {string}  separator  The path separator in use
 *
 * @return  {string[]}           The segments, root first
 */
function splitIntoSegments (fullPath: string, separator: string): string[] {
  const rawSegments = fullPath.split(separator)

  const isUncPath = separator === '\\' &&
    rawSegments.length >= 4 &&
    rawSegments[0] === '' &&
    rawSegments[1] === '' &&
    rawSegments[2] !== ''

  if (isUncPath) {
    const uncRoot = `${separator}${separator}${rawSegments[2]}${separator}${rawSegments[3]}`
    return [ uncRoot, ...rawSegments.slice(4) ]
  }

  return rawSegments
}

/**
 * Computes the path of a root node. An empty root segment is the POSIX root
 * directory, a drive segment such as "E:" becomes the drive's root directory
 * "E:\", and anything else (a UNC share, or the first segment of a relative
 * path) is used as it stands.
 *
 * @param   {string}  rootSegment  The first segment of a path
 * @param   {string}  separator    The path separator in use
 *
 * @return  {string}               The path of the corresponding root node
 */
function buildRootPath (rootSegment: string, separator: string): string {
  if (rootSegment === '') {
    return separator
  }

  if (rootSegment.endsWith(':')) {
    return rootSegment + separator
  }

  return rootSegment
}

/**
 * Appends a segment to a folder path, taking care not to double the separator
 * after a root path that already ends in one.
 *
 * @param   {string}  parentPath  The path of the parent folder
 * @param   {string}  name        The name of the child
 * @param   {string}  separator   The path separator in use
 *
 * @return  {string}              The path of the child
 */
function appendSegment (parentPath: string, name: string, separator: string): string {
  return parentPath.endsWith(separator) ? parentPath + name : parentPath + separator + name
}

/**
 * Renders the label of a folder row from its segments. The POSIX root is the
 * only node whose segments join into an empty string; it displays as "/".
 *
 * @param   {string[]}  segments   The segments of the folder row
 * @param   {string}    separator  The path separator in use
 *
 * @return  {string}               The text to display
 */
function buildLabel (segments: string[], separator: string): string {
  const label = segments.join(separator)
  return label === '' ? separator : label
}

/**
 * Creates an empty builder for a folder node.
 *
 * @param   {string[]}  segments  The segments of that folder
 * @param   {string}    path      The absolute path of that folder
 *
 * @return  {FolderNodeBuilder}   The builder
 */
function createFolderNodeBuilder (segments: string[], path: string): FolderNodeBuilder {
  return { segments, path, folderChildren: new Map(), fileChildren: new Map() }
}

/**
 * Turns a builder and everything below it into finished tree nodes: the
 * children are finalized first, then single chains are merged into this row,
 * then the children are sorted by recency and this row's recency is derived
 * from them.
 *
 * @param   {FolderNodeBuilder}      builder    The folder to finalize
 * @param   {string}                 separator  The path separator in use
 *
 * @return  {HistoryTreeFolderNode}             The finished folder node
 */
function finalizeFolderNode (builder: FolderNodeBuilder, separator: string): HistoryTreeFolderNode {
  const children: HistoryTreeNode[] = []

  for (const folderChild of builder.folderChildren.values()) {
    children.push(finalizeFolderNode(folderChild, separator))
  }

  for (const fileChild of builder.fileChildren.values()) {
    children.push(fileChild)
  }

  children.sort((first, second) => first.recency - second.recency)

  // Merge single chains: as long as this row has exactly one child and that
  // child is a folder (which also means this row has no file children), the
  // child is pulled into this row. Since the children have been finalized
  // already, they have merged their own chains, but the loop keeps the rule
  // self-contained.
  let segments = builder.segments
  let path = builder.path
  let resolvedChildren = children

  while (resolvedChildren.length === 1) {
    const onlyChild = resolvedChildren[0]

    if (onlyChild.type !== 'folder') {
      break
    }

    segments = [ ...segments, ...onlyChild.segments ]
    path = onlyChild.path
    resolvedChildren = onlyChild.children
  }

  return {
    type: 'folder',
    path,
    label: buildLabel(segments, separator),
    segments,
    children: resolvedChildren,
    recency: Math.min(...resolvedChildren.map(child => child.recency))
  }
}

/**
 * Builds the folder tree that the Files section displays from the open
 * history. The top level always consists of folder nodes: even a history with
 * a single file returns the folder that file lives in, with the file as its
 * only child.
 *
 * Paths that do not contain a folder part, that end in a separator, or that
 * are empty are skipped, as are repeated occurrences of the same path (only
 * the most recent one is kept). Should a name be used by both a file and a
 * folder within the same directory — which cannot happen on a real filesystem,
 * but a stale history entry might claim it — the folder wins and the file is
 * dropped.
 *
 * @param   {string[]}  historyPaths  The open history, most recently opened at
 *                                    index 0; that index is the file's recency
 * @param   {string}    separator     The path separator to split on. Defaults
 *                                    to a backslash if any path contains one,
 *                                    and to a forward slash otherwise
 *
 * @return  {HistoryTreeFolderNode[]} The top level of the tree, sorted by
 *                                    recency, most recent first
 */
export function buildOpenHistoryTree (
  historyPaths: string[],
  separator?: string
): HistoryTreeFolderNode[] {
  const pathSeparator = separator ?? detectSeparator(historyPaths)
  const rootBuilders = new Map<string, FolderNodeBuilder>()
  const seenPaths = new Set<string>()

  for (let recency = 0; recency < historyPaths.length; recency++) {
    const fullPath = historyPaths[recency]

    if (typeof fullPath !== 'string' || fullPath === '' || seenPaths.has(fullPath)) {
      continue
    }

    const segments = splitIntoSegments(fullPath, pathSeparator)

    // A path ending in a separator denotes a folder, not a file, and a path
    // without any separator has no folder to hang the file in.
    if (segments.length < 2 || segments[segments.length - 1] === '') {
      continue
    }

    const rootSegment = segments[0]
    // Empty segments in the middle stem from doubled separators and carry no
    // folder of their own.
    const remainingSegments = segments.slice(1).filter(segment => segment !== '')

    if (remainingSegments.length === 0) {
      continue
    }

    const fileName = remainingSegments[remainingSegments.length - 1]
    const folderNames = remainingSegments.slice(0, -1)

    const existingRootBuilder = rootBuilders.get(rootSegment)
    let currentBuilder: FolderNodeBuilder

    if (existingRootBuilder !== undefined) {
      currentBuilder = existingRootBuilder
    } else {
      currentBuilder = createFolderNodeBuilder([rootSegment], buildRootPath(rootSegment, pathSeparator))
      rootBuilders.set(rootSegment, currentBuilder)
    }

    for (const folderName of folderNames) {
      const existingChildBuilder = currentBuilder.folderChildren.get(folderName)
      let childBuilder: FolderNodeBuilder

      if (existingChildBuilder !== undefined) {
        childBuilder = existingChildBuilder
      } else {
        childBuilder = createFolderNodeBuilder(
          [folderName],
          appendSegment(currentBuilder.path, folderName, pathSeparator)
        )
        currentBuilder.folderChildren.set(folderName, childBuilder)
        // A folder always wins over a file of the same name.
        currentBuilder.fileChildren.delete(folderName)
      }

      currentBuilder = childBuilder
    }

    seenPaths.add(fullPath)

    if (currentBuilder.folderChildren.has(fileName) || currentBuilder.fileChildren.has(fileName)) {
      continue
    }

    currentBuilder.fileChildren.set(fileName, {
      type: 'file',
      path: appendSegment(currentBuilder.path, fileName, pathSeparator),
      name: fileName,
      recency
    })
  }

  const topLevelNodes: HistoryTreeFolderNode[] = []

  for (const rootBuilder of rootBuilders.values()) {
    topLevelNodes.push(finalizeFolderNode(rootBuilder, pathSeparator))
  }

  topLevelNodes.sort((first, second) => first.recency - second.recency)

  return topLevelNodes
}

/**
 * Collects the folder rows that have to be uncollapsed for the given files to
 * be on screen. A row counts as an ancestor of a file whenever the file sits
 * somewhere below it, which — because a row may stand for a whole chain of
 * merged folders — cannot be derived from the paths alone and has to be read
 * off the finished tree.
 *
 * Files that the tree does not contain contribute nothing; the caller does not
 * have to filter its wish list first.
 *
 * @param   {HistoryTreeFolderNode[]}  rootNodes  The top level of the tree
 * @param   {Iterable<string>}         filePaths  The files to reveal
 *
 * @return  {string[]}                            The paths of the folder rows
 *                                                to uncollapse, outermost row
 *                                                first and without duplicates
 */
export function collectFoldersRevealingFiles (
  rootNodes: HistoryTreeFolderNode[],
  filePaths: Iterable<string>
): string[] {
  const wantedPaths = new Set(filePaths)
  const foldersToUncollapse: string[] = []
  const alreadyCollected = new Set<string>()

  const visit = (node: HistoryTreeNode, ancestorPaths: string[]): void => {
    if (node.type === 'file') {
      if (!wantedPaths.has(node.path)) {
        return
      }

      for (const ancestorPath of ancestorPaths) {
        if (!alreadyCollected.has(ancestorPath)) {
          alreadyCollected.add(ancestorPath)
          foldersToUncollapse.push(ancestorPath)
        }
      }

      return
    }

    const pathsIncludingThisRow = [ ...ancestorPaths, node.path ]

    for (const child of node.children) {
      visit(child, pathsIncludingThisRow)
    }
  }

  for (const rootNode of rootNodes) {
    visit(rootNode, [])
  }

  return foldersToUncollapse
}
