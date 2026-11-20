<template>
  <div
    ref="mainEditorWrapper"
    class="main-editor-wrapper"
    role="region"
    v-bind:aria-label="`Markdown Editor: Currently editing file ${pathBasename(props.file.path)}`"
    v-bind:style="{
      'font-size': `${fontSize}px`,
      '--editor-base-font-size': `${fontSize}px`,
      '--zettlr-line-number-font-size': `${lineNumberFontSize}px`,
      '--zettlr-editor-margin': `${editorMargin}px`
    }"
    v-bind:class="{
      'code-file': !isMarkdown,
      fullscreen: distractionFree,
      'has-recovery-notice': recoverableSessions.length > 0
    }"
    v-on:wheel="handleZoomWheel"
  >
    <!-- Zettlr-LYH data loss prevention (R173): input that never reached this document; one session at a time -->
    <RecoveryNotice
      v-if="recoverableSessions.length > 0"
      v-bind:key="recoverableSessions[0].sessionId"
      v-bind:last-step-at="recoverableSessions[0].lastStepAt"
      v-bind:busy="recoveryActionRunning"
      v-bind:error-message="recoveryActionError"
      v-on:restore="settleRecoverableSession('restore')"
      v-on:keep-as-file="settleRecoverableSession('keep-as-file')"
      v-on:discard="settleRecoverableSession('discard')"
    ></RecoveryNotice>
    <div v-bind:id="`cm-text-${props.leafId}`">
      <!-- This element will be replaced with Codemirror's wrapper element on mount -->
    </div>
    <!-- Persistent Pandoc attribute panel (R21/R22); teleported to the body element -->
    <PopoverPandocAttributes
      v-if="showsPandocPanel && pandocPanel !== null && pandocPanelAnchor !== null"
      v-bind:anchor="pandocPanelAnchor"
      v-bind:targets="pandocPanel.targets"
      v-bind:focus-kind="pandocPanel.focusKind"
      v-on:close="windowStateStore.pandocAttributesPanelOpen = false"
      v-on:apply="applyPandocAttributes($event.updates, $event.refocusEditor)"
    ></PopoverPandocAttributes>
  </div>
</template>

<script setup lang="ts">

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Editor
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This displays the main editor for the app. It uses the
 *                  MarkdownEditor class to implement the full CodeMirror editor.
 *
 * END HEADER
 */

import MarkdownEditor, { type EditorViewPersistentState, type JumpPosition } from '@common/modules/markdown-editor'

import { ref, computed, inject, onMounted, onBeforeUnmount, watch, toRef, defineAsyncComponent } from 'vue'
import { type EditorCommands } from './App.vue'
import { type JevSearchHighlightRequest } from '@common/modules/jev-search'
import { clearJevSearchHighlight, showJevSearchHighlight } from '@common/modules/markdown-editor/plugins/jev-search-highlight'
import { resolveLineNumberFontSize } from '@common/modules/markdown-editor/plugins/line-numbers'
import { hasMarkdownExt } from '@common/util/file-extention-checks'
import { DP_EVENTS, type OpenDocument } from '@dts/common/documents'
import { CITEPROC_MAIN_DB } from '@dts/common/citeproc'
import { type EditorConfigOptions } from '@common/modules/markdown-editor/util/configuration'
import type { ColorProperty } from '@common/modules/markdown-editor/util/text-color-span'
import { normalizeCharacterPairSettings } from '@common/modules/markdown-editor/util/character-pair-policy'
import type { CodeFileDescriptor, DirDescriptor, MDFileDescriptor } from '@dts/common/fsal'
import { getBibliographyForDescriptor as getBibliography } from '@common/util/get-bibliography-for-descriptor'
import { EditorSelection } from '@codemirror/state'
import { documentAuthorityIPCAPI } from '@common/modules/markdown-editor/util/ipc-api'
import { useConfigStore, useDocumentTreeStore, useTagsStore, useWindowStateStore, useWorkspaceStore } from 'source/pinia'
import { isAbsolutePath, pathBasename, pathDirname, resolvePath } from '@common/util/renderer-path-polyfill'
import type { DocumentManagerIPCAPI, DocumentsUpdateContext } from 'source/app/service-providers/documents'
import type { CiteprocProviderIPCAPI } from 'source/app/service-providers/citeproc'
import type { ProjectInfo } from 'source/common/modules/markdown-editor/plugins/project-info-field'
import type { FileContentSearchResult } from 'source/app/service-providers/search'
import type { CustomEditorShortcut } from 'source/common/modules/markdown-editor/keymaps/shortcuts'
import getDocumentTitle from './util/get-document-title'
import { useEditorFontZoom } from './util/use-editor-font-zoom'
import { registerEditorPaneReadingCapture, storeEditorPaneReadingState } from './util/editor-pane-reading-state'
import { effectiveEditorMargin, isSplitLayout, storedEditorMargin } from './util/editor-margin'
import { CONFLICT_READ_ONLY_REGISTRY_KEY, setOriginalEditorConflictReadOnly, type ConflictReadOnlyRegistry } from './util/conflict-read-only'
import PopoverPandocAttributes from './PopoverPandocAttributes.vue'
import type { PandocAttributeTarget, PandocAttributeTargetKind } from '@common/pandoc-util/pandoc-attribute-schema'
import {
  PANDOC_ATTRIBUTES_EVENT,
  type PandocAttributeKindUpdate,
  type PandocAttributesEventDetail
} from '@common/modules/markdown-editor/context-menu/pandoc-attribute-menu'
import type { RecoverableSession } from 'source/app/service-providers/recovery-journal/journal-store'

// Zettlr-LYH data loss prevention (R173): the notice is loaded when it is first
// shown, not with a static import. Several tests evaluate this component with
// a fixed list of the modules it may import, and they have to keep passing
// unchanged. The "eager" mode keeps the notice in the same bundle, so showing
// it does not depend on loading anything.
const RecoveryNotice = defineAsyncComponent(async () => await import(/* webpackMode: "eager" */ './RecoveryNotice.vue'))

const ipcRenderer = window.ipc

// This function overwrites the getBibliographyForDescriptor function to ensure
// the library is always absolute. We have to do it this ridiculously since the
// function is called in both main and renderer processes, and we still have the
// issue that path-browserify is entirely unusable.
function getBibliographyForDescriptor (descriptor: MDFileDescriptor): string {
  const library = getBibliography(descriptor)

  if (library !== CITEPROC_MAIN_DB && !isAbsolutePath(library)) {
    return resolvePath(descriptor.dir, library)
  } else {
    return library
  }
}

