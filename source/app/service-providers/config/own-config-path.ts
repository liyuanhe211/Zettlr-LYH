/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        isOwnConfigKey, resolveOwnConfigPath, findOwnConfigParent
 * CVM-Role:        Utility function
 * License:         GNU GPL v3
 *
 * Description:     Electron-free helpers used by the ConfigProvider to decide
 *                  whether a (possibly dotted) configuration key exists. Only
 *                  own properties count, so inherited names such as
 *                  "toString", "constructor" or "__proto__" are never treated
 *                  as configuration keys.
 *
 * END HEADER
 */

/**
 * Returns true if the container is a non-null object that has the key as its
 * own property. Inherited properties do not count.
 *
 * @param   {unknown}  container  The object to inspect
 * @param   {string}   key        The property name
 *
 * @return  {boolean}             Whether the key is an own property
 */
export function isOwnConfigKey (container: unknown, key: string): boolean {
  if (container === null || typeof container !== 'object') {
    return false
  }
  return Object.prototype.hasOwnProperty.call(container, key)
}

/**
 * Resolves a dot-separated path against the configuration object, following
 * own properties only.
 *
 * @param   {unknown}  config  The configuration object
 * @param   {string}   path    The (possibly dotted) key, e.g. "display.theme"
 *
 * @return  {{ found: true, value: any } | { found: false }}  The lookup result
 */
export function resolveOwnConfigPath (config: unknown, path: string): { found: true, value: any } | { found: false } {
  let current: any = config
  for (const segment of path.split('.')) {
    if (!isOwnConfigKey(current, segment)) {
      return { found: false }
    }
    current = current[segment]
  }
  return { found: true, value: current }
}

/**
 * Finds the object that owns the last segment of a dot-separated path, so that
 * the caller can assign to it. Every segment, including the last one, must be
 * an own property; otherwise null is returned.
 *
 * @param   {unknown}  config  The configuration object
 * @param   {string}   path    The (possibly dotted) key
 *
 * @return  {{ parent: Record<string, any>, key: string } | null}  The parent and the final key, or null
 */
export function findOwnConfigParent (config: unknown, path: string): { parent: Record<string, any>, key: string } | null {
  const segments = path.split('.')
  const key = segments.pop() as string
  let parent: any = config
  for (const segment of segments) {
    if (!isOwnConfigKey(parent, segment)) {
      return null
    }
    parent = parent[segment]
  }
  if (!isOwnConfigKey(parent, key)) {
    return null
  }
  return { parent, key }
}
