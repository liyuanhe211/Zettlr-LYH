/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ConversationViewerContext, CONVERSATION_VIEWER_CONTEXT,
 *                  saveExpansionState, loadExpansionState
 * CVM-Role:        Model
 * License:         GNU GPL v3
 *
 * Description:     What ConversationViewer.vue provides to the recursive
 *                  ConversationNodeView.vue (Zettlr-LYH R79, contract C8
 *                  section 7), and the module-level memory that keeps the
 *                  expansion state of each file while its viewer is unmounted.
 *
 * END HEADER
 */

import type { InjectionKey } from 'vue'
import type { ConversationNode } from '@dts/common/conversation-history'

export interface ConversationViewerContext {
  /**
   * Whether a node (or a tool group) is expanded. `initiallyCollapsed` is
   * used while the user has not toggled it yet.
   */
  isExpanded: (id: string, initiallyCollapsed: boolean) => boolean
  setExpanded: (id: string, expanded: boolean) => void
  /**
   * The cleaned HTML of a user, assistant or summary node, or undefined while
   * it is not rendered yet.
   */
  renderedHtml: (node: ConversationNode) => string|undefined
  /**
   * The highlight classes (select and JEV) of a node.
   */
  highlightClasses: (id: string) => string[]
}

export const CONVERSATION_VIEWER_CONTEXT: InjectionKey<ConversationViewerContext> = Symbol('conversation-viewer-context')

/**
 * Maximum number of files whose expansion state is remembered.
 */
const MAXIMUM_REMEMBERED_FILES = 200

/**
 * Expansion state per file path: node or group identifier to expanded flag,
 * only for entries the user (or find and reveal) has changed. Lives as long
 * as the window, like a viewer's reading position.
 */
const expansionStateByPath = new Map<string, Record<string, boolean>>()

/**
 * Remembers the expansion state of a file. The most recently saved file is
 * kept last, so the oldest entry is dropped first.
 *
 * @param   {string}                   filePath  The file path
 * @param   {Record<string, boolean>}  state     The expansion overrides
 */
export function saveExpansionState (filePath: string, state: Record<string, boolean>): void {
  expansionStateByPath.delete(filePath)
  expansionStateByPath.set(filePath, { ...state })
  while (expansionStateByPath.size > MAXIMUM_REMEMBERED_FILES) {
    const oldest = expansionStateByPath.keys().next().value
    if (oldest === undefined) {
      break
    }
    expansionStateByPath.delete(oldest)
  }
}

/**
 * Returns a copy of the remembered expansion state of a file.
 *
 * @param   {string}                   filePath  The file path
 *
 * @return  {Record<string, boolean>}            The expansion overrides
 */
export function loadExpansionState (filePath: string): Record<string, boolean> {
  return { ...(expansionStateByPath.get(filePath) ?? {}) }
}
