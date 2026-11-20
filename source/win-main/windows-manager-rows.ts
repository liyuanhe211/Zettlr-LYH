/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Rows, sorting and selection of the Windows dialog
 * CVM-Role:        Utility functions
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH Windows dialog (R72): pure helpers behind the
 *                  window manager dialog of the Window menu. They build one row
 *                  per open file of the main window (in pane order, then tab
 *                  order; a file open in several panes is one row that knows
 *                  all its panes), derive the document type shown in the Type
 *                  column, format the modification time, sort the rows by a
 *                  column, compute Shift range selections, choose the pane
 *                  Activate switches to, and derive the per-pane tab orders
 *                  that "Sort tabs" applies. This module imports nothing
 *                  at runtime, so that it stays unit-testable outside of a
 *                  renderer process.
 *
 * END HEADER
 */

/**
 * The columns of the dialog's table
 */
export type WindowsManagerColumn = 'name'|'path'|'type'|'size'|'modtime'

/**
 * The direction a column is sorted in
 */
export type WindowsManagerSortDirection = 'ascending'|'descending'

/**
 * The sort state of the table; column undefined means the tab order
 */
export interface WindowsManagerSortState {
  column: WindowsManagerColumn|undefined
  direction: WindowsManagerSortDirection
}

/**
 * The part of an editor pane (a document tree leaf) the rows are built from
 */
export interface WindowsManagerLeafInput {
  id: string
  openFiles: Array<{ path: string, pinned: boolean }>
}

/**
 * The part of a file descriptor the rows use (size and modification time
 * from the disk, and the FSAL's file type)
 */
export interface WindowsManagerFileMetadata {
  size: number
  modtime: number
  type?: string
}

/**
 * One row of the dialog, i.e. one open file (Zettlr-LYH Windows dialog (R72): counted
 * per file; a file open in several panes is a single row)
 */
export interface WindowsManagerRow {
  /**
   * Unique per file: the path
   */
  key: string
  /**
   * The panes showing the file, in pane order
   */
  leafIds: string[]
  path: string
  /**
   * The file name, without the unsaved-changes marker
   */
  name: string
  /**
   * The file name as shown, with a trailing * if the file has unsaved changes
   */
  displayName: string
  modified: boolean
  /**
   * True if the file is pinned in at least one of its panes
   */
  pinned: boolean
  /**
   * The document type shown in the Type column
   */
  type: string
  /**
   * The size on disk in bytes, undefined if unknown
   */
  size: number|undefined
  /**
   * The modification time on disk (milliseconds), undefined if unknown
   */
  modtime: number|undefined
  /**
   * The position of the file's first tab across all panes (pane order, then
   * tab order), counted in files
   */
  tabOrder: number
}

const MARKDOWN_EXTENSIONS = [ '.md', '.rmd', '.qmd', '.markdown', '.txt', '.mdx', '.mkd' ]
const IMAGE_EXTENSIONS = [ '.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.bmp', '.tiff' ]

// The labels of the code file types Zettlr edits, by extension
const CODE_TYPE_LABELS: Record<string, string> = {
  '.tex': 'LaTeX',
  '.latex': 'LaTeX',
  '.yaml': 'YAML',
  '.yml': 'YAML',
  '.json': 'JSON',
  '.jsonl': 'JSON Lines',
  '.dic': 'Dictionary'
}

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * Returns the file name of a path; both kinds of path separators are accepted.
 *
 * @param   {string}  filePath  The path
 *
 * @return  {string}            The file name
 */
export function fileNameFromPath (filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1]
}

/**
 * Returns the lower-case extension of a path including the dot, or an empty
 * string if the file name has none.
 *
 * @param   {string}  filePath  The path
 *
 * @return  {string}            The extension
 */
