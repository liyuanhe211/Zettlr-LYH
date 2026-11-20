/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        IPC listener isolation
 * CVM-Role:        Utility Function
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH data loss prevention (R173, specification C21
 *                  section 2): wraps a listener so that nothing it throws, and
 *                  no rejection of a promise it returns, reaches the event
 *                  emitter that calls it. Node's EventEmitter stops calling the
 *                  remaining listeners of a channel as soon as one of them
 *                  throws, so a single broken listener used to silence every
 *                  listener registered after it. This module must not import
 *                  Electron: it is tested with a plain EventEmitter.
 *
 * END HEADER
 */

/**
 * What the isolation reports about a failed listener. It has the shape of the
 * runtime error reports (requirement R99), so that it can be sent over the
 * `renderer-runtime-error` channel as it is.
 */
export interface ListenerFailureReport {
  /** A listener failure is always reported as a thrown error */
  kind: 'error'
  /** Starts with `[IPC listener on <channel>] `, followed by the error description */
  message: string
  /** The stack of the error; for a thrown value that is no error, the stack of the place where it was caught */
  stack: string
}

/**
 * Receives the report on a failed listener, and the value that was thrown (or
 * the reason of the rejection). It may throw itself; the isolation swallows
 * that.
 */
export type ListenerFailureReporter = (report: ListenerFailureReport, error: unknown) => void

/**
 * Describes a thrown value in one line.
 *
 * @param   {unknown}  error  The value that was thrown
 *
 * @return  {string}          The description
 */
function describeError (error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`
  }

  if (typeof error === 'string') {
    return error
  }

  try {
    return JSON.stringify(error) ?? String(error)
  } catch (_err) {
    return String(error)
  }
}

/**
 * Builds the report on a failed listener.
 *
 * @param   {string}                 channel  The channel the listener listens on
 * @param   {unknown}                error    The value that was thrown
 *
 * @return  {ListenerFailureReport}           The report
 */
export function buildListenerFailureReport (channel: string, error: unknown): ListenerFailureReport {
  const description = describeError(error)
  let stack: string|undefined
  if (error instanceof Error && typeof error.stack === 'string' && error.stack !== '') {
    stack = error.stack
  } else {
    // A thrown value that is no error carries no stack. The stack of this
    // place at least names the listener isolation and what called it.
    stack = new Error(description).stack
  }

  return {
    kind: 'error',
    message: `[IPC listener on ${channel}] ${description}`,
    stack: stack ?? description
  }
}

/**
 * Wraps a listener so that it can never disturb the emitter that calls it:
 * an exception it throws is caught, and so is the rejection of a promise it
 * returns. Each failure is handed to the reporter exactly once; a reporter
 * that throws is ignored.
 *
 * @param   {string}                   channel   The channel the listener listens on
 * @param   {Function}                 listener  The listener to wrap
 * @param   {ListenerFailureReporter}  report    Receives each failure
 *
 * @return  {Function}                           The wrapped listener; it returns nothing
 */
export function isolateListener<Arguments extends any[]> (
  channel: string,
  listener: (...args: Arguments) => unknown,
  report: ListenerFailureReporter
): (...args: Arguments) => void {
  const handleFailure = (error: unknown): void => {
    try {
      report(buildListenerFailureReport(channel, error), error)
    } catch (_err) {
      // Reporting must never throw itself: that would bring back the very
      // failure this function exists to contain.
    }
  }

  return (...args: Arguments): void => {
    try {
      const result: any = listener(...args)
      if (result != null && typeof result.then === 'function') {
        // The listener is asynchronous; a rejection nobody handles would
        // otherwise surface as an unhandled rejection of the window.
        result.then(undefined, handleFailure)
      }
    } catch (error) {
      handleFailure(error)
    }
  }
}
