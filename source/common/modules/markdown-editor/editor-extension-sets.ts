/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Editor extension sets
 * CVM-Role:        Utility
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file contains several sets of extensions that can be
 *                  added to Codemirror 6 instances. These are bundled into
 *                  logical units as we need to access them frequently and
 *                  Zettlr does not have the need for the granular control over
 *                  extensions that Codemirror 6 offers.
 *
 * END HEADER
 */

import { characterPairClosingExtension } from './plugins/character-pair-closing'
import { mathDollarInputExtension } from './plugins/math-dollar-input'
import { normalizeCharacterPairSettings } from './util/character-pair-policy'
import { type Update } from '@codemirror/collab'
import { defaultKeymap, history } from '@codemirror/commands'
import { bracketMatching, codeFolding, foldGutter, foldKeymap, indentOnInput, indentUnit, StreamLanguage } from '@codemirror/language'
import { stex } from '@codemirror/legacy-modes/mode/stex'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { yaml } from '@codemirror/lang-yaml'
import { search, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, Prec, StateField, type Extension } from '@codemirror/state'
import {
  drawSelection,
  EditorView,
  keymap,
  lineNumbers,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  type ViewUpdate,
  type DOMEventHandlers
} from '@codemirror/view'
import { Decoration } from '@codemirror/view'
import { extractTOMLTableOfContents, type TOMLTableEntry } from '@common/util/toml-reading'
import { autocomplete } from './autocomplete'
import { codeSyntaxHighlighter, markdownSyntaxHighlighter } from './theme/syntax'
import markdownParser from './parser/markdown-parser'
import { defaultContextMenu } from './plugins/default-context-menu'
import { readabilityMode } from './plugins/readability'
import { hookDocumentAuthority } from './plugins/remote-doc'
import { lintGutter, linter, type Diagnostic } from '@codemirror/lint'
import { spellcheck } from './linters/spellcheck'
import { mdLint } from './linters/md-lint'
import { countField, countPlugin } from './plugins/statistics-fields'
import { tocField } from './plugins/toc-field'
import { typewriter } from './plugins/typewriter'
import { footnoteHover, filePreview, urlHover } from './tooltips'
import { type EditorConfiguration, configField } from './util/configuration'
import { highlightRanges } from './plugins/highlight-ranges'
import { markdownFolding } from './code-folding/markdown'
import { json, jsonParseLinter } from '@codemirror/lang-json'
import { softwrapVisualIndent } from './plugins/visual-indent'
import { backgroundLayers } from './plugins/code-background'
import { inlineCodeWrap } from './plugins/inline-code-wrap'
import { pathFolderButton } from './plugins/path-folder-button'
import { bracketContentHighlight } from './plugins/bracket-content-highlight'
import { emacs } from '@replit/codemirror-emacs'
import { distractionFree } from './plugins/distraction-free'
import { languageTool } from './linters/language-tool'
import { statusbar } from './statusbar'
import { renderers } from './renderers'
import { mdPasteDropHandlers } from './plugins/md-paste-drop-handlers'
import { footnoteGutter } from './plugins/footnote-gutter'
import { yamlFrontmatterLint } from './linters/yaml-frontmatter-lint'
import {
  mainThemes, darkMode, useDarkModeEditor,
  themeBerlinLight, themeBerlinDark,
  themeBielefeldLight, themeBielefeldDark,
  themeBordeauxLight, themeBordeauxDark,
  themeFrankfurtLight, themeFrankfurtDark,
  themeKarlMarxStadtLight, themeKarlMarxStadtDark
} from './theme'
import { highlightWhitespace } from './plugins/highlight-whitespace'
import { showLineNumbers } from './plugins/line-numbers'
import { tagClasses } from './plugins/tag-classes'
import { autocompleteTriggerCharacter } from './autocomplete/snippets'
import { vimPlugin } from './plugins/vim-mode'
import { projectInfoField } from './plugins/project-info-field'
import { preserveScrollAnchor } from './plugins/preserve-scroll-anchor'
import { offscreenEditScroll } from './plugins/offscreen-edit-scroll'
import { infiniteScroll } from './plugins/infinite-scroll'
import { freezeRevealDuringPointerSelection } from './util/reveal-selection'
import { balanceGutterWhitespace } from './plugins/balance-gutter-whitespace'
import { citationTooltips } from './tooltips/citations'
import { zettlrKeymap } from './keymaps'
import { pptxPreviewPins } from './plugins/pptx-preview-pins'
import { markdownSourceSelection } from './plugins/markdown-source-selection'
import { tomlBackgroundParse } from './plugins/toml-background-parse'
import { tomlShowTablesField, tomlShowTablesRegistration, tomlTableRender } from './plugins/toml-table-render'
import { markdownVisibleCopy } from './plugins/markdown-visible-copy'
import { trackChangesExtension } from './revisions/track-changes'
import { trackChangesFromConfiguration } from './renderers/render-revisions'
import { fenceCompletionExtension } from './autocomplete/code-blocks'
import { xmlTagsExtension } from './plugins/xml-tags'

