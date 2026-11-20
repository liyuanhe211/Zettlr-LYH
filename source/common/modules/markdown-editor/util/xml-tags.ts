import { syntaxTree } from '@codemirror/language'
import { type EditorState } from '@codemirror/state'
import { classifyHtmlBlock } from './html-block-scan'

export interface XmlTag {
  from: number
  to: number
  name: string
  closing: boolean
  standalone: boolean
}

export interface XmlTagPair {
  open: XmlTag
  close: XmlTag
  contentFrom: number
  contentTo: number
  foldable: boolean
}

interface SourceRange { from: number, to: number }

/** The same Unicode and ASCII camel-case rules as Prompt_Text.xml_tag_name. */
export function xmlTagName (label: string): string {
  const text = label.normalize('NFKC').trim()
    .replace(/([a-z0-9])(?=[A-Z])/g, '$1_')
    .replace(/([A-Z])(?=[A-Z][a-z])/g, '$1_').toLowerCase()
  let name = Array.from(text, character => /[\p{L}\p{Nd}\p{Mn}\p{Mc}_]/u.test(character) ? character : '_')
    .join('').replace(/_+/g, '_').replace(/^_+|_+$/g, '')
  if (/^[\p{Nd}\p{Mn}\p{Mc}]/u.test(name)) {
    name = '_' + name
  }
  return name
}

/** A single selection may finish at the next line's start, including at EOF. */
export function wholeLineSelection (state: EditorState): SourceRange|null {
  if (state.selection.ranges.length !== 1) {return null}
  const selection = state.selection.main
  if (selection.empty || state.doc.lineAt(selection.from).from !== selection.from) {return null}
  const lastLine = state.doc.lineAt(selection.to)
  if (selection.to !== lastLine.to && selection.to !== lastLine.from) {return null}
  return { from: selection.from, to: selection.to }
}

/**
 * CodeMirror's HTMLBlock may contain Markdown-looking code, so also scan code
 * delimiters lexically. This keeps tags in code inert even inside XML blocks.
 */
export function xmlExcludedRanges (state: EditorState): SourceRange[] {
  const ranges: SourceRange[] = []
  syntaxTree(state).iterate({
    enter (node) {
      if ([ 'FencedCode', 'CodeBlock', 'IndentedCode', 'InlineCode', 'YAMLFrontmatter' ].includes(node.name)) {
        ranges.push({ from: node.from, to: node.to })
        return false
      }
    }
  })
  let fence: { character: string, length: number, from: number }|undefined
  for (let number = 1; number <= state.doc.lines; number++) {
    const line = state.doc.line(number)
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.text)
    if (fence !== undefined) {
      if (marker !== null && marker[1][0] === fence.character && marker[1].length >= fence.length && marker[2].trim() === '') {
        ranges.push({ from: fence.from, to: line.to })
        fence = undefined
      }
      continue
    }
    if (marker !== null && !(marker[1][0] === '`' && marker[2].includes('`'))) {
      fence = { character: marker[1][0], length: marker[1].length, from: line.from }
    } else if (/^(?: {4}|\t)/.test(line.text)) {
      ranges.push({ from: line.from, to: line.to })
    }
  }
  if (fence !== undefined) {ranges.push({ from: fence.from, to: state.doc.length })}

  const source = state.doc.toString()
  const backticks = /`+/g
  let opening: RegExpExecArray|null
  while ((opening = backticks.exec(source)) !== null) {
    if (ranges.some(range => opening !== null && opening.index >= range.from && opening.index < range.to)) {continue}
    const closingPattern = new RegExp('(?<!`)' + '`'.repeat(opening[0].length) + '(?!`)', 'g')
    closingPattern.lastIndex = backticks.lastIndex
    const closing = closingPattern.exec(source)
    if (closing !== null) {
      ranges.push({ from: opening.index, to: closing.index + closing[0].length })
      backticks.lastIndex = closing.index + closing[0].length
    }
  }
  return ranges.sort((first, second) => first.from - second.from)
}

