/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Bold and italic toggling by rebuilding the inline styles
 * CVM-Role:        Utility function
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Toggles bold or italic on a selection by the parsed syntax
 *                  tree. Every text character of the affected region gets the
 *                  set of styles it carries, only the toggled style changes on
 *                  the selected characters, and the region is written out
 *                  again with properly nested delimiters. The result is parsed
 *                  once more and only applied if every character carries the
 *                  expected styles; otherwise the document stays unchanged.
 *
 * END HEADER
 */

import { type ChangeSpec, EditorSelection, type EditorState, type SelectionRange } from '@codemirror/state'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { SyntaxNode, Tree } from '@lezer/common'

/** The toggled styles, in the order used when two runs are equally long. */
const STYLE_NAMES: readonly string[] = [ 'StrongEmphasis', 'Emphasis' ]
/** Nodes whose whole content is inline text. */
const TEXT_BLOCK = /^(Paragraph|ATXHeading[1-6]|SetextHeading[12]|Task|TableCell)$/
/** Inline objects whose content is inline text again, e.g. a link text. */
const INLINE_CONTAINERS = new Set([ 'Link', 'Strikethrough', 'HighlightContent', 'PandocSpan' ])
const PARSE_TIMEOUT = 200
const Punctuation = /[\p{P}\p{S}]/u
const WordCharacter = /[\p{L}\p{N}]/u

/**
 * One piece of the inline content: a single text character, an inline object
 * kept as a whole (`atom`, e.g. inline code or a link), a structural mark kept
 * in place (`barrier`, e.g. a block quote mark on a continuation line), or the
 * opening or closing mark of an emphasis object (`mark`, dropped and rebuilt).
 */
interface StyleUnit {
  from: number
  to: number
  kind: 'text'|'space'|'atom'|'barrier'|'mark'
  styles: ReadonlySet<string>
  name: string
}

interface EmphasisObject {
  from: number
  to: number
  name: string
  character: string
}

interface InlineContext {
  node: SyntaxNode
  from: number
  to: number
  units: StyleUnit[]
  objects: EmphasisObject[]
  selectionFrom: number
  selectionTo: number
}

type Token = { unit: number } | { style: string, pair: number, open: boolean }

interface Candidate {
  text: string
  offsets: Map<number, number>
  delimiterOffsets: number[]
}

interface ContextResult {
  from: number
  to: number
  text: string
  changed: boolean
  selectedFrom?: number
  selectedTo?: number
}

function isMarkName (name: string): boolean {
  return /(Mark|Marker|Delimiter)$/.test(name)
}

function isContent (unit: StyleUnit): boolean {
  return unit.kind === 'text' || unit.kind === 'atom'
}

function firstCharacter (text: string): string {
  const codePoint = text.codePointAt(0)
  return codePoint === undefined ? '' : String.fromCodePoint(codePoint)
}

function lastCharacter (text: string): string {
  const characters = Array.from(text)
  return characters.length > 0 ? characters[characters.length - 1] : ''
}

/** A letter, digit or CJK character, as opposed to whitespace or punctuation. */
function isWord (character: string): boolean {
  return character !== '' && !/\s/u.test(character) && !Punctuation.test(character)
}

function sameStyles (first: ReadonlySet<string>, second: ReadonlySet<string>): boolean {
  return first.size === second.size && [...first].every(style => second.has(style))
}

/** The emphasis styles of `node` and all its ancestors. */
function ancestorStyles (node: SyntaxNode|null): Set<string> {
  const styles = new Set<string>()
  for (let current = node; current !== null; current = current.parent) {
    if (STYLE_NAMES.includes(current.name)) {
      styles.add(current.name)
    }
  }
  return styles
}

/**
 * The range of inline content of `node` if it is a text block or an inline
 * container: for a container, the text between its first mark and the next.
 *
 * @param   {SyntaxNode}  node  The node
 *
 * @return  {object|undefined}  The content range
 */
function contentRange (node: SyntaxNode): { from: number, to: number }|undefined {
  if (TEXT_BLOCK.test(node.name)) {
    return { from: node.from, to: node.to }
  }
  if (!INLINE_CONTAINERS.has(node.name)) {
    return undefined
  }
  const opening = node.firstChild
  if (opening === null || opening.from !== node.from || !isMarkName(opening.name)) {
    return undefined
  }
  for (let child = opening.nextSibling; child !== null; child = child.nextSibling) {
    if (isMarkName(child.name)) {
      return { from: opening.to, to: child.from }
    }
  }
  return undefined
}

