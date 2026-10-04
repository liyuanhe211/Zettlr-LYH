/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Raw HTML renderer
 * CVM-Role:        View
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     This renderer displays whitelisted raw HTML, both inline
 *                  (`<span style="color:red">text</span>`, `<sup>1</sup>`)
 *                  and as whole HTML blocks (`<div align="right"><small>
 *                  text</small></div>`), plus character entities such as
 *                  `&nbsp;`. When the selection is not inside an element, its
 *                  tags are hidden: inline elements wrap the enclosed text in
 *                  an element of the same name with the (whitelisted)
 *                  attributes, block elements apply their alignment and style
 *                  to their lines, and entities show the character they
 *                  stand for. The text itself stays editable text. Inside
 *                  paragraphs, it also renders links (`<a href="...">`, opened
 *                  with Ctrl-click, Cmd-click on macOS), line breaks (`<br>`)
 *                  and images (`<img src="...">`).
 *
 * END HEADER
 */

import { syntaxTree } from '@codemirror/language'
import type { EditorState, Range, RangeSet } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate, WidgetType } from '@codemirror/view'
import { rangeInSelection } from '../util/range-in-selection'
import { configField } from '../util/configuration'
import {
  parseHtmlTag,
  parseVoidHtmlTag,
  pairHtmlTags,
  scanHtmlBlock,
  blockLineAttributes,
  decodeCharacterReferences,
  normalizeLinkHref,
  LINK_ELEMENT,
  type HtmlTagOccurrence,
  type VoidHtmlTag
} from '../util/html-span-tags'
import clickAndSelect from './click-and-select'
import { isLinkModifierPressed, openHtmlLink, resolveHtmlImageSource } from './render-html-block'

const hiddenDeco = Decoration.replace({})

/**
 * Shows the character a character entity stands for.
 */
class EntityWidget extends WidgetType {
  constructor (readonly character: string) {
    super()
  }

  eq (other: EntityWidget): boolean {
    return other.character === this.character
  }

  toDOM (_view: EditorView): HTMLElement {
    const element = document.createElement('span')
    element.className = 'cm-html-entity'
    element.textContent = this.character
    return element
  }

  ignoreEvent (): boolean {
    return false
  }
}

/**
 * Shows a `<br>` tag as an actual line break.
 */
class LineBreakWidget extends WidgetType {
  eq (_other: LineBreakWidget): boolean {
    return true
  }

  toDOM (_view: EditorView): HTMLElement {
    const element = document.createElement('span')
    element.className = 'cm-html-line-break'
    element.appendChild(document.createElement('br'))
    return element
  }

  ignoreEvent (): boolean {
    return false
  }
}

const lineBreakDeco = Decoration.replace({ widget: new LineBreakWidget() })

/**
 * Shows an `<img>` tag as the image. A click moves the cursor into the tag's
 * source, a Ctrl-click (Cmd-click on macOS) inside a rendered link opens it.
 */
class InlineImageWidget extends WidgetType {
  constructor (readonly source: string, readonly attributes: Record<string, string>) {
    super()
  }

  eq (other: InlineImageWidget): boolean {
    return other.source === this.source && JSON.stringify(other.attributes) === JSON.stringify(this.attributes)
  }

  toDOM (view: EditorView): HTMLElement {
    const image = document.createElement('img')
    image.className = 'cm-html-inline-image'
    image.draggable = false

    const { alt, title, width, height, style } = this.attributes
    if (alt !== undefined) {
      image.alt = alt
    }
    if (title !== undefined) {
      image.title = title
    }
    // The width and height attributes of HTML are numbers of pixels or
    // percentages; anything else is ignored.
    if (width !== undefined && /^\d+(?:\.\d+)?%?$/.test(width.trim())) {
      image.setAttribute('width', width.trim())
    }
    if (height !== undefined && /^\d+(?:\.\d+)?%?$/.test(height.trim())) {
      image.setAttribute('height', height.trim())
    }
    if (style !== undefined) {
      image.setAttribute('style', style)
    }

    image.addEventListener('click', event => {
      const link = image.closest('.cm-html-link')
      if (link instanceof HTMLElement && link.dataset.href !== undefined && isLinkModifierPressed(event)) {
        event.preventDefault()
        event.stopPropagation()
        openHtmlLink(link.dataset.href, view)
        return
      }
      clickAndSelect(view)(event)
    })

    image.src = this.source
    return image
  }

