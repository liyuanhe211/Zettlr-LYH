<template>
  <div ref="tocPanel" role="tabpanel" v-bind:class="{ 'toc-no-wrap': !wrapHeadings }">
    <!-- Display options of the Table of Contents -->
    <div class="toc-display-options">
      <label class="toc-max-level-option">
        {{ showHeadingsLabel }}
        <select
          class="toc-max-level-select"
          v-bind:class="{ 'toc-max-level-all': maxHeadingLevel === DEEPEST_HEADING_LEVEL }"
          v-bind:value="maxHeadingLevel"
          v-on:change="setMaxHeadingLevel"
        >
          <option
            v-for="level in DEEPEST_HEADING_LEVEL"
            v-bind:key="level"
            v-bind:value="level"
          >
            {{ headingLevelLabel(level) }}
          </option>
        </select>
      </label>
      <!-- A checkable button with a coloured stripe on the left (R111) -->
      <button
        type="button"
        v-bind:class="{ 'toc-wrap-option': true, checked: wrapHeadings }"
        v-bind:aria-pressed="wrapHeadings ? 'true' : 'false'"
        v-on:click="toggleWrapHeadings"
      >
        {{ wrapHeadingsLabel }}
      </button>
    </div>
    <!-- Show the ToC entries; idx is the index into the complete ToC -->
    <div
      v-for="{ idx, entry } of visibleEntries"
      v-bind:key="idx"
      v-bind:data-line="entry.line"
      v-bind:data-toc-index="idx"
      v-bind:class="'toc-entry-container toc-heading-' + entry.level"
      draggable="true"
      v-on:click="emit('jump-to-line', entry.line)"
      v-on:dragstart="startDragging"
      v-on:dragover="dragOver"
      v-on:drop="drop"
    >
      <div class="toc-level">
        {{ tocBulletForLevel(entry.level) }}
      </div>
      <div
        v-bind:class="{ 'toc-entry': true, 'toc-entry-active': idx === activeIndex }"
        v-bind:data-line="entry.line"
        v-bind:title="wrapHeadings ? undefined : tocEntryText[idx]"
      >
        <!-- eslint-disable-next-line vue/no-v-html NOTE we can only disable this error here since the entries are run through DOMPurify. -->
        <span v-html="tocEntryHTML[idx]"></span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { trans } from '@common/i18n-renderer'
import { ref, computed, watch, toRef, onMounted, nextTick } from 'vue'
import { CITEPROC_MAIN_DB } from '@dts/common/citeproc'
import { type AnyDescriptor } from '@dts/common/fsal'
import { md2html } from '@common/modules/markdown-utils'
import { useConfigStore, useDocumentTreeStore, useWindowStateStore } from 'source/pinia'
import { sanitizeHTML } from 'source/common/util/sanitize-html'
import {
  DEEPEST_HEADING_LEVEL,
  activeVisibleTocEntryIndex,
  normalizeTocMaxHeadingLevel,
  sectionDropTargetLine,
  tocBulletForLevel,
  tocReadingLine,
  tocScrollOffsetToReveal,
  visibleTocEntryIndices
} from './util/toc-display'

const ipcRenderer = window.ipc
const windowStateStore = useWindowStateStore()
const documentTreeStore = useDocumentTreeStore()
const configStore = useConfigStore()

const emit = defineEmits<{
  (e: 'move-section', data: { from: number, to: number }): void
  (e: 'jump-to-line', line: number): void
}>()

const activeFileDescriptor = ref<AnyDescriptor|null>(null)
const library = ref<string>(CITEPROC_MAIN_DB)
// The root element of this tab, inside the scrolling sidebar panel
const tocPanel = ref<HTMLDivElement|null>(null)

const tableOfContents = computed(() => windowStateStore.tableOfContents)
const tocEntryHTML = ref<string[]>([])
// Plain text of each rendered entry, shown as a tooltip when entries do not wrap
const tocEntryText = ref<string[]>([])

watch(toRef(tableOfContents), updateToCHTML)
onMounted(updateToCHTML)

