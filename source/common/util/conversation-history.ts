/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Conversation history detection and parsing
 * CVM-Role:        Utility function
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Recognises raw Claude session JSONL files and Compact-LYH
 *                  transcripts by their content alone and parses them into
 *                  the node tree shown by the read-only conversation viewer
 *                  (contract C8). Every node keeps the one-based source lines
 *                  it came from, so that the table of contents, JEV Search and
 *                  jump-to-line can map raw file lines back to nodes. The
 *                  module is pure: it never reads files, touches the network
 *                  or executes anything found in the records.
 *
 * END HEADER
 */

import type {
  ConversationFormat,
  ConversationHistory,
  ConversationNode,
  ConversationNodeKind,
  ConversationOutputState,
  ConversationParseWarning,
  ConversationProvenance,
  ConversationSourceRange,
  ConversationTocItem
} from '@dts/common/conversation-history'

type JsonObject = Record<string, unknown>

/** One raw line of the file content, BOM and trailing carriage return removed. */
interface RawLine {
  line: number
  text: string
}

/** One non-blank line together with the result of parsing it as JSON. */
interface RecordLine {
  line: number
  text: string
  parsed: boolean
  value: unknown
}

const COMPACT_SIGNATURE = '[Compact-LYH-Transcript]'

const CLAUDE_AUXILIARY_TYPES = new Set([
  'attachment', 'system', 'custom-title', 'agent-name', 'mode', 'atis-latch',
  'last-prompt', 'file-history-snapshot', 'file-history-delta',
  'queue-operation', 'cost-state', 'summary'
])

const COMPACT_BLOCK_START = /^<(say|think|user-reply|call|out|err|findings|clip|dropped-blocks)(?=[\s/>])/

const TOC_TEXT_LIMIT = 80

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

