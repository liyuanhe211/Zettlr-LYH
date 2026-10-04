/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Pandoc PPTX preview document configuration
 * CVM-Role:        Utility
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Reads and writes the configuration block that a pandoc
 *                  slide document may carry at its very beginning, and which
 *                  holds the conversion inputs that are worth deciding per
 *                  document -- at the moment only the reference-doc, that is
 *                  the .potx template pandoc renders the deck against. The
 *                  block is an HTML comment, so pandoc passes over it as raw
 *                  HTML and nothing of it reaches the slides. Both the main
 *                  process (which reads the block to pick the template) and
 *                  the preview pane (which writes the block when the user
 *                  picks a template) use this module, so that the format can
 *                  never drift apart between the two.
 *
 * END HEADER
 */

/**
 * The word that marks the opening line of the configuration comment
 */
export const CONFIGURATION_MARKER = 'Pandoc_PPTX_Configuration'

/**
 * The key holding the .potx template pandoc renders against
 */
export const REFERENCE_DOC_KEY = 'reference-doc'

/**
 * The configuration a document carries. Every key is optional: a document
 * without a configuration block, or with a block that does not mention a key,
 * leaves that input at the application's default.
 */
export interface PptxPreviewDocumentConfiguration {
  /**
   * The .potx template, exactly as written in the document (may be relative;
   * resolving it against the document's directory is the caller's job)
   */
  referenceDoc?: string
}

/**
 * The outcome of reading a document: the configuration itself, plus where its
 * block sits in the text so that a writer can replace exactly that range.
 */
export interface ParsedPptxPreviewConfiguration {
  configuration: PptxPreviewDocumentConfiguration
  /**
   * Character range the configuration block occupies, or undefined when the
   * document carries no block at all
   */
  range?: { from: number, to: number }
  /**
   * The lines between the marker line and the closing `-->`, verbatim. Kept so
   * that rewriting one key cannot silently drop the others.
   */
  bodyLines: string[]
}

/**
 * A minimal edit, in the shape CodeMirror's ChangeSet.of() expects
 */
export interface ConfigurationEdit {
  from: number
  to: number
  insert: string
}

/**
 * Splits `key: value` off a configuration line. Returns undefined for a line
 * that carries no colon at all.
 */
function splitConfigurationLine (line: string): { key: string, value: string }|undefined {
  const colonIndex = line.indexOf(':')
  if (colonIndex < 0) {
    return undefined
  }
  return {
    key: line.slice(0, colonIndex).trim(),
    // NOTE: only the key side is trimmed on the left; a Windows path such as
    // `E:\...` keeps everything after the FIRST colon, which is why the value
    // is taken by index instead of by splitting on every colon.
    value: line.slice(colonIndex + 1).trim()
  }
}

/**
 * Reads the configuration block at the beginning of a pandoc slide document.
 *
 * The block is recognized only at the very start of the document (leading
 * whitespace is allowed), must open with `<!--` followed by the marker word,
 * and ends at the first `-->`. An unterminated comment, or a comment whose
 * first line does not carry the marker, counts as "no configuration".
 *
 * @param   {string}  markdown  The full document text
 *
 * @return  {ParsedPptxPreviewConfiguration}  What the document configures
 */