const props = defineProps<{
  leafId: string
  windowId: string
  activeFile: OpenDocument|null
  editorCommands: EditorCommands
  distractionFree: boolean
  file: OpenDocument
  persistentStateMap: Map<string, EditorViewPersistentState>
  /**
   * Zettlr-LYH (R124): the view mode of a TOML file, set by the mode bar of
   * the editor pane; undefined for every other file. Switching it changes
   * only the presentation of the same editor, which is not remounted.
   */
  tomlViewMode?: 'formatted'|'raw'
}>()

const emit = defineEmits<{
  (e: 'globalSearch', query: string): void
  // Zettlr-LYH undo history (R135): an undo took back the reload of an external
  // modification, so that the pane can say so
  (e: 'undidReloadFromDisk'): void
}>()

const windowStateStore = useWindowStateStore()
const documentTreeStore = useDocumentTreeStore()
const workspaceStore = useWorkspaceStore()
const configStore = useConfigStore()
const tagStore = useTagsStore()

// Zooms the editor font size with Ctrl plus the mouse wheel (R41)
const { handleZoomWheel } = useEditorFontZoom()

// UNREFFED STUFF
let currentEditor: MarkdownEditor|null = null

// Zettlr-LYH disk conflicts (R138): while any window compares the file with
// the version on disk, every original editor of the file is read-only.
// The one in the pane that shows the comparison lies beneath it; the others
// show a hint above them (EditorPane.vue). The editor reapplies the mode each
// time it replaces its state (a reload after the comparison, a first load).
const conflictReadOnlyRegistry = inject<ConflictReadOnlyRegistry|undefined>(CONFLICT_READ_ONLY_REGISTRY_KEY, undefined)
const conflictReadOnly = computed<boolean>(() => conflictReadOnlyRegistry?.isReadOnly(props.file.path) === true)
watch(conflictReadOnly, readOnly => {
  if (currentEditor !== null) {
    setOriginalEditorConflictReadOnly(currentEditor.instance, readOnly)
  }
}, { flush: 'sync' })
function captureReadingState (): void {
  if (currentEditor !== null) {
    const persistentState = currentEditor.persistentState
    if (persistentState !== undefined) {
      storeEditorPaneReadingState(props.windowId, props.leafId, captureReadingState, currentEditor.documentPath, persistentState)
    }
  }
}
const stopReadingCapture = registerEditorPaneReadingCapture(props.windowId, props.leafId, captureReadingState, props.file.path)

// Zettlr-LYH (R98): the main process keeps the last reading position of every
// text file (the line at the top of the viewport and the pixels below its top),
// so that the file opens where the reader stopped, also after a restart, in
// another window and in another pane. The reading state in memory (R75) wins
// where it exists.
/**
 * Asks the main process where the reader stopped in a file the last time.
 *
 * @param   {string}            filePath  The absolute path to the file
 *
 * @return  {Promise<unknown>}            The record: the position, null if the
 *                                        file has none, or an error object
 */
function readStoredTextReadingPosition (filePath: string): Promise<unknown> {
  return ipcRenderer.invoke('application', { command: 'get-text-reading-position', payload: { filePath } })
}

/**
 * Hands the reading position of the current editor to the main process, unless
 * the editor does not know it yet (not loaded, not displayed, or a position is
 * still waiting to be applied). Called when the editor goes away and when the
 * reader stopped scrolling.
 */
function storeTextReadingPosition (): void {
  if (currentEditor === null) {
    return
  }
  try {
    const position = currentEditor.persistableTextReadingPosition
    if (position !== undefined) {
      ipcRenderer.invoke('application', {
        command: 'set-text-reading-position',
        payload: { filePath: currentEditor.documentPath, line: position.line, offset: position.offset }
      }).catch(err => console.error(err))
    }
  } catch (err) {
    // Storing a position must never keep the editor from going away
    console.error(err)
  }
}
let unmounted = false

// EVENT LISTENERS
const stopCitationUpdates = ipcRenderer.on('citeproc-database-updated', (_event, _dbPath: string) => {
  const descriptor = activeFileDescriptor.value

  if (descriptor === undefined || descriptor.type !== 'file') {
    return // Nothing to do
  }

  const library = getBibliographyForDescriptor(descriptor)
  updateCitationKeys(library).catch(e => {
    console.error('Could not update citation keys', e)
  })
})

const stopShortcuts = ipcRenderer.on('shortcut', (event, command) => {
  if (currentEditor?.hasFocusWithin() !== true) {
    return // None of our business
  }

  if (command === 'save-file') {
    // Main is telling us to save, so tell main to save the current file.
    ipcRenderer.invoke('documents-provider', {
      command: 'save-file',
      payload: { path: props.file.path }
    } as DocumentManagerIPCAPI)
      .then(result => {
        if (result !== true) {
          console.error('Retrieved a falsy result from main, indicating an error with saving the file.')
        }
      })
      .catch(e => console.error(e))
  } else if (command === 'save-file-as') {
    // Zettlr-LYH save as (R48): main asks for the new name and lets the tab
    // follow the file; false merely means the user cancelled or was refused
    ipcRenderer.invoke('documents-provider', {
      command: 'save-file-as',
      payload: { path: props.file.path }
    } as DocumentManagerIPCAPI)
      .catch(e => console.error(e))
  } else if (command === 'search') {
    currentEditor.toggleSearchPanel()
  } else if (command === 'toggle-typewriter-mode') {
    currentEditor.hasTypewriterMode = !currentEditor.hasTypewriterMode
  } else if (command === 'copy-as-html') {
    currentEditor.copyAsHTML()
  } else if (command === 'paste-as-plain') {
    currentEditor.pasteAsPlainText()
  }
})

const stopDocumentUpdates = ipcRenderer.on('documents-update', (e, payload: { event: DP_EVENTS, context: DocumentsUpdateContext }) => {
  const { event, context } = payload
  if (event === DP_EVENTS.FILE_REMOTELY_CHANGED && context.filePath === props.file.path) {
    // The currently loaded document has been changed remotely. This event indicates
    // that the document provider has already reloaded the document and we only
    // need to tell the main editor to reload it as well.
    currentEditor?.reload().catch(e => console.error(e))
  } else if (event === DP_EVENTS.FILE_SAVED && context.filePath === props.file.path) {
    // The file has been saved to disk. This means we should probably update the
    // descriptor to know of, e.g., library changes.
    ipcRenderer.invoke('fsal', { command: 'get-descriptor', payload: props.file.path })
      .then((descriptor: MDFileDescriptor|CodeFileDescriptor|undefined) => {
        if (unmounted) {
          return
        }
        if (descriptor === undefined) {
          throw new Error(`Could not swap document: Could not retrieve descriptor for path ${props.file.path}!`)
        }

        activeFileDescriptor.value = descriptor
        const library = descriptor.type === 'file' ? getBibliographyForDescriptor(descriptor) : undefined
        if (library !== undefined) {
          updateCitationKeys(library).catch(e => console.error('Could not update citation keys', e))
        }

        // Provide the editor instance with updated metadata
        currentEditor?.setOptions({
          metadata: {
            path: props.file.path,
            id: descriptor.type === 'file' ? descriptor.id : '',
            library: library ?? CITEPROC_MAIN_DB
          }
        })
      })
      .catch(err => console.error(err))
  }
})

