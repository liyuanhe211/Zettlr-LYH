/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Code Block Autocomplete
 * CVM-Role:        Autocomplete Plugin
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This plugin manages code blocks.
 *
 * END HEADER
 */

import { pickedCompletion, type Completion } from '@codemirror/autocomplete'
import { Prec, type EditorState, type Extension } from '@codemirror/state'
import { keymap, type EditorView } from '@codemirror/view'
import { trans } from '@common/i18n-renderer'
import { type AutocompletePlugin } from '.'
import { createCodeFenceTransaction, findCodeFenceOpening } from '../util/code-fence'
import { normalizeCharacterPairSettings } from '../util/character-pair-policy'
import { configField } from '../util/configuration'

/**
 * Whether the "Code fences" character pair choice is on. An editor without a
 * configuration field keeps the original behavior, which is to complete fences.
 */
function isFenceCompletionEnabled (state: EditorState): boolean {
  const configuration = state.field(configField, false)
  if (configuration === undefined) {
    return true
  }
  return normalizeCharacterPairSettings(configuration.autoCloseCharacterPairs, configuration.autoCloseBrackets).codeFences
}

/**
 * Apply an explicitly chosen info string through the same fence pairing rules
 * as Enter, preserving the delimiter length and any existing closing fence.
 * When the Code fences choice is off, only the info string is rewritten.
 *
 * @param   {string}      infoString  The infostring to use
 */
function generate (infoString: string): (view: EditorView, completion: Completion, from: number, to: number) => void {
  return (view, completion, from, to) => {
    if (view.state.readOnly || view.composing || view.compositionStarted || view.state.selection.ranges.length !== 1 || !view.state.selection.main.empty) {
      return
    }
    const opening = findCodeFenceOpening(view.state, view.state.selection.main.head)
    if (opening === undefined || to !== opening.lineTo || from < opening.lineFrom + opening.infoFrom) {
      return
    }
    const transaction = createCodeFenceTransaction(opening, infoString, isFenceCompletionEnabled(view.state))
    view.dispatch(transaction, { annotations: pickedCompletion.of(completion) })
  }
}

/** Run before generic Enter/acceptCompletion, without choosing a suggested language. */
export const fenceCompletionExtension: Extension = Prec.highest(keymap.of([
  {
    key: 'Enter',
    run (view) {
      const { state } = view
      if (state.readOnly || view.composing || view.compositionStarted || state.selection.ranges.length !== 1 || !state.selection.main.empty) {
        return false
      }
      // With the Code fences choice off, the generic Enter commands take over.
      if (!isFenceCompletionEnabled(state)) {
        return false
      }
      const opening = findCodeFenceOpening(state, state.selection.main.head)
      if (opening === undefined) {
        return false
      }
      view.dispatch(createCodeFenceTransaction(opening))
      return true
    }
  }
]))

function getEntries (): Completion[] {
  return [
    { apply: generate(''), label: trans('No highlighting') },
    { apply: generate('bash'), label: 'Bash' },
    { apply: generate('c'), label: 'C' },
    { apply: generate('clisp'), label: 'Common Lisp' },
    { apply: generate('clojure'), label: 'Clojure' },
    { apply: generate('cpp'), label: 'C++' },
    { apply: generate('csharp'), label: 'C#' },
    { apply: generate('css'), label: 'CSS' },
    { apply: generate('dart'), label: 'Dart' },
    { apply: generate('diff'), label: 'Diff' },
    { apply: generate('docker'), label: 'Dockerfile' },
    { apply: generate('elixir'), label: 'Elixir' },
    { apply: generate('elm'), label: 'Elm' },
    { apply: generate('fortran'), label: 'Fortran' },
    { apply: generate('fsharp'), label: 'F#' },
    { apply: generate('go'), label: 'Go' },
    { apply: generate('haskell'), label: 'Haskell' },
    { apply: generate('hcl'), label: 'HCL' },
    { apply: generate('html'), label: 'HTML' },
    { apply: generate('java'), label: 'Java' },
    { apply: generate('javascript'), label: 'JavaScript/Node.JS' },
    { apply: generate('json'), label: 'JSON' },
    { apply: generate('julia'), label: 'Julia' },
    { apply: generate('kotlin'), label: 'Kotlin' },
    { apply: generate('less'), label: 'LESS' },
    { apply: generate('lua'), label: 'Lua' },
    { apply: generate('markdown'), label: 'Markdown' },
    { apply: generate('math'), label: 'MathTeX' },
    { apply: generate('mermaid'), label: 'Mermaid' },
    { apply: generate('nix'), label: 'Nix' },
    { apply: generate('objectivec'), label: 'Objective-C' },
    { apply: generate('pascal'), label: 'Pascal' },
    { apply: generate('perl'), label: 'Perl' },
    { apply: generate('php'), label: 'PHP' },
    { apply: generate('powershell'), label: 'Powershell' },
    { apply: generate('python'), label: 'Python' },
    { apply: generate('r'), label: 'R' },
    { apply: generate('ruby'), label: 'Ruby' },
    { apply: generate('rust'), label: 'Rust' },
    { apply: generate('scala'), label: 'Scala' },
    { apply: generate('scheme'), label: 'Scheme' },
    { apply: generate('scss'), label: 'SCSS' },
    { apply: generate('smalltalk'), label: 'Smalltalk' },
    { apply: generate('sparql'), label: 'SparQL' },
    { apply: generate('sql'), label: 'SQL' },
    { apply: generate('swift'), label: 'Swift' },
    { apply: generate('systemverilog'), label: 'SystemVerilog' },
    { apply: generate('tcl'), label: 'TCL' },
    { apply: generate('terraform'), label: 'Terraform' },
    { apply: generate('tex'), label: 'TeX' },
    { apply: generate('toml'), label: 'TOML/INI' },
    { apply: generate('turtle'), label: 'Turtle' },
    { apply: generate('typescript'), label: 'TypeScript' },
    { apply: generate('verilog'), label: 'Verilog' },
    { apply: generate('vhdl'), label: 'VHDL' },
    { apply: generate('visualbasic'), label: 'Visual Basic' },
    { apply: generate('xml'), label: 'XML' },
    { apply: generate('yaml'), label: 'YAML' }
  ]
}

export const codeBlocks: AutocompletePlugin = {
  applies (ctx) {
    if (ctx.state.selection.ranges.length !== 1 || !ctx.state.selection.main.empty) {
      return false
    }
    const opening = findCodeFenceOpening(ctx.state, ctx.pos)
    if (opening === undefined) {
      return false
    }
    return opening.lineFrom + opening.infoFrom + (opening.infoString.startsWith('{') ? 1 : 0)
  },
  entries (ctx, query) {
    query = query.toLowerCase()
    return getEntries().filter(entry => {
      return entry.label.toLowerCase().includes(query)
    })
  }
}
