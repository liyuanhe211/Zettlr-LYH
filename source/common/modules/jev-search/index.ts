/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        JEV search chunking, batching and hit helpers
 * CVM-Role:        Utility Function
 * License:         GNU GPL v3
 *
 * Description:     The pure functions behind the JEV Search panel (R53,
 *                  contract C4): splitting a document into chunks, grouping
 *                  the chunks into requests that stay below the estimated
 *                  token budget, and the small helpers the panel needs to
 *                  rank, present and relocate hits. Depends on nothing but the
 *                  shared types, so mocha tests it directly.
 *
 * END HEADER
 */

import {
  estimateJevTokens,
  JEV_SEARCH_BASE_OVERHEAD_TOKENS,
  JEV_SEARCH_DEFAULT_MAX_CHUNK_CHARACTERS,
  JEV_SEARCH_HIT_THRESHOLD,
  JEV_SEARCH_MAX_MAX_CHUNK_CHARACTERS,
  JEV_SEARCH_MIN_MAX_CHUNK_CHARACTERS,
  JEV_SEARCH_PER_CHUNK_OVERHEAD_TOKENS,
  JEV_SEARCH_REQUEST_TOKEN_BUDGET,
  type JevSearchChunk
} from '@dts/common/jev-search'

export { estimateJevTokens } from '@dts/common/jev-search'

/**
 * What the JEV Search panel asks the editors to do (carried as the data of
 * the jevSearchHighlight editor command): scroll the given range of the given
 * file into the middle of the view and highlight it, or, when null, remove
 * the highlight from every editor.
 * `scroll` (R57) defaults to true; when false, the editor only replaces the
 * highlight and does not scroll.
 */
export type JevSearchHighlightRequest = { filePath: string, from: number, to: number, scroll?: boolean }|null

/**
 * A stretch of the document, as offsets into it
 */
interface TextRange {
  from: number
  to: number
}

/**
 * One unit of the chunking rules: a paragraph, a fenced code block, the YAML
 * front matter or an ATX heading (the only kind that is flagged)
 */
interface TextUnit extends TextRange {
  isHeading: boolean
}

/**
 * One line of the document; `to` excludes the line feed
 */
interface TextLine extends TextRange {
  text: string
}

const FENCE_OPENING = /^ {0,3}(`{3,}|~{3,})/
const FENCE_CLOSING = /^ {0,3}(`{3,}|~{3,})\s*$/
const ATX_HEADING = /^ {0,3}#{1,6}(?:\s|$)/
const YAML_OPENING = /^---\s*$/
const YAML_CLOSING = /^(?:---|\.\.\.)\s*$/
const WHITESPACE = /\s/

// A sentence ends after one of these, no matter what follows
const CJK_SENTENCE_ENDS = '。！？；'
// A sentence ends after one of these only when whitespace or the end follows
const ASCII_SENTENCE_ENDS = '.!?;'
// Closing quotes and brackets right after a sentence end stay with the sentence
const CLOSING_PUNCTUATION = '"\'”’」』）)]】》'

function isWhitespace (character: string): boolean {
  return WHITESPACE.test(character)
}

/**
 * Narrows a range so that it neither starts nor ends with whitespace.
 *
 * @return  {TextRange|undefined}  The narrowed range, or undefined when the
 *                                 range holds nothing but whitespace
 */
function trimRange (text: string, from: number, to: number): TextRange|undefined {
  let start = from
  let end = to
  while (start < end && isWhitespace(text[start])) {
    start++
  }
  while (end > start && isWhitespace(text[end - 1])) {
    end--
  }
  return start < end ? { from: start, to: end } : undefined
}

function pushTrimmed (ranges: TextRange[], text: string, from: number, to: number): void {
  const range = trimRange(text, from, to)
  if (range !== undefined) {
    ranges.push(range)
  }
}

function splitLines (text: string): TextLine[] {
  const lines: TextLine[] = []
  let start = 0
  for (;;) {
    const lineFeed = text.indexOf('\n', start)
    const end = lineFeed === -1 ? text.length : lineFeed
    lines.push({ from: start, to: end, text: text.slice(start, end) })
    if (lineFeed === -1) {
      return lines
    }
    start = lineFeed + 1
  }
}

