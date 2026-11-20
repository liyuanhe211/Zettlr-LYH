<template>
  <div
    id="toolbar"
    ref="element"
    role="toolbar"
    v-bind:class="{
      'has-rtl-traffic-lights': hasRTLTrafficLights,
      'wrap-controls': wrapControls
    }"
    v-on:dblclick="handleDoubleClick"
    v-on:mousedown="$event.preventDefault()"
  >
    <button
      v-if="canScroll"
      class="toolbar-overflow left"
      v-on:click="scrollLeft"
    >
      <cds-icon shape="step-forward-2" flip="horizontal"></cds-icon>
    </button>
    <div
      ref="scrollArea"
      class="toolbar-scroll"
      v-on:scroll="checkOverflow"
    >
      <template v-for="(item, idx) in props.controls">
        <ButtonControl
          v-if="item.type === 'button' && item.visible !== false"
          v-bind:key="idx"
          v-bind:class="{ 'join-previous': joinsPrevious(item) }"
          v-bind:control="item"
          v-bind:show-label="showLabels"
          v-bind:button-text="item.buttonText"
          v-on:click="emit('click', item.id)"
        ></ButtonControl>
        <ToggleControl
          v-if="item.type === 'toggle' && item.visible !== false"
          v-bind:key="idx"
          v-bind:class="{ 'join-previous': joinsPrevious(item) }"
          v-bind:control="item"
          v-bind:show-label="showLabels"
          v-on:toggle="emit('toggle', { id: item.id, state: $event })"
        ></ToggleControl>
        <ThreeWayToggle
          v-if="item.type === 'three-way-toggle'"
          v-bind:key="idx"
          v-bind:class="{ 'join-previous': joinsPrevious(item) }"
          v-bind:control="item"
          v-bind:show-labels="showLabels"
          v-on:toggle="emit('toggle', { id: item.id, state: $event })"
        >
        </ThreeWayToggle>
        <RingControl
          v-if="item.type === 'ring' && item.visible !== false"
          v-bind:key="idx"
          v-bind:class="{ 'join-previous': joinsPrevious(item) }"
          v-bind:control="item"
          v-bind:show-label="showLabels"
          v-bind:progress-percent="item.progressPercent"
          v-on:click="emit('click', item.id)"
        ></RingControl>
        <SearchControl
          v-if="item.type === 'search'"
          v-bind:key="idx"
          v-bind:control="item"
          v-bind:show-label="showLabels"
          v-on:update:model-value="emit('search', $event)"
        ></SearchControl>
        <SpacerControl
          v-if="item.type === 'spacer'"
          v-bind:key="idx"
          v-bind:control="item"
        ></SpacerControl>
        <SeparatorControl
          v-if="item.type === 'separator' && item.visible !== false"
          v-bind:key="idx"
          v-bind:control="item"
          v-bind:next-to-text="separatorNextToText(props.controls, idx)"
        ></SeparatorControl>
        <DragAdjustControl
          v-if="item.type === 'drag-adjust' && item.visible !== false"
          v-bind:key="idx"
          v-bind:class="{ 'join-previous': joinsPrevious(item) }"
          v-bind:control="item"
          v-on:drag="forwardDrag(item, $event)"
        ></DragAdjustControl>
        <TextControl
          v-if="item.type === 'text' && item.visible !== false"
          v-bind:key="idx"
          v-bind:class="{ 'join-previous': joinsPrevious(item) }"
          v-bind:control="item"
          v-on:click="emit('click', item.id)"
        ></TextControl>
        <IrisIndicator
          v-if="item.type === 'iris-indicator' && item.visible !== false"
          v-bind:id="item.id"
          v-bind:key="idx"
          v-bind:tasks-aborted="item.tasksAborted"
          v-bind:tasks-failed="item.tasksFailed"
          v-bind:tasks-in-progress="item.tasksInProgress"
          v-bind:tasks-success="item.tasksSuccess"
          v-on:click="emit('click', item.id)"
        >
        </IrisIndicator>
      </template>
    </div>
    <button
      v-if="canScroll"
      class="toolbar-overflow right"
      v-on:click="scrollRight"
    >
      <cds-icon shape="step-forward-2"></cds-icon>
    </button>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Toolbar
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Displays a window-wide toolbar.
 *
 * END HEADER
 */

