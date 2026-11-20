/** Character pairs offered by the languages already installed in the editor. */
export const characterPairLabels = Object.freeze({
  parentheses: 'Parentheses ( )',
  squareBrackets: 'Square brackets [ ]',
  braces: 'Braces { }',
  singleQuotes: "Single quotes ' '",
  doubleQuotes: 'Double quotes " "',
  backticks: 'Backticks ` `',
  // Not a closeBrackets token: it controls the closing fence added on Enter
  // after three or more backticks or tildes (see autocomplete/code-blocks.ts).
  codeFences: 'Code fences ``` ```'
})

export type CharacterPair = keyof typeof characterPairLabels
export type CharacterPairSettings = Record<CharacterPair, boolean>

export const defaultCharacterPairSettings: CharacterPairSettings = Object.freeze(
  Object.fromEntries(Object.keys(characterPairLabels).map(pair => [pair, true])) as CharacterPairSettings
)

/** Tolerant migration of stored data; never retain unknown or inherited keys. */
export function normalizeCharacterPairSettings (value: unknown, legacyEnabled?: unknown): CharacterPairSettings {
  const settings = { ...defaultCharacterPairSettings }
  for (const pair of Object.keys(characterPairLabels) as CharacterPair[]) {
    settings[pair] = legacyEnabled !== false
    if (value !== null && typeof value === 'object' && !Array.isArray(value) &&
      Object.prototype.hasOwnProperty.call(value, pair)) {
      const enabled = (value as Record<string, unknown>)[pair]
      if (typeof enabled === 'boolean') {
        settings[pair] = enabled
      }
    }
  }
  return settings
}

/** Strict write validation, deliberately separate from tolerant migration. */
export function isCharacterPairSettingsUpdate (value: unknown): value is Partial<CharacterPairSettings> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    return false
  }
  return Reflect.ownKeys(value).every(pair => {
    const descriptor = Object.getOwnPropertyDescriptor(value, pair)
    return typeof pair === 'string' && Object.prototype.hasOwnProperty.call(characterPairLabels, pair) &&
      descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'boolean'
  })
}

export function filterCharacterPairTokens (tokens: readonly string[], settings: CharacterPairSettings): string[] {
  const pairs: Record<string, CharacterPair> = {
    '(': 'parentheses',
    '[': 'squareBrackets',
    '{': 'braces',
    "'": 'singleQuotes',
    '"': 'doubleQuotes',
    '`': 'backticks',
    "'''": 'singleQuotes',
    '"""': 'doubleQuotes'
  }
  return tokens.filter(token => !Object.prototype.hasOwnProperty.call(pairs, token) || settings[pairs[token]])
}
