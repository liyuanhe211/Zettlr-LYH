/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Writing PDF quotes in PDF++'s "Quote in callout" format
 * CVM-Role:        Utility Function
 * License:         GNU GPL v3
 *
 * Description:     The pure functions behind Copy as Quote (R60, contract C5,
 *                  issue 520): the link text, the percent-encoded link target
 *                  and the complete quote, written exactly like the "Quote in
 *                  callout" copy template of the Obsidian plugin PDF++ on the
 *                  author's machine:
 *                  `> [!{{calloutType}}|{{color}}] {{linkWithDisplay}}\n> > {{text}}\n> \n> `
 *
 * END HEADER
 */

import {
  PDF_QUOTE_CALLOUT_TYPE,
  type PdfLocation,
  type PdfQuoteParts
} from '@dts/common/pdf-viewer'
import { formatPdfLinkFragment } from './link-fragment'

/**
 * The characters PDF++ (function `Rr` of its main.js, applied to the target
 * of every Markdown link it writes) replaces by their percent encoding:
 * backslash, space, U+0000, U+0008, U+000B, U+000C and U+000E to U+001F.
 * Everything else, including U+0001 to U+0007, tab, line feed, carriage
 * return, `%`, commas, parentheses and CJK characters, is written as is.
 */
const LINK_CHARACTERS_TO_ENCODE = /[\\\x00\x08\x0B\x0C\x0E-\x1F ]/g

/**
 * Returns the link text of a quote, PDF++'s display text format "Title &
 * page": `《<file name>》P<page label>`.
 *
 * @param   {string}  fileBasename  The PDF's file name without the extension
 * @param   {string}  pageLabel     The page label, or the decimal page number if the PDF defines no labels
 *
 * @return  {string}                The link text, e.g. 《Ekins 2021, UV-adVISor》P8
 */
export function formatPdfDisplayText (fileBasename: string, pageLabel: string): string {
  return `《${fileBasename}》P${pageLabel}`
}

/**
 * Percent-encodes a link path the way PDF++ writes Markdown link targets:
 * spaces become `%20`, backslashes `%5C`, and the control characters of
 * LINK_CHARACTERS_TO_ENCODE are encoded as well; everything else, `%`
 * included, stays as is.
 *
 * @param   {string}  path  The path, with `/` as separator
 *
 * @return  {string}        The encoded path
 */
export function encodePdfLinkPath (path: string): string {
  return path.replace(LINK_CHARACTERS_TO_ENCODE, character => encodeURIComponent(character))
}

/**
 * Returns the target of a link to a location in a PDF: the encoded path, `#`
 * and the fragment. Like PDF++ 0.40.28 (copyLinkToSelection), every non-empty
 * color is written in lowercase as `&color=`, the default color yellow
 * included; an empty or missing color writes none.
 *
 * @param   {string}       path      The path of the PDF, with `/` as separator
 * @param   {PdfLocation}  location  The location
 *
 * @return  {string}                 The link target, e.g. `Ekins%202021,%20UV-adVISor.pdf#page=8&selection=135,0,152,33`
 */
export function formatPdfLinkTarget (path: string, location: PdfLocation): string {
  const fragmentLocation: PdfLocation = { page: location.page }
  if (location.selection !== undefined) {
    fragmentLocation.selection = location.selection
  }

  const color = location.color?.trim().toLowerCase() ?? ''
  if (color !== '') {
    fragmentLocation.color = color
  }

  // PDF++ encodes the whole target, fragment included; the fragment only
  // changes if a color name contains a space.
  return encodePdfLinkPath(`${path}#${formatPdfLinkFragment(fragmentLocation)}`)
}

/**
 * Writes one quote in PDF++'s "Quote in callout" format, including the
 * trailing `> \n> ` that leaves the cursor inside the callout. The color goes
 * into the header in lowercase; an empty color yields `[!PDF|]`, as PDF++
 * writes it when no palette color is selected.
 *
 * @param   {PdfQuoteParts}  parts  Link target, link text, quoted text and color
 *
 * @return  {string}                The quote
 */
export function formatPdfQuote (parts: PdfQuoteParts): string {
  const color = parts.color.toLowerCase()
  const link = `[${parts.displayText}](${parts.linkTarget})`
  return `> [!${PDF_QUOTE_CALLOUT_TYPE}|${color}] ${link}\n> > ${parts.text}\n> \n> `
}
