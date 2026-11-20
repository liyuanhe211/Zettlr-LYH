/**
 * Copy buttons live outside contentDOM so they never become editor content,
 * move the selection, or add transactions to the undo history.
 *
 * Each button is a small icon-only control anchored to the top-right corner of
 * its code block's gray background (the area drawn by `codeblockBackground`),
 * and is only visible while the pointer hovers that area (or while the button
 * itself has keyboard focus).
 */

import { syntaxTree } from '@codemirror/language'
import { type EditorState, type Text } from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { type SyntaxNode } from '@lezer/common'
import { configField } from '../util/configuration'
import { codeNodeCategory, shouldRevealSource } from '../util/reveal-selection'

/** Edge length of the square button in CSS pixels (keep in sync with the theme). */
export const COPY_BUTTON_SIZE = 24
/** Distance between the top of the gray background and the top of the button. */
export const COPY_BUTTON_TOP_INSET = 4
/** Distance between the right edge of the content area and the button. */
export const COPY_BUTTON_RIGHT_INSET = 6
/** How long the "Copied" and "Copy failed" feedback stays before the icon resets. */
export const COPY_FEEDBACK_DURATION = 2500
/** Class that makes a button visible; all other buttons are transparent and inert. */
export const COPY_BUTTON_VISIBLE_CLASS = 'cm-code-block-copy-visible'
/** Class that marks the failure feedback state. */
export const COPY_BUTTON_FAILED_CLASS = 'cm-code-block-copy-failed'

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'

export type CopyButtonLabel = 'Copy'|'Copied'|'Copy failed'

/** A vertical extent; all geometry below shares one coordinate space per call. */
export interface VerticalExtent {
  top: number
  bottom: number
}

/** The area in which hovering the pointer reveals a button, edges inclusive. */
export interface CopyButtonRange {
  top: number
  bottom: number
  left: number
  right: number
}

/** Where a button is placed: `right` is its right edge, `top` its top edge. */
export interface CopyButtonAnchor {
  top: number
  right: number
}

export interface PointerPosition {
  x: number
  y: number
}

interface ClientPointer {
  clientX: number
  clientY: number
}

export interface CodeBlockPosition {
  from: number
  to: number
  /** Top edge of the button, in scroller content coordinates. */
  top: number
  /** Right edge of the button, in scroller content coordinates. */
  right: number
  /** Hover area of the block, in scroller content coordinates. */
  range: CopyButtonRange
}

/** One measurement pass: the visible blocks and the pointer in the same coordinates. */
export interface CodeBlockMeasurement {
  positions: CodeBlockPosition[]
  pointer: PointerPosition|undefined
}

/** The part of a button that the copy-and-feedback logic needs to know about. */
export interface CopyFeedbackButton {
  element: HTMLElement
  pending: boolean
  timer?: unknown
}

interface CopyButton extends CopyFeedbackButton {
  element: HTMLButtonElement
  document: Text
  from: number
  to: number
  range: CopyButtonRange
}

export interface CopyFeedbackEnvironment {
  clipboard: Pick<Clipboard, 'writeText'>|undefined
  /** False once the owner of the button (the editor plugin) has been destroyed. */
  isActive: () => boolean
  /** Replaceable so that tests do not have to wait for the real feedback delay. */
  schedule?: (callback: () => void, delay: number) => unknown
  cancel?: (handle: unknown) => void
}

function isCodeBlock (node: SyntaxNode): boolean {
  // Lezer calls indented code CodeBlock; keep the descriptive name compatible
  // with Markdown extensions that expose IndentedCode instead.
  return [ 'FencedCode', 'CodeBlock', 'IndentedCode' ].includes(node.name)
}

/**
 * Decides whether a code block gets a copy button. A rendered Mermaid diagram
 * is not copyable (its source is only shown while revealed), nor is math.
 */
