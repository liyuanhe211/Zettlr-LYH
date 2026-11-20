<template>
  <div class="pdfjs-quote-controls" role="group" aria-label="Quote settings">
    <div class="pdfjs-quote-colors" role="radiogroup" aria-label="Quote color">
      <button
        v-for="option in COLOR_OPTIONS"
        v-bind:key="option.name"
        type="button"
        role="radio"
        class="pdfjs-viewer-button pdfjs-quote-color-button"
        v-bind:title="`Quote Color: ${option.label}`"
        v-bind:aria-label="option.label"
        v-bind:aria-checked="settings.color === option.name ? 'true' : 'false'"
        v-bind:disabled="props.disabled === true"
        v-on:click="selectColor(option.name)"
      >
        <span
          class="pdfjs-quote-color-swatch"
          aria-hidden="true"
          v-bind:style="{ backgroundColor: option.background }"
        ></span>
      </button>
    </div>
    <button
      type="button"
      class="pdfjs-viewer-button pdfjs-quote-auto-copy-button"
      title="Auto-copy: copy selected text as a quote when the mouse button is released"
      aria-label="Auto-copy"
      v-bind:aria-pressed="settings.autoCopy ? 'true' : 'false'"
      v-bind:disabled="props.disabled === true"
      v-on:click="toggleAutoCopy"
    >
      <cds-icon shape="copy" role="presentation"></cds-icon>
      <span>Auto-copy</span>
    </button>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        PdfQuoteControls
 * CVM-Role:        View
 * License:         GNU GPL v3
 *
 * Description:     The quote controls of the PDF viewer's toolbar (Zettlr-LYH
 *                  R60): the color of Copy as Quote (Yellow, Red, Note,
 *                  Important; PDF++'s palette, default Yellow) and the
 *                  Auto-copy toggle (default on). The settings are stored in
 *                  localStorage (copy-quote.ts) and shared by all viewers of
 *                  the window: a change is announced with the window event
 *                  PDF_QUOTE_SETTINGS_EVENT, which the controls of the other
 *                  viewers follow. The component emits `change` with the
 *                  current settings once when it is mounted and after every
 *                  change, including changes made in another viewer.
 *
 * END HEADER
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { PDF_HIGHLIGHT_COLORS, PDF_QUOTE_COLOR_NAMES } from 'source/types/common/pdf-viewer'
import {
  normalizePdfQuoteColor,
  PDF_QUOTE_SETTINGS_EVENT,
  readPdfQuoteSettings,
  writePdfQuoteSettings,
  type PdfQuoteSettings
} from './copy-quote'

interface ColorOption {
  name: string
  label: string
  background: string
}

const COLOR_OPTIONS: ColorOption[] = PDF_QUOTE_COLOR_NAMES.map(name => ({
  name,
  label: name.charAt(0).toUpperCase() + name.slice(1),
  background: PDF_HIGHLIGHT_COLORS[name] ?? 'transparent'
}))

const props = defineProps<{
  disabled?: boolean
}>()

const emit = defineEmits<(e: 'change', settings: PdfQuoteSettings) => void>()

const settings = ref<PdfQuoteSettings>(readPdfQuoteSettings(storage()))

/**
 * @return  {Storage|null}  window.localStorage, or null if it cannot be accessed
 */
function storage (): Storage|null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/**
 * Stores new settings, tells the parent and the controls of other viewers
 *
 * @param   {PdfQuoteSettings}  next  The new settings
 */
function applySettings (next: PdfQuoteSettings): void {
  settings.value = next
  writePdfQuoteSettings(storage(), next)
  emit('change', { ...next })
  window.dispatchEvent(new CustomEvent<PdfQuoteSettings>(PDF_QUOTE_SETTINGS_EVENT, { detail: { ...next } }))
}

function selectColor (color: string): void {
  if (settings.value.color === color) {
    return
  }

  applySettings({ ...settings.value, color: normalizePdfQuoteColor(color) })
}

function toggleAutoCopy (): void {
  applySettings({ ...settings.value, autoCopy: !settings.value.autoCopy })
}

/**
 * Follows a change made in the controls of another viewer
 *
 * @param   {Event}  event  The PDF_QUOTE_SETTINGS_EVENT
 */
function handleSettingsEvent (event: Event): void {
  const detail = (event as CustomEvent<unknown>).detail
  if (typeof detail !== 'object' || detail === null) {
    return
  }

  const { color, autoCopy } = detail as Record<string, unknown>
  if (typeof autoCopy !== 'boolean') {
    return
  }

  const next: PdfQuoteSettings = { color: normalizePdfQuoteColor(color), autoCopy }

  if (next.color === settings.value.color && next.autoCopy === settings.value.autoCopy) {
    return // Our own announcement, or nothing changed
  }

  settings.value = next
  emit('change', { ...next })
}

onMounted(() => {
  window.addEventListener(PDF_QUOTE_SETTINGS_EVENT, handleSettingsEvent)
  emit('change', { ...settings.value })
})

onBeforeUnmount(() => {
  window.removeEventListener(PDF_QUOTE_SETTINGS_EVENT, handleSettingsEvent)
})

defineExpose({
  /**
   * @return  {PdfQuoteSettings}  A copy of the current settings
   */
  getSettings: (): PdfQuoteSettings => ({ ...settings.value })
})
</script>

<style lang="less">
body {
  div.pdfjs-quote-controls {
    display: flex;
    align-items: center;
    gap: 4px;

    div.pdfjs-quote-colors {
      display: flex;
      align-items: center;
      gap: 2px;
    }

    // The buttons take their look from the toolbar's pdfjs-viewer-button;
    // only the swatches and the checked state are added here
    button.pdfjs-quote-color-button {
      width: 24px;

      span.pdfjs-quote-color-swatch {
        display: block;
        width: 14px;
        height: 14px;
        box-sizing: border-box;
        border: 1px solid rgba(0, 0, 0, 0.35);
        border-radius: 50%;
      }

      &[aria-checked="true"] {
        border-color: var(--grey-2);
        background-color: var(--grey-1);

        span.pdfjs-quote-color-swatch {
          border: 2px solid var(--system-accent-color, rgb(40, 100, 255));
        }
      }
    }

    button.pdfjs-quote-auto-copy-button {
      padding: 0 6px;
      white-space: nowrap;
    }
  }

  &.dark div.pdfjs-quote-controls {
    button.pdfjs-quote-color-button {
      span.pdfjs-quote-color-swatch {
        border-color: rgba(255, 255, 255, 0.45);
      }

      &[aria-checked="true"] {
        border-color: var(--grey-4);
        background-color: var(--grey-6);
      }
    }
  }
}
</style>
