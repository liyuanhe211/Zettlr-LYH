<template>
  <div
    class="recovery-notice"
    role="alert"
  >
    <span
      class="recovery-notice-text"
      v-bind:title="noticeText"
    >{{ noticeText }}</span>
    <span
      v-if="errorMessage !== undefined"
      class="recovery-notice-error"
      v-bind:title="errorMessage"
    >{{ errorMessage }}</span>
    <button
      type="button"
      class="recovery-notice-button"
      v-bind:disabled="busy"
      v-on:click="emit('restore')"
    >
      {{ restoreLabel }}
    </button>
    <button
      type="button"
      class="recovery-notice-button"
      v-bind:disabled="busy"
      v-on:click="emit('keepAsFile')"
    >
      {{ keepAsFileLabel }}
    </button>
    <button
      type="button"
      class="recovery-notice-button"
      v-bind:disabled="busy"
      v-on:click="emit('discard')"
    >
      {{ discardLabel }}
    </button>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        RecoveryNotice
 * CVM-Role:        View
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH data loss prevention (R173, specification C21
 *                  section 6): the notice above an editor whose file has input
 *                  in the recovery journal that never reached the document.
 *                  It offers to write that input back into the document, to
 *                  keep it as a file of its own, or to discard it. The notice
 *                  only reports the choice; MainEditor.vue carries it out and
 *                  takes the notice away afterwards. It never goes away by
 *                  itself.
 *
 * END HEADER
 */

import { computed } from 'vue'
import { trans } from '@common/i18n-renderer'

const props = defineProps<{
  /** When the last input of the recoverable session was made, in milliseconds since the epoch */
  lastStepAt: number
  /** Whether a choice is being carried out; the buttons are disabled meanwhile */
  busy: boolean
  /** Shown if the last choice could not be carried out */
  errorMessage?: string
}>()

const emit = defineEmits<{
  (e: 'restore'): void
  (e: 'keepAsFile'): void
  (e: 'discard'): void
}>()

/** The local time of day as HH:MM, with 24 hours */
function timeOfDay (timestamp: number): string {
  const date = new Date(timestamp)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

const noticeText = computed<string>(() => trans('Input from %s did not reach this document.', timeOfDay(props.lastStepAt)))
const restoreLabel = trans('Restore')
const keepAsFileLabel = trans('Keep as File')
const discardLabel = trans('Discard')
</script>

<style lang="less">
// The notice is one line of a fixed height, so that the editor beneath it can
// make room for exactly that line.
@recovery-notice-height: 34px;

.main-editor-wrapper.has-recovery-notice {
  box-sizing: border-box;
  padding-top: @recovery-notice-height;
}

.main-editor-wrapper > .recovery-notice {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 8px;
  box-sizing: border-box;
  height: @recovery-notice-height;
  padding: 0 10px;
  background-color: #fff6dc;
  border-bottom: 1px solid #e3d6a3;
  color: #5c4a10;
  font-family: system-ui, "Microsoft YaHei UI", sans-serif;
  font-size: 12px;
  line-height: 1.3;
  text-align: left;

  .recovery-notice-text,
  .recovery-notice-error {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .recovery-notice-text {
    flex: 0 1 auto;
    font-weight: bold;
  }

  .recovery-notice-error {
    flex: 0 2 auto;
    color: #b42318;
  }

  button.recovery-notice-button {
    flex: 0 0 auto;
    box-sizing: border-box;
    height: 24px;
    margin: 0;
    padding: 0 10px;
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
    white-space: nowrap;
    cursor: pointer;

    &:hover:not(:disabled) {
      border-color: #3b78d1;
      color: #111827;
    }

    &:disabled {
      opacity: 0.6;
      cursor: default;
    }
  }
}

body.dark .main-editor-wrapper > .recovery-notice {
  background-color: rgb(58, 50, 28);
  border-bottom-color: rgb(94, 82, 46);
  color: rgb(236, 224, 184);

  .recovery-notice-error {
    color: #ff9a8f;
  }

  button.recovery-notice-button {
    background-color: rgb(50, 50, 50);
    border-color: rgb(90, 90, 90);
    color: rgb(215, 215, 215);

    &:hover:not(:disabled) {
      border-color: #5b9bf0;
      color: rgb(240, 240, 240);
    }
  }
}
</style>
