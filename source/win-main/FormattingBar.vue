<template>
  <div
    id="formatting-bar"
    role="toolbar"
    v-bind:aria-label="barLabel"
    v-on:mousedown="$event.preventDefault()"
  >
    <template v-for="control in controls" v-bind:key="control.id">
      <div
        v-if="control.kind === 'color'"
        class="formatting-bar-color-control"
      >
        <button
          type="button"
          class="formatting-bar-button formatting-bar-color-button"
          v-bind:title="control.title"
          v-bind:aria-label="control.title"
          aria-haspopup="true"
          v-bind:aria-expanded="openPanel === control.property"
          v-on:mousedown.prevent
          v-on:click="togglePanel(control.property, $event)"
        >
          <span
            class="formatting-color-icon"
            v-bind:class="control.property === 'color' ? 'formatting-color-icon-text' : 'formatting-color-icon-background'"
          >
            <span class="formatting-color-letter">A</span>
            <span class="formatting-color-bar"></span>
          </span>
        </button>
        <div
          v-if="openPanel === control.property"
          class="formatting-color-panel"
          v-bind:style="{ left: `${panelShift}px` }"
          v-on:mousedown.prevent
        >
          <div class="formatting-color-swatches">
            <button
              v-for="color in control.presets"
              v-bind:key="color"
              type="button"
              class="formatting-color-swatch"
              v-bind:title="color"
              v-bind:aria-label="color"
              v-bind:style="{ backgroundColor: color }"
              v-on:mousedown.prevent
              v-on:click="chooseColor(control.property, color)"
            ></button>
          </div>
          <button
            type="button"
            class="formatting-color-action"
            v-on:mousedown.prevent
            v-on:click="openSystemColorPicker($event)"
          >
            {{ customLabel }}
          </button>
          <button
            type="button"
            class="formatting-color-action"
            v-on:mousedown.prevent
            v-on:click="chooseColor(control.property, null)"
          >
            {{ removeLabel }}
          </button>
        </div>
        <!--
          The system color picker anchors at this invisible input, which stays
          in the document while the panel is open or closed
        -->
        <input
          type="color"
          class="formatting-color-input"
          value="#808080"
          tabindex="-1"
          aria-hidden="true"
          v-on:change="handleSystemColorChange(control.property, $event)"
        >
      </div>
      <div
        v-else
        class="formatting-bar-group"
      >
        <button
          type="button"
          class="formatting-bar-button"
          v-bind:title="control.title"
          v-bind:aria-label="control.title"
          v-on:mousedown.prevent
          v-on:click="emit('command', control.commandId)"
        >
          <cds-icon v-bind:shape="control.icon"></cds-icon>
        </button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Formatting Bar
 * CVM-Role:        View
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH (R174, R131): the row of formatting buttons
 *                  directly below the toolbar of the main window (Bold,
 *                  Italics, Underline, Highlight, Text Color, Background
 *                  Color, Strikethrough, Link, Image, Comment, Code). It
 *                  replaces the floating toolbar that used to appear next to a
 *                  selection. The bar only reports which button was pressed:
 *                  the command buttons send the identifier of their command,
 *                  the color panels send the property and the color. The main
 *                  window forwards both to the last focused editor.
 *
 *                  Pressing a button must not take the focus from the editor or
 *                  collapse its selection, so every mouse down in the bar
 *                  (and in the color panel) is default-prevented.
 *
 * END HEADER
 */

import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { trans } from '@common/i18n-renderer'
import {
  BACKGROUND_COLOR_PRESETS,
  TEXT_COLOR_PRESETS,
  type ColorProperty
} from '@common/modules/markdown-editor/util/text-color-span'

/**
 * What the color panels send: the property to color (`color` for the text,
 * `background-color` for the background) and the color as `#rgb` or `#rrggbb`,
 * or null to remove the color.
 */
export interface FormattingColorRequest {
  property: ColorProperty
  color: string|null
}

interface CommandControl {
  kind: 'command'
  id: string
  title: string
  icon: string
  commandId: string
}

interface ColorControl {
  kind: 'color'
  id: string
  title: string
  property: ColorProperty
  presets: readonly string[]
}

const emit = defineEmits<{
  /** A command button was pressed; the value is the identifier of its command */
  (e: 'command', commandId: string): void
  /** A color was chosen in a color panel, or the color was removed */
  (e: 'color', request: FormattingColorRequest): void
}>()

const barLabel = trans('Formatting toolbar')
const customLabel = trans('Custom…')
const removeLabel = trans('Remove Color')