/** Whole code constructs can be wrapped from outside; their interiors cannot. */
export function xmlSelectionContainsCode (state: EditorState, selection: SourceRange): boolean {
  return xmlExcludedRanges(state).some(range => range.from < selection.to && range.to > selection.from &&
    !(selection.from <= range.from && selection.to >= range.to))
}

/** Insert only at the boundaries; selected text and its trailing newline survive. */
export function xmlWrapChanges (state: EditorState, selection: SourceRange, name: string): Array<{ from: number, insert: string }> {
  const selected = state.sliceDoc(selection.from, selection.to)
  const endsWithNewline = selected.endsWith('\n')
  const suffix = (endsWithNewline ? '' : '\n') + `</${name}>` + (endsWithNewline ? '\n' : '')
  return [{ from: selection.from, insert: `<${name}>\n` }, { from: selection.to, insert: suffix }]
}

const pairCache = new WeakMap<EditorState, XmlTagPair[]>()
const documentPairCache = new WeakMap<object, { tree: ReturnType<typeof syntaxTree>, pairs: XmlTagPair[] }>()
const voidNames = new Set([ 'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr' ])

/** Preserve actual HTML displays, without reserving their names from XML. */
function containsHtmlDisplay (source: string): boolean {
  return classifyHtmlBlock(source) === 'widget' && (
    /<a\s[^>]*\bhref\s*=/i.test(source) || /<img\s[^>]*\bsrc\s*=/i.test(source) ||
    (/<table(?:\s|>)/i.test(source) && /<(?:tr|td|th)(?:\s|>)/i.test(source)) ||
    (/<(?:ul|ol|dl)(?:\s|>)/i.test(source) && /<(?:li|dt|dd)(?:\s|>)/i.test(source)) ||
    (/<details(?:\s|>)/i.test(source) && /<summary(?:\s|>)/i.test(source))
  )
}

/** XML attributes need quoted values and unique, case-sensitive names. */
function validXmlAttributes (source: string): boolean {
  const names = new Set<string>()
  let remaining = source
  while (remaining.trim() !== '') {
    const attribute = /^\s+([\p{L}_:][\p{L}\p{Nd}\p{Mn}\p{Mc}_.:\-]*)\s*=\s*(?:"[^"<]*"|'[^'<]*')/u.exec(remaining)
    if (attribute === null || names.has(attribute[1])) {return false}
    names.add(attribute[1])
    remaining = remaining.slice(attribute[0].length)
  }
  return true
}

