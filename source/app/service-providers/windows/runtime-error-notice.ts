/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        RuntimeErrorReport, RuntimeErrorNoticeText,
 *                  isRuntimeErrorReport, formatRuntimeErrorLogEntry,
 *                  toRuntimeErrorLogEntry, formatUserNotice,
 *                  RuntimeErrorNoticeGate
 * CVM-Role:        Utility
 * License:         GNU GPL v3
 *
 * Description:     Handles the reports that renderers send over the
 *                  `renderer-runtime-error` channel. An uncaught error becomes
 *                  a line in the general log and an entry in the runtime error
 *                  log, without a dialog (requirement R99). A report marked
 *                  as a user notice (an operation that did not complete)
 *                  becomes a dialog with a neutral title and the message as
 *                  its text. A gate keeps those dialogs from piling up: only
 *                  one is open at a time, and each distinct message is shown
 *                  once per run. This module does not depend on Electron, so
 *                  it can be tested directly.
 *
 * END HEADER
 */

import type { RuntimeErrorLogInput } from '../log/runtime-error-log'

/**
 * How many characters of a stack trace the log entry keeps at most
 */
const MAX_STACK_LENGTH = 4000

/**
 * An uncaught error, as a renderer reports it
 */
export interface RuntimeErrorReport {
  /** Whether it was a thrown error or a rejected promise nobody handled */
  kind: 'error'|'unhandledrejection'
  /** The error message */
  message: string
  /** The stack trace, if there is one */
  stack?: string
  /** The script in which the error happened, if known */
  source?: string
  /** The line in that script, if known */
  line?: number
  /** The column in that line, if known */
  column?: number
  /**
   * Whether this tells the user that an operation did not complete, rather
   * than reporting an uncaught error. Only such reports get a dialog.
   */
  userNotice?: boolean
}

/**
 * The text of the dialog for a user notice
 */
export interface RuntimeErrorNoticeText {
  title: string
  message: string
  detail: string
}

/**
 * Checks that something a renderer sent is a usable error report, since the
 * payload of an IPC message is not typed.
 *
 * @param   {unknown}  payload  What the renderer sent
 *
 * @return  {boolean}           Whether it is a usable error report
 */
export function isRuntimeErrorReport (payload: unknown): payload is RuntimeErrorReport {
  if (payload === null || typeof payload !== 'object') {
    return false
  }

  const report = payload as Record<string, unknown>
  return (report.kind === 'error' || report.kind === 'unhandledrejection') &&
    typeof report.message === 'string' &&
    (report.userNotice === undefined || typeof report.userNotice === 'boolean')
}

/**
 * Shortens a text to at most the given length, marking the cut with an
 * ellipsis.
 *
 * @param   {string}  text       The text
 * @param   {number}  maxLength  The maximum length
 *
 * @return  {string}             The text, shortened if necessary
 */
function shorten (text: string, maxLength: number): string {
  return text.length > maxLength ? text.slice(0, maxLength - 1) + '…' : text
}

/**
 * Describes where in the code the error happened, e.g. "index.js:120:7".
 *
 * @param   {RuntimeErrorReport}  report  The error report
 *
 * @return  {string}                      The location, or an empty string
 */
function describeLocation (report: RuntimeErrorReport): string {
  if (report.source === undefined || report.source === '') {
    return ''
  }

  // Only the file name is of interest, not the URL of the dev server
  const fileName = report.source.split(/[\\/]/).pop()?.split('?')[0] ?? report.source
  let location = fileName
  // Line zero means that the browser does not know the line
  if (report.line !== undefined && report.line > 0) {
    location += `:${report.line}`
    if (report.column !== undefined && report.column > 0) {
      location += `:${report.column}`
    }
  }
  return location
}

/**
 * Builds the log entry for an uncaught error: one line with the window, the
 * kind, the message, the location, and the stack trace.
 *
 * @param   {RuntimeErrorReport}  report      The error report
 * @param   {string}              windowName  The window that reported it
 *
 * @return  {string}                          The log entry
 */
export function formatRuntimeErrorLogEntry (report: RuntimeErrorReport, windowName: string): string {
  const kind = report.kind === 'unhandledrejection' ? 'Unhandled promise rejection' : 'Uncaught error'
  let entry = `[Runtime Error] [${windowName}] ${kind}: ${report.message}`

  const location = describeLocation(report)
  if (location !== '') {
    entry += ` (${location})`
  }

  if (report.stack !== undefined && report.stack.trim() !== '') {
    entry += ` | Stack: ${shorten(report.stack, MAX_STACK_LENGTH).replace(/\s*\n\s*/g, ' --> ')}`
  }

  return entry
}

/**
 * Turns a renderer's error report into an entry for the runtime error log.
 * The runtime error log shortens the message and the stack trace itself.
 *
 * @param   {RuntimeErrorReport}  report      The error report
 * @param   {string}              windowName  The window that reported it
 *
 * @return  {RuntimeErrorLogInput}            The entry for the runtime error log
 */
export function toRuntimeErrorLogEntry (report: RuntimeErrorReport, windowName: string): RuntimeErrorLogInput {
  const entry: RuntimeErrorLogInput = {
    process: 'renderer',
    window: windowName,
    kind: report.kind === 'unhandledrejection' ? 'unhandledrejection' : 'error',
    message: report.message
  }

  const location = describeLocation(report)
  if (location !== '') {
    entry.location = location
  }

  if (report.stack !== undefined && report.stack.trim() !== '') {
    entry.stack = report.stack
  }

  return entry
}

/**
 * Builds the text of the dialog for a user notice, i.e., a report that tells
 * the user that an operation did not complete. The message is the report's
 * own text; the dialog says nothing about program errors or log files.
 *
 * @param   {RuntimeErrorReport}  report  The report
 *
 * @return  {RuntimeErrorNoticeText}      The title, message, and detail
 */
export function formatUserNotice (report: RuntimeErrorReport): RuntimeErrorNoticeText {
  return {
    title: 'Zettlr',
    message: report.message,
    detail: ''
  }
}

/**
 * Decides which user notices get a dialog: while one dialog is open, no other
 * one opens, and a message that already had its dialog during this run does
 * not get another one. Notices without a dialog are still logged.
 */
export class RuntimeErrorNoticeGate {
  private readonly shownMessages = new Set<string>()
  private dialogOpen = false

  /**
   * Checks whether the error gets a dialog, and if so, marks the dialog as
   * open and the message as shown. Call `close` once the dialog is closed.
   *
   * @param   {string}   message  The error message
   *
   * @return  {boolean}           Whether to show a dialog
   */
  tryOpen (message: string): boolean {
    if (this.dialogOpen || this.shownMessages.has(message)) {
      return false
    }

    this.dialogOpen = true
    this.shownMessages.add(message)
    return true
  }

  /**
   * Marks the dialog as closed, so that the next new message can get one.
   */
  close (): void {
    this.dialogOpen = false
  }
}