const showHeadingsLabel = trans('Show headings')
const wrapHeadingsLabel = trans('Wrap Headings')

/**
 * The deepest heading level shown, from the configuration (1-6)
 */
const maxHeadingLevel = computed(() => normalizeTocMaxHeadingLevel(configStore.config.window.tocMaxHeadingLevel))

/**
 * Whether long headings wrap onto several lines (the default)
 */
// The key is missing until a running instance restarts with the new template
const wrapHeadings = computed(() => (configStore.config.window.tocWrapHeadings as boolean|undefined) !== false)

/**
 * Indices (into the complete ToC) of the entries that are shown
 */
const visibleIndices = computed(() => visibleTocEntryIndices(tableOfContents.value, maxHeadingLevel.value))

/**
 * The shown entries together with their index into the complete ToC, so that
 * data stored per entry (HTML, plain text) stays aligned
 */
const visibleEntries = computed(() => {
  const entries = tableOfContents.value
  if (entries === undefined) {
    return []
  }
  return visibleIndices.value.map(idx => ({ idx, entry: entries[idx] }))
})

/**
 * Index (into the complete ToC) of the highlighted entry, if any: the heading
 * of the line at one third of the visible height of the active editor (R112),
 * independent of the cursor. A line inside a hidden subsection highlights the
 * nearest shown parent heading. Viewers that report no such line (the JSON
 * viewer) highlight nothing.
 */
const activeIndex = computed(() => {
  if (tableOfContents.value === undefined) {
    return undefined
  }
  const line = tocReadingLine(
    windowStateStore.readingLine,
    documentTreeStore.lastLeafId,
    documentTreeStore.lastLeafActiveFile?.path
  )
  if (line === undefined) {
    return undefined
  }
  return activeVisibleTocEntryIndex(tableOfContents.value, visibleIndices.value, line)
})

// R112: when the highlight moves to another entry, scroll the sidebar panel so
// that the entry is visible. An unchanged highlight leaves the panel alone, so
// that the user can scroll the panel freely.
watch(activeIndex, (index) => {
  if (index === undefined) {
    return
  }
  nextTick(() => { revealTocEntry(index) }).catch(err => console.error(err))
})

/**
 * Scrolls the sidebar panel just far enough to show the entry with the given
 * index completely, keeping one entry height between it and the panel edge.
 * Does nothing while this tab is hidden or the entry is not shown.
 *
 * @param  {number}  index  The index of the entry in the complete ToC
 */
function revealTocEntry (index: number): void {
  const root = tocPanel.value
  if (root === null) {
    return
  }
  const panel = root.closest<HTMLElement>('#sidebar-tab-container') ?? root.parentElement
  const entry = root.querySelector<HTMLElement>(`.toc-entry-container[data-toc-index="${index}"]`)
  if (panel === null || entry === null) {
    return
  }
  const entryRect = entry.getBoundingClientRect()
  if (entryRect.height <= 0 || panel.clientHeight <= 0) {
    return // The tab is hidden
  }
  const contentTop = panel.getBoundingClientRect().top + panel.clientTop - panel.scrollTop
  const entryTop = entryRect.top - contentTop
  const entryBottom = entryRect.bottom - contentTop
  const scrollTop = tocScrollOffsetToReveal(entryTop, entryBottom, panel.scrollTop, panel.clientHeight, entryRect.height)
  if (scrollTop !== panel.scrollTop) {
    panel.scrollTop = scrollTop
  }
}

/**
 * Returns the label of an option of the heading level selector
 *
 * @param   {number}  level  The heading level
 *
 * @return  {string}         The label
 */
function headingLevelLabel (level: number): string {
  return level === DEEPEST_HEADING_LEVEL ? trans('Level 6 (all)') : trans('Level %s', level)
}

function setMaxHeadingLevel (event: Event): void {
  const value = parseInt((event.target as HTMLSelectElement).value, 10)
  configStore.setConfigValue('window.tocMaxHeadingLevel', normalizeTocMaxHeadingLevel(value))
}

function toggleWrapHeadings (): void {
  configStore.setConfigValue('window.tocWrapHeadings', !wrapHeadings.value)
}

