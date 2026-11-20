import type { ToCEntry } from '@common/modules/markdown-editor/plugins/toc-field'

/** Extract real table headers without interpreting or rewriting any values. */
export interface TOMLTableEntry extends ToCEntry {
  from: number
  to: number
}

export function extractTOMLTableOfContents (content: string): TOMLTableEntry[] {
  const entries: TOMLTableEntry[] = []
  let stringDelimiter = ''
  let arrayDepth = 0
  let inlineTableDepth = 0
  let position = 0
  let sourcePosition = 0
  const lines = content.split(/\r\n|\r|\n/)
  const separators = content.match(/\r\n|\r|\n/g) ?? []
  const key = '(?:[A-Za-z0-9_-]+|"(?:[^"\\\\]|\\\\.)*"|\'[^\']*\')'
  const headerPattern = new RegExp(`^\\s*(\\[\\[?)\\s*(${key}(?:\\s*\\.\\s*${key})*)\\s*(\\]\\]?)\\s*(?:#.*)?$`)

  lines.forEach((line, index) => {
    if (stringDelimiter === '' && arrayDepth === 0 && inlineTableDepth === 0) {
      const match = headerPattern.exec(line)
      if (match !== null && match[1].length === match[3].length) {
        // Count only dots outside quoted keys for the outline depth.
        const parts = match[2].match(new RegExp(key, 'g')) ?? []
        entries.push({
          line: index + 1, pos: position, from: sourcePosition, to: sourcePosition + line.length, text: match[2],
          level: Math.min(parts.length, 6), renderedLevel: '', id: `toml-table-${index + 1}`
        })
        position += line.length + 1
        sourcePosition += line.length + (separators[index]?.length ?? 0)
        return
      }
    }

    for (let cursor = 0; cursor < line.length;) {
      const character = line[cursor]
      if (stringDelimiter !== '') {
        if (stringDelimiter[0] === '"' && character === '\\') {
          cursor += 2
        } else if (line.startsWith(stringDelimiter, cursor)) {
          cursor += stringDelimiter.length
          // Multiline TOML strings may end with four or five quotes.
          if (stringDelimiter.length === 3) {
            let extraQuotes = 0
            while (line[cursor] === stringDelimiter[0] && extraQuotes < 2) {
              cursor++
              extraQuotes++
            }
          }
          stringDelimiter = ''
        } else {
          cursor++
        }
      } else if (character === '#') {
        break
      } else if (character === '"' || character === "'") {
        stringDelimiter = line.startsWith(character.repeat(3), cursor) ? character.repeat(3) : character
        cursor += stringDelimiter.length
      } else {
        if (character === '[') {arrayDepth++}
        if (character === ']') {arrayDepth = Math.max(0, arrayDepth - 1)}
        if (character === '{') {inlineTableDepth++}
        if (character === '}') {inlineTableDepth = Math.max(0, inlineTableDepth - 1)}
        cursor++
      }
    }
    // Single-line strings cannot continue on the next line, even if invalid.
    if (stringDelimiter.length === 1) {stringDelimiter = ''}
    position += line.length + 1
    sourcePosition += line.length + (separators[index]?.length ?? 0)
  })
  return entries
}

// ---------------------------------------------------------------------------
// Zettlr-LYH (R128): table sections that can be shown as tables
// ---------------------------------------------------------------------------

/**
 * One `key = value` line of a TOML section that can be shown as a table row.
 * All offsets refer to the text that was given to classifyTOMLSections.
 */
export interface TOMLSectionRow {
  /** The one-indexed line number */
  line: number
  /** The key as written, including its quotes if it has any */
  key: string
  /** The value as written, without the comment at the end of the line */
  value: string
  /** The comment at the end of the line without its number sign and surrounding whitespace; empty if there is none */
  comment: string
  /** The offset of the first character of the key */
  keyFrom: number
  /** The offset of the first character of the value */
  valueFrom: number
  /** The offset of the start of the line */
  lineFrom: number
  /** The offset of the end of the line, before the line break */
  lineTo: number
}

/**
 * A TOML section: a table header line (`[name]` or `[[name]]`) with the lines
 * up to the next header, or the lines before the first header of the document
 * (the headerless top-level section, only present if it has content).
 */