export function isCopyableCodeBlock (state: EditorState, node: SyntaxNode): boolean {
  if (!isCodeBlock(node)) {
    return false
  }
  if (node.name !== 'FencedCode') {
    return true
  }
  const category = codeNodeCategory(state, node)
  if (category === 'math') {
    return false
  }
  const configuration = state.field(configField, false)
  const includeAdjacent = configuration?.previewModeShowSyntaxWhenCursorIsAdjacent ?? true
  // Match the Mermaid renderer's decision, including its empty-body exception.
  return category !== 'diagrams' ||
    node.getChild('CodeText') === null ||
    configuration?.renderingMode === 'raw' ||
    shouldRevealSource(state, 'diagrams', node.from, node.to, includeAdjacent)
}

/**
 * CodeText ranges exclude fences, language information and container/indent
 * markers. Joining their original slices preserves code whitespace and line
 * breaks without copying the rendered DOM or a nested language parser's text.
 */
export function getCodeBlockText (state: EditorState, node: SyntaxNode): string {
  return node.getChildren('CodeText')
    .map(content => state.sliceDoc(content.from, content.to))
    .join('')
}

/**
 * Finds the first and last line that carry the gray code background, exactly
 * as `codeblockBackground` does: it paints the lines of the non-empty CodeText
 * nodes (not the fence or language lines). A block without any CodeText, such
 * as an empty fence, has no gray background at all; then the first and last
 * line of the whole node serve as the fallback for the anchor and hover area.
 *
 * @param   {SyntaxNode}  node  A FencedCode or CodeBlock node
 * @return  {object}            A document position on the first line, one on the last line
 */
export function getCodeBlockBackgroundLines (node: SyntaxNode): {
  firstLinePosition: number
  lastLinePosition: number
  hasBackground: boolean
} {
  const texts = node.getChildren('CodeText').filter(text => text.from < text.to)
  if (texts.length === 0) {
    return { firstLinePosition: node.from, lastLinePosition: node.to, hasBackground: false }
  }
  return {
    firstLinePosition: texts[0].from,
    // A node's end is exclusive; the character before it is on the last line.
    lastLinePosition: texts[texts.length - 1].to - 1,
    hasBackground: true
  }
}

/**
 * Computes where the copy button goes. The top follows the top of the gray
 * background but is clamped to the visible area, so that the button stays
 * available while a long block is scrolled; `visible` is the scrollable
 * area currently on screen. `background` and `visible` must use one coordinate
 * space. `rightBoundary` is the right edge of the content area (already
 * limited to the visible area); the button sits `COPY_BUTTON_RIGHT_INSET`
 * pixels inside it.
 *
 * @param   {VerticalExtent}  background     Top and bottom of the gray background
 * @param   {VerticalExtent}  visible        Top and bottom of the visible area
 * @param   {number}          rightBoundary  Right boundary of the content area
 * @return  {CopyButtonAnchor|undefined}     The anchor, or undefined if no part of the gray background is visible
 */
export function computeCopyButtonAnchor (
  background: VerticalExtent,
  visible: VerticalExtent,
  rightBoundary: number
): CopyButtonAnchor|undefined {
  const values = [ background.top, background.bottom, visible.top, visible.bottom, rightBoundary ]
  if (!values.every(Number.isFinite)) {
    return undefined
  }
  if (background.bottom <= background.top || background.bottom <= visible.top || background.top >= visible.bottom) {
    return undefined
  }
  return {
    top: Math.max(background.top, visible.top) + COPY_BUTTON_TOP_INSET,
    right: rightBoundary - COPY_BUTTON_RIGHT_INSET
  }
}

/**
 * Computes the area that reveals a button: the gray background of the block,
 * enlarged where necessary so that it contains the whole button. A single-line
 * block is shorter than the button, which then protrudes below the gray area;
 * without this enlargement, moving the pointer onto that protruding part would
 * hide the button again.
 *
 * @param   {VerticalExtent}  background  Top and bottom of the gray background
 * @param   {object}          horizontal  Left and right edge of the gray background
 * @param   {CopyButtonAnchor}  anchor    The button anchor
 * @return  {CopyButtonRange}             The hover area
 */
