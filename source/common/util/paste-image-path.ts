/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Paste image path utilities
 * CVM-Role:        Utility function
 * License:         GNU GPL v3
 *
 * Description:     Pure helper functions for saving images pasted from the
 *                  clipboard without asking the user: they derive the image's
 *                  file name, build the "_Images" folder next to the document,
 *                  produce numbered alternatives on name conflicts, and build
 *                  the relative Markdown image link that is inserted into the
 *                  document. This module is shared by main and renderer, so it
 *                  must not import Node.js modules.
 *
 * END HEADER
 */

import sanitize from 'sanitize-filename'

/**
 * The name of the folder (next to the document) into which pasted images go.
 */
export const PASTED_IMAGE_DIRECTORY_NAME = '_Images'

/**
 * The generic file name Chromium assigns to clipboard images (e.g. screenshots).
 * It carries no information, so it is ignored when deriving a file name.
 */
const GENERIC_CLIPBOARD_IMAGE_NAME = 'image.png'

/**
 * The file extensions the image can be saved with. Any other name receives an
 * additional ".png" extension, since the image is then encoded as PNG.
 */
const SUPPORTED_IMAGE_EXTENSIONS = [ '.png', '.jpg' ]

export interface PastedImageNameSource {
  /**
   * The file name the renderer has provided (the name of the File object), if
   * any.
   */
  providedName?: string
  /**
   * The current plain text contents of the clipboard. Browsers sometimes put
   * the original URL of a copied image there.
   */
  clipboardText: string
  /**
   * A hash of the image data, used as the file name if no better name exists.
   * Identical images thus receive identical names.
   */
  contentHash: string
}

/**
 * Returns the extension of a file name, including the leading dot, following
 * the semantics of Node.js's path.extname (a leading dot, as in ".hidden", does
 * not start an extension).
 *
 * @param   {string}  fileName  The file name
 *
 * @return  {string}            The extension, or an empty string
 */
function fileExtension (fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.')
  return dotIndex > 0 ? fileName.substring(dotIndex) : ''
}

/**
 * Returns the last segment of a path or URL without its extension, equivalent
 * to Node.js's path.basename(text, path.extname(text)) on Windows, where both
 * forward and backward slashes separate segments.
 *
 * @param   {string}  text  The path or URL
 *
 * @return  {string}        The base name without extension
 */
function baseNameWithoutExtension (text: string): string {
  const withoutTrailingSeparators = text.replace(/[\\/]+$/, '')
  const segments = withoutTrailingSeparators.split(/[\\/]/)
  const lastSegment = segments[segments.length - 1]
  const extension = fileExtension(lastSegment)
  return lastSegment.substring(0, lastSegment.length - extension.length)
}

/**
 * Returns the base name that clipboard text suggests for a pasted image, or
 * undefined. Only text that looks like the location of an image counts: one
 * token without whitespace that is a URL, contains a path separator, or ends in
 * an image extension. Anything else (ordinary copied prose) is ignored, since
 * without the former paste dialog it would silently become the file name.
 *
 * @param   {string}  clipboardText  The plain text contents of the clipboard
 *
 * @return  {string|undefined}       The base name without extension, if any
 */