export interface TOMLSection {
  /** The offset of the start of the header line; 0 for the top-level section */
  from: number
  /** The offset of the end of the last key line (the last line with content if the section is not displayable); the end of the header line if there is none */
  to: number
  /** The one-indexed line number of the header line; null for the top-level section */
  headerLine: number|null
  /** The offset of the end of the header line; the start of the text for the top-level section */
  headerLineEnd: number
  /** The name of an array table (`[[name]]`) without surrounding whitespace; null for every other section */
  arrayTableName: string|null
  /** Whether the section can be shown as a table (see classifyTOMLSections) */
  displayable: boolean
  /** The key lines in their order; only filled if the section is displayable */
  rows: TOMLSectionRow[]
  /** Whether there is a comment-only line between the header and the first key line */
  hasLeadingComment: boolean
  /** Whether there is a comment-only line between the last key line and the next header */
  hasTrailingComment: boolean
}

/** One cell of a row of a table that unites array table sections */
export interface TOMLArrayGroupCell {
  /** The value as written */
  value: string
  /** The offset of the first character of the value */
  valueFrom: number
}

/** One row (one section) of a table that unites array table sections */
export interface TOMLArrayGroupRow {
  /** The index of the section in the sections of the group */
  sectionIndex: number
  /** The one-indexed line number of the header line of the section */
  headerLine: number
  /** The offset of the end of the header line of the section */
  headerLineEnd: number
  /** One cell per column; null where the section has no such key */
  cells: Array<TOMLArrayGroupCell|null>
  /** The comments of the section joined with "; "; empty if there are none */
  comment: string
}

/** A section that is shown on its own: a normal table or the top-level section */
export interface TOMLSectionUnit {
  kind: 'section'
  section: TOMLSection
}

/** Consecutive array table sections of the same name, to be shown as one table */
export interface TOMLArrayGroupUnit {
  kind: 'array-group'
  /** The name of the array table */
  name: string
  /** The sections of the group in the order of the document */
  sections: TOMLSection[]
  /** Whether the group can be shown as one table */
  displayable: boolean
  /** The keys of all sections in the order of their first appearance; empty if the group is not displayable */
  columns: string[]
  /** Whether any row has a comment, which adds a Comment column */
  hasComment: boolean
  /** One row per section; empty if the group is not displayable */
  rows: TOMLArrayGroupRow[]
  /** The offset of the start of the header line of the first section */
  from: number
  /** The offset of the end of the last key line of the last section */
  to: number
}

export type TOMLTableUnit = TOMLSectionUnit|TOMLArrayGroupUnit

interface SourceLine {
  text: string
  from: number
  to: number
}

/** Splits a text into lines with their offsets; CRLF, CR and LF end a line. */
function splitSourceLines (content: string): SourceLine[] {
  const lines: SourceLine[] = []
  const lineBreak = /\r\n|\r|\n/g
  let start = 0
  for (let match = lineBreak.exec(content); match !== null; match = lineBreak.exec(content)) {
    lines.push({ text: content.slice(start, match.index), from: start, to: match.index })
    start = match.index + match[0].length
  }
  lines.push({ text: content.slice(start), from: start, to: content.length })
  return lines
}

// A simple key (bare or quoted, but not dotted) followed by the equals sign
const TOML_ROW_START = new RegExp('^(\\s*)((?:[A-Za-z0-9_-]+|"(?:[^"\\\\]|\\\\.)*"|\'[^\']*\'))\\s*=\\s*')

/**
 * Finds the end of a single-line string.
 *
 * @param   {string}  line   The line
 * @param   {number}  start  The index of the opening quote
 *
 * @return  {number}         The index after the closing quote; -1 if the string is a multiline string or does not end in this line
 */
function singleLineStringEnd (line: string, start: number): number {
  const quote = line[start]
  if (line.startsWith(quote.repeat(3), start)) {
    return -1
  }
  for (let cursor = start + 1; cursor < line.length; cursor++) {
    if (quote === '"' && line[cursor] === '\\') {
      cursor++
    } else if (line[cursor] === quote) {
      return cursor + 1
    }
  }
  return -1
}

/**
 * Finds the end of a value that fits into one line: a single-line string, a
 * number, boolean or date, an array, or an inline table. This is a lexical
 * scan, not a validation.
 *
 * @param   {string}  line   The line
 * @param   {number}  start  The index of the first character of the value
 *
 * @return  {number}         The index after the value; -1 if there is no value, or if the value does not end in this line
 */
