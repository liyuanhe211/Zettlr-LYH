/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Info Statusbar Items
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
*
 * Description:     This file defines a set of info statusbar items
 *
 * END HEADER
 */

import { type EditorState } from '@codemirror/state'
import { type EditorView } from '@codemirror/view'
import { trans } from '@common/i18n-renderer'
import localiseNumber from '@common/util/localise-number'
import { type StatusbarItem } from '.'
import { countField } from '../plugins/statistics-fields'
import { configField } from '../util/configuration'
import { getEditorSyncHealth } from '../plugins/recovery-journal'

/** The class of the status bar item that warns about input that does not reach the main process */
export const SYNC_HEALTH_STATUS_CLASS = 'cm-statusbar-unsynchronized'

/**
 * Zettlr-LYH data loss prevention (R173, specification C21 section 7 item 4):
 * warns while the input of this editor has not reached the main process for a
 * while. The recovery journal plugin reports the health into the editor state
 * and dispatches an effect whenever it changes (every second while stalled),
 * which redraws the status bar.
 *
 * @param   {EditorState}    state  The EditorState
 * @param   {EditorView}     view   The EditorView
 *
 * @return  {StatusbarItem}         Returns the element or null
 */
export function syncHealthStatus (state: EditorState, _view: EditorView): StatusbarItem|null {
  const health = getEditorSyncHealth(state)
  if (health.status !== 'stalled') {
    return null
  }

  const seconds = Math.max(0, Math.floor(health.stalledForMs / 1000))
  return {
    content: trans('Not synchronized (%ss)', String(seconds)),
    className: SYNC_HEALTH_STATUS_CLASS
  }
}

/**
 * Displays the cursor position
 *
 * @param   {EditorState}    state  The EditorState
 * @param   {EditorView}     view   The EditorView
 *
 * @return  {StatusbarItem}         Returns the element
 */
export function cursorStatus (state: EditorState, _view: EditorView): StatusbarItem|null {
  const mainOffset = state.selection.main.head
  const line = state.doc.lineAt(mainOffset)
  return {
    content: `${line.number}:${mainOffset - line.from + 1} (${localiseNumber(mainOffset)})`
  }
}

/**
 * Displays the word count, if applicable
 *
 * @param   {EditorState}    state  The EditorState
 * @param   {EditorView}     view   The EditorView
 *
 * @return  {StatusbarItem}         Returns the element or null
 */
export function wordcountStatus (state: EditorState, _view: EditorView): StatusbarItem|null {
  const counter = state.field(countField, false)
  if (counter === undefined) {
    return null
  } else {
    const words = counter.selected === null
      ? localiseNumber(counter.words)
      : `${localiseNumber(counter.selected.words)}/${localiseNumber(counter.words)}`
    return {
      content: trans('%s words', words)
    }
  }
}

/**
 * Displays the character count, if applicable
 *
 * @param   {EditorState}    state  The EditorState
 * @param   {EditorView}     view   The EditorView
 *
 * @return  {StatusbarItem}         Returns the element or null
 */
export function charcountStatus (state: EditorState, _view: EditorView): StatusbarItem|null {
  const counter = state.field(countField, false)
  if (counter === undefined) {
    return null
  } else {
    const characters = counter.selected === null
      ? localiseNumber(counter.chars)
      : `${localiseNumber(counter.selected.chars)}/${localiseNumber(counter.chars)}`
    return {
      content: trans('%s characters', characters)
    }
  }
}

/** Displays a deliberately approximate, entirely offline source token count. */
export function tokenEstimateStatus (state: EditorState, _view: EditorView): StatusbarItem|null {
  const counter = state.field(countField, false)
  if (counter === undefined) {
    return null
  }
  const tokens = counter.selected === null
    ? `~${localiseNumber(counter.tokens)}`
    : `~${localiseNumber(counter.selected.tokens)}/~${localiseNumber(counter.tokens)}`
  return {
    content: `${tokens} tokens (offline estimate)`,
    title: 'UTF-8 bytes / 4, rounded up, for raw Markdown including code, links, line breaks and hidden syntax. Selected bytes are added across disjoint ranges before rounding, without joining the text or adding separators. This is a rough offline estimate, not an exact Claude token count. No accuracy or error bound is guaranteed for any language or model. Nothing is uploaded and no counting service is called.'
  }
}

/**
 * Displays an input mode indication, if applicable
 *
 * @param   {EditorState}    state  The EditorState
 * @param   {EditorView}     view   The EditorView
 *
 * @return  {StatusbarItem}         Returns the element or null
 */
export function inputModeStatus (state: EditorState, _view: EditorView): StatusbarItem|null {
  const config = state.field(configField, false)
  if (config === undefined) {
    return null
  } else if (config.inputMode !== 'default') {
    return {
      content: 'Mode: ' + (config.inputMode === 'vim' ? 'Vim' : 'Emacs')
    }
  } else {
    return null
  }
}
