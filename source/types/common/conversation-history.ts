/**
 * Types for the read-only conversation history viewer (Claude session JSONL
 * and Compact-LYH transcripts). These declarations are copied verbatim from
 * contract C8, section 2; change the contract first, then this file.
 */

export type ConversationFormat = 'claude' | 'compact-lyh'

export type ConversationNodeKind =
  | 'user' | 'assistant' | 'thinking' | 'tool'
  | 'output' | 'error' | 'summary' | 'omission'
  | 'metadata' | 'unknown' | 'parse-error'

export type ConversationProvenance =
  | 'original' | 'partial' | 'summary' | 'omitted'
  | 'metadata' | 'unknown'

export type ConversationToolStatus = 'success' | 'error' | 'unknown'

export type ConversationOutputState = 'present' | 'partial' | 'empty' | 'omitted' | 'unknown'

export interface ConversationSourceRange {
  // One-based line numbers of the raw file content, inclusive. The
  // Compact-LYH signature line is line 1.
  firstLine: number
  lastLine: number
}

export interface ConversationNode {
  // Deterministic for identical content, see section 3.
  id: string
  kind: ConversationNodeKind
  provenance: ConversationProvenance
  // Short English caption for the interface, e.g. "Bash", "Thinking".
  label: string
  // Only the text the source actually contains for this node.
  text: string
  // Sorted ascending, non-overlapping; adjacent ranges are merged.
  sourceRanges: ConversationSourceRange[]
  children: ConversationNode[]
  initiallyCollapsed: boolean
  role?: 'user' | 'assistant'
  turn?: number | string
  sessionId?: string
  isSidechain?: boolean
  timestamp?: string
  toolUseId?: string
  toolName?: string
  toolInput?: string
  toolStatus?: ConversationToolStatus
  outputState?: ConversationOutputState
  // The xN repeat count of Compact-LYH tags.
  repeat?: number
  // Source attributes kept verbatim (orig, keep, drop, dropped, from,
  // compressed, apiBlockIndex, unknown tag attributes, ...).
  attributes?: Record<string, string | number | boolean>
  // The raw source line(s) for unknown and malformed data.
  raw?: string
}

export interface ConversationParseWarning {
  line: number
  message: string
  raw: string
}

export interface ConversationHistory {
  format: ConversationFormat
  // Number of non-empty lines that parsed as JSON (signature line excluded).
  recordCount: number
  // The conversation in source order.
  nodes: ConversationNode[]
  // File-level information shown in a collapsed area above the conversation.
  metadata: ConversationNode[]
  warnings: ConversationParseWarning[]
}

export interface ConversationTocItem {
  nodeId: string
  line: number
  text: string
}

export type ConversationHighlightMode = 'select' | 'jev'

// Methods exposed by ConversationViewer.vue through defineExpose.
export interface ConversationViewerHandle {
  revealSourceLines: (firstLine: number, lastLine: number, mode: ConversationHighlightMode, scroll: boolean) => boolean
  clearHighlight: (mode: ConversationHighlightMode) => void
  toggleFind: () => void
  topVisibleSourceLine: () => number | undefined
  scrollToSourceLine: (line: number) => void
  containsFocus: () => boolean
}
