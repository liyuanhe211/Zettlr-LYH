/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Logic layer of the Pandoc attribute editor (contract C2):
 *                  finds the editable objects around the cursor or selection
 *                  and builds the minimal changes that write attribute
 *                  updates back into the Markdown source.
 *
 * Description:     Objects are returned innermost first -- span, image,
 *                  column, table, block, page -- at most one per kind. Spans,
 *                  images and columns carry brace attributes; tables, blocks
 *                  and pages carry directive comments. Both functions are pure
 *                  (no EditorView) and work on any EditorState that uses the
 *                  Markdown parser of the editor.
 *
 * END HEADER
 */

import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { ChangeSpec, EditorState } from '@codemirror/state'
import type { SyntaxNode, Tree } from '@lezer/common'
import {
  PANDOC_ATTRIBUTE_SCHEMA,
  PANDOC_DIRECTIVE_PREFIX,
  type PandocAttributeTarget,
  type PandocAttributeTargetKind,
  type PandocAttributeUpdate
} from './pandoc-attribute-schema'
import { readAttributeValues, tokenizeAttributes, updateAttributeList, type AttributeKeyAliases } from './pandoc-brace-attributes'
import { buildDirectiveChanges, minimalChange, readDirectiveValues } from './pandoc-directive-comment'
import { splitPandocSlides } from '@common/util/pandoc-slide-splitter'

/**
 * Alternative key spellings the renderer accepts, per object kind
 */
const KEY_ALIASES: Partial<Record<PandocAttributeTargetKind, AttributeKeyAliases>> = {
  image: { w: ['width'], h: ['height'] }
}

/**
 * Labels of the top-level blocks a `style:` directive applies to
 */
const BLOCK_LABELS: Record<string, string> = {
  Paragraph: 'Paragraph',
  BulletList: 'List',
  OrderedList: 'List',
  ATXHeading1: 'Heading',
  ATXHeading2: 'Heading',
  ATXHeading3: 'Heading',
  ATXHeading4: 'Heading',
  ATXHeading5: 'Heading',
  ATXHeading6: 'Heading',
  SetextHeading1: 'Heading',
  SetextHeading2: 'Heading',
  Table: 'Table Style'
}

/**
 * Nodes that contain the blocks a directive can apply to
 */
const BLOCK_CONTAINERS = [ 'Document', 'PandocDiv' ]

/**
 * The inline containers within which a plain selection may be wrapped into a
 * span
 */
const WRAPPABLE_CONTAINERS = [
  'Paragraph', 'TableCell',
  'ATXHeading1', 'ATXHeading2', 'ATXHeading3', 'ATXHeading4', 'ATXHeading5', 'ATXHeading6',
  'SetextHeading1', 'SetextHeading2'
]

/**
 * Inline nodes inside which no span can be written (code, URLs, attributes,
 * comments, raw HTML, math)
 */
const UNWRAPPABLE_NODES = [
  'InlineCode', 'CodeText', 'CodeMark', 'URL', 'PandocAttribute', 'PandocAttributeMark',
  'Comment', 'CommentBlock', 'HTMLTag', 'Autolink', 'InlineMath', 'InlineMathMark',
  'LinkMark', 'LinkLabel', 'LinkTitle'
]

/**
 * Nodes that are not the first block of a page
 */
const PAGE_GLUE_NODES = [ 'CommentBlock', 'HorizontalRule' ]

/**
 * Returns the syntax tree, parsing the whole document if necessary
 */
function getTree (state: EditorState): Tree {
  return ensureSyntaxTree(state, state.doc.length, 1000) ?? syntaxTree(state)
}

/**
 * Walks up from the innermost node at a position and returns the first node
 * matching the predicate. The node after the position is tried first, then
 * the node before it (so that a cursor directly behind an object counts).
 */
function findAncestor (tree: Tree, position: number, predicate: (node: SyntaxNode) => boolean): SyntaxNode|null {
  for (const side of [ 1, -1 ] as const) {
    let node: SyntaxNode|null = tree.resolveInner(position, side)
    while (node !== null) {
      if (predicate(node)) {
        return node
      }
      node = node.parent
    }
  }
  return null
}