const stopEditorReloads = ipcRenderer.on('reload-editors', _e => {
  currentEditor?.reload().catch(err => console.error('Failed to reload editor after `reload-editors` event', err))
})

// Update the file database whenever links have been updated
const stopLinkUpdates = ipcRenderer.on('links', _e => {
  updateFileDatabase().catch(err => console.error('Could not update file database', err))
})

// MOUNTED HOOK
onMounted(() => {
  loadDocument().catch(err => console.error(err))
  // "Edit All…" in the Pandoc section of the editor's context menus
  mainEditorWrapper.value?.addEventListener(PANDOC_ATTRIBUTES_EVENT, onPandocAttributesRequest)
  startEditorGeometryObserver()
})

onBeforeUnmount(() => {
  unmounted = true
  stopCitationUpdates()
  stopShortcuts()
  stopDocumentUpdates()
  stopEditorReloads()
  stopLinkUpdates()
  mainEditorWrapper.value?.removeEventListener(PANDOC_ATTRIBUTES_EVENT, onPandocAttributesRequest)
  editorGeometryObserver?.disconnect()
  editorGeometryObserver = null
  if (editorGeometryFrame !== null) {
    cancelAnimationFrame(editorGeometryFrame)
    editorGeometryFrame = null
  }
  observedGutters = null
  clearTimeout(pandocPanelRefreshTimeout)
  pandocPanel.value = null
  captureReadingState()
  storeTextReadingPosition()
  stopReadingCapture()
  // Zettlr-LYH (R112): a reading line of this editor no longer applies
  const readingLine = windowStateStore.readingLine
  if (readingLine !== undefined && readingLine.leafId === props.leafId && readingLine.filePath === props.file.path) {
    windowStateStore.readingLine = undefined
  }
  if (currentEditor !== null) {
    // Clear out the table of contents before unmounting the component.
    windowStateStore.tableOfContents = undefined
    currentEditor.unmount()
    currentEditor = null
  }
})

// DATA SETUP
const mainEditorWrapper = ref<HTMLDivElement|null>(null)

// Zettlr-LYH data loss prevention (R173, specification C21 section 6): the
// sessions of this file whose input never reached the document, as the editor
// announced them after its last load, the newest first. The notice above the
// editor shows the first one and stays until the user has chosen what happens
// to it; then the next one is shown.
const recoverableSessions = ref<RecoverableSession[]>([])
const recoveryActionRunning = ref(false)
const recoveryActionError = ref<string|undefined>(undefined)

/**
 * Opens a recovery copy in a new tab of this pane.
 *
 * @param  {string}  path  The absolute path of the recovery copy
 */
async function openRecoveryCopy (path: string): Promise<void> {
  await ipcRenderer.invoke('documents-provider', {
    command: 'open-file',
    payload: { path, windowId: props.windowId, leafId: props.leafId, newTab: true }
  } as DocumentManagerIPCAPI)
}

/**
 * Carries out what the user chose in the recovery notice for the session it
 * shows. The session leaves the list once the choice has been carried out; if
 * that fails, the notice stays and says so.
 *
 * @param  {'restore'|'keep-as-file'|'discard'}  choice  The button the user clicked
 */
function settleRecoverableSession (choice: 'restore'|'keep-as-file'|'discard'): void {
  const editor = currentEditor
  if (editor === null || recoverableSessions.value.length === 0 || recoveryActionRunning.value) {
    return
  }

  const session = recoverableSessions.value[0]
  let action: Promise<unknown>
  if (choice === 'restore') {
    action = editor.restoreRecoverableSession(session)
  } else if (choice === 'keep-as-file') {
    action = editor.keepRecoverableSessionAsFile(session, openRecoveryCopy)
  } else {
    action = editor.discardRecoverableSession(session)
  }

  recoveryActionRunning.value = true
  action
    .then(() => {
      recoveryActionError.value = undefined
      recoverableSessions.value = recoverableSessions.value.filter(candidate => candidate.sessionId !== session.sessionId)
    })
    .catch(err => {
      console.error(`Could not ${choice} the recoverable session ${session.sessionId} of ${props.file.path}`, err)
      recoveryActionError.value = 'Could not complete this action. Please try again.'
    })
    .finally(() => { recoveryActionRunning.value = false })
}

// Zettlr-LYH (R81): the left and right margin of the text. The toolbar's
// Margin control stores one value for a single pane and one for split panes;
// while it is being dragged, the preview of this window applies instead. The
// margin is reduced to what the width of this pane allows (at least 200 px of
// text), which needs the client width of the scroller and the width of the
// gutters before the text; a ResizeObserver keeps both up to date. The CSS
// rules of code files and of the distraction free mode ignore the value.
const paneScrollerWidth = ref(0)
const paneGutterWidth = ref(0)
let editorGeometryObserver: ResizeObserver|null = null
let editorGeometryFrame: number|null = null
let observedGutters: HTMLElement|null = null

const requestedEditorMargin = computed<number>(() => {
  const split = isSplitLayout(documentTreeStore.paneStructure)
  const preview = windowStateStore.editorMarginPreview
  if (preview?.split === split) {
    return preview.value
  }
  return storedEditorMargin(configStore.config.display, split)
})

const editorMargin = computed<number>(() => {
  // A pane that is not laid out (e.g., a hidden tab) has no width yet; it
  // gets limited once it is shown and measured
  if (paneScrollerWidth.value <= 0) {
    return requestedEditorMargin.value
  }
  return effectiveEditorMargin(requestedEditorMargin.value, paneScrollerWidth.value, paneGutterWidth.value)
})

/**
 * Zettlr-LYH (R81): measures the client width of the editor's scroller and the
 * width of the gutters before the text, and makes sure that the observer
 * watches the current gutter container. The two measured widths do not depend
 * on the margin, so the measurement does not feed back into itself. The margin
 * that follows from them is written to the padding of the scroller, though,
 * and that changes the content box which other observers (CodeMirror's DOM
 * observer and the line number, code block and gutter whitespace plugins) are
 * watching. The observer therefore does not call this function synchronously;
 * see scheduleEditorGeometryMeasurement().
 */
