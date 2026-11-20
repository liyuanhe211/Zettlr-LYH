/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        isShortcutPath, resolveShortcutTarget
 * CVM-Role:        Utility Function
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Finds the file a Windows shortcut (.lnk) points to, so that
 *                  Markdown images may link a shortcut instead of the image.
 *                  The shortcuts are the ones written by the Python function
 *                  create_relative_shortcut: the target field holds the
 *                  absolute path of the image, and the description field holds
 *                  "REL|" followed by a path relative to the folder of the
 *                  shortcut itself. The relative path wins, because it keeps
 *                  working after the whole folder tree has been moved or
 *                  renamed, while the absolute path is then out of date.
 *                  Main process only. Electron is loaded on first use, so that
 *                  this module can be imported (and tested with an injected
 *                  reader) without Electron.
 *
 * END HEADER
 */

import fs from 'fs'
import path from 'path'
import type { Shell } from 'electron'

/**
 * The part of the data of a shortcut that is needed to find its file.
 */
export interface ShortcutDetails {
  /** The absolute path of the file the shortcut points to */
  target?: string
  /** The description (comment) of the shortcut */
  description?: string
}

/**
 * Reads a shortcut. Throws if it cannot be read (the file does not exist, is
 * no shortcut, or the platform is not Windows).
 */
export type ShortcutReader = (shortcutPath: string) => ShortcutDetails

/**
 * The prefix by which the description of a shortcut announces that the rest is
 * a path relative to the folder of the shortcut.
 */
const RELATIVE_PATH_MARKER = 'REL|'

/**
 * Reads a shortcut through Electron.
 *
 * @param   {string}           shortcutPath  The absolute path of the .lnk file
 *
 * @return  {ShortcutDetails}                The target and the description
 */
function readShortcutWithElectron (shortcutPath: string): ShortcutDetails {
  // Loaded here instead of at the top of the module: outside of Electron, the
  // electron package does not provide the shell API.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { shell } = require('electron') as { shell: Shell }
  return shell.readShortcutLink(shortcutPath)
}

/**
 * Checks whether a path or an image address names a Windows shortcut: it ends
 * with ".lnk", in any capitalization, optionally followed by a query string or
 * a fragment. A "#" in front of the extension belongs to the file name, which
 * is allowed on Windows ("Figure #1.png.lnk"); a "?" never is, so everything
 * from the first "?" on is a query string.
 *
 * @param   {string}   address  The path or address to check
 *
 * @return  {boolean}           True if it names a shortcut
 */
export function isShortcutPath (address: string): boolean {
  const queryStart = address.indexOf('?')
  const withoutQuery = queryStart >= 0 ? address.slice(0, queryStart) : address
  if (withoutQuery.toLowerCase().endsWith('.lnk')) {
    return true
  }

  const fragmentStart = withoutQuery.indexOf('#')
  return fragmentStart >= 0 && withoutQuery.slice(0, fragmentStart).toLowerCase().endsWith('.lnk')
}

/**
 * Returns the absolute path of the file a shortcut points to.
 *
 * If the description of the shortcut starts with "REL|", the rest is a path
 * relative to the folder of the shortcut (with forward or backward slashes),
 * and that file is used if it exists. Otherwise, or if that file does not
 * exist, the absolute target of the shortcut is used if it exists. The result
 * is not cached, because a shortcut may be changed to point to a newer version
 * of an image at any time.
 *
 * @param   {string}             shortcutPath   The absolute path of the .lnk file
 * @param   {ShortcutReader}     readShortcut   Reads the target and description
 *                                              of the shortcut (replaceable for tests)
 * @param   {Function}           exists         Checks whether a file exists
 *                                              (replaceable for tests)
 *
 * @return  {string|undefined}                  The path of the existing file,
 *                                              or undefined if the shortcut
 *                                              cannot be read or both of its
 *                                              paths do not exist
 */
export function resolveShortcutTarget (
  shortcutPath: string,
  readShortcut: ShortcutReader = readShortcutWithElectron,
  exists: (filePath: string) => boolean = fs.existsSync
): string|undefined {
  let details: ShortcutDetails
  try {
    details = readShortcut(shortcutPath)
  } catch {
    return undefined
  }

  const description = details.description ?? ''
  if (description.startsWith(RELATIVE_PATH_MARKER)) {
    const relativePath = description.slice(RELATIVE_PATH_MARKER.length).replace(/\\/g, '/')
    if (relativePath !== '') {
      const candidate = path.isAbsolute(relativePath)
        ? path.normalize(relativePath)
        : path.join(path.dirname(shortcutPath), relativePath)
      if (exists(candidate)) {
        return candidate
      }
    }
  }

  const target = details.target ?? ''
  if (target !== '' && exists(target)) {
    return target
  }

  return undefined
}