/**
 * Finds a node starting at `from` that matches the predicate
 */
function findNodeAt (tree: Tree, from: number, to: number, predicate: (node: SyntaxNode) => boolean): SyntaxNode|null {
  let found: SyntaxNode|null = null
  tree.iterate({
    from,
    to: Math.max(from, to),
    enter: (reference) => {
      if (found !== null) {
        return false
      }
      if (reference.from === from && predicate(reference.node)) {
        found = reference.node
        return false
      }
      return undefined
    }
  })
  return found
}

/**
 * The text between the braces of a PandocAttribute node
 */
function braceInner (state: EditorState, attribute: SyntaxNode): string {
  return state.sliceDoc(attribute.from + 1, attribute.to - 1)
}

/**
 * The direct PandocAttribute child of a span or div
 */
function attributeChild (node: SyntaxNode): SyntaxNode|null {
  let child = node.lastChild
  while (child !== null) {
    if (child.name === 'PandocAttribute') {
      return child
    }
    child = child.prevSibling
  }
  return null
}

// ---------------------------------------------------------------------------
// Locating the objects
// ---------------------------------------------------------------------------

function isBlockNode (node: SyntaxNode): boolean {
  return BLOCK_LABELS[node.name] !== undefined && node.parent !== null && BLOCK_CONTAINERS.includes(node.parent.name)
}

function isColumnDiv (state: EditorState, node: SyntaxNode): boolean {
  if (node.name !== 'PandocDiv') {
    return false
  }
  const info = node.getChild('PandocDivInfo')
  if (info !== null && state.sliceDoc(info.from, info.to) === 'column') {
    return true
  }
  const attribute = node.getChild('PandocAttribute')
  if (attribute === null) {
    return false
  }
  return tokenizeAttributes(braceInner(state, attribute), 'brace').some(token => token.kind === 'class' && token.key === 'column')
}

/**
 * Finds the image around a position together with its attribute node
 */
function findImage (tree: Tree, position: number): { image: SyntaxNode, attribute: SyntaxNode|null }|undefined {
  const image = findAncestor(tree, position, node => node.name === 'Image')
  if (image !== null) {
    const next = image.nextSibling
    return { image, attribute: next !== null && next.name === 'PandocAttribute' && next.from === image.to ? next : null }
  }
  const attribute = findAncestor(tree, position, node => node.name === 'PandocAttribute')
  const previous = attribute?.prevSibling ?? null
  if (attribute !== null && previous !== null && previous.name === 'Image' && previous.to === attribute.from) {
    return { image: previous, attribute }
  }
  return undefined
}

/**
 * Whether a plain selection can be wrapped into a new span: it lies within
 * one paragraph (or heading, or table cell), is not blank, does not start or
 * end inside code, a URL or an attribute, and does not cut through any inline
 * node (emphasis, link, span …) -- nodes must lie completely inside or
 * completely around the selection.
 */
function canWrapSelection (state: EditorState, tree: Tree, from: number, to: number): boolean {
  if (state.sliceDoc(from, to).trim() === '') {
    return false
  }
  const container = (node: SyntaxNode|null): SyntaxNode|null => {
    while (node !== null && !WRAPPABLE_CONTAINERS.includes(node.name)) {
      node = node.parent
    }
    return node
  }
  const startContainer = container(tree.resolveInner(from, 1))
  const endContainer = container(tree.resolveInner(to, -1))
  if (startContainer === null || endContainer === null || startContainer.from !== endContainer.from || startContainer.to !== endContainer.to) {
    return false
  }

  for (const [ position, side ] of [ [ from, 1 ], [ to, -1 ] ] as const) {
    let node: SyntaxNode|null = tree.resolveInner(position, side)
    while (node !== null && node.from >= startContainer.from && node.to <= startContainer.to && node !== startContainer) {
      if (UNWRAPPABLE_NODES.includes(node.name) && node.from < position && position < node.to) {
        return false
      }
      node = node.parent
    }
  }

  let cutsThrough = false
  tree.iterate({
    from: startContainer.from,
    to: startContainer.to,
    enter: (reference) => {
      if (reference.from === startContainer.from && reference.to === startContainer.to) {
        return undefined
      }
      const startsBefore = reference.from < from && from < reference.to && reference.to < to
      const endsAfter = from < reference.from && reference.from < to && to < reference.to
      if (startsBefore || endsAfter) {
        cutsThrough = true
        return false
      }
      return undefined
    }
  })
  return !cutsThrough
}