function isJsonObject (value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString (value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

function isScalar (value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function splitContentLines (content: string): RawLine[] {
  const parts = content.split('\n')
  const result: RawLine[] = []
  for (let index = 0; index < parts.length; index++) {
    let text = parts[index]
    if (text.endsWith('\r')) {
      text = text.slice(0, -1)
    }
    if (index === 0 && text.startsWith('﻿')) {
      text = text.slice(1)
    }
    result.push({ line: index + 1, text })
  }
  return result
}

function parseRecordLines (lines: RawLine[]): RecordLine[] {
  const records: RecordLine[] = []
  for (const rawLine of lines) {
    if (rawLine.text.trim() === '') {
      continue
    }
    try {
      const value: unknown = JSON.parse(rawLine.text)
      records.push({ line: rawLine.line, text: rawLine.text, parsed: true, value })
    } catch {
      records.push({ line: rawLine.line, text: rawLine.text, parsed: false, value: undefined })
    }
  }
  return records
}

function createNode (
  kind: ConversationNodeKind,
  provenance: ConversationProvenance,
  label: string,
  text: string,
  lines: number[],
  initiallyCollapsed = false
): ConversationNode {
  return {
    id: '',
    kind,
    provenance,
    label,
    text,
    sourceRanges: lines.map(line => ({ firstLine: line, lastLine: line })),
    children: [],
    initiallyCollapsed
  }
}

function addSourceLines (node: ConversationNode, lines: number[]): void {
  for (const line of lines) {
    node.sourceRanges.push({ firstLine: line, lastLine: line })
  }
}

function addSourceRanges (node: ConversationNode, ranges: ConversationSourceRange[]): void {
  for (const range of ranges) {
    node.sourceRanges.push({ firstLine: range.firstLine, lastLine: range.lastLine })
  }
}

function setAttribute (node: ConversationNode, key: string, value: string | number | boolean): void {
  if (node.attributes === undefined) {
    node.attributes = {}
  }
  node.attributes[key] = value
}

function normalizeRanges (ranges: ConversationSourceRange[]): ConversationSourceRange[] {
  const sorted = ranges
    .map(range => ({
      firstLine: Math.min(range.firstLine, range.lastLine),
      lastLine: Math.max(range.firstLine, range.lastLine)
    }))
    .sort((left, right) => left.firstLine - right.firstLine || left.lastLine - right.lastLine)
  const merged: ConversationSourceRange[] = []
  for (const range of sorted) {
    const previous = merged[merged.length - 1]
    if (previous !== undefined && range.firstLine <= previous.lastLine + 1) {
      previous.lastLine = Math.max(previous.lastLine, range.lastLine)
    } else {
      merged.push(range)
    }
  }
  return merged
}

function forEachNodePreorder (
  history: ConversationHistory,
  visit: (node: ConversationNode, ancestors: ConversationNode[]) => void
): void {
  const walk = (node: ConversationNode, ancestors: ConversationNode[]): void => {
    visit(node, ancestors)
    const childAncestors = [ ...ancestors, node ]
    for (const child of node.children) {
      walk(child, childAncestors)
    }
  }
  for (const node of history.metadata) {
    walk(node, [])
  }
  for (const node of history.nodes) {
    walk(node, [])
  }
}

/**
 * Merges the source ranges of every node and assigns the deterministic
 * identifiers n<first line>-<sequence> in preorder (metadata first).
 */
function finalizeHistory (history: ConversationHistory): ConversationHistory {
  const sequenceByLine = new Map<number, number>()
  forEachNodePreorder(history, (node) => {
    node.sourceRanges = normalizeRanges(node.sourceRanges)
    const firstLine = node.sourceRanges[0]?.firstLine ?? 0
    const sequence = sequenceByLine.get(firstLine) ?? 0
    sequenceByLine.set(firstLine, sequence + 1)
    node.id = `n${firstLine}-${sequence}`
  })
  return history
}

function parseErrorNode (record: RecordLine): ConversationNode {
  const node = createNode('parse-error', 'unknown', `Unparsable line ${record.line}`, record.text, [record.line], true)
  node.raw = record.text
  return node
}

function parseErrorWarning (record: RecordLine): ConversationParseWarning {
  return { line: record.line, message: 'Invalid JSON', raw: record.text }
}

// ---------------------------------------------------------------------------
// Raw Claude sessions
// ---------------------------------------------------------------------------

function isValidClaudeContentBlock (block: unknown): boolean {
  if (!isJsonObject(block) || !isNonEmptyString(block.type)) {
    return false
  }
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string'
    case 'thinking':
      return typeof block.thinking === 'string'
    case 'tool_use':
      return isNonEmptyString(block.id) && isNonEmptyString(block.name)
    case 'tool_result':
      return isNonEmptyString(block.tool_use_id) &&
        (block.content === undefined || typeof block.content === 'string' || Array.isArray(block.content))
    default:
      return true
  }
}

function isValidClaudeMessage (record: JsonObject): boolean {
  const message = record.message
  if (!isJsonObject(message) || message.role !== record.type) {
    return false
  }
  if (!isNonEmptyString(record.uuid) || !isNonEmptyString(record.sessionId)) {
    return false
  }
  if (typeof record.timestamp !== 'string' || Number.isNaN(Date.parse(record.timestamp))) {
    return false
  }
  const content = message.content
  if (typeof content === 'string') {
    return true
  }
  return Array.isArray(content) && content.every(isValidClaudeContentBlock)
}

function isClaudeMessageRecord (record: JsonObject): boolean {
  return record.type === 'user' || record.type === 'assistant'
}

function isValidClaudeAuxiliaryRecord (record: JsonObject): boolean {
  if (typeof record.type === 'string' && CLAUDE_AUXILIARY_TYPES.has(record.type)) {
    return true
  }
  return isNonEmptyString(record.type) && isNonEmptyString(record.sessionId)
}

function isClaudeSession (records: RecordLine[]): boolean {
  let parsedCount = 0
  let unparsableCount = 0
  let messageCount = 0
  for (const record of records) {
    if (!record.parsed) {
      unparsableCount++
      continue
    }
    parsedCount++
    if (!isJsonObject(record.value)) {
      return false
    }
    if (isClaudeMessageRecord(record.value)) {
      if (!isValidClaudeMessage(record.value)) {
        return false
      }
      messageCount++
    } else if (!isValidClaudeAuxiliaryRecord(record.value)) {
      return false
    }
  }
  if (parsedCount === 0 || messageCount === 0) {
    return false
  }
  const threshold = Math.max(1, Math.floor(records.length * 0.1))
  return unparsableCount <= threshold && unparsableCount < messageCount
}

/** Values the Claude parser copies from a record onto every node it makes. */
interface ClaudeRecordContext {
  line: number
  sessionId?: string
  timestamp?: string
  isSidechain?: boolean
  apiBlockIndex?: string | number | boolean
  turn?: number
}

function claudeRecordContext (record: JsonObject, line: number, turn?: number): ClaudeRecordContext {
  const context: ClaudeRecordContext = { line }
  if (typeof record.sessionId === 'string') {
    context.sessionId = record.sessionId
  }
  if (typeof record.timestamp === 'string') {
    context.timestamp = record.timestamp
  }
  if (typeof record.isSidechain === 'boolean') {
    context.isSidechain = record.isSidechain
  }
  if (isScalar(record.apiBlockIndex)) {
    context.apiBlockIndex = record.apiBlockIndex
  }
  if (turn !== undefined) {
    context.turn = turn
  }
  return context
}

function applyClaudeContext (node: ConversationNode, context: ClaudeRecordContext): ConversationNode {
  if (context.turn !== undefined) {
    node.turn = context.turn
  }
  if (context.sessionId !== undefined) {
    node.sessionId = context.sessionId
  }
  if (context.isSidechain !== undefined) {
    node.isSidechain = context.isSidechain
  }
  if (context.timestamp !== undefined) {
    node.timestamp = context.timestamp
  }
  if (context.apiBlockIndex !== undefined) {
    setAttribute(node, 'apiBlockIndex', context.apiBlockIndex)
  }
  return node
}

function claudeImageNode (block: JsonObject, context: ClaudeRecordContext): ConversationNode {
  const source = block.source
  const mediaType = isJsonObject(source) && typeof source.media_type === 'string' ? source.media_type : ''
  return applyClaudeContext(createNode('metadata', 'metadata', 'Image (not loaded)', mediaType, [context.line]), context)
}

function claudeUnknownBlockNode (block: unknown, context: ClaudeRecordContext): ConversationNode {
  const type = isJsonObject(block) && typeof block.type === 'string' ? block.type : typeof block
  const node = createNode('unknown', 'unknown', `Unknown block: ${type}`, '', [context.line], true)
  node.raw = JSON.stringify(block) ?? String(block)
  return applyClaudeContext(node, context)
}

class ClaudeSessionParser {
  private readonly nodes: ConversationNode[] = []
  private readonly warnings: ConversationParseWarning[] = []
  private readonly toolsById = new Map<string, ConversationNode>()
  private logGroup: ConversationNode | null = null
  private recordCount = 0
  private turn = 0

  parse (records: RecordLine[]): ConversationHistory {
    for (const record of records) {
      if (!record.parsed) {
        this.logGroup = null
        this.nodes.push(parseErrorNode(record))
        this.warnings.push(parseErrorWarning(record))
        continue
      }
      this.recordCount++
      const value = record.value as JsonObject
      if (isClaudeMessageRecord(value)) {
        this.logGroup = null
        this.parseMessage(value, record)
      } else {
        this.parseLogRecord(value, record)
      }
    }
    return {
      format: 'claude',
      recordCount: this.recordCount,
      nodes: this.nodes,
      metadata: [],
      warnings: this.warnings
    }
  }

  private parseLogRecord (value: JsonObject, record: RecordLine): void {
    const type = String(value.type)
    const child = createNode('metadata', 'metadata', type, JSON.stringify(value, null, 2), [record.line], true)
    child.raw = record.text
    applyClaudeContext(child, claudeRecordContext(value, record.line))
    if (this.logGroup === null) {
      this.logGroup = createNode('metadata', 'metadata', '', '', [], true)
      this.nodes.push(this.logGroup)
    }
    this.logGroup.children.push(child)
    addSourceLines(this.logGroup, [record.line])
    const count = this.logGroup.children.length
    this.logGroup.label = count === 1 ? `Log record: ${type}` : `${count} log records`
  }

  private parseMessage (value: JsonObject, record: RecordLine): void {
    const message = value.message as JsonObject
    const content = message.content
    const isUser = value.type === 'user'
    if (isUser && value.isSidechain !== true) {
      const hasText = typeof content === 'string' ||
        (Array.isArray(content) && content.some(block => isJsonObject(block) && block.type === 'text'))
      if (hasText) {
        this.turn++
      }
    }
    const context = claudeRecordContext(value, record.line, this.turn)

    if (typeof content === 'string') {
      this.nodes.push(isUser ? this.userNode(content, context) : this.assistantNode(content, context))
      return
    }
    if (!Array.isArray(content)) {
      return
    }
    for (const block of content) {
      if (!isJsonObject(block)) {
        this.nodes.push(claudeUnknownBlockNode(block, context))
      } else if (isUser) {
        this.parseUserBlock(block, context)
      } else {
        this.parseAssistantBlock(block, context)
      }
    }
  }

  private userNode (text: string, context: ClaudeRecordContext): ConversationNode {
    const node = createNode('user', 'original', 'User', text, [context.line])
    node.role = 'user'
    return applyClaudeContext(node, context)
  }

  private assistantNode (text: string, context: ClaudeRecordContext): ConversationNode {
    const node = createNode('assistant', 'original', 'Assistant', text, [context.line])
    node.role = 'assistant'
    return applyClaudeContext(node, context)
  }

  private parseUserBlock (block: JsonObject, context: ClaudeRecordContext): void {
    switch (block.type) {
      case 'text':
        this.nodes.push(this.userNode(String(block.text), context))
        break
      case 'tool_result':
        this.attachToolResult(block, context)
        break
      case 'image':
        this.nodes.push(claudeImageNode(block, context))
        break
      default:
        this.nodes.push(claudeUnknownBlockNode(block, context))
    }
  }

  private parseAssistantBlock (block: JsonObject, context: ClaudeRecordContext): void {
    switch (block.type) {
      case 'text':
        this.nodes.push(this.assistantNode(String(block.text), context))
        break
      case 'thinking':
      case 'redacted_thinking': {
        const thinking = block.type === 'thinking' && typeof block.thinking === 'string' ? block.thinking : ''
        const node = thinking === ''
          ? createNode('thinking', 'omitted', 'Thinking (not recorded)', '', [context.line], true)
          : createNode('thinking', 'original', 'Thinking', thinking, [context.line], true)
        this.nodes.push(applyClaudeContext(node, context))
        break
      }
      case 'tool_use': {
        const name = String(block.name)
        const node = createNode('tool', 'original', name, '', [context.line], true)
        node.toolName = name
        node.toolUseId = String(block.id)
        const input = JSON.stringify(block.input, null, 2)
        if (input !== undefined) {
          node.toolInput = input
        }
        node.toolStatus = 'unknown'
        node.outputState = 'unknown'
        applyClaudeContext(node, context)
        this.toolsById.set(node.toolUseId, node)
        this.nodes.push(node)
        break
      }
      default:
        this.nodes.push(claudeUnknownBlockNode(block, context))
    }
  }

  private attachToolResult (block: JsonObject, context: ClaudeRecordContext): void {
    const toolUseId = String(block.tool_use_id)
    const isError = block.is_error === true
    const texts: string[] = []
    const extraChildren: ConversationNode[] = []
    const content = block.content
    if (typeof content === 'string') {
      texts.push(content)
    } else if (Array.isArray(content)) {
      for (const item of content) {
        if (isJsonObject(item) && item.type === 'text' && typeof item.text === 'string') {
          texts.push(item.text)
        } else if (isJsonObject(item) && item.type === 'image') {
          extraChildren.push(claudeImageNode(item, context))
        } else {
          extraChildren.push(claudeUnknownBlockNode(item, context))
        }
      }
    }
    const text = texts.join('\n')
    const outputState: ConversationOutputState = text.trim() === '' ? 'empty' : 'present'
    const child = createNode(isError ? 'error' : 'output', 'original', isError ? 'Error' : 'Output', text, [context.line])
    child.outputState = outputState
    applyClaudeContext(child, context)

    let parent = this.toolsById.get(toolUseId)
    if (parent === undefined) {
      parent = createNode('tool', 'original', 'Tool result', '', [context.line], true)
      parent.toolUseId = toolUseId
      applyClaudeContext(parent, context)
      this.toolsById.set(toolUseId, parent)
      this.nodes.push(parent)
    } else {
      addSourceLines(parent, [context.line])
    }
    parent.children.push(child, ...extraChildren)
    parent.toolStatus = isError ? 'error' : 'success'
    parent.outputState = outputState
  }
}

// ---------------------------------------------------------------------------
// Compact-LYH transcripts
// ---------------------------------------------------------------------------

function isValidCompactHistoryRecord (value: unknown): value is JsonObject {
  return isJsonObject(value) &&
    value['记录'] === '对话历史' &&
    typeof value['内容'] === 'string' &&
    typeof value['角色'] === 'string' &&
    (typeof value['轮次'] === 'number' || typeof value['轮次'] === 'string')
}

function isCompactTranscript (lines: RawLine[]): boolean {
  if (lines.length === 0 || lines[0].text.trim() !== COMPACT_SIGNATURE) {
    return false
  }
  return parseRecordLines(lines.slice(1)).some(record => record.parsed && isValidCompactHistoryRecord(record.value))
}

/** The start offset of each record's text inside a block's concatenated text. */
interface CompactPiece {
  line: number
  start: number
}

interface CompactTurn {
  value: number | string
  compressed?: boolean
  chain: CompactBlock[]
  previousBlockWasCall: boolean
  currentBlock: CompactBlock | null
  lastUserNode: ConversationNode | null
}

interface CompactBlock {
  name: string
  node: ConversationNode
  fullText: string
  pieces: CompactPiece[]
  turn: CompactTurn
  pairedOutput?: CompactBlock
  isPaired: boolean
  outputOmitted: boolean
  wrapper?: ConversationNode
}

interface CompactHeader {
  attributes: Record<string, string | number | boolean>
  repeat?: number
  selfClosing: boolean
  bodyStart: number
  body: string
}

const HEADER_TOKEN = /([^\s=]+)=("[^"]*"|'[^']*'|\S*)|(\S+)/g

function headerValue (raw: string): string | number {
  let value = raw
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    value = value.slice(1, -1)
  }
  return /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value
}

function parseCompactHeader (block: CompactBlock): CompactHeader {
  const fullText = block.fullText
  const closeIndex = fullText.indexOf('>')
  const selfClosing = closeIndex > 0 && fullText[closeIndex - 1] === '/'
  const innerEnd = closeIndex === -1 ? fullText.length : (selfClosing ? closeIndex - 1 : closeIndex)
  const inner = fullText.slice(1 + block.name.length, innerEnd)
  const header: CompactHeader = { attributes: {}, selfClosing, bodyStart: fullText.length, body: '' }
  if (closeIndex === -1) {
    header.attributes.unterminated = true
  } else {
    let bodyStart = closeIndex + 1
    if (fullText[bodyStart] === '\n') {
      bodyStart++
    }
    header.bodyStart = bodyStart
    header.body = fullText.slice(bodyStart)
  }
  HEADER_TOKEN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = HEADER_TOKEN.exec(inner)) !== null) {
    if (match[1] !== undefined) {
      header.attributes[match[1]] = headerValue(match[2] ?? '')
      continue
    }
    const token = match[3]
    const repeatMatch = /^x(\d+)$/.exec(token)
    if (repeatMatch !== null) {
      header.repeat = Number(repeatMatch[1])
    } else if (/^\d+$/.test(token)) {
      header.attributes.count = Number(token)
    } else {
      header.attributes[token] = true
    }
  }
  return header
}

