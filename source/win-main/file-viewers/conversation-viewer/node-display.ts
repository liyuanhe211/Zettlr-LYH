/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Display helpers of the conversation viewer
 * CVM-Role:        Utility function
 * License:         GNU GPL v3
 *
 * Description:     Pure helpers that decide how a ConversationNode is shown in
 *                  the read-only conversation viewer (Zettlr-LYH R79, contract
 *                  C8 section 7): which kinds are rendered as Markdown, which
 *                  are collapsible, the status badges of tools and outputs,
 *                  source line captions and the tool group summary. All
 *                  captions are English.
 *
 * END HEADER
 */

import type { ConversationNode, ConversationNodeKind } from '@dts/common/conversation-history'

/**
 * Kinds whose text is Markdown rendered through md2html; every other kind is
 * shown as plain text (contract C8 section 7).
 */
const MARKDOWN_KINDS = new Set<ConversationNodeKind>([ 'user', 'assistant', 'summary' ])

/**
 * Kinds that are shown open, without an expand control, unless the node is
 * initially collapsed.
 */
const OPEN_KINDS = new Set<ConversationNodeKind>([ 'user', 'assistant', 'summary', 'omission' ])

/**
 * Kinds whose children are parts of their own text (kept segments, gaps,
 * clip markers, images of a tool result) rather than separate blocks.
 */
const SEGMENT_PARENT_KINDS = new Set<ConversationNodeKind>([ 'user', 'assistant', 'summary', 'output', 'error', 'thinking' ])

/**
 * Attributes that are present on most nodes of a file and only shown in the
 * tooltip, not as a visible caption.
 */
const TOOLTIP_ONLY_ATTRIBUTES = new Set<string>([ 'compressed', 'apiBlockIndex' ])

export interface NodeBadge {
  text: string
  className: string
}

export interface InputPart {
  text: string
  omitted: boolean
}

export function isMarkdownKind (kind: ConversationNodeKind): boolean {
  return MARKDOWN_KINDS.has(kind)
}

export function childrenAreSegments (node: ConversationNode): boolean {
  return SEGMENT_PARENT_KINDS.has(node.kind)
}

/**
 * The attributes shown visibly, as "name: value" pairs.
 */
export function visibleAttributes (node: ConversationNode): Array<[string, string]> {
  if (node.attributes === undefined) {
    return []
  }

  return Object.entries(node.attributes)
    .filter(([name]) => !TOOLTIP_ONLY_ATTRIBUTES.has(name))
    .map(([ name, value ]) => [ name, String(value) ])
}

/**
 * Whether a node has anything to show below its header line.
 */
export function hasExpandableContent (node: ConversationNode): boolean {
  return node.text !== '' ||
    (node.raw !== undefined && node.raw !== '') ||
    (node.toolInput !== undefined && node.toolInput !== '') ||
    node.children.length > 0 ||
    visibleAttributes(node).length > 0
}

/**
 * Whether a node is shown with an expand control. Open kinds only get one
 * when the source marks them as initially collapsed; nodes without content
 * below their header never get one.
 */
export function isCollapsible (node: ConversationNode): boolean {
  if (OPEN_KINDS.has(node.kind) && !node.initiallyCollapsed) {
    return false
  }

  return hasExpandableContent(node)
}

/**
 * Whether the raw source line is worth showing besides the text.
 */
export function showsRaw (node: ConversationNode): boolean {
  if (node.raw === undefined || node.raw === '') {
    return false
  }

  return node.kind === 'unknown' || node.kind === 'parse-error' || node.text === ''
}

/**
 * The first source line of a node, if it has any source range.
 */
export function firstSourceLine (node: ConversationNode): number|undefined {
  return node.sourceRanges.length > 0 ? node.sourceRanges[0].firstLine : undefined
}

/**
 * Whether any source range of a node intersects the inclusive line range.
 */
export function intersectsLines (node: ConversationNode, firstLine: number, lastLine: number): boolean {
  return node.sourceRanges.some(range => range.firstLine <= lastLine && range.lastLine >= firstLine)
}

/**
 * "Line 3", "Lines 3–5" or "Lines 3–5, 9", or an empty string.
 */
export function sourceLinesLabel (node: ConversationNode): string {
  if (node.sourceRanges.length === 0) {
    return ''
  }

  const parts = node.sourceRanges.map(range => {
    return range.firstLine === range.lastLine ? String(range.firstLine) : `${range.firstLine}–${range.lastLine}`
  })

  const single = node.sourceRanges.length === 1 && node.sourceRanges[0].firstLine === node.sourceRanges[0].lastLine
  return `${single ? 'Line' : 'Lines'} ${parts.join(', ')}`
}

