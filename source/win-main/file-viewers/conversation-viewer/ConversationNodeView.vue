<template>
  <div
    v-if="inline"
    class="conversation-node conversation-segment"
    v-bind:class="nodeClasses"
    v-bind:data-node-id="node.id"
  >
    <div v-if="isMarkerSegment" class="conversation-omission" v-bind:title="tooltip">
      <span class="conversation-omission-label">{{ node.label }}</span>
      <span v-if="node.text !== ''" class="conversation-omission-text">{{ node.text }}</span>
    </div>
    <template v-else>
      <!-- eslint-disable-next-line vue/no-v-html NOTE html comes from renderConversationMarkdown, which runs DOMPurify and a second cleaning pass -->
      <div v-html="html"
        v-if="html !== undefined"
        class="conversation-markdown"
      ></div>
      <div
        v-else-if="node.text !== ''"
        class="conversation-plain-text"
        v-bind:class="{ 'conversation-code': node.kind === 'output' || node.kind === 'error' }"
      >{{ node.text }}</div>
    </template>
    <ConversationNodeView
      v-for="child in node.children"
      v-bind:key="child.id"
      v-bind:node="child"
      v-bind:inline="true"
    ></ConversationNodeView>
  </div>

  <div
    v-else-if="variant === 'user'"
    class="conversation-node conversation-user-row"
    v-bind:class="nodeClasses"
    v-bind:data-node-id="node.id"
  >
    <div class="conversation-user-bubble">
      <div v-if="captionVisible || node.isSidechain === true" class="conversation-caption">
        <span v-if="node.isSidechain === true" class="conversation-badge conversation-sidechain-badge">Subagent</span>
        <span v-if="captionVisible" class="conversation-caption-label" v-bind:title="tooltip">{{ node.label }}</span>
        <span v-if="attributeLine !== ''" class="conversation-attribute-line">{{ attributeLine }}</span>
      </div>
      <!-- eslint-disable-next-line vue/no-v-html NOTE html comes from renderConversationMarkdown, which runs DOMPurify and a second cleaning pass -->
      <div v-html="html"
        v-if="html !== undefined"
        class="conversation-markdown"
      ></div>
      <div v-else-if="node.text !== ''" class="conversation-plain-text">{{ node.text }}</div>
      <ConversationNodeView
        v-for="child in node.children"
        v-bind:key="child.id"
        v-bind:node="child"
        v-bind:inline="true"
      ></ConversationNodeView>
    </div>
  </div>

  <div
    v-else-if="variant === 'assistant' || variant === 'summary'"
    class="conversation-node"
    v-bind:class="[ ...nodeClasses, variant === 'summary' ? 'conversation-summary' : 'conversation-assistant' ]"
    v-bind:data-node-id="node.id"
  >
    <div
      v-if="variant === 'summary' || captionVisible || node.isSidechain === true || attributeLine !== ''"
      class="conversation-caption"
    >
      <span v-if="node.isSidechain === true" class="conversation-badge conversation-sidechain-badge">Subagent</span>
      <span
        v-if="variant === 'summary'"
        class="conversation-badge conversation-summary-badge"
        v-bind:title="tooltip"
      >{{ node.label }}</span>
      <span
        v-else-if="captionVisible"
        class="conversation-caption-label"
        v-bind:title="tooltip"
      >{{ node.label }}</span>
      <span v-if="attributeLine !== ''" class="conversation-attribute-line">{{ attributeLine }}</span>
    </div>
    <!-- eslint-disable-next-line vue/no-v-html NOTE html comes from renderConversationMarkdown, which runs DOMPurify and a second cleaning pass -->
    <div v-html="html"
      v-if="html !== undefined"
      class="conversation-markdown"
    ></div>
    <div v-else-if="node.text !== ''" class="conversation-plain-text">{{ node.text }}</div>
    <ConversationNodeView
      v-for="child in node.children"
      v-bind:key="child.id"
      v-bind:node="child"
      v-bind:inline="true"
    ></ConversationNodeView>
  </div>

  <div
    v-else-if="variant === 'omission'"
    class="conversation-node"
    v-bind:class="nodeClasses"
    v-bind:data-node-id="node.id"
  >
    <div class="conversation-omission" v-bind:title="tooltip">
      <span v-if="node.isSidechain === true" class="conversation-badge conversation-sidechain-badge">Subagent</span>
      <span class="conversation-omission-label">{{ node.label }}</span>
      <span v-if="node.text !== ''" class="conversation-omission-text">{{ node.text }}</span>
    </div>
  </div>

  <div
    v-else-if="variant === 'collapsible'"
    class="conversation-node conversation-block"
    v-bind:class="nodeClasses"
    v-bind:data-node-id="node.id"
  >
    <button
      type="button"
      class="conversation-toggle conversation-node-header"
      v-bind:aria-expanded="expanded ? 'true' : 'false'"
      v-bind:aria-label="`${expanded ? 'Collapse' : 'Expand'} ${node.label}`"
      v-bind:title="tooltip"
      v-on:click="toggle"
    >
      <span class="conversation-chevron" aria-hidden="true"></span>
      <span class="conversation-node-label">{{ node.label }}</span>
      <span v-if="node.repeat !== undefined" class="conversation-repeat">×{{ node.repeat }}</span>
      <span
        v-for="badge in badges"
        v-bind:key="badge.text"
        class="conversation-badge"
        v-bind:class="badge.className"
      >{{ badge.text }}</span>
      <span v-if="node.isSidechain === true" class="conversation-badge conversation-sidechain-badge">Subagent</span>
      <span v-if="lineLabelVisible" class="conversation-line-label">{{ linesLabel }}</span>
      <span v-if="!expanded && preview !== ''" class="conversation-preview">{{ preview }}</span>
    </button>
    <div v-if="expanded" class="conversation-node-body">
      <template v-if="node.toolInput !== undefined && node.toolInput !== ''">
        <div class="conversation-section-caption">Input</div>
        <div class="conversation-plain-text conversation-code"><template
          v-for="(part, index) in inputParts"
          v-bind:key="index"
        ><span
          v-if="part.omitted"
          class="conversation-omit-marker"
          title="Parameters omitted in this transcript"
        >{{ part.text }}</span><template v-else>{{ part.text }}</template></template></div>
      </template>
      <template v-if="node.text !== ''">
        <!-- eslint-disable-next-line vue/no-v-html NOTE html comes from renderConversationMarkdown, which runs DOMPurify and a second cleaning pass -->
        <div v-html="html"
          v-if="html !== undefined"
          class="conversation-markdown"
        ></div>
        <div
          v-else
          class="conversation-plain-text"
          v-bind:class="{ 'conversation-code': node.kind !== 'thinking' }"
        >{{ node.text }}</div>
      </template>
      <template v-if="rawVisible">
        <div class="conversation-section-caption">Raw source</div>
        <div class="conversation-plain-text conversation-code">{{ node.raw }}</div>
      </template>
      <dl v-if="attributes.length > 0" class="conversation-attributes">
        <template v-for="[name, value] in attributes" v-bind:key="name">
          <dt>{{ name }}</dt>
          <dd>{{ value }}</dd>
        </template>
      </dl>
      <ConversationNodeView
        v-for="child in node.children"
        v-bind:key="child.id"
        v-bind:node="child"
        v-bind:inline="segmentChildren"
      ></ConversationNodeView>
    </div>
  </div>

  <div
    v-else
    class="conversation-node conversation-block"
    v-bind:class="nodeClasses"
    v-bind:data-node-id="node.id"
  >
    <div class="conversation-node-header conversation-static-header" v-bind:title="tooltip">
      <span class="conversation-node-label">{{ node.label }}</span>
      <span v-if="node.repeat !== undefined" class="conversation-repeat">×{{ node.repeat }}</span>
      <span
        v-for="badge in badges"
        v-bind:key="badge.text"
        class="conversation-badge"
        v-bind:class="badge.className"
      >{{ badge.text }}</span>
      <span v-if="node.isSidechain === true" class="conversation-badge conversation-sidechain-badge">Subagent</span>
      <span v-if="lineLabelVisible" class="conversation-line-label">{{ linesLabel }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ConversationNodeView
 * CVM-Role:        View
 * License:         GNU GPL v3
 *
 * Description:     Renders one node of a conversation history and, through
 *                  itself, its children (Zettlr-LYH R79, contract C8 section
 *                  7). User messages are bubbles, assistant text and findings
 *                  are open text, omissions are marks, and every other kind
 *                  is a light summary row that expands. Only user, assistant
 *                  and summary text goes through v-html, and only as the
 *                  cleaned HTML the viewer provides; everything else is text
 *                  interpolation. Expansion and highlight state come from
 *                  ConversationViewer.vue through provide and inject.
 *
 * END HEADER
 */
import { computed, inject } from 'vue'
import type { ConversationNode } from '@dts/common/conversation-history'
import { CONVERSATION_VIEWER_CONTEXT } from './viewer-context'
import {
  childrenAreSegments,
  isCollapsible,
  isMarkdownKind,
  nodeTooltip,
  outputBadges,
  previewText,
  showsRaw,
  sourceLinesLabel,
  splitOmitMarkers,
  toolBadges,
  visibleAttributes,
  type NodeBadge
} from './node-display'

type NodeVariant = 'user'|'assistant'|'summary'|'omission'|'collapsible'|'static'

const props = withDefaults(defineProps<{
  node: ConversationNode
  inline?: boolean
}>(), { inline: false })

const context = inject(CONVERSATION_VIEWER_CONTEXT)
if (context === undefined) {
  throw new Error('ConversationNodeView must be used inside ConversationViewer')
}
const viewer = context

/**
 * Captions that need not be repeated above the text of their kind.
 */
const DEFAULT_CAPTIONS = new Set<string>([ 'User', 'Assistant', 'Kept text' ])

const variant = computed<NodeVariant>(() => {
  const node = props.node
  if (isCollapsible(node)) {
    return 'collapsible'
  }

  switch (node.kind) {
    case 'user':
      return 'user'
    case 'assistant':
      return 'assistant'
    case 'summary':
      return 'summary'
    case 'omission':
      return 'omission'
    default:
      return 'static'
  }
})

// Inline children that are not text of their parent are shown as marks
const isMarkerSegment = computed<boolean>(() => {
  const kind = props.node.kind
  return kind === 'omission' || kind === 'metadata' || kind === 'unknown' || kind === 'parse-error' || kind === 'tool'
})

const nodeClasses = computed<string[]>(() => {
  const node = props.node
  const classes = [
    `conversation-kind-${node.kind}`,
    `conversation-provenance-${node.provenance}`
  ]

  if (node.kind === 'thinking') {
    classes.push('conversation-thinking')
  }

  if (node.kind === 'tool') {
    classes.push('conversation-tool')
    if (node.toolStatus === 'error') {
      classes.push('conversation-tool-failed')
    }
  }

  if (node.isSidechain === true) {
    classes.push('conversation-sidechain')
  }

  classes.push(...viewer.highlightClasses(node.id))
  return classes
})

const expanded = computed<boolean>(() => viewer.isExpanded(props.node.id, props.node.initiallyCollapsed))

const html = computed<string|undefined>(() => {
  return isMarkdownKind(props.node.kind) ? viewer.renderedHtml(props.node) : undefined
})

const captionVisible = computed<boolean>(() => !DEFAULT_CAPTIONS.has(props.node.label))

const tooltip = computed<string>(() => nodeTooltip(props.node))

const linesLabel = computed<string>(() => sourceLinesLabel(props.node))

// Unknown and malformed data shows its original line number (R79)
const lineLabelVisible = computed<boolean>(() => {
  const kind = props.node.kind
  return linesLabel.value !== '' && (kind === 'unknown' || kind === 'parse-error' || kind === 'metadata')
})

const badges = computed<NodeBadge[]>(() => {
  const node = props.node
  if (node.kind === 'tool') {
    return toolBadges(node)
  }
  if (node.kind === 'output' || node.kind === 'error') {
    return outputBadges(node)
  }
  if (node.provenance === 'partial') {
    return [{ text: 'Partial', className: 'conversation-badge-partial' }]
  }
  return []
})

const preview = computed<string>(() => {
  const node = props.node
  if (node.kind === 'tool') {
    return previewText(node.toolInput)
  }
  if (node.kind === 'thinking' || node.kind === 'output' || node.kind === 'error') {
    return previewText(node.text)
  }
  return ''
})

const attributes = computed<Array<[string, string]>>(() => visibleAttributes(props.node))

const attributeLine = computed<string>(() => {
  return attributes.value.map(([ name, value ]) => `${name} ${value}`).join(' · ')
})

const rawVisible = computed<boolean>(() => showsRaw(props.node))

const inputParts = computed(() => splitOmitMarkers(props.node.toolInput ?? ''))

const segmentChildren = computed<boolean>(() => childrenAreSegments(props.node))

function toggle (): void {
  viewer.setExpanded(props.node.id, !expanded.value)
}
</script>
