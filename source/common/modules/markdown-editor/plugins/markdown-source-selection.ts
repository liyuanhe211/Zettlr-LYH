/**
 * Preserve complete hidden Markdown objects in the actual selection.
 * Only preview selection events expand;
 * input, remote changes, and programmatic navigation keep their own positions.
 */
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState, StateEffect, StateField, type Extension, type SelectionRange } from '@codemirror/state'
import { type SyntaxNode } from '@lezer/common'
import type { EditorView } from '@codemirror/view'
import { ViewPlugin } from '@codemirror/view'
import { configField } from '../util/configuration'
import { codeNodeCategory, freezeRevealSelectionEffect, shouldRevealSource } from '../util/reveal-selection'
import { type CodeEditingCategory } from '../util/code-editing-policy'
import { pairHtmlTags, parseHtmlTag, scanHtmlBlock, type HtmlTagOccurrence } from '../util/html-span-tags'
import { parsePdfCallout } from '../parser/admonition-parser'
import { type CopyVisibleTextCategory } from '../util/visible-copy-policy'

export interface SourceBoundary {
  from: number
  to: number
  contentFrom: number
  contentTo: number
  prefix?: boolean
  /**
   * A prefix rendered as a visible widget (the bullet of an unordered list).
   * Its content start and the visible start of the text are one place, so a
   * selection starting exactly there selects the text only; the selection has
   * to start strictly before it, unless another prefix moved the start there.
   */
  visiblePrefix?: boolean
  styleCategory?: CodeEditingCategory
  sourceCategory?: CodeEditingCategory
  revealFrom?: number
  revealTo?: number
  /** Text object extent; prefixes only occupy a small part of their object. */
  objectFrom?: number
  objectTo?: number
  copyCategory?: CopyVisibleTextCategory
}

function afterHorizontalSpace (state: EditorState, from: number, to: number): number {
  while (from < to) {
    const character = state.sliceDoc(from, from + 1)
    if (character !== ' ' && character !== '\t') {
      break
    }
    from++
  }
  return from
}

function pairedBoundary (node: SyntaxNode, markName: string, styleCategory?: CodeEditingCategory): SourceBoundary | undefined {
  const marks = node.getChildren(markName)
  if (marks.length < 2) {
    return undefined
  }
  return {
    from: node.from, to: node.to,
    contentFrom: marks[0].to, contentTo: marks[marks.length - 1].from, styleCategory
  }
}

function prefixBoundary (state: EditorState, from: number, to: number, limit: number): SourceBoundary {
  const line = state.doc.lineAt(from)
  // Preserve indentation when a selected list marker starts an indented line.
  if (afterHorizontalSpace(state, line.from, from) === from) {
    from = line.from
  }
  const contentFrom = afterHorizontalSpace(state, to, limit)
  return { from, to: contentFrom, contentFrom, contentTo: contentFrom, prefix: true }
}

