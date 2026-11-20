<template>
  <div class="toolbar-group">
    <button
      v-bind:id="`toolbar-${props.control.id ?? ''}`"
      ref="buttonElement"
      type="button"
      v-bind:class="[ 'toolbar-text-button', 'toolbar-drag-adjust', props.control.class, { dragging: dragging } ]"
      v-bind:title="props.control.title"
      v-bind:disabled="props.control.disabled === true"
      v-bind:aria-disabled="props.control.disabled === true"
      v-on:mousedown="startDrag"
    >
      {{ labelText }}
    </button>
    <!-- While the pointer is locked, Chromium hides the cursor; this arrow
         stands in for it where the drag started -->
    <Teleport to="body">
      <div
        v-if="cursorAnchor !== null"
        class="toolbar-drag-adjust-cursor"
        v-bind:style="{ left: `${cursorAnchor.x}px`, top: `${cursorAnchor.y}px` }"
        aria-hidden="true"
      >
        <svg width="24" height="12" viewBox="0 0 24 12">
          <path
            d="M1 6 L6 1 L6 4 L18 4 L18 1 L23 6 L18 11 L18 8 L6 8 L6 11 Z"
            fill="#000000"
            stroke="#ffffff"
            stroke-width="1"
            stroke-linejoin="round"
          ></path>
        </svg>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        DragAdjustControl
 * CVM-Role:        View
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH (R81): a toolbar control that adjusts a number by
 *                  dragging sideways instead of clicking. Pressing the primary
 *                  mouse button locks the pointer, and every horizontal mouse
 *                  movement changes the value by the same number of pixels,
 *                  within zero and an upper limit that the owner of the
 *                  control computes when the drag starts. While dragging, the
 *                  label shows the value, and an arrow stands in for the hidden
 *                  cursor. Releasing the button finishes the drag; losing the
 *                  lock before that cancels it. If the pointer cannot be
 *                  locked, the drag goes on with the regular cursor. The
 *                  control reports every change as a drag update and never
 *                  emits a click.
 *
 * END HEADER
 */

import { computed, onBeforeUnmount, ref } from 'vue'
import {
  initialMarginDragState,
  reduceMarginDrag,
  type MarginDragAction,
  type MarginDragEvent
} from '../../../../win-main/util/editor-margin'

/**
 * A change during a drag: show a value without storing it ('preview'), store
 * the final value ('commit'), or show the stored value again because the drag
 * was cancelled or ended without a change ('restore').
 */
export interface ToolbarDragUpdate {
  id?: string
  kind: 'preview'|'commit'|'restore'
  value: number
}

export interface ToolbarDragAdjustControl {
  type: 'drag-adjust'
  id?: string
  /**
   * The label of the control, e.g. Margin. While dragging, the control shows
   * `<label>: <value> px` instead.
   */
  label: string
  title?: string
  /**
   * Optional CSS class(es) put verbatim on the button element
   */
  class?: string
  /**
   * The stored value; a drag starts from it
   */
  value: number
  /**
   * Computes the upper limit of the value when a drag starts
   */
  maximum: () => number
  /**
   * Receives every drag update, in addition to the toolbar's drag event
   */
  onDrag?: (update: ToolbarDragUpdate) => void
  /**
   * When true, the control is greyed out and does not react to the mouse
   */
  disabled?: boolean
  /**
   * When false, the toolbar does not render the control
   */
  visible?: boolean
  // Allow arbitrary properties that we ignore
  [key: string]: unknown
}

const props = defineProps<{ control: ToolbarDragAdjustControl }>()

const emit = defineEmits<(e: 'drag', update: ToolbarDragUpdate) => void>()

const buttonElement = ref<HTMLButtonElement|null>(null)
const dragging = ref(false)
const dragValue = ref(0)
const cursorAnchor = ref<{ x: number, y: number }|null>(null)

let dragState = initialMarginDragState()
// Whether the pointer lock of the current drag has actually been granted
let lockGranted = false
// Where the drag started, for the stand-in cursor
let pressPoint = { x: 0, y: 0 }
// Counts the drags, so that a late answer to an old lock request is ignored
let dragSerial = 0

const labelText = computed<string>(() => {
  return dragging.value ? `${props.control.label}: ${dragValue.value} px` : props.control.label
})