export function parsePptxPreviewConfiguration (markdown: string): ParsedPptxPreviewConfiguration {
  const empty: ParsedPptxPreviewConfiguration = { configuration: {}, bodyLines: [] }

  const leadingWhitespace = /^\s*/.exec(markdown)
  const from = leadingWhitespace === null ? 0 : leadingWhitespace[0].length
  if (!markdown.startsWith('<!--', from)) {
    return empty
  }

  const closingIndex = markdown.indexOf('-->', from)
  if (closingIndex < 0) {
    return empty // An unterminated comment is not a configuration block
  }

  const to = closingIndex + '-->'.length
  const inner = markdown.slice(from + '<!--'.length, closingIndex)
  const lines = inner.split('\n')
  if (lines.length === 0 || lines[0].trim() !== CONFIGURATION_MARKER) {
    return empty
  }

  // The last line holds whatever sits between the final newline and the `-->`,
  // which is indentation rather than a configuration line.
  const bodyLines = lines.slice(1)
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === '') {
    bodyLines.pop()
  }

  const configuration: PptxPreviewDocumentConfiguration = {}
  for (const line of bodyLines) {
    const entry = splitConfigurationLine(line)
    if (entry === undefined) {
      continue // Unreadable lines are ignored, not treated as an error
    }
    if (entry.key === REFERENCE_DOC_KEY && entry.value !== '') {
      configuration.referenceDoc = entry.value
    }
  }

  return { configuration, range: { from, to }, bodyLines }
}

/**
 * Renders a configuration block from its body lines
 */
function renderConfigurationBlock (bodyLines: string[]): string {
  return [ `<!-- ${CONFIGURATION_MARKER}`, ...bodyLines, '-->' ].join('\n')
}

/**
 * Produces the smallest edit that makes the document configure the given
 * template, leaving every other configuration line untouched.
 *
 * An empty path removes the reference-doc line again (and the whole block with
 * it, when nothing else is configured), which is how a document goes back to
 * the application's default template.
 *
 * @param   {string}  markdown          The full document text
 * @param   {string}  referenceDocPath  The template path to write, or '' to clear
 *
 * @return  {ConfigurationEdit|undefined}  The edit, or undefined if there is
 *                                         nothing to change
 */
export function writeReferenceDoc (markdown: string, referenceDocPath: string): ConfigurationEdit|undefined {
  const trimmedPath = referenceDocPath.trim()
  const parsed = parsePptxPreviewConfiguration(markdown)

  if (parsed.range === undefined) {
    if (trimmedPath === '') {
      return undefined // Nothing configured, nothing to clear
    }
    // No block yet: put one at the very beginning, followed by a blank line.
    return {
      from: 0,
      to: 0,
      insert: renderConfigurationBlock([ `${REFERENCE_DOC_KEY}: ${trimmedPath}` ]) + '\n\n'
    }
  }

  const otherLines = parsed.bodyLines.filter(line => {
    const entry = splitConfigurationLine(line)
    return entry === undefined || entry.key !== REFERENCE_DOC_KEY
  })

  if (trimmedPath === '') {
    if (otherLines.some(line => line.trim() !== '')) {
      const replacement = renderConfigurationBlock(otherLines)
      if (replacement === markdown.slice(parsed.range.from, parsed.range.to)) {
        return undefined
      }
      return { from: parsed.range.from, to: parsed.range.to, insert: replacement }
    }
    // The block would be left empty: drop it, and with it the blank line that
    // separated it from the document body.
    let to = parsed.range.to
    while (to < markdown.length && (markdown[to] === '\n' || markdown[to] === '\r')) {
      to++
    }
    return { from: parsed.range.from, to, insert: '' }
  }

  // Rewrite the existing reference-doc line where it stands, so that the order
  // of the user's configuration lines survives; only a document that has none
  // gets one appended.
  const newLine = `${REFERENCE_DOC_KEY}: ${trimmedPath}`
  let alreadyWritten = false
  const newBodyLines: string[] = []
  for (const line of parsed.bodyLines) {
    const entry = splitConfigurationLine(line)
    if (entry === undefined || entry.key !== REFERENCE_DOC_KEY) {
      newBodyLines.push(line)
      continue
    }
    if (!alreadyWritten) {
      newBodyLines.push(newLine)
      alreadyWritten = true
    }
  }
  if (!alreadyWritten) {
    newBodyLines.push(newLine)
  }

  const replacement = renderConfigurationBlock(newBodyLines)
  if (replacement === markdown.slice(parsed.range.from, parsed.range.to)) {
    return undefined
  }
  return { from: parsed.range.from, to: parsed.range.to, insert: replacement }
}
