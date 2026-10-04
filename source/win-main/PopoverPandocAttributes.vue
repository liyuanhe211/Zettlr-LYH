<template>
  <PopoverWrapper
    v-bind:target="props.anchor"
    v-bind:persistent="true"
    v-bind:draggable="true"
    v-on:close="emit('close')"
  >
    <div ref="container" class="pandoc-attributes-popover">
      <p class="pandoc-attributes-heading popover-drag-handle" title="Drag to move the panel">
        Pandoc Attributes
      </p>
      <p v-if="props.targets.length === 0" class="pandoc-attributes-empty">
        Nothing at the cursor has Pandoc attributes to edit.
      </p>
      <section
        v-for="target in props.targets"
        v-bind:key="target.kind"
        v-bind:data-kind="target.kind"
        v-bind:class="{
          'pandoc-attributes-section': true,
          focused: target.kind === props.focusKind
        }"
      >
        <hr>
        <p class="pandoc-attributes-section-heading">
          {{ target.label }}
          <span class="pandoc-attributes-kind">{{ KIND_LABEL[target.kind] }}</span>
        </p>
        <p v-if="target.wrapsSelection === true" class="pandoc-attributes-note">
          Applying wraps the selection in a bracketed span.
        </p>
        <div
          v-for="(row, rowIndex) in rowsFor(target.kind)"
          v-bind:key="rowIndex"
          class="pandoc-attributes-row"
        >
          <template v-for="entry in row" v-bind:key="entry.key">
            <!-- Bold / Italic / Underline: Word-like tri-state icon buttons -->
            <button
              v-if="controlFor(entry) === 'cycle'"
              v-bind:class="[ 'pandoc-attributes-style-toggle', `style-${entry.key}`, cycleState(target.kind, entry.key) ]"
              v-bind:title="`${entry.label}: ${cycleStateLabel(target.kind, entry.key)} (click to change)`"
              v-bind:data-key="entry.key"
              type="button"
              v-on:click="cycleBoolean(target.kind, entry)"
            >
              {{ CYCLE_GLYPH[entry.key] }}
            </button>
            <!-- Alignment: one segmented icon button per choice -->
            <div
              v-else-if="controlFor(entry) === 'segmented'"
              class="pandoc-attributes-segmented"
              v-bind:data-key="entry.key"
            >
              <button
                v-for="choice in entry.choices ?? []"
                v-bind:key="choice"
                v-bind:class="{ active: form[target.kind][entry.key].choice === choice }"
                v-bind:title="`${entry.label}: ${choice}`"
                v-bind:data-choice="choice"
                type="button"
                v-on:click="setChoice(target.kind, entry, choice)"
              >
                <svg
                  viewBox="0 0 12 10" width="12" height="10"
                  aria-hidden="true"
                >
                  <line
                    v-for="(segment, lineIndex) in ALIGN_LINES[choice] ?? ALIGN_LINES.justify"
                    v-bind:key="lineIndex"
                    v-bind:x1="segment[0]"
                    v-bind:x2="segment[1]"
                    v-bind:y1="1.5 + lineIndex * 2.4"
                    v-bind:y2="1.5 + lineIndex * 2.4"
                  />
                </svg>
              </button>
            </div>
            <!-- Flags and classes: a plain checkbox -->
            <label v-else-if="controlFor(entry) === 'checkbox'" class="pandoc-attributes-check">
              <input
                v-model="form[target.kind][entry.key].checked"
                type="checkbox"
                v-bind:data-key="entry.key"
                v-on:change="applyField(target.kind, entry, true)"
              >
              {{ entry.label }}
            </label>
            <!-- Remaining booleans and choice keys: a labelled compact select -->
            <div
              v-else-if="controlFor(entry) === 'select'"
              class="pandoc-attributes-field"
            >
              <span class="pandoc-attributes-field-label">{{ entry.label }}</span>
              <select
                v-model="form[target.kind][entry.key].choice"
                v-bind:title="entry.hint ?? entry.label"
                v-bind:data-key="entry.key"
                v-on:change="onSelectChange(target.kind, entry)"
              >
                <option
                  v-for="(optionLabel, optionValue) in selectOptions(target, entry)"
                  v-bind:key="optionValue"
                  v-bind:value="optionValue"
                >
                  {{ optionLabel }}
                </option>
              </select>
            </div>
            <!-- Text-like keys: a labelled compact input -->
            <div
              v-else
              v-bind:class="{
                'pandoc-attributes-field': true,
                narrow: entry.type === 'size' || entry.type === 'number'
              }"
            >
              <span class="pandoc-attributes-field-label">{{ entry.label }}</span>
              <span class="pandoc-attributes-input-row">
                <input
                  v-bind:ref="element => registerInput(target.kind, entry.key, element)"
                  v-model="form[target.kind][entry.key].text"
                  type="text"
                  v-bind:placeholder="entry.hint ?? ''"
                  v-bind:title="entry.hint ?? entry.label"
                  v-bind:data-key="entry.key"
                  v-on:keydown.enter.prevent="applyField(target.kind, entry, true)"
                  v-on:blur="applyField(target.kind, entry, false)"
                >
                <span
                  v-if="entry.type === 'color' && colorPreview(form[target.kind][entry.key].text) !== undefined"
                  class="pandoc-attributes-swatch"
                  v-bind:style="{ backgroundColor: colorPreview(form[target.kind][entry.key].text) }"
                ></span>
              </span>
            </div>
            <!-- The free text of a choice key set to Custom… -->
            <div
              v-if="entry.type === 'choice' && entry.allowFreeText === true && form[target.kind][entry.key].choice === CUSTOM_CHOICE"
              class="pandoc-attributes-field"
            >
              <span class="pandoc-attributes-field-label">Custom</span>
              <input
                v-bind:ref="element => registerInput(target.kind, `${entry.key}-custom`, element)"
                v-model="form[target.kind][entry.key].text"
                type="text"
                v-bind:placeholder="entry.hint ?? ''"
                v-bind:data-key="`${entry.key}-custom`"
                v-on:keydown.enter.prevent="applyField(target.kind, entry, true)"
                v-on:blur="applyField(target.kind, entry, false)"
              >
            </div>
          </template>
        </div>
      </section>
      <hr>
      <p class="pandoc-attributes-note">
        Changes apply immediately; an emptied field removes the attribute.
      </p>
    </div>
  </PopoverWrapper>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Pandoc Attributes Panel
 * CVM-Role:        View
 *
 * Description:     A persistent panel (requirements R21/R22) that edits the
 *                  Pandoc attributes of every object around the cursor or
 *                  selection, innermost first, one section per object; the
 *                  controls are generated from the key catalog in
 *                  pandoc-attribute-schema.ts, laid out compactly (Word-like
 *                  tri-state icon buttons for bold/italic/underline, segmented
 *                  alignment icons, small labelled inputs). Every control
 *                  applies its change immediately: toggles and selects on
 *                  click, text inputs on Enter or when leaving the field; an
 *                  emptied field removes the key. The hosting editor writes
 *                  the emitted update back and refreshes the targets, which
 *                  rebuilds the form.
 *
 * END HEADER
 */