  ignoreEvent (_event: Event): boolean {
    return true // The click listener handles everything
  }
}

const entityDecoder = document.createElement('textarea')

/**
 * Decodes a single character entity. Returns undefined for unknown names,
 * which the browser leaves as they are.
 *
 * @param   {string}            entity  The entity, e.g. `&nbsp;`
 *
 * @return  {string|undefined}          The character(s) it stands for
 */
function decodeEntity (entity: string): string|undefined {
  // Safe: callers only pass text matching HTML_ENTITY_PATTERN / Entity nodes
  entityDecoder.innerHTML = entity
  const decoded = entityDecoder.value
  return decoded !== entity ? decoded : undefined
}

/**
 * Creates the mark decoration for a link's text. The link target is stored
 * in `data-href` instead of `href`, so that the browser can never navigate by
 * itself. Returns undefined for a link whose target uses a protocol other
 * than http, https, file or mailto; such a link stays visible as source.
 *
 * @param   {Record<string, string>}  attributes  The link's attributes
 *
 * @return  {Decoration|undefined}                The mark decoration
 */
function linkMark (attributes: Record<string, string>): Decoration|undefined {
  const { href, ...otherAttributes } = attributes
  if (href === undefined) {
    // An anchor without a target, e.g. `<a id="section">`
    return Decoration.mark({ tagName: LINK_ELEMENT, attributes: otherAttributes })
  }

  const target = normalizeLinkHref(decodeCharacterReferences(href))
  if (target === undefined) {
    return undefined
  }

  const className = [ 'cm-html-link', otherAttributes.class ?? '' ].join(' ').trim()
  return Decoration.mark({
    tagName: LINK_ELEMENT,
    attributes: { ...otherAttributes, class: className, 'data-href': target }
  })
}

function createHtmlDecorations (view: EditorView): RangeSet<Decoration> {
  const state = view.state
  const includeAdjacent = state.field(configField, false)?.previewModeShowSyntaxWhenCursorIsAdjacent ?? true
  const documentPath = state.field(configField, false)?.metadata.path ?? ''
  const occurrences: HtmlTagOccurrence[] = []
  const voidTags: Array<{ from: number, to: number, tag: VoidHtmlTag }> = []
  const entities: Array<{ from: number, to: number }> = []

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from, to,
      enter: (node) => {
        if (node.name === 'HTMLTag') {
          const tagText = state.sliceDoc(node.from, node.to)
          const tag = parseHtmlTag(tagText, { allowLinks: true })
          if (tag !== undefined) {
            occurrences.push({
              from: node.from,
              to: node.to,
              tag,
              // Pair tags only within the same enclosing block (e.g. paragraph)
              blockId: node.node.parent?.from ?? -1
            })
          } else {
            const voidTag = parseVoidHtmlTag(tagText)
            if (voidTag !== undefined) {
              voidTags.push({ from: node.from, to: node.to, tag: voidTag })
            }
          }
          return false // Do not descend into the nested HTML parse
        } else if (node.name === 'Entity') {
          entities.push({ from: node.from, to: node.to })
          return false
        } else if (node.name === 'HTMLBlock') {
          const scan = scanHtmlBlock(state.sliceDoc(node.from, node.to))
          if (scan !== undefined) {
            for (const tag of scan.tags) {
              occurrences.push({ from: node.from + tag.from, to: node.from + tag.to, tag: tag.tag, blockId: node.from })
            }
            for (const entity of scan.entities) {
              entities.push({ from: node.from + entity.from, to: node.from + entity.to })
            }
          }
          return false
        }
      }
    })
  }

  const ranges: Array<Range<Decoration>> = []

  for (const { open, close } of pairHtmlTags(occurrences)) {
    // Show the raw syntax while the selection touches the element
    if (rangeInSelection(state.selection, open.from, close.to, includeAdjacent)) {
      continue
    }

    // A view plugin may not replace line breaks, so a tag whose attributes
    // span several lines stays visible, together with its partner.
    if (state.sliceDoc(open.from, open.to).includes('\n') || state.sliceDoc(close.from, close.to).includes('\n')) {
      continue
    }

    let contentMark: Decoration|undefined
    if (open.tag.name === LINK_ELEMENT) {
      contentMark = linkMark(open.tag.attributes)
      if (contentMark === undefined) {
        continue // A link with a disallowed target stays visible as source
      }
    } else if (open.tag.element === 'inline') {
      contentMark = Decoration.mark({ tagName: open.tag.name, attributes: open.tag.attributes })
    }

    ranges.push(hiddenDeco.range(open.from, open.to))
    ranges.push(hiddenDeco.range(close.from, close.to))

    if (contentMark !== undefined) {
      if (open.to < close.from) {
        ranges.push(contentMark.range(open.to, close.from))
      }
    } else {
      addBlockLineDecorations(state, open.to, close.from, blockLineAttributes(open.tag), ranges)
    }
  }

  for (const { from, to, tag } of voidTags) {
    if (rangeInSelection(state.selection, from, to, includeAdjacent)) {
      continue
    }
    if (state.sliceDoc(from, to).includes('\n')) {
      continue // A view plugin may not replace line breaks
    }

    if (tag.name === 'br') {
      ranges.push(lineBreakDeco.range(from, to))
    } else {
      const decodedAttributes: Record<string, string> = {}
      for (const [ name, value ] of Object.entries(tag.attributes)) {
        decodedAttributes[name] = decodeCharacterReferences(value)
      }
      const source = resolveHtmlImageSource(decodedAttributes.src, documentPath)
      if (source === '') {
        continue
      }
      ranges.push(Decoration.replace({ widget: new InlineImageWidget(source, decodedAttributes) }).range(from, to))
    }
  }

  for (const { from, to } of entities) {
    if (rangeInSelection(state.selection, from, to, includeAdjacent)) {
      continue
    }
    const character = decodeEntity(state.sliceDoc(from, to))
    if (character !== undefined) {
      ranges.push(Decoration.replace({ widget: new EntityWidget(character) }).range(from, to))
    }
  }

  return Decoration.set(ranges, true)
}

