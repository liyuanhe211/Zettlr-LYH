<template>
  <!-- Teleported to the body element so that it covers the whole window -->
  <Teleport to="body">
    <div
      class="revision-author-overlay"
      v-on:keydown.stop
      v-on:mousedown.self.prevent
    >
      <form
        class="revision-author-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="revision-author-title"
        v-on:submit.prevent="confirm()"
      >
        <div id="revision-author-title" class="revision-author-title">
          Revision author
        </div>
        <label class="revision-author-explanation" for="revision-author-input">
          Enter the author name recorded with your tracked changes.
        </label>
        <input
          id="revision-author-input"
          ref="input"
          v-model="name"
          type="text"
          class="revision-author-input"
          spellcheck="false"
          v-on:keydown.esc.prevent="emit('cancel')"
        >
        <div class="revision-author-buttons">
          <button
            type="submit"
            class="revision-author-button"
            v-bind:disabled="name.trim() === ''"
          >
            OK
          </button>
          <button
            type="button"
            class="revision-author-button"
            v-on:click="emit('cancel')"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        RevisionAuthorDialog
 * CVM-Role:        View
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH revision mode (R84, spec C10): asks for the
 *                  author name recorded with tracked changes when the user
 *                  turns Track Changes on while the editor.revisionAuthor
 *                  setting is empty. OK (or Enter) emits the trimmed name and
 *                  is disabled while the name is empty; Cancel (or Escape)
 *                  emits cancel. Saving the setting and turning Track Changes
 *                  on is left to the parent. When initialName is empty, the
 *                  dialog asks the main process for the account name
 *                  (get-account-name, decision 107) and fills it in unless the
 *                  user has typed something meanwhile; the name is only saved
 *                  when the user presses OK.
 *
 * END HEADER
 */

import { nextTick, onMounted, ref } from 'vue'

const props = defineProps<{
  /** The name filled in when the dialog opens */
  initialName: string
}>()

const emit = defineEmits<{
  (e: 'confirm', name: string): void
  (e: 'cancel'): void
}>()

const ipcRenderer = window.ipc

const name = ref(props.initialName)
const input = ref<HTMLInputElement|null>(null)

onMounted(() => {
  input.value?.focus()
  input.value?.select()

  if (props.initialName.trim() !== '') {
    return
  }

  // Prefill the account name (decision 107); an empty or failed result keeps
  // the field empty
  ipcRenderer.invoke('application', { command: 'get-account-name' })
    .then((accountName: unknown) => {
      if (typeof accountName !== 'string' || accountName.trim() === '' || name.value !== '') {
        return
      }
      name.value = accountName.trim()
      // Select the prefilled name so that typing replaces it
      void nextTick(() => {
        input.value?.select()
      })
    })
    .catch(err => console.error(err))
})

function confirm (): void {
  const author = name.value.trim()
  if (author !== '') {
    emit('confirm', author)
  }
}
</script>

<style lang="less">
// Zettlr-LYH revision author dialog (R84): follows the flat design language of
// the Windows dialog (square corners, 1 px borders, neutral fills);
// body.dark switches to dark colors.
.revision-author-overlay {
  position: fixed;
  inset: 0;
  z-index: 99000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  box-sizing: border-box;
  background-color: rgba(0, 0, 0, 0.45);

  .revision-author-dialog {
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: 420px;
    max-width: 100%;
    padding: 16px;
    box-sizing: border-box;
    background-color: #ffffff;
    color: #1f2328;
    border: 1px solid #c0c4cc;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.35);
  }

  .revision-author-title {
    font-size: 14px;
    font-weight: bold;
  }

  .revision-author-explanation {
    font-size: 13px;
  }

  input.revision-author-input {
    padding: 4px 6px;
    font-size: 13px;
    border: 1px solid #c0c4cc;
    border-radius: 0;
    background-color: #ffffff;
    color: #1f2328;
    outline: none;

    &:focus {
      border-color: #3b78d1;
    }
  }

  .revision-author-buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  button.revision-author-button {
    min-width: 80px;
    background-color: #eceef2;
    color: #374151;
    border: 1px solid #c0c4cc;
    border-radius: 0;
    padding: 5px 14px;
    font-weight: bold;

    &:hover:not(:disabled) {
      border-color: #3b78d1;
      color: #111827;
    }

    &:active:not(:disabled) {
      background-color: #dcdfe5;
    }

    &:disabled {
      opacity: 0.5;
    }
  }
}

body.dark .revision-author-overlay {
  background-color: rgba(0, 0, 0, 0.6);

  .revision-author-dialog {
    background-color: #2b2b2c;
    color: #e0e0e0;
    border-color: #505050;
  }

  input.revision-author-input {
    background-color: #1e1e1e;
    color: #e0e0e0;
    border-color: #505050;

    &:focus {
      border-color: #3b78d1;
    }
  }

  button.revision-author-button {
    background-color: #3a3a3c;
    color: #e0e0e0;
    border-color: #505050;

    &:hover:not(:disabled) {
      border-color: #3b78d1;
      color: #ffffff;
    }

    &:active:not(:disabled) {
      background-color: #2f2f31;
    }
  }
}
</style>