function singleLineValueEnd (line: string, start: number): number {
  const first = line[start]
  if (first === undefined || first === '#') {
    return -1
  }
  if (first === '"' || first === "'") {
    return singleLineStringEnd(line, start)
  }
  if (first === '[' || first === '{') {
    let depth = 0
    for (let cursor = start; cursor < line.length; cursor++) {
      const character = line[cursor]
      if (character === '"' || character === "'") {
        const end = singleLineStringEnd(line, cursor)
        if (end < 0) {
          return -1
        }
        cursor = end - 1
      } else if (character === '#') {
        // The rest of the line is a comment, so the value goes on in a later line
        return -1
      } else if (character === '[' || character === '{') {
        depth++
      } else if (character === ']' || character === '}') {
        depth--
        if (depth === 0) {
          return cursor + 1
        }
      }
    }
    return -1
  }
  // A number, boolean or date, which a comment may follow
  const commentStart = line.indexOf('#', start)
  const end = commentStart < 0 ? line.length : commentStart
  return start + line.slice(start, end).trimEnd().length
}

/**
 * Reads a line as `key = value` with an optional comment.
 *
 * @param   {SourceLine}  line        The line
 * @param   {number}      lineNumber  The one-indexed line number
 *
 * @return  {TOMLSectionRow|null}     The row; null if the line is not a simple single-line key and value
 */
function parseSectionRow (line: SourceLine, lineNumber: number): TOMLSectionRow|null {
  const start = TOML_ROW_START.exec(line.text)
  if (start === null) {
    return null
  }
  const valueStart = start[0].length
  const valueEnd = singleLineValueEnd(line.text, valueStart)
  if (valueEnd < 0) {
    return null
  }
  const rest = line.text.slice(valueEnd).trim()
  if (rest !== '' && !rest.startsWith('#')) {
    return null
  }
  return {
    line: lineNumber,
    key: start[2],
    value: line.text.slice(valueStart, valueEnd),
    comment: rest.slice(1).trim(),
    keyFrom: line.from + start[1].length,
    valueFrom: line.from + valueStart,
    lineFrom: line.from,
    lineTo: line.to
  }
}

/**
 * Builds a section out of its header and the lines up to the next header.
 *
 * @param   {SourceLine[]}             lines        All lines of the text
 * @param   {TOMLTableEntry|null}      header       The header of the section; null for the top-level section
 * @param   {number}                   firstIndex   The index of the first line after the header
 * @param   {number}                   endIndex     The index after the last line of the section
 *
 * @return  {TOMLSection|null}                      The section; null for a top-level section without content
 */
function buildSection (lines: SourceLine[], header: TOMLTableEntry|null, firstIndex: number, endIndex: number): TOMLSection|null {
  // The first and the last line with content (neither empty nor only a comment)
  let first = -1
  let last = -1
  const commentIndexes: number[] = []
  for (let index = firstIndex; index < endIndex; index++) {
    const trimmed = lines[index].text.trim()
    if (trimmed === '') {
      continue
    }
    if (trimmed.startsWith('#')) {
      commentIndexes.push(index)
      continue
    }
    if (first < 0) {
      first = index
    }
    last = index
  }

  if (header === null && first < 0) {
    return null
  }

  // Everything between the first and the last line with content has to be a
  // simple key and value: no empty lines, no comment lines.
  let displayable = first >= 0
  const rows: TOMLSectionRow[] = []
  for (let index = first; displayable && index <= last; index++) {
    const row = parseSectionRow(lines[index], index + 1)
    if (row === null) {
      displayable = false
    } else {
      rows.push(row)
    }
  }
  if (!displayable) {
    rows.length = 0
  }

  // Comment lines outside of the first and the last line with content
  if (first < 0) {
    first = endIndex
    last = firstIndex - 1
  }
  const hasLeadingComment = commentIndexes.some(index => index < first)
  const hasTrailingComment = commentIndexes.some(index => index > last)

  const isArrayTable = header !== null && lines[header.line - 1].text.trim().startsWith('[[')
  const headerLineEnd = header === null ? 0 : header.to
  return {
    from: header === null ? 0 : header.from,
    to: last >= firstIndex ? lines[last].to : headerLineEnd,
    headerLine: header === null ? null : header.line,
    headerLineEnd,
    arrayTableName: header !== null && isArrayTable ? header.text : null,
    displayable,
    rows,
    hasLeadingComment,
    hasTrailingComment
  }
}