/**
 * Applies a block element's attributes to every line its content touches.
 */
function addBlockLineDecorations (
  state: EditorState, from: number, to: number,
  attributes: Record<string, string>, ranges: Array<Range<Decoration>>
): void {
  if (Object.keys(attributes).length === 0) {
    return
  }
  const lineDeco = Decoration.line({ attributes })
  const lastLine = state.doc.lineAt(to).number
  for (let lineNumber = state.doc.lineAt(from).number; lineNumber <= lastLine; lineNumber++) {
    ranges.push(lineDeco.range(state.doc.line(lineNumber).from))
  }
}

const htmlSpanPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet

  constructor (view: EditorView) {
    this.decorations = createHtmlDecorations(view)
  }

  update (update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged || update.selectionSet) {
      this.decorations = createHtmlDecorations(update.view)
    }
  }
}, {
  decorations: v => v.decorations,
  eventHandlers: {
    // Ctrl-click (Cmd-click on macOS) on a rendered link opens it. A plain
    // click is not intercepted, so the cursor lands in the text as usual and
    // the link's source is revealed.
    mousedown (event: MouseEvent, view: EditorView) {
      if (!isLinkModifierPressed(event) || !(event.target instanceof Element)) {
        return false
      }
      const link = event.target.closest('.cm-html-link')
      if (!(link instanceof HTMLElement) || !view.contentDOM.contains(link) || link.dataset.href === undefined) {
        return false
      }
      event.preventDefault()
      openHtmlLink(link.dataset.href, view)
      return true
    }
  }
})

export const renderHtmlSpans = [
  htmlSpanPlugin,
  EditorView.baseTheme({
    '.cm-html-link': {
      color: 'var(--zettlr-editor-primary-color)',
      textDecoration: 'underline'
    },
    '.cm-html-inline-image': {
      maxWidth: '100%',
      verticalAlign: 'bottom',
      cursor: 'default'
    },
    // Keep the aspect ratio when a width is given and the image is shrunk
    '.cm-html-inline-image[width]': {
      height: 'auto'
    }
  })
]
