import { syntaxTree } from '@codemirror/language'
import { EditorSelection, RangeSetBuilder, type Extension } from '@codemirror/state'
import {
  Decoration,
  Direction,
  EditorView,
  layer,
  RectangleMarker,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'
import { gutterBalanceChanged } from './balance-gutter-whitespace'

/**
 * Whether the background layers have to redraw their markers. Besides changes
 * of the document and the viewport, this includes the balancing of the white
 * space around the text (R56), which moves the text sideways without
 * CodeMirror noticing a change of the geometry.
 *
 * @param   {ViewUpdate}  update  The view update
 *
 * @return  {boolean}             True if the markers have to be redrawn
 */
function backgroundNeedsRedraw (update: ViewUpdate): boolean {
  // LayerView already handles geometryChanged and docViewUpdate. Background
  // parsing, however, can finish without either geometry or document changes.
  return update.docChanged || update.viewportChanged ||
    syntaxTree(update.startState) !== syntaxTree(update.state) || update.transactions.some(
    transaction => transaction.effects.some(effect => effect.is(gutterBalanceChanged))
  )
}

const codeBlockLineDeco = Decoration.line({ class: 'code-block-line' })

/**
 * Marks every line of a code block (fences included) with the class
 * `code-block-line`, so that the main editor can exempt those lines from the
 * justified alignment of Markdown text.
 *
 * @param   {EditorView}     view  The editor view
 *
 * @return  {DecorationSet}        The line decorations
 */
function buildCodeBlockLineDecorations (view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  let lastLineStart = -1

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (![ 'FencedCode', 'CodeBlock', 'IndentedCode' ].includes(node.name)) {
          return
        }

        const start = Math.max(node.from, from)
        const end = Math.min(node.to, to)
        if (start >= end) {
          return false
        }
        const firstLine = view.state.doc.lineAt(start).number
        const lastLine = view.state.doc.lineAt(end - 1).number
        for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber++) {
          const lineStart = view.state.doc.line(lineNumber).from
          if (lineStart > lastLineStart) {
            builder.add(lineStart, lineStart, codeBlockLineDeco)
            lastLineStart = lineStart
          }
        }
        return false
      }
    })
  }

  return builder.finish()
}

export const codeBlockLineClass = ViewPlugin.fromClass(class {
  decorations: DecorationSet

  constructor (view: EditorView) {
    this.decorations = buildCodeBlockLineDecorations(view)
  }

  update (update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
      this.decorations = buildCodeBlockLineDecorations(update.view)
    }
  }
}, { decorations: value => value.decorations })

/**
 * A layer that renders a code background for both code blocks and block comments
 *
 * @return  {Extension}  A CodeMirror extension
 */
export const codeblockBackground = layer({
  above: false, // Render below text
  class: 'cm-codeBackgroundLayer',
  update: backgroundNeedsRedraw, // Return true to redraw markers
  markers (view) {
    const markers: RectangleMarker[] = []
    const ranges = new Map<string, { from: number, to: number }>()

    for (const { from, to } of view.visibleRanges) {
      syntaxTree(view.state).iterate({
        from,
        to,
        enter: (node) => {
          if (![ 'CodeText', 'CommentBlock' ].includes(node.name)) {
            return
          }

          if (node.from >= node.to) {
            return false
          }
          let start = node.from
          let end = node.to

          if (node.name === 'CodeText') {
            start = view.state.doc.lineAt(node.from).from
            // A node's end is exclusive. In particular, a CodeText fragment
            // ending after a newline must not include the following line.
            end = Math.min(view.state.doc.length, view.state.doc.lineAt(node.to - 1).to + 1)
          }

          ranges.set(`${start}:${end}`, { from: start, to: end })
          return false
        }
      })
    }

    // Container prefixes can split CodeText into several fragments on the same
    // line. Merge their expanded line ranges before measuring, as well as
    // deduplicating nodes encountered through multiple visible ranges.
    const merged: Array<{ from: number, to: number }> = []
    for (const range of [...ranges.values()].sort((a, b) => a.from - b.from || a.to - b.to)) {
      const previous = merged[merged.length - 1]
      if (previous !== undefined && range.from <= previous.to) {
        previous.to = Math.max(previous.to, range.to)
      } else {
        merged.push({ ...range })
      }
    }

    for (const range of merged) {
      for (const visible of view.visibleRanges) {
        const start = Math.max(range.from, visible.from)
        const end = Math.min(range.to, visible.to)
        if (start >= end) {
          continue
        }
        // Never bridge a folded/replaced gap with one selection rectangle.
        const localMarkers = RectangleMarker.forRange(
          view, 'code-block-line-background', EditorSelection.range(start, end)
        ).filter(marker => marker.width !== null && marker.width > 0 && marker.height > 0)
        for (let index = 0; index < localMarkers.length; index++) {
          const { top, left, width, height } = localMarkers[index]
          const classes = [ 'code', 'code-block-line-background' ]
          if (index === 0 && start === range.from) {
            classes.push('top')
          }
          if (index === localMarkers.length - 1 && end === range.to) {
            classes.push('bottom')
          }
          markers.push(new RectangleMarker(classes.join(' '), left, top, width, height))
        }
      }
    }
    return markers
  }
})

