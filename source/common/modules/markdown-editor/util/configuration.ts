/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Editor Configuration
 * CVM-Role:        Utility
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Since configuration for CodeMirror mainly works via
 *                  StateFields and StateEffects, in order to reduce the amount
 *                  of boiler plate, we define all configuration options as an
 *                  easily query-able object similarly to CM5 -- only now with
 *                  full type support.
 *
 * END HEADER
 */

import { StateEffect, StateField } from '@codemirror/state'
import safeAssign from '@common/util/safe-assign'
import { CITEPROC_MAIN_DB } from '@dts/common/citeproc'
import { type MarkdownTheme } from '@providers/config/get-config-template'
import { type CustomEditorShortcut } from '../keymaps/shortcuts'
import { defaultCodeEditingExceptions, type CodeEditingExceptions } from './code-editing-policy'
import { defaultCopyVisibleTextCategories, type CopyVisibleTextCategories } from './visible-copy-policy'
import { defaultCharacterPairSettings, normalizeCharacterPairSettings, type CharacterPairSettings } from './character-pair-policy'

export interface AutocorrectOptions {
  active: boolean
  matchWholeWords: boolean
  magicQuotes: { primary: string, secondary: string }
  replacements: Array<{ key: string, value: string }>
}

export interface EditorConfiguration {
  autocompleteSuggestEmojis: boolean
  snippetAutocompleteTriggerCharacter: ':'
  autocompleteWithEnter: boolean
  autocompleteWithTab: boolean
  autocorrect: AutocorrectOptions
  autoCloseBrackets: boolean
  autoCloseCharacterPairs: CharacterPairSettings
  renderingMode: 'preview'|'raw'
  previewModeShowSyntaxWhenCursorIsAdjacent: boolean
  editCodeWhenClicked: boolean
  codeEditingExceptions: CodeEditingExceptions
  copyVisibleTextCategories: CopyVisibleTextCategories
  renderCitations: boolean
  renderIframes: boolean
  renderImages: boolean
  renderLinks: boolean
  renderMath: boolean
  renderTasks: boolean
  renderHeadings: boolean
  renderTables: boolean
  renderEmphasis: boolean
  renderPandoc: boolean
  renderAdmonitions: boolean
  renderHorizontalRules: boolean
  imagePreviewWidth: number
  imagePreviewHeight: number
  /**
   * Zettlr-LYH (R64): Indentation of rendered blockquotes on both sides, in em
   */
  blockquoteIndent: number
  /**
   * Zettlr-LYH (R64): Background color (`#rrggbb`) of rendered blockquotes in
   * light mode
   */
  blockquoteBackgroundLight: string
  /**
   * Zettlr-LYH (R64): Whether rendered blockquotes have no background in light
   * mode
   */
  blockquoteBackgroundLightTransparent: boolean
  /**
   * Zettlr-LYH (R64): Background color (`#rrggbb`) of rendered blockquotes in
   * dark mode
   */
  blockquoteBackgroundDark: string
  /**
   * Zettlr-LYH (R64): Whether rendered blockquotes have no background in dark
   * mode
   */
  blockquoteBackgroundDarkTransparent: boolean
  /**
   * Zettlr-LYH: Size of level-1 headings relative to the body text
   */
  headingSize1: number
  /**
   * Zettlr-LYH: Whether level-1 headings are bold
   */
  headingBold1: boolean
  /**
   * Zettlr-LYH: Size of level-2 headings relative to the body text
   */
  headingSize2: number
  /**
   * Zettlr-LYH: Whether level-2 headings are bold
   */
  headingBold2: boolean
  /**
   * Zettlr-LYH: Size of level-3 headings relative to the body text
   */
  headingSize3: number
  /**
   * Zettlr-LYH: Whether level-3 headings are bold
   */
  headingBold3: boolean
  /**
   * Zettlr-LYH: Size of level-4 headings relative to the body text
   */
  headingSize4: number
  /**
   * Zettlr-LYH: Whether level-4 headings are bold
   */
  headingBold4: boolean
  /**
   * Zettlr-LYH: Size of level-5 headings relative to the body text
   */
  headingSize5: number
  /**
   * Zettlr-LYH: Whether level-5 headings are bold
   */
  headingBold5: boolean
  /**
   * Zettlr-LYH: Size of level-6 headings relative to the body text
   */
  headingSize6: number
  /**
   * Zettlr-LYH: Whether level-6 headings are bold
   */
  headingBold6: boolean
  idRE: string
  idGen: string
  indentUnit: number
  indentWithTabs: boolean
  alwaysIndentLineOnTab: boolean
  linkPreference: 'always'|'never'|'withID'
  zknLinkFormat: 'link|title'|'title|link'
  zknAddFileTitle: boolean
  linkWithIDIfPossible: boolean
  metadata: {
    path: string
    id: string
    library: string
  }
  boldFormatting: '**'|'__'
  italicFormatting: '*'|'_'
  highlightFormatting: 'span'|'=='
  citeStyle: 'in-text'|'in-text-suffix'|'regular'
  inputMode: 'default'|'vim'|'emacs'
  muteLines: boolean
  readabilityAlgorithm: 'dale-chall'|'gunning-fog'|'coleman-liau'|'automated-readability'
  readabilityMode: boolean
  typewriterMode: boolean
  distractionFree: boolean
  lintMarkdown: boolean
  lintLanguageTool: boolean
  showStatusbar: boolean
  showFormattingToolbar: boolean
  darkMode: boolean
  darkModeEditor: 'match'|'light'|'dark'
  theme: MarkdownTheme
  margins: 'S'|'M'|'L'
  highlightWhitespace: boolean
  showMarkdownLineNumbers: boolean
  countChars: boolean
  shortcuts: CustomEditorShortcut[]
  /**
   * Pandoc mode: the context menus get a Pandoc attribute section. Set by the
   * hosting component while the document's Pandoc PPTX preview is open.
   */
  pandocAttributeEditing: boolean
  /**
   * Zettlr-LYH (R84): Whether edits are recorded as tracked changes
   * (`editor.trackChanges`)
   */
  trackChanges: boolean
  /**
   * Zettlr-LYH (R84): Whether tracked changes are shown, rather than the text
   * with every change accepted (`display.showRevisions`)
   */
  showRevisions: boolean
  /**
   * Zettlr-LYH (R84): Author name written into new tracked changes
   * (`editor.revisionAuthor`)
   */
  revisionAuthor: string
}

