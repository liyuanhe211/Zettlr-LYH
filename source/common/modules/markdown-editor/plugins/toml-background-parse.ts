/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TOML Background Parse
 * CVM-Role:        CodeMirror Plugin
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     The TOML highlighter is a legacy stream parser that can only
 *                  parse from the beginning of the document, and CodeMirror
 *                  itself only parses a limited stretch beyond the visible
 *                  area within a time budget. Jumping far away (e.g. by
 *                  dragging the scroll bar) would therefore first show plain,
 *                  unhighlighted text. This plugin parses the whole document
 *                  in slices of about 20 milliseconds during idle time, right
 *                  after the document was loaded and again after every change,
 *                  until the syntax tree reaches the end of the document, so
 *                  that the highlighting is already there wherever the user
 *                  jumps to. It uses requestIdleCallback where available and
 *                  timers otherwise, and cancels everything when the view is
 *                  destroyed.
 *
 * END HEADER
 */

import { forceParsing, language, syntaxTreeAvailable } from '@codemirror/language'
import { ViewPlugin, type EditorView, type PluginValue, type ViewUpdate } from '@codemirror/view'

/**
 * How many milliseconds one parsing slice may take at most. It is kept well
 * below the 50 milliseconds after which the browser counts a task as long.
 */
const PARSE_SLICE_MILLISECONDS = 20

/**
 * The shortest slice (in milliseconds) that is still worth starting. If the
 * idle period has less time left, the slice waits for the next idle period.
 */
const MINIMUM_SLICE_MILLISECONDS = 1

/**
 * After how many milliseconds an idle callback runs anyway, even though the
 * page never became idle (e.g. during continuous typing), so that the parsing
 * keeps advancing.
 */
const IDLE_CALLBACK_TIMEOUT_MILLISECONDS = 500

/**
 * The pause between two slices if requestIdleCallback is not available and
 * timers are used instead. It leaves the main thread room for input events.
 */
const TIMER_DELAY_MILLISECONDS = 10

/**
 * Schedules a function for the next idle period of the page, or for a short
 * timer if the page has no requestIdleCallback.
 *
 * @param   {Function}  work  Receives the idle deadline (undefined for timers)
 *
 * @return  {Function}        Cancels the scheduled function if it has not run
 */
function scheduleIdleWork (work: (deadline: IdleDeadline|undefined) => void): () => void {
  // Looked up on every call, so that it always reflects the current page
  const host: Partial<Pick<Window, 'requestIdleCallback'|'cancelIdleCallback'>> = typeof window !== 'undefined' ? window : {}
  const request = host.requestIdleCallback
  const cancel = host.cancelIdleCallback

  if (typeof request === 'function' && typeof cancel === 'function') {
    const handle = request.call(host, deadline => { work(deadline) }, { timeout: IDLE_CALLBACK_TIMEOUT_MILLISECONDS })
    return () => { cancel.call(host, handle) }
  }

  const timer = setTimeout(() => { work(undefined) }, TIMER_DELAY_MILLISECONDS)
  return () => { clearTimeout(timer) }
}

/**
 * Parses the document of a TOML editor to its end, slice by slice, while the
 * page is idle.
 */
class TOMLBackgroundParser implements PluginValue {
  private readonly view: EditorView

  /**
   * Cancels the scheduled slice; null if no slice is scheduled.
   */
  private cancelScheduledSlice: (() => void)|null = null

  constructor (view: EditorView) {
    this.view = view
    this.scheduleSlice()
  }

  update (update: ViewUpdate): void {
    // A change invalidates the syntax tree behind the change; carry on to the
    // new end of the document. (Empty transactions, such as the ones that
    // forceParsing dispatches to publish its progress, do not restart anything.)
    if (update.docChanged) {
      this.scheduleSlice()
    }
  }

  destroy (): void {
    if (this.cancelScheduledSlice !== null) {
      this.cancelScheduledSlice()
      this.cancelScheduledSlice = null
    }
  }

  /**
   * Schedules the next slice, unless one is already waiting or the syntax tree
   * already reaches the end of the document.
   */
  private scheduleSlice (): void {
    if (this.cancelScheduledSlice !== null) {
      return
    }

    const state = this.view.state
    // Without a language there is nothing to parse (and the tree would never
    // be reported as available)
    if (state.facet(language) === null || syntaxTreeAvailable(state, state.doc.length)) {
      return
    }

    this.cancelScheduledSlice = scheduleIdleWork(deadline => {
      this.cancelScheduledSlice = null
      this.parseSlice(deadline)
    })
  }

  /**
   * Parses for one slice, then schedules the next one if the end of the
   * document has not been reached yet.
   *
   * @param  {IdleDeadline|undefined}  deadline  The idle deadline, if any
   */
  private parseSlice (deadline: IdleDeadline|undefined): void {
    // Never run longer than the idle period allows, unless the callback only
    // ran because its timeout expired
    const budget = deadline === undefined || deadline.didTimeout
      ? PARSE_SLICE_MILLISECONDS
      : Math.min(PARSE_SLICE_MILLISECONDS, deadline.timeRemaining())

    if (budget >= MINIMUM_SLICE_MILLISECONDS) {
      forceParsing(this.view, this.view.state.doc.length, budget)
    }

    this.scheduleSlice()
  }
}

/**
 * Zettlr-LYH (R127): the view plugin that parses a TOML document to its end in
 * idle time, so that the highlighting is already there when the user jumps
 * far away.
 */
export const tomlBackgroundParse = ViewPlugin.fromClass(TOMLBackgroundParser)
