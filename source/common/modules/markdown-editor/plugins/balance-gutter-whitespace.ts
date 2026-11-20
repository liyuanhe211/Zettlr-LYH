/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        computeGutterBalance, gutterBalanceChanged,
 *                  balanceGutterWhitespacePlugin, balanceGutterWhitespace
 * CVM-Role:        Extension
 * License:         GNU GPL v3
 *
 * Description:     Keeps the white space to the left and to the right of the
 *                  text equally wide at normal margins (R56), removing the
 *                  extra opposite gutter at low Markdown margins (R81).
 *                  CodeMirror places the gutters
 *                  before the text (heading levels, folding, line numbers,
 *                  lint markers, PPTX preview pins) between the left padding
 *                  of the scroller and the content, while nothing of that
 *                  width sits on the right, so the text started further away
 *                  from the left edge than it ended from the right one. This
 *                  extension moves the gutters half their width into the left
 *                  padding and gives the content the same margin on the
 *                  right, which keeps the width of the text unchanged. A
 *                  ResizeObserver follows the width of the gutters and the
 *                  padding of the scroller (which changes with the fullscreen
 *                  mode and the window width) and writes both amounts as CSS
 *                  custom properties onto the scroller, where a theme picks
 *                  them up. Without a ResizeObserver (e.g., in tests), the
 *                  extension does nothing.
 *
 * END HEADER
 */