/**
 * Splits the inline content between `from` and `to` into style units and
 * collects the emphasis objects in it.
 */
function collectUnits (state: EditorState, node: SyntaxNode, from: number, to: number): { units: StyleUnit[], objects: EmphasisObject[] } {
  const units: StyleUnit[] = []
  const objects: EmphasisObject[] = []

  const addText = (textFrom: number, textTo: number, styles: ReadonlySet<string>): void => {
    let position = textFrom
    for (const character of state.sliceDoc(textFrom, textTo)) {
      const kind = /\s/u.test(character) ? 'space' : 'text'
      units.push({ from: position, to: position + character.length, kind, styles, name: '' })
      position += character.length
    }
  }

  const walk = (parent: SyntaxNode, walkFrom: number, walkTo: number, styles: ReadonlySet<string>): void => {
    let position = walkFrom
    for (let child = parent.firstChild; child !== null; child = child.nextSibling) {
      if (child.to <= walkFrom || child.from >= walkTo) {
        continue
      }
      if (child.from > position) {
        addText(position, child.from, styles)
      }
      const marks = STYLE_NAMES.includes(child.name) ? child.getChildren('EmphasisMark') : []
      if (marks.length >= 2) {
        const opening = marks[0]
        const closing = marks[marks.length - 1]
        objects.push({ from: child.from, to: child.to, name: child.name, character: state.sliceDoc(opening.from, opening.from + 1) })
        units.push({ from: child.from, to: opening.to, kind: 'mark', styles, name: child.name })
        walk(child, opening.to, closing.from, new Set([ ...styles, child.name ]))
        units.push({ from: closing.from, to: child.to, kind: 'mark', styles, name: child.name })
      } else {
        units.push({ from: child.from, to: child.to, kind: isMarkName(child.name) ? 'barrier' : 'atom', styles, name: child.name })
      }
      position = child.to
    }
    if (position < walkTo) {
      addText(position, walkTo, styles)
    }
  }

  walk(node, from, to, ancestorStyles(node))
  return { units, objects }
}

/**
 * The inline contexts the selection touches: the innermost text block or
 * inline container that holds the whole selection, or else every text block
 * the selection overlaps.
 */
function findContexts (state: EditorState, tree: Tree, range: SelectionRange): InlineContext[] {
  const ranges: Array<{ node: SyntaxNode, from: number, to: number }> = []
  for (let node: SyntaxNode|null = tree.resolveInner(range.from, 1); node !== null; node = node.parent) {
    const content = contentRange(node)
    if (content !== undefined && content.from <= range.from && range.to <= content.to) {
      ranges.push({ node, ...content })
      break
    }
  }
  if (ranges.length === 0) {
    tree.iterate({
      from: range.from,
      to: range.to,
      enter (reference) {
        if (!TEXT_BLOCK.test(reference.name)) {
          return undefined
        }
        if (reference.from < range.to && reference.to > range.from) {
          ranges.push({ node: reference.node, from: reference.from, to: reference.to })
        }
        return false
      }
    })
  }
  return ranges.map(({ node, from, to }) => ({
    node,
    from,
    to,
    ...collectUnits(state, node, from, to),
    selectionFrom: Math.max(range.from, from),
    selectionTo: Math.min(range.to, to)
  }))
}

function isSelected (context: InlineContext, unit: StyleUnit): boolean {
  return unit.kind !== 'mark' && unit.kind !== 'barrier' && unit.from < context.selectionTo && unit.to > context.selectionFrom
}

/**
 * The region to rebuild: the selection, grown to every emphasis object that
 * touches it and every inline object that overlaps it.
 */
function regionOf (context: InlineContext): { from: number, to: number } {
  let from = context.selectionFrom
  let to = context.selectionTo
  for (;;) {
    let nextFrom = from
    let nextTo = to
    for (const object of context.objects) {
      if (object.from <= to && object.to >= from) {
        nextFrom = Math.min(nextFrom, object.from)
        nextTo = Math.max(nextTo, object.to)
      }
    }
    for (const unit of context.units) {
      if ((unit.kind === 'atom' || unit.kind === 'barrier') && unit.from < to && unit.to > from) {
        nextFrom = Math.min(nextFrom, unit.from)
        nextTo = Math.max(nextTo, unit.to)
      }
    }
    if (nextFrom === from && nextTo === to) {
      return { from, to }
    }
    from = nextFrom
    to = nextTo
  }
}