/** The source lines whose text overlaps [start, end) of the block's text. */
function blockLinesFor (block: CompactBlock, start: number, end: number): number[] {
  const lines: number[] = []
  const pieces = block.pieces
  for (let index = 0; index < pieces.length; index++) {
    const pieceStart = pieces[index].start
    const pieceEnd = index + 1 < pieces.length ? pieces[index + 1].start : block.fullText.length
    const isLast = index === pieces.length - 1
    if (end > start) {
      if (pieceStart < end && pieceEnd > start) {
        lines.push(pieces[index].line)
      }
    } else if (start >= pieceStart && (start < pieceEnd || isLast)) {
      lines.push(pieces[index].line)
      break
    }
  }
  if (lines.length === 0) {
    return pieces.map(piece => piece.line)
  }
  return lines
}

function blockLines (block: CompactBlock): number[] {
  return block.pieces.map(piece => piece.line)
}

function omissionNode (label: string, lines: number[]): ConversationNode {
  return createNode('omission', 'omitted', label, '', lines)
}

/**
 * Fills a block node with its body text, splitting it at literal <gap>
 * markers when requested and turning a trailing <clip/> into a child.
 */
function fillBlockBody (block: CompactBlock, header: CompactHeader, splitGaps: boolean): void {
  const node = block.node
  const body = header.body
  const trimmed = body.trimEnd()
  let effective = body
  let clipOffset = -1
  if (trimmed.endsWith('<clip/>')) {
    effective = trimmed.slice(0, -'<clip/>'.length)
    clipOffset = header.bodyStart + effective.length
  }
  if (splitGaps) {
    node.text = ''
    let cursor = 0
    const pushSegment = (segmentStart: number, segmentEnd: number): void => {
      const segment = effective.slice(segmentStart, segmentEnd)
      if (segment.trim() === '') {
        return
      }
      const child = createNode(node.kind, 'partial', 'Kept text', segment,
        blockLinesFor(block, header.bodyStart + segmentStart, header.bodyStart + segmentEnd))
      if (node.role !== undefined) {
        child.role = node.role
      }
      node.children.push(child)
    }
    let gapIndex = effective.indexOf('<gap>')
    while (gapIndex !== -1) {
      pushSegment(cursor, gapIndex)
      node.children.push(omissionNode('Gap',
        blockLinesFor(block, header.bodyStart + gapIndex, header.bodyStart + gapIndex + '<gap>'.length)))
      cursor = gapIndex + '<gap>'.length
      gapIndex = effective.indexOf('<gap>', cursor)
    }
    pushSegment(cursor, effective.length)
  } else {
    node.text = effective
  }
  if (clipOffset !== -1) {
    node.children.push(omissionNode('Clipped here', blockLinesFor(block, clipOffset, clipOffset + '<clip/>'.length)))
  }
}

