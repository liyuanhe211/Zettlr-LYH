/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Order-preserving reader and rewriter for Pandoc attribute
 *                  lists, shared by brace attributes (`{.citation size=19}`)
 *                  and directive comments (`<!-- table: col-widths=equal -->`)
 *
 * Description:     The existing parse/format helpers in
 *                  parse-pandoc-attributes.ts do not round-trip (they change
 *                  quotes and add units), so the attribute editor uses this
 *                  module instead. An attribute list is split into tokens
 *                  that remember their exact source offsets; an update then
 *                  rewrites only the tokens it mentions, keeps every other
 *                  token (including keys outside the catalog) verbatim, keeps
 *                  the original separators, and appends new keys at the end.
 *                  Pure functions, no editor dependencies.
 *
 * END HEADER
 */

import type { PandocAttributeKey } from './pandoc-attribute-schema'

/**
 * brace:     the text between `{` and `}`; `#id` and `.class` are recognized
 * directive: the text after `prefix:` of a directive comment; a bare word is
 *            a flag, and an unquoted multi-word choice value (as in
 *            `layout=Two Content`) is joined the way the renderer does
 */
export type AttributeSyntax = 'brace'|'directive'

export interface AttributeToken {
  /** Offsets of the token within the attribute text (end exclusive) */
  from: number
  to: number
  /** id `#x`, class `.x`, `key=value`, or a bare word */
  kind: 'id'|'class'|'keyValue'|'bare'
  /** The key as written; for ids and classes without the leading character */
  key: string
  /** For keyValue only: the value with quotes and escapes removed */
  value: string
  /** For keyValue only: the offset where the (raw) value starts */
  valueFrom: number
  /** For keyValue only: the quote character around the value, or '' */
  quote: string
}

/**
 * Alternative spellings of catalog keys, e.g. `width` for the image key `w`
 */
export type AttributeKeyAliases = Record<string, string[]>

export interface AttributeListUpdateResult {
  /** Whether the attribute text differs from the original */
  changed: boolean
  /** Whether no token at all remains */
  empty: boolean
  /** The rewritten attribute text, including the surrounding whitespace */
  text: string
  /** The rewritten attribute text without surrounding whitespace */
  core: string
}

const WHITESPACE = /\s/

/**
 * Splits text into leading whitespace, core, and trailing whitespace
 */
function splitSurroundingWhitespace (text: string): { lead: string, core: string, trail: string } {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)
  if (match === null) {
    return { lead: '', core: text, trail: '' }
  }
  return { lead: match[1], core: match[2], trail: match[3] }
}

/**
 * Returns the offset just after a (possibly quoted) value starting at `index`.
 * A value ends at the first whitespace outside quotes.
 */
function skipValue (text: string, index: number): number {
  let quote = ''
  while (index < text.length) {
    const character = text[index]
    if (quote !== '') {
      if (character === '\\' && quote === '"') {
        index += 2
        continue
      }
      if (character === quote) {
        quote = ''
      }
      index++
      continue
    }
    if (WHITESPACE.test(character)) {
      break
    }
    if (character === '"' || character === "'") {
      quote = character
    }
    index++
  }
  return Math.min(index, text.length)
}

/**
 * Removes the quotes (and, for double quotes, the backslash escapes) around a
 * raw value
 */
function unquoteValue (raw: string): { value: string, quote: string } {
  const first = raw[0]
  if (raw.length >= 2 && (first === '"' || first === "'") && raw.endsWith(first)) {
    const inner = raw.slice(1, -1)
    if (first === '"') {
      return { value: inner.replace(/\\([\s\S])/g, '$1'), quote: first }
    }
    return { value: inner, quote: first }
  }
  return { value: raw, quote: '' }
}

/**
 * Normalizes a choice value for comparison: case, spaces, underscores and
 * hyphens do not matter (the renderer compares layout names this way)
 */
function normalizeChoice (value: string): string {
  return value.replace(/[\s_-]+/g, ' ').trim().toLowerCase()
}

/**
 * Maps a value of a choice key to the catalog spelling of the matching
 * choice; other values are returned unchanged.
 */
export function canonicalChoice (catalogKey: PandocAttributeKey|undefined, value: string): string {
  if (catalogKey?.type !== 'choice' || catalogKey.choices === undefined) {
    return value
  }
  const normalized = normalizeChoice(value)
  return catalogKey.choices.find(choice => normalizeChoice(choice) === normalized) ?? value
}

/**
 * Whether a value names one of the choices of a choice key
 */
function matchesChoice (catalogKey: PandocAttributeKey, value: string): boolean {
  const normalized = normalizeChoice(value)
  return (catalogKey.choices ?? []).some(choice => normalizeChoice(choice) === normalized)
}

/**
 * Finds the catalog entry for a key as written (case-insensitive, aliases
 * included)
 */