export function sourceBoundaries (state: EditorState, to: number): SourceBoundary[] {
  const boundaries: SourceBoundary[] = []
  const htmlTags: HtmlTagOccurrence[] = []
  // Parse through the selected area, including ancestors whose closing mark is
  // outside it. Never infer Markdown structure from displayed DOM text.
  const tree = ensureSyntaxTree(state, state.doc.length, 50) ?? syntaxTree(state)
  tree.iterate({
    from: 0, to: state.doc.length,
    enter (reference) {
      const node = reference.node
      let boundary: SourceBoundary | undefined
      switch (node.name) {
        case 'InlineCode':
          boundary = pairedBoundary(node, 'CodeMark', codeNodeCategory(state, reference))
          if (boundary !== undefined) {
            boundary.copyCategory = boundary.styleCategory === 'math' ? 'math' : 'inlineCode'
          }
          break
        case 'StrongEmphasis':
        case 'Emphasis':
          boundary = pairedBoundary(node, 'EmphasisMark', 'formatting')
          if (boundary !== undefined) {
            boundary.copyCategory = node.name === 'StrongEmphasis' ? 'bold' : 'italic'
          }
          break
        case 'Strikethrough':
          boundary = pairedBoundary(node, 'StrikethroughMark', 'formatting')
          break
        case 'HighlightContent':
          boundary = pairedBoundary(node, 'HighlightMark', 'formatting')
          break
        case 'PandocSpan':
          boundary = pairedBoundary(node, 'PandocSpanMark', 'pandoc')
          break
        case 'HTMLTag': {
          const tag = parseHtmlTag(state.sliceDoc(node.from, node.to))
          if (tag !== undefined) {
            htmlTags.push({ from: node.from, to: node.to, tag, blockId: node.parent?.from ?? -1 })
          }
          return false
        }
        case 'HTMLBlock': {
          const scan = scanHtmlBlock(state.sliceDoc(node.from, node.to))
          if (scan !== undefined) {
            for (const tag of scan.tags) {
              htmlTags.push({ from: node.from + tag.from, to: node.from + tag.to, tag: tag.tag, blockId: node.from })
            }
          }
          return false
        }
        case 'Link': {
          const marks = node.getChildren('LinkMark')
          // Shortcut reference links and autolinks have no hidden destination.
          if (marks.length >= 3 || node.getChild('LinkLabel') !== null) {
            if (marks.length >= 2) {
              boundary = { from: node.from, to: node.to, contentFrom: marks[0].to, contentTo: marks[1].from, sourceCategory: 'links' }
            }
          }
          break
        }
        case 'ZknLink': {
          const content = node.getChild('ZknLinkTitle') ?? node.getChild('ZknLinkContent')
          if (content !== null) {
            boundary = { from: node.from, to: node.to, contentFrom: content.from, contentTo: content.to, sourceCategory: 'links' }
          }
          break
        }
        case 'FencedCode': {
          const marks = node.getChildren('CodeMark')
          if (marks.length >= 2) {
            const firstLine = state.doc.lineAt(marks[0].from)
            const lastLine = state.doc.lineAt(marks[marks.length - 1].from)
            boundary = {
              from: node.from, to: node.to,
              contentFrom: firstLine.to + 1,
              // The separator before the closing fence belongs to the object,
              // but selecting its last visible character need not select it.
              contentTo: lastLine.from - 1, sourceCategory: codeNodeCategory(state, reference)
            }
            boundary.copyCategory = boundary.sourceCategory === 'math' ? 'math'
              : boundary.sourceCategory === 'codeBlocks' ? 'codeBlocks' : undefined
          }
          if (boundary !== undefined && boundary.contentFrom < boundary.contentTo) {
            boundaries.push(boundary)
          }
          // Nested language parsers must not create Markdown boundaries.
          return false
        }
        case 'QuoteMark':
        case 'ListMark':
        case 'TaskMarker': {
          // Ordered list numbers are rendered as literal source, unlike bullets.
          if (node.name === 'ListMark' && node.parent?.parent?.name === 'OrderedList') {
            break
          }
          boundary = prefixBoundary(state, node.from, node.to, state.doc.lineAt(node.to).to)
          let parent = node.parent
          if (node.name === 'QuoteMark') {
            for (let ancestor = parent; ancestor !== null; ancestor = ancestor.parent) {
              if (ancestor.name === 'Blockquote') {
                parent = ancestor
              }
            }
          }
          boundary.sourceCategory = node.name === 'QuoteMark' ? 'blockquotes' : node.name === 'TaskMarker' ? 'checkboxes' : 'lists'
          if (node.name === 'QuoteMark' && parent !== null && parsePdfCallout(parent, state.doc) !== null) {
            boundary.sourceCategory = 'admonitions'
          }
          boundary.revealFrom = node.name === 'TaskMarker' ? node.from : parent?.from ?? node.from
          boundary.revealTo = node.name === 'TaskMarker' ? node.to : parent?.to ?? node.to
          boundary.objectFrom = state.doc.lineAt(node.from).from
          boundary.objectTo = state.doc.lineAt(node.from).to
          if (node.name === 'ListMark') {
            boundary.copyCategory = 'lists'
            boundary.visiblePrefix = true
          }
          // Zettlr-LYH (R171): a rendered task checkbox is visible like a
          // bullet, so a selection starting at the task text leaves it out
          if (node.name === 'TaskMarker') {
            boundary.visiblePrefix = true
          }
          break
        }
        default:
          if (node.name.startsWith('ATXHeading')) {
            const mark = node.getChild('HeaderMark')
            if (mark !== null) {
              boundary = prefixBoundary(state, mark.from, mark.to, node.to)
              boundary.sourceCategory = 'headings'
              boundary.revealFrom = node.from
              boundary.revealTo = node.to
              boundary.objectFrom = node.from
              boundary.objectTo = node.to
              boundary.copyCategory = 'headings'
            }
          }
      }
      if (boundary !== undefined && (boundary.prefix === true || boundary.contentFrom < boundary.contentTo)) {
        boundaries.push(boundary)
      }
      if (node.name === 'InlineCode') {
        return false
      }
    }
  })
  for (const { open, close } of pairHtmlTags(htmlTags)) {
    if (open.tag.element === 'inline' && open.to < close.from &&
      !state.sliceDoc(open.from, open.to).includes('\n') && !state.sliceDoc(close.from, close.to).includes('\n')) {
      boundaries.push({ from: open.from, to: close.to, contentFrom: open.to, contentTo: close.from, styleCategory: 'html' })
    }
  }
  return boundaries.filter(boundary => boundary.from <= to && boundarySyntaxHidden(state, boundary))
}

