/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Replacement guard
 * CVM-Role:        Utility
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH data loss prevention (R173, specification C21
 *                  section 6): the decisions around replacing the state of an
 *                  editor, as pure functions. `decideReplacement` tells what
 *                  has to happen to the unconfirmed local modifications of an
 *                  editor before its state is replaced with new content.
 *                  `splitRecoverableSessions` tells which recoverable sessions
 *                  of a file are settled by the content that was just loaded
 *                  and which ones the user has to decide about.
 *                  `minimalReplacement` is the one change that turns the text
 *                  of the editor into the text of a recovered session.
 *
 * END HEADER
 */

/**
 * What happens to the unconfirmed local modifications when the editor state is
 * replaced:
 *
 * * `replace`: nothing; the state is replaced right away.
 * * `replay`: the state is replaced, then the unconfirmed local modifications
 *   are dispatched again, one by one, onto the new state.
 * * `preserve`: the modifications stay behind in the recovery journal, as a
 *   session that ends with unconfirmed steps; then the state is replaced.
 */
export type ReplacementVerdict = 'replace'|'replay'|'preserve'

export interface ReplacementSituation {
  /** Whether the editor has local modifications that the document authority has not confirmed */
  hasUnconfirmedChanges: boolean
  /** The content that is about to be loaded into the editor */
  newContent: string
  /** What the editor shows right now */
  currentContent: string
  /** What the editor showed when all of its local modifications were last confirmed */
  lastConfirmedContent: string
  /**
   * Whether the unconfirmed local modifications still apply, step by step, to
   * the last confirmed content
   */
  canReplay: boolean
}

/**
 * Decides what has to happen to the unconfirmed local modifications of an
 * editor before its state is replaced with new content.
 *
 * @param   {ReplacementSituation}  situation  What is known about the editor
 *                                             and the new content
 *
 * @return  {ReplacementVerdict}               The verdict
 */
export function decideReplacement (situation: ReplacementSituation): ReplacementVerdict {
  if (!situation.hasUnconfirmedChanges) {
    return 'replace'
  }

  // The new content already contains everything the editor has
  if (situation.newContent === situation.currentContent) {
    return 'replace'
  }

  // The new content is what the unconfirmed modifications were made on
  if (situation.canReplay && situation.newContent === situation.lastConfirmedContent) {
    return 'replay'
  }

  return 'preserve'
}

/** What the split needs to know about a recoverable session */
export interface RecoverableSessionText {
  /** The text of the session, rebuilt from the recovery journal */
  finalText: string
  /** When the session began, in milliseconds since the epoch */
  startedAt: number
  /** The time of the last local step of the session, in milliseconds since the epoch */
  lastStepAt: number
}

export interface RecoverableSessionSplit<Session extends RecoverableSessionText> {
  /** The sessions whose text is the loaded content: nothing of them is missing in the document */
  delivered: Session[]
  /** The sessions whose text differs from the loaded content, the newest first */
  undecided: Session[]
}

/**
 * Splits the recoverable sessions of a file into those that the loaded content
 * settles and those that the user has to decide about.
 *
 * @param   {Session[]}  sessions       The recoverable sessions of the file
 * @param   {string}     loadedContent  The content that was loaded into the editor
 *
 * @return  {RecoverableSessionSplit<Session>}  Both groups
 */
export function splitRecoverableSessions<Session extends RecoverableSessionText> (
  sessions: readonly Session[],
  loadedContent: string
): RecoverableSessionSplit<Session> {
  const delivered: Session[] = []
  const undecided: Session[] = []
  for (const session of sessions) {
    if (session.finalText === loadedContent) {
      delivered.push(session)
    } else {
      undecided.push(session)
    }
  }

  undecided.sort((first, second) => {
    return second.lastStepAt - first.lastStepAt || second.startedAt - first.startedAt
  })

  return { delivered, undecided }
}

/** One change of a text: the range from `from` to `to` is replaced with `insert` */
export interface TextReplacement {
  from: number
  to: number
  insert: string
}

/**
 * Returns the one change that turns the current text into the target text and
 * leaves the common beginning and the common end of the two untouched, so
 * that the cursor and the view stay where they are as far as possible.
 *
 * @param   {string}  currentText  The text as it is
 * @param   {string}  targetText   The text as it should be
 *
 * @return  {TextReplacement|undefined}  The change; undefined if the texts are
 *                                       the same
 */
export function minimalReplacement (currentText: string, targetText: string): TextReplacement|undefined {
  if (currentText === targetText) {
    return undefined
  }

  const shorterLength = Math.min(currentText.length, targetText.length)
  let commonStart = 0
  while (commonStart < shorterLength && currentText.charCodeAt(commonStart) === targetText.charCodeAt(commonStart)) {
    commonStart++
  }

  let commonEnd = 0
  while (
    commonEnd < shorterLength - commonStart &&
    currentText.charCodeAt(currentText.length - 1 - commonEnd) === targetText.charCodeAt(targetText.length - 1 - commonEnd)
  ) {
    commonEnd++
  }

  return {
    from: commonStart,
    to: currentText.length - commonEnd,
    insert: targetText.slice(commonStart, targetText.length - commonEnd)
  }
}
