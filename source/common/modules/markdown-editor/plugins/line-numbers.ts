/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        CodeMirror Extension
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     A configurable line number extension for CodeMirror.
 *
 * END HEADER
 */

import {
  EditorView,
  lineNumbers,
  ViewPlugin,
  type ViewUpdate
} from '@codemirror/view'
import {
  type Extension,
  Compartment,
  EditorState
} from '@codemirror/state'
import { configUpdateEffect } from '../util/configuration'

const extensionCompartment = new Compartment()

interface LineNumberGeometry {
  element: HTMLElement
  firstRowOffset: number
  firstRowHeight: number
  rangeTop: number
  rangeHeight: number
  numberCenterOffset: number
  active: boolean
}

/**
 * Decorates the native gutter without changing its markers or width. Reading
 * cursor rectangles in requestMeasure also covers rendered Markdown, wrapping,
 * font changes and scaled editors without estimating rows from text length.
 */
class LineNumberFeedback {
  private readonly observer: ResizeObserver|null
  private observedGutter: Element|null = null

  constructor (private readonly view: EditorView) {
    this.observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.scheduleMeasure())
    this.observer?.observe(view.contentDOM)
    this.observer?.observe(view.scrollDOM)
    this.scheduleMeasure()
  }

  update (_update: ViewUpdate): void {
    this.scheduleMeasure()
  }

  destroy (): void {
    this.observer?.disconnect()
  }

  private scheduleMeasure (): void {
    this.view.requestMeasure({
      key: this,
      read: view => this.measure(view),
      write: measurements => {
        for (const measurement of measurements) {
          const { element } = measurement
          element.style.setProperty('--zettlr-number-row-offset', `${measurement.firstRowOffset}px`)
          element.style.setProperty('--zettlr-number-row-height', `${measurement.firstRowHeight}px`)
          element.style.setProperty('--zettlr-number-range-top', `${measurement.rangeTop}px`)
          element.style.setProperty('--zettlr-number-range-height', `${measurement.rangeHeight}px`)
          element.style.setProperty('--zettlr-number-center-offset', `${measurement.numberCenterOffset}px`)
          const activeChanged = element.hasAttribute('data-line-number-active') !== measurement.active
          element.toggleAttribute('data-line-number-active', measurement.active)
          element.toggleAttribute('data-line-number-wrapped', measurement.rangeHeight > 0)
          if (activeChanged) {
            // Re-read the numeral after its font weight changes.
            this.scheduleMeasure()
          }
        }
      }
    })
  }

  private measure (view: EditorView): LineNumberGeometry[] {
    const gutter = view.scrollDOM.querySelector(':scope > .cm-gutters > .cm-lineNumbers')
    if (gutter === null) {
      return []
    }
    if (gutter !== this.observedGutter) {
      if (this.observedGutter !== null) {
        this.observer?.unobserve(this.observedGutter)
      }
      this.observedGutter = gutter
      this.observer?.observe(gutter)
    }

    const measurements: LineNumberGeometry[] = []
    const activeLine = view.state.doc.lineAt(view.state.selection.main.head).number
    const scale = view.scaleY

    for (const child of Array.from(gutter.children)) {
      const element = child as HTMLElement
      // Ignore the hidden width spacer and non-numeric widget markers.
      if (element.style.visibility === 'hidden' || !/^\d+$/.test(element.textContent ?? '')) {
        continue
      }
      const lineNumber = Number(element.textContent)
      if (lineNumber < 1 || lineNumber > view.state.doc.lines) {
        continue
      }

      const line = view.state.doc.line(lineNumber)
      const firstRow = view.coordsAtPos(line.from, 1)
      const lastRow = view.coordsAtPos(line.to, -1)
      const rectangle = element.getBoundingClientRect()
      if (firstRow === null || rectangle.height === 0) {
        continue
      }

      const firstRowOffset = Math.max(0, (firstRow.top - rectangle.top) / scale)
      const firstRowHeight = (firstRow.bottom - firstRow.top) / scale
      const rangeTop = firstRowOffset + firstRowHeight
      // A tall image or a heading on one visual row is not a wrapped line.
      // Both endpoints must occupy distinct, non-overlapping text rows.
      const wrapped = lastRow !== null && lastRow.top >= firstRow.bottom - 1
      const block = view.lineBlockAt(line.from)
      const blockBottom = (view.documentTop + block.bottom - rectangle.top) / scale
      const numberRange = element.ownerDocument.createRange()
      numberRange.selectNodeContents(element)
      const numberRectangle = numberRange.getBoundingClientRect()

      measurements.push({
        element,
        firstRowOffset,
        firstRowHeight,
        rangeTop,
        rangeHeight: wrapped ? Math.max(0, blockBottom - rangeTop - 1) : 0,
        numberCenterOffset: (rectangle.right - (numberRectangle.left + numberRectangle.right) / 2) / view.scaleX,
        active: lineNumber === activeLine
      })
    }
    return measurements
  }
}