function resolveCatalogKey (writtenKey: string, keys: PandocAttributeKey[], aliases: AttributeKeyAliases): PandocAttributeKey|undefined {
  const lowered = writtenKey.toLowerCase()
  return keys.find(entry => entry.key.toLowerCase() === lowered || (aliases[entry.key] ?? []).some(alias => alias.toLowerCase() === lowered))
}

/**
 * Joins an unquoted choice value with the bare words following it when the
 * words together name a choice (`layout=Two Content`), as the renderer does.
 */
function joinMultiWordChoices (text: string, tokens: AttributeToken[], keys: PandocAttributeKey[]): AttributeToken[] {
  const result: AttributeToken[] = []
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]
    const catalogKey = token.kind === 'keyValue' && token.quote === '' ? resolveCatalogKey(token.key, keys, {}) : undefined
    if (catalogKey?.type === 'choice' && !matchesChoice(catalogKey, token.value)) {
      let joined: AttributeToken|undefined
      let end = index + 1
      for (; end < tokens.length && tokens[end].kind === 'bare'; end++) {
        const candidate = text.slice(token.valueFrom, tokens[end].to)
        if (matchesChoice(catalogKey, candidate)) {
          joined = { ...token, to: tokens[end].to, value: candidate }
          break
        }
      }
      if (joined !== undefined) {
        result.push(joined)
        index = end + 1
        continue
      }
    }
    result.push(token)
    index++
  }
  return result
}

/**
 * Splits an attribute list into tokens with exact source offsets.
 *
 * @param   {string}                text    The attribute text
 * @param   {AttributeSyntax}       syntax  Brace or directive syntax
 * @param   {PandocAttributeKey[]}  keys    The catalog (directive syntax uses
 *                                          it to join multi-word choices)
 *
 * @return  {AttributeToken[]}              The tokens in source order
 */
export function tokenizeAttributes (text: string, syntax: AttributeSyntax, keys: PandocAttributeKey[] = []): AttributeToken[] {
  const tokens: AttributeToken[] = []
  let index = 0

  while (index < text.length) {
    if (WHITESPACE.test(text[index])) {
      index++
      continue
    }

    const start = index
    const first = text[index]
    if (syntax === 'brace' && (first === '#' || first === '.')) {
      while (index < text.length && !WHITESPACE.test(text[index])) {
        index++
      }
      tokens.push({ from: start, to: index, kind: first === '#' ? 'id' : 'class', key: text.slice(start + 1, index), value: '', valueFrom: index, quote: '' })
      continue
    }

    while (index < text.length && !WHITESPACE.test(text[index]) && text[index] !== '=') {
      index++
    }
    const key = text.slice(start, index)
    if (text[index] !== '=') {
      tokens.push({ from: start, to: index, kind: 'bare', key, value: '', valueFrom: index, quote: '' })
      continue
    }

    const valueFrom = index + 1
    index = skipValue(text, valueFrom)
    const { value, quote } = unquoteValue(text.slice(valueFrom, index))
    tokens.push({ from: start, to: index, kind: 'keyValue', key, value, valueFrom, quote })
  }

  return syntax === 'directive' ? joinMultiWordChoices(text, tokens, keys) : tokens
}

/**
 * Reads the current values of the catalog keys from an attribute list. Flags
 * and classes map to ''; a class `.bold` or a bare word for a boolean key maps
 * to 'true'; choice values are mapped to the catalog spelling. Keys outside
 * the catalog and ids are ignored. For duplicate keys the last one wins, as
 * in the renderer.
 */
export function readAttributeValues (
  text: string,
  syntax: AttributeSyntax,
  keys: PandocAttributeKey[],
  aliases: AttributeKeyAliases = {}
): Record<string, string> {
  const values: Record<string, string> = {}
  for (const token of tokenizeAttributes(text, syntax, keys)) {
    if (token.kind === 'id') {
      continue
    }
    const catalogKey = resolveCatalogKey(token.key, keys, aliases)
    if (catalogKey === undefined) {
      continue
    }
    if (token.kind === 'keyValue') {
      values[catalogKey.key] = canonicalChoice(catalogKey, token.value)
    } else {
      values[catalogKey.key] = catalogKey.type === 'boolean' ? 'true' : ''
    }
  }
  return values
}

/**
 * Formats a value for `key=value`: quoted with double quotes when it is empty
 * or contains whitespace, quotes, `=`, braces or backslashes. A value that was
 * quoted before stays quoted with the same quote character when possible.
 */