// The descriptor of the active file only determines the citation library of
// the rendered entries; the tab shows no title line (R110)
const activeFile = computed(() => documentTreeStore.lastLeafActiveFile)

watch(activeFile, async (newValue) => {
  if (newValue === undefined) {
    activeFileDescriptor.value = null
  } else {
    const descriptor: AnyDescriptor|undefined = await ipcRenderer.invoke('fsal', {
      command: 'get-descriptor',
      payload: newValue.path
    })

    activeFileDescriptor.value = descriptor ?? null
  }
})

watch(activeFileDescriptor, (newValue) => {
  if (newValue === null || newValue.type !== 'file') {
    library.value = CITEPROC_MAIN_DB
  } else {
    const fm = newValue.frontmatter
    if (fm != null && 'bibliography' in fm && typeof fm.bibliography === 'string' && fm.bibliography.length > 0) {
      library.value = fm.bibliography
    }
  }
})

/**
 * Converts the ToC entries's texts to (safe) HTML.
 */
function updateToCHTML () {
  if (tableOfContents.value === undefined) {
    return
  }

  const promises: Promise<string>[] = []

  for (const entry of tableOfContents.value) {
    promises.push(
      md2html(entry.text, {
        onCitation: window.getCitationCallback(library.value),
        zknLinkFormat: configStore.config.zkn.linkFormat
      })
    )
  }

  Promise.all(promises)
    .then(values => {
      values = values.map(html => sanitizeHTML(html))
      tocEntryHTML.value = values
      // DOMParser documents load no resources, so images in headings are not fetched here
      const parser = new DOMParser()
      tocEntryText.value = values.map(html => {
        const text = parser.parseFromString(html, 'text/html').body.textContent ?? ''
        return text.replace(/\s+/g, ' ').trim()
      })
    })
    .catch(err => console.error(err))
}

function startDragging (event: DragEvent): void {
  if (event.currentTarget === null) {
    return
  }
  const fromLine = (event.currentTarget as HTMLElement).dataset.line
  if (fromLine !== undefined) {
    event.dataTransfer?.setData('x-zettlr/toc-drag', fromLine)
  }
}

function dragOver (event: DragEvent): void {
  const elem = document.querySelectorAll('.toc-entry-container')
  elem.forEach(e => e.classList.remove('toc-drop-effect'))
  const container = event.currentTarget as HTMLElement
  container.classList.add('toc-drop-effect')
}

function drop (event: DragEvent): void {
  if (event.currentTarget === null || event.dataTransfer === null) {
    return
  }

  const container = event.currentTarget as HTMLElement
  container.classList.remove('toc-drop-effect')

  if (container.dataset.line === undefined) {
    return
  }

  const fromLine = parseInt(event.dataTransfer.getData('x-zettlr/toc-drag'), 10)
  const toLine = parseInt(container.dataset.line, 10)
  if (fromLine === toLine) {
    return
  }

  const actualToLine = findEndOfEntry(toLine)
  if (actualToLine === undefined) {
    console.warn('Could not move section: Could not find correct target line')
    return
  }

  emit('move-section', { from: fromLine, to: actualToLine })
}

/**
 * Returns the line in front of which a section dropped onto the entry at the
 * given line is inserted: the next shown entry, so that hidden subsections of
 * the target are passed over; -1 means the end of the document.
 *
 * @param   {number}            originalToLine  The line of the target entry
 *
 * @return  {number|undefined}                  The target line, or undefined
 */
function findEndOfEntry (originalToLine: number): number|undefined {
  if (tableOfContents.value == null) {
    return
  }

  const idx = tableOfContents.value.findIndex(elem => elem.line === originalToLine)

  if (idx < 0) {
    return
  }

  return sectionDropTargetLine(tableOfContents.value, idx, maxHeadingLevel.value)
}
</script>

