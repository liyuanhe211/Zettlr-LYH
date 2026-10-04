/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        JSON and JSON Lines to Markdown conversion
 * CVM-Role:        Utility function
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Converts JSON data into a readable Markdown outline for the
 *                  read-only formatted JSON viewer. Object keys become headings
 *                  (top-level keys on level three, so that the headings do not
 *                  dwarf the text), array items become sibling headings named
 *                  "key - 1", "key - 2", ..., and string values are written out
 *                  verbatim, so that escape sequences such as \n or \" show up
 *                  as the characters they stand for.
 *
 * END HEADER
 */

import type { ToCEntry } from '@common/modules/markdown-editor/plugins/toc-field'

/**
 * The heading level of top-level keys (and of JSON Lines records). Level one and
 * two headings are rendered so large that they dwarf the values beneath them.
 */
const TOP_LEVEL_HEADING_LEVEL = 3

/**
 * The deepest heading level Markdown supports. Keys nested deeper than this are
 * written as bold paragraphs instead.
 */
const MAXIMUM_HEADING_LEVEL = 6

/**
 * Raw lines that failed to parse are quoted in the output; longer lines are cut
 * off so that a single broken multi-megabyte record cannot flood the view.
 */
const MAXIMUM_QUOTED_LINE_LENGTH = 5000

export interface JSONParseError {
  /**
   * The one-indexed line of the source file the error refers to, if known
   */
  line: number|undefined
  /**
   * The error message of the JSON parser
   */
  message: string
}

export interface JSONMarkdownConversion {
  /**
   * The generated Markdown document
   */
  markdown: string
  /**
   * How the content has been interpreted. A file ending in .json whose content
   * is not a single JSON value but valid JSON Lines is shown as JSON Lines.
   */
  format: 'json'|'jsonl'
  /**
   * The number of successfully parsed top-level values (one per JSON Lines
   * record, or one for a valid JSON document)
   */
  recordCount: number
  /**
   * All parse errors encountered during conversion
   */
  errors: JSONParseError[]
}

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/

/**
 * Appends a closing fence if the text opens a fenced code block without closing
 * it. Otherwise the code block would swallow all headings that follow.
 *
 * @param   {string}  text  The Markdown text
 *
 * @return  {string}        The text with all code fences closed
 */
function closeUnterminatedCodeFence (text: string): string {
  let openFence: string|undefined

  for (const line of text.split('\n')) {
    const match = FENCE_LINE.exec(line)
    if (match === null) {
      continue
    }

    const [ , fence, rest ] = match
    if (openFence === undefined) {
      // Backtick fences may not contain backticks in their info string
      if (!fence.startsWith('`') || !rest.includes('`')) {
        openFence = fence
      }
    } else if (fence[0] === openFence[0] && fence.length >= openFence.length && rest.trim() === '') {
      openFence = undefined
    }
  }

  return openFence === undefined ? text : `${text}\n${openFence}`
}

/**
 * Wraps text into a fenced code block whose fence is longer than any backtick
 * sequence inside the text.
 *
 * @param   {string}  text  The text to quote
 *
 * @return  {string}        The fenced code block
 */
function fencedCodeBlock (text: string): string {
  const longestBacktickRun = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length))
  const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1))
  return `${fence}\n${text}\n${fence}`
}

function headingLine (title: string, level: number): string {
  let text = title.replace(/\s*[\r\n]+\s*/g, ' ').trim()
  if (text === '') {
    text = '(empty key)'
  }

  return level <= MAXIMUM_HEADING_LEVEL ? `${'#'.repeat(level)} ${text}` : `**${text}**`
}

function stringBlock (value: string): string {
  if (value === '') {
    return '*(empty string)*'
  }

  if (value.trim() === '') {
    return '*(whitespace-only string)*'
  }

  return closeUnterminatedCodeFence(value.replace(/\r\n?/g, '\n'))
}

function scalarBlock (value: unknown): string {
  return typeof value === 'string' ? stringBlock(value) : String(JSON.stringify(value))
}

/**
 * Whether the value fits on a single bullet list line. Arrays consisting only
 * of such values are shown as a bullet list instead of one heading per item.
 */
function isInlineScalar (value: unknown): boolean {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return true
  }

  return typeof value === 'string' && value.trim() !== '' && !/[\r\n]/.test(value)
}