function measureEditorGeometry (): void {
  const wrapper = mainEditorWrapper.value
  const scroller = wrapper?.querySelector<HTMLElement>(':scope > .cm-editor > .cm-scroller') ?? null
  const gutters = scroller?.querySelector<HTMLElement>(':scope > .cm-gutters.cm-gutters-before') ?? null

  if (editorGeometryObserver !== null && gutters !== observedGutters) {
    if (observedGutters !== null) {
      editorGeometryObserver.unobserve(observedGutters)
    }
    observedGutters = gutters
    if (gutters !== null) {
      editorGeometryObserver.observe(gutters)
    }
  }

  paneScrollerWidth.value = scroller?.clientWidth ?? 0
  paneGutterWidth.value = gutters?.offsetWidth ?? 0
}

/**
 * Zettlr-LYH (R81): measures the geometry of the editor in the next animation
 * frame, once for any number of calls until then. A new margin changes the
 * content box of the scroller, which shallower elements than the observed
 * gutters hold observers on; if the margin were changed inside the same
 * observer loop (the observer callback and the update that Vue runs in a
 * microtask after it), the browser would skip their notifications until the
 * next frame and report "ResizeObserver loop completed with undelivered
 * notifications". In an animation frame callback, the margin changes before
 * the layout of that frame, and all observers are notified of the new size
 * regularly. The margin follows the widths one frame (about 16 ms) later.
 */
function scheduleEditorGeometryMeasurement (): void {
  if (editorGeometryFrame !== null) {
    return
  }
  editorGeometryFrame = requestAnimationFrame(() => {
    editorGeometryFrame = null
    measureEditorGeometry()
  })
}

/**
 * Zettlr-LYH (R81): starts observing the size of the editor wrapper, which
 * follows the width of the pane, and of the gutters, which follow the font
 * size. Without a ResizeObserver, the margin is not limited.
 */
function startEditorGeometryObserver (): void {
  if (typeof ResizeObserver === 'undefined' || mainEditorWrapper.value === null) {
    return
  }
  editorGeometryObserver = new ResizeObserver(() => { scheduleEditorGeometryMeasurement() })
  editorGeometryObserver.observe(mainEditorWrapper.value)
}

// COMPUTED PROPERTIES
const useH1 = computed<boolean>(() => configStore.config.fileNameDisplay.includes('heading'))
const useTitle = computed<boolean>(() => configStore.config.fileNameDisplay.includes('title'))
const fontSize = computed<number>(() => configStore.config.editor.fontSize)
const lineNumberFontSize = computed<number>(() => resolveLineNumberFontSize(fontSize.value, configStore.config.editor.lineNumberFontSize))
const globalSearchResults = computed(() => windowStateStore.searchResults)
const snippets = computed(() => windowStateStore.snippets)
const tags = computed(() => tagStore.tags)
const isMarkdown = computed(() => hasMarkdownExt(props.file.path))

const activeFileDescriptor = ref<undefined|MDFileDescriptor|CodeFileDescriptor>(undefined)

const editorConfiguration = computed<EditorConfigOptions>(() => {
  // We update everything, because not so many values are actually updated
  // right after setting the new configurations. Plus, the user won't update
  // everything all the time, but rather do one initial configuration, so
  // even if we incur a performance penalty, it won't be noticed that much.
  const { editor, display, zkn, darkMode, shortcuts, darkModeEditor } = configStore.config
  return {
    indentUnit: editor.indentUnit,
    indentWithTabs: editor.indentWithTabs,
    alwaysIndentLineOnTab: editor.alwaysIndentLineOnTab,
    autoCloseBrackets: editor.autoCloseBrackets,
    autoCloseCharacterPairs: normalizeCharacterPairSettings(editor.autoCloseCharacterPairs, editor.autoCloseBrackets),
    autocorrect: {
      active: editor.autoCorrect.active,
      matchWholeWords: editor.autoCorrect.matchWholeWords,
      magicQuotes: {
        primary: editor.autoCorrect.magicQuotes.primary,
        secondary: editor.autoCorrect.magicQuotes.secondary
      },
      replacements: editor.autoCorrect.replacements
    },
    autocompleteSuggestEmojis: editor.autocompleteSuggestEmojis,
    snippetAutocompleteTriggerCharacter: editor.snippetAutocompleteTriggerCharacter,
    autocompleteWithEnter: editor.autocompleteWithEnter,
    autocompleteWithTab: editor.autocompleteWithTab,
    imagePreviewWidth: display.imageWidth,
    imagePreviewHeight: display.imageHeight,
    blockquoteIndent: display.blockquoteIndent,
    blockquoteBackgroundLight: display.blockquoteBackgroundLight,
    blockquoteBackgroundLightTransparent: display.blockquoteBackgroundLightTransparent,
    blockquoteBackgroundDark: display.blockquoteBackgroundDark,
    blockquoteBackgroundDarkTransparent: display.blockquoteBackgroundDarkTransparent,
    headingSize1: display.headingSize1,
    headingBold1: display.headingBold1,
    headingSize2: display.headingSize2,
    headingBold2: display.headingBold2,
    headingSize3: display.headingSize3,
    headingBold3: display.headingBold3,
    headingSize4: display.headingSize4,
    headingBold4: display.headingBold4,
    headingSize5: display.headingSize5,
    headingBold5: display.headingBold5,
    headingSize6: display.headingSize6,
    headingBold6: display.headingBold6,
    boldFormatting: editor.boldFormatting,
    italicFormatting: editor.italicFormatting,
    highlightFormatting: editor.highlightFormatting,
    muteLines: configStore.config.muteLines,
    citeStyle: editor.citeStyle,
    readabilityAlgorithm: editor.readabilityAlgorithm,
    idRE: zkn.idRE,
    idGen: zkn.idGen,
    previewModeShowSyntaxWhenCursorIsAdjacent: display.previewModeShowSyntaxWhenCursorIsAdjacent,
    editCodeWhenClicked: display.editCodeWhenClicked,
    codeEditingExceptions: { ...display.codeEditingExceptions },
    // Zettlr-LYH (R84): Track Changes, Show Revisions and the revision author
    trackChanges: editor.trackChanges,
    showRevisions: display.showRevisions,
    revisionAuthor: editor.revisionAuthor,
    copyVisibleTextCategories: { ...display.copyVisibleTextCategories },
    renderCitations: display.renderCitations,
    renderingMode: display.renderingMode,
    renderIframes: display.renderIframes,
    renderImages: display.renderImages,
    renderLinks: display.renderLinks,
    renderMath: display.renderMath,
    renderTasks: display.renderTasks,
    renderHeadings: display.renderHTags,
    renderTables: editor.enableTableHelper,
    renderEmphasis: display.renderEmphasis,
    renderPandoc: display.renderPandoc,
    renderAdmonitions: display.renderAdmonitions,
    renderHorizontalRules: display.renderHorizontalRules,
    zknLinkFormat: zkn.linkFormat,
    zknAddFileTitle: zkn.linkAddFileTitle,
    linkWithIDIfPossible: zkn.linkWithIDIfPossible,
    inputMode: editor.inputMode,
    lintMarkdown: editor.lint.markdown,
    // The editor only needs to know if it should use languageTool
    lintLanguageTool: editor.lint.languageTool.active,
    distractionFree: props.distractionFree.valueOf(),
    showStatusbar: editor.showStatusbar,
    showFormattingToolbar: editor.showFormattingToolbar,
    darkMode,
    darkModeEditor,
    theme: display.theme,
    highlightWhitespace: editor.showWhitespace,
    showMarkdownLineNumbers: editor.showMarkdownLineNumbers,
    countChars: editor.countChars,
    shortcuts: Object.entries(shortcuts.editor)
      .map(([ name, shortcut ]) => ({ name, shortcut }))
      .filter((shortcut): shortcut is CustomEditorShortcut => shortcut.shortcut !== undefined),
    // Pandoc mode (R21): this document's Pandoc PPTX preview is open
    pandocAttributeEditing: windowStateStore.pptxPreviewPaths.has(props.file.path)
  } satisfies EditorConfigOptions
})