import ButtonControl, { type ToolbarButtonControl } from './toolbar-controls/ButtonControl.vue'
import RingControl, { type RingProgressButtonControl } from './toolbar-controls/RingProgressButton.vue'
import ToggleControl, { type ToolbarToggleControl } from './toolbar-controls/ToggleControl.vue'
import ThreeWayToggle, { type ToolbarThreeWayControl } from './toolbar-controls/ThreeWayToggle.vue'
import SearchControl, { type ToolbarSearchControl } from './toolbar-controls/SearchControl.vue'
import SpacerControl, { type ToolbarSpacerControl } from './toolbar-controls/SpacerControl.vue'
import SeparatorControl, { type ToolbarSeparatorControl } from './toolbar-controls/SeparatorControl.vue'
import TextControl, { type ToolbarTextControl } from './toolbar-controls/TextControl.vue'
import DragAdjustControl, { type ToolbarDragAdjustControl, type ToolbarDragUpdate } from './toolbar-controls/DragAdjustControl.vue'
import { separatorNextToText } from './toolbar-controls/separator-height'
import { onMounted, onBeforeUnmount, ref, computed } from 'vue'
import IrisIndicator, { type IrisIndicatorControl } from '../IrisIndicator.vue'

export type ToolbarControl = ToolbarButtonControl|RingProgressButtonControl|
ToolbarSearchControl|ToolbarSpacerControl|ToolbarSeparatorControl|
ToolbarTextControl|ToolbarThreeWayControl|ToolbarToggleControl|
IrisIndicatorControl|ToolbarDragAdjustControl

const ipcRenderer = window.ipc

const props = defineProps<{
  controls: ToolbarControl[]
  showLabels?: boolean
  /**
   * Zettlr-LYH (R77): what happens to controls that do not fit into one row.
   * 'wrap' moves them onto further rows, 'scroll' keeps one row that scrolls
   * sideways. Defaults to 'wrap' in the main window and to 'scroll' in every
   * other window. (A string rather than a boolean, because Vue turns an
   * absent boolean property into false, which would hide the default.)
   */
  overflowMode?: 'wrap'|'scroll'
}>()

const element = ref<HTMLDivElement|null>(null)

const emit = defineEmits<{
  (e: 'click', value: string|undefined): void
  (e: 'dblclick'): void
  (e: 'toggle', value: { id: string|undefined, state: string|boolean|undefined }): void
  (e: 'search', value: string): void
  (e: 'drag', value: ToolbarDragUpdate): void
}>()

const hasRTLTrafficLights = ref<boolean>(false)

/**
 * Zettlr-LYH (R77): whether this toolbar sits in the main window. Every window
 * loads its own renderer entry point, whose URL path contains the entry's name
 * as a folder (main_window, preferences, log_viewer and so on), both on the
 * development server and in a packaged build.
 *
 * @return  {boolean}  True in the main window
 */
function isMainWindowDocument (): boolean {
  return window.location.pathname.split('/').includes('main_window')
}

// Zettlr-LYH (R77): the main window's toolbar wraps its controls onto further
// rows when one row is too narrow (user decision 107); other windows keep the
// single scrolling row.
const wrapControls = computed<boolean>(() => {
  if (props.overflowMode !== undefined) {
    return props.overflowMode === 'wrap'
  }
  return isMainWindowDocument()
})

const scrollArea = ref<HTMLDivElement|null>(null)
const canScroll = ref(false)
// To account for really small differences between `scrollWidth` and `clientWidth`
// (sometimes only fractions of a pixel), add a small additional tolerance to
// `clientWidth` to prevent erroneously displaying of the scroll buttons.
const clientWidthTolerance = 5

function checkOverflow () {
  // A wrapping toolbar never overflows sideways and shows no scroll buttons
  if (wrapControls.value) {
    canScroll.value = false
    return
  }

  if (scrollArea.value) {
    const sa = scrollArea.value
    canScroll.value = sa.scrollWidth > (sa.clientWidth + clientWidthTolerance)
  }
}

function scrollLeft () {
  scrollArea.value?.scrollBy({ left: -100, behavior: 'smooth' })
}

function scrollRight () {
  scrollArea.value?.scrollBy({ left: 100, behavior: 'smooth' })
}