/** Read through quoted attributes and declaration subsets without executing HTML. */
function tagEnd (source: string, start: number): number {
  let quote = ''
  let brackets = 0
  for (let position = start; position < source.length; position++) {
    const character = source[position]
    if (quote !== '') {
      if (character === quote) {quote = ''}
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (character === '[') {
      brackets++
    } else if (character === ']') {
      brackets = Math.max(0, brackets - 1)
    } else if (character === '>' && brackets === 0) {
      return position + 1
    } else if (character === '<') {
      return -1
    }
  }
  return -1
}

/** Full-document, case-sensitive stack pairing; crossed structures are rejected. */
export function findXmlTagPairs (state: EditorState): XmlTagPair[] {
  const cached = pairCache.get(state)
  if (cached !== undefined) {return cached}
  const tree = syntaxTree(state)
  const documentCached = documentPairCache.get(state.doc)
  if (documentCached?.tree === tree) {return documentCached.pairs}
  const source = state.doc.toString()
  const excluded = xmlExcludedRanges(state)
  const stack: XmlTag[] = []
  const pairs: XmlTagPair[] = []
  const htmlDisplays: SourceRange[] = []
  tree.iterate({
    enter (node) {
      if (node.name === 'HTMLBlock' && containsHtmlDisplay(source.slice(node.from, node.to))) {
        htmlDisplays.push({ from: node.from, to: node.to })
        return false
      }
    }
  })
  let position = 0
  let excludedIndex = 0
  while ((position = source.indexOf('<', position)) !== -1) {
    while (excludedIndex < excluded.length && excluded[excludedIndex].to <= position) {excludedIndex++}
    const code = excluded[excludedIndex]
    if (code !== undefined && position >= code.from && position < code.to) {
      position = code.to
      continue
    }
    let ignoredEnd: number|undefined
    for (const [ prefix, suffix ] of [ [ '<!--', '-->' ], [ '<![CDATA[', ']]>' ], [ '<?', '?>' ] ]) {
      if (source.startsWith(prefix, position)) {
        const end = source.indexOf(suffix, position + prefix.length)
        ignoredEnd = end < 0 ? source.length : end + suffix.length
        break
      }
    }
    if (ignoredEnd !== undefined) { position = ignoredEnd; continue }
    const end = tagEnd(source, position + 1)
    if (end < 0) { position++; continue }
    const text = source.slice(position, end)
    if (text.startsWith('<!')) { position = end; continue }
    const match = /^<(\/?)([\p{L}_:][\p{L}\p{Nd}\p{Mn}\p{Mc}_.:\-]*)([\s\S]*)>$/u.exec(text)
    if (match === null || (match[3] !== '' && !/^[\s/]/.test(match[3]))) { position = end; continue }
    const closing = match[1] === '/'
    const unpairedHtmlVoid = !closing && voidNames.has(match[2]) &&
      !new RegExp('</' + match[2] + '\\s*>').test(source.slice(end))
    if ((closing && match[3].trim() !== '') || /\/\s*>$/.test(text) || unpairedHtmlVoid) { position = end; continue }
    if (!closing && !validXmlAttributes(match[3])) { stack.length = 0; position = end; continue }
    const firstLine = state.doc.lineAt(position)
    const lastLine = state.doc.lineAt(end)
    const tag: XmlTag = {
      from: position, to: end, name: match[2], closing,
      standalone: firstLine.number === lastLine.number && source.slice(firstLine.from, position).trim() === '' && source.slice(end, lastLine.to).trim() === ''
    }
    if (!closing) {
      stack.push(tag)
    } else {
      const open = stack.pop()
      if (open === undefined || open.name !== tag.name) {
        // Previously completed children of this malformed group are invalid too.
        const invalidFrom = stack[0]?.from ?? open?.from ?? position
        for (let index = pairs.length - 1; index >= 0; index--) {
          if (pairs[index].open.from >= invalidFrom) {pairs.splice(index, 1)}
        }
        stack.length = 0
      } else if (open.standalone && tag.standalone) {
        const contentFrom = state.doc.lineAt(open.to).to
        const contentTo = state.doc.lineAt(tag.from).from - 1
        if (containsHtmlDisplay(source.slice(open.from, tag.to))) {
          htmlDisplays.push({ from: open.from, to: tag.to })
        } else {
          pairs.push({ open, close: tag, contentFrom, contentTo,
            foldable: contentTo > contentFrom && source.slice(contentFrom, contentTo).trim() !== '' })
        }
      }
    }
    position = end
  }
  // An unclosed ancestor must not expose partially valid nested controls.
  const unclosedFrom = stack[0]?.from
  const result = pairs.filter(pair => (unclosedFrom === undefined || pair.open.from < unclosedFrom) &&
    !htmlDisplays.some(display => pair.open.from >= display.from && pair.close.to <= display.to))
    .sort((first, second) => first.open.from - second.open.from)
  pairCache.set(state, result)
  documentPairCache.set(state.doc, { tree, pairs: result })
  return result
}

/** HTML renderers must leave XML control lines visible, including enclosing blocks. */
export function overlapsXmlTagControls (state: EditorState, from: number, to: number): boolean {
  return findXmlTagPairs(state).some(pair =>
    (from < pair.open.to && to > pair.open.from) || (from < pair.close.to && to > pair.close.from))
}