function isClosingFence (lineText: string, openingMarker: string): boolean {
  const match = FENCE_CLOSING.exec(lineText)
  return match !== null && match[1][0] === openingMarker[0] && match[1].length >= openingMarker.length
}

/**
 * Chunking rule 1: cuts the document into units. Paragraphs are separated by
 * blank lines; a fenced code block (including its blank lines) and the YAML
 * front matter are one unit each; an ATX heading line is a unit of its own.
 * Every unit is trimmed; whitespace-only units are dropped.
 */
function parseUnits (text: string): TextUnit[] {
  const lines = splitLines(text)
  const units: TextUnit[] = []

  const pushUnit = (from: number, to: number, isHeading: boolean): void => {
    const range = trimRange(text, from, to)
    if (range !== undefined) {
      units.push({ ...range, isHeading })
    }
  }

  let index = 0
  if (lines.length > 1 && YAML_OPENING.test(lines[0].text)) {
    const closing = lines.findIndex((line, lineIndex) => lineIndex > 0 && YAML_CLOSING.test(line.text))
    if (closing > 0) {
      pushUnit(lines[0].from, lines[closing].to, false)
      index = closing + 1
    }
  }

  let paragraphStart = -1
  const endParagraph = (lastLineIndex: number): void => {
    if (paragraphStart >= 0) {
      pushUnit(lines[paragraphStart].from, lines[lastLineIndex].to, false)
      paragraphStart = -1
    }
  }

  while (index < lines.length) {
    const line = lines[index]

    if (line.text.trim() === '') {
      endParagraph(index - 1)
      index++
      continue
    }

    const fence = FENCE_OPENING.exec(line.text)
    if (fence !== null) {
      endParagraph(index - 1)
      // An unclosed fence runs to the end of the document
      let last = lines.length - 1
      for (let next = index + 1; next < lines.length; next++) {
        if (isClosingFence(lines[next].text, fence[1])) {
          last = next
          break
        }
      }
      pushUnit(line.from, lines[last].to, false)
      index = last + 1
      continue
    }

    if (ATX_HEADING.test(line.text)) {
      endParagraph(index - 1)
      pushUnit(line.from, line.to, true)
      index++
      continue
    }

    if (paragraphStart < 0) {
      paragraphStart = index
    }
    index++
  }
  endParagraph(lines.length - 1)

  return units
}

/**
 * Chunking rule 3, first step: cuts a range into sentences. A sentence ends
 * after 。！？；, after .!?; followed by whitespace or the end of the range,
 * and at every line feed. Closing quotes and brackets right after the
 * punctuation stay with the sentence.
 */
function splitIntoSentences (text: string, from: number, to: number): TextRange[] {
  const sentences: TextRange[] = []
  let start = from
  let position = from

  while (position < to) {
    const character = text[position]
    let boundary = -1

    if (character === '\n') {
      boundary = position
    } else if (CJK_SENTENCE_ENDS.includes(character) || ASCII_SENTENCE_ENDS.includes(character)) {
      let end = position + 1
      while (end < to && CLOSING_PUNCTUATION.includes(text[end])) {
        end++
      }
      if (CJK_SENTENCE_ENDS.includes(character) || end >= to || isWhitespace(text[end])) {
        boundary = end
      }
    }

    if (boundary >= 0) {
      pushTrimmed(sentences, text, start, boundary)
      start = boundary
      position = Math.max(boundary, position + 1)
    } else {
      position++
    }
  }
  pushTrimmed(sentences, text, start, to)

  return sentences
}

function isHighSurrogate (code: number): boolean {
  return code >= 0xD800 && code <= 0xDBFF
}

function isLowSurrogate (code: number): boolean {
  return code >= 0xDC00 && code <= 0xDFFF
}

/**
 * Chunking rule 3, last resort: cuts a sentence longer than the limit into
 * pieces of the limit's length. A cut never separates a surrogate pair.
 */