/**
 * Writes the region out with delimiters for the target styles. Opening
 * delimiters go after and closing delimiters before whitespace; styles that
 * start together are nested with the longer run outside.
 */
function emit (state: EditorState, context: InlineContext, region: { from: number, to: number }, regionIndices: number[], targets: Map<number, Set<string>>, preferred: (style: string) => string): Candidate {
  const { units } = context
  const content = regionIndices.filter(index => isContent(units[index]))
  const order = new Map(content.map((index, position) => [ index, position ]))
  const duration = (start: number, style: string): number => {
    let length = 0
    while (start + length < content.length && targets.get(content[start + length])?.has(style) === true) {
      length++
    }
    return length
  }

  const tokens: Token[] = []
  const stack: Array<{ style: string, pair: number }> = []
  let pending: number[] = []
  let pairCount = 0
  const closeAbove = (keep: number): void => {
    while (stack.length > keep) {
      const entry = stack.pop() as { style: string, pair: number }
      tokens.push({ style: entry.style, pair: entry.pair, open: false })
    }
  }
  const flush = (): void => {
    for (const index of pending) {
      tokens.push({ unit: index })
    }
    pending = []
  }

  for (const index of regionIndices) {
    const unit = units[index]
    if (unit.kind === 'mark') {
      continue
    }
    if (unit.kind === 'space' || unit.kind === 'barrier') {
      pending.push(index)
      continue
    }
    const target = targets.get(index) as Set<string>
    let keep = 0
    while (keep < stack.length && target.has(stack[keep].style)) {
      keep++
    }
    closeAbove(keep)
    flush()
    const start = order.get(index) as number
    const opening = [...target]
      .filter(style => !stack.some(entry => entry.style === style))
      .sort((first, second) => duration(start, second) - duration(start, first) || STYLE_NAMES.indexOf(first) - STYLE_NAMES.indexOf(second))
    for (const style of opening) {
      const pair = pairCount++
      stack.push({ style, pair })
      tokens.push({ style, pair, open: true })
    }
    tokens.push({ unit: index })
  }
  closeAbove(0)
  flush()

  // `_` cannot open or close emphasis inside a word: such pairs use `*`.
  const sourceOf = (index: number): string => state.sliceDoc(units[index].from, units[index].to)
  const characterBefore = (tokenIndex: number): string => {
    for (let other = tokenIndex - 1; other >= 0; other--) {
      const token = tokens[other]
      if ('unit' in token) {
        return lastCharacter(sourceOf(token.unit))
      }
    }
    return lastCharacter(state.sliceDoc(Math.max(0, region.from - 2), region.from))
  }
  const characterAfter = (tokenIndex: number): string => {
    for (let other = tokenIndex + 1; other < tokens.length; other++) {
      const token = tokens[other]
      if ('unit' in token) {
        return firstCharacter(sourceOf(token.unit))
      }
    }
    return firstCharacter(state.sliceDoc(region.to, region.to + 2))
  }
  const pairCharacters = new Map<number, string>()
  tokens.forEach((token, tokenIndex) => {
    if ('unit' in token || !token.open) {
      return
    }
    const pair = token.pair
    const closingIndex = tokens.findIndex(other => !('unit' in other) && other.pair === pair && !other.open)
    let character = preferred(token.style)
    if (character === '_' && (WordCharacter.test(characterBefore(tokenIndex)) || WordCharacter.test(characterAfter(closingIndex)))) {
      character = '*'
    }
    pairCharacters.set(pair, character)
  })

  let text = ''
  const offsets = new Map<number, number>()
  const delimiterOffsets: number[] = []
  for (const token of tokens) {
    if ('unit' in token) {
      offsets.set(token.unit, text.length)
      text += sourceOf(token.unit)
      continue
    }
    const delimiter = (pairCharacters.get(token.pair) as string).repeat(token.style === 'StrongEmphasis' ? 2 : 1)
    for (let offset = 0; offset < delimiter.length; offset++) {
      delimiterOffsets.push(text.length + offset)
    }
    text += delimiter
  }
  return { text, offsets, delimiterOffsets }
}