function nameFromClipboardText (clipboardText: string): string|undefined {
  const trimmed = clipboardText.trim()
  if (trimmed === '' || /\s/.test(trimmed)) {
    return undefined
  }

  const withoutQuery = trimmed.replace(/[?#].*$/, '')
  const isLocation = /^[a-z][a-z0-9+.-]*:\/\//i.test(withoutQuery) || /[\\/]/.test(withoutQuery)
  const hasImageExtension = /\.(png|jpe?g|gif|webp|bmp|svg|tiff?)$/i.test(withoutQuery)
  if (!isLocation && !hasImageExtension) {
    return undefined
  }

  const baseName = baseNameWithoutExtension(withoutQuery).trim()
  return baseName === '' ? undefined : baseName
}

/**
 * Derives the file name for a pasted image: (1) the name the caller has
 * provided, unless it is the generic "image.png"; (2) otherwise the base name
 * of the clipboard text (with ".png" appended) if that text is the location of
 * an image, e.g. the original URL of an image copied from a browser; (3)
 * otherwise the content hash with ".png". The result is sanitized (forbidden
 * characters become "-"), and ".png" is appended unless the name already ends
 * in ".png" or ".jpg". If sanitizing leaves no usable name, the content hash is
 * used.
 *
 * @param   {PastedImageNameSource}  source  The available name sources
 *
 * @return  {string}                         The file name (without directory)
 */
export function derivePastedImageFileName (source: PastedImageNameSource): string {
  const hashName = source.contentHash + '.png'
  const providedName = source.providedName === GENERIC_CLIPBOARD_IMAGE_NAME
    ? undefined
    : source.providedName
  const clipboardName = nameFromClipboardText(source.clipboardText)

  let name = hashName
  if (providedName !== undefined && providedName.trim() !== '') {
    name = providedName.trim()
  } else if (clipboardName !== undefined) {
    name = clipboardName + '.png'
  }

  let sanitizedName = sanitize(name, { replacement: '-' })
  const sanitizedExtension = fileExtension(sanitizedName)
  const sanitizedStem = sanitizedName.substring(0, sanitizedName.length - sanitizedExtension.length)
  if (sanitizedStem === '' || /^[-.\s]*$/.test(sanitizedStem)) {
    // Nothing meaningful survived sanitizing
    sanitizedName = hashName
  }

  if (!SUPPORTED_IMAGE_EXTENSIONS.includes(fileExtension(sanitizedName).toLowerCase())) {
    sanitizedName += '.png'
  }

  return sanitizedName
}

/**
 * Returns the file name to try on the given attempt when the preferred name is
 * already taken: attempt 0 is the name itself, attempt n appends "-n" to the
 * part before the extension ("image.png" -> "image-1.png", "image-2.png", ...).
 *
 * @param   {string}  fileName  The preferred file name
 * @param   {number}  attempt   The zero-based attempt number
 *
 * @return  {string}            The candidate file name
 */
export function buildCandidateFileName (fileName: string, attempt: number): string {
  if (attempt <= 0) {
    return fileName
  }
  const extension = fileExtension(fileName)
  const stem = fileName.substring(0, fileName.length - extension.length)
  return `${stem}-${attempt}${extension}`
}

/**
 * Returns the absolute path of the "_Images" folder next to the document,
 * using the separator style of the provided document directory.
 *
 * @param   {string}  documentDirectory  The absolute directory of the document
 *
 * @return  {string}                     The absolute path of the image folder
 */
export function buildPastedImageDirectory (documentDirectory: string): string {
  const isWindowsStyle = documentDirectory.includes('\\') && !documentDirectory.includes('/')
  const separator = isWindowsStyle ? '\\' : '/'
  const trimmedDirectory = documentDirectory.replace(/[\\/]+$/, '')
  return trimmedDirectory + separator + PASTED_IMAGE_DIRECTORY_NAME
}

/**
 * Returns the path of a pasted image relative to its document, always with
 * forward slashes, e.g. "_Images/image.png".
 *
 * @param   {string}  fileName  The image's file name
 *
 * @return  {string}            The relative path
 */
export function buildPastedImageRelativePath (fileName: string): string {
  return `${PASTED_IMAGE_DIRECTORY_NAME}/${fileName}`
}

/**
 * Builds the Markdown image tag for a relative image path. Backslashes become
 * forward slashes; spaces and parentheses are percent-encoded, since the
 * Markdown parser accepts neither spaces nor unbalanced parentheses in link
 * destinations, and a literal "%" is encoded first, since the destination is
 * percent-decoded when the image is loaded.
 *
 * @param   {string}  relativePath  The relative path of the image
 *
 * @return  {string}                The image tag, e.g. "![](_Images/a%20b.png)"
 */
export function buildImageMarkdownLink (relativePath: string): string {
  const destination = relativePath
    .replace(/\\/g, '/')
    .replace(/%/g, '%25')
    .replace(/ /g, '%20')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
  return `![](${destination})`
}