function hardCut (text: string, from: number, to: number, limit: number): TextRange[] {
  const pieces: TextRange[] = []
  let start = from
  while (to - start > limit) {
    let end = start + limit
    if (end - 1 > start && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) {
      end--
    }
    pushTrimmed(pieces, text, start, end)
    start = end
  }
  pushTrimmed(pieces, text, start, to)
  return pieces
}

/**
 * Splits a document into the chunks the JEV search judges one by one
 * (contract C4, chunking rules 1 to 4).
 *
 * @param   {string}            text                The whole document
 * @param   {number}            maxChunkCharacters  Upper bound of a chunk's length
 *
 * @return  {JevSearchChunk[]}                      Chunks in document order;
 *                                                  `text` always equals the
 *                                                  document sliced from `from`
 *                                                  to `to`
 */
export function splitIntoJevChunks (text: string, maxChunkCharacters: number): JevSearchChunk[] {
  const limit = Number.isFinite(maxChunkCharacters)
    ? Math.max(1, Math.floor(maxChunkCharacters))
    : JEV_SEARCH_DEFAULT_MAX_CHUNK_CHARACTERS

  // Rule 3: units above the limit fall apart into sentences, and sentences
  // above the limit into hard-cut pieces. Only the first piece of a heading
  // keeps the heading flag.
  const pieces: TextUnit[] = []
  for (const unit of parseUnits(text)) {
    if (unit.to - unit.from <= limit) {
      pieces.push(unit)
      continue
    }

    let isFirstPiece = true
    for (const sentence of splitIntoSentences(text, unit.from, unit.to)) {
      const parts = sentence.to - sentence.from <= limit
        ? [sentence]
        : hardCut(text, sentence.from, sentence.to, limit)
      for (const part of parts) {
        pieces.push({ ...part, isHeading: unit.isHeading && isFirstPiece })
        isFirstPiece = false
      }
    }
  }

  // Rule 2: greedy merging. A piece joins the current chunk as long as the
  // chunk's span stays within the limit; a heading always starts a new chunk.
  const chunks: JevSearchChunk[] = []
  let current: TextRange|undefined
  for (const piece of pieces) {
    if (current !== undefined && !piece.isHeading && piece.to - current.from <= limit) {
      current.to = piece.to
      continue
    }
    if (current !== undefined) {
      chunks.push({ from: current.from, to: current.to, text: text.slice(current.from, current.to) })
    }
    current = { from: piece.from, to: piece.to }
  }
  if (current !== undefined) {
    chunks.push({ from: current.from, to: current.to, text: text.slice(current.from, current.to) })
  }

  return chunks
}

/**
 * Groups chunks into requests (contract C4, batching rule). Chunks are taken
 * in order; a batch is closed as soon as the next chunk would push its
 * estimated tokens (the prompt once, the base overhead, and per chunk its text
 * plus the question overhead) above the budget. A chunk that alone exceeds the
 * budget gets a batch of its own.
 *
 * @param   {string[]}    chunks       Chunk texts in document order
 * @param   {string}      prompt       The search description
 * @param   {number}      tokenBudget  Estimated-token budget of one request
 *
 * @return  {number[][]}               Chunk indices per batch
 */
export function planJevSearchBatches (chunks: string[], prompt: string, tokenBudget: number = JEV_SEARCH_REQUEST_TOKEN_BUDGET): number[][] {
  const requestBase = estimateJevTokens(prompt) + JEV_SEARCH_BASE_OVERHEAD_TOKENS
  const batches: number[][] = []
  let batch: number[] = []
  let batchTokens = requestBase

  chunks.forEach((chunk, index) => {
    const chunkTokens = estimateJevTokens(chunk) + JEV_SEARCH_PER_CHUNK_OVERHEAD_TOKENS
    if (batch.length > 0 && batchTokens + chunkTokens > tokenBudget) {
      batches.push(batch)
      batch = []
      batchTokens = requestBase
    }
    batch.push(index)
    batchTokens += chunkTokens
  })

  if (batch.length > 0) {
    batches.push(batch)
  }

  return batches
}