export function computeCopyButtonHoverRange (
  background: VerticalExtent,
  horizontal: { left: number, right: number },
  anchor: CopyButtonAnchor
): CopyButtonRange {
  return {
    top: background.top,
    bottom: Math.max(background.bottom, anchor.top + COPY_BUTTON_SIZE),
    left: Math.min(horizontal.left, anchor.right - COPY_BUTTON_SIZE),
    right: Math.max(horizontal.right, anchor.right)
  }
}

/**
 * Tells whether the pointer is inside a hover area; a pointer exactly on any
 * edge counts as inside.
 */
export function isPointerInCopyRange (pointer: PointerPosition, range: CopyButtonRange): boolean {
  return pointer.x >= range.left && pointer.x <= range.right &&
    pointer.y >= range.top && pointer.y <= range.bottom
}

/**
 * Shows the button of the block under the pointer and hides every other
 * button. A button that has keyboard focus stays visible, so that keyboard
 * users can see what they are operating. Only the class of the elements is
 * changed; nothing in the document or selection is touched.
 *
 * @param   {Array}             entries         Each button element with its hover area
 * @param   {PointerPosition}   pointer         The pointer, or undefined if it left the editor
 * @param   {Element|null}      focusedElement  The element that has keyboard focus, if any
 * @return  {HTMLElement[]}                     The elements that are visible afterwards
 */
export function updateCopyButtonVisibility (
  entries: Array<{ element: HTMLElement, range: CopyButtonRange }>,
  pointer: PointerPosition|undefined,
  focusedElement: Element|null|undefined = null
): HTMLElement[] {
  // Neighboring areas may share an edge; the first one in document order wins,
  // so the pointer never reveals two buttons at once.
  const hovered = pointer === undefined
    ? undefined
    : entries.find(entry => isPointerInCopyRange(pointer, entry.range))?.element
  const visible: HTMLElement[] = []
  for (const { element } of entries) {
    const show = element === hovered || element === focusedElement
    element.classList.toggle(COPY_BUTTON_VISIBLE_CLASS, show)
    if (show) {
      visible.push(element)
    }
  }
  return visible
}

function createSvgElement (ownerDocument: Document, name: string, attributes: Record<string, string>): Element {
  const element = ownerDocument.createElementNS(SVG_NAMESPACE, name)
  for (const [ attribute, value ] of Object.entries(attributes)) {
    element.setAttribute(attribute, value)
  }
  return element
}

/**
 * Creates the icon for a button state: two overlapping rounded squares for
 * "Copy", a check mark for "Copied" and an exclamation circle for "Copy
 * failed". The icon is built with createElementNS and draws in currentColor.
 */
