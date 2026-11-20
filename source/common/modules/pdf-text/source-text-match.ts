/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Locating the quoted source text of a PDF link on its page
 * CVM-Role:        Utility Function
 * License:         GNU GPL v3
 *
 * Description:     Decision 071 (R60, contract C5): when a PDF++ link is
 *                  clicked, the viewer first compares the text of the link's
 *                  selection with the quoted text below the link. If they
 *                  agree, the selection is highlighted as it is; otherwise the
 *                  quoted text is looked up on the page, and a single hit
 *                  replaces the selection. No hit, or several, keep the
 *                  link's selection. Links written with the older pdf.js of
 *                  Obsidian number the items differently (the drift measured
 *                  in the PDF++ compatibility report), which this repairs.
 *
 *                  Comparison and lookup work on a match key: the text
 *                  NFKC-normalized character by character, curly quotes
 *                  replaced by straight ones, and without whitespace, NUL,
 *                  hyphens and dashes and `*`. So line breaks, end-of-line
 *                  hyphenation and the spaces between Chinese and Japanese
 *                  characters of the page text do not matter. Every code unit
 *                  of a key remembers the range of the original character it
 *                  comes from, which maps a hit back to the page text.
 *
 *                  The exports are re-exported from index.ts; the functions
 *                  this file imports from there are only used when called,
 *                  never while the modules load, so the mutual import is
 *                  harmless.
 *
 * END HEADER
 */

import type { PdfPageText, PdfTextSelection } from '@dts/common/pdf-viewer'
import {
  pageRangeToSelection,
  selectionText,
  toQuoteText,
  type PdfTextItem
} from './index'

/**
 * Characters left out of a match key: whitespace (line breaks included), NUL,
 * the hyphen-minus, the soft hyphen, the hyphens and dashes U+2010 to U+2015,
 * the minus sign and `*`.
 */
const IGNORED_IN_MATCH_KEY = /[\s\u0000­‐-―−*-]/

/**
 * Quotation mark variants and the straight quote each one is compared as
 */
const QUOTE_REPLACEMENTS: Record<string, string> = {
  '‘': '\'',
  '’': '\'',
  '‚': '\'',
  '‛': '\'',
  '′': '\'',
  '“': '"',
  '”': '"',
  '„': '"',
  '‟': '"',
  '″': '"'
}

/**
 * A text turned into a match key. `starts[k]` and `ends[k]` are the range, in
 * the original text, of the character code unit k of `key` comes from.
 */
export interface SourceTextMatchKey {
  key: string
  starts: number[]
  ends: number[]
}

/**
 * How resolveSelectionBySourceText arrived at its selection: `index` means
 * the link's own selection (its text equals the source text, or there is no
 * source text or no selection); `text` means the source text was found once
 * on the page and the selection covers it; `fallback` means the texts differ
 * and the source text was found nowhere or more than once on the page, so the
 * link's selection is kept.
 */
export type SourceTextResolutionMethod = 'index'|'text'|'fallback'

/**
 * Result of resolveSelectionBySourceText
 */
export interface SourceTextResolution {
  selection: PdfTextSelection|undefined
  method: SourceTextResolutionMethod
}

/**
 * Turns a text into its match key and records, for every code unit of the
 * key, the range of the original character it comes from.
 *
 * @param   {string}              text  The text, e.g. the page text or a quote
 *
 * @return  {SourceTextMatchKey}        The key and its mapping to the text
 */
export function buildSourceTextMatchKey (text: string): SourceTextMatchKey {
  const keyParts: string[] = []
  const starts: number[] = []
  const ends: number[] = []
  let offset = 0

  for (const character of text) {
    for (const normalized of character.normalize('NFKC')) {
      if (IGNORED_IN_MATCH_KEY.test(normalized)) {
        continue
      }
      const keyCharacter = QUOTE_REPLACEMENTS[normalized] ?? normalized
      keyParts.push(keyCharacter)
      for (let unit = 0; unit < keyCharacter.length; unit++) {
        starts.push(offset)
        ends.push(offset + character.length)
      }
    }
    offset += character.length
  }

  return { key: keyParts.join(''), starts, ends }
}