import PopoverWrapper from '@common/vue/PopoverWrapper.vue'
import { nextTick, onMounted, reactive, ref, watch } from 'vue'
import {
  PANDOC_ATTRIBUTE_SCHEMA,
  type PandocAttributeKey,
  type PandocAttributeTarget,
  type PandocAttributeTargetKind,
  type PandocAttributeUpdate
} from '@common/pandoc-util/pandoc-attribute-schema'
import type { PandocAttributeKindUpdate } from '@common/modules/markdown-editor/context-menu/pandoc-attribute-menu'

const props = defineProps<{
  /** The element the panel points at (the toolbar's Attributes button) */
  anchor: HTMLElement
  /** The editable objects, innermost first */
  targets: PandocAttributeTarget[]
  /** The object to scroll to and highlight, e.g. from a context menu's Edit All… */
  focusKind?: PandocAttributeTargetKind
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'apply', payload: { updates: PandocAttributeKindUpdate[], refocusEditor: boolean }): void
}>()

const KIND_LABEL: Record<PandocAttributeTargetKind, string> = {
  span: 'Text',
  image: 'Image',
  column: 'Column',
  table: 'Table',
  block: 'Block',
  page: 'Page'
}

/** Select value standing for "a free text value" of allowFreeText keys */
const CUSTOM_CHOICE = '__custom__'

