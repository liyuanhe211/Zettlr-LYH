/** Normalize separators and Windows casing without confusing sibling prefixes. */
export function normalizeHistorySelectionPath (path: string): string {
  const networkPath = /^[\\/]{2}[^\\/]/.test(path)
  const windowsPath = /^[a-z]:[\\/]/i.test(path) || networkPath
  const normalized = (networkPath ? '/' : '') + path.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  const withoutTrailingSeparator = normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
  return windowsPath ? withoutTrailingSeparator.toLowerCase() : withoutTrailingSeparator
}

export function historySelectionPathsEqual (first: string | undefined, second: string | undefined): boolean {
  return first !== undefined && second !== undefined &&
    normalizeHistorySelectionPath(first) === normalizeHistorySelectionPath(second)
}

export function isSelectedFileAncestor (folderPath: string, selectedFilePath: string | undefined): boolean {
  if (selectedFilePath === undefined || selectedFilePath === '' || folderPath === '') {
    return false
  }
  const folder = normalizeHistorySelectionPath(folderPath)
  const selectedFile = normalizeHistorySelectionPath(selectedFilePath)
  if (folder.startsWith('//') !== selectedFile.startsWith('//')) {return false}
  return selectedFile !== folder && selectedFile.startsWith(folder.endsWith('/') ? folder : `${folder}/`)
}

/** null is an explicit folder selection; undefined restores the active document. */
export function effectiveHistoryFileSelection (
  activeFilePath: string | undefined,
  selectedTreePath: string | null | undefined
): string | undefined {
  if (selectedTreePath === null) {return undefined}
  return selectedTreePath ?? activeFilePath
}