/**
 * Returns the match key of a text: NFKC-normalized, curly quotes made
 * straight, without whitespace, NUL, hyphens, dashes and `*`. Two texts
 * count as the same quote if their keys are equal.
 *
 * @param   {string}  text  The text
 *
 * @return  {string}        Its match key
 */
export function normalizeForSourceTextMatch (text: string): string {
  return buildSourceTextMatchKey(text).key
}

/**
 * Returns every position at which needle occurs in haystack, overlapping
 * occurrences included.
 */
function findAllOccurrences (haystack: string, needle: string): number[] {
  const positions: number[] = []
  if (needle === '') {
    return positions
  }

  let position = haystack.indexOf(needle)
  while (position >= 0) {
    positions.push(position)
    position = haystack.indexOf(needle, position + 1)
  }
  return positions
}

/**
 * Looks a source text up in the page text. Returns the range of the page text
 * that a single occurrence covers, or null if the source text occurs nowhere
 * or more than once (or its key is empty).
 *
 * @param   {PdfPageText}  pageText    The page text
 * @param   {string}       sourceText  The text to look for
 *
 * @return  {{ from: number, to: number, occurrences: number }}  The range of the only occurrence (from and to are -1 unless occurrences is 1)
 */
export function findSourceTextOnPage (pageText: PdfPageText, sourceText: string): { from: number, to: number, occurrences: number } {
  const sourceKey = normalizeForSourceTextMatch(sourceText)
  const pageKey = buildSourceTextMatchKey(pageText.text)
  const occurrences = findAllOccurrences(pageKey.key, sourceKey)
  if (occurrences.length !== 1) {
    return { from: -1, to: -1, occurrences: occurrences.length }
  }

  const position = occurrences[0]
  return {
    from: pageKey.starts[position],
    to: pageKey.ends[position + sourceKey.length - 1],
    occurrences: 1
  }
}

/**
 * Decides which selection to highlight for a link (decision 071). Without a
 * selection the link only names a page and nothing is looked up; without a
 * source text (empty or whitespace only) the link's selection is used as is.
 * Otherwise the text of the selection, as a quote (toQuoteText), is compared
 * with the source text by their match keys; if they differ, the source text is
 * looked up on the page, and a single occurrence yields a new selection
 * (pageRangeToSelection). No or several occurrences keep the link's
 * selection.
 *
 * @param   {PdfPageText}                    pageText    The text of the link's page
 * @param   {PdfTextItem[]}                  items       The items the page text was built from
 * @param   {PdfTextSelection|undefined}     selection   The link's selection, if any
 * @param   {string|undefined}               sourceText  The quoted text below the link, if any
 *
 * @return  {SourceTextResolution}                       The selection to highlight and how it was found
 */
export function resolveSelectionBySourceText (
  pageText: PdfPageText,
  items: PdfTextItem[],
  selection: PdfTextSelection|undefined,
  sourceText: string|undefined
): SourceTextResolution {
  if (selection === undefined) {
    return { selection: undefined, method: 'index' }
  }

  const sourceKey = normalizeForSourceTextMatch(sourceText ?? '')
  if (sourceKey === '') {
    return { selection, method: 'index' }
  }

  const selectedKey = normalizeForSourceTextMatch(toQuoteText(selectionText(items, selection)))
  if (selectedKey === sourceKey) {
    return { selection, method: 'index' }
  }

  const found = findSourceTextOnPage(pageText, sourceText ?? '')
  if (found.occurrences !== 1) {
    return { selection, method: 'fallback' }
  }

  return { selection: pageRangeToSelection(pageText, items, found.from, found.to), method: 'text' }
}
