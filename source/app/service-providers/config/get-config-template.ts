/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        getConfigTemplate utility function
 * CVM-Role:        <none>
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Returns a functional template to be used by the config provider.
 *
 * END HEADER
 */

import { app, nativeTheme } from 'electron'
import path from 'path'
import * as bcp47 from 'bcp-47'
import { v4 as uuid4 } from 'uuid'
import getLanguageFile from '@common/util/get-language-file'
import type { EditorShortcutName } from 'source/common/modules/markdown-editor/keymaps/shortcuts'
import { type MenuShortcutName } from '../menu/shortcuts'
import { JEV_SEARCH_DEFAULT_MAX_CHUNK_CHARACTERS } from '@dts/common/jev-search'
import { defaultCodeEditingExceptions, type CodeEditingExceptions } from '@common/modules/markdown-editor/util/code-editing-policy'
import { defaultCopyVisibleTextCategories, type CopyVisibleTextCategories } from '@common/modules/markdown-editor/util/visible-copy-policy'
import { defaultCharacterPairSettings, type CharacterPairSettings } from '@common/modules/markdown-editor/util/character-pair-policy'

export type MarkdownTheme = 'berlin'|'frankfurt'|'bielefeld'|'karl-marx-stadt'|'bordeaux'

// This is a handy interface to add groups of file types to the settings in
// order to allow users to display them in filemanager and/or sidebar, and open
// internally or externally.
// NOTE: The generics are meant so that you can restrict certain groupings.
// E.g., FileTypeSettings<true, false, 'zettlr'> enforces these values for the
// three properties.
interface FileTypeSettings<F = boolean, S = boolean, O = 'zettlr'|'system'> {
  showInFilemanager: F
  showInSidebar: S
  openWith: O
}

// The following lines make a subset of all available editor/UI shortcuts
// configurable. This way, we do not have to specify *all* shortcuts, but only
// those that are actually configurable.
type Extends<T, U extends T> = U // Helper type to allow for autocomplete
export type ConfigurableEditorShortcuts = Extends<
  EditorShortcutName,
  'table-align'|'table-align-col-center'|'table-align-col-left'|
  'table-align-col-right'|'tr-zap-gremlins'|'tr-emdash-add-spaces'|
  'tr-double-quotes-to-single'|'tr-emdash-remove-spaces'|
  'tr-ensure-double-quotes'|'tr-italics-to-quotes'|'tr-quotes-to-italics'|
  'tr-quotes-to-magic'|'tr-remove-line-breaks'|'tr-sentence-case'|
  'tr-single-quotes-to-double'|'tr-straighten-quotes'|
  'tr-strip-duplicate-spaces'|'tr-title-case'
>
// Zettlr-LYH reopen closed tab (R43): adds reopen-closed-tab
export type ConfigurableUIShortcuts = Extends<MenuShortcutName, 'previous-tab'|'next-tab'|'filter-files'|'reopen-closed-tab'>

/**
 * This type describes an entry of the ignored rules array in the config. We
 * define this type here, and not in the LanguageTool command, because if we
 * change its structure, bad things could happen. By colocating it with the
 * config, it is harder for us to forget to write a migration rule if we ever
 * change this structure.
 */
export interface LanguageToolIgnoredRuleEntry {
  /**
   * The description of the rule (usually localized).
   */
  description: string
  /**
   * The unique ID of this rule.
   */
  id: string
  /**
   * The category for this rule.
   */
  category: string
}

export interface ConfigOptions {
  version: string
  markdownLineNumbersMigrated: boolean
  buildDate: string
  uuid: string
  appLang: string

  darkMode: boolean
  darkModeEditor: 'match'|'light'|'dark'
  autoDarkMode: 'off'|'system'|'schedule'
  autoDarkModeStart: string
  autoDarkModeEnd: string

  openDirectory: string|null
  attachmentExtensions: string[]
  muteLines: boolean
  // Zettlr-LYH (R128): whether the Formatted mode of TOML files shows table
  // sections as grids; one switch for all TOML files, windows and panes
  tomlShowTables: boolean