/**
 * This interface describes the required properties which the extension sets
 * need to set up the proper extensions necessary for loading the specified
 * documents.
 */
export interface CoreExtensionOptions {
  initialConfig: EditorConfiguration
  remoteConfig: {
    filePath: string
    startVersion: number
    pullUpdates: (filePath: string, version: number) => Promise<Update[]|false>
    pushUpdates: (filePath: string, version: number, updates: Update[]) => Promise<boolean>
  }
  updateListener: (update: ViewUpdate) => void
  domEventsListeners: DOMEventHandlers<unknown>
}

/**
 * This compartment is being used to activate/disable the vim or emacs
 * keybindings dependent on the configuration.
 *
 * @var  {Compartment}
 */
export const inputModeCompartment = new Compartment()

export function getMainEditorThemes (): Record<EditorConfiguration['theme'], { lightThemes: Extension[], darkThemes: Extension[] }> {
  return {
    berlin: {
      lightThemes: [ mainThemes, themeBerlinLight ],
      darkThemes: [ mainThemes, themeBerlinDark ]
    },
    bielefeld: {
      lightThemes: [ mainThemes, themeBielefeldLight ],
      darkThemes: [ mainThemes, themeBielefeldDark ]
    },
    bordeaux: {
      lightThemes: [ mainThemes, themeBordeauxLight ],
      darkThemes: [ mainThemes, themeBordeauxDark ]
    },
    frankfurt: {
      lightThemes: [ mainThemes, themeFrankfurtLight ],
      darkThemes: [ mainThemes, themeFrankfurtDark ]
    },
    'karl-marx-stadt': {
      lightThemes: [ mainThemes, themeKarlMarxStadtLight ],
      darkThemes: [ mainThemes, themeKarlMarxStadtDark ]
    }
  }
}

/**
 * This private function loads a set of core extensions that are required for
 * all Codemirror instances inside of Zettlr regardless of document type. These
 * include:
 *
 * - Default keymaps
 * - An undo/redo history
 * - Code folding (only the service provider)
 * - A fold gutter
 * - A custom cursor drawing extension
 * - An extension enabling multiple extensions
 * - Search functionality
 * - Tab size and indentation with spaces or tabs
 * - line wrapping
 * - A configuration field (which has some options that only apply to Md or code)
 * - An update listener that is notified on every update
 * - The document authority functions to sync docs remotely
 *
 * @param   {CoreExtensionOptions}  options  The main extension options
 *
 * @return  {Extension[]}                    An array of core extensions
 */