export function createCopyButtonIcon (ownerDocument: Document, label: CopyButtonLabel): Element {
  const kind = label === 'Copy' ? 'copy' : (label === 'Copied' ? 'check' : 'error')
  const icon = createSvgElement(ownerDocument, 'svg', {
    width: '14',
    height: '14',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
    'data-icon': kind
  })
  if (kind === 'copy') {
    icon.appendChild(createSvgElement(ownerDocument, 'rect', { x: '9', y: '9', width: '13', height: '13', rx: '2', ry: '2' }))
    icon.appendChild(createSvgElement(ownerDocument, 'path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }))
  } else if (kind === 'check') {
    icon.appendChild(createSvgElement(ownerDocument, 'path', { d: 'M20 6 9 17l-5-5' }))
  } else {
    icon.appendChild(createSvgElement(ownerDocument, 'circle', { cx: '12', cy: '12', r: '10' }))
    icon.appendChild(createSvgElement(ownerDocument, 'path', { d: 'M12 8v4M12 16h.01' }))
  }
  return icon
}

/**
 * Switches a button to a state: swaps the icon, sets the (English) accessible
 * name and tooltip, and marks or unmarks the failure state.
 */
export function setCopyButtonFeedback (element: HTMLElement, label: CopyButtonLabel): void {
  element.textContent = ''
  element.appendChild(createCopyButtonIcon(element.ownerDocument, label))
  element.setAttribute('aria-label', label)
  element.title = label
  element.classList.toggle(COPY_BUTTON_FAILED_CLASS, label === 'Copy failed')
}

/**
 * Creates the icon-only button, in its idle "Copy" state, without any click
 * behavior. It keeps pointer activation from focusing the button or reaching
 * any editor selection/source-reveal handler; native Tab, Enter and Space
 * still work.
 */
export function createCopyButtonElement (ownerDocument: Document): HTMLButtonElement {
  const element = ownerDocument.createElement('button')
  element.type = 'button'
  element.className = 'cm-code-block-copy'
  setCopyButtonFeedback(element, 'Copy')
  for (const name of [ 'pointerdown', 'mousedown' ]) {
    element.addEventListener(name, event => {
      event.preventDefault()
      event.stopPropagation()
    })
  }
  for (const name of [ 'mouseup', 'pointerup', 'dblclick', 'keydown', 'keyup' ]) {
    element.addEventListener(name, event => event.stopPropagation())
  }
  element.setAttribute('aria-live', 'polite')
  element.setAttribute('aria-atomic', 'true')
  return element
}

/**
 * Writes the text to the clipboard and reports the result on the button:
 * "Copied" on success, "Copy failed" on any failure (including text being
 * undefined, which means the block no longer exists). The feedback is reset to
 * "Copy" after `COPY_FEEDBACK_DURATION` milliseconds, if the button is still
 * in the document and its owner is still active.
 */
export async function copyTextWithFeedback (
  button: CopyFeedbackButton,
  text: string|undefined,
  environment: CopyFeedbackEnvironment
): Promise<void> {
  const schedule = environment.schedule ??
    ((callback: () => void, delay: number): unknown => setTimeout(callback, delay))
  const cancel = environment.cancel ?? ((handle: unknown) => { clearTimeout(handle as ReturnType<typeof setTimeout>) })
  const scheduleReset = (): void => {
    if (button.element.isConnected && environment.isActive()) {
      button.timer = schedule(() => setCopyButtonFeedback(button.element, 'Copy'), COPY_FEEDBACK_DURATION)
    }
  }

  cancel(button.timer)
  if (text === undefined) {
    setCopyButtonFeedback(button.element, 'Copy failed')
    scheduleReset()
    return
  }
  setCopyButtonFeedback(button.element, 'Copy')
  button.pending = true
  button.element.setAttribute('aria-disabled', 'true')
  try {
    if (environment.clipboard === undefined) {
      throw new Error('Clipboard is unavailable')
    }
    await environment.clipboard.writeText(text)
    if (button.element.isConnected && environment.isActive()) {
      setCopyButtonFeedback(button.element, 'Copied')
    }
  } catch {
    if (button.element.isConnected && environment.isActive()) {
      setCopyButtonFeedback(button.element, 'Copy failed')
    }
  } finally {
    button.pending = false
    button.element.removeAttribute('aria-disabled')
    scheduleReset()
  }
}

function parseCssPixels (value: string|undefined): number {
  const pixels = Number.parseFloat(value ?? '')
  return Number.isFinite(pixels) ? pixels : 0
}

export class CodeBlockCopyView {
  private readonly layer: HTMLDivElement
  private readonly buttons = new Map<string, CopyButton>()
  private readonly resizeObserver: ResizeObserver|undefined
  private destroyed = false
  /** The most recent pointer position (viewport coordinates) while it is over the editor. */
  private pointer: ClientPointer|undefined
  private focusedElement: HTMLElement|undefined
  private readonly measureRequest = {
    key: this,
    read: (view: EditorView) => this.measure(view),
    write: (measurement: CodeBlockMeasurement) => this.paint(measurement)
  }

  constructor (private readonly view: EditorView) {
    this.layer = view.dom.ownerDocument.createElement('div')
    this.layer.className = 'cm-code-block-copy-layer'
    this.layer.contentEditable = 'false'
    view.scrollDOM.appendChild(this.layer)
    view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true })
    view.scrollDOM.addEventListener('pointermove', this.onPointerMove, { passive: true })
    view.scrollDOM.addEventListener('mouseleave', this.onPointerLeave, { passive: true })
    this.layer.addEventListener('focusin', this.onFocusChange)
    this.layer.addEventListener('focusout', this.onFocusChange)
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(this.schedule)
      this.resizeObserver.observe(view.contentDOM)
      this.resizeObserver.observe(view.scrollDOM)
    }
    this.schedule()
  }

  update (update: ViewUpdate): void {
    if (update.docChanged) {
      // Disable old coordinates immediately, before the next measurement.
      this.clearButtons()
    }
    // Selection/configuration and background parsing may replace Mermaid
    // widgets or reveal fences without changing the document.
    this.schedule()
  }

  docViewUpdate (): void {
    this.schedule()
  }

  private readonly schedule = (): void => {
    if (!this.destroyed) {
      this.view.requestMeasure(this.measureRequest)
    }
  }

  private readonly onScroll = (): void => {
    // The hover areas live in content coordinates and do not move when the
    // content scrolls, but the pointer's content position does.
    this.refreshHover()
    this.schedule()
  }

  private readonly onPointerMove = (event: MouseEvent): void => {
    this.pointer = { clientX: event.clientX, clientY: event.clientY }
    this.refreshHover()
  }

  private readonly onPointerLeave = (): void => {
    this.pointer = undefined
    this.refreshHover()
  }

  private readonly onFocusChange = (event: FocusEvent): void => {
    const target = event.target
    this.focusedElement = event.type === 'focusin' && target !== null ? target as HTMLElement : undefined
    this.refreshHover()
  }

  private pointerInContent (pointer: ClientPointer): PointerPosition {
    const scroller = this.view.scrollDOM
    const scrollBounds = scroller.getBoundingClientRect()
    return {
      x: (pointer.clientX - scrollBounds.left) / this.view.scaleX + scroller.scrollLeft,
      y: (pointer.clientY - scrollBounds.top) / this.view.scaleY + scroller.scrollTop
    }
  }

  private refreshHover (): void {
    this.applyHover(this.pointer === undefined ? undefined : this.pointerInContent(this.pointer))
  }

  private applyHover (pointer: PointerPosition|undefined): void {
    if (this.destroyed) {
      return
    }
    const entries = [...this.buttons.values()].map(button => ({ element: button.element, range: button.range }))
    updateCopyButtonVisibility(entries, pointer, this.focusedElement)
  }

  /**
   * Reads the geometry of all visible, copyable code blocks and of the
   * pointer. This is the read half of the measure cycle; it is public so that
   * tests can call it with fake geometry, like `paint`.
   */
  measure (view: EditorView): CodeBlockMeasurement {
    if (this.destroyed || !view.inView) {
      return { positions: [], pointer: undefined }
    }
    const scroller = view.scrollDOM
    const scrollBounds = scroller.getBoundingClientRect()
    const contentBounds = view.contentDOM.getBoundingClientRect()
    // Viewport coordinates to the coordinates of the layer inside the scroller.
    const toContentX = (x: number): number => (x - scrollBounds.left) / view.scaleX + scroller.scrollLeft
    const toContentY = (y: number): number => (y - scrollBounds.top) / view.scaleY + scroller.scrollTop
    const visibleTop = scrollBounds.top + scroller.clientTop * view.scaleY
    const visibleBottom = visibleTop + scroller.clientHeight * view.scaleY
    const visibleRight = scrollBounds.left + (scroller.clientLeft + scroller.clientWidth) * view.scaleX
    const visible = { top: toContentY(visibleTop), bottom: toContentY(visibleBottom) }
    const rightBoundary = toContentX(Math.min(contentBounds.right, visibleRight))
    // The gray background spans the content area minus the padding of a line.
    const lineElement = view.contentDOM.querySelector('.cm-line')
    const lineStyle = lineElement === null ? undefined : view.dom.ownerDocument.defaultView?.getComputedStyle(lineElement)
    const horizontal = {
      left: toContentX(contentBounds.left + parseCssPixels(lineStyle?.paddingLeft)),
      right: toContentX(contentBounds.right - parseCssPixels(lineStyle?.paddingRight))
    }
    const documentTop = view.documentTop
    const positions = new Map<string, CodeBlockPosition>()

    for (const { from, to } of view.visibleRanges) {
      syntaxTree(view.state).iterate({
        from,
        to,
        enter: reference => {
          const node = reference.node
          if (!isCodeBlock(node)) {
            return
          }
          if (isCopyableCodeBlock(view.state, node)) {
            const { firstLinePosition, lastLinePosition } = getCodeBlockBackgroundLines(node)
            const background = {
              top: toContentY(documentTop + view.lineBlockAt(firstLinePosition).top),
              bottom: toContentY(documentTop + view.lineBlockAt(lastLinePosition).bottom)
            }
            // Keep the button available while scrolling a long block.
            const anchor = computeCopyButtonAnchor(background, visible, rightBoundary)
            if (anchor !== undefined) {
              positions.set(`${node.from}:${node.to}`, {
                from: node.from,
                to: node.to,
                top: anchor.top,
                right: anchor.right,
                range: computeCopyButtonHoverRange(background, horizontal, anchor)
              })
            }
          }
          return false
        }
      })
    }
    return {
      positions: [...positions.values()],
      // The most recent pointer position decides again after every measurement
      // (scrolling, document changes, resizing).
      pointer: this.pointer === undefined
        ? undefined
        : { x: toContentX(this.pointer.clientX), y: toContentY(this.pointer.clientY) }
    }
  }

  /**
   * Creates, moves and removes the buttons for a measurement and applies the
   * hover state. This is the write half of the measure cycle; it is public so
   * that tests can supply measurements without a layout engine.
   */
  paint (measurement: CodeBlockMeasurement): void {
    if (this.destroyed) {
      return
    }
    const { positions, pointer } = measurement
    const visibleKeys = new Set(positions.map(position => `${position.from}:${position.to}`))
    for (const [ key, button ] of this.buttons) {
      if (!visibleKeys.has(key)) {
        this.removeButton(button)
        this.buttons.delete(key)
      }
    }
    for (const position of positions) {
      const key = `${position.from}:${position.to}`
      let button = this.buttons.get(key)
      if (button === undefined) {
        button = this.createButton(position)
        this.buttons.set(key, button)
        this.layer.appendChild(button.element)
      }
      button.range = position.range
      button.element.style.top = `${position.top}px`
      button.element.style.left = `${position.right}px`
    }
    this.applyHover(pointer)
  }

  private createButton (position: CodeBlockPosition): CopyButton {
    const element = createCopyButtonElement(this.view.dom.ownerDocument)
    const button: CopyButton = {
      element, document: this.view.state.doc,
      from: position.from, to: position.to, pending: false, range: position.range
    }
    element.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      void this.copy(button)
    })
    return button
  }

  private async copy (button: CopyButton): Promise<void> {
    if (button.pending || button.document !== this.view.state.doc || this.destroyed) {
      return
    }
    // Re-resolve the block in the current tree; do not trust a cached body.
    let block: SyntaxNode|undefined
    syntaxTree(this.view.state).iterate({
      from: button.from,
      to: button.to,
      enter: reference => {
        if (isCodeBlock(reference.node)) {
          if (reference.from === button.from && reference.to === button.to &&
            isCopyableCodeBlock(this.view.state, reference.node)) {
            block = reference.node
          }
          return false
        }
      }
    })
    await copyTextWithFeedback(button, block === undefined ? undefined : getCodeBlockText(this.view.state, block), {
      clipboard: this.view.dom.ownerDocument.defaultView?.navigator.clipboard,
      isActive: () => !this.destroyed
    })
  }

  private removeButton (button: CopyButton): void {
    clearTimeout(button.timer as ReturnType<typeof setTimeout>|undefined)
    if (this.focusedElement === button.element) {
      this.focusedElement = undefined
    }
    button.element.remove()
  }

  private clearButtons (): void {
    for (const button of this.buttons.values()) {
      this.removeButton(button)
    }
    this.buttons.clear()
  }

  destroy (): void {
    this.destroyed = true
    this.view.scrollDOM.removeEventListener('scroll', this.onScroll)
    this.view.scrollDOM.removeEventListener('pointermove', this.onPointerMove)
    this.view.scrollDOM.removeEventListener('mouseleave', this.onPointerLeave)
    this.layer.removeEventListener('focusin', this.onFocusChange)
    this.layer.removeEventListener('focusout', this.onFocusChange)
    this.resizeObserver?.disconnect()
    this.clearButtons()
    this.layer.remove()
  }
}