/**
 * Splits a TOML text into its sections and decides which of them can be shown
 * as a table. A section is displayable if it has at least one `key = value`
 * line and all lines from its first to its last such line are a simple key (a
 * bare key or a quoted key, but not a dotted key) and a value that ends in the
 * same line (a single-line string, a number, a boolean, a date, a single-line
 * array or a single-line inline table), optionally followed by a comment.
 * Between the first and the last key line there must be neither an empty line
 * nor a comment line; empty lines and comment lines before the first and after
 * the last key line are fine. Array table sections (`[[name]]`) are decided
 * the same way. The scan is lexical and does not validate the TOML; it never
 * throws, whatever the text is.
 *
 * @param   {string}         text  The text of a TOML document
 *
 * @return  {TOMLSection[]}        The sections in the order of the document
 */
export function classifyTOMLSections (text: string): TOMLSection[] {
  if (typeof text !== 'string' || text === '') {
    return []
  }
  const lines = splitSourceLines(text)
  const headers = extractTOMLTableOfContents(text)
  const sections: TOMLSection[] = []

  const topLevel = buildSection(lines, null, 0, headers.length > 0 ? headers[0].line - 1 : lines.length)
  if (topLevel !== null) {
    sections.push(topLevel)
  }
  headers.forEach((header, index) => {
    const endIndex = index + 1 < headers.length ? headers[index + 1].line - 1 : lines.length
    const section = buildSection(lines, header, header.line, endIndex)
    if (section !== null) {
      sections.push(section)
    }
  })
  return sections
}

/**
 * Fills the table of a group of array table sections: whether the group is
 * displayable, its columns, its rows and its range in the text.
 *
 * @param  {TOMLArrayGroupUnit}  group  The group, with its sections
 */
function completeArrayGroup (group: TOMLArrayGroupUnit): void {
  const last = group.sections.length - 1
  group.from = group.sections[0].from
  group.to = group.sections[last].to

  let displayable = group.sections.every((section, index) => {
    return section.displayable && !section.hasLeadingComment && (index === last || !section.hasTrailingComment)
  })
  const columns: string[] = []
  if (displayable) {
    for (const section of group.sections) {
      const seen = new Set<string>()
      for (const row of section.rows) {
        if (seen.has(row.key)) {
          displayable = false
        }
        seen.add(row.key)
        if (!columns.includes(row.key)) {
          columns.push(row.key)
        }
      }
    }
  }
  group.displayable = displayable
  if (!displayable) {
    return
  }

  group.columns = columns
  group.rows = group.sections.map((section, sectionIndex) => {
    const comments = section.rows.map(row => row.comment).filter(comment => comment !== '')
    return {
      sectionIndex,
      headerLine: section.headerLine ?? 0,
      headerLineEnd: section.headerLineEnd,
      cells: columns.map(key => {
        const row = section.rows.find(candidate => candidate.key === key)
        return row === undefined ? null : { value: row.value, valueFrom: row.valueFrom }
      }),
      comment: comments.join('; ')
    }
  })
  group.hasComment = group.rows.some(row => row.comment !== '')
}

/**
 * Orders the sections into the units that are shown as one table each: every
 * section that is not an array table on its own, and consecutive array table
 * sections of the same name as one group. Two array table sections of the same
 * name belong to one group only if no other section lies between them (a
 * sub-table such as `[name.child]` does separate them). A group is displayable
 * if all its sections are, no comment-only line lies inside the range it
 * replaces, and no section has the same key twice, so that the table never
 * hides text of the document. The scan never throws.
 *
 * @param   {TOMLSection[]}      sections  The sections, see classifyTOMLSections
 *
 * @return  {TOMLTableUnit[]}              The units in the order of the document
 */
export function groupTOMLTableSections (sections: TOMLSection[]): TOMLTableUnit[] {
  const units: TOMLTableUnit[] = []
  let current: TOMLArrayGroupUnit|null = null

  for (const section of sections) {
    if (section.arrayTableName === null) {
      units.push({ kind: 'section', section })
      current = null
    } else if (current !== null && current.name === section.arrayTableName) {
      current.sections.push(section)
    } else {
      current = {
        kind: 'array-group', name: section.arrayTableName, sections: [section], displayable: false,
        columns: [], hasComment: false, rows: [], from: section.from, to: section.to
      }
      units.push(current)
    }
  }

  for (const unit of units) {
    if (unit.kind === 'array-group') {
      completeArrayGroup(unit)
    }
  }
  return units
}
