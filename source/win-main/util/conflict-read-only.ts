import { Compartment, EditorState, Prec, StateEffect, Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { ConflictReadOnlySession, ConflictReadOnlySnapshot } from '@dts/common/documents'

export const CONFLICT_READ_ONLY_REGISTRY_KEY = 'zettlr-conflict-read-only-registry'

export interface ConflictReadOnlyRegistry {
  readonly ready: boolean
  readonly legacy: boolean
  readonly sessions: readonly ConflictReadOnlySession[]
  isReadOnly: (filePath: string) => boolean
  registerPane: (leafId: string, host: HTMLElement|null) => void
}

/** Reject stale snapshots, including replies overtaken by a live event. */
export class ConflictReadOnlyState {
  revision = -1
  sessions: ConflictReadOnlySession[] = []
  legacy = false

  /** Only an explicit unsupported response can enable compatibility mode. */
  markUnsupported (): void {
    if (this.revision < 0) { this.legacy = true }
  }

  applySnapshot (value: unknown): boolean {
    if (typeof value !== 'object' || value === null) { return false }
    const snapshot = value as Partial<ConflictReadOnlySnapshot>
    if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision! < 0 || snapshot.revision! <= this.revision || !Array.isArray(snapshot.sessions)) {
      return false
    }
    if (!snapshot.sessions.every(session => session !== null && typeof session === 'object' &&
      typeof session.filePath === 'string' && typeof session.sessionId === 'string' &&
      typeof session.windowId === 'string' && typeof session.leafId === 'string')) {
      return false
    }
    this.revision = snapshot.revision!
    this.legacy = false
    this.sessions = snapshot.sessions.map(session => ({ ...session }))
    return true
  }
}

export function isUnsupportedConflictReadOnlyCommand (error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('get-conflict-read-only-state') && /unknown command|unsupported command|unrecognized command/i.test(message)
}

const conflictReadOnlyCompartment = new Compartment()

/** Also block programmatic editing commands; collaborative acknowledgements may pass. */
export function setOriginalEditorConflictReadOnly (view: EditorView, readOnly: boolean): void {
  const extensions = readOnly
    ? [
        EditorState.readOnly.of(true),
        Prec.highest(EditorView.editable.of(false)),
        EditorState.transactionFilter.of(transaction => {
          return transaction.docChanged && transaction.annotation(Transaction.remote) !== true ? [] : transaction
        })
      ]
    : []
  if (conflictReadOnlyCompartment.get(view.state) === undefined) {
    if (readOnly) {
      view.dispatch({ effects: StateEffect.appendConfig.of(conflictReadOnlyCompartment.of(extensions)) })
    }
  } else {
    view.dispatch({ effects: conflictReadOnlyCompartment.reconfigure(extensions) })
  }
}