function getCoreExtensions (options: CoreExtensionOptions): Extension[] {
  const inputMode: Extension[] = []
  if (options.initialConfig.inputMode === 'vim') {
    inputMode.push(vimPlugin())
  } else if (options.initialConfig.inputMode === 'emacs') {
    inputMode.push(emacs())
  }

  const themes = getMainEditorThemes()

  return [
    EditorView.cursorScrollMargin.of({ x: 50, y: 50 }), // Corresponds to the padding set to the MainEditor.vue for now
    // Both vim and emacs modes need to be included first, before any other
    // keymap.
    inputModeCompartment.of(inputMode),
    // Then, include the default keymap
    zettlrKeymap(options.initialConfig.shortcuts, options.initialConfig),
    darkMode({ darkMode: useDarkModeEditor(options.initialConfig.darkMode, options.initialConfig.darkModeEditor), ...themes[options.initialConfig.theme] }),
    // CODE FOLDING
    codeFolding(),
    Prec.low(foldGutter()), // The fold gutter should appear next to the text content
    // HISTORY
    // Zettlr-LYH undo history (R135): 10,000 groups (CodeMirror starts to trim
    // at the depth plus 20). The number equals UNDO_HISTORY_MAX_EVENTS of the
    // main process; the renderer must not import main process modules at
    // runtime, so the value is written out here.
    history({ minDepth: 10000 }),
    // SELECTIONS
    // Overrides the default browser selection drawing, allows styling
    drawSelection({ drawRangeCursor: false, cursorBlinkRate: 1200 }),
    highlightWhitespace(options.initialConfig.highlightWhitespace),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    // Column (rectangular) selection with Alt+drag, as known from Notepad++
    // and VS Code. Creates one cursor/selection per line so that all of them
    // can be edited simultaneously.
    rectangularSelection(),
    // While Alt is held down, show a crosshair cursor to indicate that
    // dragging will create a rectangular selection.
    crosshairCursor(),
    // Ensure the cursor never completely sticks to the top or bottom of the editor
    // EditorView.scrollMargins.of(_view => { return { top: 30, bottom: 30 } }),
    search({ top: true }), // Add a search
    // TAB SIZES/INDENTATION -> Depend on the configuration field
    EditorState.tabSize.from(configField, (val) => val.indentUnit),
    indentUnit.from(configField, (val) => val.indentWithTabs ? '\t' : ' '.repeat(val.indentUnit)),
    EditorView.lineWrapping, // Enable line wrapping,
    characterPairClosingExtension,

    // Allow configuration of the trigger character
    autocompleteTriggerCharacter.from(configField, val => val.snippetAutocompleteTriggerCharacter),

    // Add the statusbar
    statusbar,

    // Add the configuration and preset it with whatever is in the cached
    // config.
    configField.init(_state => ({
      ...JSON.parse(JSON.stringify(options.initialConfig)),
      autoCloseCharacterPairs: normalizeCharacterPairSettings(options.initialConfig.autoCloseCharacterPairs, options.initialConfig.autoCloseBrackets)
    })),

    // The updateListener is a custom extension we're using in order to be
    // able to emit events from this main class based on change events.
    EditorView.updateListener.of(options.updateListener),

    // Enables the editor to fetch updates to the document from main
    hookDocumentAuthority(
      options.remoteConfig.filePath,
      options.remoteConfig.startVersion,
      options.remoteConfig.pullUpdates,
      options.remoteConfig.pushUpdates
    ),
    // Keep the viewport visually stable when the display height changes
    // without the user scrolling (remote edits, widgets (re)rendering, ...)
    preserveScrollAnchor,
    // Bring the cursor's row to one third of the visible height when the user
    // modifies the document while the cursor is scrolled out of view
    offscreenEditScroll,
    // Keep rendered elements from switching to their source while the mouse
    // drags a selection across them
    freezeRevealDuringPointerSelection,
    highlightRanges
  ]
}

/**
 * This private function returns a set of extensions required for all code
 * editors (but not the Markdown editors). These include:
 *
 * - The core extensions
 * - Line numbers
 * - Close-brackets support
 * - Bracket matching (highlighting)
 * - Indent on input (for proper indentation where applicable)
 * - The code syntax highlighter
 *
 * @param   {CoreExtensionOptions}  options  The main extension options
 *
 * @return  {Extension[]}                    An array of generic code extensions
 */
function getGenericCodeExtensions (options: CoreExtensionOptions): Extension[] {
  return [
    ...getCoreExtensions(options),
    lineNumbers(),
    bracketMatching(),
    indentOnInput(),
    codeSyntaxHighlighter(),
  ]
}

/**
 * This public function returns a set of extensions required to run a default
 * Zettlr Markdown editor. These include:
 *
 * - The core extensions
 * - The autocompletion functionality
 * - A few extra keys (e.g. for copying as HTML)
 * - The Markdown parser and syntax highlighter
 * - Renderers for the partial WYSIWYG-highlights
 * - A set of extensions to the default syntax of the Codemirror plugin
 * - Document statistics that can be queried
 * - A typewriter mode
 * - A table of contents field
 * - Autocompletion support
 * - A readability mode
 * - The formatting toolbar
 * - Footnote previews on hover
 * - The paste handlers for image saving
 * - The default context menu with default Markdown formats
 * - A spellchecker
 *
 * @param   {CoreExtensionOptions}  options  The main config options
 *
 * @return  {Extension[]}                    An array of Markdown extensions
 */
