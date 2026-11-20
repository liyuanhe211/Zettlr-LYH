<template>
  <WindowChrome
    class="preferences-design"
    v-bind:title="windowTitle"
    v-bind:titlebar="true"
    v-bind:menubar="false"
    v-bind:tabbar-label="'Preferences'"
    v-bind:disable-vibrancy="!hasVibrancy"
  >
    <!--
      To comply with ARIA, we have to wrap the form in a tab container because
      we make use of the tabbar on the window chrome.
    -->
    <SplitView
      v-bind:initial-size-percent="[ 20, 80 ]"
      v-bind:minimum-size-percent="[ 20, 20 ]"
      v-bind:reset-size-percent="[ 20, 80 ]"
      v-bind:split="'horizontal'"
      v-bind:initial-total-width="100"
      v-on:wheel.capture="handleNumberWheel"
    >
      <template #view1>
        <div id="preferences-container-list">
          <TextControl
            v-model="query"
            v-bind:placeholder="searchPlaceholder"
            v-bind:search-icon="true"
            v-bind:autofocus="true"
            v-bind:reset="true"
            style="padding: 10px 10px 0px 10px;"
          ></TextControl>
          <nav aria-label="Preferences Categories" class="preferences-navigation">
            <button
              v-for="(group, index) in groups"
              v-bind:key="group.id"
              type="button"
              v-bind:class="{ selected: selectedItem === index }"
              v-bind:aria-current="selectedItem === index ? 'page' : undefined"
              v-bind:disabled="!groupHasResults(index)"
              v-bind:title="group.displayText"
              v-on:click="selectGroup(index)"
            >
              {{ group.displayText }}
            </button>
          </nav>
        </div>
      </template>
      <template #view2>
        <!--
          One long page that contains every group (or, while searching, every
          group with matches). All sections stay mounted while scrolling; the
          navigation on the left only scrolls to the group headings.
        -->
        <div
          id="preferences-scroller"
          ref="scroller"
          class="preferences-scroller"
          v-on:scroll.passive="updateActiveGroup"
        >
          <template v-if="sections.length > 0">
            <section
              v-for="(section, sectionIndex) in sections"
              v-bind:id="'preferences-group-' + section.group.id"
              v-bind:key="section.group.id"
              class="preferences-group"
              v-bind:class="{ 'pad-to-viewport': !isSearching && sectionIndex === sections.length - 1 }"
              v-bind:data-group-index="section.index"
              v-bind:aria-labelledby="'preferences-heading-' + section.group.id"
            >
              <h2 v-bind:id="'preferences-heading-' + section.group.id">
                {{ section.group.displayText }}
              </h2>
              <FormBuilder
                v-bind:model="model"
                v-bind:schema="section.schema"
                v-on:update:model-value="handleInput"
              ></FormBuilder>
            </section>
          </template>
          <div v-else id="no-results-message">
            {{ noResultsMessage }}
          </div>
        </div>
      </template>
    </SplitView>
  </WindowChrome>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Preferences
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This is the entry app for the preferences window.
 *
 * END HEADER
 */

import FormBuilder, { type FormSchema, type Fieldset } from '@common/vue/form/FormBuilder.vue'
import WindowChrome from '@common/vue/window/WindowChrome.vue'
import { trans } from '@common/i18n-renderer'

import { getGeneralFields } from './schema/general'
import { getEditorFields } from './schema/editor'
import { getCitationFields } from './schema/citations'
import { getZettelkastenFields } from './schema/zettelkasten'
import { getSpellcheckingFields } from './schema/spellchecking'
import { getAutocorrectFields } from './schema/autocorrect'
import { getAdvancedFields } from './schema/advanced'
import { ref, computed, watch, onMounted, onBeforeMount, nextTick } from 'vue'
import { resolveLangCode } from '@common/util/map-lang-code'
import SplitView from '@common/vue/window/SplitView.vue'
import type { SelectableListItem } from '@common/vue/form/elements/SelectableList.vue'
import TextControl from '@common/vue/form/elements/TextControl.vue'
import { getAppearanceFields } from './schema/appearance'
import { getFileManagerFields } from './schema/file-manager'
import { getImportExportFields } from './schema/import-export'
import { getSnippetsFields } from './schema/snippets'
import { useConfigStore } from 'source/pinia'
import { PreferencesGroups } from './schema/_preferences-groups'
import { getShortcutFields } from './schema/shortcuts'
import { findActiveGroupIndex } from './util/scroll-spy'