<style lang="less">
// Add a neat little effect to the table of content entries as you drag them
.toc-entry-container {
  border-bottom: 2px solid transparent;

  &.toc-heading-1 { margin-left: 0px; }
  &.toc-heading-2 { margin-left: 10px; }
  &.toc-heading-3 { margin-left: 20px; }
  &.toc-heading-4 { margin-left: 30px; }
  &.toc-heading-5 { margin-left: 40px; }
  &.toc-heading-6 { margin-left: 50px; }

  &.toc-drop-effect {
    border-bottom-color: rgb(40, 100, 255);
  }
}

// Display options above the Table of Contents
.toc-display-options {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 6px;
  font-size: 12px;

  label {
    display: inline-flex;
    flex-wrap: nowrap;
    flex: 0 0 auto;
    align-items: center;
    gap: 4px;
    min-width: 0;
    max-width: 100%;
    white-space: nowrap;
  }

  select { max-width: 100%; }
}

// R111: the controls of the PyQt6 design language. The selectors carry an
// element and two classes besides body, so that they win over the generic
// platform rules for inputs and buttons (body.win32.dark select).
body div.toc-display-options {
  margin-bottom: 10px;
  font-family: system-ui, "Microsoft YaHei UI", sans-serif;
  color: #5f6b76;

  select.toc-max-level-select {
    box-sizing: border-box;
    height: 30px;
    width: 66px;
    flex: 0 0 66px;
    min-width: 0;
    margin: 0;
    padding: 0 4px;
    border: 1px solid #c0c4cc;
    border-radius: 0;
    background-color: #ffffff;
    box-shadow: none;
    color: #1f2227;
    font-family: inherit;
    font-size: 12px;

    &.toc-max-level-all {
      width: 90px;
      flex-basis: 90px;
    }

    &:hover, &:focus {
      border-color: #3b78d1;
      outline: none;
    }
  }

  button.toc-wrap-option {
    box-sizing: border-box;
    flex: 0 0 auto;
    height: 30px;
    min-width: 0;
    max-width: 100%;
    margin: 0;
    padding: 0 6px;
    border: 1px solid #c0c4cc;
    border-left: 5px solid #9ca3af;
    border-radius: 0;
    background-color: #eceef2;
    background-image: none;
    box-shadow: none;
    color: #374151;
    font-family: inherit;
    font-size: 12px;
    font-weight: bold;
    white-space: nowrap;
    cursor: pointer;

    &:hover {
      border-color: #3b78d1;
      border-left-color: #9ca3af;
      color: #111827;
    }

    &.checked {
      background-color: #d4ecdf;
      color: #1f5a46;
      border-color: #9ccbb6;
      border-left-color: #5fae90;
    }

    &.checked:hover {
      background-color: #e3f4ea;
      border-color: #3b78d1;
      border-left-color: #5fae90;
    }
  }
}

// Dark mode: the same shapes with the dark colours of Zettlr (neutral greys,
// a lighter blue for focus, a dark green for the switched-on toggle)
body.dark div.toc-display-options {
  color: rgb(170, 170, 170);

  select.toc-max-level-select {
    background-color: rgb(50, 50, 50);
    border-color: rgb(90, 90, 90);
    color: rgb(230, 230, 230);

    &:hover, &:focus { border-color: #5b9bf0; }
  }

  button.toc-wrap-option {
    background-color: rgb(55, 55, 55);
    border-color: rgb(90, 90, 90);
    border-left-color: rgb(120, 120, 120);
    color: rgb(215, 215, 215);

    &:hover {
      border-color: #5b9bf0;
      border-left-color: rgb(120, 120, 120);
      color: rgb(240, 240, 240);
    }

    &.checked {
      background-color: rgb(31, 61, 50);
      color: rgb(185, 228, 207);
      border-color: rgb(63, 122, 100);
      border-left-color: #5fae90;
    }

    &.checked:hover {
      background-color: rgb(38, 74, 61);
      border-color: #5b9bf0;
      border-left-color: #5fae90;
    }
  }
}

// Without wrapping, every entry takes a single line and long headings end in an
// ellipsis; the full heading is shown in the tooltip of the entry.
.toc-no-wrap .toc-entry-container {
  min-width: 0;

  .toc-level {
    flex-shrink: 0;
    white-space: nowrap;
  }

  .toc-entry {
    flex: 1 1 0;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
}
</style>