export function getMarkdownExtensions (options: CoreExtensionOptions): Extension[] {
  // The following linters are always active: The spellcheck because that is
  // turned on and off with the dictionary settings, and the yamlFrontmatterNode
  // because if that thing has an error, that thing has an error.
  const mdLinterExtensions = [
    spellcheck,
    yamlFrontmatterLint
  ]

  let hasLinters = false

  if (options.initialConfig.lintMarkdown) {
    hasLinters = true
    mdLinterExtensions.push(mdLint)
  }

  if (options.initialConfig.lintLanguageTool) {
    hasLinters = true // We always add this linter
  }

  if (hasLinters) {
    // If there's any linter (except the spellchecker), add a lint gutter
    mdLinterExtensions.push(
      lintGutter({
        markerFilter (diagnostics) {
          // Show any linter warnings and errors in the gutter *except* wrongly
          // spelled words, since that would be weird.
          return diagnostics.filter(d => d.source !== 'spellcheck' && d.source?.startsWith('language-tool') === false)
        }
      })
    )
  }

  return [
    ...getCoreExtensions(options),
    // These handlers deal with Markdown specific stuff, for example, pasting
    // HTML should not add the verbatim HTML code, but rather convert it to
    // Markdown prior. Additionally, images should get preferential treatment.
    EditorView.domEventHandlers(mdPasteDropHandlers),
    // We need our custom keymaps first
    // The parser generates the AST for the document ...
    markdownParser({
      zknLinkParserConfig: { format: options.initialConfig.zknLinkFormat }
    }),
    markdownSourceSelection, markdownVisibleCopy,
    fenceCompletionExtension,
    xmlTagsExtension,
    // Zettlr-LYH (R175): "$" pairs, and "$" or "￥" wraps a selection as "$selection$"
    mathDollarInputExtension,
    // Zettlr-LYH (R84): Track Changes rewrites edits into tracked changes while
    // `editor.trackChanges` is on. Only the main editor loads it; the table
    // cell editors do not (spec C10).
    trackChangesExtension(),
    trackChangesFromConfiguration,
    // ... which can then be styled with a highlighter
    markdownSyntaxHighlighter(),
    bracketContentHighlight,
    renderers(options.initialConfig),
    showLineNumbers(options.initialConfig.showMarkdownLineNumbers),
    mdLinterExtensions,
    infiniteScroll,
    balanceGutterWhitespace, // Keeps the white space left and right of the text equally wide (R56)
    pptxPreviewPins, // Heading pins for the pandoc PPTX preview (hidden unless it is open)
    languageTool,
    // Some statistics we need for Markdown documents
    countPlugin,
    countField,
    typewriter,
    distractionFree,
    tocField,
    projectInfoField,
    markdownFolding, // Should be before footnoteGutter
    autocomplete,
    readabilityMode,
    footnoteHover,
    footnoteGutter, // Should be after markdownFolding
    urlHover,
    filePreview,
    citationTooltips,
    backgroundLayers, // Add a background behind inline code and code blocks
    inlineCodeWrap, // Wrap inline code at any character
    pathFolderButton, // Folder buttons after existing paths (R100, spec C12)
    defaultContextMenu, // A default context menu
    softwrapVisualIndent, // Always indent visually
    tagClasses(), // Apply a custom class to each tag so that users can style them (#4589)
    EditorView.domEventHandlers(options.domEventsListeners)
  ]
}

/**
 * This public function returns a set of extensions required to display LaTeX
 * documents in Zettlr editors. These include the core extensions, the generic
 * code extensions as well as the LaTeX syntax highlighter.
 *
 * @param   {CoreExtensionOptions}  options  The default options
 *
 * @return  {Extension[]}                    An array of options for LaTeX files
 */
export function getTexExtensions (options: CoreExtensionOptions): Extension[] {
  return [
    ...getGenericCodeExtensions(options),
    StreamLanguage.define(stex)
  ]
}

/**
 * This public function returns a set of extensions required to display YAML
 * documents in Zettlr editors. These include the core extensions, the generic
 * code extensions as well as the YAML syntax highlighter.
 *
 * @param   {CoreExtensionOptions}  options  The default options
 *
 * @return  {Extension[]}                    An array of options for YAML files
 */
export function getYAMLExtensions (options: CoreExtensionOptions): Extension[] {
  return [
    ...getGenericCodeExtensions(options),
    yaml()
  ]
}