/** The emphasis styles of the text character at `position`, null on a mark. */
function textStylesAt (tree: Tree, position: number): Set<string>|null {
  const node = tree.resolveInner(position, 1)
  return node.name === 'EmphasisMark' ? null : ancestorStyles(node)
}

/** The emphasis styles around the inline object `name` at `from`–`to`. */
function atomStylesAt (tree: Tree, from: number, to: number, name: string): Set<string>|null {
  for (let node: SyntaxNode|null = tree.resolveInner(from, 1); node !== null; node = node.parent) {
    if (node.from === from && node.to === to && node.name === name) {
      return ancestorStyles(node.parent)
    }
  }
  return null
}

/**
 * Parses the document with the candidate in place of the region and checks
 * that every delimiter became an emphasis mark and every text character and
 * inline object of the context carries exactly the expected styles.
 */
function verify (state: EditorState, context: InlineContext, region: { from: number, to: number }, candidate: Candidate, targets: Map<number, Set<string>>): boolean {
  const delta = candidate.text.length - (region.to - region.from)
  const next = state.update({ changes: { from: region.from, to: region.to, insert: candidate.text }, filter: false }).state
  const tree = ensureSyntaxTree(next, Math.min(next.doc.length, context.to + delta + 1), PARSE_TIMEOUT)
  if (tree === null) {
    return false
  }
  for (const offset of candidate.delimiterOffsets) {
    if (tree.resolveInner(region.from + offset, 1).name !== 'EmphasisMark') {
      return false
    }
  }
  for (let index = 0; index < context.units.length; index++) {
    const unit = context.units[index]
    if (!isContent(unit)) {
      continue
    }
    let position = unit.from
    if (unit.from >= region.to) {
      position += delta
    } else if (unit.from >= region.from) {
      position = region.from + (candidate.offsets.get(index) as number)
    }
    const expected = targets.get(index) ?? unit.styles
    const actual = unit.kind === 'text'
      ? textStylesAt(tree, position)
      : atomStylesAt(tree, position, position + unit.to - unit.from, unit.name)
    if (actual === null || !sameStyles(actual, expected)) {
      return false
    }
  }
  return true
}

/**
 * Takes the style off punctuation at the edges of each styled run whose outer
 * neighbour is a letter, digit or CJK character, since such a delimiter
 * cannot open or close emphasis. Returns null when nothing was changed.
 */
function stripEdgePunctuation (state: EditorState, context: InlineContext, regionIndices: number[], targets: Map<number, Set<string>>): Map<number, Set<string>>|null {
  const { units } = context
  const result = new Map([...targets].map(([ index, styles ]) => [ index, new Set(styles) ]))
  const content = regionIndices.filter(index => isContent(units[index]))
  const neighbour = (index: number, step: number): string => {
    for (let other = index + step; other >= 0 && other < units.length; other += step) {
      if (units[other].kind !== 'mark') {
        const source = state.sliceDoc(units[other].from, units[other].to)
        return step < 0 ? lastCharacter(source) : firstCharacter(source)
      }
    }
    return step < 0
      ? lastCharacter(state.sliceDoc(Math.max(0, context.from - 2), context.from))
      : firstCharacter(state.sliceDoc(context.to, context.to + 2))
  }
  const isPunctuationUnit = (index: number): boolean => units[index].kind === 'text' && Punctuation.test(state.sliceDoc(units[index].from, units[index].to))

  let changed = false
  for (const style of STYLE_NAMES) {
    let start = 0
    while (start < content.length) {
      if (targets.get(content[start])?.has(style) !== true) {
        start++
        continue
      }
      let end = start
      while (end + 1 < content.length && targets.get(content[end + 1])?.has(style) === true) {
        end++
      }
      const first = content[start]
      const last = content[end]
      if (isPunctuationUnit(first) && isWord(neighbour(first, -1))) {
        result.get(first)?.delete(style)
        changed = true
      }
      if (isPunctuationUnit(last) && isWord(neighbour(last, 1))) {
        result.get(last)?.delete(style)
        changed = true
      }
      start = end + 1
    }
  }
  return changed ? result : null
}

