/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Routing between the JSON outline and the conversation view
 * CVM-Role:        Utility function
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Decides from the content alone whether JSONViewer.vue shows
 *                  a file as a conversation history (raw Claude session or
 *                  Compact-LYH transcript) or as the regular JSON outline, and
 *                  derives the notice, table of contents and reading position
 *                  key of the conversation view (Zettlr-LYH R79, contract C8
 *                  section 8). The functions are pure so that the routing can
 *                  be tested in mocha.
 *
 * END HEADER
 */

import type { ConversationHistory } from '@dts/common/conversation-history'
import type { ToCEntry } from '@common/modules/markdown-editor/plugins/toc-field'
import { conversationTableOfContents, parseConversationHistory } from '@common/util/conversation-history'

export type JSONViewerRoute =
  | { mode: 'conversation', history: ConversationHistory }
  | { mode: 'outline' }

/**
 * Decides how the JSON viewer shows a piece of content. Only the content is
 * looked at, never the file name or extension; content that is not a
 * recognised conversation history (including content that fails to parse)
 * keeps the outline view.
 *
 * @param   {string}          content  The raw file content
 *
 * @return  {JSONViewerRoute}          The view to use
 */
export function routeJSONViewerContent (content: string): JSONViewerRoute {
  const history = parseConversationHistory(content)
  return history === null ? { mode: 'outline' } : { mode: 'conversation', history }
}

/**
 * The notice shown above the conversation view, or an empty string when every
 * line could be parsed.
 *
 * @param   {ConversationHistory}  history  The parsed history
 *
 * @return  {string}                        The notice text
 */
export function conversationNotice (history: ConversationHistory): string {
  const count = history.warnings.length
  if (count === 0) {
    return ''
  }

  const firstLine = Math.min(...history.warnings.map(warning => warning.line))
  const lineCount = count === 1 ? '1 line' : `${count} lines`
  const pronoun = count === 1 ? 'it is' : 'they are'
  return `${lineCount} could not be parsed (the first at line ${firstLine}); ${pronoun} shown in place.`
}

/**
 * The sidebar renders ToC text as Markdown, so message text is escaped to
 * show literally: no images (network requests), links or HTML from the file.
 *
 * @param   {string}  text  The first line of a user message
 *
 * @return  {string}        Markdown that renders as exactly that text
 */
function escapeTocText (text: string): string {
  return text
    .replace(/[\\`*_{}[\]()#+\-.!|~]/g, '\\$&')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * The table of contents of the conversation view: one entry per user message,
 * pointing at the message's first line in the raw file.
 *
 * @param   {ConversationHistory}  history  The parsed history
 *
 * @return  {ToCEntry[]}                    The sidebar entries
 */
export function conversationTocEntries (history: ConversationHistory): ToCEntry[] {
  return conversationTableOfContents(history).map((item, index) => {
    return {
      line: item.line,
      pos: 0,
      text: escapeTocText(item.text),
      level: 1,
      renderedLevel: String(index + 1),
      id: item.nodeId
    }
  })
}

/**
 * The key under which the reading position of the conversation view is kept,
 * separate from the outline view's key (the plain file path).
 *
 * @param   {string}  filePath  The file path
 *
 * @return  {string}            The key
 */
export function conversationReadingPositionKey (filePath: string): string {
  return `conversation:${filePath}`
}
