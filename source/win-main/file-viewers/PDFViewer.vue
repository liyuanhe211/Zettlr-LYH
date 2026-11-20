<template>
  <PdfJsViewer
    v-bind:leaf-id="props.leafId"
    v-bind:window-id="props.windowId"
    v-bind:active-file="props.activeFile"
    v-bind:editor-commands="props.editorCommands"
    v-bind:file="props.file"
  ></PdfJsViewer>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        PDFViewer
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     The PDF Viewer is the component that editor panes mount to
 *                  display PDF files. Zettlr-LYH R59: it no longer embeds
 *                  Chromium's built-in viewer in an iframe; it only hands its
 *                  properties on to PdfJsViewer, the read-only viewer built on
 *                  pdf.js (contract C5), so that EditorPane stays unchanged.
 *
 * END HEADER
 */
import type { OpenDocument } from 'source/types/common/documents'
import type { EditorCommands } from '../App.vue'
import PdfJsViewer from './pdf-viewer/PdfJsViewer.vue'

const props = defineProps<{
  leafId: string
  windowId: string
  activeFile: OpenDocument|null
  editorCommands: EditorCommands
  file: OpenDocument
}>()
</script>
