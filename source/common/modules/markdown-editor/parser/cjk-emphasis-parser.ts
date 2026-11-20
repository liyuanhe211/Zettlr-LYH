/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        CJK-friendly emphasis parser
 * CVM-Role:        InlineParser
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     CommonMark does not let a delimiter run such as `**` close
 *                  when it is preceded by punctuation and followed by a letter
 *                  (and vice versa for opening). In Chinese and Japanese text
 *                  there is no space between words, so `**重点。**后文` never
 *                  renders bold. This parser wraps Lezer's own Emphasis and
 *                  Strikethrough parsers and additionally treats a CJK
 *                  character on the outer side of a delimiter run like
 *                  whitespace, following the "markdown-cjk-friendly"
 *                  amendment to the flanking rules. Text without CJK
 *                  characters around the delimiter is parsed unchanged.
 *
 * END HEADER
 */

import type { InlineContext, InlineParser } from '@lezer/markdown'

// Lezer's own definition, see @lezer/markdown (dist/index.js)
let Punctuation = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~\xA1‐-‧]/
try {
  Punctuation = /[\p{S}|\p{P}]/u
} catch (_err) {}

const CJKCharacter = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}　-〿・ー︰-﹏＀-￯]/u
const VariationSelector = /[︀-️\u{E0100}-\u{E01EF}]/u

/**
 * The internals of Lezer's InlineContext and MarkdownParser that this parser
 * relies on. They are not part of the public typings.
 */
interface InlineDelimiterInternal { from: number, to: number, side: number }
interface InlineContextInternal {
  parts: Array<InlineDelimiterInternal|unknown>
  parser: { inlineParsers: Array<((cx: InlineContext, next: number, pos: number) => number)|undefined>, inlineNames: string[] }
}

const MarkOpen = 1
const MarkClose = 2

/**
 * Returns the full code point that ends right before `pos` (or starts at `pos`
 * if `forward` is true), skipping variation selectors so that an ideograph with
 * an ideographic variation sequence still counts as CJK.
 *
 * @param   {InlineContext}  cx       The inline context
 * @param   {number}         pos      The boundary position
 * @param   {boolean}        forward  Whether to read after (true) or before
 *
 * @return  {string}                  The character, or an empty string
 */
function characterAt (cx: InlineContext, pos: number, forward: boolean): string {
  if (forward) {
    const first = cx.slice(pos, Math.min(pos + 2, cx.end))
    const codePoint = first.codePointAt(0)
    return codePoint === undefined ? '' : String.fromCodePoint(codePoint)
  }

  let end = pos
  while (end > cx.offset) {
    let start = end - 1
    const low = cx.char(start)
    if (low >= 0xDC00 && low <= 0xDFFF && start > cx.offset) {
      const high = cx.char(start - 1)
      if (high >= 0xD800 && high <= 0xDBFF) {
        start--
      }
    }
    const character = cx.slice(start, end)
    if (!VariationSelector.test(character)) {
      return character
    }
    end = start
  }
  return ''
}

/**
 * Wraps one of Lezer's delimiter-producing inline parsers. The wrapped parser
 * runs unchanged; if it added a delimiter and a CJK character sits right
 * outside it, the open/close flags are recomputed with the CJK-friendly rules.
 *
 * @param   {string}        name          The name of the new inline parser
 * @param   {string}        originalName  The name of the wrapped Lezer parser
 * @param   {number[]}      characters    The delimiter character codes
 *
 * @return  {InlineParser}                The wrapping inline parser
 */
function cjkFriendlyDelimiterParser (name: string, originalName: string, characters: number[]): InlineParser {
  return {
    name,
    before: originalName,
    parse (cx, next, start) {
      if (!characters.includes(next)) {
        return -1
      }

      const internal = cx as unknown as InlineContextInternal
      const index = internal.parser?.inlineNames?.indexOf(originalName) ?? -1
      const original = index > -1 ? internal.parser.inlineParsers[index] : undefined
      if (original === undefined) {
        return -1
      }

      const partCount = internal.parts.length
      const result = original(cx, next, start)
      if (result < 0 || internal.parts.length !== partCount + 1) {
        return result
      }

      const delimiter = internal.parts[partCount] as InlineDelimiterInternal
      const before = cx.slice(delimiter.from - 1, delimiter.from)
      const after = cx.slice(delimiter.to, delimiter.to + 1)
      const cjkBefore = CJKCharacter.test(characterAt(cx, delimiter.from, false))
      const cjkAfter = CJKCharacter.test(characterAt(cx, delimiter.to, true))
      if (!cjkBefore && !cjkAfter) {
        return result
      }

      const pBefore = Punctuation.test(before)
      const pAfter = Punctuation.test(after)
      const sBefore = /\s|^$/.test(before)
      const sAfter = /\s|^$/.test(after)
      const leftFlanking = !sAfter && (!pAfter || sBefore || pBefore || cjkBefore)
      const rightFlanking = !sBefore && (!pBefore || sAfter || pAfter || cjkAfter)

      let canOpen = leftFlanking
      let canClose = rightFlanking
      if (next === 95 /* _ */) {
        canOpen = leftFlanking && (!rightFlanking || pBefore)
        canClose = rightFlanking && (!leftFlanking || pAfter)
      }

      delimiter.side = (canOpen ? MarkOpen : 0) | (canClose ? MarkClose : 0)
      return result
    }
  }
}

export const cjkEmphasisParser = cjkFriendlyDelimiterParser('CJKEmphasis', 'Emphasis', [ 42 /* * */, 95 /* _ */ ])
export const cjkStrikethroughParser = cjkFriendlyDelimiterParser('CJKStrikethrough', 'Strikethrough', [126])