// BEGIN: PROJECT INFO
function updateProjectInfo (): ProjectInfo|null {
  // If this file is part of a project, the project must be defined in any
  // containing folder -> traverse up the file tree until we have found one.
  let dir = workspaceStore.descriptorMap.get(pathDirname(props.file.path)) as DirDescriptor|undefined

  while (dir !== undefined && dir.settings.project === null) {
    dir = workspaceStore.descriptorMap.get(dir.dir) as DirDescriptor|undefined
  }

  if (dir === undefined || dir.settings.project === null) {
    return null // No project found in the tree
  }

  // Check if this file is part of the project.
  const absPaths = dir.settings.project.files.map(p => resolvePath(dir.path, p))
  if (!absPaths.includes(props.file.path)) {
    return null
  }

  const extractedMetadata = absPaths
    .map(p => {
      return workspaceStore.descriptorMap.get(p)
    })
    .filter (d => d !== undefined && d.type === 'file')
    .map(d => {
      return {
        wordCount: d.wordCount,
        charCount: d.charCount,
        path: d.path,
        displayName: d.yamlTitle ?? d.firstHeading ?? d.name
      }
    })

  // It is! So now we can return the proper project info.
  return {
    name: dir.settings.project.title,
    files: extractedMetadata
      .map(p => ({ path: p.path, displayName: p.displayName })),
    wordCount: extractedMetadata
      .map(p => p.wordCount)
      .reduce((p, c) => p + c, 0),
    charCount: extractedMetadata
      .map(p => p.charCount)
      .reduce((p, c) => p + c, 0)
  }
}

// Update the project info as soon as anything in the workspaces has changed.
workspaceStore.$subscribe(() => {
  if (currentEditor !== null) {
    currentEditor.projectInfo = updateProjectInfo()
  }
})
// END: PROJECT INFO

// External commands/"event" system
watch(toRef(props.editorCommands, 'jumpToLine'), () => {
  const { filePath, lineNumber, cursorOnly, leafId, position } = props.editorCommands.data
  // Execute a jtl-command if the current displayed file is the correct one.
  // cursorOnly (Zettlr-LYH R62, PDF backlinks): place the cursor at the start
  // of the line instead of selecting the whole line.
  // leafId (Zettlr-LYH R113, table of contents): only the editor of that pane
  // jumps; jumps without a pane move every editor showing the file. This is
  // the rule of shouldEditorJump in sidebar/util/toc-display.ts, written out
  // here because this component imports no sidebar modules.
  const jumpsHere = filePath === props.file.path &&
    (typeof leafId !== 'string' || leafId === props.leafId)
  if (jumpsHere && typeof lineNumber === 'number') {
    // position (Zettlr-LYH R112): 'reading-line' puts the line top at one
    // third of the visible height instead of the middle
    jtl(lineNumber, cursorOnly !== true, position === 'reading-line' ? 'reading-line' : 'center')
  }
})

watch(toRef(props.editorCommands, 'moveSection'), () => {
  if (props.activeFile?.path !== props.file.path || documentTreeStore.lastLeafId !== props.leafId) {
    return
  }

  const { from, to } = props.editorCommands.data
  if (typeof from === 'number' && typeof to === 'number') {
    currentEditor?.moveSection(from, to)
  }
})

// Zettlr-LYH (R124): the mode bar switched a TOML file between Formatted and
// Raw Text; the editor keeps its state and only changes the presentation
watch(toRef(props, 'tomlViewMode'), (mode) => {
  if (mode !== undefined) {
    currentEditor?.setTOMLPresentation(mode === 'formatted')
  }
})

watch(toRef(props, 'distractionFree'), () => {
  if (currentEditor !== null && props.activeFile?.path === props.file.path && documentTreeStore.lastLeafId === props.leafId) {
    currentEditor.distractionFree = props.distractionFree
  }
})

watch(toRef(props.editorCommands, 'executeCommand'), () => {
  if (props.activeFile?.path !== props.file.path || currentEditor === null) {
    return
  }

  if (documentTreeStore.lastLeafId !== props.leafId) {
    // This editor, even though it may be focused, was not the last focused
    // See https://github.com/Zettlr/Zettlr/issues/4361
    return
  }

  const command: string = props.editorCommands.data
  currentEditor.runCommand(command)
  currentEditor.focus()
})

// Zettlr-LYH (R174, R131): the Text Color and Background Color buttons of the
// formatting bar. The guards are the same as for executeCommand: only the
// editor that shows the active file and was the last one to have the focus
// carries out the request.
watch(toRef(props.editorCommands, 'applyTextColor'), () => {
  if (props.activeFile?.path !== props.file.path || currentEditor === null) {
    return
  }

  if (documentTreeStore.lastLeafId !== props.leafId) {
    return
  }

  const request: { property: ColorProperty, color: string|null } = props.editorCommands.data
  currentEditor.applyTextColor(request.property, request.color)
  currentEditor.focus()
})

watch(toRef(props.editorCommands, 'replaceSelection'), () => {
  if (props.activeFile?.path !== props.file.path) {
    return
  }

  if (documentTreeStore.lastLeafId !== props.leafId) {
    // This editor, even though it may be focused, was not the last focused
    // See https://github.com/Zettlr/Zettlr/issues/4361
    return
  }

  const textToInsert: string = props.editorCommands.data
  currentEditor?.replaceSelection(textToInsert)
})

