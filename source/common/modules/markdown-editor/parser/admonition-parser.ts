/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Admonition parser
 * CVM-Role:        BlockParser
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This inline parser detects admonitions adds corresponding
 *                  syntax nodes to the tree.
 *
 * END HEADER
 */

import type { BlockContext, BlockParser, Line } from '@lezer/markdown'
// Zettlr-LYH (R60): types for the PDF++ callout recognition at the end
import type { SyntaxNode } from '@lezer/common'
import type { Text } from '@codemirror/state'

const admonitionRE = /^>(?<ws>\s*)\[!(?<keyword>note|tip|important|warning|caution|)\](?:\s*|(?<title>(.+)))$/id
const admonitionStartRE = /^(>\s*)+/

export const validAdmonitionKeywords: string[] = [
  'note', 'tip', 'important', 'warning', 'caution'
] as const

/**
 * Helper function to determine the number of parent Admonitions
 */
function getNestingLevel (text: string): number {
  let depth = 0
  for (let idx = 0; idx < text.length; idx++) {
    if (text.charAt(idx) === '>') {
      depth++
    } else if (!/\s/.test(text.charAt(idx))) {
      break
    }
  }

  return depth
}

/**
 * This factory function returns block parsers that can parse composite blocks
 * based on the various admonition nodes that we have available. The reason we
 * have to resort to a factory function is that each BlockParser can only define
 * a single composite node, and we need different types of admonitions such that
 * the syntax highlighting theme can differentiate via colors and other styles
 * between the admonition nodes.
 *
 * @param   {AdmonitionNode}  admonitionType  The admonition type to produce
 *
 * @return  {BlockParser}                     The block parser
 */
export const admonitionParser: BlockParser = {
  name: 'admonition',
  before: 'Blockquote',
  parse: (ctx, line) => {
    // The line needs to be a valid admonition start
    if (!admonitionStartRE.test(line.text)) {
      return false
    }

    // Ensure that even in nested admonitions, we execute on only the relevant
    // bit. The parent's composite parser will have moved the base accordingly.
    const linetext = line.text.slice(line.pos)
    const match = admonitionRE.exec(linetext)

    // Valid lines have the pattern `> [!KEYWORD]`.
    if (!match?.indices?.groups) {
      return false
    }

    // Admonitions require a keyword and, optionally a title.
    if (match.groups?.keyword === undefined) {
      return false
    }

    if (!validAdmonitionKeywords.includes(match.groups.keyword.toLowerCase())) {
      return false // Wrong admonition type
    }

    // Start a composite block, similar to blockquotes. This enables the node to
    // contain other blocks as children. By setting `value` to the nesting
    // depth, we can track nesting level. This comes in handy in the node
    // `composite` method when we need to decide whether a block is closed by a
    // closing mark.
    ctx.startComposite('Admonition', line.pos, getNestingLevel(line.text))

    // Place the required initial elements to mark:
    //     >        [!     keyword     ]        optional title
    // QuoteMark CodeMark {keyword} CodeMark   AdmonitionTitle
    const linestart = ctx.lineStart + line.pos
    ctx.addElement(ctx.elt('QuoteMark', linestart, linestart + 1))

    const skippedSpace = ctx.lineStart + line.skipSpace(line.pos + 1)
    const [ kwStart, kwEnd ] = match.indices.groups.keyword
    // The admonition marker encompasses both the keyword and the two code
    // marks, because this way it can be styled in its entirety.
    ctx.addElement(ctx.elt('AdmonitionMark', skippedSpace, skippedSpace + 2))
    ctx.addElement(ctx.elt('AdmonitionKeyword', linestart + kwStart, linestart + kwEnd))
    ctx.addElement(ctx.elt('AdmonitionMark', linestart + kwEnd, linestart + kwEnd + 1))
    
    // We need to move the line position after parsing, so we track the offset
    // as we calculate markers. This is a line-relative position, not document-
    // relative.
    let lineBasePos = line.pos + kwEnd + 1

    if (match.groups?.title !== undefined) {
      const [ titleFrom, titleTo ] = match.indices.groups.title
      const skipped = line.skipSpace(titleFrom)
      ctx.addElement(ctx.elt('AdmonitionTitle', linestart + skipped, linestart + titleTo))
      lineBasePos = line.pos + titleTo
    }

    // Move the base position to avoid infinite loops
    line.moveBase(line.skipSpace(lineBasePos))

    return null // composite blocks require returning `null` on success
  },
}