export type PreferencesFieldset = Fieldset & { group: PreferencesGroups }

/**
 * One group of the long preferences page: its position in the navigation, the
 * navigation entry, and the schema of its (possibly filtered) fieldsets.
 */
interface PreferencesSection {
  index: number
  group: SelectableListItem & { id: PreferencesGroups }
  schema: FormSchema
}

const ipcRenderer = window.ipc
const configStore = useConfigStore()

const hasVibrancy = computed(() => configStore.config.window.vibrancy && process.platform === 'darwin')

// The index (within the navigation) of the group that is highlighted, i.e., the
// one whose heading is currently at the top of the long page.
const currentGroup = ref(0)
const query = ref('')
// The scrolling container that holds all group sections
const scroller = ref<HTMLElement|null>(null)
// Will be populated afterwards, contains the user dict
const userDictionaryContents = ref<string[]>([])
// Will be populated afterwards, contains all dictionaries
const availableDictionaries = ref<Array<{ selected: boolean, value: string, key: string }>>([])
// Will be populated afterwards, contains the available languages
const appLangOptions = ref<Record<string, string>>({})

// This will return the full object
const config = computed(() => configStore.config)

const noResultsMessage = computed(() => trans('No results for "%s"', query.value))
const searchPlaceholder = trans('Search')

// Searching ignores case and surrounding whitespace; a query that consists of
// whitespace only does not count as a search.
const normalizedQuery = computed(() => query.value.toLowerCase().trim())
const isSearching = computed(() => normalizedQuery.value !== '')

// Only the highlighted group is selected; while searching, a group without any
// matches (which has no section on the page) cannot be highlighted.
const selectedItem = computed(() => groupHasResults(currentGroup.value) ? currentGroup.value : -1)

const fieldsets = computed<Fieldset[]>(() => {
  return [
    ...getAdvancedFields(configStore.config),
    ...getAppearanceFields(configStore.config),
    ...getAutocorrectFields(),
    ...getCitationFields(),
    ...getEditorFields(configStore.config),
    ...getFileManagerFields(configStore.config),
    ...getGeneralFields(appLangOptions.value),
    ...getImportExportFields(),
    ...getShortcutFields(configStore.config),
    ...getSnippetsFields(),
    ...getSpellcheckingFields(configStore.config),
    ...getZettelkastenFields(configStore.config)
  ]
})

const filteredFieldsets = computed(() => {
  const q = normalizedQuery.value

  if (q === '') {
    // No active search, so every group is displayed in full
    return fieldsets.value
  }

  return fieldsets.value.filter(f => {
    // BUG: Somehow TypeScript (and ESLint!) knows that everything here works
    // out but STILL insists on explicitly casting everything to boolean. I
    // don't know why.

    // Match relevancy:
    // 1. Search term is in card title
    if (Boolean(f.title.toLowerCase().includes(q))) {
      return true
    }

    if (Boolean((f.help?.toLowerCase().includes(q)))) {
      return true
    }

    for (const field of f.fields) {
      if ('label' in field && (Boolean((field.label?.toLowerCase().includes(q))))) {
        return true
      } else if ('info' in field && (Boolean((field.info?.toLowerCase().includes(q))))) {
        return true
      } else if (field.type === 'radio' || field.type === 'select') {
        for (const option in field.options) {
          if (option.toLowerCase().includes(q)) {
            return true
          }
        }
      }
    }
    return false
  })
})