  // NOTE to everyone: These options (and possibly others) that pertain to the
  // file manager should slowly be migrated into the fileManager group below.
  fileManagerMode: 'thin'|'combined'|'expanded'
  fileManagerShowFiles: boolean
  fileManagerShowOnlyOpenTabs: boolean
  fileManagerShowWorkspaces: boolean
  fileMeta: boolean
  fileMetaTime: 'modtime'|'creationtime'
  sorting: 'natural'|'ascii'
  sortFoldersFirst: boolean
  fileNameDisplay: 'filename'|'title'|'heading'|'title+heading'

  // NOTE to everyone: The various filemanager options (see above) should over
  // time be migrated into this group.
  fileManager: {
    twoStepCollapseWorkspaces: boolean
    // If this is true, the config will never attempt to auto-sort workspaces.
    sortWorkspacesManually: boolean
  }

  newFileNamePattern: string
  newFileDontPrompt: boolean
  // Folder that receives the scratch notes created with Ctrl+N
  scratchNotesDirectory: string
  // Folder that receives the undo history on disk (R135); empty means the default
  undoHistoryDirectory: string
  // Semantic search over the active document with TypeSafe's Jev model
  jevSearch: {
    apiKey: string // Empty: fall back to the TYPESAFE_API_KEY environment variable
    maxChunkCharacters: number
  }
  selectedDicts: string[]

  debug: boolean
  checkForBeta: boolean

  app: {
    openFiles: string[]
    openWorkspaces: string[]
  }

