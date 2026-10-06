/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        displayImagePath, buildImageWarning
 * CVM-Role:        Utility Functions
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Builds the warning that "Export to HTML" shows when local
 *                  images referenced in the Markdown file could not be
 *                  embedded into the HTML file. Such images are missing as
 *                  soon as the HTML file is opened elsewhere or uploaded on
 *                  its own, so the user must learn about every one of them.
 *                  The functions here only turn the failures into readable
 *                  text; the main process command determines the failures
 *                  and shows the dialog. Main process only.
 *
 * END HEADER
 */

import path from 'path'

/**
 * Why a local image could not be embedded: the file does not exist, its
 * format is not one that can be embedded as a data URI, or it exists but
 * could not be read.
 */
export type ImageEmbedFailureReason = 'not-found' | 'unsupported-format' | 'unreadable'

/**
 * The text shown after each image in the warning, per failure reason.
 */
const REASON_DESCRIPTIONS: Record<ImageEmbedFailureReason, string> = {
  'not-found': 'file not found',
  'unsupported-format': 'unsupported image format',
  unreadable: 'file could not be read'
}

/**
 * The warning lists at most this many images; the rest are summarized in one
 * final line, so that the dialog stays within the screen.
 */
const MAXIMUM_LISTED_IMAGES = 20

/**
 * Returns the path by which the warning names an image: relative to the folder
 * of the Markdown file, with forward slashes, and without any percent-encoding,
 * so that the user recognizes it as written in the file system. If no relative
 * path can be written (another drive, a UNC path on one side, or the image path
 * is the folder itself), the absolute path is returned unchanged.
 *
 * For example, an image E:\A\Figures_Production\Figure 1\a.png referenced from
 * a file in E:\A\Manuscript is shown as ../Figures_Production/Figure 1/a.png.
 *
 * @param   {string}  absolutePath       The absolute path of the image
 * @param   {string}  documentDirectory  The folder of the Markdown file
 *
 * @return  {string}                     The path to show to the user
 */
export function displayImagePath (absolutePath: string, documentDirectory: string): string {
  const relativePath = path.relative(documentDirectory, absolutePath)
  if (relativePath === '' || path.isAbsolute(relativePath)) {
    return absolutePath
  }

  return relativePath.split(path.sep).join('/')
}

/**
 * Builds the message and the detail text of the warning about the local images
 * that could not be embedded. The detail lists one image per line together with
 * the reason, up to MAXIMUM_LISTED_IMAGES lines, followed by a line counting
 * the images left out. It is meant to be called only with at least one failure;
 * for an empty list, it returns a message about zero images and only the
 * introductory sentence as the detail.
 *
 * @param   {Array}   failures      The images that could not be embedded, each
 *                                  with the path to show and the reason
 * @param   {string}  htmlFileName  The file name of the written HTML file
 *
 * @return  {Object}                The message and the detail of the dialog
 */
export function buildImageWarning (
  failures: Array<{ displayPath: string, reason: ImageEmbedFailureReason }>,
  htmlFileName: string
): { message: string, detail: string } {
  const count = failures.length
  const message = `${count} ${count === 1 ? 'image' : 'images'} could not be embedded into the HTML file`
  const introduction = `${htmlFileName} was written, but the following images referenced in the Markdown file could not be read, so they will be missing when the HTML file is opened elsewhere or uploaded on its own:`

  if (count === 0) {
    return { message, detail: introduction }
  }

  const lines = failures
    .slice(0, MAXIMUM_LISTED_IMAGES)
    .map(failure => `• ${failure.displayPath} (${REASON_DESCRIPTIONS[failure.reason]})`)

  if (count > MAXIMUM_LISTED_IMAGES) {
    lines.push(`…and ${count - MAXIMUM_LISTED_IMAGES} more (see the log for the full list)`)
  }

  return { message, detail: `${introduction}\n\n${lines.join('\n')}` }
}
