/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        relativeImageURL
 * CVM-Role:        Utility Function
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Turns the absolute path of a local image into a URL that
 *                  is relative to the folder of an exported HTML file, so
 *                  that "Export to HTML" can link the images it could not
 *                  embed. Only the characters that would break the URL or
 *                  the attribute holding it are percent-encoded; all other
 *                  characters, including non-ASCII ones such as Chinese, are
 *                  kept so that the path stays readable in the HTML source.
 *                  If no relative path exists (the image is on another drive,
 *                  or one of the two paths is a UNC path), an absolute file
 *                  URL is returned instead. Main process only.
 *
 * END HEADER
 */

import path from 'path'
import { pathToFileURL } from 'url'

/**
 * The characters that would break a relative URL or the attribute holding it:
 * the URL delimiters (% # ? &), quotes, angle brackets, the backtick, the
 * colon (which would turn the first path segment into a scheme), whitespace,
 * and control characters. The backslash is included because browsers read it
 * as a path separator; it can only remain in a segment on platforms whose
 * path separator is the forward slash.
 */
const UNSAFE_URL_CHARACTERS = /[%#?&"'<>`:\\\s\u0000-\u001F\u007F]/g

/**
 * Percent-encodes a character as the UTF-8 bytes it consists of, with
 * uppercase hexadecimal digits. ASCII characters become a single %XX.
 *
 * @param   {string}  character  The character to encode
 *
 * @return  {string}             The percent-encoded character
 */
function percentEncode (character: string): string {
  return Array.from(Buffer.from(character, 'utf8'), byte => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join('')
}

/**
 * Returns the URL by which an HTML file in htmlDirectory links the image at
 * absolutePath: the relative path with forward slashes, in which only the
 * characters that would break the URL or the attribute are percent-encoded.
 * If no relative path can be written (another drive, a UNC path on one side,
 * or the image path is the folder itself), the absolute file URL is returned.
 *
 * For example, an HTML file in E:\A\Manuscript links E:\A\Figures\Fig 1#a.svg
 * as ../Figures/Fig%201%23a.svg, and D:\X\y.png as file:///D:/X/y.png.
 *
 * @param   {string}  absolutePath   The absolute path of the image
 * @param   {string}  htmlDirectory  The folder the HTML file is written to
 *
 * @return  {string}                 The URL to write into the src attribute
 */
export function relativeImageURL (absolutePath: string, htmlDirectory: string): string {
  const relativePath = path.relative(htmlDirectory, absolutePath)
  if (relativePath === '' || path.isAbsolute(relativePath)) {
    return pathToFileURL(absolutePath).href
  }

  return relativePath
    .split(path.sep)
    .map(segment => segment.replace(UNSAFE_URL_CHARACTERS, percentEncode))
    .join('/')
}
