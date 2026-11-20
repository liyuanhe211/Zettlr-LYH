/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Recovery journal API
 * CVM-Role:        Utility
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH data loss prevention (R173, specification C21
 *                  section 5.3): how a renderer reaches the recovery journal
 *                  of the main process. Every command of the channel
 *                  `recovery-journal` and the unanswered channel
 *                  `recovery-journal-flush` is wrapped in one function. The
 *                  recovery journal plugin receives these functions through
 *                  its configuration, so tests can substitute them. This
 *                  module also ends every live session when the page is
 *                  unloaded (`pagehide`).
 *
 * END HEADER
 */

import type {
  RecoverableSession,
  RecoverableSessionSummary,
  RecoveryJournalEndReason,
  RecoveryJournalIPCAPI,
  RecoveryJournalPreserveResult,
  RecoveryJournalRecord,
  RecoveryJournalResolution,
  RecoveryJournalResolveResult
} from '@providers/recovery-journal/journal-store'

const RECOVERY_JOURNAL_CHANNEL = 'recovery-journal'
const RECOVERY_JOURNAL_FLUSH_CHANNEL = 'recovery-journal-flush'

/**
 * The functions through which the recovery journal is reached. The recovery
 * journal plugin only uses `append`, `flush` and `preserveText`.
 */
export interface RecoveryJournalAPI {
  /**
   * Appends records to a session file. Resolves once the main process has
   * written them to disk; rejects if they could not be written, or if the main
   * process has no handler for the channel (yet).
   */
  append: (filePath: string, sessionId: string, records: RecoveryJournalRecord[]) => Promise<void>
  /**
   * Sends records without waiting for an answer. For editors that are being
   * destroyed and pages that are being unloaded.
   */
  flush: (filePath: string, sessionId: string, records: RecoveryJournalRecord[]) => void
  /**
   * With a file path: the recoverable sessions of that file with their rebuilt
   * texts. Without: a summary of the recoverable sessions of all files. The
   * newest session comes first in both cases.
   */
  listRecoverable: {
    (filePath: string): Promise<RecoverableSession[]>
    (): Promise<RecoverableSessionSummary[]>
  }
  /**
   * Settles a session; its file moves into the folder of resolved sessions.
   * `kept-as-file` also writes the rebuilt text as a recovery copy and returns
   * its path.
   */
  resolve: (filePath: string, sessionId: string, resolution: RecoveryJournalResolution) => Promise<RecoveryJournalResolveResult>
  /**
   * Writes a full text as the recovery copy of a session. The same session
   * always writes the same file.
   */
  preserveText: (filePath: string, sessionId: string, text: string, reason: string) => Promise<RecoveryJournalPreserveResult>
}

async function append (filePath: string, sessionId: string, records: RecoveryJournalRecord[]): Promise<void> {
  const message: RecoveryJournalIPCAPI = { command: 'append', payload: { filePath, sessionId, records } }
  await window.ipc.invoke(RECOVERY_JOURNAL_CHANNEL, message)
}

function flush (filePath: string, sessionId: string, records: RecoveryJournalRecord[]): void {
  window.ipc.send(RECOVERY_JOURNAL_FLUSH_CHANNEL, { filePath, sessionId, records })
}

async function listRecoverable (filePath: string): Promise<RecoverableSession[]>
async function listRecoverable (): Promise<RecoverableSessionSummary[]>
async function listRecoverable (filePath?: string): Promise<RecoverableSession[]|RecoverableSessionSummary[]> {
  const message: RecoveryJournalIPCAPI = {
    command: 'list-recoverable',
    payload: filePath === undefined ? undefined : { filePath }
  }
  return await window.ipc.invoke(RECOVERY_JOURNAL_CHANNEL, message)
}

async function resolve (filePath: string, sessionId: string, resolution: RecoveryJournalResolution): Promise<RecoveryJournalResolveResult> {
  const message: RecoveryJournalIPCAPI = { command: 'resolve', payload: { filePath, sessionId, resolution } }
  return await window.ipc.invoke(RECOVERY_JOURNAL_CHANNEL, message)
}

async function preserveText (filePath: string, sessionId: string, text: string, reason: string): Promise<RecoveryJournalPreserveResult> {
  const message: RecoveryJournalIPCAPI = { command: 'preserve-text', payload: { filePath, sessionId, text, reason } }
  return await window.ipc.invoke(RECOVERY_JOURNAL_CHANNEL, message)
}

/**
 * This API can be passed to the recovery journal plugin (and used by the
 * editor) to reach the recovery journal of the main process via IPC.
 *
 * @var {RecoveryJournalAPI}
 */
export const recoveryJournalIPCAPI: RecoveryJournalAPI = {
  append,
  flush,
  listRecoverable,
  resolve,
  preserveText
}

/** Ends a session: writes out its pending records and the end record at once */
export type LiveSessionEnder = (reason: RecoveryJournalEndReason) => void

const liveSessionEnders = new Set<LiveSessionEnder>()

/**
 * Called when the page is unloaded: every live session writes out its pending
 * records and an end record with the reason `pagehide`. One session that
 * fails must not keep the others from being written.
 */
function endLiveSessionsOnPageHide (): void {
  for (const endSession of [...liveSessionEnders]) {
    try {
      endSession('pagehide')
    } catch (err) {
      console.error('Could not write out a recovery journal session while the page was unloaded', err)
    }
  }
}

/**
 * Registers a live session, so that it is ended when the page is unloaded.
 * The `pagehide` listener exists only while at least one session is
 * registered: a module that a hot update has replaced leaves no listener
 * behind once its sessions are gone.
 *
 * @param   {LiveSessionEnder}  endSession  Ends the session with the given reason
 *
 * @return  {() => void}                    Call this once the session has ended
 */
export function registerLiveSession (endSession: LiveSessionEnder): () => void {
  if (liveSessionEnders.size === 0) {
    window.addEventListener('pagehide', endLiveSessionsOnPageHide)
  }
  liveSessionEnders.add(endSession)

  return () => {
    if (liveSessionEnders.delete(endSession) && liveSessionEnders.size === 0) {
      window.removeEventListener('pagehide', endLiveSessionsOnPageHide)
    }
  }
}