/** Boolean keys rendered as Word-like tri-state icon buttons, and their glyphs */
const CYCLE_GLYPH: Record<string, string> = {
  bold: 'B',
  italic: 'I',
  underline: 'U'
}

/** The bar lengths of the four alignment icons (x start/end per line) */
const ALIGN_LINES: Record<string, Array<[number, number]>> = {
  left: [ [ 1, 11 ], [ 1, 7 ], [ 1, 11 ], [ 1, 7 ] ],
  center: [ [ 1, 11 ], [ 3, 9 ], [ 1, 11 ], [ 3, 9 ] ],
  right: [ [ 1, 11 ], [ 5, 11 ], [ 1, 11 ], [ 5, 11 ] ],
  justify: [ [ 1, 11 ], [ 1, 11 ], [ 1, 11 ], [ 1, 11 ] ]
}

/**
 * The compact row layout per kind: keys grouped into rows. Keys of a kind
 * that are missing here (e.g. added to the catalog later) are appended below
 * these rows, one key per row.
 */
const ROW_LAYOUT: Partial<Record<PandocAttributeTargetKind, string[][]>> = {
  span: [ [ 'bold', 'italic', 'underline', 'size', 'color' ], [ 'font', 'citation' ] ],
  block: [
    [ 'bold', 'italic', 'underline', 'size', 'color' ],
    [ 'align', 'font' ],
    [ 'line-spacing', 'space-before', 'space-after' ],
    [ 'bullet', 'indent' ]
  ],
  image: [ [ 'w', 'h' ], [ 'x', 'y', 'no-upscale' ] ],
  table: [ ['col-widths'], [ 'row-heights', 'row-height' ], [ 'font-size', 'header-fill' ] ],
  page: [ ['layout'], [ 'allow-overflow', 'no-title' ], ['id'] ]
}

interface FieldState {
  text: string
  choice: string
  checked: boolean
}

type FormState = Record<string, Record<string, FieldState>>

const container = ref<HTMLDivElement|null>(null)

/** The text inputs by `kind-key`, to focus the free-text input of Custom… */
const inputElements = new Map<string, HTMLInputElement>()

function registerInput (kind: PandocAttributeTargetKind, key: string, element: unknown): void {
  if (element instanceof HTMLInputElement) {
    inputElements.set(`${kind}-${key}`, element)
  } else {
    inputElements.delete(`${kind}-${key}`)
  }
}

/**
 * Builds the initial state of one field from the value written in the
 * Markdown source.
 *
 * @param   {PandocAttributeKey}  entry  The catalog entry
 * @param   {string|undefined}    value  The current value
 *
 * @return  {FieldState}                 The field state
 */
function initialField (entry: PandocAttributeKey, value: string|undefined): FieldState {
  const field: FieldState = { text: '', choice: '', checked: value !== undefined }
  if (entry.type === 'boolean') {
    field.choice = value ?? ''
  } else if (entry.type === 'choice') {
    const choices = entry.choices ?? []
    if (value === undefined) {
      field.choice = choices[0] ?? ''
    } else if (choices.includes(value) || entry.allowFreeText !== true) {
      field.choice = value
    } else {
      field.choice = CUSTOM_CHOICE
      field.text = value
    }
  } else {
    field.text = value ?? ''
  }
  return field
}

function buildForm (): FormState {
  const state: FormState = {}
  for (const target of props.targets) {
    state[target.kind] = {}
    for (const entry of PANDOC_ATTRIBUTE_SCHEMA[target.kind]) {
      state[target.kind][entry.key] = initialField(entry, target.values[entry.key])
    }
  }
  return state
}

// The form holds the edited state; the baseline holds the state as read from
// the source, so that a field only applies when its written value changed.
// Both are rebuilt whenever the hosting editor hands in new targets (cursor
// moved, or an update was just written back).
let baseline: FormState = buildForm()
const form = reactive<FormState>(buildForm())

