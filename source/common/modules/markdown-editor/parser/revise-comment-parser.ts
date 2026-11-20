/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Revise Comment Parser
 * CVM-Role:        InlineParser
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Keeps Revise Comments ("[text{comment}]") out of the
 *                  reference link syntax. Without this parser, two adjacent
 *                  comments "[A{}][B{}]" form one reference link whose label
 *                  "[B{}]" gets hidden. A bracket ending in a brace group that
 *                  is not followed by "(" (inline link) or "{" (Pandoc span)
 *                  stays plain text, and so does a bracket whose would-be
 *                  reference label is such a comment.
 *
 * END HEADER
 */

import type { DelimiterType, InlineParser } from '@lezer/markdown'

const ReviseCommentDelimiter: DelimiterType = {}

/**
 * Bracket content ending in an unescaped brace group, e.g. "text{comment}"
 */
const commentContentRe = /(?:^|[^\\])\{[^{}]*\}$/

/**
 * A following bracket that is itself a Revise Comment, e.g. "[B{comment}]"
 */
const followingCommentRe = /^\[(?:[^[\]\\]|\\.)*\{[^{}]*\}\]/

export const reviseCommentParser: InlineParser = {
  name: 'revise-comment',
  before: 'Link',
  parse (ctx, next, pos) {
    if (next === 91) { // 91 === '['
      ctx.addDelimiter(ReviseCommentDelimiter, pos, pos + 1, true, false)
      // Return -1 so that the link parser can add its own delimiter
      return -1
    }

    if (next !== 93) { // 93 === ']'
      return -1
    }

    const following = ctx.char(pos + 1)
    if (following === 40 || following === 123) { // 40 === '(', 123 === '{'
      return -1
    }

    const opening = ctx.findOpeningDelimiter(ReviseCommentDelimiter)
    if (opening === null) {
      return -1
    }

    const delimiter = ctx.getDelimiterAt(opening)
    if (delimiter === null) {
      return -1
    }

    const isComment = commentContentRe.test(ctx.slice(delimiter.to, pos))
    const isFollowedByComment = following === 91 && followingCommentRe.test(ctx.slice(pos + 1, ctx.end))
    if (!isComment && !isFollowedByComment) {
      return -1
    }

    // Taking the content drops the link start delimiter of this bracket, so
    // the bracket stays plain text; the parsed children are kept as they are.
    for (const child of ctx.takeContent(opening)) {
      ctx.addElement(child)
    }

    return pos + 1
  }
}