export function formatAttributeValue (value: string, previousQuote = ''): string {
  if (previousQuote === "'" && !value.includes("'")) {
    return `'${value}'`
  }
  const needsQuotes = value === '' || /[\s"'={}\\]/.test(value) || previousQuote === '"'
  if (!needsQuotes) {
    return value
  }
  return '"' + value.replace(/["\\]/g, '\\$&') + '"'
}

/**
 * Builds the text of a token for a key and value.
 */
function formatToken (
  updateKey: string,
  catalogKey: PandocAttributeKey|undefined,
  value: string,
  syntax: AttributeSyntax,
  existing: AttributeToken|undefined
): string {
  if (catalogKey?.type === 'class' && syntax === 'brace') {
    return '.' + updateKey
  }
  if (catalogKey?.type === 'flag') {
    return updateKey
  }
  const keySpelling = existing?.kind === 'keyValue' ? existing.key : updateKey
  return `${keySpelling}=${formatAttributeValue(value, existing?.kind === 'keyValue' ? existing.quote : '')}`
}

/**
 * Applies an update to an attribute list, preserving everything it does not
 * mention.
 *
 * - A key mapped to undefined is removed (every occurrence, including its
 *   class spelling `.key` and its aliases).
 * - A key mapped to a string is rewritten in place at its first occurrence
 *   (keeping the key spelling and the quote style); further occurrences are
 *   removed; a key not present yet is appended at the end.
 * - A choice key set to its first choice (the default) is removed.
 * - A boolean key set to 'true' that is written as the class `.key` stays as
 *   it is.
 *
 * @param   {string}                text     The attribute text (between the
 *                                           braces, or after `prefix:`)
 * @param   {AttributeSyntax}       syntax   Brace or directive syntax
 * @param   {PandocAttributeKey[]}  keys     The catalog of the object kind
 * @param   {Record}                update   The update to apply
 * @param   {AttributeKeyAliases}   aliases  Alternative key spellings
 *
 * @return  {AttributeListUpdateResult}      The rewritten attribute text
 */
export function updateAttributeList (
  text: string,
  syntax: AttributeSyntax,
  keys: PandocAttributeKey[],
  update: Record<string, string|undefined>,
  aliases: AttributeKeyAliases = {}
): AttributeListUpdateResult {
  const { lead, core, trail } = splitSurroundingWhitespace(text)
  const tokens = tokenizeAttributes(core, syntax, keys)
  // Per token index: a replacement text, or null to remove the token
  const actions = new Map<number, string|null>()
  const appended: string[] = []

  for (const [ updateKey, requestedValue ] of Object.entries(update)) {
    const catalogKey = keys.find(entry => entry.key === updateKey)
    let value = requestedValue
    if (value !== undefined && catalogKey?.type === 'choice' && catalogKey.choices !== undefined &&
      canonicalChoice(catalogKey, value) === catalogKey.choices[0]) {
      value = undefined
    }

    const names = [ updateKey, ...(aliases[updateKey] ?? []) ].map(name => name.toLowerCase())
    const matching: number[] = []
    tokens.forEach((token, index) => {
      if (token.kind !== 'id' && !actions.has(index) && names.includes(token.key.toLowerCase())) {
        matching.push(index)
      }
    })

    if (value === undefined) {
      for (const index of matching) {
        actions.set(index, null)
      }
      continue
    }

    if (matching.length === 0) {
      appended.push(formatToken(updateKey, catalogKey, value, syntax, undefined))
      continue
    }

    const [ firstIndex, ...duplicates ] = matching
    const existing = tokens[firstIndex]
    const keepsClassSpelling = existing.kind === 'class' && catalogKey?.type === 'boolean' && value === 'true'
    const keepsSameValue = existing.kind === 'keyValue' && catalogKey?.type !== 'class' && catalogKey?.type !== 'flag' && existing.value === value
    const newText = formatToken(updateKey, catalogKey, value, syntax, existing)
    if (keepsClassSpelling || keepsSameValue || newText === core.slice(existing.from, existing.to)) {
      actions.set(firstIndex, core.slice(existing.from, existing.to))
    } else {
      actions.set(firstIndex, newText)
    }
    for (const index of duplicates) {
      actions.set(index, null)
    }
  }

  const pieces: string[] = []
  tokens.forEach((token, index) => {
    const action = actions.get(index)
    if (action === null) {
      return
    }
    const tokenText = action ?? core.slice(token.from, token.to)
    if (pieces.length > 0) {
      const separator = index > 0 ? core.slice(tokens[index - 1].to, token.from) : ''
      pieces.push(separator !== '' ? separator : ' ')
    }
    pieces.push(tokenText)
  })
  for (const tokenText of appended) {
    if (pieces.length > 0) {
      pieces.push(' ')
    }
    pieces.push(tokenText)
  }

  const newCore = pieces.join('')
  const padding = syntax === 'directive' ? ' ' : ''
  const newText = core === '' && newCore !== ''
    ? (lead !== '' ? lead : padding) + newCore + (trail !== '' ? trail : padding)
    : lead + newCore + trail

  return { changed: newCore !== core, empty: newCore === '', text: newText, core: newCore }
}
