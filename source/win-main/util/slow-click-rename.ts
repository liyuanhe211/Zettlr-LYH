/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Slow click rename decision
 * CVM-Role:        Utility functions
 * License:         GNU GPL v3
 *
 * Description:     Decides when a click on an item that is already selected
 *                  turns into a rename, the way the Windows Explorer's "slow
 *                  double click" does: the left button is pressed on the
 *                  selected item without modifier keys while the window already
 *                  has the focus, released on the same item without moving the
 *                  pointer further than the drag tolerance, and no second press
 *                  follows within the double click time. The tab bar
 *                  (DocumentTabs.vue) and the file rows of the file manager
 *                  (HistoryTreeItem.vue, TreeItem.vue, FileItem.vue) feed their
 *                  pointer events into one object per item or tab bar (R101).
 *                  The module depends neither on Vue nor on the DOM; the clock
 *                  and the timer can be injected, so that it can be tested with
 *                  a fake clock.
 *
 * END HEADER
 */

/**
 * How long, in milliseconds, the second click must stay away after the release
 * before the rename starts. Windows' default double click time; the renderer
 * cannot read the system setting, so the value is fixed.
 */
export const SLOW_CLICK_RENAME_DELAY = 500

/**
 * How far, in pixels along either axis, the pointer may move between press and
 * release before the click counts as the beginning of a drag.
 */
export const SLOW_CLICK_MOVE_TOLERANCE = 4

/**
 * What the item knows at the moment the mouse button goes down.
 */
export interface SlowClickPointerDown {
  // MouseEvent.button: 0 is the left button
  button: number
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
  x: number
  y: number
  // Whether the item was already selected before this press selected it
  wasSelected: boolean
  // Whether the window already had the focus before this press
  windowFocused: boolean
}

export interface SlowClickRenameOptions {
  // Called once when a slow click has been recognised
  onRename: () => void
  // Called with true when the object starts following a press and with false
  // once it is idle again, so that the caller only listens to window wide
  // events while they matter
  onActiveChange?: (active: boolean) => void
  now?: () => number
  setTimer?: (callback: () => void, delay: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface SlowClickRename {
  pointerDown: (info: SlowClickPointerDown) => void
  pointerMove: (x: number, y: number) => void
  pointerUp: (x: number, y: number, inside: boolean) => void
  cancel: () => void
}

/**
 * Creates the object that follows the presses on one item (or one tab bar) and
 * calls `onRename` once a press and release qualify as a slow click and the
 * double click time has passed without another press.
 *
 * @param   {SlowClickRenameOptions}  options  The callbacks and the clock
 *
 * @return  {SlowClickRename}                  The object to feed events into
 */
export function createSlowClickRename (options: SlowClickRenameOptions): SlowClickRename {
  const now = options.now ?? (() => Date.now())
  const setTimer = options.setTimer ?? ((callback: () => void, delay: number) => setTimeout(callback, delay))
  const clearTimer = options.clearTimer ?? ((handle: unknown) => { clearTimeout(handle as ReturnType<typeof setTimeout>) })

  // idle: nothing to follow; pressed: a qualifying press waits for its release;
  // waiting: the release happened and the double click time is running
  let phase: 'idle'|'pressed'|'waiting' = 'idle'
  let pressX = 0
  let pressY = 0
  let timer: unknown = undefined
  // The latest left press and the latest qualifying release; a press closer
  // than the double click time to either of them is part of a double click
  let lastPressTime = Number.NEGATIVE_INFINITY
  let lastReleaseTime = Number.NEGATIVE_INFINITY

  function setPhase (next: 'idle'|'pressed'|'waiting'): void {
    const wasActive = phase !== 'idle'
    phase = next
    const isActive = phase !== 'idle'
    if (wasActive !== isActive) {
      options.onActiveChange?.(isActive)
    }
  }

  function stopTimer (): void {
    if (timer !== undefined) {
      clearTimer(timer)
      timer = undefined
    }
  }

  function cancel (): void {
    stopTimer()
    setPhase('idle')
  }

  function movedTooFar (x: number, y: number): boolean {
    return Math.abs(x - pressX) > SLOW_CLICK_MOVE_TOLERANCE || Math.abs(y - pressY) > SLOW_CLICK_MOVE_TOLERANCE
  }

  function pointerDown (info: SlowClickPointerDown): void {
    // Any press ends a running wait; a second press is a double click
    const interruptsWait = phase === 'waiting'
    cancel()

    if (info.button !== 0) {
      return
    }

    const time = now()
    const partOfDoubleClick = interruptsWait ||
      time - lastPressTime < SLOW_CLICK_RENAME_DELAY ||
      time - lastReleaseTime < SLOW_CLICK_RENAME_DELAY
    lastPressTime = time

    const hasModifier = info.ctrlKey || info.shiftKey || info.altKey || info.metaKey
    if (partOfDoubleClick || hasModifier || !info.wasSelected || !info.windowFocused) {
      return
    }

    pressX = info.x
    pressY = info.y
    setPhase('pressed')
  }

  function pointerMove (x: number, y: number): void {
    if (phase === 'pressed' && movedTooFar(x, y)) {
      cancel()
    }
  }

  function pointerUp (x: number, y: number, inside: boolean): void {
    if (phase !== 'pressed') {
      return
    }

    if (!inside || movedTooFar(x, y)) {
      cancel()
      return
    }

    lastReleaseTime = now()
    setPhase('waiting')
    timer = setTimer(() => {
      timer = undefined
      setPhase('idle')
      options.onRename()
    }, SLOW_CLICK_RENAME_DELAY)
  }

  return { pointerDown, pointerMove, pointerUp, cancel }
}