const groups = computed<Array<SelectableListItem & { id: PreferencesGroups }>>(() => {
  return [
    {
      displayText: trans('General'),
      icon: 'cog',
      id: PreferencesGroups.General
    },
    {
      displayText: trans('Appearance'),
      icon: 'paint-roller',
      id: PreferencesGroups.Appearance
    },
    {
      displayText: trans('File Manager'),
      icon: 'folder-open',
      id: PreferencesGroups.FileManager
    },
    {
      displayText: trans('Editor'),
      icon: 'align-left-text',
      id: PreferencesGroups.Editor
    },
    {
      displayText: trans('Spellchecking'),
      icon: 'text',
      id: PreferencesGroups.Spellchecking
    },
    {
      displayText: trans('Autocorrect'),
      icon: 'wand', // 'block-quote'
      id: PreferencesGroups.Autocorrect
    },
    {
      displayText: trans('Citations'),
      icon: 'chat-bubble',
      id: PreferencesGroups.Citations
    },
    {
      displayText: trans('Shortcuts'),
      icon: 'keyboard',
      id: PreferencesGroups.Shortcuts
    },
    {
      displayText: trans('Zettelkasten'),
      icon: 'details',
      id: PreferencesGroups.Zettelkasten
    },
    {
      displayText: trans('Snippets'),
      icon: 'add-text',
      id: PreferencesGroups.Snippets
    },
    {
      displayText: trans('Import and Export'),
      icon: 'two-way-arrows',
      id: PreferencesGroups.ImportExport
    },
    {
      displayText: trans('Advanced'),
      icon: 'cpu',
      id: PreferencesGroups.Advanced
    }
  ]
})

/**
 * The sections of the long page, in the order of the navigation. Without a
 * search, every group has a section; during a search only the groups that have
 * at least one matching fieldset keep theirs. The single FormBuilder of each
 * section shows no category label, because the section heading names the group.
 */
const sections = computed<PreferencesSection[]>(() => {
  const result: PreferencesSection[] = []

  groups.value.forEach((group, index) => {
    const groupFieldsets = filteredFieldsets.value.filter(f => f.group === group.id)

    if (isSearching.value && groupFieldsets.length === 0) {
      return
    }

    result.push({
      index,
      group,
      schema: {
        fieldsets: groupFieldsets,
        getFieldsetCategory: () => undefined
      }
    })
  })

  return result
})

// The navigation indices of all groups that currently have a section
const visibleGroupIndices = computed(() => new Set(sections.value.map(section => section.index)))

const windowTitle = computed(() => {
  if (query.value !== '') {
    return trans('Searching: %s', query.value)
  } else if (process.platform === 'darwin') {
    return groups.value[currentGroup.value].displayText
  } else {
    return trans('Preferences')
  }
})

const model = computed(() => {
  // The model to be passed on will simply be a merger of custom values
  // and the configuration object. This way we can safely change some of
  // these values without risking to overwrite the model (which we have
  // done in a previous iteration of the preferences ...)
  return {
    userDictionaryContents: userDictionaryContents.value,
    availableDictionaries: availableDictionaries.value,
    ...config.value
  }
})

/**
 * Whenever the highlighted group changes (by scrolling or by clicking a
 * navigation entry), update the window title and remember the group in the URL
 * hash. The hash holds the numeric PreferencesGroups value. It replaces the
 * current history entry so that scrolling does not pile up history entries.
 */
watch(currentGroup, () => {
  setTitle()
  history.replaceState(history.state, '', '#' + groups.value[currentGroup.value].id)
})

/**
 * When the search changes, the page content changes completely. A new search
 * starts at the top of the results. Clearing the search shows the full page
 * again and returns to the group that was highlighted at that moment. This runs
 * after the DOM has been updated so that the sections can be measured.
 */
watch(normalizedQuery, () => {
  const container = scroller.value
  if (container === null) {
    return
  }

  if (normalizedQuery.value === '') {
    scrollToGroup(currentGroup.value)
  } else {
    container.scrollTo({ top: 0, left: 0, behavior: 'instant' })
    updateActiveGroup()
  }
}, { flush: 'post' })

/**
 * Initialise values during component mount
 */
onMounted(() => {
  setTitle()
  populateDynamicValues()
  restoreGroupFromHash()
})

/**
   * Listen to events in order to adapt display.
   */
onBeforeMount(() => {
  ipcRenderer.on('dictionary-provider', (event, message) => {
    const { command } = message
    if (command === 'invalidate-dict') {
      populateDynamicValues()
    }
  })
})