function setOutputState (node: ConversationNode, state: ConversationOutputState): void {
  node.outputState = state
  node.provenance = state === 'partial' ? 'partial' : state === 'omitted' ? 'omitted' : 'original'
}

function finalizeCallBlock (block: CompactBlock): void {
  const node = block.node
  const fullText = block.fullText
  node.kind = 'tool'
  node.provenance = 'original'
  node.text = ''
  node.initiallyCollapsed = true
  let rest = fullText.slice('<call'.length)
  const repeatMatch = /^\s+x(\d+)(?=[\s/>:]|$)/.exec(rest)
  if (repeatMatch !== null) {
    node.repeat = Number(repeatMatch[1])
    rest = rest.slice(repeatMatch[0].length)
  }
  const separator = rest.indexOf(': ')
  let toolName: string | undefined
  let summary: string
  if (separator === -1) {
    summary = rest
  } else {
    toolName = rest.slice(0, separator).trim()
    summary = rest.slice(separator + 2)
  }
  summary = summary.trimEnd()
  if (summary.endsWith('/>')) {
    summary = summary.slice(0, -2).trimEnd()
  }
  if (separator === -1) {
    summary = summary.trim()
  }
  if (toolName !== undefined && toolName !== '') {
    node.toolName = toolName
    node.label = toolName
  } else {
    node.label = 'Tool call'
  }
  if (summary !== '') {
    node.toolInput = summary
  }
  if (!fullText.trimEnd().endsWith('/>')) {
    setAttribute(node, 'unterminated', true)
  }
}