// The buttons from left to right. The icons of the two color buttons are drawn
// by the template. The command identifiers begin with "markdown" so that the
// main window forwards them to the last focused editor.
const controls: Array<CommandControl|ColorControl> = [
  { kind: 'command', id: 'bold', title: trans('Bold'), icon: 'bold', commandId: 'markdownBold' },
  { kind: 'command', id: 'italic', title: trans('Italics'), icon: 'italic', commandId: 'markdownItalic' },
  { kind: 'command', id: 'underline', title: trans('Underline'), icon: 'underline', commandId: 'markdownUnderline' },
  { kind: 'command', id: 'highlight', title: trans('Highlight'), icon: 'highlighter', commandId: 'markdownHighlight' },
  { kind: 'color', id: 'text-color', title: trans('Text Color'), property: 'color', presets: TEXT_COLOR_PRESETS },
  { kind: 'color', id: 'background-color', title: trans('Background Color'), property: 'background-color', presets: BACKGROUND_COLOR_PRESETS },
  { kind: 'command', id: 'strikethrough', title: trans('Strikethrough'), icon: 'strikethrough', commandId: 'markdownStrikethrough' },
  { kind: 'command', id: 'link', title: trans('Link'), icon: 'link', commandId: 'markdownLink' },
  { kind: 'command', id: 'image', title: trans('Image'), icon: 'image', commandId: 'markdownImage' },
  { kind: 'command', id: 'comment', title: trans('Comment'), icon: 'code', commandId: 'markdownComment' },
  { kind: 'command', id: 'code', title: trans('Code'), icon: 'code-alt', commandId: 'markdownCode' }
]

// The panel that is open, if any. At most one panel is open at a time.
const openPanel = ref<ColorProperty|null>(null)
// How far the open panel moves to the left so that it stays inside the window
// (0 or negative, in pixels)
const panelShift = ref<number>(0)

// The distance the panel keeps from the right edge of the window
const WINDOW_EDGE_MARGIN = 4

function closePanel (): void {
  openPanel.value = null
  panelShift.value = 0
}

/**
 * Opens the panel of a color below its button, or closes it if it is open. The
 * other panel closes.
 *
 * @param  {ColorProperty}  property  The property of the pressed color button
 * @param  {MouseEvent}     event     The click on the button
 */
function togglePanel (property: ColorProperty, event: MouseEvent): void {
  if (openPanel.value === property) {
    closePanel()
    return
  }

  const control = (event.currentTarget as HTMLElement).closest('.formatting-bar-color-control')
  panelShift.value = 0
  openPanel.value = property

  // The panel exists only after the next render. A panel that reaches past the
  // right edge of the window moves left by the part that sticks out, but never
  // past the left edge.
  nextTick()
    .then(() => {
      const panel = control?.querySelector<HTMLElement>('.formatting-color-panel')
      const windowWidth = document.documentElement.clientWidth
      if (panel === null || panel === undefined || windowWidth <= 0) {
        return
      }
      const bounds = panel.getBoundingClientRect()
      if (bounds.right > windowWidth - WINDOW_EDGE_MARGIN) {
        panelShift.value = Math.max(windowWidth - WINDOW_EDGE_MARGIN - bounds.right, -bounds.left)
      }
    })
    .catch(err => console.error(err))
}

/**
 * Closes the panel and reports the color (null removes the color)
 *
 * @param  {ColorProperty}  property  The property to color
 * @param  {string|null}    color     The chosen color, or null
 */
function chooseColor (property: ColorProperty, color: string|null): void {
  closePanel()
  emit('color', { property, color })
}

/**
 * Opens the system color picker of the color control the button belongs to
 *
 * @param  {MouseEvent}  event  The click on the Custom… button
 */
function openSystemColorPicker (event: MouseEvent): void {
  const control = (event.currentTarget as HTMLElement).closest('.formatting-bar-color-control')
  control?.querySelector<HTMLInputElement>('input.formatting-color-input')?.click()
}

/**
 * The system color picker reports a color when it is closed with a choice that
 * differs from the value it was opened with. Only this event applies a color:
 * the input events while the user is still dragging in the picker would write
 * one undo step after the other.
 *
 * @param  {ColorProperty}  property  The property of the color control
 * @param  {Event}          event     The change event of the input
 */
function handleSystemColorChange (property: ColorProperty, event: Event): void {
  chooseColor(property, (event.target as HTMLInputElement).value)
}

/**
 * Closes the open panel when the mouse goes down anywhere except on a color
 * button or in a panel. The listener sits on the document, because the editor
 * and the rest of the window are outside of this component.
 *
 * @param  {MouseEvent}  event  The mouse down
 */
function handleDocumentMouseDown (event: MouseEvent): void {
  if (openPanel.value === null) {
    return
  }
  const target = event.target as Partial<Element>|null
  if (typeof target?.closest === 'function' && target.closest('.formatting-bar-color-control') !== null) {
    return
  }
  closePanel()
}

/**
 * Closes the open panel on Escape, and does not pass that key press on to the
 * editor.
 *
 * @param  {KeyboardEvent}  event  The key press
 */
function handleDocumentKeyDown (event: KeyboardEvent): void {
  if (event.key === 'Escape' && openPanel.value !== null) {
    closePanel()
    event.stopPropagation()
  }
}