const lineNumberFeedback = ViewPlugin.fromClass(LineNumberFeedback)

/** Resolves the independent size, or an automatic size four pixels smaller. */
export function resolveLineNumberFontSize (editorFontSize: number, configuredSize: unknown): number {
  return typeof configuredSize === 'number' && Number.isFinite(configuredSize) && configuredSize > 0
    ? Math.max(1, Math.min(96, configuredSize))
    : Math.max(1, editorFontSize - 4)
}

/**
 * A TransactionExtender that reconfigures the line number compartment in response
 * to a showLineNumbersEffect if applicable.
 */
const modeSwitcher = EditorState.transactionExtender.of(transaction => {
  // Apply whatever the last effect told us
  let showLineNumbers: boolean|undefined

  for (const effect of transaction.effects) {
    // Allow updating both via the main config and a dedicated effect.
    if (effect.is(configUpdateEffect)) {
      if (effect.value.showMarkdownLineNumbers !== undefined) {
        showLineNumbers = effect.value.showMarkdownLineNumbers
      }
    }
  }

  if (showLineNumbers === true) {
    return { effects: extensionCompartment.reconfigure([lineNumbers()]) }
  } else if (showLineNumbers === false) {
    return { effects: extensionCompartment.reconfigure([]) }
  } else {
    return null
  }
})

/**
 * A configurable line number renderer.
 *
 * @param   {boolean}      show  Initial setting for the highlighter
 *                                    (default: true)
 *
 * @return  {Extension[]}             The extension.
 */
export function showLineNumbers (show: boolean = true): Extension[] {
  const lineNumbersExtension = extensionCompartment.of(show ? [lineNumbers()] : [])

  return [
    lineNumbersExtension,
    modeSwitcher,
    lineNumberFeedback,
    EditorView.baseTheme({
      '.cm-lineNumbers': {
        color: 'rgb(from currentColor calc(r * 1.69) calc(g * 1.69) calc(b * 1.69))'
      },
      // The native marker remains the width authority. Only its first row's
      // line box and decorative, non-interactive range marker are repositioned.
      '.cm-lineNumbers .cm-gutterElement': {
        display: 'block',
        position: 'relative',
        boxSizing: 'border-box',
        textAlign: 'right',
        paddingTop: 'var(--zettlr-number-row-offset, 0px)',
        lineHeight: 'var(--zettlr-number-row-height, normal)'
      },
      '.cm-lineNumbers .cm-gutterElement[data-line-number-active]': {
        fontWeight: 'bold',
        '--zettlr-number-range-width': '2px'
      },
      '.cm-lineNumbers .cm-gutterElement[data-line-number-wrapped]::after': {
        content: '""',
        position: 'absolute',
        pointerEvents: 'none',
        boxSizing: 'border-box',
        top: 'var(--zettlr-number-range-top)',
        height: 'var(--zettlr-number-range-height)',
        // Center the original border stroke on the entire measured numeral.
        right: 'var(--zettlr-number-center-offset, 0px)',
        width: '0',
        transform: 'translateX(50%)',
        borderLeft: 'var(--zettlr-number-range-width, 1px) solid currentColor'
      }
    })
  ]
}