watch(toRef(props.editorCommands, 'insertPandoc'), () => {
  if (props.activeFile?.path !== props.file.path || currentEditor === null) {
    return
  }

  if (documentTreeStore.lastLeafId !== props.leafId) {
    // This editor, even though it may be focused, was not the last focused
    // See https://github.com/Zettlr/Zettlr/issues/4361
    return
  }

  const { type, attributes } = props.editorCommands.data
  if ((type === 'div' || type === 'span') && typeof attributes === 'string') {
    currentEditor?.insertPandocDivOrSpan(type as 'div'|'span', attributes)
    currentEditor?.focus()
  }
})

// JEV Search (R53): the panel picked a hit (scroll it into the middle of the
// view and highlight it) or asked to remove the highlight (null). Only the
// last focused editor of the hit's file shows it; every other editor drops
// its highlight, so that one chunk at most is highlighted at a time. R57: a
// request with scroll set to false (the panel restores the pinned hit after a
// hover preview) only replaces the highlight and leaves the view where it is.
watch(toRef(props.editorCommands, 'jevSearchHighlight'), () => {
  if (currentEditor === null) {
    return
  }

  const request = props.editorCommands.data as JevSearchHighlightRequest
  const isTarget = request !== null && typeof request === 'object' &&
    request.filePath === props.file.path &&
    props.activeFile?.path === props.file.path &&
    documentTreeStore.lastLeafId === props.leafId

  if (isTarget && typeof request.from === 'number' && typeof request.to === 'number') {
    showJevSearchHighlight(currentEditor.instance, request.from, request.to, request.scroll !== false)
  } else {
    clearJevSearchHighlight(currentEditor.instance)
  }
})

// BEGIN: PANDOC ATTRIBUTES (R21/R22)
interface PandocPanelState {
  from: number
  to: number
  targets: PandocAttributeTarget[]
  /** Set by a context menu's Edit All…; cursor-driven refreshes clear it */
  focusKind?: PandocAttributeTargetKind
}

const pandocPanel = ref<PandocPanelState|null>(null)
const pandocPanelAnchor = ref<HTMLElement|null>(null)
let pandocPanelRefreshTimeout: ReturnType<typeof setTimeout>|undefined

// The persistent panel is a window-wide singleton (the toolbar's checkable
// Attributes button toggles it); the last focused editor of the active
// Markdown file renders it.
const showsPandocPanel = computed<boolean>(() => {
  return windowStateStore.pandocAttributesPanelOpen &&
    props.activeFile?.path === props.file.path &&
    // This editor, even though it may be focused, was not the last focused
    // See https://github.com/Zettlr/Zettlr/issues/4361
    documentTreeStore.lastLeafId === props.leafId &&
    isMarkdown.value
})

/**
 * (Re)reads the objects around the given range (default: the main selection)
 * into the panel state.
 *
 * @param   {number|undefined}          from       Range start
 * @param   {number|undefined}          to         Range end
 * @param   {PandocAttributeTargetKind} focusKind  Section to scroll to
 */
function refreshPandocPanel (from?: number, to?: number, focusKind?: PandocAttributeTargetKind): void {
  if (currentEditor === null) {
    return
  }
  const found = currentEditor.getPandocAttributeTargets(from, to)
  pandocPanel.value = { from: found.from, to: found.to, targets: found.targets, focusKind }
}

/**
 * Follows the cursor while the panel is open: re-reads the objects around the
 * selection, debounced so that typing does not query on every keystroke.
 */
function schedulePandocPanelRefresh (): void {
  if (!showsPandocPanel.value) {
    return
  }
  clearTimeout(pandocPanelRefreshTimeout)
  pandocPanelRefreshTimeout = setTimeout(() => {
    if (showsPandocPanel.value) {
      refreshPandocPanel()
    }
  }, 200)
}

watch(showsPandocPanel, (visible) => {
  if (visible) {
    pandocPanelAnchor.value = document.querySelector<HTMLElement>('#toolbar-pandocAttributes')
    // An Edit All… request may have populated the state right before this
    // watcher ran; keep its range and focus in that case
    if (pandocPanel.value === null) {
      refreshPandocPanel()
    }
  } else {
    clearTimeout(pandocPanelRefreshTimeout)
    pandocPanel.value = null
  }
// The panel may already be open when this editor mounts (e.g. after switching
// tabs); immediate makes the watcher run once right away. The refresh then
// no-ops until loadDocument() has created the editor and refreshes again.
}, { immediate: true })

/**
 * Writes attribute updates back into the document. Called per control change
 * (the panel applies instantly, R22).
 *
 * @param   {PandocAttributeKindUpdate[]}  updates        At most one update per kind
 * @param   {boolean}                      refocusEditor  Hand focus back to the editor
 */
function applyPandocAttributes (updates: PandocAttributeKindUpdate[], refocusEditor: boolean): void {
  const state = pandocPanel.value
  if (state === null || currentEditor === null) {
    return
  }
  currentEditor.applyPandocAttributeUpdates(state.from, state.to, updates)
  if (refocusEditor) {
    currentEditor.focus()
  }
  // The write moved positions around; re-read the objects right away so that
  // the panel shows the written values and holds valid ranges
  refreshPandocPanel()
}

/**
 * Handles "Edit All…" from the context menus: opens the panel for the range
 * the menu was opened on and scrolls to the requested section.
 *
 * @param   {Event}  event  The PANDOC_ATTRIBUTES_EVENT
 */
function onPandocAttributesRequest (event: Event): void {
  const detail = (event as CustomEvent<PandocAttributesEventDetail>).detail
  refreshPandocPanel(detail.from, detail.to, detail.focusKind)
  windowStateStore.pandocAttributesPanelOpen = true
}
// END: PANDOC ATTRIBUTES

const fsalFiles = computed<MDFileDescriptor[]>(() => {
  return [...workspaceStore.descriptorMap.values()].filter(d => d.type === 'file')
})

// WATCHERS
watch(useH1, () => { updateFileDatabase().catch(err => console.error('Could not update file database', err)) })
watch(useTitle, () => { updateFileDatabase().catch(err => console.error('Could not update file database', err)) })
watch(fsalFiles, () => { updateFileDatabase().catch(err => console.error('Could not update file database', err)) })

watch(editorConfiguration, (newValue) => {
  currentEditor?.setOptions(newValue)
})

watch(globalSearchResults, () => {
  // TODO: I don't like that we need a timeout here.
  setTimeout(maybeHighlightSearchResults, 200)
})

watch(snippets, (newValue) => {
  currentEditor?.setCompletionDatabase('snippets', newValue)
})

watch(tags, (newValue) => {
  currentEditor?.setCompletionDatabase('tags', newValue)
})

