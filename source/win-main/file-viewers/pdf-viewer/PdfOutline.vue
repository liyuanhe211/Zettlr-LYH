<template>
  <div v-if="props.pdfDocument !== null" class="pdf-outline">
    <div v-if="outline !== null && outline.length === 0" class="pdf-outline-empty">
      No outline
    </div>
    <div
      v-else-if="outline !== null"
      class="pdf-outline-tree"
      role="tree"
      aria-label="Outline"
    >
      <div
        v-for="row in visibleRows"
        v-bind:key="row.key"
        class="pdf-outline-row"
        role="treeitem"
        v-bind:aria-level="row.depth + 1"
        v-bind:aria-expanded="row.hasChildren ? row.expanded : undefined"
        v-bind:style="{
          'padding-left': `${row.depth * TREE_INDENT_PER_LEVEL + TREE_INDENT_BASE}px`
        }"
      >
        <span
          v-if="row.hasChildren"
          class="pdf-outline-toggle"
          role="button"
          v-bind:title="row.expanded ? 'Collapse' : 'Expand'"
          v-bind:aria-label="row.expanded ? 'Collapse' : 'Expand'"
          v-on:click.stop="toggle(row.key)"
        >
          <cds-icon
            shape="angle"
            v-bind:direction="row.expanded ? 'down' : 'right'"
            role="presentation"
          ></cds-icon>
        </span>
        <span v-else class="pdf-outline-toggle" aria-hidden="true"></span>

        <!-- An entry that points to a web address is a real link: following it
        makes the main process open the address in the system browser -->
        <a
          v-if="row.externalUrl !== null"
          class="pdf-outline-title"
          v-bind:style="row.titleStyle"
          v-bind:href="row.externalUrl"
          v-bind:title="row.externalUrl"
          rel="noopener noreferrer nofollow"
          v-on:click="handleExternalLinkClick"
        >{{ row.title }}</a>
        <span
          v-else
          class="pdf-outline-title"
          v-bind:style="row.titleStyle"
          role="link"
          tabindex="0"
          v-on:click="navigate(row.node)"
          v-on:keydown.enter.prevent="navigate(row.node)"
        >{{ row.title }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        PdfOutline
 * CVM-Role:        View
 * License:         GNU GPL v3
 *
 * Description:     Shows the bookmarks (outline) of a PDF as a collapsible
 *                  tree for the pdf.js-based PDF viewer (Zettlr-LYH R59).
 *                  Initially, only the first level is expanded. Clicking an
 *                  entry makes pdf.js' PDFLinkService go to its destination;
 *                  entries that point to a web address open it in the system
 *                  browser. The component fills the width of its parent and
 *                  scrolls by itself.
 *
 * END HEADER
 */
import { computed, ref, shallowRef, toRaw, watch } from 'vue'
// Type imports only: pdf_viewer.mjs reads globalThis.pdfjsLib as soon as it is
// loaded, so only the viewer itself may import it, after pdf.mjs.
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { PDFLinkService } from 'pdfjs-dist/web/pdf_viewer.mjs'
import { TREE_INDENT_BASE, TREE_INDENT_PER_LEVEL } from '../../file-manager/util/tree-indentation'

/**
 * One outline entry as PDFDocumentProxy.getOutline() delivers it. Besides
 * the declared fields, pdf.js' worker also fills in `action` (a named action
 * such as NextPage) and `setOCGState` (switching optional content), see
 * build/pdf.worker.mjs where the outline items are assembled.
 */
interface OutlineNode {
  title: string
  bold: boolean
  italic: boolean
  dest: string|unknown[]|null
  url: string|null
  action?: string|null
  setOCGState?: object|null
  items: OutlineNode[]
}

/**
 * One visible line of the tree
 */
interface OutlineRow {
  // Indices from the top level down, joined with dots, e.g. "2.0.3"
  key: string
  node: OutlineNode
  depth: number
  title: string
  titleStyle: Record<string, string>
  hasChildren: boolean
  expanded: boolean
  externalUrl: string|null
}

// What pdf.js' own outline viewer shows for an entry without a title
const UNTITLED_ENTRY = '–'

const props = defineProps<{
  pdfDocument: PDFDocumentProxy|null
  linkService: PDFLinkService|null
}>()

// null while the outline of the current document has not been read yet
const outline = shallowRef<OutlineNode[]|null>(null)
const expandedKeys = ref<Set<string>>(new Set())

// Counts the documents whose outline has been requested, so that a slow
// answer for a previous document cannot overwrite the current one
let outlineRequestNumber = 0

function childrenOf (node: OutlineNode): OutlineNode[] {
  return Array.isArray(node.items) ? node.items : []
}

function displayTitle (node: OutlineNode): string {
  const title = typeof node.title === 'string'
    ? node.title.split('\u0000').join('').trim()
    : ''
  return title === '' ? UNTITLED_ENTRY : title
}

function titleStyleOf (node: OutlineNode): Record<string, string> {
  const style: Record<string, string> = {}
  if (node.bold) {
    style['font-weight'] = 'bold'
  }
  if (node.italic) {
    style['font-style'] = 'italic'
  }
  return style
}

function externalUrlOf (node: OutlineNode): string|null {
  return typeof node.url === 'string' && node.url !== '' ? node.url : null
}

/**
 * Reads the outline of a document and expands its first level.
 *
 * @param   {PDFDocumentProxy|null}  pdfDocument  The document, or null
 */
async function loadOutline (pdfDocument: PDFDocumentProxy|null): Promise<void> {
  outlineRequestNumber++
  const requestNumber = outlineRequestNumber
  outline.value = null
  expandedKeys.value = new Set()

  if (pdfDocument === null) {
    return
  }

  let nodes: OutlineNode[] = []
  try {
    // getOutline() resolves with null when the document has no outline. The
    // raw object is used because pdf.js keeps state in private class fields,
    // which a reactive proxy cannot reach.
    const result: OutlineNode[]|null = await toRaw(pdfDocument).getOutline()
    nodes = result ?? []
  } catch (error) {
    console.error('Could not read the outline of the PDF', error)
  }

  if (requestNumber !== outlineRequestNumber) {
    return // Another document has been set in the meantime
  }

  const firstLevelKeys = new Set<string>()
  nodes.forEach((node, index) => {
    if (childrenOf(node).length > 0) {
      firstLevelKeys.add(String(index))
    }
  })

  expandedKeys.value = firstLevelKeys
  outline.value = nodes
}

watch(() => props.pdfDocument, (pdfDocument) => {
  loadOutline(pdfDocument).catch(error => console.error('Could not read the outline of the PDF', error))
}, { immediate: true })

const visibleRows = computed<OutlineRow[]>(() => {
  const rows: OutlineRow[] = []
  if (outline.value === null) {
    return rows
  }

  const expanded = expandedKeys.value
  const appendRows = (nodes: OutlineNode[], depth: number, parentKey: string): void => {
    nodes.forEach((node, index) => {
      const key = parentKey === '' ? String(index) : `${parentKey}.${index}`
      const children = childrenOf(node)
      const isExpanded = children.length > 0 && expanded.has(key)
      rows.push({
        key,
        node,
        depth,
        title: displayTitle(node),
        titleStyle: titleStyleOf(node),
        hasChildren: children.length > 0,
        expanded: isExpanded,
        externalUrl: externalUrlOf(node)
      })

      if (isExpanded) {
        appendRows(children, depth + 1, key)
      }
    })
  }

  appendRows(outline.value, 0, '')
  return rows
})

function toggle (key: string): void {
  const expanded = new Set(expandedKeys.value)
  if (expanded.has(key)) {
    expanded.delete(key)
  } else {
    expanded.add(key)
  }
  expandedKeys.value = expanded
}

/**
 * Carries out an entry that is not a web link, in the same order of
 * precedence as pdf.js' own outline viewer: a named action, then a change of
 * optional content, then a destination.
 *
 * @param   {OutlineNode}  node  The entry clicked
 */
function navigate (node: OutlineNode): void {
  if (props.linkService === null) {
    return
  }

  const linkService = toRaw(props.linkService)
  if (typeof node.action === 'string' && node.action !== '') {
    linkService.executeNamedAction(node.action)
  } else if (node.setOCGState != null) {
    linkService.executeSetOCGState(node.setOCGState)
      .catch(error => console.error('Could not change the optional content of the PDF', error))
  } else if (node.dest != null) {
    linkService.goToDestination(node.dest)
      .catch(error => console.error('Could not go to the outline entry', error))
  }
}

/**
 * Following a web link navigates the window, which Zettlr's main process
 * prevents and turns into opening the address in the system browser
 * (attach-app-navigation-handlers.ts). The link therefore has no target:
 * opening a new window would be denied without opening anything. Only when
 * the link service has disabled external links, the click does nothing.
 */
function handleExternalLinkClick (event: MouseEvent): void {
  if (props.linkService !== null && !toRaw(props.linkService).externalLinkEnabled) {
    event.preventDefault()
  }
}
</script>

<style lang="less">
body {
  div.pdf-outline {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 4px 0;
    font-size: 13px;

    div.pdf-outline-empty {
      padding: 10px;
      color: rgb(131, 131, 131);
    }

    div.pdf-outline-row {
      display: flex;
      align-items: flex-start;
      padding-right: 6px;

      &:hover {
        background-color: var(--grey-1);
      }

      .pdf-outline-toggle {
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        width: 20px;
        height: 22px;

        &[role="button"] {
          cursor: pointer;
        }

        cds-icon {
          width: 12px;
          height: 12px;
        }
      }

      .pdf-outline-title {
        flex-grow: 1;
        min-width: 0;
        padding: 3px 5px;
        line-height: 16px;
        color: inherit;
        text-decoration: none;
        overflow-wrap: anywhere;
        cursor: pointer;
        border-radius: 3px;

        &:hover {
          text-decoration: underline;
        }

        &:focus-visible {
          outline: 2px solid var(--system-accent-color, rgb(40, 100, 255));
          outline-offset: -2px;
        }
      }
    }
  }

  &.dark div.pdf-outline {
    div.pdf-outline-empty {
      color: rgb(150, 150, 150);
    }

    div.pdf-outline-row:hover {
      background-color: var(--grey-6);
    }
  }
}
</style>
