/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        windowTitleCandidates, chooseWindowTitle, centeredTitleBox
 * CVM-Role:        Utility function
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH (R85): the arithmetic behind the title shown in
 *                  the middle of the main window's menu bar on Windows. The
 *                  title is the file name of the active tab, preceded by its
 *                  parent directories. The candidates go from the full path
 *                  down to the bare file name; the first one that fits the
 *                  available width is shown, and the bare file name
 *                  is truncated with an ellipsis as a last resort. These
 *                  functions do not depend on the DOM, so that they can be
 *                  tested without Electron.
 *
 * END HEADER
 */

/**
 * The separator shown between the parts of the title (Windows style).
 */
const TITLE_SEPARATOR = '\\'

/**
 * The prefix that marks omitted outer directories.
 */
const OMITTED_PREFIX = '…' + TITLE_SEPARATOR

/**
 * The ellipsis appended to a truncated file name.
 */
const ELLIPSIS = '…'

/**
 * Splits a path into its directory parts and its file name. The root counts as
 * one directory part: a drive letter (E:), a UNC share (\\server\share), or an
 * empty part for a POSIX root (so that it renders as a leading separator).
 * Both forward slashes and backslashes are accepted as separators.
 *
 * @param   {string}  filePath  The full path
 *
 * @return  {{ directories: string[], fileName: string }}  The parts
 */
function splitTitlePath (filePath: string): { directories: string[], fileName: string } {
  const isUncPath = /^[\\/]{2}[^\\/]/.test(filePath)
  const isRootedPath = !isUncPath && /^[\\/]/.test(filePath)
  const parts = filePath.split(/[\\/]+/).filter(part => part !== '')

  const directories: string[] = []
  if (isUncPath && parts.length >= 3) {
    // \\server\share is the root of a UNC path and counts as one level
    directories.push(TITLE_SEPARATOR + TITLE_SEPARATOR + parts[0] + TITLE_SEPARATOR + parts[1])
    parts.splice(0, 2)
  } else if (isRootedPath && parts.length >= 1) {
    // A POSIX root renders as a leading separator
    directories.push('')
  }

  const fileName = parts.pop() ?? ''
  directories.push(...parts)
  return { directories, fileName }
}

/**
 * Builds the title candidates for a path, from the longest to the shortest:
 * the file name with all, then progressively fewer parent directories, down
 * to one parent directory, then the bare file name. A candidate that omits
 * outer directories starts with "…\"; the
 * bare file name has no prefix. The first candidate is the full path without
 * a prefix (the drive letter counts as one directory level).
 *
 * @param   {string}    filePath  The full path of the active file
 *
 * @return  {string[]}            The candidates, longest first
 */
export function windowTitleCandidates (filePath: string): string[] {
  const { directories, fileName } = splitTitlePath(filePath.trim())
  if (fileName === '') {
    return []
  }

  const candidates: string[] = []
  for (let count = directories.length; count >= 1; count--) {
    const shown = directories.slice(directories.length - count)
    const prefix = count < directories.length ? OMITTED_PREFIX : ''
    candidates.push(prefix + [ ...shown, fileName ].join(TITLE_SEPARATOR))
  }

  candidates.push(fileName)
  return candidates
}

/**
 * Picks the first candidate that fits the available width. When not even the
 * last (shortest) candidate fits, it is cut at its end and an ellipsis is
 * appended, keeping as many characters as fit.
 *
 * @param   {string[]}                  candidates      The candidates, longest first
 * @param   {(text: string) => number}  measure         Returns the rendered width of a text
 * @param   {number}                    availableWidth  The width the title may occupy
 *
 * @return  {{ text: string, truncated: boolean }}      The text to show
 */
export function chooseWindowTitle (
  candidates: string[],
  measure: (text: string) => number,
  availableWidth: number
): { text: string, truncated: boolean } {
  if (candidates.length === 0) {
    return { text: '', truncated: false }
  }

  for (const candidate of candidates) {
    if (measure(candidate) <= availableWidth) {
      return { text: candidate, truncated: false }
    }
  }

  // Not even the shortest candidate fits: find the longest prefix (by code
  // points, so that no surrogate pair is split) that fits with an ellipsis.
  const characters = Array.from(candidates[candidates.length - 1])
  let low = 0
  let high = characters.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (measure(characters.slice(0, middle).join('') + ELLIPSIS) <= availableWidth) {
      low = middle
    } else {
      high = middle - 1
    }
  }

  if (low === 0 && measure(ELLIPSIS) > availableWidth) {
    return { text: '', truncated: true }
  }

  return { text: characters.slice(0, low).join('') + ELLIPSIS, truncated: true }
}

/**
 * Computes the horizontal box the title may occupy. The left boundary is the
 * right edge of the last menu item plus the margin, the right boundary is the
 * left edge of the window controls minus the margin. Normally the box is the
 * widest one centred on the middle of the window that crosses neither
 * boundary. When that symmetric box is narrower than minimumWidth (the width
 * of the bare file name), or has no width at all, the whole gap between the
 * boundaries is returned instead, so that the title is centred in the gap.
 *
 * @param   {number}  windowWidth     The width of the window
 * @param   {number}  menuItemsRight  The right edge of the last menu item
 * @param   {number}  controlsLeft    The left edge of the window controls
 * @param   {number}  margin          The gap kept on either side
 * @param   {number}  minimumWidth    The width of the bare file name (optional)
 *
 * @return  {{ left: number, width: number }}  The box, in window coordinates
 */
export function centeredTitleBox (
  windowWidth: number,
  menuItemsRight: number,
  controlsLeft: number,
  margin: number,
  minimumWidth: number = 0
): { left: number, width: number } {
  const leftBoundary = menuItemsRight + margin
  const rightBoundary = controlsLeft - margin
  const middle = windowWidth / 2

  const halfWidth = Math.min(middle - leftBoundary, rightBoundary - middle)
  const symmetricWidth = Math.max(0, 2 * halfWidth)
  if (symmetricWidth > 0 && symmetricWidth >= minimumWidth) {
    return { left: middle - halfWidth, width: symmetricWidth }
  }

  return { left: leftBoundary, width: Math.max(0, rightBoundary - leftBoundary) }
}
