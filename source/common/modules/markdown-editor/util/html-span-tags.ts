/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Raw HTML tag utilities
 * CVM-Role:        Utility Functions
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Pure helper functions for the raw HTML renderer: parsing
 *                  the text of a single tag of a whitelisted element (e.g.
 *                  `<span style="...">`, `<small>`, `<div align="right">`)
 *                  into its name and (whitelisted) attributes, pairing a
 *                  document-order sequence of such tags into matching
 *                  open/close pairs, and finding tags and character entities
 *                  in the text of a raw HTML block. Also recognizes the void
 *                  elements `<br>` and `<img>` inside paragraphs, decodes
 *                  character references in attribute values, and filters
 *                  link targets down to safe protocols.
 *
 * END HEADER
 */

/**
 * Inline formatting elements. When rendered, the enclosed text is wrapped in
 * an element of the same name, so the browser's default styling applies
 * (e.g. `<small>` shrinks the text, `<sup>` raises it).
 */
export const INLINE_ELEMENTS = [
  'span', 'small', 'big', 'sup', 'sub', 'b', 'strong', 'i', 'em', 'u', 'ins',
  's', 'strike', 'del', 'mark', 'kbd', 'abbr', 'cite', 'q', 'var', 'samp', 'dfn'
]

/**
 * Block elements. When rendered, their lines receive the element's
 * alignment and style (e.g. `<div align="right">` right-aligns its lines).
 */
export const BLOCK_ELEMENTS = [ 'div', 'p', 'center' ]

/**
 * Only these attributes are carried over into the rendered decoration.
 * Everything else (especially `on*` event handlers) is dropped for safety.
 * `align` is only honored on block elements, where it becomes `text-align`.
 */
const ALLOWED_ATTRIBUTES = [ 'style', 'class', 'id', 'title', 'lang', 'dir', 'align' ]

/**
 * The link element. It is only accepted as an inline element when a caller
 * asks for it (see `ParseHtmlTagOptions`), and it is the only element whose
 * `href` attribute is carried over.
 */
export const LINK_ELEMENT = 'a'

export interface ParseHtmlTagOptions {
  /**
   * Also accept the link element `a` as an inline element, together with its
   * `href` attribute. Off by default.
   */
  allowLinks?: boolean
}

/**
 * Matches attribute="double quoted", attribute='single quoted', and
 * attribute=unquoted forms
 */