import { StateEffect, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'

/**
 * The CSS custom property on the scroller that holds how far, in pixels, the
 * gutters move into the start padding
 */
const SHIFT_PROPERTY = '--zettlr-gutter-shift'

/**
 * The CSS custom property on the scroller that holds the margin, in pixels,
 * at the end of the content
 */
const BALANCE_PROPERTY = '--zettlr-gutter-balance'

/**
 * The effect of the transaction that the balancer dispatches after it has
 * changed the amounts. The content then sits elsewhere but keeps its width,
 * so CodeMirror sees no change of the geometry and its layers do not redraw
 * by themselves; layers that draw next to the text (such as the code
 * backgrounds) redraw on this effect.
 */
export const gutterBalanceChanged = StateEffect.define<null>()

/**
 * The balancer that currently looks after each editor. Switching documents
 * replaces the state of the editor, which destroys the plugin and creates a
 * new one right away. The new one keeps the amounts that the old one left on
 * the scroller; removing them in between would let CodeMirror measure (and
 * draw the code backgrounds and the cursor) with the content in the wrong
 * place, and nothing would redraw them once the amounts came back.
 */
const currentBalancers = new WeakMap<EditorView, GutterWhitespaceBalancer>()

/**
 * How the white space around the text gets balanced, in pixels
 */
export interface GutterBalance {
  /** How far the gutters move into the start padding of the scroller */
  shift: number
  /** The margin at the end of the content */
  balance: number
}

/**
 * Turns a measured value into a usable length: negative values and values
 * that are not finite numbers count as zero.
 *
 * @param   {number}  value  The measured value
 *
 * @return  {number}         The value, or zero if it is unusable
 */
function usableLength (value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Computes how to balance the white space around the text. Without
 * balancing, the white space before the text is the start padding plus the
 * width of the gutters, and the white space after it is the end padding. The
 * gutters move half their width into the start padding (at most the whole
 * padding), and the content gets a margin at its end that makes both sides
 * equally wide. With equal paddings and gutters at most twice as wide as the
 * padding, both amounts are half the gutter width, so the text keeps its
 * width. Wider gutters can only move as far as the padding goes, and the
 * margin takes up the rest in the legacy mode. Compact margins instead cap
 * that extra margin at the shift: reducing padding below half the gutter
 * width progressively removes the artificial opposite gutter. At zero, the
 * gutters retain their normal layout width and no opposite margin is added.
 * When the end padding exceeds the start padding by more
 * than half the gutter width, the margin is zero and the end side stays the
 * wider one.
 *
 * @param   {number}         gutterWidth   The width of the gutters before the text
 * @param   {number}         paddingStart  The start (left) padding of the scroller
 * @param   {number}         paddingEnd    The end (right) padding of the scroller
 * @param   {boolean}        compact       Whether low margins may become asymmetric
 *
 * @return  {GutterBalance}                The shift and the balance, never negative
 */
export function computeGutterBalance (gutterWidth: number, paddingStart: number, paddingEnd: number, compact: boolean = true): GutterBalance {
  const width = usableLength(gutterWidth)
  const start = usableLength(paddingStart)
  const end = usableLength(paddingEnd)

  const shift = Math.min(width / 2, start)
  const symmetricBalance = Math.max(0, start - shift + width - end)
  const balance = compact ? Math.min(symmetricBalance, shift) : symmetricBalance
  return { shift, balance }
}

/**
 * Finds the container of the gutters before the text, which CodeMirror puts
 * directly into the scroller.
 *
 * @param   {HTMLElement}       scroller  The scroller of the editor
 *
 * @return  {HTMLElement|null}            The gutter container, if there is one
 */
function findGuttersBefore (scroller: HTMLElement): HTMLElement|null {
  for (const child of Array.from(scroller.children)) {
    if (child.classList.contains('cm-gutters') && child.classList.contains('cm-gutters-before')) {
      return child as HTMLElement
    }
  }
  return null
}

/**
 * Moves the gutters and adds the margin. A negative `margin-inline-start`
 * alone does not suffice: CodeMirror makes the gutters sticky, and its base
 * theme pins them to the start edge (`inset-inline-start: 0`). Chromium keeps
 * a sticky element inside the scroller minus its padding, so it would push
 * the gutters back to where they were, on top of the text; the sticky offset
 * therefore gets the same negative value. This is a regular theme rather than
 * a base theme, and its selectors start at the editor element, so they win
 * over the base theme and do not reach editors nested in the content (such as
 * table cells). Only inline-direction properties are set, which leaves the
 * vertical margins of the typewriter mode alone.
 */
const balanceGutterWhitespaceTheme = EditorView.theme({
  '& > .cm-scroller > .cm-gutters.cm-gutters-before': {
    marginInlineStart: `calc(-1 * var(${SHIFT_PROPERTY}, 0px))`,
    insetInlineStart: `calc(-1 * var(${SHIFT_PROPERTY}, 0px))`
  },
  '& > .cm-scroller > .cm-content': {
    marginInlineEnd: `var(${BALANCE_PROPERTY}, 0px)`
  }
})

/**
 * Measures the gutters and the padding of the scroller whenever either
 * changes size, and writes the resulting amounts onto the scroller. The
 * content element is left alone, since CodeMirror rewrites its style
 * attribute.
 */
class GutterWhitespaceBalancer {
  private readonly observer: ResizeObserver|null
  private gutters: HTMLElement|null = null
  private appliedShift: number|null = null
  private appliedBalance: number|null = null
  private destroyed = false

  constructor (private readonly view: EditorView) {
    if (typeof ResizeObserver === 'undefined') {
      this.observer = null
      return
    }

    currentBalancers.set(view, this)

    // Observing the content box of the scroller catches changes of its
    // padding, observing the gutters catches changes of their width. Both
    // report once right after observe(), which takes the first measurement.
    this.observer = new ResizeObserver(() => { this.measure() })
    this.observer.observe(view.scrollDOM)
    this.followGutters()
  }

  update (_update: ViewUpdate): void {
    // Reconfiguring the extensions can replace or remove the gutters
    this.followGutters()
  }

  destroy (): void {
    this.destroyed = true
    this.observer?.disconnect()
    this.gutters = null

    // When the editor only switches its state, a new balancer has taken over
    // by the time this runs and keeps the amounts. They go away only with
    // the editor itself or with the extension.
    const view = this.view
    queueMicrotask(() => {
      if (currentBalancers.get(view) === this) {
        currentBalancers.delete(view)
        view.scrollDOM.style.removeProperty(SHIFT_PROPERTY)
        view.scrollDOM.style.removeProperty(BALANCE_PROPERTY)
      }
    })
  }

  /**
   * Makes sure that the observer watches the current gutter container. While
   * there is none, there is nothing to balance.
   */
  private followGutters (): void {
    const observer = this.observer
    if (observer === null || this.destroyed) {
      return
    }

    const current = findGuttersBefore(this.view.scrollDOM)
    if (current === this.gutters) {
      return
    }

    if (this.gutters !== null) {
      observer.unobserve(this.gutters)
    }

    this.gutters = current
    if (current !== null) {
      // The observer reports the new element right away and measures it then
      observer.observe(current)
    } else {
      this.apply(0, 0)
    }
  }

  /**
   * Reads the width of the gutters and the padding of the scroller, and
   * applies the resulting amounts. Runs in the observer callback, i.e., after
   * the layout is done, so reading it costs nothing extra.
   */
  private measure (): void {
    if (this.destroyed) {
      return
    }

    this.followGutters()
    const gutters = this.gutters
    if (gutters === null) {
      return
    }

    const style = window.getComputedStyle(this.view.scrollDOM)
    const paddingLeft = parseFloat(style.paddingLeft)
    const paddingRight = parseFloat(style.paddingRight)
    // In right-to-left text, the gutters before the text are on the right
    const rightToLeft = style.direction === 'rtl'
    // The Margin control only governs the main Markdown editor. Keep the
    // existing geometry of code files, distraction free mode and subeditors.
    const compact = this.view.dom.matches('.main-editor-wrapper:not(.code-file):not(.fullscreen) > .cm-editor')
    const { shift, balance } = computeGutterBalance(
      gutters.offsetWidth,
      rightToLeft ? paddingRight : paddingLeft,
      rightToLeft ? paddingLeft : paddingRight,
      compact
    )
    this.apply(shift, balance)
  }

  /**
   * Writes both amounts onto the scroller, unless they are unchanged. Since
   * the content then has a different width or position, CodeMirror has to
   * measure again: its own observer only watches the size of the scroller,
   * which stays the same. A position alone does not count as a change of the
   * geometry, so a transaction with `gutterBalanceChanged` then tells the
   * layers to redraw. This can run during an update of the view, where no
   * transaction may be dispatched, hence it waits until the update is done.
   *
   * @param   {number}  shift    How far the gutters move into the padding
   * @param   {number}  balance  The margin at the end of the content
   */
  private apply (shift: number, balance: number): void {
    if (shift === this.appliedShift && balance === this.appliedBalance) {
      return
    }

    this.appliedShift = shift
    this.appliedBalance = balance
    const style = this.view.scrollDOM.style
    style.setProperty(SHIFT_PROPERTY, `${shift}px`)
    style.setProperty(BALANCE_PROPERTY, `${balance}px`)
    this.view.requestMeasure()
    queueMicrotask(() => {
      if (!this.destroyed) {
        this.view.dispatch({ effects: gutterBalanceChanged.of(null) })
      }
    })
  }
}

/**
 * The view plugin that measures the gutters and the padding (exported for the
 * tests)
 */
export const balanceGutterWhitespacePlugin = ViewPlugin.fromClass(GutterWhitespaceBalancer)

/**
 * Balances normal margins and removes avoidable compensation at low margins.
 */
export const balanceGutterWhitespace: Extension = [ balanceGutterWhitespacePlugin, balanceGutterWhitespaceTheme ]