function rebuildForm (): void {
  baseline = buildForm()
  // Kinds that dropped out of the targets simply stop being rendered; their
  // stale form state is overwritten on the next rebuild that includes them
  Object.assign(form, buildForm())
}

watch(() => props.targets, () => {
  rebuildForm()
  if (props.focusKind !== undefined) {
    nextTick().then(scrollToFocusedSection).catch(err => console.error(err))
  }
})

function scrollToFocusedSection (): void {
  if (props.focusKind === undefined || container.value === null) {
    return
  }
  const section = container.value.querySelector(`section[data-kind="${props.focusKind}"]`)
  section?.scrollIntoView({ block: 'start' })
}

onMounted(scrollToFocusedSection)

/**
 * The rows of catalog entries to render for one kind: the compact layout
 * first, then any catalog keys the layout does not mention.
 *
 * @param   {PandocAttributeTargetKind}  kind  The object kind
 *
 * @return  {PandocAttributeKey[][]}           Rows of entries
 */
function rowsFor (kind: PandocAttributeTargetKind): PandocAttributeKey[][] {
  const catalog = PANDOC_ATTRIBUTE_SCHEMA[kind]
  const layout = ROW_LAYOUT[kind] ?? []
  const rows: PandocAttributeKey[][] = []
  const seen = new Set<string>()
  for (const rowKeys of layout) {
    const row: PandocAttributeKey[] = []
    for (const key of rowKeys) {
      const entry = catalog.find(candidate => candidate.key === key)
      if (entry !== undefined) {
        row.push(entry)
        seen.add(key)
      }
    }
    if (row.length > 0) {
      rows.push(row)
    }
  }
  for (const entry of catalog) {
    if (!seen.has(entry.key)) {
      rows.push([entry])
    }
  }
  return rows
}

type ControlType = 'cycle' | 'segmented' | 'checkbox' | 'select' | 'text'

function controlFor (entry: PandocAttributeKey): ControlType {
  if (entry.type === 'boolean' && entry.key in CYCLE_GLYPH) {
    return 'cycle'
  }
  if (entry.key === 'align') {
    return 'segmented'
  }
  if (entry.type === 'flag' || entry.type === 'class') {
    return 'checkbox'
  }
  if (entry.type === 'boolean' || entry.type === 'choice') {
    return 'select'
  }
  return 'text'
}

/** The visual state of a tri-state icon button: default, on, or off */
function cycleState (kind: PandocAttributeTargetKind, key: string): string {
  const choice = form[kind][key].choice
  return choice === 'true' ? 'on' : choice === 'false' ? 'off' : 'default'
}

function cycleStateLabel (kind: PandocAttributeTargetKind, key: string): string {
  const state = cycleState(kind, key)
  return state === 'on' ? 'On' : state === 'off' ? 'Off' : 'Default'
}

function cycleBoolean (kind: PandocAttributeTargetKind, entry: PandocAttributeKey): void {
  const field = form[kind][entry.key]
  field.choice = field.choice === '' ? 'true' : field.choice === 'true' ? 'false' : ''
  applyField(kind, entry, true)
}

function setChoice (kind: PandocAttributeTargetKind, entry: PandocAttributeKey, choice: string): void {
  form[kind][entry.key].choice = choice
  applyField(kind, entry, true)
}

/**
 * A select changed: apply, except that switching to Custom… only reveals the
 * free-text input (which applies on Enter) and moves the focus there.
 *
 * @param   {PandocAttributeTargetKind}  kind   The object kind
 * @param   {PandocAttributeKey}         entry  The catalog entry
 */
function onSelectChange (kind: PandocAttributeTargetKind, entry: PandocAttributeKey): void {
  if (form[kind][entry.key].choice === CUSTOM_CHOICE) {
    nextTick().then(() => {
      inputElements.get(`${kind}-${entry.key}-custom`)?.focus()
    }).catch(err => console.error(err))
    return
  }
  applyField(kind, entry, true)
}

/**
 * Returns a CSS color for a RRGGBB value, or undefined if it is not one.
 *
 * @param   {string}            value  The field text
 *
 * @return  {string|undefined}         The CSS color
 */
