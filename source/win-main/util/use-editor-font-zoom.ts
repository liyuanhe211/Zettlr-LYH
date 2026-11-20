/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        useEditorFontZoom
 * CVM-Role:        Utility function
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Lets the editor panes zoom their font size with Ctrl plus
 *                  the mouse wheel. The new font size goes into the global
 *                  `editor.fontSize` configuration option, so that it is
 *                  persisted across restarts and applies to every file and
 *                  every window. The arithmetic itself lives in the dependency
 *                  free module `editor-font-zoom`.
 *
 * END HEADER
 */

import { useConfigStore } from 'source/pinia'
import {
  accumulateZoomSteps,
  nextEditorFontSize,
  normalizeWheelDelta
} from './editor-font-zoom'

/**
 * Provides a wheel handler that zooms the editor font size while the Control
 * key is held down. Each component instance keeps its own accumulated wheel
 * movement.
 *
 * @return  {{ handleZoomWheel: (event: WheelEvent) => void }}  The handler to
 *          attach to the wheel event of the editor wrapper element
 */
export function useEditorFontZoom (): { handleZoomWheel: (event: WheelEvent) => void } {
  const configStore = useConfigStore()

  // Remainder of the wheel movement that has not yet added up to a full zoom
  // step. High-resolution wheels and trackpads report only a few pixels per
  // event, so the movement has to be accumulated across events.
  let carriedDelta = 0

  function handleZoomWheel (event: WheelEvent): void {
    // Only plain Ctrl plus wheel zooms; any additional modifier belongs to
    // some other interaction, and the pane must keep scrolling as usual.
    if (!event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) {
      return
    }

    // This both keeps the pane from scrolling and keeps Chromium from applying
    // its own built-in Ctrl plus wheel page zoom.
    event.preventDefault()

    const normalizedDelta = normalizeWheelDelta(event.deltaY, event.deltaMode)
    const accumulated = accumulateZoomSteps(carriedDelta, normalizedDelta)
    carriedDelta = accumulated.carriedDelta

    if (accumulated.fontSizeDelta === 0) {
      return // Not a full zoom step yet
    }

    const currentFontSize = configStore.config.editor.fontSize
    const newFontSize = nextEditorFontSize(currentFontSize, accumulated.fontSizeDelta)
    if (newFontSize === currentFontSize) {
      return // Already at the limit; no need for a synchronous IPC round trip
    }

    configStore.setConfigValue('editor.fontSize', newFontSize)
  }

  return { handleZoomWheel }
}