  dialogPaths: {
    askFileDialog: string
    askDirDialog: string
    askLangFileDialog: string
  }
  export: {
    dir: 'temp'|'cwd'|'ask'
    stripTags: boolean
    autoOpenExportedFiles: boolean
    stripLinks: 'full'|'unlink'|'no'
    cslLibrary: string
    cslStyle: string
    useBundledPandoc: boolean
    exportQmdWithQuarto: boolean
    customCommands: Array<{ displayName: string, command: string }>
    selectedProfiles: Array<{ filePath: string, profile: string }>
    lastUsedProfile: string
    forceEnableExtensions: {
      mark: boolean
      alerts: boolean
    }
  }
  zkn: {
    idRE: string
    idGen: string
    linkAddFileTitle: boolean
    linkWithIDIfPossible: boolean
    linkFormat: 'link|title'|'title|link'
    autoSearch: boolean
    customDirectory: string
  }
  editor: {
    autocompleteSuggestEmojis: boolean
    snippetAutocompleteTriggerCharacter: ':'
    autocompleteWithEnter: boolean
    autocompleteWithTab: boolean
    autoSave: 'off'|'immediately'|'delayed'
    citeStyle: 'in-text'|'in-text-suffix'|'regular'
    autoCloseBrackets: boolean
    autoCloseCharacterPairs: CharacterPairSettings
    showLinkPreviews: boolean
    showStatusbar: boolean
    showFormattingToolbar: boolean
    /**
     * Zettlr-LYH (R84, spec C10): Whether edits in the Markdown editors are
     * recorded as tracked insertions and deletions; shared by all editors
     */
    trackChanges: boolean
    /**
     * Zettlr-LYH (R84, spec C10): The author name recorded with every tracked
     * change; empty until the user enters one
     */
    revisionAuthor: string
    showWhitespace: boolean
    showMarkdownLineNumbers: boolean
    defaultSaveImagePath: string
    enableTableHelper: boolean
    indentUnit: number
    indentWithTabs: boolean
    alwaysIndentLineOnTab: boolean
    fontSize: number
    lineNumberFontSize: number
    countChars: boolean
    inputMode: 'default'|'vim'|'emacs'
    boldFormatting: '**'|'__'
    italicFormatting: '_'|'*'
    highlightFormatting: 'span'|'=='
    readabilityAlgorithm: 'dale-chall'|'gunning-fog'|'coleman-liau'|'automated-readability'
    lint: {
      markdown: boolean
      languageTool: {
        active: boolean
        level: 'picky'|'default'
        motherTongue: string // e.g., en-US, de-DE
        variants: {
          en: string
          de: string
          pt: string
          ca: string
        }
        ignoredRules: LanguageToolIgnoredRuleEntry[]
        provider: 'official'|'custom'
        customServer: string
        username: string
        apiKey: string
      }
    }
    autoCorrect: {
      active: boolean
      magicQuotes: {
        primary: string
        secondary: string
      }
      replacements: Array<{ key: string, value: string }>
      matchWholeWords: boolean
    }
  }
  display: {
    theme: MarkdownTheme
    hideToolbarInDistractionFree: boolean
    markdownFileExtensions: boolean
    previewModeShowSyntaxWhenCursorIsAdjacent: boolean
    editCodeWhenClicked: boolean
    codeEditingExceptions: CodeEditingExceptions
    /**
     * Zettlr-LYH (R84, spec C10): Whether tracked changes are shown; when off,
     * the editors show the text as if all changes were accepted
     */
    showRevisions: boolean
    copyVisibleTextCategories: CopyVisibleTextCategories
    imageWidth: number
    imageHeight: number
    /**
     * Zettlr-LYH (R64): Indentation of rendered blockquotes on the left and on
     * the right, in em
     */
    blockquoteIndent: number
    /**
     * Zettlr-LYH (R64): Background color (`#rrggbb`) of rendered blockquotes in
     * light mode
     */
    blockquoteBackgroundLight: string
    /**
     * Zettlr-LYH (R64): Whether rendered blockquotes have no background in
     * light mode (the color is kept for when this is turned off again)
     */
    blockquoteBackgroundLightTransparent: boolean
    /**
     * Zettlr-LYH (R64): Background color (`#rrggbb`) of rendered blockquotes in
     * dark mode
     */
    blockquoteBackgroundDark: string
    /**
     * Zettlr-LYH (R64): Whether rendered blockquotes have no background in dark
     * mode (the color is kept for when this is turned off again)
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
    /**
     * Zettlr-LYH (R81): Left and right margin of the Markdown editors, in
     * pixels, while the editor area shows a single pane
     */
    editorMarginSingle: number
    /**
     * Zettlr-LYH (R81): Left and right margin of the Markdown editors, in
     * pixels, while the editor area is split into two or more panes
     */
    editorMarginSplit: number
    renderingMode: 'preview'|'raw'
    renderCitations: boolean
    renderIframes: boolean
    renderImages: boolean
    renderLinks: boolean
    renderMath: boolean
    renderTasks: boolean
    renderHTags: boolean
    renderEmphasis: boolean
    renderPandoc: boolean
    renderAdmonitions: boolean
    renderHorizontalRules: boolean
  }
  files: {
    // Built-in files cannot be shown in the sidebar, will always be shown in
    // the file manager, and will always be opened with Zettlr.
    builtin: FileTypeSettings<true, false, 'zettlr'>
    // Images and PDFs can be entirely hidden or shown everywhere, and opened
    // with the system default, or in Zettlr
    images: FileTypeSettings
    pdf: FileTypeSettings
    // These file types can be shown anywhere, but are not open-able by Zettlr.
    msoffice: FileTypeSettings<boolean, boolean, 'system'>
    openOffice: FileTypeSettings<boolean, boolean, 'system'>
    dataFiles: FileTypeSettings<boolean, boolean, 'system'>
    dotFiles: FileTypeSettings<boolean, boolean>
  }
  watchdog: {
    activatePolling: boolean
    stabilityThreshold: number
  }
  window: {
    nativeAppearance: boolean
    vibrancy: boolean
    sidebarVisible: boolean
    fileManagerVisible: boolean
    currentSidebarTab: 'toc'|'references'|'relatedFiles'|'attachments'
    tocMaxHeadingLevel: number
    tocWrapHeadings: boolean
    recentGlobalSearches: string[]
  }
  ui: {
    fileManagerSplitSize: [number, number]
    editorSidebarSplitSize: [number, number]
  }
  system: {
    deleteOnFail: boolean
    leaveAppRunning: boolean
    avoidNewTabs: boolean
    maxOpenTabs: number
    iframeWhitelist: string[]
    checkForUpdates: boolean
    zoomBehavior: 'gui'|'editor'
  }
  shortcuts: {
    editor: Record<ConfigurableEditorShortcuts, string>
    ui: Record<MenuShortcutName, string>
  }
  displayToolbarButtons: {
    showOpenPreferencesButton: boolean
    showNewFileButton: boolean
    showPreviousFileButton: boolean
    showNextFileButton: boolean
    showPandocDivSpanButton: boolean
    showMarkdownCommentButton: boolean
    showMarkdownLinkButton: boolean
    showMarkdownImageButton: boolean
    showMarkdownMakeTaskListButton: boolean
    showInsertTableButton: boolean
    showInsertFootnoteButton: boolean
    showDocumentInfoText: boolean
    showPomodoroButton: boolean
  }
}