function colorPreview (value: string): string|undefined {
  const hex = value.trim().replace(/^#/, '')
  return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex}` : undefined
}

/**
 * The options of a select: boolean keys offer default / true / false, choice
 * keys their presets. A value in the source that is none of these is kept as
 * an extra option so that the select can show it.
 *
 * @param   {PandocAttributeTarget}   target  The object
 * @param   {PandocAttributeKey}      entry   The catalog entry
 *
 * @return  {Record<string, string>}          Value to label
 */
function selectOptions (target: PandocAttributeTarget, entry: PandocAttributeKey): Record<string, string> {
  const current = target.values[entry.key]
  const options: Record<string, string> = {}
  if (entry.type === 'boolean') {
    options[''] = 'Default'
    options.true = 'Yes'
    options.false = 'No'
  } else {
    const choices = entry.choices ?? []
    choices.forEach((choice, index) => {
      if (index > 0) {
        options[choice] = choice
      } else {
        options[choice] = choice === '' ? 'Default' : `${choice} (default)`
      }
    })
    if (entry.allowFreeText === true) {
      options[CUSTOM_CHOICE] = 'Custom…'
    }
  }

  if (current !== undefined && !(current in options) && !(entry.type === 'choice' && entry.allowFreeText === true)) {
    options[current] = current
  }
  return options
}

/**
 * Returns the value a field writes: undefined removes the key.
 *
 * @param   {PandocAttributeKey}  entry  The catalog entry
 * @param   {FieldState}          field  The field state
 *
 * @return  {string|undefined}           The value
 */
function fieldValue (entry: PandocAttributeKey, field: FieldState): string|undefined {
  switch (entry.type) {
    case 'flag':
    case 'class':
      return field.checked ? '' : undefined
    case 'boolean':
      return field.choice === '' ? undefined : field.choice
    case 'choice': {
      if (field.choice === CUSTOM_CHOICE) {
        const text = field.text.trim()
        return text === '' ? undefined : text
      }
      return field.choice === (entry.choices ?? [])[0] ? undefined : field.choice
    }
    default: {
      let text = field.text.trim()
      if (entry.type === 'color') {
        text = text.replace(/^#/, '')
      }
      return text === '' ? undefined : text
    }
  }
}

/**
 * Applies one field if its written value differs from the source (R22:
 * instant apply). A choice standing on Custom… with an empty text is a
 * pending state and applies nothing.
 *
 * @param   {PandocAttributeTargetKind}  kind           The object kind
 * @param   {PandocAttributeKey}         entry          The catalog entry
 * @param   {boolean}                    refocusEditor  Hand focus back to the editor
 */
function applyField (kind: PandocAttributeTargetKind, entry: PandocAttributeKey, refocusEditor: boolean): void {
  const field = form[kind][entry.key]
  if (entry.type === 'choice' && field.choice === CUSTOM_CHOICE && field.text.trim() === '') {
    return
  }
  const before = fieldValue(entry, baseline[kind][entry.key])
  const after = fieldValue(entry, field)
  if (before === after) {
    return
  }
  // Refocusing the editor blurs a text input synchronously, which calls this
  // function a second time before the rebuild; aligning the baseline first
  // makes that call a no-op
  baseline[kind][entry.key] = { ...field }
  const update: PandocAttributeUpdate = { [entry.key]: after }
  emit('apply', { updates: [{ kind, update }], refocusEditor })
}
</script>

<style lang="less">
body {
  .pandoc-attributes-popover {
    margin: 2px;
    width: 280px;

    .pandoc-attributes-heading {
      margin: 2px 4px;
      font-weight: bold;
      cursor: move;
      user-select: none;
    }

    .pandoc-attributes-section-heading {
      margin: 2px 4px;
      font-weight: bold;

      .pandoc-attributes-kind {
        font-weight: normal;
        opacity: 0.6;
        margin-left: 5px;
      }
    }

    .pandoc-attributes-section.focused {
      border-left: 3px solid rgb(90, 160, 220);
      padding-left: 4px;
    }

    .pandoc-attributes-note, .pandoc-attributes-empty {
      margin: 2px 4px;
      opacity: 0.7;
    }

    hr {
      margin: 3px 4px;
    }

    .pandoc-attributes-row {
      display: flex;
      align-items: flex-end;
      gap: 5px;
      margin: 3px 4px;
    }

    .pandoc-attributes-field {
      display: flex;
      flex-direction: column;
      flex: 1 1 0;
      min-width: 0;

      &.narrow { flex: 0 0 52px; }

      .pandoc-attributes-field-label {
        font-size: 10px;
        opacity: 0.7;
        margin-bottom: 1px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .pandoc-attributes-input-row {
        display: flex;
        align-items: center;
        gap: 3px;
      }

      input[type="text"], select {
        height: 25px;
        width: 100%;
        min-width: 0;
        box-sizing: border-box;
        padding: 1px 4px;
        font-size: 12px;
        border: 1px solid rgb(170, 170, 170);
        border-radius: 2px;
        background-color: rgb(255, 255, 255);
        color: inherit;
      }

      select { padding: 1px 1px; }
    }

    // Word-like tri-state buttons: neutral while the renderer default holds,
    // held down in blue when forced on, struck through in red when forced off
    .pandoc-attributes-style-toggle {
      flex: 0 0 27px;
      width: 27px;
      height: 25px;
      padding: 0;
      margin: 0;
      font-size: 13px;
      line-height: 1;
      border: 1px solid rgb(170, 170, 170);
      border-radius: 2px;
      background-color: rgb(243, 244, 246);
      color: rgb(55, 65, 81);
      cursor: pointer;

      &.style-bold { font-weight: bold; }
      &.style-italic { font-style: italic; }
      &.style-underline { text-decoration: underline; }

      &:hover { border-color: rgb(59, 120, 209); }

      &.on {
        background-color: rgb(59, 120, 209);
        border-color: rgb(38, 88, 163);
        color: rgb(255, 255, 255);
      }

      &.off {
        background-color: rgb(246, 218, 218);
        border-color: rgb(196, 128, 128);
        color: rgb(138, 31, 31);
        text-decoration: line-through;

        &.style-underline { text-decoration: underline line-through; }
      }
    }

    .pandoc-attributes-segmented {
      display: flex;
      flex: 0 0 auto;

      button {
        width: 27px;
        height: 25px;
        padding: 0;
        margin: 0;
        border: 1px solid rgb(170, 170, 170);
        border-radius: 0;
        background-color: rgb(243, 244, 246);
        color: rgb(55, 65, 81);
        cursor: pointer;

        &:not(:first-child) { border-left: none; }
        &:first-child { border-radius: 2px 0 0 2px; }
        &:last-child { border-radius: 0 2px 2px 0; }
        &:hover { border-color: rgb(59, 120, 209); }

        svg { display: block; margin: 0 auto; }
        line { stroke: currentColor; stroke-width: 1.2; }

        &.active {
          background-color: rgb(59, 120, 209);
          border-color: rgb(38, 88, 163);
          color: rgb(255, 255, 255);
        }
      }
    }

    .pandoc-attributes-check {
      display: flex;
      align-items: center;
      gap: 3px;
      flex: 0 1 auto;
      white-space: nowrap;
      min-height: 25px;

      input[type="checkbox"] { margin: 0; }
    }

    .pandoc-attributes-swatch {
      display: inline-block;
      flex: 0 0 16px;
      width: 16px;
      height: 16px;
      border: 1px solid rgb(150, 150, 150);
      border-radius: 2px;
    }
  }
}

body.dark {
  .pandoc-attributes-popover {
    .pandoc-attributes-field {
      input[type="text"], select {
        background-color: rgb(40, 40, 40);
        border-color: rgb(90, 90, 90);
      }
    }

    .pandoc-attributes-style-toggle,
    .pandoc-attributes-segmented button {
      background-color: rgb(55, 55, 55);
      border-color: rgb(90, 90, 90);
      color: rgb(210, 210, 210);

      &.on, &.active {
        background-color: rgb(59, 120, 209);
        border-color: rgb(38, 88, 163);
        color: rgb(255, 255, 255);
      }
    }

    .pandoc-attributes-style-toggle.off {
      background-color: rgb(90, 50, 50);
      border-color: rgb(150, 90, 90);
      color: rgb(240, 170, 170);
    }
  }
}
</style>