function finalizeCompactBlock (block: CompactBlock): void {
  if (block.name === 'call') {
    finalizeCallBlock(block)
    return
  }
  const node = block.node
  const header = parseCompactHeader(block)
  const attributes = header.attributes
  if (Object.keys(attributes).length > 0) {
    node.attributes = { ...(node.attributes ?? {}), ...attributes }
  }
  if (header.repeat !== undefined) {
    node.repeat = header.repeat
  }
  node.provenance = 'original'
  node.initiallyCollapsed = false
  node.text = ''

  switch (block.name) {
    case 'say':
      if (attributes.drop !== undefined) {
        node.kind = 'omission'
        node.provenance = 'omitted'
        node.label = `Message omitted (${String(attributes.drop)} characters)`
      } else {
        node.kind = 'assistant'
        node.role = 'assistant'
        const partial = attributes.orig !== undefined || attributes.keep !== undefined
        node.provenance = partial ? 'partial' : 'original'
        node.label = partial ? 'Assistant (partially kept)' : 'Assistant'
        fillBlockBody(block, header, partial)
      }
      break
    case 'think':
      if (attributes.dropped !== undefined) {
        node.kind = 'omission'
        node.provenance = 'omitted'
        node.label = `${String(attributes.dropped)} thinking blocks omitted`
      } else {
        node.kind = 'thinking'
        node.label = 'Thinking'
        node.initiallyCollapsed = true
        node.text = header.body
      }
      break
    case 'user-reply':
      node.kind = 'user'
      node.role = 'user'
      node.label = 'Answer'
      node.text = header.body
      break
    case 'out':
      node.kind = 'output'
      node.label = 'Output'
      if (header.selfClosing && attributes.empty === true) {
        setOutputState(node, 'empty')
      } else if (header.selfClosing) {
        setOutputState(node, 'omitted')
        node.label = 'Output omitted'
      } else if (attributes.cut === true) {
        setOutputState(node, 'partial')
        fillBlockBody(block, header, true)
      } else {
        setOutputState(node, 'present')
        fillBlockBody(block, header, false)
      }
      break
    case 'err':
      node.kind = 'error'
      node.label = 'Error'
      if (header.selfClosing) {
        setOutputState(node, 'omitted')
        node.label = 'Error output omitted'
      } else {
        setOutputState(node, 'present')
        fillBlockBody(block, header, false)
      }
      break
    case 'findings':
      node.kind = 'summary'
      node.provenance = 'summary'
      node.label = 'Extracted findings'
      node.text = header.body
      break
    case 'clip':
      node.kind = 'omission'
      node.provenance = 'omitted'
      node.label = 'Clipped'
      break
    case 'dropped-blocks':
      node.kind = 'omission'
      node.provenance = 'omitted'
      node.label = attributes.count !== undefined ? `${String(attributes.count)} blocks omitted` : 'Blocks omitted'
      break
  }
}

