<template>
  <PopoverWrapper v-bind:target="props.target" v-on:close="emit('close')">
    <div class="pandoc-div-span">
      <p class="pandoc-popover-heading">
        {{ headingLabel }}
      </p>
      <hr>
      <TextControl
        ref="identifiers"
        v-model="identifierQuery"
        v-bind:placeholder="identifierPlaceholder"
      ></TextControl>

      <TextControl
        ref="classes"
        v-model="classesQuery"
        v-bind:placeholder="classesPlaceholder"
      ></TextControl>

      <TextControl
        ref="attributes"
        v-model="attributesQuery"
        v-bind:placeholder="attributesPlaceholder"
      ></TextControl>
      <hr>
      <button v-on:click="handleClick">
        {{ insertPandocButtonLabel }}
      </button>
    </div>
  </PopoverWrapper>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Fenced Div and Bracketed Span Popover
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This popover allows a user to insert and configure
 *                  the identifier, classes, and key-value attributes
 *                  of a Pandoc fenced div or bracketed span.
 *
 * END HEADER
 */
import PopoverWrapper from '@common/vue/PopoverWrapper.vue'
import TextControl from '@common/vue/form/elements/TextControl.vue'
import { trans } from '@common/i18n-renderer'
import { ref, computed } from 'vue'

const props = defineProps<{
  target: HTMLElement
  // Which structure to insert. The toolbar has one button per structure, so
  // the popover no longer offers the choice itself.
  pandocType: 'div'|'span'
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'insert-pandoc', value: { type: string, attributes: string }): void
}>()

const identifierQuery = ref('')
const identifierPlaceholder: string = trans('#identifier')

const classesQuery = ref('')
const classesPlaceholder: string = trans('.classes')

const attributesQuery = ref('')
const attributesPlaceholder: string = trans('key=value')

const structureLabel = computed(() => props.pandocType === 'div' ? 'Fenced Div' : 'Bracketed Span')

const headingLabel = computed(() => trans(`Pandoc ${structureLabel.value}`))

const insertPandocButtonLabel = computed(() => trans(`Insert ${structureLabel.value}`))

function handleClick (): void {
  const formatAttributes = (input: string, prefix: string, join: string = ' '): string =>
    input
      .trim()
      .split(/\s+/)
      .filter(word => word.trim() !== '')
      .map(word => word.startsWith(prefix) ? word : prefix + word)
      .join(join)

  const pandocAttributesString: string = formatAttributes(`${formatAttributes(formatAttributes(identifierQuery.value, '', '-'), '#')} ${formatAttributes(classesQuery.value, '.')} ${attributesQuery.value}`, '')

  emit('insert-pandoc', { type: props.pandocType, attributes: pandocAttributesString })
  emit('close')
}
</script>

<style lang="less">
body {
  .pandoc-div-span {
    margin: 5px;

    .pandoc-popover-heading {
      margin: 5px;
      font-weight: bold;
    }

    button {
      width: stretch;
      margin: 5px;
    }
  }
}
</style>
