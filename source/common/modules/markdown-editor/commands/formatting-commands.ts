/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Formatting commands of the formatting bar
 * CVM-Role:        Command
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH (R174): the table that maps the command
 *                  identifiers of the nine formatting buttons of the main
 *                  window (Bold, Italics, Underline, Highlight, Strikethrough,
 *                  Link, Image, Comment, Code) to the command functions that
 *                  carry them out on an editor view. The formatting bar sends
 *                  the identifiers through the same route as the buttons of
 *                  the main toolbar, and MarkdownEditor.runCommand looks them
 *                  up here. Every command leaves a view that does not contain
 *                  Markdown unchanged.
 *
 * END HEADER
 */

import type { EditorView } from '@codemirror/view'
import {
  applyBold,
  applyCode,
  applyComment,
  applyHighlight,
  applyItalic,
  applyPandocDivOrSpan,
  applyStrikethrough,
  insertImage,
  insertLink
} from './markdown'

/**
 * A command that acts on an editor view and reports whether it was applicable.
 */
export type FormattingCommand = (view: EditorView) => boolean

/**
 * The commands of the formatting bar by their identifier. All identifiers begin
 * with "markdown", which is what the main window needs in order to forward a
 * button click to the last focused editor.
 */
export const FORMATTING_COMMANDS: ReadonlyMap<string, FormattingCommand> = new Map<string, FormattingCommand>([
  [ 'markdownBold', applyBold ],
  [ 'markdownItalic', applyItalic ],
  // Underline is a Pandoc span with the class "underline"
  [ 'markdownUnderline', (view: EditorView) => applyPandocDivOrSpan(view, 'span', { classes: ['underline'] }) ],
  [ 'markdownHighlight', applyHighlight ],
  [ 'markdownStrikethrough', applyStrikethrough ],
  [ 'markdownLink', insertLink ],
  [ 'markdownImage', insertImage ],
  [ 'markdownComment', applyComment ],
  [ 'markdownCode', applyCode ]
])