function findSpanTarget (state: EditorState, tree: Tree, from: number, to: number): PandocAttributeTarget|undefined {
  const span = findAncestor(tree, from, node => node.name === 'PandocSpan' && node.from <= from && node.to >= to)
  if (span !== null) {
    const attribute = attributeChild(span)
    const values = attribute !== null ? readAttributeValues(braceInner(state, attribute), 'brace', PANDOC_ATTRIBUTE_SCHEMA.span) : {}
    return { kind: 'span', label: 'Text Span', from: span.from, to: span.to, values }
  }
  if (from !== to && canWrapSelection(state, tree, from, to)) {
    return { kind: 'span', label: 'Selected Text', from, to, values: {}, wrapsSelection: true }
  }
  return undefined
}

function findImageTarget (state: EditorState, tree: Tree, from: number): PandocAttributeTarget|undefined {
  const found = findImage(tree, from)
  if (found === undefined) {
    return undefined
  }
  const { image, attribute } = found
  const values = attribute !== null
    ? readAttributeValues(braceInner(state, attribute), 'brace', PANDOC_ATTRIBUTE_SCHEMA.image, KEY_ALIASES.image)
    : {}
  return { kind: 'image', label: 'Image', from: image.from, to: attribute?.to ?? image.to, values }
}

function findColumnTarget (state: EditorState, tree: Tree, from: number): PandocAttributeTarget|undefined {
  const column = findAncestor(tree, from, node => isColumnDiv(state, node))
  if (column === null) {
    return undefined
  }
  const attribute = column.getChild('PandocAttribute')
  const values = attribute !== null ? readAttributeValues(braceInner(state, attribute), 'brace', PANDOC_ATTRIBUTE_SCHEMA.column) : {}
  return { kind: 'column', label: 'Column', from: column.from, to: column.to, values }
}

function findTableTarget (state: EditorState, tree: Tree, from: number): PandocAttributeTarget|undefined {
  const table = findAncestor(tree, from, node => node.name === 'Table')
  if (table === null) {
    return undefined
  }
  const values = readDirectiveValues(state, table, 'table', PANDOC_ATTRIBUTE_SCHEMA.table)
  return { kind: 'table', label: 'Table', from: table.from, to: table.to, values }
}

function findBlockTarget (state: EditorState, tree: Tree, from: number): PandocAttributeTarget|undefined {
  const block = findAncestor(tree, from, isBlockNode)
  if (block === null) {
    return undefined
  }
  const values = readDirectiveValues(state, block, 'style', PANDOC_ATTRIBUTE_SCHEMA.block)
  return { kind: 'block', label: BLOCK_LABELS[block.name], from: block.from, to: block.to, values }
}

/**
 * Finds the first block of the page around a position, and the end of the
 * page. The page follows the pandoc pagination of splitPandocSlides; the
 * first block is the first top-level node of the page that is neither a
 * comment nor a horizontal rule.
 */
function findPageStart (state: EditorState, tree: Tree, position: number): { firstBlock: SyntaxNode, pageTo: number }|undefined {
  const chunks = splitPandocSlides(state.doc.toString())
  if (chunks.length === 0) {
    return undefined
  }
  const lineIndex = state.doc.lineAt(position).number - 1
  let chunk = chunks.find(candidate => candidate.startLine <= lineIndex && lineIndex < candidate.endLine)
  if (chunk === undefined && lineIndex >= chunks[chunks.length - 1].endLine) {
    chunk = chunks[chunks.length - 1]
  }
  if (chunk === undefined || chunk.kind !== 'slide') {
    return undefined
  }
  const pageFrom = state.doc.line(chunk.startLine + 1).from
  const pageTo = state.doc.line(Math.min(chunk.endLine, state.doc.lines)).to

  let child = tree.topNode.firstChild
  while (child !== null) {
    if (child.from >= pageFrom && child.from <= pageTo && !PAGE_GLUE_NODES.includes(child.name)) {
      return { firstBlock: child, pageTo }
    }
    if (child.from > pageTo) {
      break
    }
    child = child.nextSibling
  }
  return undefined
}