function isObject (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isExpandedArray (value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0 && !value.every(isInlineScalar)
}

function errorMessage (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function renderArrayItems (titlePrefix: string|undefined, items: unknown[], level: number, blocks: string[]): void {
  items.forEach((item, index) => {
    const title = titlePrefix === undefined ? `Item ${index + 1}` : `${titlePrefix} - ${index + 1}`
    renderEntry(title, item, level, blocks)
  })
}

/**
 * Renders a titled value. Arrays that cannot be shown as a bullet list are
 * flattened into sibling headings "title - 1", "title - 2", ... on the same
 * level instead of receiving a heading of their own.
 */
function renderEntry (title: string, value: unknown, level: number, blocks: string[]): void {
  if (isExpandedArray(value)) {
    renderArrayItems(title, value, level, blocks)
    return
  }

  blocks.push(headingLine(title, level))
  renderBody(value, level, blocks)
}

/**
 * Renders the contents of a value whose heading (if any) is on the given level.
 */
function renderBody (value: unknown, level: number, blocks: string[]): void {
  if (isExpandedArray(value)) {
    renderArrayItems(undefined, value, level + 1, blocks)
  } else if (Array.isArray(value)) {
    blocks.push(value.length === 0
      ? '*(empty array)*'
      : value.map(item => `- ${scalarBlock(item)}`).join('\n'))
  } else if (isObject(value)) {
    const entries = Object.entries(value)
    if (entries.length === 0) {
      blocks.push('*(empty object)*')
    }

    for (const [ key, child ] of entries) {
      renderEntry(key, child, level + 1, blocks)
    }
  } else {
    blocks.push(scalarBlock(value))
  }
}

function joinBlocks (blocks: string[]): string {
  return blocks.length === 0 ? '*(empty file)*\n' : blocks.join('\n\n') + '\n'
}

function stripByteOrderMark (content: string): string {
  return content.startsWith('﻿') ? content.slice(1) : content
}

/**
 * Converts an already parsed JSON value into a Markdown outline. Keys of a
 * top-level object become level-three headings.
 *
 * @param   {unknown}  value  The parsed JSON value
 *
 * @return  {string}          The Markdown document
 */
export function jsonValueToMarkdown (value: unknown): string {
  const blocks: string[] = []
  renderBody(value, TOP_LEVEL_HEADING_LEVEL - 1, blocks)
  return joinBlocks(blocks)
}

/**
 * Converts the contents of a JSON Lines file. Every non-empty line becomes a
 * level-three heading carrying its line number in the file, so that a record can
 * be located again in the raw text. Lines that fail to parse are reported and
 * quoted instead of aborting the conversion.
 *
 * @param   {string}                  content  The file contents
 *
 * @return  {JSONMarkdownConversion}           The conversion result
 */
export function convertJSONLinesToMarkdown (content: string): JSONMarkdownConversion {
  const blocks: string[] = []
  const errors: JSONParseError[] = []
  let recordCount = 0

  stripByteOrderMark(content).split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === '') {
      return
    }

    const lineNumber = index + 1
    try {
      const value: unknown = JSON.parse(line)
      recordCount++
      renderEntry(`Line ${lineNumber}`, value, TOP_LEVEL_HEADING_LEVEL, blocks)
    } catch (error) {
      const message = errorMessage(error)
      errors.push({ line: lineNumber, message })
      const quotedLine = line.length > MAXIMUM_QUOTED_LINE_LENGTH
        ? `${line.slice(0, MAXIMUM_QUOTED_LINE_LENGTH)} … (line has ${line.length} characters; the rest is omitted)`
        : line
      blocks.push(headingLine(`Line ${lineNumber} (parse error)`, TOP_LEVEL_HEADING_LEVEL), fencedCodeBlock(message), fencedCodeBlock(quotedLine))
    }
  })

  return { markdown: joinBlocks(blocks), format: 'jsonl', recordCount, errors }
}

/**
 * Converts the contents of a JSON file. If the content is not a single JSON
 * value but consists of several valid JSON Lines records, it is converted as
 * JSON Lines instead, since language model tooling frequently writes JSON Lines
 * into files ending in .json.
 *
 * @param   {string}                  content  The file contents
 *
 * @return  {JSONMarkdownConversion}           The conversion result
 */
export function convertJSONToMarkdown (content: string): JSONMarkdownConversion {
  const text = stripByteOrderMark(content)
  if (text.trim() === '') {
    return { markdown: joinBlocks([]), format: 'json', recordCount: 0, errors: [] }
  }

  try {
    const value: unknown = JSON.parse(text)
    return { markdown: jsonValueToMarkdown(value), format: 'json', recordCount: 1, errors: [] }
  } catch (error) {
    const asJSONLines = convertJSONLinesToMarkdown(text)
    if (asJSONLines.recordCount > 1 && asJSONLines.errors.length === 0) {
      return asJSONLines
    }

    const message = errorMessage(error)
    const position = /at position (\d+)/.exec(message)
    const line = position === null
      ? undefined
      : text.slice(0, parseInt(position[1], 10)).split('\n').length

    const blocks = [
      headingLine('Parse Error', TOP_LEVEL_HEADING_LEVEL),
      fencedCodeBlock(message),
      line === undefined
        ? 'The file is not valid JSON. Switch to "Raw Text" mode to view or edit it.'
        : `The file is not valid JSON; the error is near line ${line}. Switch to "Raw Text" mode to view or edit it.`
    ]
    return { markdown: joinBlocks(blocks), format: 'json', recordCount: 0, errors: [{ line, message }] }
  }
}

/**
 * Shifts the table of contents of a converted document so that top-level keys
 * appear on level one again, with numbering "1", "1.1", ... instead of "0.0.1",
 * "0.0.1.1", .... Headings written out inside string values may sit above the
 * top level; they are placed on level one.
 *
 * @param   {ToCEntry[]}  entries  The table of contents of the converted document
 *
 * @return  {ToCEntry[]}           The shifted table of contents
 */
export function rebaseTableOfContents (entries: ToCEntry[]): ToCEntry[] {
  const counters: number[] = []

  return entries.map(entry => {
    const level = Math.max(1, entry.level - (TOP_LEVEL_HEADING_LEVEL - 1))
    while (counters.length < level) {
      counters.push(0)
    }
    counters.length = level
    counters[level - 1]++

    return { ...entry, level, renderedLevel: counters.join('.') }
  })
}