function applyCompactTurn (node: ConversationNode, turn: CompactTurn): void {
  node.turn = turn.value
  if (turn.compressed !== undefined) {
    setAttribute(node, 'compressed', turn.compressed)
  }
  for (const child of node.children) {
    applyCompactTurn(child, turn)
  }
}

class CompactTranscriptParser {
  private readonly nodes: ConversationNode[] = []
  private readonly metadata: ConversationNode[] = []
  private readonly warnings: ConversationParseWarning[] = []
  private readonly blocks: CompactBlock[] = []
  private readonly topLevelTurnNodes: Array<{ node: ConversationNode, turn: CompactTurn }> = []
  private recordCount = 0
  private turn: CompactTurn | null = null
  private lastPromptNode: ConversationNode | null = null

  parse (lines: RawLine[]): ConversationHistory {
    for (const record of parseRecordLines(lines.slice(1))) {
      this.parseRecord(record)
    }
    this.endTurn()
    this.finalize()
    return {
      format: 'compact-lyh',
      recordCount: this.recordCount,
      nodes: this.nodes,
      metadata: this.metadata,
      warnings: this.warnings
    }
  }

  private parseRecord (record: RecordLine): void {
    const value = record.value
    const kind = record.parsed && isJsonObject(value) && typeof value['记录'] === 'string' ? value['记录'] as string : undefined
    if (kind !== '用户prompt') {
      this.lastPromptNode = null
    }
    const isUserHistory = kind === '对话历史' && isValidCompactHistoryRecord(value) && value['角色'] === '用户' &&
      this.turn !== null && this.turn.value === value['轮次']
    if (!isUserHistory && this.turn !== null) {
      this.turn.lastUserNode = null
    }

    if (!record.parsed) {
      this.nodes.push(parseErrorNode(record))
      this.warnings.push(parseErrorWarning(record))
      return
    }
    this.recordCount++
    if (!isJsonObject(value) || kind === undefined) {
      this.nodes.push(this.unknownRecordNode(record, 'Unknown record'))
      return
    }
    switch (kind) {
      case '说明':
        this.metadata.push(this.aboutNode(value, record))
        break
      case '用户prompt':
        this.parseUserPrompt(value, record)
        break
      case '对话历史':
        if (isValidCompactHistoryRecord(value)) {
          this.parseHistory(value, record)
        } else {
          this.nodes.push(this.unknownRecordNode(record, 'Unknown record'))
        }
        break
      case '当前状态': {
        const content = value['内容']
        const text = typeof content === 'string' ? content : (content === undefined ? '' : JSON.stringify(content, null, 2))
        this.nodes.push(createNode('metadata', 'metadata', 'Current state', text, [record.line], false))
        break
      }
      case '_元数据': {
        const rest: JsonObject = { ...value }
        delete rest['记录']
        this.metadata.push(createNode('metadata', 'metadata', 'Metadata', JSON.stringify(rest, null, 2), [record.line], true))
        break
      }
      default:
        this.nodes.push(this.unknownRecordNode(record, 'Unknown record'))
    }
  }

