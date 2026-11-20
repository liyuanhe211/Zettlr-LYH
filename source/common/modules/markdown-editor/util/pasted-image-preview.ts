import { StateEffect, StateField, type EditorState } from '@codemirror/state'
import { ViewPlugin, type EditorView } from '@codemirror/view'
import { configField } from './configuration'
import { selectImageEffect } from './image-selection'
import { freezeRevealSelectionEffect, pointerSelectionEndEffect } from './reveal-selection'

interface PastedImageRange { from: number, to: number }

/** Only the insertion transaction grants this preview; undo/redo use normal rules. */
export const pastedImagePreviewEffect = StateEffect.define<readonly PastedImageRange[]>({
  map: (ranges, changes) => ranges.map(range => ({
    from: changes.mapPos(range.from, 1), to: changes.mapPos(range.to, -1)
  })).filter(range => range.from < range.to)
})

export const clearPastedImagePreviewEffect = StateEffect.define<null>()

export const pastedImagePreviewField = StateField.define<readonly PastedImageRange[]>({
  create: () => [],
  update (ranges, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(pastedImagePreviewEffect)) return effect.value
    }
    // No range survives an edit (including undo), an explicit selection, or a
    // configuration change. Keeping a stale range could hide unrelated source.
    if (transaction.docChanged || transaction.selection !== undefined ||
      transaction.startState.field(configField, false) !== transaction.state.field(configField, false) ||
      transaction.effects.some(effect => effect.is(clearPastedImagePreviewEffect) ||
        effect.is(selectImageEffect) || effect.is(freezeRevealSelectionEffect) || effect.is(pointerSelectionEndEffect))) {
      return ranges.length === 0 ? ranges : []
    }
    return ranges
  }
})

export function hasPastedImagePreview (state: EditorState, from: number, to: number): boolean {
  const configuration = state.field(configField, false)
  return configuration?.renderingMode !== 'raw' && configuration?.renderImages !== false &&
    (state.field(pastedImagePreviewField, false)?.some(range => range.from <= from && range.to >= to) ?? false)
}

// Track actual view lifetime without relying on private EditorView internals or
// DOM attachment (an isolated editor can intentionally live in a detached DOM).
const liveImageViews = new WeakSet<EditorView>()
const trackedImageViews = new WeakSet<EditorView>()
export const pastedImagePreviewLifecycle = ViewPlugin.fromClass(class {
  constructor (private readonly view: EditorView) { liveImageViews.add(view) }
  destroy (): void { liveImageViews.delete(this.view) }
})

/** Keep lifetime tracking installed even when Raw mode removes image renderers. */
export function trackImagePasteView (view: EditorView): void {
  if (!trackedImageViews.has(view)) {
    view.dispatch({ effects: StateEffect.appendConfig.of(pastedImagePreviewLifecycle) })
    trackedImageViews.add(view)
  }
}

export function canCompleteImagePaste (view: EditorView): boolean {
  return liveImageViews.has(view)
}