/**
 * Tooltip with the source lines, turn, time and every attribute of a node.
 */
export function nodeTooltip (node: ConversationNode): string {
  const lines: string[] = []
  const linesLabel = sourceLinesLabel(node)
  if (linesLabel !== '') {
    lines.push(linesLabel)
  }

  if (node.turn !== undefined) {
    lines.push(`Turn: ${node.turn}`)
  }

  if (node.timestamp !== undefined) {
    lines.push(`Time: ${node.timestamp}`)
  }

  if (node.toolUseId !== undefined) {
    lines.push(`Tool use ID: ${node.toolUseId}`)
  }

  if (node.attributes !== undefined) {
    for (const [ name, value ] of Object.entries(node.attributes)) {
      lines.push(`${name}: ${String(value)}`)
    }
  }

  return lines.join('\n')
}

/**
 * The status badges in the header of a tool node. Execution status and
 * output state are shown separately: only an explicit error is a failure,
 * and an omitted output is never shown as a failure.
 */
export function toolBadges (node: ConversationNode): NodeBadge[] {
  const badges: NodeBadge[] = []
  if (node.toolStatus === 'error') {
    badges.push({ text: 'Failed', className: 'conversation-badge-failed' })
  }

  switch (node.outputState) {
    case 'omitted':
      badges.push({
        text: node.toolStatus === 'error' ? 'Error output omitted' : 'Output omitted',
        className: 'conversation-badge-omitted'
      })
      break
    case 'partial':
      badges.push({ text: 'Partial output', className: 'conversation-badge-partial' })
      break
    case 'empty':
      badges.push({ text: 'Empty output', className: 'conversation-badge-empty' })
      break
    case 'unknown':
      if (node.toolStatus !== 'error' && node.toolStatus !== 'success') {
        badges.push({ text: 'No result recorded', className: 'conversation-badge-unknown' })
      }
      break
    default:
      break
  }

  return badges
}

/**
 * The state badges in the header of an output or error node; the label
 * already says "Output omitted" or "Error output omitted" for omitted ones.
 */
export function outputBadges (node: ConversationNode): NodeBadge[] {
  switch (node.outputState) {
    case 'partial':
      return [{ text: 'Partial', className: 'conversation-badge-partial' }]
    case 'empty':
      return [{ text: 'Empty', className: 'conversation-badge-empty' }]
    default:
      return []
  }
}

/**
 * The first non-empty line of a text, shortened for a header preview.
 */
export function previewText (text: string|undefined, maximumLength = 160): string {
  if (text === undefined) {
    return ''
  }

  const firstLine = text.split('\n').map(line => line.trim()).find(line => line !== '') ?? ''
  return firstLine.length > maximumLength ? firstLine.slice(0, maximumLength) + '…' : firstLine
}

/**
 * Splits a Compact-LYH call summary at its literal `<omit>` markers, so that
 * they can be shown as omission marks. The text is not changed otherwise.
 */
export function splitOmitMarkers (text: string): InputPart[] {
  const parts: InputPart[] = []
  const pieces = text.split('<omit>')
  pieces.forEach((piece, index) => {
    if (index > 0) {
      parts.push({ text: '<omit>', omitted: true })
    }
    if (piece !== '') {
      parts.push({ text: piece, omitted: false })
    }
  })
  return parts
}

/**
 * The name under which a tool node is listed in its group summary.
 */
export function toolDisplayName (node: ConversationNode): string {
  return node.toolName ?? node.label
}

/**
 * The summary line of a tool group, e.g. "3 tool calls: Bash (2), Read".
 */
export function toolGroupSummary (nodes: ConversationNode[]): string {
  const counts = new Map<string, number>()
  for (const node of nodes) {
    const name = toolDisplayName(node)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }

  const maximumNames = 6
  const names = Array.from(counts.entries()).map(([ name, count ]) => count > 1 ? `${name} (${count})` : name)
  const shown = names.slice(0, maximumNames).join(', ') + (names.length > maximumNames ? ', …' : '')
  const countText = nodes.length === 1 ? '1 tool call' : `${nodes.length} tool calls`
  return `${countText}: ${shown}`
}

/**
 * The number of failed tools in a group.
 */
export function failedToolCount (nodes: ConversationNode[]): number {
  return nodes.filter(node => node.toolStatus === 'error').length
}