  private unknownRecordNode (record: RecordLine, label: string): ConversationNode {
    const node = createNode('unknown', 'unknown', label, record.text, [record.line], true)
    node.raw = record.text
    return node
  }

  private aboutNode (value: JsonObject, record: RecordLine): ConversationNode {
    const content = value['内容']
    const text = typeof content === 'string' ? content : (content === undefined ? '' : JSON.stringify(content, null, 2))
    const node = createNode('metadata', 'metadata', 'About this transcript', text, [record.line], true)
    for (const [ key, field ] of Object.entries(value)) {
      if (key !== '记录' && key !== '内容' && isScalar(field)) {
        setAttribute(node, key, field)
      }
    }
    return node
  }

  private parseUserPrompt (value: JsonObject, record: RecordLine): void {
    const content = value['内容']
    const text = typeof content === 'string' ? content : (content === undefined ? '' : JSON.stringify(content))
    let node = this.lastPromptNode
    if (node === null) {
      node = createNode('user', 'original', 'User prompt', '', [], false)
      node.role = 'user'
      this.nodes.push(node)
      this.lastPromptNode = node
    }
    node.text += text
    addSourceLines(node, [record.line])
    for (const [ key, field ] of Object.entries(value)) {
      if (key !== '记录' && key !== '内容' && isScalar(field) && node.attributes?.[key] === undefined) {
        setAttribute(node, key, field)
      }
    }
  }

  private pushTurnNode (node: ConversationNode, turn: CompactTurn): void {
    this.nodes.push(node)
    this.topLevelTurnNodes.push({ node, turn })
  }

  private parseHistory (value: JsonObject, record: RecordLine): void {
    const turnValue = value['轮次'] as number | string
    if (this.turn === null || this.turn.value !== turnValue) {
      this.endTurn()
      this.turn = {
        value: turnValue,
        chain: [],
        previousBlockWasCall: false,
        currentBlock: null,
        lastUserNode: null
      }
      const compressed = value['已压缩']
      if (typeof compressed === 'boolean') {
        this.turn.compressed = compressed
      }
    }
    const turn = this.turn
    const role = value['角色'] as string
    const content = value['内容'] as string

    if (role === '用户') {
      turn.currentBlock = null
      turn.previousBlockWasCall = false
      if (turn.lastUserNode !== null) {
        turn.lastUserNode.text += content
        addSourceLines(turn.lastUserNode, [record.line])
        return
      }
      const node = createNode('user', 'original', 'User', content, [record.line])
      node.role = 'user'
      turn.lastUserNode = node
      this.pushTurnNode(node, turn)
      return
    }
    if (role !== '助手') {
      turn.currentBlock = null
      turn.previousBlockWasCall = false
      this.pushTurnNode(this.unknownRecordNode(record, `Unknown role: ${role}`), turn)
      return
    }

    const match = COMPACT_BLOCK_START.exec(content)
    if (match === null) {
      const current = turn.currentBlock
      if (current === null) {
        this.pushTurnNode(this.unknownRecordNode(record, 'Untagged content'), turn)
        return
      }
      current.pieces.push({ line: record.line, start: current.fullText.length })
      current.fullText += content
      addSourceLines(current.node, [record.line])
      return
    }
    this.startBlock(match[1], content, record.line, turn)
  }

  private startBlock (name: string, content: string, line: number, turn: CompactTurn): void {
    const node = createNode('unknown', 'original', '', '', [line])
    const block: CompactBlock = {
      name,
      node,
      fullText: content,
      pieces: [{ line, start: 0 }],
      turn,
      isPaired: false,
      outputOmitted: false
    }
    this.blocks.push(block)
    turn.currentBlock = block

    if (name === 'call') {
      if (!turn.previousBlockWasCall) {
        this.closeChain(turn)
      }
      turn.chain.push(block)
      turn.previousBlockWasCall = true
      this.pushTurnNode(node, turn)
      return
    }
    turn.previousBlockWasCall = false
    if (name === 'out' || name === 'err') {
      const target = turn.chain.find(call => !call.isPaired && !call.outputOmitted)
      if (target !== undefined) {
        target.isPaired = true
        target.pairedOutput = block
        target.node.children.push(node)
        return
      }
      const wrapper = createNode('tool', 'original', 'Output', '', [], true)
      wrapper.children.push(node)
      block.wrapper = wrapper
      this.pushTurnNode(wrapper, turn)
      return
    }
    this.pushTurnNode(node, turn)
  }