/** Rebuilds one context; null when no candidate passes the verification. */
function rebuildContext (state: EditorState, context: InlineContext, styleName: string, remove: boolean, markup: string): ContextResult|null {
  const region = regionOf(context)
  const { units } = context
  const regionIndices: number[] = []
  units.forEach((unit, index) => {
    if (unit.from >= region.from && unit.to <= region.to) {
      regionIndices.push(index)
    }
  })
  let targets = new Map<number, Set<string>>()
  for (const index of regionIndices) {
    const unit = units[index]
    if (!isContent(unit)) {
      continue
    }
    const styles = new Set(unit.styles)
    if (isSelected(context, unit)) {
      if (remove) {
        styles.delete(styleName)
      } else {
        styles.add(styleName)
      }
    }
    targets.set(index, styles)
  }

  // Keep the delimiter character of the existing objects, e.g. `_` or `__`.
  const preferred = (style: string): string => {
    const existing = context.objects.find(object => object.name === style && object.from >= region.from && object.to <= region.to)
    if (existing !== undefined) {
      return existing.character
    }
    return style === styleName && markup.startsWith('_') ? '_' : '*'
  }

  const original = state.sliceDoc(region.from, region.to)
  let candidate = emit(state, context, region, regionIndices, targets, preferred)
  if (candidate.text !== original && !verify(state, context, region, candidate, targets)) {
    const stripped = stripEdgePunctuation(state, context, regionIndices, targets)
    if (stripped === null) {
      return null
    }
    targets = stripped
    candidate = emit(state, context, region, regionIndices, targets, preferred)
    if (candidate.text !== original && !verify(state, context, region, candidate, targets)) {
      return null
    }
  }

  const selected = regionIndices.filter(index => isSelected(context, units[index]))
  const result: ContextResult = { from: region.from, to: region.to, text: candidate.text, changed: candidate.text !== original }
  if (selected.length > 0) {
    const first = selected[0]
    const last = selected[selected.length - 1]
    result.selectedFrom = region.from + (candidate.offsets.get(first) as number)
    result.selectedTo = region.from + (candidate.offsets.get(last) as number) + units[last].to - units[last].from
  }
  return result
}

/**
 * Toggles bold (`StrongEmphasis`) or italic (`Emphasis`) on a nonempty
 * selection by the parsed objects. When every selected text character already
 * has the style, the selection loses it; otherwise it gains it. Other styles
 * stay as they are, inline objects such as code or links are never split, and
 * the change is only made if the new text parses to exactly these styles.
 *
 * @param   {EditorState}     state      The current state
 * @param   {SelectionRange}  range      A nonempty selection range
 * @param   {string}          markup     The configured markup for new objects
 * @param   {string}          styleName  `StrongEmphasis` or `Emphasis`
 *
 * @return  {object}                     The changes and the new range
 */
export function toggleInlineStyle (state: EditorState, range: SelectionRange, markup: string, styleName: string): { changes?: ChangeSpec, range: SelectionRange } {
  const tree = ensureSyntaxTree(state, state.doc.length, PARSE_TIMEOUT) ?? syntaxTree(state)
  const contexts = findContexts(state, tree, range)
  const selectedContent = contexts.flatMap(context => context.units.filter(unit => isContent(unit) && isSelected(context, unit)))
  if (selectedContent.length === 0) {
    return { range }
  }
  const remove = selectedContent.every(unit => unit.styles.has(styleName))

  const results: ContextResult[] = []
  for (const context of contexts) {
    const result = rebuildContext(state, context, styleName, remove, markup)
    if (result === null) {
      return { range }
    }
    results.push(result)
  }
  if (!results.some(result => result.changed)) {
    return { range }
  }

  const changes: ChangeSpec[] = []
  let delta = 0
  let newFrom: number|undefined
  let newTo: number|undefined
  for (const result of results) {
    if (result.selectedFrom !== undefined && result.selectedTo !== undefined) {
      newFrom = newFrom ?? result.selectedFrom + delta
      newTo = result.selectedTo + delta
    }
    if (result.changed) {
      changes.push({ from: result.from, to: result.to, insert: result.text })
      delta += result.text.length - (result.to - result.from)
    }
  }
  return {
    changes,
    range: newFrom !== undefined && newTo !== undefined ? EditorSelection.range(newFrom, newTo) : range
  }
}
