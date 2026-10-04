/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Pandoc PPTX preview link (renderer-side channel)
 * CVM-Role:        Model
 * License:         GNU GPL v3
 *
 * Description:     The small renderer-side channel that links a Markdown
 *                  editor, its pandoc PPTX preview pane, and the main
 *                  window's toolbar, all of which live in the same renderer
 *                  process but in unrelated component trees:
 *
 *                  - pptxSyncScrollEnabled: the toolbar's Sync Scroll switch.
 *                    App.vue writes it, every preview pane reads it. Being a
 *                    module-level ref, it lives as long as the window and
 *                    therefore survives switching tabs.
 *                  - PPTX_EDITOR_PIN_EVENT: a DOM event the editor's heading
 *                    pins dispatch (bubbling) from the editor element. The
 *                    preview pane listens on the document and reacts only to
 *                    events from an editor inside its own editor pane.
 *
 * END HEADER
 */

import { ref } from 'vue'

/**
 * Whether the Markdown editor and its PPTX preview scroll together
 */
export const pptxSyncScrollEnabled = ref(false)

/**
 * Name of the DOM event an editor heading pin dispatches
 */
export const PPTX_EDITOR_PIN_EVENT = 'zettlr-pptx-editor-pin'

/**
 * Detail of PPTX_EDITOR_PIN_EVENT
 */
export interface PptxEditorPinDetail {
  /**
   * Absolute path of the document shown in the editor
   */
  filePath: string
  /**
   * 0-based line number of the pinned heading
   */
  line: number
}