export const codeBlockCopyPlugin = ViewPlugin.fromClass(CodeBlockCopyView)

/**
 * The style rules of the copy button. They are exported so that the tests can
 * inspect the selectors.
 *
 * The dark rules are keyed on the dark class that the application's dark mode
 * puts on the body (see register-themes.ts), not on CodeMirror's `&dark`.
 * The global button rule of the windows (generic.css, `body.win32.dark button`,
 * specificity 0,2,2) paints every button of the application, so the selectors
 * below, which CodeMirror expands to `body.dark .<editor scope> .cm-code-block-copy`
 * (specificity 0,3,1), have to stay more specific than that rule.
 */
export const CODE_BLOCK_COPY_THEME: Parameters<typeof EditorView.baseTheme>[0] = {
  '.cm-code-block-copy-layer': {
    position: 'absolute', top: '0', left: '0', width: '0', height: '0',
    pointerEvents: 'none', zIndex: '10'
  },
  // Icon-only 24 x 24 button. It is transparent and inert until the pointer
  // hovers the gray background of its code block (or it has keyboard focus).
  '.cm-code-block-copy': {
    position: 'absolute', transform: 'translateX(-100%)',
    boxSizing: 'border-box', width: `${COPY_BUTTON_SIZE}px`, height: `${COPY_BUTTON_SIZE}px`,
    padding: '0', display: 'flex', alignItems: 'center', justifyContent: 'center',
    opacity: '0', pointerEvents: 'none', transition: 'opacity 0.12s ease-in-out',
    userSelect: 'none', cursor: 'pointer', lineHeight: '0',
    borderRadius: '4px',
    border: '1px solid #9ca3af', backgroundColor: '#f8fafc', color: '#1f2937'
  },
  '.cm-code-block-copy svg': { display: 'block', pointerEvents: 'none' },
  '.cm-code-block-copy-visible, .cm-code-block-copy:focus-visible': { opacity: '1', pointerEvents: 'auto' },
  '.cm-code-block-copy:hover': { backgroundColor: '#e2e8f0' },
  '.cm-code-block-copy:focus-visible': { outline: '2px solid #2563eb', outlineOffset: '2px' },
  '.cm-code-block-copy-failed': { color: '#b91c1c', borderColor: '#b91c1c' },
  'body.dark & .cm-code-block-copy': { backgroundColor: '#27272a', color: '#f4f4f5', borderColor: '#71717a' },
  'body.dark & .cm-code-block-copy:hover': { backgroundColor: '#3f3f46' },
  'body.dark & .cm-code-block-copy-failed': { color: '#fca5a5', borderColor: '#fca5a5' },
  '@media (prefers-reduced-motion: reduce)': { '.cm-code-block-copy': { transition: 'none' } },
  '@media print': { '.cm-code-block-copy-layer': { display: 'none' } }
}

export const codeBlockCopy = [
  codeBlockCopyPlugin,
  EditorView.baseTheme(CODE_BLOCK_COPY_THEME)
]
