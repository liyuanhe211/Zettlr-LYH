/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Parsing and writing PDF++-compatible link fragments
 * CVM-Role:        Utility Function
 * License:         GNU GPL v3
 *
 * Description:     Converts between a PdfLocation and the part of a PDF link
 *                  after the `#`, e.g. `page=8&selection=135,0,152,33&color=red`,
 *                  the notation of the Obsidian plugin PDF++ (contract C5).
 *                  Kept in a file of its own so that both index.ts and
 *                  quote.ts can use it without importing each other; index.ts
 *                  re-exports both functions.
 *
 * END HEADER
 */

import type { PdfLocation, PdfTextSelection } from '@dts/common/pdf-viewer'

/**
 * Matches a non-negative decimal integer, nothing else
 */
const DECIMAL_INTEGER = /^\d+$/

/**
 * Parses the fragment of a PDF link, with or without the leading `#`, as a URL
 * query string. Returns null unless `page` is a positive integer. A
 * `selection` is only taken when it consists of exactly four integers; a
 * `color` is kept in lowercase. PDF++'s `rect`, `offset` and `annotation`
 * parameters and every other parameter are ignored, so such links only yield
 * their page.
 *
 * @param   {string}            fragment  The fragment, e.g. `#page=8&selection=135,0,152,33`
 *
 * @return  {PdfLocation|null}            The location, or null if the fragment names no page
 */
export function parsePdfLinkFragment (fragment: string): PdfLocation|null {
  const query = fragment.startsWith('#') ? fragment.slice(1) : fragment
  const parameters = new URLSearchParams(query)

  const pageValue = parameters.get('page')
  if (pageValue === null || !DECIMAL_INTEGER.test(pageValue.trim())) {
    return null
  }

  const page = parseInt(pageValue.trim(), 10)
  if (!Number.isSafeInteger(page) || page < 1) {
    return null
  }

  const location: PdfLocation = { page }

  const selectionValue = parameters.get('selection')
  if (selectionValue !== null) {
    const selection = parseSelection(selectionValue)
    if (selection !== null) {
      location.selection = selection
    }
  }

  const colorValue = parameters.get('color')
  if (colorValue !== null && colorValue.trim() !== '') {
    location.color = colorValue.trim().toLowerCase()
  }

  return location
}

/**
 * Parses the value of a `selection=` parameter; returns null unless it
 * consists of exactly four non-negative integers.
 *
 * @param   {string}                 value  The parameter value, e.g. `135,0,152,33`
 *
 * @return  {PdfTextSelection|null}         The selection, or null
 */
function parseSelection (value: string): PdfTextSelection|null {
  const parts = value.split(',').map(part => part.trim())
  if (parts.length !== 4 || !parts.every(part => DECIMAL_INTEGER.test(part))) {
    return null
  }

  const numbers = parts.map(part => parseInt(part, 10))
  if (!numbers.every(number => Number.isSafeInteger(number))) {
    return null
  }

  const [ beginIndex, beginOffset, endIndex, endOffset ] = numbers
  return { beginIndex, beginOffset, endIndex, endOffset }
}

/**
 * Writes a location as a link fragment without the leading `#`:
 * `page=<page>`, followed by `&selection=a,b,c,d` if it has a selection and
 * by `&color=<color>` if it has a non-empty color, in this order (the order
 * in which PDF++ writes them).
 *
 * @param   {PdfLocation}  location  The location
 *
 * @return  {string}                 The fragment, e.g. `page=8&selection=135,0,152,33`
 */
export function formatPdfLinkFragment (location: PdfLocation): string {
  let fragment = `page=${location.page}`

  const selection = location.selection
  if (selection !== undefined) {
    fragment += `&selection=${selection.beginIndex},${selection.beginOffset},${selection.endIndex},${selection.endOffset}`
  }

  if (location.color !== undefined && location.color !== '') {
    fragment += `&color=${location.color}`
  }

  return fragment
}