export function fileExtension (filePath: string): string {
  const name = fileNameFromPath(filePath)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

/**
 * Derives the document type shown in the Type column: Markdown for Markdown
 * files, the language for the code files Zettlr edits, the viewer's category
 * (Image, PDF) for files shown in a viewer, and otherwise the upper-case
 * extension (or File if there is none).
 *
 * @param   {string}                     filePath        The path
 * @param   {string|undefined}           descriptorType  The FSAL descriptor type, if known
 * @param   {(label: string) => string}  translate       Translates the generic labels
 *
 * @return  {string}                                     The type
 */
export function deriveDocumentType (
  filePath: string,
  descriptorType?: string,
  translate: (label: string) => string = label => label
): string {
  const extension = fileExtension(filePath)
  if (MARKDOWN_EXTENSIONS.includes(extension)) {
    return 'Markdown'
  }
  if (extension in CODE_TYPE_LABELS) {
    const label = CODE_TYPE_LABELS[extension]
    return label === 'Dictionary' ? translate(label) : label
  }
  if (IMAGE_EXTENSIONS.includes(extension)) {
    return translate('Image')
  }
  if (extension === '.pdf') {
    return 'PDF'
  }
  if (descriptorType === 'file') {
    return 'Markdown'
  }
  if (extension !== '') {
    return extension.slice(1).toUpperCase()
  }
  return translate('File')
}

/**
 * Formats a modification time as YYYY-MM-DD HH:mm:ss in local time; an
 * unknown time gives an empty string.
 *
 * @param   {number|undefined}  modtime  The time in milliseconds
 *
 * @return  {string}                     The formatted time
 */
export function formatModificationTime (modtime: number|undefined): string {
  if (modtime === undefined || !Number.isFinite(modtime)) {
    return ''
  }
  const date = new Date(modtime)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * Builds one row per open file, in pane order and then tab order. A file open
 * in several panes is listed once, at its first tab, with all its panes
 * (Zettlr-LYH Windows dialog (R72)).
 *
 * @param   {WindowsManagerLeafInput[]}                leaves         The window's panes, in order
 * @param   {Map<string, WindowsManagerFileMetadata>}  metadata       Disk metadata by path
 * @param   {string[]}                                 modifiedPaths  Paths with unsaved changes
 * @param   {(label: string) => string}                translate      Translates the generic type labels
 *
 * @return  {WindowsManagerRow[]}                                     The rows
 */
export function buildWindowsManagerRows (
  leaves: WindowsManagerLeafInput[],
  metadata: Map<string, WindowsManagerFileMetadata>,
  modifiedPaths: string[],
  translate: (label: string) => string = label => label
): WindowsManagerRow[] {
  const modified = new Set(modifiedPaths)
  const rows: WindowsManagerRow[] = []
  const rowByPath = new Map<string, WindowsManagerRow>()
  for (const leaf of leaves) {
    for (const file of leaf.openFiles) {
      const existing = rowByPath.get(file.path)
      if (existing !== undefined) {
        if (!existing.leafIds.includes(leaf.id)) {
          existing.leafIds.push(leaf.id)
        }
        existing.pinned = existing.pinned || file.pinned
        continue
      }
      const name = fileNameFromPath(file.path)
      const isModified = modified.has(file.path)
      const fileMetadata = metadata.get(file.path)
      const row: WindowsManagerRow = {
        key: file.path,
        leafIds: [leaf.id],
        path: file.path,
        name,
        displayName: isModified ? `${name}*` : name,
        modified: isModified,
        pinned: file.pinned,
        type: deriveDocumentType(file.path, fileMetadata?.type, translate),
        size: fileMetadata?.size,
        modtime: fileMetadata?.modtime,
        tabOrder: rows.length
      }
      rows.push(row)
      rowByPath.set(file.path, row)
    }
  }
  return rows
}

/**
 * The pane Activate switches to for a row (Zettlr-LYH Windows dialog (R72)): the pane
 * that last had the focus if it shows the file, otherwise the file's first
 * pane.
 *
 * @param   {WindowsManagerRow}  row         The row
 * @param   {string|undefined}   lastLeafId  The pane that last had the focus, if known
 *
 * @return  {string}                         The pane
 */
export function activationLeafId (row: WindowsManagerRow, lastLeafId: string|undefined): string {
  if (lastLeafId !== undefined && row.leafIds.includes(lastLeafId)) {
    return lastLeafId
  }
  return row.leafIds[0]
}

/**
 * Compares two optional numbers; unknown values sort after known ones.
 *
 * @param   {number|undefined}  a  The first number
 * @param   {number|undefined}  b  The second number
 *
 * @return  {number}               The comparison result
 */
function compareOptionalNumbers (a: number|undefined, b: number|undefined): number {
  if (a === undefined && b === undefined) {
    return 0
  } else if (a === undefined) {
    return 1
  } else if (b === undefined) {
    return -1
  }
  return a - b
}

/**
 * Sorts the rows by a column: Name, Path and Type in case-insensitive natural
 * order, Size and Modified time by value. Ties keep the tab order, and
 * without a column the rows are in tab order. Returns a new array.
 *
 * @param   {WindowsManagerRow[]}       rows   The rows
 * @param   {WindowsManagerSortState}   state  The column and direction
 *
 * @return  {WindowsManagerRow[]}              The sorted rows
 */
export function sortWindowsManagerRows (rows: WindowsManagerRow[], state: WindowsManagerSortState): WindowsManagerRow[] {
  const { column, direction } = state
  const sign = direction === 'descending' ? -1 : 1
  return [...rows].sort((a, b) => {
    let result = 0
    if (column === 'name') {
      result = nameCollator.compare(a.name, b.name)
    } else if (column === 'path') {
      result = nameCollator.compare(a.path, b.path)
    } else if (column === 'type') {
      result = nameCollator.compare(a.type, b.type)
    } else if (column === 'size' || column === 'modtime') {
      const aValue = a[column]
      const bValue = b[column]
      // Unknown values stay at the end in both directions
      if (aValue === undefined || bValue === undefined) {
        result = compareOptionalNumbers(aValue, bValue)
        if (result !== 0) {
          return result
        }
      } else {
        result = aValue - bValue
      }
    } else {
      return (a.tabOrder - b.tabOrder) * sign
    }
    return result !== 0 ? result * sign : a.tabOrder - b.tabOrder
  })
}

/**
 * The sort state after clicking a column header: the column that is already
 * sorted switches direction, any other column starts ascending.
 *
 * @param   {WindowsManagerSortState}  state   The current state
 * @param   {WindowsManagerColumn}     column  The clicked column
 *
 * @return  {WindowsManagerSortState}          The new state
 */
export function nextSortState (state: WindowsManagerSortState, column: WindowsManagerColumn): WindowsManagerSortState {
  if (state.column === column) {
    return { column, direction: state.direction === 'ascending' ? 'descending' : 'ascending' }
  }
  return { column, direction: 'ascending' }
}

/**
 * The keys of a Shift range selection: every key from the anchor to the
 * target (both included), in list order. Without a valid anchor the range is
 * the target alone; an unknown target gives an empty range.
 *
 * @param   {string[]}          orderedKeys  The row keys in display order
 * @param   {string|undefined}  anchorKey    The key the range starts at
 * @param   {string}            targetKey    The key the range ends at
 *
 * @return  {string[]}                       The keys in the range
 */
export function shiftSelectionRange (orderedKeys: string[], anchorKey: string|undefined, targetKey: string): string[] {
  const targetIndex = orderedKeys.indexOf(targetKey)
  if (targetIndex < 0) {
    return []
  }
  const anchorIndex = anchorKey !== undefined ? orderedKeys.indexOf(anchorKey) : -1
  if (anchorIndex < 0) {
    return [targetKey]
  }
  const start = Math.min(anchorIndex, targetIndex)
  const end = Math.max(anchorIndex, targetIndex)
  return orderedKeys.slice(start, end + 1)
}

/**
 * The tab order of every pane that "Sort tabs" applies: each pane's files in
 * the order the dialog currently lists them (a file open in several panes
 * takes its list position in each of them). Panes keep their order.
 *
 * @param   {WindowsManagerRow[]}  orderedRows  The rows in display order
 *
 * @return  {Array<{ leafId: string, newOrder: string[] }>}  The orders
 */
export function buildSortTabsOrders (orderedRows: WindowsManagerRow[]): Array<{ leafId: string, newOrder: string[] }> {
  const leafOrder = [...orderedRows].sort((a, b) => a.tabOrder - b.tabOrder).flatMap(row => row.leafIds)
  const leafIds = [...new Set(leafOrder)]
  return leafIds.map(leafId => ({
    leafId,
    newOrder: orderedRows.filter(row => row.leafIds.includes(leafId)).map(row => row.path)
  }))
}

/**
 * The paths "Save" writes: the selected files with unsaved changes, each once,
 * in display order.
 *
 * @param   {WindowsManagerRow[]}  selectedRows  The selected rows in display order
 *
 * @return  {string[]}                           The paths
 */
export function pathsToSave (selectedRows: WindowsManagerRow[]): string[] {
  return [...new Set(selectedRows.filter(row => row.modified).map(row => row.path))]
}