/**
 * This public function returns a set of extensions required to display JSON
 * documents in Zettlr editors. These include the core extensions, the generic
 * code extensions as well as the JSON syntax highlighter.
 *
 * @param   {CoreExtensionOptions}  options  The default options
 *
 * @return  {Extension[]}                    An array of options for JSON files
 */
export function getJSONExtensions (options: CoreExtensionOptions): Extension[] {
  return [
    ...getGenericCodeExtensions(options),
    json(),
    linter(jsonParseLinter())
  ]
}

/**
 * Zettlr-LYH (R117, R124): the table headers of a TOML document with their
 * one-indexed source lines and offsets, recomputed whenever the document
 * changes. Both TOML view modes carry it: the MarkdownEditor publishes it as
 * the table of contents, and the Formatted mode emphasizes the header lines.
 */
export const tomlTableOfContentsField = StateField.define<TOMLTableEntry[]>({
  create: state => extractTOMLTableOfContents(state.doc.toString()),
  update: (entries, transaction) => transaction.docChanged ? extractTOMLTableOfContents(transaction.state.doc.toString()) : entries
})

/**
 * Zettlr-LYH (R124): holds the reading presentation of the TOML Formatted mode
 * and is empty in the Raw Text mode. Switching modes reconfigures only this
 * compartment, so the editor state with its document, selection, undo
 * history and unsaved changes stays as it is.
 *
 * @var  {Compartment}
 */
export const tomlPresentationCompartment = new Compartment()

/**
 * Zettlr-LYH (R124): a line decoration on every table header line, derived
 * from the table of contents field.
 */
const tomlTableHeadingDecorations = EditorView.decorations.compute([tomlTableOfContentsField], state => {
  const lineCount = state.doc.lines
  return Decoration.set(state.field(tomlTableOfContentsField)
    .filter(entry => entry.line >= 1 && entry.line <= lineCount)
    .map(entry => Decoration.line({ class: 'toml-table-heading' }).range(state.doc.line(entry.line).from)))
})

/**
 * Zettlr-LYH (R124): the reading presentation of the TOML Formatted mode. It
 * only decorates and never changes characters or line numbers: the text is
 * limited in width and centered, the line height is 1.7, and table header
 * lines get extra space, bold text and a background. Line wrapping comes
 * with the core extensions of both modes. The document stays editable.
 *
 * @return  {Extension[]}  The presentation, to be placed into the compartment
 */
export function formattedTOMLPresentation (): Extension[] {
  return [
    tomlTableHeadingDecorations,
    EditorView.theme({
      '.cm-content': { padding: '16px 24px', lineHeight: '1.7', maxWidth: '1000px', margin: '0 auto', flex: '1' },
      '.toml-table-heading': { paddingTop: '12px', paddingBottom: '6px', fontWeight: '700', backgroundColor: 'rgba(128, 128, 128, 0.12)', borderBottom: '1px solid currentColor' }
    }),
    // R128 (Show Tables): the grids of plugins/toml-table-render.ts (block
    // replacement widgets) only exist in the Formatted mode. Whether they are
    // shown is decided by the Show Tables state field of
    // getTOMLLanguageExtensions, which is not part of this compartment and so
    // keeps its value across mode switches.
    tomlTableRender
  ]
}

/**
 * Zettlr-LYH (R124): the TOML specific extensions of both view modes, without
 * the generic code extensions: the legacy TOML highlighter, the table of
 * contents field, and the presentation compartment, which starts with the
 * reading presentation if formatted is true and empty otherwise.
 *
 * @param   {boolean}      formatted  Whether to start in the Formatted mode
 *
 * @return  {Extension[]}             The TOML specific extensions
 */
export function getTOMLLanguageExtensions (formatted: boolean): Extension[] {
  return [
    StreamLanguage.define(toml),
    tomlTableOfContentsField,
    // R127: parses the document to its end in idle time, so that the
    // highlighting is already there after jumping far away. Both modes carry it.
    tomlBackgroundParse,
    // R128: the global Show Tables setting of this editor, and the registration
    // that hands later changes of it to this editor. Both modes carry them; the
    // grids themselves belong to the presentation of the Formatted mode.
    tomlShowTablesField,
    tomlShowTablesRegistration,
    tomlPresentationCompartment.of(formatted ? formattedTOMLPresentation() : [])
  ]
}