/**
 * Called whenever a form value changes, and updates that specific setting.
 *
 * @param   {string}  prop  The property that has changed
 * @param   {any}     val   The value of that property.
 */
function handleInput (prop: string, val: unknown): void {
  // We do have an easy time here
  if (prop === 'userDictionaryContents') {
    // The user dictionary is not handled by the config
    ipcRenderer.invoke('dictionary-provider', {
      command: 'set-user-dictionary',
      payload: val
    })
      .catch(err => console.error(err))
  } else if (prop === 'availableDictionaries') {
    // We have to extract the selected dictionaries and send their keys only
    const enabled = (val as Array<{ selected: boolean, value: string, key: string }>)
      .filter(elem => elem.selected).map(elem => elem.key)
    configStore.setConfigValue('selectedDicts', enabled)
    // Additionally, we have to backpropagate the new stuff down the pipe
    // so that the list view has them again
  } else {
    // By default, we should have the correct value already, we just need to
    // treat (complex) lists as special (not even token inputs).

    // NOTE: Due to Vue 3 we MUST deproxy anything here. Since config values
    // are always either dictionaries, lists, or primitives, we can safely
    // do it the brute-force-way and stringify it. This will basically read
    // out every value from the proxy and store it in vanilla objects/arrays
    // again.
    configStore.setConfigValue(prop, JSON.parse(JSON.stringify(val)))
  }
}

/**
 * Sets the window title corresponding to the current tab.
 */
function setTitle (): void {
  if (process.platform === 'darwin') {
    // Apple's Human Interface Guidelines state the window title should be
    // the current tab.
    document.title = groups.value[currentGroup.value].displayText
  }
}

/**
 * Populates dynamic fields (that is, those configurations that are not
 * controlled by the configuration provider).
 */
function populateDynamicValues (): void {
  // Get a list of all available languages
  ipcRenderer.invoke('application', {
    command: 'get-available-languages'
  })
    .then((languages) => {
      const options: Record<string, string> = {}
      languages.map((lang: string) => {
        options[lang] = resolveLangCode(lang, 'name')
        return null
      })
      appLangOptions.value = options
    })
    .catch(err => console.error(err))

  // Also, get a list of all available dictionaries
  ipcRenderer.invoke('application', {
    command: 'get-available-dictionaries'
  })
    .then((dictionaries) => {
      const values: Array<{ selected: boolean, value: string, key: string }> = []
      dictionaries.map((dict: string) => {
        values.push({
          selected: model.value.selectedDicts.includes(dict),
          value: resolveLangCode(dict, 'name'),
          key: dict
        })
        return null
      })

      availableDictionaries.value = values
    })
    .catch(err => console.error(err))

  // Retrieve the user dictionary
  ipcRenderer.invoke('dictionary-provider', {
    command: 'get-user-dictionary'
  })
    .then((dictionary) => {
      userDictionaryContents.value = dictionary
    })
    .catch(err => console.error(err))
}

/**
 * Returns true if the group at the given navigation index has a section on the
 * page. Without a search, this is the case for all groups.
 *
 * @param   {number}  which  The navigation index of the group.
 *
 * @return  {boolean}        Whether the group has a section.
 */
function groupHasResults (which: number): boolean {
  return visibleGroupIndices.value.has(which)
}

/**
 * Highlights a group and jumps (without animation) to its heading.
 *
 * @param   {number}  which  The navigation index of the group.
 */
function selectGroup (which: number): void {
  if (!groupHasResults(which)) {
    return
  }

  currentGroup.value = which
  scrollToGroup(which)
}

/**
 * Scrolls the long page so that the heading of the given group is at the top.
 *
 * @param   {number}  which  The navigation index of the group.
 */
function scrollToGroup (which: number): void {
  const container = scroller.value
  const group = groups.value[which]
  if (container === null || group === undefined) {
    return
  }

  const section = container.querySelector<HTMLElement>('#preferences-group-' + group.id)
  if (section === null) {
    return
  }

  container.scrollTo({ top: section.offsetTop, left: 0, behavior: 'instant' })
}

/**
 * Reads the position of every section heading and highlights the group that
 * the scroll spy considers active. Runs on every scroll event.
 */