function boundarySyntaxHidden (state: EditorState, boundary: SourceBoundary): boolean {
  const configuration = state.field(configField)
  const category = boundary.sourceCategory ?? boundary.styleCategory ?? 'formatting'
  // These options remove the corresponding renderer, leaving literal source.
  const rendererEnabled = category === 'headings' ? configuration.renderHeadings
    : category === 'links' ? configuration.renderLinks
      : category === 'html' ? configuration.renderPandoc
        : category === 'checkboxes' ? configuration.renderTasks
          : configuration.renderEmphasis
  if (!rendererEnabled) {
    return false
  }
  return !shouldRevealSource(state, category, boundary.revealFrom ?? boundary.from, boundary.revealTo ?? boundary.to,
    category === 'headings' || configuration.previewModeShowSyntaxWhenCursorIsAdjacent)
}

/**
 * A selection holds every source character of the object between these ends.
 * `prefixChained` tells that the expansion of another prefix (a task checkbox,
 * a heading mark) moved `from` to where it is now.
 */
function boundaryComplete (boundary: SourceBoundary, from: number, to: number, prefixChained = false): boolean {
  if (boundary.prefix === true) {
    const startsBefore = boundary.visiblePrefix === true && !prefixChained
      ? from < boundary.contentFrom
      : from <= boundary.contentFrom
    return startsBefore && to > boundary.contentFrom
  }
  return from <= boundary.contentFrom && to >= boundary.contentTo && to > boundary.from && from < boundary.to
}

/**
 * The first position at or beyond `head` towards the anchor that the expansion
 * in `normalizeRange` leaves alone, so that shrinking the selection with the
 * keyboard skips a whole hidden object instead of being pushed back every time.
 */
function headOutsideHiddenSource (boundaries: SourceBoundary[], anchor: number, head: number, forward: boolean): number {
  // Every pass moves the head further towards the anchor, so this terminates.
  let changed = true
  // A hidden prefix that begins right after a crossed visible bullet (a task
  // checkbox) is crossed together with it, as before bullets became visible.
  let crossedVisiblePrefix = false
  while (changed && (forward ? head < anchor : head > anchor)) {
    changed = false
    for (const boundary of boundaries) {
      if (!boundaryComplete(boundary, forward ? head : anchor, forward ? anchor : head)) {
        continue
      }
      if (forward && (boundary.from < head || (crossedVisiblePrefix && boundary.prefix === true && boundary.from === head))) {
        // A visible bullet only needs the start at its content: that position
        // no longer selects it.
        head = boundary.visiblePrefix === true ? boundary.contentFrom : boundary.contentFrom + 1
        crossedVisiblePrefix = boundary.visiblePrefix === true
        changed = true
      } else if (!forward && boundary.to > head) {
        head = boundary.prefix === true ? boundary.contentFrom : boundary.contentTo - 1
        changed = true
      }
    }
  }
  return forward ? Math.min(head, anchor) : Math.max(head, anchor)
}