/**
 * Applies an event to the drag and carries out the resulting action
 *
 * @param   {MarginDragEvent}  event  The event
 */
function dispatch (event: MarginDragEvent): void {
  const wasActive = dragState.phase !== 'idle'
  const { state, action } = reduceMarginDrag(dragState, event)
  dragState = state
  carryOut(action)
  if (wasActive && state.phase === 'idle') {
    finishDrag()
  }
}

/**
 * Reports an action of the drag to the owner of the control
 *
 * @param   {MarginDragAction}  action  The action
 */
function carryOut (action: MarginDragAction): void {
  if (action.type === 'none') {
    return
  }

  dragValue.value = action.value
  let kind: ToolbarDragUpdate['kind'] = 'preview'
  if (action.type === 'write') {
    kind = 'commit'
  } else if (action.type === 'restore') {
    kind = 'restore'
  }
  emit('drag', { id: props.control.id, kind, value: action.value })
}

/**
 * Starts a drag on a press of the primary mouse button
 *
 * @param   {MouseEvent}  event  The mousedown event
 */
function startDrag (event: MouseEvent): void {
  const element = buttonElement.value
  if (event.button !== 0 || props.control.disabled === true || dragState.phase !== 'idle' || element === null) {
    return
  }

  event.preventDefault()
  lockGranted = false
  pressPoint = { x: event.clientX, y: event.clientY }
  dragging.value = true

  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)
  document.addEventListener('pointerlockchange', onPointerLockChange)
  document.addEventListener('pointerlockerror', onPointerLockError)
  window.addEventListener('blur', onWindowBlur)

  dispatch({ type: 'start', startValue: props.control.value, max: props.control.maximum() })

  // A late answer to the request of an earlier drag must not affect this one
  const serial = ++dragSerial
  try {
    // Newer versions of Chromium return a promise that rejects on failure,
    // older ones only fire pointerlockerror; both end up in the same place.
    const request = element.requestPointerLock() as unknown
    if (request instanceof Promise) {
      request.catch(() => {
        if (serial === dragSerial) {
          onPointerLockError()
        }
      })
    }
  } catch {
    onPointerLockError()
  }
}

function onMouseMove (event: MouseEvent): void {
  dispatch({ type: 'move', movementX: event.movementX })
}

function onMouseUp (event: MouseEvent): void {
  if (event.button !== 0) {
    return
  }
  dispatch({ type: 'end' })
}

function onPointerLockChange (): void {
  if (document.pointerLockElement === buttonElement.value && buttonElement.value !== null) {
    lockGranted = true
    cursorAnchor.value = { ...pressPoint }
  } else if (lockGranted) {
    // The lock is gone before the button was released (Escape, focus loss, or
    // the system took it back): cancel
    lockGranted = false
    dispatch({ type: 'lock-lost' })
  }
}

function onPointerLockError (): void {
  dispatch({ type: 'lock-error' })
}

function onWindowBlur (): void {
  // In a plain drag, the window losing the focus cancels the drag; with the
  // pointer locked, the lock goes away as well, which cancels it anyway
  dispatch({ type: 'lock-lost' })
}

/**
 * Removes the listeners of a drag, releases the pointer lock and resets the
 * display
 */
function finishDrag (): void {
  document.removeEventListener('mousemove', onMouseMove)
  document.removeEventListener('mouseup', onMouseUp)
  document.removeEventListener('pointerlockchange', onPointerLockChange)
  document.removeEventListener('pointerlockerror', onPointerLockError)
  window.removeEventListener('blur', onWindowBlur)

  lockGranted = false
  if (buttonElement.value !== null && document.pointerLockElement === buttonElement.value) {
    document.exitPointerLock()
  }

  dragging.value = false
  cursorAnchor.value = null
}

onBeforeUnmount(() => {
  if (dragState.phase !== 'idle') {
    dispatch({ type: 'lock-lost' })
  }
  finishDrag()
})
</script>

<style lang="less">
body div#toolbar button.toolbar-drag-adjust {
  cursor: ew-resize;

  &:disabled {
    cursor: default;
    opacity: 0.5;
  }
}

.toolbar-drag-adjust-cursor {
  position: fixed;
  z-index: 100000;
  width: 24px;
  height: 12px;
  margin-left: -12px;
  margin-top: -6px;
  pointer-events: none;
}
</style>
