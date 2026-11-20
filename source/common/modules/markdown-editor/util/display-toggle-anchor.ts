/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Display Toggle Anchor
 * CVM-Role:        Utility
 * License:         GNU GPL v3
 *
 * Description:     Pure functions that decide which line keeps its position
 *                  on screen when a selection change switches a block between
 *                  its rendered display and its source (an image entering or
 *                  leaving source editing, a raw HTML block, a block formula,
 *                  ...). The input are two snapshots of the line boxes of the
 *                  rendered viewport, taken before and after the switch; the
 *                  result is the line directly above the first switched block
 *                  that is visible on screen (if it is itself unchanged and
 *                  entirely visible), otherwise the first unchanged visible
 *                  line below the switched lines. See specification C13,
 *                  section 4.
 *
 * END HEADER
 */

/**
 * Height differences (in pixels) up to this value do not count as a change of
 * a line's display.
 */
const HEIGHT_TOLERANCE = 1

/**
 * The box of one document line (or of a block that a widget renders in place
 * of several lines, keyed by its first line) in the rendered viewport.
 */
export interface LineBox {
  /**
   * The document line number (1-based).
   */
  line: number
  /**
   * The top of the line's block, in pixels relative to the top of the visible
   * area of the scroller.
   */
  top: number
  /**
   * The bottom of the line's block, relative to the same origin.
   */
  bottom: number
}

/**
 * The line that keeps its position on screen across a display toggle.
 */
export interface ToggleAnchor {
  /**
   * The document line number of the anchor line.
   */
  line: number
  /**
   * The top of the anchor line before the toggle, relative to the top of the
   * visible area.
   */
  top: number
}

/**
 * Determines whether a box intersects the visible area.
 *
 * @param   {LineBox}  box            The box
 * @param   {number}   visibleHeight  The height of the visible area
 *
 * @return  {boolean}                 True if the box is at least partly visible
 */
function intersectsVisibleArea (box: LineBox, visibleHeight: number): boolean {
  return box.bottom > 0 && box.top < visibleHeight
}

/**
 * Determines whether a row lies entirely within the visible area.
 *
 * @param   {number}   top            The row top, relative to the visible area
 * @param   {number}   bottom         The row bottom, relative to the same origin
 * @param   {number}   visibleHeight  The height of the visible area
 *
 * @return  {boolean}                 True if the row is entirely visible
 */
export function isRowFullyVisible (top: number, bottom: number, visibleHeight: number): boolean {
  return top >= 0 && bottom <= visibleHeight
}

/**
 * Finds the line that keeps its position on screen when a selection change
 * switches one or more blocks between their rendered display and their
 * source. A line counts as changed if its height differs by more than one
 * pixel between the snapshots, or if it appears in only one of them (it was
 * swallowed by a widget or released from one). The first changed line that
 * intersects the visible area before the toggle decides: the anchor is the
 * unchanged line directly above it if that line was entirely visible,
 * otherwise the first unchanged line below the consecutive run of changed
 * lines that intersected the visible area.
 *
 * @param   {LineBox[]}         before         The boxes before the toggle,
 *                                             sorted by line number
 * @param   {LineBox[]}         after          The boxes after the toggle,
 *                                             sorted by line number
 * @param   {number}            visibleHeight  The height of the visible area
 *
 * @return  {ToggleAnchor|null}                The anchor line and its top
 *                                             before the toggle, or null if
 *                                             no visible line changed or no
 *                                             anchor exists
 */
export function findToggleAnchor (before: LineBox[], after: LineBox[], visibleHeight: number): ToggleAnchor|null {
  const beforeByLine = new Map(before.map(box => [ box.line, box ]))
  const afterByLine = new Map(after.map(box => [ box.line, box ]))

  const isChanged = (line: number): boolean => {
    const beforeBox = beforeByLine.get(line)
    const afterBox = afterByLine.get(line)
    if (beforeBox === undefined || afterBox === undefined) {
      return true
    }
    const heightBefore = beforeBox.bottom - beforeBox.top
    const heightAfter = afterBox.bottom - afterBox.top
    return Math.abs(heightBefore - heightAfter) > HEIGHT_TOLERANCE
  }

  const firstChanged = before.find(box => intersectsVisibleArea(box, visibleHeight) && isChanged(box.line))
  if (firstChanged === undefined) {
    return null // No visible line changed
  }

  // First preference: the unchanged line with the largest line number above
  // the first changed line, if it was entirely visible.
  let above: LineBox|undefined
  for (const box of before) {
    if (box.line >= firstChanged.line) {
      break
    }
    if (!isChanged(box.line)) {
      above = box
    }
  }
  if (above !== undefined && isRowFullyVisible(above.top, above.bottom, visibleHeight)) {
    return { line: above.line, top: above.top }
  }

  // Otherwise: the first unchanged line below the run of consecutive changed
  // lines starting at the first changed line. The run follows the line
  // numbers present in either snapshot; lines in neither are inside a block
  // that is unchanged in both.
  const lines = [...new Set([ ...beforeByLine.keys(), ...afterByLine.keys() ])].sort((a, b) => a - b)
  let index = lines.indexOf(firstChanged.line)
  while (index + 1 < lines.length && isChanged(lines[index + 1])) {
    index++
  }
  const lastChangedLine = lines[index]

  const below = before.find(box => {
    return box.line > lastChangedLine && !isChanged(box.line) && intersectsVisibleArea(box, visibleHeight)
  })
  if (below === undefined) {
    return null
  }

  return { line: below.line, top: below.top }
}

/**
 * Computes the scroll position that moves the anchor line back to its top
 * before the toggle, clamped between 0 and the maximum scroll position.
 *
 * @param   {number}  currentScrollTop  The current scroll position
 * @param   {number}  topAfter          The anchor line's current top,
 *                                      relative to the visible area
 * @param   {number}  topBefore         The anchor line's top before the
 *                                      toggle, relative to the visible area
 * @param   {number}  maxScrollTop      The maximum scroll position
 *
 * @return  {number}                    The new scroll position
 */
export function toggleCompensationScrollTop (
  currentScrollTop: number,
  topAfter: number,
  topBefore: number,
  maxScrollTop: number
): number {
  const target = currentScrollTop + topAfter - topBefore
  return Math.min(Math.max(target, 0), maxScrollTop)
}