onMounted(() => {
  // Make sure that (on macOS) we have the correct spacing of the toolbar.
  ipcRenderer.on('window-controls', (event, message) => {
    const { command, payload } = message
    if (command === 'traffic-lights-rtl') {
      hasRTLTrafficLights.value = payload
    }
  })

  // Also send an initial request
  ipcRenderer.send('window-controls', { command: 'get-traffic-lights-rtl' })

  checkOverflow()
  window.addEventListener('resize', checkOverflow)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', checkOverflow)
})

/**
 * Zettlr-LYH (R58): whether a control sits flush against the control before
 * it. Any control may carry the optional property `joinPrevious: true` (the
 * control interfaces accept arbitrary extra properties); the toolbar then
 * gives the control the class join-previous, whose negative left margin
 * cancels the flex gap of .toolbar-scroll, so that adjacent buttons form one
 * continuous strip. The `in` check keeps this type safe for every member of
 * the ToolbarControl union, including those that do not declare the property.
 *
 * @param   {ToolbarControl}  control  The control to inspect
 *
 * @return  {boolean}                  True if the control joins its predecessor
 */
function joinsPrevious (control: ToolbarControl): boolean {
  return 'joinPrevious' in control && control.joinPrevious === true
}

/**
 * Zettlr-LYH (R81): passes a drag update of a drag-adjust control on, both as
 * the toolbar's drag event and to the control's own onDrag callback. The
 * callback reaches the owner of the controls even where a window chrome in
 * between does not forward the drag event.
 *
 * @param   {ToolbarDragAdjustControl}  control  The control being dragged
 * @param   {ToolbarDragUpdate}         update   The drag update
 */
function forwardDrag (control: ToolbarDragAdjustControl, update: ToolbarDragUpdate): void {
  emit('drag', update)
  control.onDrag?.(update)
}

function handleDoubleClick (event: MouseEvent): void {
  // Only emit a double click event if the user double clicked on the
  // _toolbar_ or on a spacer, and not just on any button. Zettlr-LYH: a
  // separator line counts as toolbar background as well.
  const t = event.target as HTMLElement|null
  if (
    t === element.value ||
    t?.className.includes('spacer') === true ||
    t?.classList.contains('toolbar-separator') === true
  ) {
    emit('dblclick')
  }
}
</script>

<style lang="less">
body div#toolbar {
  // The space between two adjacent toolbar controls
  @control-gap: 5px;
  // The height of one row of controls: the 28 px of the toolbar buttons, which
  // a single row shows vertically centred in the 40 px toolbar
  @row-height: 28px;

  height: 40px;
  padding: 5px 10px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  position: relative;

  .toolbar-scroll {
    display: flex;
    gap: @control-gap;
    flex: 1;
    overflow-x: auto;
    scrollbar-width: none;
    -ms-overflow-style: none;

    &::-webkit-scrollbar {
      display: none;
    }

    // Zettlr-LYH (R58): a control with joinPrevious cancels the gap on its
    // left and touches the control before it
    > .join-previous {
      margin-left: -@control-gap;
    }
  }

  // Zettlr-LYH (R77): in a wrapping toolbar the controls flow onto further
  // rows instead of scrolling sideways. The toolbar keeps its single-row
  // height as a minimum (the platform blocks below replace the fixed height)
  // and grows by one row height plus the gap for every further row; the
  // window chrome is a flex column, so the window content moves down with it.
  // A single row stays vertically centred exactly as before. Every control
  // except separators and spacers is at least one row high, so that all rows
  // are equally high.
  &.wrap-controls .toolbar-scroll {
    flex-wrap: wrap;
    row-gap: @control-gap;
    overflow-x: visible;

    > :not(.toolbar-separator):not(.spacer) {
      min-height: @row-height;
    }
  }

  button cds-icon {
    width: 16px;
    height: 16px;
  }

  .toolbar-overflow {
    width: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  div.spacer {
    .size-1x { flex-grow: 1; }
    .size-3x { flex-grow: 3; }
    .size-5x { flex-grow: 5; }
  }

  div.toolbar-group {
    text-align: center;
    display: flex;

    span.toolbar-label {
      display: block;
      font-size: 10px;
      text-align: center;
    }
  }

  button {
    cursor: pointer;
    display: flex;
    justify-content: center;
    align-items: center;
    padding: 0 10px;
  }

  // Text buttons of a toolbar share one minimum width (design language:
  // buttons visible together are equal-width). A label longer than that, such
  // as Insert Two Columns, widens its own button only, which keeps the crowded
  // main toolbar from growing by the same amount for every text button.
  button.toolbar-text-button {
    min-width: 100px;
  }
}

