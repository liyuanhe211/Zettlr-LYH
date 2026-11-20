/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        registerRuntimeErrorReporting, buildErrorEventReport
 * CVM-Role:        Controller
 * License:         GNU GPL v3
 *
 * Description:     Catches errors that nothing in the renderer handled
 *                  (thrown errors and rejected promises) and reports them to
 *                  the main process, which writes them silently to the
 *                  runtime error log and no longer shows a dialog
 *                  (requirement R99). This replaces the full-window overlay
 *                  of the development server, which is turned off for runtime
 *                  errors.
 *
 * END HEADER
 */

import type { RuntimeErrorReport } from '@providers/windows/runtime-error-notice'
import {
  collectResizeObserverDiagnosis,
  formatResizeObserverDiagnosis,
  installResizeObserverDiagnostics,
  RESIZE_OBSERVER_LOOP_MESSAGE
} from './resize-observer-diagnostics'

const ipcRenderer = window.ipc

/**
 * Turns whatever was thrown or rejected into a message and, if available, a
 * stack trace.
 *
 * @param   {unknown}  reason  The thrown value or the rejection reason
 *
 * @return  {{ message: string, stack?: string }}  The message and the stack trace
 */
function describeReason (reason: unknown): { message: string, stack?: string } {
  if (reason instanceof Error) {
    return { message: `${reason.name}: ${reason.message}`, stack: reason.stack }
  }

  if (typeof reason === 'string') {
    return { message: reason }
  }

  try {
    return { message: JSON.stringify(reason) ?? String(reason) }
  } catch (_err) {
    return { message: String(reason) }
  }
}

/**
 * Sends an error report to the main process. Reporting must never throw
 * itself, otherwise it would report its own error over and over again.
 *
 * @param   {RuntimeErrorReport}  report  The error report
 */
function send (report: RuntimeErrorReport): void {
  try {
    ipcRenderer.send('renderer-runtime-error', report)
  } catch (err) {
    console.error('[Runtime Error Reporting] Could not report an error to the main process', err)
  }
}

/**
 * Turns an error event into an error report. The ResizeObserver loop
 * notification carries no stack; in development builds, the diagnosis of the
 * observers (see resize-observer-diagnostics.ts) takes its place, as one line
 * of text, so that the signature of the log entry stays the same.
 *
 * @param   {ErrorEvent}          event  The error event
 *
 * @return  {RuntimeErrorReport}         The report
 */
export function buildErrorEventReport (event: Pick<ErrorEvent, 'error'|'message'|'filename'|'lineno'|'colno'>): RuntimeErrorReport {
  // Some errors carry no error object (e.g., the ResizeObserver loop
  // notification), only a message
  const { message, stack } = event.error != null
    ? describeReason(event.error)
    : { message: event.message, stack: undefined }

  const report: RuntimeErrorReport = {
    kind: 'error',
    message: message !== '' ? message : 'Unknown error',
    stack,
    source: event.filename !== '' ? event.filename : undefined,
    line: event.lineno > 0 ? event.lineno : undefined,
    column: event.colno > 0 ? event.colno : undefined
  }

  if (stack === undefined && message.includes(RESIZE_OBSERVER_LOOP_MESSAGE)) {
    try {
      const diagnosis = collectResizeObserverDiagnosis()
      if (diagnosis !== undefined) {
        report.stack = formatResizeObserverDiagnosis(diagnosis)
      }
    } catch (err) {
      console.error('[Runtime Error Reporting] Could not collect the ResizeObserver diagnosis', err)
    }
  }

  return report
}

/**
 * Registers the listeners that report uncaught errors to the main process.
 */
export default function registerRuntimeErrorReporting (): void {
  // Development builds only: remember which observer does what, so that a
  // ResizeObserver loop error can say which observers were involved
  installResizeObserverDiagnostics()

  window.addEventListener('error', (event: ErrorEvent) => {
    send(buildErrorEventReport(event))
  })

  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    const { message, stack } = describeReason(event.reason)
    send({ kind: 'unhandledrejection', message, stack })
  })
}