/**
 * Measures the background of an inline range from the boxes the browser has
 * actually laid out its text in, one marker per visual line. This is needed
 * for ranges that wrap onto a further visual line: `RectangleMarker.forRange`
 * treats them like a selection and extends them to the edges of the content,
 * which is wrong inside an inline-block element (e.g., a rendered
 * `<span style="display: inline-block; margin-left: 1.5em">`), where the
 * background would then cover the margin beside the box.
 *
 * @param   {EditorView}                    view       The editor view
 * @param   {string}                        className  The class of the markers
 * @param   {number}                        from       Start of the range
 * @param   {number}                        to         End of the range
 *
 * @return  {RectangleMarker[]|undefined}              The markers, or
 *                                                     undefined if the range
 *                                                     cannot be measured
 */
function laidOutRangeMarkers (view: EditorView, className: string, from: number, to: number): RectangleMarker[]|undefined {
  const range = document.createRange()
  try {
    const start = view.domAtPos(from, 1)
    const end = view.domAtPos(to, -1)
    range.setStart(start.node, start.offset)
    range.setEnd(end.node, end.offset)
  } catch (err) {
    return undefined
  }

  // Combine the boxes of all text and elements on the same visual line
  const lines: Array<{ left: number, right: number, top: number, bottom: number }> = []
  for (const rect of Array.from(range.getClientRects())) {
    if (rect.width <= 0 || rect.height <= 0) {
      continue
    }
    const middle = (rect.top + rect.bottom) / 2
    const line = lines.find(line => middle > line.top && middle < line.bottom)
    if (line === undefined) {
      lines.push({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })
    } else {
      line.left = Math.min(line.left, rect.left)
      line.right = Math.max(line.right, rect.right)
      line.top = Math.min(line.top, rect.top)
      line.bottom = Math.max(line.bottom, rect.bottom)
    }
  }
  if (lines.length === 0) {
    return undefined
  }

  // Markers are positioned relative to the same origin that CodeMirror uses
  // for RectangleMarker.forRange.
  const scroller = view.scrollDOM
  const scrollerRect = scroller.getBoundingClientRect()
  const originLeft = (view.textDirection === Direction.LTR ? scrollerRect.left : scrollerRect.right - scroller.clientWidth * view.scaleX) -
    scroller.scrollLeft * view.scaleX
  const originTop = scrollerRect.top - scroller.scrollTop * view.scaleY

  return lines.map(line => new RectangleMarker(
    className, line.left - originLeft, line.top - originTop, line.right - line.left, line.bottom - line.top
  ))
}

/**
 * An extension that renders backgrounds for inline code and inline comments.
 *
 * @return  {Extension}  A CodeMirror extension
 */
export const inlineCodeBackground = layer({
  above: false, // Render below text
  class: 'cm-inlineCodeBackgroundLayer',
  update: backgroundNeedsRedraw, // Return true to redraw markers
  markers (view) {
    const markers: RectangleMarker[] = []
    const seen = new Set<string>()

    for (const { from, to } of view.visibleRanges) {
      syntaxTree(view.state).iterate({
        from,
        to,
        enter: (node) => {
          if (![ 'InlineCode', 'Comment' ].includes(node.name)) {
            return
          }
          const key = `${node.name}:${node.from}:${node.to}`
          if (seen.has(key)) {
            return false
          }
          seen.add(key)

          // Additional check: Rendering of anything messes with the code
          // backgrounds, so we want to disable them in those cases. Here: inline
          // math.
          if (view.state.sliceDoc(node.from, node.from + 1) === '$') {
            return false
          }

          // NOTE: For inline code, the range includes the backticks, since
          // those remain visible (see the InlineCode case in the emphasis
          // renderer) and should look like part of the code span.
          const start = node.from
          const end = node.to

          const localMarkers = RectangleMarker.forRange(
            view,
            'inline-code-background',
            EditorSelection.range(start, end)
          )

          // A range on a single visual line is drawn exactly; a wrapped one
          // is measured from its laid out text instead (see above).
          if (localMarkers.length > 1) {
            markers.push(...laidOutRangeMarkers(view, 'inline-code-background', start, end) ?? localMarkers)
          } else {
            markers.push(...localMarkers)
          }
          return false
        }
      })
    }
    // Third, return
    return markers
  }
})

export const backgroundLayers: Extension[] = [
  codeblockBackground,
  inlineCodeBackground,
  codeBlockLineClass,
  EditorView.baseTheme({
    '.inline-code-background': {
      borderRadius: '2px',
      padding: '0 2px'
    },
    '.code-block-line-background.top': {
      borderTopLeftRadius: '4px',
      borderTopRightRadius: '4px'
    },
    '.code-block-line-background.bottom': {
      borderBottomLeftRadius: '4px',
      borderBottomRightRadius: '4px'
    }
  })
]