function updateActiveGroup (): void {
  const container = scroller.value
  if (container === null) {
    return
  }

  const elements = Array.from(container.querySelectorAll<HTMLElement>('section.preferences-group'))
  if (elements.length === 0) {
    return
  }

  const active = findActiveGroupIndex(
    elements.map(element => element.offsetTop),
    container.scrollTop,
    container.clientHeight,
    container.scrollHeight
  )

  const index = parseInt(elements[active].dataset.groupIndex ?? '', 10)
  if (!Number.isNaN(index)) {
    currentGroup.value = index
  }
}

/**
 * If the URL hash contains the numeric value of a preferences group, highlight
 * that group and scroll to it as soon as the freshly mounted page is rendered.
 */
function restoreGroupFromHash (): void {
  if (location.hash === '') {
    return
  }

  const groupId = parseInt(location.hash.substring(1), 10)
  if (!Object.values(PreferencesGroups).includes(groupId)) {
    return
  }

  const index = groups.value.findIndex(group => group.id === groupId)
  if (index < 0) {
    return
  }

  currentGroup.value = index
  nextTick()
    .then(() => { scrollToGroup(index) })
    .catch(err => console.error(err))
}

function handleNumberWheel (event: WheelEvent): void {
  if (event.target instanceof HTMLInputElement && event.target.type === 'number') {
    event.preventDefault()
  }
}
</script>

