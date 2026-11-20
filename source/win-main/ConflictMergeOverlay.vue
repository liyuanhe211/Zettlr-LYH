<template>
  <!-- Mounted by the editor pane that is the target of the comparison; it covers
       only that pane's editor area. While another tab of the pane is active it
       is hidden, not destroyed -->
  <div
    class="conflict-merge-overlay"
    v-bind:class="{ 'conflict-merge-hidden': !props.active }"
    role="region"
    v-bind:aria-label="`Compare the two versions of ${fileName}`"
    v-bind:aria-hidden="props.active ? undefined : 'true'"
    v-bind:style="overlayStyle"
    v-on:keydown.esc.stop
  >
    <div class="conflict-merge-header">
      <div class="conflict-merge-header-text">
        <div class="conflict-merge-title" v-bind:title="props.filePath">
          {{ fileName }}
        </div>
        <div class="conflict-merge-description">
          {{ text.description }}
        </div>
      </div>
      <button
        type="button"
        class="conflict-merge-button conflict-merge-toggle"
        v-bind:aria-pressed="showOnlyDifferences ? 'true' : 'false'"
        v-bind:title="text.showOnlyDifferencesTooltip"
        v-on:click="showOnlyDifferences = !showOnlyDifferences"
      >{{ text.showOnlyDifferences }}</button>
    </div>
    <div v-if="pendingDisk !== undefined" class="conflict-merge-warning" role="alert">
      <span class="conflict-merge-banner-text">{{ text.diskChangedAgainWarning }}</span>
      <button
        type="button"
        class="conflict-merge-button"
        v-bind:disabled="submitting"
        v-on:click="loadNewestDiskVersion()"
      >{{ text.loadNewestDiskVersion }}</button>
    </div>
    <div v-else-if="diskReplacedNotice" class="conflict-merge-notice" role="status">
      {{ text.diskChangedAgainReplaced }}
    </div>
    <div class="conflict-merge-labels">
      <div class="conflict-merge-label-cell">
        <div class="conflict-merge-label">{{ text.diskTitle }}</div>
        <div class="conflict-merge-label-info">{{ diskInfo }}</div>
      </div>
      <div class="conflict-merge-label-gap"></div>
      <div class="conflict-merge-label-cell">
        <div class="conflict-merge-label">{{ text.editorTitle }}</div>
        <div class="conflict-merge-label-info">{{ editorInfo }}</div>
      </div>
    </div>
    <div ref="mergeContainer" class="conflict-merge-editors"></div>
    <div v-if="errorMessage !== ''" class="conflict-merge-error" role="alert">
      {{ errorMessage }}
    </div>
    <div class="conflict-merge-footer">
      <div class="conflict-merge-footer-cell">
        <button
          type="button"
          class="conflict-merge-button primary"
          v-bind:aria-label="text.keepDiskAriaLabel"
          v-bind:disabled="commitDisabled"
          v-on:click="commit('keep-left')"
        >{{ text.keepThisVersion }}</button>
      </div>
      <div class="conflict-merge-footer-cell conflict-merge-footer-center">
        <button
          type="button"
          class="conflict-merge-button"
          v-bind:title="text.saveBothDescription"
          v-bind:aria-label="text.saveBothDescription"
          v-bind:disabled="commitDisabled"
          v-on:click="commit('save-both')"
        >{{ text.saveBoth }}</button>
      </div>
      <div class="conflict-merge-footer-cell">
        <button
          type="button"
          class="conflict-merge-button primary"
          v-bind:aria-label="text.keepEditorAriaLabel"
          v-bind:disabled="commitDisabled"
          v-on:click="commit('keep-right')"
        >{{ text.keepThisVersion }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ConflictMergeOverlay
 * CVM-Role:        View
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH conflict merge (R47, rewritten for R138): the
 *                  comparison view that opens when a file was modified on disk
 *                  while the editor holds unsaved changes. It covers the editor
 *                  area of the pane that is the target of the comparison (the
 *                  pane mounts it; it is hidden, not destroyed, while another
 *                  tab of the pane is active). The version on disk is on the
 *                  left, the editor's version on the right, and both panes are
 *                  editable with their own undo history. Blocks are copied
 *                  between the panes by the buttons in the column between them
 *                  (ConflictMergeSyncColumn). The three buttons below submit the
 *                  left pane, the right pane, or the left pane as the file and
 *                  the right pane as a copy next to it; there is no way to
 *                  close the view without a decision (Escape does nothing).
 *                  The component reports the outcome to the main process itself
 *                  and emits close afterwards; the parent decides what is shown.
 *                  If the disk changes again during the comparison, the parent
 *                  passes the newest disk version in through the props.
 *
 * END HEADER
 */

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { MergeView } from '@codemirror/merge'
import { Compartment, type Extension } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightSpecialChars,
  keymap,
  lineNumbers
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { useConfigStore } from 'source/pinia'
import { pathBasename } from '@common/util/renderer-path-polyfill'
import {
  buildCollapseUnchangedReconfiguration,
  buildCommitConflictMergeCommand,
  buildConflictMergeViewConfig,
  buildDiskVersionInfo,
  buildEditorVersionInfo,
  CONFLICT_MERGE_CENTER_COLUMN_WIDTH,
  CONFLICT_MERGE_TEXT,
  ConflictMergeSyncColumn,
  handleCommitFailure,
  parseCommitConflictMergeResult,
  type CommitConflictMergeResult,
  type ConflictMergeChoice
} from './util/conflict-merge'

const ipcRenderer = window.ipc

const props = withDefaults(defineProps<{
  filePath: string
  sessionId: string
  /** The editor's version when the comparison began (the right pane) */
  editorContents: string
  /** The newest version on disk the main process knows (the left pane) */
  diskContents: string
  diskModifiedAt?: number
  diskSize?: number
  editorEditedAt?: number
  editorSize?: number
  /** Whether the tab of this file is the active one of its pane */
  active?: boolean
}>(), {
  active: true
})

const emit = defineEmits<{
  close: [filePath: string, sessionId: string]
  refresh: [filePath: string, sessionId: string]
}>()

/** The version on disk as the left pane was last loaded with it */
interface DiskVersion {
  contents: string
  modifiedAt: number|undefined
  size: number|undefined
}

const text = CONFLICT_MERGE_TEXT
const configStore = useConfigStore()

const mergeContainer = ref<HTMLDivElement|null>(null)
const submitting = ref(false)
const errorMessage = ref('')
// R55: whether unchanged stretches are collapsed to the changed blocks plus
// a margin of context lines; off by default so the result reads as a whole
const showOnlyDifferences = ref(false)
const fileName = computed(() => pathBasename(props.filePath))
const darkMode = computed<boolean>(() => configStore.config.darkMode)

// The disk version the left pane was loaded with, the newer one the main
// process reported while the left pane holds edits (shown as a warning until
// the user loads it), and whether the left pane was swapped for a newer one
const shownDisk = ref<DiskVersion>({ contents: props.diskContents, modifiedAt: props.diskModifiedAt, size: props.diskSize })
const pendingDisk = ref<DiskVersion|undefined>(undefined)
const diskReplacedNotice = ref(false)

// The width of the vertical scrollbar of the merge view: the titles and the
// buttons below the panes keep the same width as the panes
const scrollbarWidth = ref(0)

const diskInfo = computed(() => buildDiskVersionInfo(shownDisk.value.modifiedAt, shownDisk.value.size))
const editorInfo = computed(() => buildEditorVersionInfo(props.editorEditedAt, props.editorSize))
const commitDisabled = computed(() => submitting.value || pendingDisk.value !== undefined)
const overlayStyle = computed(() => ({
  '--conflict-merge-center-width': `${CONFLICT_MERGE_CENTER_COLUMN_WIDTH}px`,
  '--conflict-merge-scrollbar-width': `${scrollbarWidth.value}px`
}))

let mergeView: MergeView|null = null
let syncColumn: ConflictMergeSyncColumn|null = null
let previouslyFocused: Element|null = null
let lastFocusedSide: 'a'|'b' = 'a'
const themeCompartment = new Compartment()

/**
 * The colors of both editors. The dark flag also switches the merge
 * package's own highlight colors, which follow EditorView.darkTheme.
 *
 * @param   {boolean}    dark  Whether the window uses the dark theme
 *
 * @return  {Extension}        The theme
 */
function buildEditorTheme (dark: boolean): Extension {
  return EditorView.theme({
    '&': {
      backgroundColor: dark ? '#2b2b2c' : '#ffffff',
      color: dark ? '#d4d4d4' : '#1f2328'
    },
    '.cm-content': {
      caretColor: dark ? '#ffffff' : '#000000'
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: dark ? '#ffffff' : '#000000'
    },
    '.cm-gutters': {
      backgroundColor: dark ? '#252526' : '#f4f5f7',
      color: dark ? '#858585' : '#6e7781',
      borderRight: dark ? '1px solid #3c3c3c' : '1px solid #dcdfe5'
    },
    '.cm-activeLine': {
      backgroundColor: dark ? 'rgba(255, 255, 255, 0.04)' : 'rgba(0, 0, 0, 0.03)'
    }
  }, { dark })
}

/**
 * Measures the vertical scrollbar of the merge view, after the column between
 * the panes redrew (which happens whenever the content or the size changed).
 */
function measureScrollbar (): void {
  const dom = mergeView?.dom
  scrollbarWidth.value = dom === undefined ? 0 : Math.max(0, dom.offsetWidth - dom.clientWidth)
}

onMounted(() => {
  previouslyFocused = document.activeElement

  const container = mergeContainer.value
  if (container === null) {
    return
  }

  syncColumn = new ConflictMergeSyncColumn({ onUpdate: measureScrollbar })

  // The pane that had the focus last gets it back when the tab comes forward
  const focusTracker = EditorView.updateListener.of(update => {
    if (update.focusChanged && update.view.hasFocus) {
      lastFocusedSide = update.view === mergeView?.b ? 'b' : 'a'
    }
  })

  const configuration = buildConflictMergeViewConfig({
    diskContents: props.diskContents,
    editorContents: props.editorContents,
    sharedExtensions: [
      lineNumbers(),
      highlightSpecialChars(),
      drawSelection(),
      EditorView.lineWrapping,
      themeCompartment.of(buildEditorTheme(darkMode.value)),
      history(),
      highlightActiveLine(),
      keymap.of([ ...defaultKeymap, ...historyKeymap ]),
      syncColumn.extension,
      focusTracker
    ]
  })

  mergeView = new MergeView({ ...configuration, parent: container })
  syncColumn.attach(mergeView)
  if (showOnlyDifferences.value) {
    mergeView.reconfigure(buildCollapseUnchangedReconfiguration(true))
  }
  if (props.active) {
    focusPane()
  }
})

onBeforeUnmount(() => {
  syncColumn?.destroy()
  syncColumn = null
  const hadFocus = mergeView?.dom.contains(document.activeElement) === true
  mergeView?.destroy()
  mergeView = null
  if (hadFocus && previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
    previouslyFocused.focus()
  }
})

watch(showOnlyDifferences, (showOnly) => {
  mergeView?.reconfigure(buildCollapseUnchangedReconfiguration(showOnly))
})

watch(darkMode, (dark) => {
  if (mergeView === null) {
    return
  }
  for (const view of [ mergeView.a, mergeView.b ]) {
    view.dispatch({ effects: themeCompartment.reconfigure(buildEditorTheme(dark)) })
  }
})

// Coming forward again (the user switched back to this tab), the comparison
// continues where it was: the pane that had the focus gets it back
watch(() => props.active, (active) => {
  if (active) {
    nextTick(() => { focusPane() }).catch(err => console.error(err))
  }
})

// The main process reported a newer version on disk: swap it in if the left
// pane was not edited, else warn and wait for the user
watch(() => [ props.diskContents, props.diskModifiedAt, props.diskSize ] as const, ([ contents, modifiedAt, size ]) => {
  applyIncomingDisk({ contents, modifiedAt, size })
})

/**
 * Focuses the pane that had the focus last (the left pane at first).
 */
function focusPane (): void {
  if (mergeView === null) {
    return
  }
  (lastFocusedSide === 'b' ? mergeView.b : mergeView.a).focus()
}

/**
 * Replaces the whole text of the left pane. The replacement is a change of
 * that pane like any other, so it is part of its undo history.
 *
 * @param   {string}  contents  The new text
 */
function replaceLeftPane (contents: string): void {
  if (mergeView === null) {
    return
  }
  mergeView.a.dispatch({ changes: { from: 0, to: mergeView.a.state.doc.length, insert: contents } })
}

/**
 * Handles a newer version on disk.
 *
 * - While the warning is up, the newest version replaces the one waiting behind
 *   the button; if the disk went back to what the left pane shows, the warning
 *   goes away.
 * - If the left pane still holds exactly the version it was loaded with, the
 *   newer version replaces it and the user is told.
 * - Else the left pane holds edits that must not be lost silently: the
 *   warning appears and the buttons below stay disabled until the user loads
 *   the newest version.
 *
 * @param   {DiskVersion}  incoming  The version on disk the main process reported
 */
function applyIncomingDisk (incoming: DiskVersion): void {
  if (mergeView === null) {
    shownDisk.value = incoming
    return
  }

  // The disk has the text the left pane was loaded with again (or still; only
  // the time or the size differ): nothing is waiting any more
  if (incoming.contents === shownDisk.value.contents) {
    shownDisk.value = incoming
    pendingDisk.value = undefined
    return
  }

  if (pendingDisk.value !== undefined) {
    pendingDisk.value = incoming
    return
  }

  if (mergeView.a.state.doc.toString() === shownDisk.value.contents) {
    replaceLeftPane(incoming.contents)
    shownDisk.value = incoming
    diskReplacedNotice.value = true
  } else {
    pendingDisk.value = incoming
  }
}

/**
 * Replaces the left pane by the newest version on disk, which discards its
 * edits (the button says so by its position next to the warning).
 */
function loadNewestDiskVersion (): void {
  const newest = pendingDisk.value
  if (newest === undefined || submitting.value) {
    return
  }
  replaceLeftPane(newest.contents)
  shownDisk.value = newest
  pendingDisk.value = undefined
  diskReplacedNotice.value = false
}

/**
 * Submits the comparison with the chosen button. When the main process
 * refuses, the view stays open with both panes unchanged and shows the reason,
 * unless the session is gone (then the view closes) or the disk changed (then
 * the newest version is fetched and shown as described at applyIncomingDisk).
 *
 * @param   {ConflictMergeChoice}  choice  The button that was pressed
 */
async function commit (choice: ConflictMergeChoice): Promise<void> {
  if (mergeView === null || commitDisabled.value) {
    return
  }
  const leftContents = mergeView.a.state.doc.toString()
  const rightContents = mergeView.b.state.doc.toString()

  submitting.value = true
  errorMessage.value = ''

  let result: CommitConflictMergeResult
  try {
    const reply: unknown = await ipcRenderer.invoke('documents-provider', buildCommitConflictMergeCommand(props.filePath, props.sessionId, choice, leftContents, rightContents))
    result = parseCommitConflictMergeResult(reply)
  } catch (err) {
    console.error('Conflict merge: could not report the outcome to the main process', err)
    result = { ok: false, reason: 'write-failed', message: err instanceof Error ? err.message : String(err) }
  }

  if (result.ok) {
    // The buttons stay disabled: the parent removes this view next
    emit('close', props.filePath, props.sessionId)
    return
  }

  submitting.value = false
  const handling = handleCommitFailure(result, fileName.value)
  if (handling.action === 'show-error') {
    errorMessage.value = handling.text
  } else if (handling.action === 'refresh') {
    emit('refresh', props.filePath, props.sessionId)
  } else {
    emit('close', props.filePath, props.sessionId)
  }
}
</script>

<style lang="less">
// Zettlr-LYH conflict merge (R47, R138): the comparison view follows the flat
// design language of the Pandoc toolbar buttons in App.vue (square corners, 1 px
// borders, neutral and action-blue fills); body.dark switches to dark colors.
.conflict-merge-overlay {
  // It covers the editor area of its pane (the parent is positioned)
  position: absolute;
  inset: 0;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  box-sizing: border-box;
  container: conflict-merge / inline-size;
  background-color: #ffffff;
  color: #1f2328;
  // The two columns below the titles use the width the panes have: the centre
  // column holds the block buttons, the scrollbar width is measured at runtime
  --conflict-merge-center-width: 60px;
  --conflict-merge-scrollbar-width: 0px;

  // The tab of another file is active: the view stays alive (so that both
  // panes keep their text, undo history and scroll position) but neither
  // shows nor takes input
  &.conflict-merge-hidden {
    visibility: hidden;
    pointer-events: none;
  }

  .conflict-merge-header {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 8px 16px;
    border-bottom: 1px solid #dcdfe5;
  }

  .conflict-merge-header-text {
    flex: 1 1 auto;
    min-width: 0;
  }

  .conflict-merge-title {
    font-weight: bold;
    font-size: 15px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .conflict-merge-description {
    margin-top: 4px;
    font-size: 13px;
    color: #4b5563;
  }

  .conflict-merge-notice,
  .conflict-merge-warning {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 16px;
    font-size: 13px;
    border-bottom: 1px solid #dcdfe5;
  }

  .conflict-merge-notice {
    background-color: #e6f2ff;
    color: #1a3d6b;
  }

  .conflict-merge-warning {
    background-color: #fff4ce;
    color: #7a5200;
    font-weight: bold;

    .conflict-merge-banner-text {
      flex: 1 1 auto;
      min-width: 0;
    }
  }

  // The titles above the panes and the buttons below them share the columns
  // of the panes: left pane, centre column, right pane
  .conflict-merge-labels,
  .conflict-merge-footer {
    display: grid;
    grid-template-columns: minmax(0, 1fr) var(--conflict-merge-center-width) minmax(0, 1fr);
    padding-right: var(--conflict-merge-scrollbar-width);
  }

  .conflict-merge-labels {
    background-color: #eceef2;
    border-bottom: 1px solid #dcdfe5;
  }

  .conflict-merge-label-cell {
    min-width: 0;
    padding: 4px 8px;
  }

  .conflict-merge-label {
    font-size: 13px;
    font-weight: bold;
    color: #374151;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .conflict-merge-label-info {
    font-size: 12px;
    color: #6b7280;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .conflict-merge-editors {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    font-size: 14px;
    background-color: #ffffff;

    // The merge view itself is the scroll container (both editors take their
    // natural height inside it, so that their lines stay aligned)
    .cm-mergeView {
      height: 100%;
    }

    // The column between the panes (drawn by ConflictMergeSyncColumn)
    .conflict-merge-sync-column {
      box-sizing: border-box;
      align-self: stretch;
      background-color: #eceef2;
      border-left: 1px solid #dcdfe5;
      border-right: 1px solid #dcdfe5;

      .conflict-merge-sync-pair {
        position: absolute;
        left: 0;
        right: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 2px;
      }

      // Neutralize the global body.win32 button style (min-width 50px, 8px
      // padding, 2px border, white fill); these are clearly buttons: opaque
      // blue fill, 1 px border, hand cursor, and a visible reaction to the
      // mouse and the keyboard focus
      button.conflict-merge-sync-button {
        box-sizing: border-box;
        display: block;
        width: calc(100% - 6px);
        min-width: 0;
        height: 26px;
        min-height: 26px;
        margin: 0;
        padding: 0;
        border: 1px solid #3b78d1;
        border-radius: 0;
        background-color: #d6e8fa;
        background-image: none;
        box-shadow: none;
        color: #1a3d6b;
        font-size: 16px;
        font-weight: bold;
        line-height: 1;
        text-align: center;
        cursor: pointer;

        &:hover,
        &:focus-visible {
          background-color: #a9cbee;
          border-color: #1f5fb8;
        }

        &:focus-visible {
          outline: 2px solid #1f5fb8;
          outline-offset: 1px;
        }

        &:active {
          background-color: #8fb8e6;
        }
      }

      button.conflict-merge-selection-button {
        position: absolute;
        left: 3px;
        right: 3px;
        box-sizing: border-box;
        height: 40px;
        min-width: 0;
        margin: 0;
        padding: 0 1px;
        border: 1px solid #1f5fb8;
        border-radius: 0;
        background-color: #3b78d1;
        background-image: none;
        box-shadow: none;
        color: #ffffff;
        font-size: 10px;
        font-weight: bold;
        line-height: 14px;
        white-space: normal;
        text-align: center;
        cursor: pointer;

        &:hover:not(:disabled),
        &:focus-visible {
          background-color: #1f5fb8;
          border-color: #17468a;
        }

        &:focus-visible {
          outline: 2px solid #17468a;
          outline-offset: 1px;
        }

        &:disabled {
          background-color: #e5e7eb;
          border-color: #c0c4cc;
          color: #6b7280;
          cursor: default;
        }
      }
    }

    // The bar that stands in for a collapsed unchanged stretch while "Show
    // Only Differences" is active; a click expands the stretch
    .cm-collapsedLines {
      background: #eceef2;
      color: #374151;
      border-top: 1px solid #dcdfe5;
      border-bottom: 1px solid #dcdfe5;
      font-size: 12px;
    }
  }

  .conflict-merge-error {
    padding: 6px 16px;
    font-size: 13px;
    font-weight: bold;
    color: #b42318;
    border-top: 1px solid #dcdfe5;
  }

  .conflict-merge-footer {
    grid-template-columns: minmax(0, 1fr) max-content minmax(0, 1fr);
    column-gap: 8px;
    padding-top: 8px;
    padding-bottom: 8px;
    border-top: 1px solid #dcdfe5;

    // Every button is centered under its pane (or between the panes)
    .conflict-merge-footer-cell {
      display: flex;
      justify-content: center;
      min-width: 0;
    }

    // Reserve the button's actual width instead of overflowing the editor gap.
    .conflict-merge-footer-center .conflict-merge-button {
      flex: 0 0 auto;
      margin: 0;
      white-space: nowrap;
    }
  }

  @container conflict-merge (max-width: 560px) {
    .conflict-merge-footer {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      row-gap: 8px;

      .conflict-merge-footer-center {
        grid-column: 1 / -1;
        grid-row: 2;
      }

      .conflict-merge-footer-cell .conflict-merge-button {
        min-width: 0;
        max-width: 100%;
        white-space: normal;
      }
    }
  }

  @container conflict-merge (max-width: 300px) {
    .conflict-merge-footer-center .conflict-merge-button {
      padding-inline: 3px;
    }
  }

  .conflict-merge-button {
    flex: 0 0 auto;
    background-color: #eceef2;
    color: #374151;
    border: 1px solid #c0c4cc;
    border-radius: 0;
    padding: 4px 14px;
    font-weight: bold;
    cursor: pointer;

    &:hover:not(:disabled) {
      border-color: #3b78d1;
      color: #111827;
    }

    &:active:not(:disabled) {
      background-color: #dcdfe5;
    }

    &:disabled {
      opacity: 0.6;
      cursor: default;
    }

    &.primary {
      background-color: #d6e8fa;
      color: #1a3d6b;
      border-color: #b8d2ec;

      &:hover:not(:disabled) {
        border-color: #3b78d1;
        background-color: #e6f2ff;
      }

      &:active:not(:disabled) {
        background-color: #b8d2ec;
      }
    }

    &.conflict-merge-toggle[aria-pressed="true"] {
      background-color: #d6e8fa;
      color: #1a3d6b;
      border-color: #3b78d1;
    }
  }
}

body.dark .conflict-merge-overlay {
  background-color: #2b2b2c;
  color: #e0e0e0;

  .conflict-merge-header,
  .conflict-merge-labels,
  .conflict-merge-notice,
  .conflict-merge-warning {
    border-bottom-color: #3c3c3c;
  }

  .conflict-merge-description {
    color: #b0b0b0;
  }

  .conflict-merge-notice {
    background-color: #24476e;
    color: #e6f2ff;
  }

  .conflict-merge-warning {
    background-color: #4a3b12;
    color: #ffe08a;
  }

  .conflict-merge-labels {
    background-color: #333436;
  }

  .conflict-merge-label {
    color: #d0d0d0;
  }

  .conflict-merge-label-info {
    color: #a0a0a0;
  }

  .conflict-merge-editors {
    background-color: #2b2b2c;

    .conflict-merge-sync-column {
      background-color: #333436;
      border-left-color: #3c3c3c;
      border-right-color: #3c3c3c;

      button.conflict-merge-sync-button {
        background-color: #24476e;
        border-color: #5b9bf0;
        color: #e6f2ff;

        &:hover,
        &:focus-visible {
          background-color: #356ba3;
          border-color: #9cc6f5;
        }

        &:focus-visible {
          outline-color: #9cc6f5;
        }

        &:active {
          background-color: #1d3a5a;
        }
      }

      button.conflict-merge-selection-button {
        background-color: #3b78d1;
        border-color: #9cc6f5;
        color: #ffffff;

        &:hover:not(:disabled),
        &:focus-visible {
          background-color: #5b9bf0;
          border-color: #cfe3fb;
        }

        &:focus-visible {
          outline-color: #cfe3fb;
        }

        &:disabled {
          background-color: #3a3b3d;
          border-color: #55575b;
          color: #8a8c90;
        }
      }
    }

    .cm-collapsedLines {
      background: #333436;
      color: #d0d0d0;
      border-top-color: #3c3c3c;
      border-bottom-color: #3c3c3c;
    }
  }

  .conflict-merge-error {
    color: #ff8a80;
    border-top-color: #3c3c3c;
  }

  .conflict-merge-footer {
    border-top-color: #3c3c3c;
  }

  .conflict-merge-button {
    background-color: #3a3b3d;
    color: #e0e0e0;
    border-color: #55575b;

    &:hover:not(:disabled) {
      border-color: #3b78d1;
      color: #ffffff;
    }

    &:active:not(:disabled) {
      background-color: #303133;
    }

    &.primary {
      background-color: #24476e;
      color: #e6f2ff;
      border-color: #3b78d1;

      &:hover:not(:disabled) {
        background-color: #2c5584;
      }

      &:active:not(:disabled) {
        background-color: #1d3a5a;
      }
    }

    &.conflict-merge-toggle[aria-pressed="true"] {
      background-color: #24476e;
      color: #e6f2ff;
      border-color: #3b78d1;
    }
  }
}
</style>
