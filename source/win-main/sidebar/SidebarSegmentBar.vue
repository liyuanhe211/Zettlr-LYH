<template>
  <div class="sidebar-segment-bar" role="tablist">
    <button
      v-for="segment, index in props.segments"
      v-bind:key="segment.id"
      type="button"
      role="tab"
      v-bind:data-target="segment.target"
      v-bind:aria-selected="props.currentId === segment.id ? 'true' : 'false'"
      v-bind:class="{
        'sidebar-segment': true,
        'sidebar-segment-following': index > 0,
        active: props.currentId === segment.id
      }"
      v-bind:title="segment.label"
      v-on:click="emit('select', segment.id)"
    >
      <span class="sidebar-segment-label">{{ segment.label }}</span>
    </button>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        SidebarSegmentBar
 * CVM-Role:        View
 * License:         GNU GPL v3
 *
 * Description:     The row of text buttons that switches the tabs of the right
 *                  sidebar (R111). It follows the Segment control of the PyQt6
 *                  design language: equally wide, square buttons that touch
 *                  each other and share one border; the selected button has a
 *                  light blue fill, a 2 pixel blue border and bold text. Labels
 *                  that do not fit end in an ellipsis; the full label is the
 *                  tooltip. The shared TabBar component is left untouched.
 *
 * END HEADER
 */

/**
 * One button of the segmented control
 */
export interface SidebarSegment {
  /**
   * A unique ID for the segment, reported when it is clicked
   */
  id: string
  /**
   * The ID of the panel that the segment shows (for a11y purposes)
   */
  target: string
  /**
   * The text of the button, also used as its tooltip
   */
  label: string
}

const props = defineProps<{
  segments: SidebarSegment[]
  currentId: string
}>()

const emit = defineEmits<(e: 'select', id: string) => void>()
</script>

<style lang="less">
// The selectors carry an element and two classes besides body, so that they
// win over the generic platform rules for buttons (body.win32.dark button).
body div.sidebar-segment-bar {
  // Grid tracks have equal widths whatever the borders; flex items with a
  // zero basis still grow from their padding and border boxes
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(0, 1fr);
  align-items: stretch;
  gap: 0;
  padding: 8px;
  background-color: #f5f6f8;
  border-bottom: 1px solid #d1d5db;

  button.sidebar-segment {
    min-width: 0;
    box-sizing: border-box;
    height: 30px;
    margin: 0;
    padding: 0 6px;
    border: 1px solid #c0c4cc;
    border-radius: 0;
    background-color: #ffffff;
    background-image: none;
    box-shadow: none;
    color: #374151;
    font-family: system-ui, "Microsoft YaHei UI", sans-serif;
    font-size: 12px;
    font-weight: normal;
    line-height: 1;
    text-align: center;
    white-space: nowrap;
    overflow: hidden;
    cursor: pointer;

    // Adjacent buttons share one border
    &.sidebar-segment-following { border-left: none; }

    &:hover:not(.active) {
      border-color: #3b78d1;
      color: #111827;
    }

    &.active {
      background-color: #d6e8fa;
      color: #1a3d6b;
      border: 2px solid #3b78d1;
      font-weight: bold;
    }

    &:focus-visible {
      outline: 1px dotted #3b78d1;
      outline-offset: -4px;
    }

    span.sidebar-segment-label {
      display: block;
      // A full line box, so that the overflow clip keeps the descenders
      line-height: normal;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
  }
}

// Dark mode: the same shapes with the dark colours of Zettlr; the selected
// button keeps a blue border on a dark blue fill instead of a light block.
body.dark div.sidebar-segment-bar {
  background-color: rgb(37, 37, 38);
  border-bottom-color: rgb(70, 70, 70);

  button.sidebar-segment {
    background-color: rgb(50, 50, 50);
    border-color: rgb(90, 90, 90);
    color: rgb(215, 215, 215);

    &:hover:not(.active) {
      border-color: #5b9bf0;
      color: rgb(240, 240, 240);
    }

    &.active {
      background-color: rgb(30, 58, 95);
      color: rgb(214, 232, 250);
      border-color: #5b9bf0;
    }

    &:focus-visible { outline-color: #5b9bf0; }
  }
}
</style>