function normalizeRange (range: SelectionRange, boundaries: SourceBoundary[]): SelectionRange {
  if (range.empty) {
    return range
  }
  let { from, to } = range
  // Inner objects can make an enclosing object complete. Each pass only adds
  // source characters, so this terminates and is idempotent.
  let changed = true
  let prefixChained = false
  while (changed) {
    changed = false
    for (const boundary of boundaries) {
      if (!boundaryComplete(boundary, from, to, prefixChained)) {
        continue
      }
      const nextFrom = Math.min(from, boundary.from)
      const nextTo = Math.max(to, boundary.to)
      if (nextFrom !== from || nextTo !== to) {
        if (nextFrom !== from) {
          // Only an expansion over hidden source chains on to the prefix in
          // front: a visible one (bullet, checkbox) was selected by the user
          prefixChained = boundary.prefix === true && boundary.visiblePrefix !== true
        }
        from = nextFrom
        to = nextTo
        changed = true
      }
    }
  }
  if (range.from === from && range.to === to) {
    return range
  }
  if (range.undirectional) {
    return EditorSelection.undirectionalRange(from, to)
  }
  return EditorSelection.range(
    range.anchor > range.head ? to : from,
    range.anchor > range.head ? from : to,
    range.goalColumn, range.bidiLevel ?? undefined, range.assoc
  )
}

function normalizeAgainstBoundaries (selection: EditorSelection, boundaries: SourceBoundary[]): EditorSelection {
  const ranges = selection.ranges.map(range => normalizeRange(range, boundaries))
  if (ranges.every((range, index) => range === selection.ranges[index])) {
    return selection
  }
  return EditorSelection.create(ranges, selection.mainIndex)
}

function selectionNormalizable (state: EditorState, selection: EditorSelection): boolean {
  return state.field(configField, false)?.renderingMode === 'preview' && selection.ranges.some(range => !range.empty)
}

/** Normalize a selection against the parsed source without changing the doc. */
export function normalizeMarkdownSourceSelection (state: EditorState, selection: EditorSelection = state.selection): EditorSelection {
  if (!selectionNormalizable(state, selection)) {
    return selection
  }
  return normalizeAgainstBoundaries(selection, sourceBoundaries(state, selection.ranges[selection.ranges.length - 1].to))
}

/**
 * Normalize the selection of a keyboard selection transaction. A move that only
 * shrinks one side must still arrive somewhere: where the expansion would push
 * the moved end right back to where it came from, that end skips the whole
 * hidden object instead, down to an empty selection at the anchor.
 */
export function resolveMarkdownSourceSelection (state: EditorState, selection: EditorSelection): EditorSelection {
  if (!selectionNormalizable(state, selection)) {
    return selection
  }
  const previous = state.selection
  const lastTo = Math.max(selection.ranges[selection.ranges.length - 1].to, previous.ranges[previous.ranges.length - 1].to)
  const boundaries = sourceBoundaries(state, lastTo)
  const normalized = normalizeAgainstBoundaries(selection, boundaries)
  if (normalized.ranges.length !== previous.ranges.length || normalized.ranges.length !== selection.ranges.length) {
    return normalized
  }
  const ranges = normalized.ranges.map((range, index) => {
    const before = previous.ranges[index]
    const moved = selection.ranges[index]
    const forward = moved.head > before.head
    // Only a shrinking move of one end whose result was undone completely.
    if (before.empty || moved.anchor !== before.anchor || moved.head === before.head ||
      forward !== (before.head < before.anchor) ||
      range.anchor !== before.anchor || range.head !== before.head) {
      return range
    }
    const head = headOutsideHiddenSource(boundaries, before.anchor, moved.head, forward)
    return head === before.head ? range : EditorSelection.range(before.anchor, head)
  })
  if (ranges.every((range, index) => range === normalized.ranges[index])) {
    return normalized
  }
  return EditorSelection.create(ranges, normalized.mainIndex)
}

