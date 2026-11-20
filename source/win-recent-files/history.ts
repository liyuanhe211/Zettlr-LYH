/** Filter complete paths without changing their recent-access order. */
export function searchRecentPaths (paths: readonly string[], query: string): string[] {
  const search = query.toLowerCase()
  return paths.filter(path => path.toLowerCase().includes(search))
}

/** Return the current spelling of the selected path, or cancel an invalid selection. */
export function retainRecentSelection (
  paths: readonly string[], selectedPath: string|null, windowsPaths: boolean
): string|null {
  if (selectedPath === null) {
    return null
  }
  const identity = windowsPaths ? windowsPathIdentity(selectedPath) : selectedPath
  return paths.find(path => {
    const candidate = windowsPaths ? windowsPathIdentity(path) : path
    return candidate === identity
  }) ?? null
}

// Absolute Windows paths only: preserve the drive or UNC share while resolving
// dot segments. The renderer cannot import Node's path module.
function windowsPathIdentity (path: string): string {
  const separators = path.replace(/\\/g, '/')
  const networkPath = /^\/\/[^/]+\/+[^/]+(?:\/|$)/.test(separators)
  const drivePath = /^[a-z]:\//i.test(separators)
  const rootLength = networkPath ? 2 : (drivePath ? 1 : 0)
  const segments = separators.split('/').filter(segment => segment !== '')
  const resolved = segments.slice(0, rootLength)
  for (const segment of segments.slice(rootLength)) {
    if (segment === '..') {
      if (resolved.length > rootLength) {
        resolved.pop()
      }
    } else if (segment !== '.') {
      resolved.push(segment)
    }
  }
  const prefix = networkPath ? '\\\\' : (drivePath ? '' : '\\')
  let identity = prefix + resolved.join('\\')
  if (!identity.endsWith('\\') && (separators.endsWith('/') || resolved.length === rootLength)) {
    identity += '\\'
  }
  return identity.toLowerCase()
}