body.darwin {
  @toolbar-height: 40px;
  @font-size: 14px;

  div#toolbar {
    // On macOS, there is no titlebar, and as such we need to make the toolbar draggable
    -webkit-app-region: drag;
    button, .toolbar-text { -webkit-app-region: no-drag; }

    height: @toolbar-height;
    font-size: @font-size;

    // Zettlr-LYH (R77): a wrapping toolbar is at least one row high and grows
    // with every further row
    &.wrap-controls {
      height: auto;
      min-height: @toolbar-height;
    }
    background-color: rgb(245, 245, 245);

    // Make space for the traffic lights, either on the left side or the right.
    &:not(.has-rtl-traffic-lights) {
      padding-left: 80px;
    }
    &.has-rtl-traffic-lights {
      padding-right: 80px;
    }

    color: rgb(100, 100, 100);

    button {
      border-radius: 4px;
      background-color: transparent;
      border: none;

      &:hover, &.toolbar-overflow {
        background-color: rgb(230, 230, 230);
      }
    }

    // Icon buttons occupy a fixed square; the toolbar's text buttons carry
    // .toolbar-text-button and size to their label instead. The min-width
    // matters: generic.css gives every Windows button min-width 50px.
    button:not(.toolbar-text-button) {
      width: 28px;
      min-width: 28px;
      height: 28px;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }
  }

  &.dark {
    // Dark styling
    div#toolbar {
      background-color: rgb(51, 51, 51);
      color: rgb(172, 172, 172);

      button:hover, button.toolbar-overflow {
        background-color: rgb(60, 60, 60);
      }

      &:window-inactive {
        background-color: rgb(34, 34, 34);
        color: rgb(100, 100, 100);
      }
    }
  }
}

body.win32 {
  @toolbar-height: 40px;
  @font-size: 14px;

  div#toolbar {
    height: @toolbar-height;
    font-size: @font-size;

    // Zettlr-LYH (R77): a wrapping toolbar is at least one row high and grows
    // with every further row
    &.wrap-controls {
      height: auto;
      min-height: @toolbar-height;
    }
    background-color: rgb(245, 245, 245);
    color: rgb(100, 100, 100);

    button {
      background-color: transparent;
      border: none;

      &:hover, &.toolbar-overflow {
        background-color: rgb(230, 230, 230);
      }
    }

    // Icon buttons occupy a fixed square; the toolbar's text buttons carry
    // .toolbar-text-button and size to their label instead. The min-width
    // matters: generic.css gives every Windows button min-width 50px.
    button:not(.toolbar-text-button) {
      width: 28px;
      min-width: 28px;
      height: 28px;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }
  }

  &.dark {
    // Dark styling
    div#toolbar {
      background-color: rgb(51, 51, 51);
      color: rgb(172, 172, 172);

      button {
        color: white;

        &:hover, &.toolbar-overflow {
          background-color: rgb(60, 60, 60,);
        }
      }

      &:window-inactive {
        background-color: rgb(34, 34, 34);
        color: rgb(100, 100, 100);
      }
    }
  }
}

body.linux {
  @toolbar-height: 40px;
  @font-size: 14px;
  @border-radius: 4px;

  div#toolbar {
    height: @toolbar-height;
    font-size: @font-size;

    // Zettlr-LYH (R77): a wrapping toolbar is at least one row high and grows
    // with every further row
    &.wrap-controls {
      height: auto;
      min-height: @toolbar-height;
    }
    background-color: rgb(245, 245, 245);
    color: rgb(100, 100, 100);

    button {
      background-color: transparent;
      border: 1px solid rgb(180, 180, 180);
      border-radius: @border-radius;
      margin: 0 4px;

      &:hover, &.toolbar-overflow {
        background-color: rgb(230, 230, 230);
      }
    }
  }

  &.dark {
    // Dark styling
    div#toolbar {
      background-color: rgb(51, 51, 51);
      color: rgb(172, 172, 172);

      button{
        color: white;

        &:hover, &.toolbar-overflow {
          background-color: rgb(60, 60, 60,);
        }
      }

      &:window-inactive {
        background-color: rgb(34, 34, 34);
        color: rgb(100, 100, 100);
      }
    }
  }
}
</style>