const ATTRIBUTE_PATTERN = /([a-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi

/**
 * Returns all attributes of a tag's attribute text, with lowercase names.
 *
 * @param   {string}                   attributeText  The text after the name
 *
 * @return  {Array<[string, string]>}                 Name and value pairs
 */
function parseAttributes (attributeText: string): Array<[string, string]> {
  const attributes: Array<[string, string]> = []
  for (const match of attributeText.matchAll(ATTRIBUTE_PATTERN)) {
    attributes.push([ match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '' ])
  }
  return attributes
}

export type HtmlElementKind = 'inline'|'block'

export interface OpeningHtmlTag {
  kind: 'open'
  name: string
  element: HtmlElementKind
  attributes: Record<string, string>
}

export interface ClosingHtmlTag {
  kind: 'close'
  name: string
}

export type ParsedHtmlTag = OpeningHtmlTag | ClosingHtmlTag

function elementKind (name: string, options: ParseHtmlTagOptions = {}): HtmlElementKind|undefined {
  if (INLINE_ELEMENTS.includes(name) || (options.allowLinks === true && name === LINK_ELEMENT)) {
    return 'inline'
  } else if (BLOCK_ELEMENTS.includes(name)) {
    return 'block'
  }
  return undefined
}

/**
 * Parses the verbatim text of a single HTML tag. Returns a descriptor if the
 * text is an opening or closing tag of a whitelisted element, and undefined
 * for any other tag (other element names, comments, self-closing tags,
 * malformed text).
 *
 * @param   {string}               tagText  The tag text, including the angle
 *                                          brackets
 * @param   {ParseHtmlTagOptions}  options  Optional: also accept links
 *
 * @return  {ParsedHtmlTag|undefined}  The parse result
 */
export function parseHtmlTag (tagText: string, options: ParseHtmlTagOptions = {}): ParsedHtmlTag|undefined {
  const closingMatch = /^<\/([a-z][a-z0-9]*)\s*>$/i.exec(tagText)
  if (closingMatch !== null) {
    const name = closingMatch[1].toLowerCase()
    return elementKind(name, options) !== undefined ? { kind: 'close', name } : undefined
  }

  const openingMatch = /^<([a-z][a-z0-9]*)(\s[^>]*)?>$/is.exec(tagText)
  if (openingMatch === null) {
    return undefined
  }

  const name = openingMatch[1].toLowerCase()
  const element = elementKind(name, options)
  const attributeText = openingMatch[2] ?? ''
  if (element === undefined || attributeText.trimEnd().endsWith('/')) {
    return undefined
  }

  const attributes: Record<string, string> = {}
  for (const [ attributeName, value ] of parseAttributes(attributeText)) {
    const isLinkTarget = name === LINK_ELEMENT && attributeName === 'href'
    if (isLinkTarget || (ALLOWED_ATTRIBUTES.includes(attributeName) && (attributeName !== 'align' || element === 'block'))) {
      attributes[attributeName] = value
    }
  }

  return { kind: 'open', name, element, attributes }
}

/**
 * Void elements that are rendered inside paragraphs. They have no closing
 * tag, so they do not take part in the open/close pairing.
 */
export const VOID_INLINE_ELEMENTS = [ 'br', 'img' ]

/**
 * The attributes carried over for each void element. Everything else
 * (especially `on*` event handlers) is dropped.
 */
const VOID_ELEMENT_ATTRIBUTES: Record<string, string[]> = {
  br: [],
  img: [ 'src', 'alt', 'title', 'width', 'height', 'style' ]
}

export interface VoidHtmlTag {
  name: string
  attributes: Record<string, string>
}

/**
 * Parses the verbatim text of a `<br>` or `<img>` tag, in void (`<br>`) or
 * self-closing (`<br/>`, `<img src="x.png" />`) form. Returns undefined for
 * every other tag, and for an image without a `src` attribute.
 *
 * @param   {string}                tagText  The tag text, including the
 *                                           angle brackets
 *
 * @return  {VoidHtmlTag|undefined}          The parse result
 */
export function parseVoidHtmlTag (tagText: string): VoidHtmlTag|undefined {
  const match = /^<([a-z][a-z0-9]*)(\s[^>]*|\/)?>$/is.exec(tagText)
  if (match === null) {
    return undefined
  }

  const name = match[1].toLowerCase()
  if (!VOID_INLINE_ELEMENTS.includes(name)) {
    return undefined
  }

  const attributes: Record<string, string> = {}
  for (const [ attributeName, value ] of parseAttributes(match[2] ?? '')) {
    if (VOID_ELEMENT_ATTRIBUTES[name].includes(attributeName)) {
      attributes[attributeName] = value
    }
  }

  if (name === 'img' && (attributes.src === undefined || attributes.src.trim() === '')) {
    return undefined
  }

  return { name, attributes }
}

/**
 * The named character references that `decodeCharacterReferences` resolves.
 * Other names are left as they are.
 */
const NAMED_CHARACTER_REFERENCES: Record<string, string> = {
  amp: '&',
  AMP: '&',
  lt: '<',
  LT: '<',
  gt: '>',
  GT: '>',
  quot: '"',
  QUOT: '"',
  apos: "'",
  nbsp: '\u00a0',
  colon: ':',
  Tab: '\t',
  NewLine: '\n',
  sol: '/',
  period: '.',
  lpar: '(',
  rpar: ')',
  num: '#',
  quest: '?',
  equals: '=',
  percnt: '%'
}

/**
 * Decodes the character references in an attribute value, as a browser would
 * before using it: decimal and hexadecimal references (with or without the
 * final semicolon) and a set of common named references. This matters for
 * link targets, since `&#106;avascript:` must be recognized as `javascript:`.
 *
 * @param   {string}  text  The raw attribute value
 *
 * @return  {string}        The decoded value
 */
export function decodeCharacterReferences (text: string): string {
  return text.replace(
    /&(?:#([0-9]+);?|#[xX]([0-9a-fA-F]+);?|([a-zA-Z][a-zA-Z0-9]*);)/g,
    (reference: string, decimal?: string, hexadecimal?: string, name?: string) => {
      if (name !== undefined) {
        // Look up own entries only, so that e.g. `&toString;` stays as it is
        return Object.prototype.hasOwnProperty.call(NAMED_CHARACTER_REFERENCES, name)
          ? NAMED_CHARACTER_REFERENCES[name]
          : reference
      }
      const codePoint = decimal !== undefined ? parseInt(decimal, 10) : parseInt(hexadecimal ?? '', 16)
      const isValid = Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff &&
        (codePoint < 0xd800 || codePoint > 0xdfff)
      return isValid ? String.fromCodePoint(codePoint) : '\ufffd'
    }
  )
}

/**
 * The protocols a rendered HTML link may point to. Links without a protocol
 * (relative paths, `#heading` anchors) are always allowed.
 */
const ALLOWED_LINK_PROTOCOLS = [ 'http', 'https', 'file', 'mailto' ]

/**
 * Checks a (decoded) link target and returns it in the form a browser would
 * use (surrounding whitespace and control characters removed, tabs and line
 * breaks removed everywhere). Returns undefined for an empty target and for
 * any protocol other than http, https, file and mailto (e.g. `javascript:`).
 * Relative paths and absolute Windows paths (`C:\...`) count as local files.
 *
 * @param   {string}            href  The link target
 *
 * @return  {string|undefined}        The cleaned target, or undefined
 */
export function normalizeLinkHref (href: string): string|undefined {
  const cleaned = href
    .replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '')
    .replace(/[\t\n\r]/g, '')

  if (cleaned === '') {
    return undefined
  }

  if (/^[a-z]:[\\/]/i.test(cleaned)) {
    return cleaned // An absolute Windows path
  }

  const protocolMatch = /^([a-z][a-z0-9+.-]*):/i.exec(cleaned)
  if (protocolMatch === null) {
    return cleaned // A relative path or an anchor
  }

  return ALLOWED_LINK_PROTOCOLS.includes(protocolMatch[1].toLowerCase()) ? cleaned : undefined
}

/**
 * Turns the attributes of a block element into the attributes of a line
 * decoration: `align` (and `<center>`) become `text-align` in the style.
 *
 * @param   {OpeningHtmlTag}          tag  The opening tag of a block element
 *
 * @return  {Record<string, string>}       The line attributes
 */
export function blockLineAttributes (tag: OpeningHtmlTag): Record<string, string> {
  const { align, ...attributes } = tag.attributes
  const alignment = tag.name === 'center' ? 'center' : align?.toLowerCase()
  if (alignment !== undefined && /^(left|right|center|justify)$/.test(alignment)) {
    const style = attributes.style?.trim() ?? ''
    attributes.style = `text-align: ${alignment};` + (style !== '' ? ` ${style}` : '')
  }
  return attributes
}

export interface HtmlTagOccurrence {
  /**
   * Start offset of the tag in the document
   */
  from: number
  /**
   * End offset of the tag in the document
   */
  to: number
  /**
   * The parsed tag
   */
  tag: ParsedHtmlTag
  /**
   * An identifier for the enclosing block (e.g., the start offset of the
   * paragraph). Tags are only paired within the same block.
   */
  blockId: number
}

export interface HtmlTagPair {
  open: HtmlTagOccurrence & { tag: OpeningHtmlTag }
  close: HtmlTagOccurrence & { tag: ClosingHtmlTag }
}

/**
 * Pairs a document-order list of tag occurrences into matching open/close
 * pairs of the same element, honoring nesting. Unmatched tags are ignored,
 * and tags are never paired across different blocks.
 *
 * @param   {HtmlTagOccurrence[]}  occurrences  The tags in document order
 *
 * @return  {HtmlTagPair[]}                     The matched pairs
 */
export function pairHtmlTags (occurrences: HtmlTagOccurrence[]): HtmlTagPair[] {
  const pairs: HtmlTagPair[] = []
  let openStack: Array<HtmlTagOccurrence & { tag: OpeningHtmlTag }> = []

  for (const occurrence of occurrences) {
    // An opening tag from an earlier block can never be closed anymore.
    openStack = openStack.filter(candidate => candidate.blockId === occurrence.blockId)

    if (occurrence.tag.kind === 'open') {
      openStack.push(occurrence as HtmlTagOccurrence & { tag: OpeningHtmlTag })
      continue
    }

    // Find the innermost unclosed opening tag of the same element. Opening
    // tags nested inside it that were never closed are dropped.
    const name = occurrence.tag.name
    let index = openStack.length - 1
    while (index >= 0 && openStack[index].tag.name !== name) {
      index--
    }
    if (index >= 0) {
      pairs.push({ open: openStack[index], close: occurrence as HtmlTagOccurrence & { tag: ClosingHtmlTag } })
      openStack = openStack.slice(0, index)
    }
  }

  return pairs
}

export interface HtmlBlockScan {
  /**
   * The whitelisted tags, with offsets relative to the block's text
   */
  tags: Array<{ from: number, to: number, tag: ParsedHtmlTag }>
  /**
   * The character entities, with offsets relative to the block's text
   */
  entities: Array<{ from: number, to: number }>
}

/**
 * Finds the tags and character entities in the text of a raw HTML block.
 * Returns undefined if the block contains any element that is not
 * whitelisted (e.g. `<table>`, `<iframe>`, `<script>`), since such a block
 * must be left as it is rather than rendered in part.
 *
 * @param   {string}                    text  The block's text
 *
 * @return  {HtmlBlockScan|undefined}         The findings
 */
export function scanHtmlBlock (text: string): HtmlBlockScan|undefined {
  const scan: HtmlBlockScan = { tags: [], entities: [] }
  const withoutComments = text.replace(/<!--[\s\S]*?-->/g, comment => ' '.repeat(comment.length))

  for (const match of withoutComments.matchAll(/<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?>/gi)) {
    const tag = parseHtmlTag(match[0])
    if (tag === undefined) {
      return undefined
    }
    scan.tags.push({ from: match.index, to: match.index + match[0].length, tag })
  }

  for (const match of withoutComments.matchAll(HTML_ENTITY_PATTERN)) {
    scan.entities.push({ from: match.index, to: match.index + match[0].length })
  }

  return scan
}

/**
 * Matches named, decimal and hexadecimal character entities such as
 * `&nbsp;`, `&#8212;` and `&#x2014;`.
 */
export const HTML_ENTITY_PATTERN = /&(?:[a-z][a-z0-9]*|#[0-9]{1,7}|#x[0-9a-f]{1,6});/gi