// METHODS
/**
 * Returns a MarkdownEditor for the provided path.
 *
 * @param   {string}          doc  The document to load
 *
 * @return  {MarkdownEditor}       The requested editor
 */
function getEditorFor (doc: string): MarkdownEditor {
  const persistentState = props.persistentStateMap.get(doc)
  // Zettlr-LYH (R98): only a file without a reading state in memory asks the
  // main process for the stored reading position
  const editor = new MarkdownEditor(
    props.leafId, props.windowId, doc, documentAuthorityIPCAPI, undefined, persistentState,
    persistentState === undefined ? () => readStoredTextReadingPosition(doc) : undefined
  )
  // Zettlr-LYH (R124): a TOML file loads directly in its current view mode
  if (props.tomlViewMode !== undefined) {
    editor.setTOMLPresentation(props.tomlViewMode === 'formatted')
  }

  // Update the document info on corresponding events
  editor.on('loaded', () => {
    // Zettlr-LYH disk conflicts (R138): loading replaced the editor state, and
    // with it the read-only mode of a running comparison
    setOriginalEditorConflictReadOnly(editor.instance, conflictReadOnly.value)
    if (currentEditor === editor) {
      windowStateStore.activeDocumentInfo = currentEditor.documentInfo
      windowStateStore.tableOfContents = currentEditor.tableOfContents
    }
  })

  editor.on('change', () => {
    if (currentEditor === editor) {
      windowStateStore.tableOfContents = currentEditor.tableOfContents
    }
  })

  editor.on('docUpdate', () => {
    if (currentEditor === editor) {
      windowStateStore.activeDocumentInfo = currentEditor.documentInfo
    }
  })

  // Zettlr-LYH (R112): the line at one third of the visible height, reported
  // at most once per frame after scrolling, edits and size changes
  editor.on('reading-line', (line: number) => {
    if (currentEditor === editor) {
      publishReadingLine(line)
    }
  })

  // Zettlr-LYH (R98): the reader stopped scrolling for a second
  editor.on('scroll-idle', () => {
    if (currentEditor === editor) {
      storeTextReadingPosition()
    }
  })

  // Zettlr-LYH undo history (R135): the user undid the reload of an external
  // modification (a reload from disk or the result of a comparison)
  editor.on('undid-external-reload', () => {
    if (currentEditor === editor) {
      emit('undidReloadFromDisk')
    }
  })

  // Zettlr-LYH data loss prevention (R173): after a load, the editor found
  // sessions of this file whose input is missing in the document (or, with an
  // empty list, found that the ones it announced earlier are settled)
  editor.on('recoverable-sessions', (sessions: RecoverableSession[]) => {
    if (currentEditor === editor) {
      recoverableSessions.value = sessions
      recoveryActionError.value = undefined
    }
  })

  editor.on('focus', () => {
    ipcRenderer.invoke('documents-provider', {
      command: 'focus-leaf',
      payload: {
        leafId: props.leafId,
        windowId: props.windowId
      }
    } as DocumentManagerIPCAPI).catch(err => console.error(err))

    // NOTE: The lastLeafId will be changed in the documentTreeStore in response
    // to an event from main (DP_EVENTS.ACTIVE_FILE) which will be emitted as a
    // result of our focus-leaf event above.
    if (currentEditor === editor) {
      windowStateStore.tableOfContents = currentEditor.tableOfContents
    }
  })

  editor.on('zettelkasten-link', (linkContents: string) => {
    ipcRenderer.invoke('application', {
      command: 'force-open',
      payload: {
        linkContents,
        newTab: undefined, // let open-file command decide based on preferences
        leafId: props.leafId,
        windowId: props.windowId
      }
    })
      .catch(err => console.error(err))

    if (configStore.config.zkn.autoSearch) {
      emit('globalSearch', linkContents)
    }
  })

  editor.on('zettelkasten-tag', (tag: string) => {
    emit('globalSearch', tag)
  })

  // The persistent Pandoc attribute panel (R22) follows the cursor
  editor.on('cursorActivity', () => {
    if (currentEditor === editor) {
      schedulePandocPanelRefresh()
    }
  })

  // Supply the configuration object once initially
  editor.setOptions(editorConfiguration.value)
  return editor
}

/**
 * Loads the document for this editor instance.
 */
async function loadDocument (): Promise<void> {
  const newEditor = getEditorFor(props.file.path)

  mainEditorWrapper.value?.appendChild(newEditor.dom)
  currentEditor = newEditor
  // The new editor brings its own scroller and gutters (R81)
  measureEditorGeometry()

  currentEditor.setCompletionDatabase('tags', tags.value)
  currentEditor.setCompletionDatabase('snippets', snippets.value)

  // The attribute panel may have been open while this editor was still
  // loading (see the immediate watcher above); read the objects now
  if (showsPandocPanel.value && pandocPanel.value === null) {
    refreshPandocPanel()
  }

  maybeHighlightSearchResults()

  const descriptor: MDFileDescriptor|CodeFileDescriptor|undefined = await ipcRenderer.invoke('fsal', { command: 'get-descriptor', payload: props.file.path })
  if (unmounted || currentEditor !== newEditor) {
    return
  }
  if (descriptor === undefined) {
    throw new Error(`Could not swap document: Could not retrieve descriptor for path ${props.file.path}!`)
  }

  activeFileDescriptor.value = descriptor

  const library = descriptor.type === 'file' ? getBibliographyForDescriptor(descriptor) : undefined
  if (library !== undefined) {
    updateCitationKeys(library).catch(e => console.error('Could not update citation keys', e))
  }

  updateFileDatabase().catch(err => console.error('Could not update file database', err))

  // Provide the editor instance with metadata for the new file
  currentEditor.setOptions({
    metadata: {
      path: props.file.path,
      id: descriptor.type === 'file' ? descriptor.id : '',
      library: library ?? CITEPROC_MAIN_DB
    }
  })
  currentEditor.projectInfo = updateProjectInfo()
}

function jtl (lineNumber: number, selectLine: boolean = true, position: JumpPosition = 'center'): void {
  currentEditor?.jtl(lineNumber, selectLine, position)
}

/**
 * Zettlr-LYH (R112): reports the reading line of this editor to the window
 * state, which the sidebar table of contents highlights, but only while this
 * pane is the active one and its editor shows the active file.
 *
 * @param  {number|undefined}  line  The reading line of the current editor
 */
function publishReadingLine (line: number|undefined): void {
  if (
    line === undefined || unmounted ||
    documentTreeStore.lastLeafId !== props.leafId ||
    props.activeFile?.path !== props.file.path
  ) {
    return
  }
  const previous = windowStateStore.readingLine
  if (previous !== undefined && previous.leafId === props.leafId && previous.filePath === props.file.path && previous.line === line) {
    return
  }
  windowStateStore.readingLine = { leafId: props.leafId, filePath: props.file.path, line }
}

