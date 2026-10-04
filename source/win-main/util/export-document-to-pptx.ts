/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        exportDocumentToPptx
 * CVM-Role:        Utility Function
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Drives the PPTX export of a Markdown document from the
 *                  renderer: the document is saved through the regular save
 *                  path first, then the main process runs the maintained
 *                  conversion script over the saved file. The progress and the
 *                  outcome live in this module rather than in a component, so
 *                  that the toolbar button can start an export no matter which
 *                  panes happen to be open.
 *
 * END HEADER
 */

import { computed, ref } from 'vue'
import { formatPptxExportSummary } from '@common/util/pptx-export-report'
import { pathBasename } from 'source/common/util/renderer-path-polyfill'
import type { DocumentManagerIPCAPI } from 'source/app/service-providers/documents'
import type { PptxExportCommandArg, PptxExportResult } from '@dts/common/pptx-export'

const ipcRenderer = window.ipc

/**
 * The document whose export is currently running, if any. One export at a
 * time: the main process refuses a second export of the same document anyway,
 * and two exports at once would only fight over the same PowerPoint instance.
 */
const runningExportPath = ref<string|undefined>(undefined)

/**
 * What the last export has to say for itself, empty before the first one.
 */
const lastExportMessage = ref('')
const lastExportFailed = ref(false)

/**
 * True while an export is running.
 */
export const pptxExportRunning = computed(() => runningExportPath.value !== undefined)

/**
 * The line to show the user: the progress of the running export, otherwise the
 * outcome of the last one.
 */
export const pptxExportMessage = computed(() => lastExportMessage.value)

/**
 * True when the message reports a failure rather than a finished export.
 */
export const pptxExportFailed = computed(() => lastExportFailed.value)

function reportOutcome (filePath: string, message: string, failed: boolean): void {
  // Another document may have become the active one during a long export, so
  // the message names the document it is about.
  lastExportMessage.value = `${pathBasename(filePath)}: ${message}`
  lastExportFailed.value = failed
}

/**
 * Saves the document through the regular save path (the same documents
 * provider command Ctrl+S ends up in), then has the main process run the
 * maintained conversion script over the saved file, which writes the PPTX and
 * its companion files next to the document.
 *
 * @param   {string}  filePath  The absolute path of the Markdown document
 */
export async function exportDocumentToPptx (filePath: string): Promise<void> {
  if (runningExportPath.value !== undefined) {
    return
  }

  runningExportPath.value = filePath
  lastExportFailed.value = false
  lastExportMessage.value = 'Saving the document…'

  try {
    const modifiedPaths: unknown = await ipcRenderer.invoke('documents-provider', {
      command: 'get-file-modification-status',
      payload: undefined
    } as DocumentManagerIPCAPI)

    if (Array.isArray(modifiedPaths) && modifiedPaths.includes(filePath)) {
      const saved: unknown = await ipcRenderer.invoke('documents-provider', {
        command: 'save-file',
        payload: { path: filePath }
      } as DocumentManagerIPCAPI)

      if (saved !== true) {
        reportOutcome(filePath, 'Export cancelled: the document could not be saved', true)
        return
      }
    }

    reportOutcome(filePath, 'Exporting PPTX…', false)
    const result: unknown = await ipcRenderer.invoke('application', {
      command: 'pptx-export',
      payload: { filePath } satisfies PptxExportCommandArg
    })

    if (typeof result !== 'object' || result === null) {
      reportOutcome(filePath, 'Export failed: the export command did not answer; see the log', true)
      return
    }

    const exportResult = result as PptxExportResult
    reportOutcome(filePath, formatPptxExportSummary(exportResult), !exportResult.ok)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    reportOutcome(filePath, `Export failed: ${message}`, true)
  } finally {
    runningExportPath.value = undefined
  }
}