  /** Marks every call of the current chain that got no output as omitted. */
  private closeChain (turn: CompactTurn): void {
    for (const call of turn.chain) {
      if (!call.isPaired) {
        call.outputOmitted = true
      }
    }
    turn.chain = []
  }

  private endTurn (): void {
    if (this.turn !== null) {
      this.closeChain(this.turn)
      this.turn.currentBlock = null
    }
  }

  private finalize (): void {
    for (const block of this.blocks) {
      finalizeCompactBlock(block)
    }
    for (const block of this.blocks) {
      const node = block.node
      if (block.name === 'call') {
        if (block.pairedOutput !== undefined) {
          const output = block.pairedOutput.node
          node.toolStatus = output.kind === 'error' ? 'error' : 'success'
          if (output.outputState !== undefined) {
            node.outputState = output.outputState
          }
          addSourceRanges(node, output.sourceRanges)
        } else if (block.outputOmitted) {
          node.toolStatus = 'success'
          node.outputState = 'omitted'
          node.children.push(omissionNode('Output omitted', blockLines(block)))
        } else {
          node.toolStatus = 'unknown'
          node.outputState = 'unknown'
        }
      }
      if (block.wrapper !== undefined) {
        block.wrapper.toolStatus = node.kind === 'error' ? 'error' : 'unknown'
        if (node.outputState !== undefined) {
          block.wrapper.outputState = node.outputState
        }
        addSourceRanges(block.wrapper, node.sourceRanges)
      }
    }
    for (const { node, turn } of this.topLevelTurnNodes) {
      applyCompactTurn(node, turn)
    }
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Returns the conversation format the content is recognised as, or null.
 * Always equal to `parseConversationHistory(content)?.format ?? null`.
 */
export function detectConversationFormat (content: string): ConversationFormat | null {
  return parseConversationHistory(content)?.format ?? null
}

/**
 * Parses a raw Claude session or a Compact-LYH transcript. Returns null when
 * the content is neither; never throws.
 */
export function parseConversationHistory (content: string): ConversationHistory | null {
  try {
    if (typeof content !== 'string') {
      return null
    }
    const lines = splitContentLines(content)
    if (isCompactTranscript(lines)) {
      return finalizeHistory(new CompactTranscriptParser().parse(lines))
    }
    const records = parseRecordLines(lines)
    if (isClaudeSession(records)) {
      return finalizeHistory(new ClaudeSessionParser().parse(records))
    }
    return null
  } catch {
    return null
  }
}

/**
 * Returns the identifiers of all nodes whose source ranges intersect the
 * inclusive line interval, together with all their ancestors, in preorder.
 */
export function conversationNodeIdsForLines (history: ConversationHistory, firstLine: number, lastLine: number): string[] {
  const low = Math.min(firstLine, lastLine)
  const high = Math.max(firstLine, lastLine)
  const selected = new Set<ConversationNode>()
  forEachNodePreorder(history, (node, ancestors) => {
    const hit = node.sourceRanges.some(range => range.firstLine <= high && range.lastLine >= low)
    if (hit) {
      for (const ancestor of ancestors) {
        selected.add(ancestor)
      }
      selected.add(node)
    }
  })
  const result: string[] = []
  const seen = new Set<string>()
  forEachNodePreorder(history, (node) => {
    if (selected.has(node) && !seen.has(node.id)) {
      seen.add(node.id)
      result.push(node.id)
    }
  })
  return result
}

/**
 * One table of contents item per top-level user node.
 */
export function conversationTableOfContents (history: ConversationHistory): ConversationTocItem[] {
  const items: ConversationTocItem[] = []
  for (const node of history.nodes) {
    if (node.kind !== 'user') {
      continue
    }
    const firstText = node.text.split('\n').map(line => line.trim()).find(line => line !== '')
    let text = 'User message'
    if (firstText !== undefined) {
      const characters = Array.from(firstText)
      text = characters.length > TOC_TEXT_LIMIT ? characters.slice(0, TOC_TEXT_LIMIT).join('') + '…' : firstText
    }
    items.push({ nodeId: node.id, line: node.sourceRanges[0]?.firstLine ?? 0, text })
  }
  return items
}

/**
 * The text the find bar searches for a single node (children excluded).
 */
export function conversationSearchableText (node: ConversationNode): string {
  return [ node.label, node.toolName, node.toolInput, node.text ]
    .filter((part): part is string => part !== undefined && part !== '')
    .join('\n')
}
