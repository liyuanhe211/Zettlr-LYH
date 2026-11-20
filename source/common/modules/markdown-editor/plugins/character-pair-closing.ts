import { closeBrackets, type CloseBracketConfig } from '@codemirror/autocomplete'
import { EditorState, Prec, type Extension } from '@codemirror/state'
import { configField } from '../util/configuration'
import { filterCharacterPairTokens, normalizeCharacterPairSettings } from '../util/character-pair-policy'

const defaultTokens = ['(', '[', '{', "'", '"']

function originalCloseBracketConfiguration (state: EditorState, position: number, side: -1|0|1): CloseBracketConfig {
  // Query only the original providers, preserving their precedence and the
  // language's own nested-position lookup without recursively querying us.
  for (const provider of state.facet(EditorState.languageData)) {
    if (provider === characterPairLanguageData) {continue}
    for (const data of provider(state, position, side)) {
      if (Object.prototype.hasOwnProperty.call(data, 'closeBrackets')) {
        return data.closeBrackets ?? {}
      }
    }
  }
  return {}
}

function characterPairLanguageData (state: EditorState, position: number, side: -1|0|1): Array<{ closeBrackets: CloseBracketConfig }> {
  const original = originalCloseBracketConfiguration(state, position, side)
  const configuration = state.field(configField)
  const settings = normalizeCharacterPairSettings(configuration.autoCloseCharacterPairs, configuration.autoCloseBrackets)
  return [{
    closeBrackets: {
      ...original,
      brackets: filterCharacterPairTokens(original.brackets ?? defaultTokens, settings)
    }
  }]
}

// Keep the library's state field even when all pairs are disabled. Existing
// paired deletion and closing-character overtyping depend on that state.
export const characterPairClosingExtension: Extension = [
  closeBrackets(),
  Prec.highest(EditorState.languageData.of(characterPairLanguageData))
]