onMounted(() => {
  document.addEventListener('mousedown', handleDocumentMouseDown, true)
  document.addEventListener('keydown', handleDocumentKeyDown, true)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', handleDocumentMouseDown, true)
  document.removeEventListener('keydown', handleDocumentKeyDown, true)
})
</script>

<style lang="less">
// Zettlr-LYH (R174): the bar takes the look of the main toolbar (see
// WindowToolbar.vue): the same background, the same 28 px icon buttons, the
// same 5 px gap, and one row is as high as a single-row toolbar. Buttons that
// do not fit in one row continue in the next row instead of scrolling.
body div#formatting-bar {
  @control-gap: 5px;
  @row-height: 28px;

  box-sizing: border-box;
  min-height: 40px;
  padding: 5px 10px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  align-content: center;
  gap: @control-gap;
  background-color: rgb(245, 245, 245);
  color: rgb(100, 100, 100);
  user-select: none;

  div.formatting-bar-group,
  div.formatting-bar-color-control {
    display: flex;
  }

  // The panel and the input of the system color picker anchor at the control
  div.formatting-bar-color-control {
    position: relative;
  }

  // The generic styles give every button of Windows a minimum width of 50 px,
  // a frame and a padding, which these buttons must not take
  button.formatting-bar-button {
    box-sizing: border-box;
    width: @row-height;
    min-width: @row-height;
    height: @row-height;
    margin: 0;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background-color: transparent;
    border: none;
    border-radius: 0;
    color: inherit;
    cursor: pointer;

    &:hover, &[aria-expanded="true"] {
      background-color: rgb(230, 230, 230);
    }

    cds-icon {
      width: 16px;
      height: 16px;
    }
  }

  // The color buttons show a letter "A" with a bar of the preset color below it
  // (text color), or on a light background (background color)
  .formatting-color-icon {
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    line-height: 1;
  }

  .formatting-color-letter {
    font-size: 15px;
    font-weight: bold;
    padding: 0 3px;
    border-radius: 2px;
  }

  .formatting-color-bar {
    display: block;
    width: 14px;
    height: 3px;
    margin-top: 1px;
    border-radius: 1px;
  }

  .formatting-color-icon-text .formatting-color-bar {
    background-color: #d32f2f;
  }

  .formatting-color-icon-background .formatting-color-bar {
    display: none;
  }

  .formatting-color-icon-background .formatting-color-letter {
    background-color: #fff59d;
    color: #333333;
  }

  // The panel with the colors opens below its button. It takes the background of
  // the bar.
  .formatting-color-panel {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 2000;
    box-sizing: border-box;
    width: 152px;
    padding: 8px;
    border: 1px solid rgba(128, 128, 128, 0.5);
    border-radius: 8px;
    background-color: rgb(245, 245, 245);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
  }

  .formatting-color-swatches {
    display: grid;
    grid-template-columns: repeat(5, 22px);
    gap: 4px;
    justify-content: center;
    margin-bottom: 6px;
  }

  button.formatting-color-swatch {
    box-sizing: border-box;
    width: 22px;
    min-width: 22px;
    height: 22px;
    margin: 0;
    padding: 0;
    border: 1px solid rgba(128, 128, 128, 0.55);
    border-radius: 4px;
    cursor: pointer;

    &:hover {
      outline: 2px solid rgba(128, 128, 128, 0.8);
      outline-offset: 1px;
    }
  }

  button.formatting-color-action {
    display: block;
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    margin: 0;
    padding: 3px 6px;
    border: none;
    border-radius: 4px;
    background-color: transparent;
    color: inherit;
    font-size: 13px;
    line-height: 18px;
    text-align: left;
    cursor: pointer;

    &:hover {
      background-color: rgba(128, 128, 128, 0.25);
    }
  }

  input.formatting-color-input {
    position: absolute;
    left: 0;
    top: 100%;
    width: 1px;
    height: 1px;
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
    opacity: 0;
    pointer-events: none;
  }
}

body.dark div#formatting-bar {
  background-color: rgb(51, 51, 51);
  color: rgb(172, 172, 172);

  button.formatting-bar-button:hover,
  button.formatting-bar-button[aria-expanded="true"] {
    background-color: rgb(60, 60, 60);
  }

  .formatting-color-panel {
    background-color: rgb(51, 51, 51);
  }

  button.formatting-color-action {
    color: rgb(200, 200, 200);
  }

  &:window-inactive {
    background-color: rgb(34, 34, 34);
    color: rgb(100, 100, 100);
  }
}

// The platforms differ only in the shape of the buttons, as on the toolbar
body.darwin div#formatting-bar button.formatting-bar-button {
  border-radius: 4px;
}

body.linux div#formatting-bar button.formatting-bar-button {
  border: 1px solid rgb(180, 180, 180);
  border-radius: 4px;
}

body.dark.win32 div#formatting-bar button.formatting-bar-button,
body.dark.linux div#formatting-bar button.formatting-bar-button {
  color: white;
}
</style>