/**
 * This public function returns the extensions of the TOML Raw Text mode: the
 * generic code extensions, the TOML highlighter and the table of contents,
 * with an empty presentation compartment.
 *
 * @param   {CoreExtensionOptions}  options  The default options
 *
 * @return  {Extension[]}                    An array of options for TOML files
 */
export function getTOMLExtensions (options: CoreExtensionOptions): Extension[] {
  return [ ...getGenericCodeExtensions(options), ...getTOMLLanguageExtensions(false) ]
}

/**
 * Zettlr-LYH (R124): returns the extensions of the TOML Formatted mode, which
 * equal those of the Raw Text mode plus the reading presentation. The
 * document stays editable and is connected to the document authority, so
 * saving, undo, backups and conflict handling work as in the Raw Text mode.
 *
 * @param   {CoreExtensionOptions}  options  The default options
 *
 * @return  {Extension[]}                    An array of options for TOML files
 */
export function getFormattedTOMLExtensions (options: CoreExtensionOptions): Extension[] {
  return [ ...getGenericCodeExtensions(options), ...getTOMLLanguageExtensions(true) ]
}

/**
 * A linter for JSON Lines documents: Every non-empty line must be a JSON value
 * of its own. (The default JSON linter would flag everything after the first
 * line as an error.)
 *
 * @param   {EditorView}    view  The editor view
 *
 * @return  {Diagnostic[]}        One error diagnostic per malformed line
 */
function jsonLinesParseLinter (view: EditorView): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const doc = view.state.doc

  for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber++) {
    const line = doc.line(lineNumber)
    if (line.text.trim() === '') {
      continue
    }

    try {
      JSON.parse(line.text)
    } catch (error) {
      diagnostics.push({
        from: line.from,
        to: line.to,
        severity: 'error',
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  return diagnostics
}

/**
 * This public function returns a set of extensions required to display JSON
 * Lines documents in Zettlr editors. These include the generic code extensions,
 * the JSON syntax highlighter, and a linter that checks each line separately.
 *
 * @param   {CoreExtensionOptions}  options  The default options
 *
 * @return  {Extension[]}                    An array of options for JSON Lines files
 */
export function getJSONLExtensions (options: CoreExtensionOptions): Extension[] {
  return [
    ...getGenericCodeExtensions(options),
    json(),
    linter(jsonLinesParseLinter)
  ]
}

/**
 * This public function returns a set of extensions to display generated,
 * read-only Markdown, such as the formatted JSON viewer. The document is not
 * connected to the document authority, and all renderers that could modify the
 * document or that need the context of a Markdown file on disk (tables, tasks,
 * images, iframes, citations) are turned off.
 *
 * @param   {EditorConfiguration}           config          The editor configuration
 * @param   {(update: ViewUpdate) => void}  updateListener  Notified on every update
 *
 * @return  {Extension[]}                                   An array of extensions
 */
export function getReadOnlyMarkdownExtensions (config: EditorConfiguration, updateListener: (update: ViewUpdate) => void): Extension[] {
  const viewerConfig: EditorConfiguration = {
    ...structuredClone(config),
    renderingMode: 'preview',
    renderTables: false,
    renderTasks: false,
    renderImages: false,
    renderIframes: false,
    renderCitations: false
  }

  const themes = getMainEditorThemes()

  return [
    EditorState.readOnly.of(true),
    keymap.of([ ...defaultKeymap, ...searchKeymap, ...foldKeymap ]),
    darkMode({ darkMode: useDarkModeEditor(viewerConfig.darkMode, viewerConfig.darkModeEditor), ...themes[viewerConfig.theme] }),
    codeFolding(),
    Prec.low(foldGutter()),
    drawSelection({ drawRangeCursor: false, cursorBlinkRate: 1200 }),
    search({ top: true }),
    EditorView.lineWrapping,
    configField.init(_state => viewerConfig),
    EditorView.updateListener.of(updateListener),
    markdownParser({
      zknLinkParserConfig: { format: viewerConfig.zknLinkFormat }
    }),
    markdownSourceSelection, markdownVisibleCopy,
    markdownSyntaxHighlighter(),
    bracketContentHighlight,
    renderers(viewerConfig),
    tocField,
    markdownFolding,
    backgroundLayers,
    inlineCodeWrap,
    softwrapVisualIndent,
    preserveScrollAnchor,
    freezeRevealDuringPointerSelection
  ]
}
