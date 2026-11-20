/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        IPC API
 * CVM-Role:        Utility Function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file specifies the API to communicate with the central
 *                  document authority via an IPC bridge (used for Electron).
 *
 * END HEADER
 */

import { DP_EVENTS, type DocumentExternalStep, type DocumentType } from '@dts/common/documents'
import { type Update } from '@codemirror/collab'
import { type DocumentAuthorityAPI } from '..'
import type { DocumentAuthorityIPCAPI } from 'source/app/service-providers/documents'
import { PULL_FALLBACK_INTERVAL_MS, type PullUpdateOptions, type PushAnswer } from '../plugins/remote-doc'

const ipcRenderer = window.ipc

/**
 * Requests new updates from the authority. The request is not sent right away:
 * the function first waits until there is a reason to ask.
 *
 * Zettlr-LYH data loss prevention (R173, specification C21 section 3.1): there
 * are three such reasons. A status event for the file arrives; the caller wakes
 * the pull (`options.onWait`); or PULL_FALLBACK_INTERVAL_MS have passed.
 * Before, only the event ended the wait, so one lost event (or one listener
 * that never got called) stalled the synchronization of the file for good.
 * However the wait ends, its listener and its timer are removed at that
 * moment, before the request is sent. Events that arrive while the request is
 * in flight are not remembered; the next wait catches up after at most
 * PULL_FALLBACK_INTERVAL_MS.
 *
 * @param   {string}             filePath  The file
 * @param   {number}             version   The version the editor has synchronized
 * @param   {PullUpdateOptions}  options   The hooks of the caller, if it has any
 *
 * @return  {Promise<false|Update[]>}      The answer of the authority; an empty
 *                                         list if the caller cancelled the wait
 */
async function pullUpdates (filePath: string, version: number, options?: PullUpdateOptions): Promise<false|Update[]> {
  const sendRequest = await new Promise<boolean>(resolve => {
    let finished = false
    let stopListening: (() => void)|undefined
    let timer: ReturnType<typeof setTimeout>|undefined

    // Ends the wait; only the first call has an effect.
    const finish = (request: boolean): void => {
      if (finished) {
        return
      }
      finished = true
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      // Clean up to not pollute the event listener with millions of callbacks
      stopListening?.()
      stopListening = undefined
      resolve(request)
    }

    stopListening = ipcRenderer.on('documents-update', (evt, payload) => {
      if (payload?.event === DP_EVENTS.CHANGE_FILE_STATUS && payload.context?.filePath === filePath) {
        finish(true)
      }
    })
    timer = setTimeout(() => { finish(true) }, PULL_FALLBACK_INTERVAL_MS)

    try {
      options?.onWait?.({
        wake: () => { finish(true) },
        cancel: () => { finish(false) }
      })
    } catch (err) {
      console.error(`The pull for ${filePath} could not hand over its controls`, err)
    }
  })

  if (!sendRequest) {
    return []
  }

  // The state of the editor is read as late as possible, so that the report
  // describes the moment of the request.
  const editor = options?.prepareRequest?.()
  // A main process that has not been restarted yet ignores the additional
  // field.
  const payload = editor === undefined ? { filePath, version } : { filePath, version, editor }
  return await ipcRenderer.invoke('documents-authority', {
    command: 'pull-updates',
    payload
  } as DocumentAuthorityIPCAPI)
}

/**
 * Submits new updates to the authority, returns true if successful.
 *
 * Zettlr-LYH data loss prevention (R173, specification C21 section 3.3): the
 * main process answers with an object that also names the reason of a
 * rejection; a main process that has not been restarted yet answers with a
 * boolean. Callers of this function depend on a boolean, so the object is
 * reduced to its `accepted` field here. The reason is in the log of the main
 * process.
 */
async function pushUpdates (filePath: string, version: number, updates: any): Promise<boolean> {
  const answer: unknown = await ipcRenderer.invoke('documents-authority', {
    command: 'push-updates',
    payload: { filePath, version, updates }
  } as DocumentAuthorityIPCAPI)

  if (typeof answer === 'object' && answer !== null) {
    return (answer as PushAnswer).accepted !== false
  }

  return answer !== false
}

async function fetchDoc (filePath: string): Promise<{ content: string, type: DocumentType, startVersion: number, externalStep?: DocumentExternalStep }> {
  // Fetches a fresh document
  return await ipcRenderer.invoke('documents-authority', {
    command: 'get-document',
    payload: { filePath }
  } as DocumentAuthorityIPCAPI)
}

/**
 * Zettlr-LYH undo history (R135): asks the main process for the undo history of
 * an open document, rebuilt from the records on disk. The answer is not
 * checked here; the editor does that. It is null if the document is not open,
 * its version differs from the given one, or no step is usable.
 *
 * @param   {string}            filePath  The document
 * @param   {number}            version   The version the editor loaded
 *
 * @return  {Promise<unknown>}            The history, or whatever the main process answered
 */
async function fetchUndoHistory (filePath: string, version: number): Promise<unknown> {
  return await ipcRenderer.invoke('documents-provider', {
    command: 'get-undo-history',
    payload: { filePath, version }
  })
}

/**
 * This API can be passed in to an instance of MainEditor to allow it to
 * communicate with the central document authority via an IPC bridge.
 *
 * @var {DocumentAuthorityAPI}
 */
export const documentAuthorityIPCAPI: DocumentAuthorityAPI = {
  fetchDoc,
  fetchUndoHistory,
  pushUpdates,
  pullUpdates
}
