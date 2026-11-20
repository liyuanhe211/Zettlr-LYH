/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        characterPairTabOutTargets, tabOutOfCharacterPair
 * CVM-Role:        CodeMirror Command
 * License:         GNU GPL v3
 *
 * Description:     Tab jumps over a closing character of an enabled character
 *                  pair. When every cursor sits directly in front of a closing
 *                  `)`, `]`, `}`, `'`, `"` or backtick, Tab moves each cursor
 *                  behind that character instead of indenting. The enabled
 *                  pairs are read from the `closeBrackets` language data, which
 *                  `plugins/character-pair-closing.ts` has already filtered by
 *                  the user's settings (and which keeps the language's own
 *                  range), so a disabled pair or a pair the current language
 *                  does not support never makes Tab jump. The command only
 *                  changes the selection: no document change, no undo event.
 *
 * END HEADER
 */

import { type CloseBracketConfig } from '@codemirror/autocomplete'
import { EditorSelection, type EditorState } from '@codemirror/state'
import { type EditorView } from '@codemirror/view'

/**
 * Closing brackets and the opening token that has to be enabled for them.
 */
const bracketOpeners = new Map<string, string>([
  [')', '('],
  [']', '['],
  ['}', '{']
])

/**
 * Closing characters that are the same character as their opening one. They
 * only count as closing if an odd number of the character precedes the cursor.
 */
const quoteCharacters = new Set<string>(["'", '"', '`'])

/**
 * Counts how often `character` appears in `text`, leaving out occurrences that
 * are escaped, i.e. that are preceded by an odd number of backslashes.
 *
 * @param   {string}  text       The text to search, normally the part of a line
 *                               in front of the cursor
 * @param   {string}  character  The single character to count
 *
 * @return  {number}             The number of unescaped occurrences
 */
function countUnescapedOccurrences (text: string, character: string): number {
  let occurrences = 0
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== character) {
      continue
    }

    let backslashes = 0
    while (index - backslashes - 1 >= 0 && text[index - backslashes - 1] === '\\') {
      backslashes++
    }

    if (backslashes % 2 === 0) {
      occurrences++
    }
  }

  return occurrences
}

/**
 * Returns the position behind the closing character that directly follows
 * `position`, or undefined if that character is not a closing character of an
 * enabled pair. Only the single character after the cursor is skipped; a
 * multi-character closing token such as a triple quote is skipped character by
 * character.
 *
 * @param   {EditorState}  state     The editor state
 * @param   {number}       position  The cursor position
 *
 * @return  {number|undefined}       The new cursor position, or undefined
 */
function positionBehindClosingCharacter (state: EditorState, position: number): number|undefined {
  const next = state.sliceDoc(position, position + 1)
  if (next === '') {
    return undefined
  }

  // The list is already filtered by the character pair settings and holds the
  // language's own tokens. If it is missing there is no enabled pair at all.
  const configuration: CloseBracketConfig|undefined = state.languageDataAt<CloseBracketConfig>('closeBrackets', position)[0]
  const enabledTokens = configuration?.brackets ?? []

  const opener = bracketOpeners.get(next)
  if (opener !== undefined) {
    return enabledTokens.includes(opener) ? position + 1 : undefined
  }

  if (!quoteCharacters.has(next) || !enabledTokens.includes(next)) {
    return undefined
  }

  const line = state.doc.lineAt(position)
  const textBefore = state.sliceDoc(line.from, position)
  return countUnescapedOccurrences(textBefore, next) % 2 === 1 ? position + 1 : undefined
}

/**
 * Computes where each cursor goes when Tab jumps out of a character pair. Pure
 * function; it neither reads the view nor dispatches anything.
 *
 * @param   {EditorState}  state  The editor state
 *
 * @return  {number[]|undefined}  The new cursor position for each selection
 *                                range, in selection order. Undefined if any
 *                                range is not an empty cursor or is not
 *                                directly in front of a closing character of
 *                                an enabled pair.
 */
export function characterPairTabOutTargets (state: EditorState): number[]|undefined {
  const targets: number[] = []
  for (const range of state.selection.ranges) {
    if (!range.empty) {
      return undefined
    }

    const target = positionBehindClosingCharacter(state, range.head)
    if (target === undefined) {
      return undefined
    }

    targets.push(target)
  }

  return targets
}

/**
 * Tab command: moves every cursor behind the closing character of an enabled
 * character pair if all cursors sit directly in front of one. Dispatches a
 * selection-only transaction, so the document and the undo history stay
 * untouched.
 *
 * @param   {EditorView}  view  The editor view
 *
 * @return  {boolean}           True if the cursors were moved. False if Tab is
 *                              left to the next command, which also holds
 *                              during IME composition.
 */
export function tabOutOfCharacterPair (view: EditorView): boolean {
  if (view.composing || view.compositionStarted) {
    return false
  }

  const targets = characterPairTabOutTargets(view.state)
  if (targets === undefined) {
    return false
  }

  view.dispatch({
    selection: EditorSelection.create(
      targets.map(target => EditorSelection.cursor(target)),
      view.state.selection.mainIndex
    ),
    scrollIntoView: true,
    userEvent: 'select'
  })
  return true
}