function hiddenStyles (state: EditorState, to: number): SourceBoundary[] {
  if (state.field(configField, false)?.renderingMode !== 'preview') {
    return []
  }
  return sourceBoundaries(state, to).filter(boundary => boundary.styleCategory !== undefined)
}

/** Resolve the two sides of hidden style marks after a plain mouse click. */
export function markdownStyleCursorPosition (state: EditorState, position: number): number {
  if (state.field(configField, false)?.editCodeWhenClicked !== false) {
    return position
  }
  const boundaries = hiddenStyles(state, position)
  const originalPosition = position
  // A shared boundary belongs to the styled text on its left. In nested
  // styles all contiguous closing marks must remain after the cursor.
  let closingPosition = position
  while (true) {
    const closing = boundaries.filter(boundary => closingPosition >= boundary.contentTo && closingPosition <= boundary.to)
    const nextPosition = closing.length === 0 ? closingPosition : Math.min(...closing.map(boundary => boundary.contentTo))
    if (nextPosition === closingPosition) {
      break
    }
    closingPosition = nextPosition
  }
  if (closingPosition !== position) {
    return closingPosition
  }
  let changed = true
  while (changed) {
    changed = false
    for (const boundary of boundaries) {
      if (position > boundary.from && position <= boundary.contentFrom) {
        position = boundary.from
        changed = true
      }
    }
  }
  // Opening marks can end immediately after another object's closing marks.
  // Resolve that shared boundary again so adjacent styles prefer the left side.
  return position < originalPosition ? markdownStyleCursorPosition(state, position) : position
}

// Wait until mouseup so a drag starts at the native text position, including
// when it begins at the very same pixel as a plain boundary click.
const styleBoundaryClicks = ViewPlugin.fromClass(class {
  cleanup: (() => void) | undefined

  destroy (): void {
    this.cleanup?.()
  }

  begin (event: MouseEvent, view: EditorView): void {
    this.cleanup?.()
    if (event.button !== 0 || event.detail !== 1 || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey ||
      view.state.field(configField, false)?.editCodeWhenClicked !== false) {
      return
    }
    const document = view.state.doc
    const window = view.dom.ownerDocument.defaultView!
    let moved = false
    const move = (next: MouseEvent): void => {
      moved ||= next.clientX !== event.clientX || next.clientY !== event.clientY
    }
    const cancel = (): void => { this.cleanup?.() }
    const end = (next: MouseEvent): void => {
      move(next)
      this.cleanup?.()
      const selection = view.state.selection
      if (moved || view.state.doc !== document || selection.ranges.length !== 1 || !selection.main.empty || !view.dom.isConnected) {
        return
      }
      const position = markdownStyleCursorPosition(view.state, selection.main.head)
      if (position !== selection.main.head) {
        view.dispatch({ selection: EditorSelection.cursor(position, selection.main.assoc), userEvent: 'select.pointer' })
      }
    }
    this.cleanup = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', end)
      window.removeEventListener('blur', cancel)
      window.removeEventListener('dragstart', cancel)
      this.cleanup = undefined
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', end)
    window.addEventListener('blur', cancel)
    window.addEventListener('dragstart', cancel)
  }
}, {
  eventHandlers: {
    mousedown (event, view) {
      this.begin(event, view)
      return false
    }
  }
})

interface CopySelectionSnapshot {
  boundaries: SourceBoundary[]
  intent: EditorSelection
}

const copyBoundariesEffect = StateEffect.define<CopySelectionSnapshot>()

/**
 * Compares two configuration values by content. The configuration module
 * rebuilds some object-valued settings (for example the character pair
 * settings) on every update, so comparing by identity would report a change
 * where nothing changed. Class instances (Map, Set, RegExp, ...) keep their
 * state out of reach of Object.keys, so they only count as equal by identity.
 */
