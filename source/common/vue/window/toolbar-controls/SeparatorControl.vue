<template>
  <div
    v-bind:id="props.control.id !== undefined ? `toolbar-${props.control.id}` : undefined"
    class="toolbar-separator"
    v-bind:class="{ 'next-to-text': props.nextToText === true }"
    role="separator"
    aria-orientation="vertical"
  ></div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Separator
 * CVM-Role:        View
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH: a thin vertical line that divides the toolbar
 *                  into groups of controls. It neither grows nor shrinks and
 *                  does not react to input; a double click on it counts as a
 *                  double click on the toolbar background (WindowToolbar.vue).
 *                  Next to a text control, the line is as tall as the text
 *                  buttons; otherwise it is short (R77, see separator-height.ts).
 *
 * END HEADER
 */

export interface ToolbarSeparatorControl {
  type: 'separator'
  id?: string
  /**
   * When false, the toolbar does not render the separator
   */
  visible?: boolean
  // Allow arbitrary properties that we ignore
  [key: string]: unknown
}

const props = defineProps<{
  control: ToolbarSeparatorControl
  /**
   * Whether a text control is the nearest visible neighbor on either side, in
   * which case the line takes the height of the text buttons
   */
  nextToText?: boolean
}>()
</script>

<style lang="less">
// The visible line is the 1 px content box. The padding on either side adds
// to the toolbar's control gap and widens the target of a double click, while
// background-clip keeps the padding transparent. Between controls without
// text, the height is about 60 % of the 28 px toolbar buttons; the colors come
// from the app-wide grey palette.
body div#toolbar .toolbar-separator {
  flex-grow: 0;
  flex-shrink: 0;
  align-self: center;
  box-sizing: content-box;
  width: 1px;
  min-width: 1px;
  height: 18px;
  padding: 0 3px;
  background-color: var(--grey-2);
  background-clip: content-box;
}

// Next to a text control, the line stretches like the text buttons do (the
// toolbar's flex row aligns its items with the default stretch), so that its
// top and bottom edges meet theirs.
body div#toolbar .toolbar-separator.next-to-text {
  align-self: stretch;
  height: auto;
}

body.dark div#toolbar .toolbar-separator {
  background-color: var(--grey-4);
}
</style>