// This function is used in the node [composite](https://github.com/lezer-parser/markdown?tab=readme-ov-file#user-content-nodespec.composite) method:
//
// If this is a composite block, this should hold a function that,
// at the start of a new line where that block is active, checks
// whether the composite block should continue (return value) and
// optionally adjusts the line's base position and registers nodes
// for any markers involved in the block's syntax.
export function admonitionComposite (ctx: BlockContext, line: Line, value: number): boolean {
  if (!admonitionStartRE.test(line.text)) {
    return false
  }

  if (getNestingLevel(line.text) < value) {
    return false // End this (nested) block.
  }

  // Insert this level(s) quote mark and forward the line's base.
  line.addMarker(ctx.elt('QuoteMark', ctx.lineStart + line.pos, ctx.lineStart + line.pos + 1))
  line.moveBase(line.skipSpace(line.pos + 1))
  return true
}

// Zettlr-LYH (R60): PDF++ callouts, i.e., quotes copied from a PDF by the
// Obsidian plugin PDF++ (and by Zettlr's PDF viewer) in the form
//
//     > [!PDF|yellow] [《File》P8](File.pdf#page=8&selection=135,0,152,33)
//     > > Quoted text
//
// are recognized by the renderers only, via parsePdfCallout below. They
// deliberately do not become Admonition nodes, and `pdf` is not added to
// validAdmonitionKeywords: the Markdown AST behind Copy as HTML, Export to
// HTML, printing and the statistics is built from this parser's syntax tree,
// so an Admonition node would change how these quotes are exported. They stay
// Blockquote nodes, and the link on the first line stays a regular Link node.

/**
 * Color of a PDF++ callout whose header names no color (PDF++'s default)
 */
export const PDF_CALLOUT_DEFAULT_COLOR = 'yellow'

// `[!PDF]` or `[!PDF|<color>]`, keyword in any case, followed by whitespace or
// the end of the line
const pdfCalloutMarkerRE = /^\[!pdf(?:\|(?<color>[^\]\n]*))?\](?=\s|$)/i

/**
 * A recognized PDF++ callout. All positions are document offsets.
 */
export interface PdfCallout {
  /**
   * Start of the Blockquote node
   */
  from: number
  /**
   * End of the Blockquote node
   */
  to: number
  /**
   * Start of the line on which the callout begins (the header line)
   */
  headerLineFrom: number
  /**
   * End of the header line
   */
  headerLineTo: number
  /**
   * Start of the `[!PDF|<color>]` marker
   */
  markerFrom: number
  /**
   * End of the `[!PDF|<color>]` marker
   */
  markerTo: number
  /**
   * End of the whitespace that follows the marker on the header line
   */
  markerSpaceTo: number
  /**
   * Lowercase color name; PDF_CALLOUT_DEFAULT_COLOR if the header names none.
   * Unknown names are kept as they are.
   */
  color: string
}

/**
 * Recognizes a PDF++ callout: a Blockquote node whose first line, right after
 * its quote mark, starts a paragraph with `[!PDF]` or `[!PDF|<color>]`.
 *
 * @param   {SyntaxNode}       node  Any syntax node
 * @param   {Text}             doc   The document the node belongs to
 *
 * @return  {PdfCallout|null}        The callout, or null if the node is none
 */
export function parsePdfCallout (node: SyntaxNode, doc: Text): PdfCallout|null {
  if (node.name !== 'Blockquote') {
    return null
  }

  const quoteMark = node.firstChild
  if (quoteMark === null || quoteMark.name !== 'QuoteMark') {
    return null
  }

  // The marker must open the paragraph that follows the quote mark on the
  // same line (this rules out, e.g., indented code inside the blockquote)
  const paragraph = quoteMark.nextSibling
  const headerLine = doc.lineAt(quoteMark.from)
  if (paragraph === null || paragraph.name !== 'Paragraph' || paragraph.from > headerLine.to) {
    return null
  }

  const headerText = doc.sliceString(paragraph.from, headerLine.to)
  const leadingSpace = /^[ \t]*/.exec(headerText)?.[0].length ?? 0
  const match = pdfCalloutMarkerRE.exec(headerText.slice(leadingSpace))
  if (match === null) {
    return null
  }

  const markerFrom = paragraph.from + leadingSpace
  const markerTo = markerFrom + match[0].length
  const trailingSpace = /^[ \t]*/.exec(doc.sliceString(markerTo, headerLine.to))?.[0].length ?? 0
  const color = (match.groups?.color ?? '').trim().toLowerCase()

  return {
    from: node.from,
    to: node.to,
    headerLineFrom: headerLine.from,
    headerLineTo: headerLine.to,
    markerFrom,
    markerTo,
    markerSpaceTo: markerTo + trailingSpace,
    color: color === '' ? PDF_CALLOUT_DEFAULT_COLOR : color
  }
}