<style lang="less">
// PyQt6-GUI-Design-Rules-LYH: keep this palette local to Preferences,
// including when the editor uses a dark theme. Native inputs retain their
// model bindings and keyboard behavior underneath the toggle/segment visuals.
body #window-frame.preferences-design {
  --preferences-row-height: 30px;
  color-scheme: light;
  background: #f5f6f8;
  color: #1f2227;
  font: 13px system-ui, "Microsoft YaHei UI", sans-serif;

  *, *::before, *::after { box-sizing: border-box; }
  button, input, select, textarea { font: inherit; box-shadow: none; border-radius: 0; }
  button:focus, input:focus, select:focus { outline: none; }
  label { color: #374151; background: transparent; }
  #window-chrome, #window-content, #titlebar {
    background: #f5f6f8;
    color: #1f2227;
  }
  .split-view { height: 100%; background: #f5f6f8; }
  .split-view > .view { min-width: 0; overflow: auto; }
  .split-view > .view-border { border-left: 1px solid #d1d5db; }
  .horizontal-resizer { background: #d1d5db; }
  #preferences-container-list { padding: 2px 4px 12px; }
  .preferences-navigation { display: grid; gap: 6px; padding: 12px 10px; }
  .preferences-navigation button {
    width: 100%; min-width: 0; padding: 0 10px;
    text-align: left; text-overflow: ellipsis; overflow: hidden;
    background: #ffffff; color: #374151; font-weight: normal;
  }
  .preferences-navigation button.selected {
    background: #d6e8fa; color: #1a3d6b;
    border: 2px solid #3b78d1; font-weight: bold;
  }
  // A group without search results: dimmed, and no hover colour (the generic
  // hover rule only applies to enabled buttons).
  .preferences-navigation button:disabled {
    opacity: 0.45; background: #ffffff; color: #374151; border-color: #c0c4cc;
    cursor: default;
  }

  // The long page: one scrolling container that holds a section per group. The
  // container is positioned so that the offsetTop of a section is its position
  // within the scrolled content.
  .preferences-scroller { position: relative; height: 100%; overflow: auto; }
  .preferences-group { min-width: 0; border-top: 1px solid #d1d5db; }
  .preferences-group:first-child { border-top: none; }
  // Without a search, the last section is at least as tall as the viewport, so
  // that every heading (also the last one) can be scrolled to the top.
  .preferences-group.pad-to-viewport { min-height: 100%; }
  .preferences-group > h2 {
    margin: 0; padding: 14px 14px 0;
    color: #111827; font-size: 18px; font-weight: bold; line-height: 1.3;
  }
  .form-container { padding: 12px 14px; }
  .form-container fieldset {
    min-width: 0; margin: 0 0 14px; padding: 0 0 6px;
    border: none; border-radius: 0; background: transparent; color: #374151;
  }
  .form-container .form-header {
    padding: 0 0 6px; margin-bottom: 10px;
    background: transparent; border-bottom: 1px solid #d1d5db;
  }
  .form-header legend { color: #111827; font-size: 15px; font-weight: bold; }
  .form-header .form-help {
    background: #eceff4; color: #5f6b76; border: 1px solid #d1d5db; border-radius: 0;
  }
  .fieldset-category { color: #111827; font-size: 18px; font-weight: bold; }
  .fieldset-category cds-icon { display: none; }
  .form-field-info-text, .form-control .info, .cb-group .info {
    color: #5f6b76; font-size: 12px; line-height: 1.5;
  }
  .form-control { min-width: 0; margin: 6px 0; }
  .form-control > label { display: block; margin-bottom: 6px; }
  .style-group .columns {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    column-count: auto; gap: 6px 8px; align-items: start;
  }
  .style-group .columns > .form-control { margin: 0; }
  .control-grid-cell { min-width: 0; padding: 3px 6px; }
  button {
    height: var(--preferences-row-height); margin: 0; padding: 0 10px;
    border: 1px solid #c0c4cc; background: #d6e8fa; background-image: none;
    color: #1a3d6b; font-weight: bold; line-height: normal; white-space: nowrap;
    cursor: pointer;
  }
  button:hover:enabled { background: #e6f2ff; border-color: #3b78d1; }
  button:active:enabled { background: #b8d2ec; }
  button:focus-visible { outline: 1px solid #3b78d1; outline-offset: 1px; }
  button:disabled, input:disabled, select:disabled, textarea:disabled {
    background: #e5e7eb; color: #9ca3af; border-color: #d1d5db; cursor: default;
  }
  input:where(:not([type="checkbox"], [type="radio"], [type="range"])), select, textarea {
    min-width: 0; max-width: 100%; height: var(--preferences-row-height);
    padding: 2px 6px; border: 1px solid #c0c4cc;
    background: #ffffff; color: #1f2227;
  }
  textarea { height: auto; min-height: 90px; resize: vertical; }
  input:focus, select:focus, textarea:focus { border-color: #3b78d1; outline: none; }
  input[type="number"] { appearance: textfield; }
  input[type="number"]::-webkit-inner-spin-button,
  input[type="number"]::-webkit-outer-spin-button { appearance: none; margin: 0; }
  input[type="range"] { accent-color: #3b78d1; }
  .input-text-button-group, .input-button-group { min-width: 0; }
  .input-text-button-group {
    height: var(--preferences-row-height); padding: 0 4px; gap: 4px;
    grid-template-columns: 20px minmax(0, 1fr) 30px;
    border: 1px solid #c0c4cc; border-radius: 0; background: #ffffff; outline: none;
  }
  .input-text-button-group input {
    width: 100%; height: calc(var(--preferences-row-height) - 2px);
    padding: 2px 6px; margin: 0; border: none;
  }
  .input-text-button-group:focus-within { border-color: #3b78d1; outline: none; }
  .input-text-button-group:has(input:disabled) { background: #e5e7eb; border-color: #d1d5db; }
  // The clear button of the search field shows only the × glyph: no box, no
  // border, a click target of 24 by 24 pixels. It must beat the generic blue
  // button rules above, including their hover and pressed colours.
  .input-reset-button {
    width: 24px; min-width: 24px; height: 24px; padding: 0;
    background: transparent; border: 0; color: #5f6b76;
  }
  .input-reset-button:hover:enabled { background: transparent; border: 0; color: #1f2227; }
  .input-reset-button:active:enabled { background: transparent; }
  .input-reset-button:focus-visible { outline: 1px solid #3b78d1; outline-offset: -2px; }
  .input-text-button-group-icon { color: #5f6b76; }

  // Keep the real checkbox over the whole labeled row: mouse, Space,
  // disabled state, and the original change/input events still work.
  .cb-group:has(.cb-group-label), .switch-group {
    display: flex; position: relative; align-items: center;
    min-height: var(--preferences-row-height); gap: 0; margin: 6px 0;
    padding: 4px 10px; border: 1px solid #c0c4cc; border-left: 5px solid #9ca3af;
    background: #eceef2; color: #374151; font-weight: bold;
  }
  .cb-group:has(.cb-group-label) label.checkbox, .switch-group label.switch {
    display: contents !important;
  }
  .cb-group:has(.cb-group-label) .checkmark, .switch-group .toggle { display: none; }
  .cb-group:has(.cb-group-label) input[type="checkbox"], .switch-group input[type="checkbox"] {
    display: block !important; position: absolute; inset: 0;
    width: 100%; height: 100%; margin: 0; opacity: 0; z-index: 1; cursor: pointer;
  }
  .cb-group:has(.cb-group-label) .cb-group-label, .switch-group > label {
    margin: 0; color: inherit; line-height: 20px;
  }
  .cb-group:has(.cb-group-label):hover, .switch-group:hover { border-color: #3b78d1; }
  .cb-group:has(.cb-group-label):has(input:checked), .switch-group:has(input:checked) {
    background: #d4ecdf; color: #1f5a46; border-color: #9ccbb6; border-left-color: #5fae90;
  }
  .cb-group:has(.cb-group-label):has(input:checked):hover, .switch-group:has(input:checked):hover {
    background: #e3f4ea; border-color: #3b78d1; border-left-color: #5fae90;
  }
  .cb-group:has(input:focus-visible), .switch-group:has(input:focus-visible) { outline: 1px solid #3b78d1; }
  .cb-group:has(.cb-group-label):has(input:disabled), .switch-group:has(input:disabled) {
    background: #e5e7eb; color: #9ca3af; border-color: #d1d5db;
  }
  .cb-group input:disabled { cursor: default !important; }

  .radio-group-container, .radio-group-container.inline {
    display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr);
    gap: 0; margin: 6px 0; overflow-x: auto;
  }
  .radio-group, .radio-group.inline {
    display: flex; position: relative; align-items: center; justify-content: center;
    min-width: 0; min-height: var(--preferences-row-height); margin: 0; padding: 4px 10px;
    border: 1px solid #c0c4cc; background: #ffffff; color: #374151;
  }
  .radio-group + .radio-group { border-left: none; }
  .radio-group label.radio { display: contents !important; }
  .radio-group .toggle { display: none; }
  .radio-group label.radio input {
    display: block !important; position: absolute; inset: 0;
    width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer;
  }
  .radio-group-label { color: inherit; text-align: center; line-height: 20px; }
  .radio-group:hover { border-color: #3b78d1; }
  .radio-group:has(input:checked) {
    border: 2px solid #3b78d1; padding: 3px 9px;
    background: #d6e8fa; color: #1a3d6b; font-weight: bold;
  }
  .radio-group:has(input:focus-visible) { outline: 1px solid #3b78d1; outline-offset: 1px; }
  .radio-group:has(input:disabled) { background: #e5e7eb; color: #9ca3af; border-color: #d1d5db; }
  .radio-group:has(input:checked:disabled) { border-color: #9ca3af; }
  table { width: 100%; border-collapse: collapse; background: #ffffff; color: #374151; }
  th { height: var(--preferences-row-height); background: #eceff4; text-align: center; }
  th, td { padding: 4px 6px; border: 1px solid #d1d5db; }
  tr:nth-child(even) { background: #fafbfc; }
  .list-input-item td:last-child button:enabled { background: #c94040; color: #ffffff; border-color: #a83030; }
  .list-input-item td:last-child button:hover:enabled { background: #d55555; }
  #no-results-message { margin: 20vh 14px 0; color: #5f6b76; font-size: 18px; text-align: center; }
  ::-webkit-scrollbar { width: 20px; height: 20px; background: #eceef2; }
  ::-webkit-scrollbar-thumb { min-height: 24px; background: #c0c4cc; border: none; border-radius: 0; }
  ::-webkit-scrollbar-thumb:hover { background: #3b78d1; }
  ::-webkit-scrollbar-button { display: none; }

  @media (max-width: 700px) {
    .style-group .columns { grid-template-columns: minmax(0, 1fr); }
  }
}
</style>