export function getConfigTemplate (): ConfigOptions {
  // Before returning the settings object, we have to make sure we retrieve a
  // locale that is both installed as a translation AND more or less the user's
  // wish.
  let locale = app.getLocale()
  let locSchema = bcp47.parse(locale)
  if (locSchema.language === undefined) {
    // Fall back to en-US
    locale = 'en-US'
  } else {
    // Return the best match that the app can find (only the tag).
    locale = getLanguageFile(locale).tag
  }

  // Return the complete configuration object
  return {
    version: app.getVersion(), // Useful for migrating
    markdownLineNumbersMigrated: false,
    buildDate: __BUILD_DATE__,
    app: {
      openFiles: [],
      openWorkspaces: []
    },
    openDirectory: null, // Save last opened dir path here
    dialogPaths: {
      askFileDialog: '',
      askDirDialog: '',
      askLangFileDialog: ''
    },
    window: {
      // Only use native window appearance by default on macOS. If this value
      // is false, this means that Zettlr will display the menu bar and window
      // controls as defined in the HTML.
      nativeAppearance: process.platform === 'darwin', // Linux only
      vibrancy: false,
      // Store a few GUI related settings here as well
      fileManagerVisible: true,
      sidebarVisible: false,
      currentSidebarTab: 'toc',
      // Deepest heading level shown in the sidebar table of contents (1-6)
      tocMaxHeadingLevel: 6,
      tocWrapHeadings: true,
      recentGlobalSearches: []
    },
    ui: {
      fileManagerSplitSize: [ 20, 80 ],
      editorSidebarSplitSize: [ 80, 20 ]
    },
    // Visible attachment filetypes
    attachmentExtensions: [],
    // UI related options
    darkMode: nativeTheme.shouldUseDarkColors,
    darkModeEditor: 'match', // Possible values: 'match', 'light', 'dark'
    autoDarkMode: 'system', // Possible values: 'off', 'system', 'schedule', 'auto'
    autoDarkModeStart: '21:00', // Switch into dark mode at this time
    autoDarkModeEnd: '06:00', // Switch to light mode at this time
    fileMeta: true,
    fileMetaTime: 'modtime', // The time to be displayed in file meta
    sorting: 'natural', // Can be natural or based on ASCII values
    sortFoldersFirst: true, // should folders be shown first in combined fileview
    muteLines: true, // Should the editor mute lines in distraction free mode?
    tomlShowTables: false, // Zettlr-LYH (R128): Show table sections of TOML files as grids in the Formatted mode?
    fileManagerMode: 'combined', // thin = Preview or directories visible --- expanded = both visible --- combined = tree view displays also files
    fileManagerShowFiles: true, // Allow users to persistently collapse or uncollapse the files and workspaces sections.
    fileManagerShowWorkspaces: true,
    fileManagerShowOnlyOpenTabs: false, // Zettlr-LYH (R87): the Files section lists only the folders of this window's open tabs
    fileNameDisplay: 'filename', // Controls what info is displayed as filenames
    fileManager: {
      twoStepCollapseWorkspaces: false,
      sortWorkspacesManually: false // By default, let Zettlr sort workspaces
    },
    newFileNamePattern: '%id.md',
    newFileDontPrompt: false, // If true immediately creates files
    // Scratch notes created with Ctrl+N live here until they are saved; an
    // empty value falls back to this default folder at runtime.
    // (R135: Zettlr\__Unsaved inside the documents folder; written out here
    // rather than imported, since tests load this file with stand-ins for
    // each of its imports.)
    scratchNotesDirectory: path.join(app.getPath('documents'), 'Zettlr', '__Unsaved'),
    // Undo history folder (R135); empty means the folder Zettlr\__History
    // inside the documents folder.
    undoHistoryDirectory: '',
    jevSearch: {
      apiKey: '', // Empty: fall back to the TYPESAFE_API_KEY environment variable
      maxChunkCharacters: JEV_SEARCH_DEFAULT_MAX_CHUNK_CHARACTERS
    },
    export: {
      dir: 'temp', // Can either be "temp", "cwd" (current working directory) or "ask"
      stripTags: false, // Strip tags a.k.a. #tag
      autoOpenExportedFiles: true,
      stripLinks: 'full', // Strip internal links: "full" - remove completely, "unlink" - only remove brackets, "no" - don't alter
      cslLibrary: '', // Path to a CSL JSON library file
      cslStyle: '', // Path to a CSL Style file
      useBundledPandoc: true, // Whether to use the bundled Pandoc
      exportQmdWithQuarto: false, // Whether .qmd-files should be exported with Quarto
      customCommands: [], // Custom commands that the user can use to run arbitrary exports
      selectedProfiles: [], // Remembers the last chosen exporter per file for easy re-exporting
      lastUsedProfile: 'HTML.yaml', // Remembers the last chosen exporter for easy re-exporting
      forceEnableExtensions: {
        mark: true,
        alerts: true
      }
    },
    // Zettelkasten stuff (IDs, as well as link matchers)
    zkn: {
      idRE: '(\\d{14})',
      idGen: '%Y%M%D%h%m%s',
      linkAddFileTitle: true,
      linkWithIDIfPossible: false,
      linkFormat: 'link|title', // Determines what internal links ([[link|title]]) look like
      autoSearch: true, // Automatically start a search upon following a link?
      customDirectory: '' // If present, saves auto-created files here
    },
    // Editor related stuff
    editor: {
      autoSave: 'delayed',
      autocompleteSuggestEmojis: true,
      snippetAutocompleteTriggerCharacter: ':',
      autocompleteWithEnter: false,
      autocompleteWithTab: true,
      autoCloseBrackets: true,
      autoCloseCharacterPairs: { ...defaultCharacterPairSettings },
      showLinkPreviews: true, // Whether to fetch link previews in the editor
      showWhitespace: false,
      showMarkdownLineNumbers: true,
      defaultSaveImagePath: '',
      citeStyle: 'regular', // Determines how autocomplete will complete citations
      enableTableHelper: true, // Enable the table helper plugin
      indentUnit: 4, // The number of spaces to be added
      indentWithTabs: false,
      alwaysIndentLineOnTab: false, // Whether `Tab` always indents the current line
      fontSize: 18, // The editor's font size in pixels
      lineNumberFontSize: 0, // Zero follows the editor font size minus two pixels
      countChars: false, // Set to true to enable counting characters instead of words
      inputMode: 'default', // Can be default, vim, emacs
      boldFormatting: '**', // Can be ** or __
      italicFormatting: '_', // Can be * or _
      highlightFormatting: '==', // Can be 'span' or ==
      readabilityAlgorithm: 'dale-chall', // The algorithm to use with readability mode.
      showStatusbar: true,
      showFormattingToolbar: true,
      trackChanges: false, // Record edits as tracked changes (R84)
      revisionAuthor: '', // Author name of tracked changes, asked for when empty (R84)
      lint: {
        markdown: true, // Should Markdown be linted?
        languageTool: {
          active: false, // Utilize languageTool?
          level: 'default', // API: https://languagetool.org/http-api/#!/default/post_check
          motherTongue: '', // Optional motherTongue property
          variants: {
            // These defaults are taken from LT's extension
            en: 'en-US',
            de: 'de-DE',
            pt: 'pt-PT',
            ca: 'ca-ES'
          },
          // This is an (initially empty) array of rules the user chose to
          // ignore globally.
          ignoredRules: [],
          provider: 'official',
          customServer: '',
          username: '',
          apiKey: ''
        }
      },
      autoCorrect: {
        active: true, // AutoCorrect is on by default
        magicQuotes: {
          // Can be various quote pairs. The default characters (" and ')
          // will disable magic quotes.
          primary: '"…"',
          secondary: "'…'"
        },
        replacements: [
          // Arrows
          { key: '-->', value: '→' },
          { key: '–>', value: '→' }, // For Word mode arrows
          { key: '<--', value: '←' },
          { key: '<->', value: '↔' },
          { key: '<-->', value: '↔' },
          { key: '==>', value: '⇒' },
          { key: '<==', value: '⇐' },
          { key: '<=>', value: '⇔' },
          { key: '<==>', value: '⇔' },
          // Mathematical symbols
          { key: '!=', value: '≠' },
          { key: '<>', value: '≠' },
          { key: '+-', value: '±' },
          { key: ':time:', value: '×' },
          { key: ':division:', value: '÷' },
          { key: '<=', value: '≤' },
          { key: '>=', value: '≥' },
          { key: '1/2', value: '½' },
          { key: '1/3', value: '⅓' },
          { key: '2/3', value: '⅔' },
          { key: '1/4', value: '¼' },
          { key: '3/4', value: '¾' },
          { key: '1/8', value: '⅛' },
          { key: '3/8', value: '⅜' },
          { key: '5/8', value: '⅝' },
          { key: '7/8', value: '⅞' },
          // Units
          { key: 'mm2', value: 'mm²' },
          { key: 'cm2', value: 'cm²' },
          { key: 'm2', value: 'm²' },
          { key: 'km2', value: 'km²' },
          { key: 'mm3', value: 'mm³' },
          { key: 'cm3', value: 'cm³' },
          { key: 'ccm', value: 'cm³' },
          { key: 'm3', value: 'm³' },
          { key: 'km3', value: 'km³' },
          { key: ':sup2:', value: '²' },
          { key: ':sup3:', value: '³' },
          { key: ':deg:', value: '°' },
          // Currencies
          { key: ':eur', value: '€' },
          { key: ':gbp', value: '£' },
          { key: ':yen', value: '¥' },
          { key: ':cent', value: '¢' },
          { key: ':inr:', value: '₹' },
          // Special symbols
          { key: '(c)', value: '©' },
          { key: '(tm)', value: '™' },
          { key: '(r)', value: '®' },
          // Interpunctation
          { key: '...', value: '…' },
          { key: '--', value: '–' },
          { key: '---', value: '—' }
        ],
        matchWholeWords: false // Whether to only autocorrect entire words, not parts
      } // END autoCorrect options
    },
    display: {
      theme: 'berlin', // The theme, can be berlin|frankfurt|bielefeld|karl-marx-stadt|bordeaux
      hideToolbarInDistractionFree: false,
      markdownFileExtensions: false,
      previewModeShowSyntaxWhenCursorIsAdjacent: true,
      editCodeWhenClicked: false,
      codeEditingExceptions: { ...defaultCodeEditingExceptions },
      showRevisions: true, // Show tracked changes rather than the accepted text (R84)
      copyVisibleTextCategories: { ...defaultCopyVisibleTextCategories },
      imageWidth: 100, // Maximum preview image width
      imageHeight: 50, // Maximum preview image height
      blockquoteIndent: 2, // Left and right indentation of blockquotes in em
      blockquoteBackgroundLight: '#f3f3f3',
      blockquoteBackgroundLightTransparent: false,
      blockquoteBackgroundDark: '#2b2b2b',
      blockquoteBackgroundDarkTransparent: false,
      headingSize1: 2, // Size of level-1 headings relative to the body text
      headingBold1: true,
      headingSize2: 1.8, // Size of level-2 headings relative to the body text
      headingBold2: true,
      headingSize3: 1.5, // Size of level-3 headings relative to the body text
      headingBold3: true,
      headingSize4: 1.3, // Size of level-4 headings relative to the body text
      headingBold4: true,
      headingSize5: 1, // Size of level-5 headings relative to the body text
      headingBold5: true,
      headingSize6: 1, // Size of level-6 headings relative to the body text
      headingBold6: true,
      editorMarginSingle: 50, // Left and right margin of the editor text with a single pane, in px (R81)
      editorMarginSplit: 50, // Left and right margin of the editor text with split panes, in px (R81)
      renderingMode: 'preview',
      renderCitations: true,
      renderIframes: true,
      renderImages: true,
      renderLinks: true,
      renderMath: true,
      renderTasks: true,
      renderHTags: true,
      renderEmphasis: true,
      renderPandoc: true,
      renderAdmonitions: true,
      renderHorizontalRules: true
    },
    files: {
      builtin: { showInFilemanager: true, showInSidebar: false, openWith: 'zettlr' },
      images: { showInFilemanager: false, showInSidebar: true, openWith: 'system' },
      pdf: { showInFilemanager: false, showInSidebar: true, openWith: 'system' },
      msoffice: { showInFilemanager: false, showInSidebar: true, openWith: 'system' },
      openOffice: { showInFilemanager: false, showInSidebar: true, openWith: 'system' },
      dataFiles: { showInFilemanager: false, showInSidebar: true, openWith: 'system' },
      dotFiles: { showInFilemanager: false, showInSidebar: false, openWith: 'system' }
    },
    // Language
    selectedDicts: [], // By default no spell checking is active to speed up first start.
    appLang: locale,
    debug: false,
    watchdog: {
      activatePolling: false, // Set to true to enable polling in chokidar
      stabilityThreshold: 1000 // Positive int in milliseconds
    },
    system: {
      deleteOnFail: false, // Whether to delete files if trashing them fails
      leaveAppRunning: false, // Whether to leave app running in the notification area (tray)
      avoidNewTabs: false, // Whether to avoid opening new tabs for documents if possible
      maxOpenTabs: 0, // Maximum saved, unpinned tabs per window; zero is unlimited
      iframeWhitelist: [ 'www.youtube.com', 'player.vimeo.com' ], // Contains a list of whitelisted iFrame prerendering domains
      checkForUpdates: true,
      zoomBehavior: 'gui' // Used to determine what gets zoomed: The GUI or the editor
    },
    checkForBeta: false, // Should the user be notified of beta releases?
    displayToolbarButtons: {
      showOpenPreferencesButton: true,
      showNewFileButton: true,
      showPreviousFileButton: true,
      showNextFileButton: true,
      showPandocDivSpanButton: true,
      showMarkdownCommentButton: true,
      showMarkdownLinkButton: true,
      showMarkdownImageButton: true,
      showMarkdownMakeTaskListButton: true,
      showInsertTableButton: true,
      showInsertFootnoteButton: true,
      showDocumentInfoText: true,
      showPomodoroButton: true
    },
    shortcuts: {
      ui: {
        'next-tab': '',
        'previous-tab': '',
        'filter-files': '',
        'reopen-closed-tab': '' // Zettlr-LYH reopen closed tab (R43)
      },
      editor: {
        'table-align': '',
        'table-align-col-left': '',
        'table-align-col-center': '',
        'table-align-col-right': '',
        'tr-double-quotes-to-single': '',
        'tr-single-quotes-to-double': '',
        'tr-emdash-add-spaces': '',
        'tr-emdash-remove-spaces': '',
        'tr-ensure-double-quotes': '',
        'tr-italics-to-quotes': '',
        'tr-quotes-to-italics': '',
        'tr-quotes-to-magic': '',
        'tr-remove-line-breaks': '',
        'tr-sentence-case': '',
        'tr-straighten-quotes': '',
        'tr-strip-duplicate-spaces': '',
        'tr-title-case': '',
        'tr-zap-gremlins': ''
      }
    },
    uuid: uuid4() // The app's unique anonymous identifier
  }
}