// Zettlr-LYH (R112): a pane that becomes active, or a pane whose active file
// becomes this file, reports where its editor currently stands
watch(() => [ documentTreeStore.lastLeafId, props.activeFile?.path ], () => {
  publishReadingLine(currentEditor?.readingLine)
})

async function updateCitationKeys (library: string): Promise<void> {
  const items: Array<{ citekey: string, displayText: string }> = (await ipcRenderer.invoke('citeproc-provider', {
    command: 'get-items',
    payload: { database: library }
  } as CiteprocProviderIPCAPI))
    .map((item: CSLItem) => {
      // Get a rudimentary author list. Precedence are authors, then editors.
      // Fallback: Container title.
      let authors = ''
      const authorSrc = item.author !== undefined && Array.isArray(item.author)
        ? item.author
        : item.editor !== undefined && Array.isArray(item.editor) ? item.editor : []

      if (authorSrc.length > 0) {
        authors = authorSrc.map(author => {
          if (author.family !== undefined) {
            return author.family
          } else if (author.literal !== undefined) {
            return author.literal
          } else {
            return undefined
          }
        }).filter(elem => elem !== undefined).join(', ')
      } else if (item['container-title'] !== undefined && typeof item['container-title'] === 'string') {
        authors = item['container-title']
      }

      let title = ''
      if (item.title !== undefined && typeof item.title === 'string') {
        title = item.title
      } else if (item['container-title'] !== undefined && typeof item['container-title'] === 'string') {
        title = item['container-title']
      }

      let date = ''
      if (item.issued != undefined && typeof item.issued === 'object') {
        if ('date-parts' in item.issued && Array.isArray(item.issued['date-parts'])) {
          const year = item.issued['date-parts'][0][0]
          date = ` (${year})`
        } else if ('literal' in item.issued) {
          date = ` (${item.issued.literal})`
        }
      }

      // This is just a very crude representation of the citations.
      return {
        citekey: item.id,
        displayText: `${authors}${date} - ${title}`
      }
    })

  if (unmounted) {
    return
  }
  currentEditor?.setCompletionDatabase('citations', items)
}

async function updateFileDatabase (): Promise<void> {
  // Get all our files ...
  const fileDatabase: Array<{ filename: string, displayName: string, id: string }> = []

  // ... and the unique links that are part of the link database
  const rawLinks: Record<string, string[]> = await ipcRenderer.invoke('link-provider', { command: 'get-link-database' })
  if (unmounted) {
    return
  }
  const linkDatabase = [...new Set(Object.values(rawLinks).flat())]

  // First, add all existing files to the database ...
  for (const file of fsalFiles.value) {
    fileDatabase.push({
      filename: pathBasename(file.name, file.ext),
      displayName: getDocumentTitle(file),
      id: file.id
    })
  }

  // ... before going through the link database to add those links that link to
  // not yet existing files
  for (const link of linkDatabase) {
    const existingFile = fileDatabase.find(file => file.filename === link || file.id === link)
    if (existingFile === undefined) {
      fileDatabase.push({ filename: link, displayName: link, id: '' })
    }
  }

  currentEditor?.setCompletionDatabase('files', fileDatabase)
}

function maybeHighlightSearchResults (): void {
  if (currentEditor === null) {
    return
  }

  const result = globalSearchResults.value.find(r => r.file.path === props.file.path)
  if (result === undefined) {
    currentEditor.highlightRanges([])
    return
  }

  // Construct CodeMirror.Ranges from the results
  const rangesToHighlight = []
  // NOTE: We have to filter out "whole-file" results
  for (const res of result.result.filter((res): res is FileContentSearchResult => res.type === 'content' && res.line > -1)) {
    const startIdx = currentEditor.instance.state.doc.line(res.line + 1).from
    for (const range of res.ranges) {
      const { from, to } = range
      rangesToHighlight.push(EditorSelection.range(startIdx + from, startIdx + to))
    }
  }
  currentEditor.highlightRanges(rangesToHighlight)
}

</script>

<style lang="less">
// Editor Geometry

// Editor margins left and right for all breakpoints in both fullscreen and
// normal mode.
@editor-margin-fullscreen-sm:  50px;
@editor-margin-fullscreen-md:   5vw;
@editor-margin-fullscreen-lg:  10vw;
@editor-margin-fullscreen-xl:  20vw;
@editor-margin-fullscreen-xxl: 30vw;

.main-editor-wrapper {
  width: 100%;
  height: 100%;
  overflow-x: hidden;
  overflow-y: auto;
  background-color: #ffffff;
  transition: 0.2s background-color ease;
  position: relative;

  // The left and right padding follows the toolbar's Margin control (R81)
  .cm-editor {
    .cm-scroller { padding: 50px var(--zettlr-editor-margin, 50px); }
    .cm-content { min-width: 0; }
  }

  .cm-lineNumbers { font-size: var(--zettlr-line-number-font-size); }

  // Markdown text is justified; code files keep their ragged right edge.
  // Code block lines stay left-aligned: justification would stretch their
  // leading indentation and push wrapped lines' content to the right edge.
  &:not(.code-file) .cm-content .cm-line { text-align: justify; }
  &:not(.code-file) .cm-content .cm-line.code-block-line { text-align: left; }

  // If a code file is loaded, we need to display the editor contents in monospace.
  &.code-file .cm-editor {
    font-family: Inconsolata, monospace;

    // Reset the margins for code files
    .cm-scroller { padding: 0px; }
  }
}

body.dark .main-editor-wrapper {
  background-color: #2b2b2c;
}

// CodeMirror fullscreen
.main-editor-wrapper.fullscreen {
  // This makes the editor pane show "fullscreen" on top over the rest of the UI
  // except the toolbar (due to a position: relative on the window content div).
  position: absolute;
  top: 0;

  .cm-scroller {
    @media(min-width: 1301px) { padding: 0 @editor-margin-fullscreen-xxl; }
    @media(max-width: 1300px) { padding: 0 @editor-margin-fullscreen-xl; }
    @media(max-width: 1100px) { padding: 0 @editor-margin-fullscreen-lg; }
    @media(max-width: 1000px) { padding: 0 @editor-margin-fullscreen-md; }
    @media(max-width:  800px) { padding: 0 @editor-margin-fullscreen-sm; }

  }
}

body.darwin {
    .main-editor-wrapper.fullscreen {
      border-top: 1px solid #d5d5d5;
  }

  &.dark {
    .main-editor-wrapper.fullscreen {
      border-top-color: #505050;
    }
  }
}

</style>