/**
 * Brings a maximum chunk length entered by the user into the valid range.
 *
 * @param   {number}  value  The entered value
 *
 * @return  {number}         An integer between the C4 range bounds; the
 *                           default for anything that is not a number
 */
export function clampJevMaxChunkCharacters (value: number): number {
  if (!Number.isFinite(value)) {
    return JEV_SEARCH_DEFAULT_MAX_CHUNK_CHARACTERS
  }
  return Math.min(JEV_SEARCH_MAX_MAX_CHUNK_CHARACTERS, Math.max(JEV_SEARCH_MIN_MAX_CHUNK_CHARACTERS, Math.round(value)))
}

/**
 * Picks the hits among the judged chunks.
 *
 * @param   {number[]}  probabilities  Probability of "yes" per chunk
 * @param   {number}    threshold      Lowest probability that counts as a hit
 *
 * @return  {number[]}                 Indices of the hits, most probable
 *                                     first; ties keep document order
 */
export function rankJevSearchHits (probabilities: number[], threshold: number = JEV_SEARCH_HIT_THRESHOLD): number[] {
  return probabilities
    .map((probability, index) => ({ probability, index }))
    .filter(entry => Number.isFinite(entry.probability) && entry.probability >= threshold)
    .sort((a, b) => b.probability - a.probability || a.index - b.index)
    .map(entry => entry.index)
}

/**
 * Computes 1-based line numbers for offsets into a document in one pass.
 *
 * @param   {string}    text     The document
 * @param   {number[]}  offsets  Offsets in any order
 *
 * @return  {number[]}           The line number of each offset, same order
 */
export function jevLineNumbers (text: string, offsets: number[]): number[] {
  const order = offsets.map((offset, index) => ({ offset: Math.max(0, Math.min(text.length, offset)), index }))
    .sort((a, b) => a.offset - b.offset)
  const lineNumbers = new Array<number>(offsets.length)
  let line = 1
  let position = 0
  for (const { offset, index } of order) {
    for (; position < offset; position++) {
      if (text.charCodeAt(position) === 10) {
        line++
      }
    }
    lineNumbers[index] = line
  }
  return lineNumbers
}

/**
 * The preview line of a hit: the start of the chunk with every run of
 * whitespace collapsed into one space.
 *
 * @param   {string}  text       The chunk text
 * @param   {number}  maxLength  Characters (code points) to keep
 *
 * @return  {string}             The preview, with an ellipsis when cut
 */
export function jevChunkPreview (text: string, maxLength = 200): string {
  const characters = Array.from(text.replace(/\s+/g, ' ').trim())
  if (characters.length <= maxLength) {
    return characters.join('')
  }
  return characters.slice(0, maxLength).join('').trimEnd() + '…'
}

/**
 * Finds a chunk in the current version of its document: in place when the
 * text between its offsets is unchanged, otherwise the occurrence of its text
 * closest to its old start.
 *
 * @param   {string}                  text   The current document
 * @param   {JevSearchChunk}          chunk  The chunk as found by the search
 *
 * @return  {{ from: number, to: number }|undefined}  Where the chunk is now, or
 *                                           undefined when its text no longer
 *                                           occurs
 */
export function locateJevChunk (text: string, chunk: JevSearchChunk): { from: number, to: number }|undefined {
  if (chunk.text === '') {
    return undefined
  }
  if (text.slice(chunk.from, chunk.to) === chunk.text) {
    return { from: chunk.from, to: chunk.to }
  }

  let best = -1
  for (let found = text.indexOf(chunk.text); found !== -1; found = text.indexOf(chunk.text, found + 1)) {
    if (best === -1 || Math.abs(found - chunk.from) < Math.abs(best - chunk.from)) {
      best = found
    }
    if (found > chunk.from) {
      break // Later occurrences are only farther away
    }
  }

  return best === -1 ? undefined : { from: best, to: best + chunk.text.length }
}