function configurationValuesEqual (first: unknown, second: unknown): boolean {
  if (first === second) {
    return true
  }
  if (typeof first !== 'object' || typeof second !== 'object' || first === null || second === null) {
    return false
  }
  if (Array.isArray(first) || Array.isArray(second)) {
    return Array.isArray(first) && Array.isArray(second) && first.length === second.length &&
      first.every((item, index) => configurationValuesEqual(item, second[index]))
  }
  const isPlainObject = (value: object): boolean => {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  }
  if (!isPlainObject(first) || !isPlainObject(second)) {
    return false
  }
  const firstRecord = first as Record<string, unknown>
  const secondRecord = second as Record<string, unknown>
  const firstKeys = Object.keys(firstRecord)
  return firstKeys.length === Object.keys(secondRecord).length &&
    firstKeys.every(key => Object.prototype.hasOwnProperty.call(secondRecord, key) && configurationValuesEqual(firstRecord[key], secondRecord[key]))
}

// Keep the visibility at the beginning of a selection. A completed selection
// can reveal its own source, which must not change what a subsequent copy does.
const copyBoundariesField = StateField.define<CopySelectionSnapshot | null>({
  create () { return null },
  update (value, transaction) {
    const before = transaction.startState.field(configField, false)
    const after = transaction.state.field(configField, false)
    const visibilityChanged = before !== after && (before === undefined || after === undefined ||
      (Object.keys(before) as Array<keyof typeof before>).some(key => key !== 'copyVisibleTextCategories' && !configurationValuesEqual(before[key], after[key])))
    if (transaction.docChanged || visibilityChanged) {
      return null
    }
    for (const effect of transaction.effects) {
      if (effect.is(copyBoundariesEffect)) {
        return effect.value
      }
      if (effect.is(freezeRevealSelectionEffect)) {
        return { boundaries: sourceBoundaries(transaction.startState, transaction.startState.doc.length), intent: transaction.startState.selection }
      }
    }
    if (transaction.selection !== undefined && (!transaction.isUserEvent('select') || transaction.newSelection.ranges.every(range => range.empty))) {
      return null
    }
    return value
  }
})

/** Hidden source ranges at selection start, shared with ordinary copy. */
export function markdownCopyBoundaries (state: EditorState): SourceBoundary[] {
  if (state.field(configField, false)?.renderingMode !== 'preview') {
    return []
  }
  return state.field(copyBoundariesField, false)?.boundaries ?? sourceBoundaries(state, state.doc.length)
}

/** Before normalization added hidden characters, which object was selected? */
export function markdownCopySelectionIntent (state: EditorState): EditorSelection {
  return state.field(copyBoundariesField, false)?.intent ?? state.selection
}

/** Complete objects retain their actual source range for cut/delete/drag. */
export const markdownSourceSelection: Extension = [ styleBoundaryClicks, copyBoundariesField,
  EditorState.transactionFilter.of(transaction => {
    if (transaction.selection === undefined || transaction.docChanged || !transaction.isUserEvent('select')) {
      return transaction
    }
    const selection = transaction.isUserEvent('select.pointer')
      ? normalizeMarkdownSourceSelection(transaction.startState, transaction.newSelection)
      : resolveMarkdownSourceSelection(transaction.startState, transaction.newSelection)
    if (selection.ranges.every(range => range.empty)) {
      return selection === transaction.newSelection ? transaction : [ transaction, { selection, sequential: true }]
    }
    const previous = transaction.startState.field(copyBoundariesField, false)
    const boundaries = previous?.boundaries ?? sourceBoundaries(transaction.startState, transaction.startState.doc.length)
    const intent = previous !== null && previous !== undefined && transaction.newSelection.eq(transaction.startState.selection)
      ? previous.intent : transaction.newSelection
    return [ transaction, {
      ...(selection === transaction.newSelection ? {} : { selection }),
      effects: copyBoundariesEffect.of({ boundaries, intent }), sequential: true
    }]
  }) ]