export function getDefaultConfig (): EditorConfiguration {
  return {
    autocorrect: {
      active: true,
      matchWholeWords: false,
      magicQuotes: {
        primary: '"…"',
        secondary: "'…'"
      },
      replacements: []
    },
    autocompleteSuggestEmojis: false,
    snippetAutocompleteTriggerCharacter: ':',
    autocompleteWithEnter: false,
    autocompleteWithTab: true,
    autoCloseBrackets: true,
    autoCloseCharacterPairs: { ...defaultCharacterPairSettings },
    renderingMode: 'preview',
    previewModeShowSyntaxWhenCursorIsAdjacent: true,
    editCodeWhenClicked: false,
    codeEditingExceptions: { ...defaultCodeEditingExceptions },
    copyVisibleTextCategories: { ...defaultCopyVisibleTextCategories },
    renderCitations: true,
    renderIframes: true,
    renderImages: true,
    renderLinks: true,
    renderMath: true,
    renderTasks: true,
    renderHeadings: true,
    renderTables: true,
    renderEmphasis: true,
    renderPandoc: true,
    renderAdmonitions: true,
    renderHorizontalRules: true,
    imagePreviewWidth: 100,
    imagePreviewHeight: 100,
    blockquoteIndent: 2,
    blockquoteBackgroundLight: '#f3f3f3',
    blockquoteBackgroundLightTransparent: false,
    blockquoteBackgroundDark: '#2b2b2b',
    blockquoteBackgroundDarkTransparent: false,
    headingSize1: 2,
    headingBold1: true,
    headingSize2: 1.8,
    headingBold2: true,
    headingSize3: 1.5,
    headingBold3: true,
    headingSize4: 1.3,
    headingBold4: true,
    headingSize5: 1,
    headingBold5: true,
    headingSize6: 1,
    headingBold6: true,
    idRE: '(\\d{14})',
    idGen: '',
    indentUnit: 4,
    indentWithTabs: false,
    alwaysIndentLineOnTab: false,
    linkPreference: 'always',
    zknLinkFormat: 'link|title',
    linkWithIDIfPossible: false,
    zknAddFileTitle: true,
    metadata: {
      path: '',
      id: '',
      library: CITEPROC_MAIN_DB
    },
    boldFormatting: '**',
    italicFormatting: '_',
    highlightFormatting: '==',
    citeStyle: 'regular',
    muteLines: true,
    readabilityAlgorithm: 'dale-chall',
    inputMode: 'default',
    readabilityMode: false,
    typewriterMode: false,
    distractionFree: false,
    lintMarkdown: false,
    lintLanguageTool: false,
    showStatusbar: false,
    showFormattingToolbar: true,
    darkMode: false,
    darkModeEditor: 'match',
    theme: 'berlin',
    margins: 'M',
    highlightWhitespace: false,
    showMarkdownLineNumbers: false,
    countChars: false,
    shortcuts: [],
    pandocAttributeEditing: false,
    trackChanges: false,
    showRevisions: true,
    revisionAuthor: ''
  }
}

export type EditorConfigOptions = Partial<EditorConfiguration>

export const configUpdateEffect = StateEffect.define<EditorConfigOptions>()
export const configField = StateField.define<EditorConfiguration>({
  create (_state) {
    return getDefaultConfig()
  },
  update (val, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(configUpdateEffect)) {
        const newConfig = safeAssign(effect.value, val)
        newConfig.autoCloseCharacterPairs = normalizeCharacterPairSettings(newConfig.autoCloseCharacterPairs, newConfig.autoCloseBrackets)
        // Perform some housekeeping
        // Make sure the replacements are sorted longest-key-first
        newConfig.autocorrect.replacements.sort((a, b) => b.key.length - a.key.length)
        return newConfig
      }
    }
    return val
  }
})