function findPageTarget (state: EditorState, tree: Tree, from: number): PandocAttributeTarget|undefined {
  const page = findPageStart(state, tree, from)
  if (page === undefined) {
    return undefined
  }
  const values = readDirectiveValues(state, page.firstBlock, 'page', PANDOC_ATTRIBUTE_SCHEMA.page)
  return { kind: 'page', label: 'Page', from: page.firstBlock.from, to: page.pageTo, values }
}

/**
 * Returns the editable objects at the cursor or selection, innermost first
 * (span, image, column, table, block, page), at most one per kind (contract
 * C2). A non-empty selection that is not inside an existing span and stays
 * within one paragraph yields a span with `wrapsSelection: true`. The values
 * reflect what is written in the Markdown source.
 *
 * @param   {EditorState}  state  The editor state (Markdown parser required)
 * @param   {number}       from   The start of the selection
 * @param   {number}       to     The end of the selection (= from for a cursor)
 *
 * @return  {PandocAttributeTarget[]}  The objects, innermost first
 */
export function findPandocAttributeTargets (state: EditorState, from: number, to: number): PandocAttributeTarget[] {
  if (to < from) {
    [ from, to ] = [ to, from ]
  }
  const tree = getTree(state)
  const targets = [
    findSpanTarget(state, tree, from, to),
    findImageTarget(state, tree, from),
    findColumnTarget(state, tree, from),
    findTableTarget(state, tree, from),
    findBlockTarget(state, tree, from),
    findPageTarget(state, tree, from)
  ]
  return targets.filter((target): target is PandocAttributeTarget => target !== undefined)
}

// ---------------------------------------------------------------------------
// Building the changes
// ---------------------------------------------------------------------------

/**
 * Builds the changes for an existing brace attribute node. Returns undefined
 * when no key remains, so that the caller can remove the braces its own way.
 */
function rewriteBraces (
  state: EditorState,
  attribute: SyntaxNode,
  kind: PandocAttributeTargetKind,
  update: PandocAttributeUpdate
): ChangeSpec[]|undefined {
  const inner = braceInner(state, attribute)
  const result = updateAttributeList(inner, 'brace', PANDOC_ATTRIBUTE_SCHEMA[kind], update, KEY_ALIASES[kind])
  if (!result.changed) {
    return []
  }
  if (result.empty) {
    return undefined
  }
  return minimalChange(attribute.from + 1, inner, result.text)
}

/**
 * The brace attribute text for a new attribute node, or undefined when the
 * update adds nothing
 */
function newBraceCore (kind: PandocAttributeTargetKind, update: PandocAttributeUpdate): string|undefined {
  const result = updateAttributeList('', 'brace', PANDOC_ATTRIBUTE_SCHEMA[kind], update, KEY_ALIASES[kind])
  return result.empty ? undefined : result.core
}

function buildSpanChanges (state: EditorState, tree: Tree, target: PandocAttributeTarget, update: PandocAttributeUpdate): ChangeSpec[] {
  if (target.wrapsSelection === true) {
    const core = newBraceCore('span', update)
    if (core === undefined || target.to <= target.from) {
      return []
    }
    return [{ from: target.from, insert: '[' }, { from: target.to, insert: `]{${core}}` }]
  }

  const span = findNodeAt(tree, target.from, target.to, node => node.name === 'PandocSpan' && node.to === target.to)
  const attribute = span !== null ? attributeChild(span) : null
  if (span === null || attribute === null) {
    return []
  }
  const changes = rewriteBraces(state, attribute, 'span', update)
  if (changes !== undefined) {
    return changes
  }
  // No key left: unwrap the span back into plain text
  const marks = span.getChildren('PandocSpanMark')
  if (marks.length < 2) {
    return []
  }
  return [{ from: marks[0].from, to: marks[0].to }, { from: marks[marks.length - 1].from, to: attribute.to }]
}

function buildImageChanges (state: EditorState, tree: Tree, target: PandocAttributeTarget, update: PandocAttributeUpdate): ChangeSpec[] {
  const found = findImage(tree, target.from)
  if (found === undefined || found.image.from !== target.from) {
    return []
  }
  const { image, attribute } = found
  if (attribute === null) {
    const core = newBraceCore('image', update)
    return core === undefined ? [] : [{ from: image.to, insert: `{${core}}` }]
  }
  return rewriteBraces(state, attribute, 'image', update) ?? [{ from: attribute.from, to: attribute.to }]
}

function buildColumnChanges (state: EditorState, tree: Tree, target: PandocAttributeTarget, update: PandocAttributeUpdate): ChangeSpec[] {
  const column = findNodeAt(tree, target.from, target.to, node => isColumnDiv(state, node) && node.to === target.to)
  if (column === null) {
    return []
  }
  const attribute = column.getChild('PandocAttribute')
  const info = column.getChild('PandocDivInfo')
  if (attribute === null) {
    // `::: column` written with a bare class name: add braces after it
    const core = newBraceCore('column', update)
    return core === undefined || info === null ? [] : [{ from: info.to, insert: ` {${core}}` }]
  }
  const changes = rewriteBraces(state, attribute, 'column', update)
  if (changes !== undefined) {
    return changes
  }
  if (info !== null) {
    // `::: column {width=…}`: drop the braces together with the space before
    return [{ from: info.to, to: attribute.to }]
  }
  // Without a class name the braces must stay, or the fence would close the div
  const inner = braceInner(state, attribute)
  return minimalChange(attribute.from + 1, inner, '')
}

/**
 * Relocates the node a directive target refers to
 */
function findDirectiveBlock (state: EditorState, tree: Tree, target: PandocAttributeTarget): SyntaxNode|null {
  switch (target.kind) {
    case 'table':
      return findNodeAt(tree, target.from, target.to, node => node.name === 'Table' && node.to === target.to)
    case 'block':
      return findNodeAt(tree, target.from, target.to, node => isBlockNode(node) && node.to === target.to)
    case 'page': {
      const page = findPageStart(state, tree, target.from)
      return page !== undefined && page.firstBlock.from === target.from ? page.firstBlock : null
    }
    default:
      return null
  }
}

/**
 * Returns the minimal changes that apply an attribute update to a target
 * found by findPandocAttributeTargets, ready for `view.dispatch({ changes })`
 * (contract C2). Brace attributes are rewritten in their original order; the
 * braces disappear when no key remains (a span is unwrapped into plain text).
 * Directive comments are rewritten in place, inserted before the object when
 * missing, and removed with one following blank line when no key remains.
 * Returns an empty list when nothing changes or the target no longer exists.
 *
 * @param   {EditorState}            state   The editor state
 * @param   {PandocAttributeTarget}  target  The target to change
 * @param   {PandocAttributeUpdate}  update  The keys to set or remove
 *
 * @return  {ChangeSpec[]}                   The changes
 */
export function buildPandocAttributeChanges (state: EditorState, target: PandocAttributeTarget, update: PandocAttributeUpdate): ChangeSpec[] {
  const tree = getTree(state)
  switch (target.kind) {
    case 'span':
      return buildSpanChanges(state, tree, target, update)
    case 'image':
      return buildImageChanges(state, tree, target, update)
    case 'column':
      return buildColumnChanges(state, tree, target, update)
    case 'table':
    case 'block':
    case 'page': {
      const block = findDirectiveBlock(state, tree, target)
      const prefix = PANDOC_DIRECTIVE_PREFIX[target.kind]
      if (block === null || prefix === undefined) {
        return []
      }
      return buildDirectiveChanges(state, block, prefix, PANDOC_ATTRIBUTE_SCHEMA[target.kind], update)
    }
  }
}
