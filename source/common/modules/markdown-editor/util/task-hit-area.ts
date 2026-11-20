/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Task checkbox hit areas
 * CVM-Role:        Utility
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH (R116): Pure functions that decide whether a
 *                  pointer position lies within the enlarged clickable area of
 *                  a rendered task checkbox. In the main editor, the area spans
 *                  from the left edge of the list marker to a few pixels right
 *                  of the checkbox, over the full height of the visual row. In
 *                  table cells, which have no list marker, the area extends
 *                  the checkbox by a fixed margin on all four sides.
 *
 * END HEADER
 */

/**
 * How far the clickable area of a task checkbox in the main editor extends to
 * the right of the checkbox, in pixels.
 */
export const TASK_HIT_AREA_RIGHT_EXTENSION = 4

/**
 * How far the clickable area of a task checkbox in a table cell extends beyond
 * the checkbox on every side, in pixels.
 */
export const TABLE_TASK_HIT_AREA_MARGIN = 6

/**
 * The geometry of a task line in the main editor, in client coordinates.
 */
export interface TaskLineGeometry {
  /**
   * The left edge of the list marker as displayed (or of the line content, if
   * the marker is hidden).
   */
  markerLeft: number
  /**
   * The left edge of the checkbox.
   */
  checkboxLeft: number
  /**
   * The right edge of the checkbox.
   */
  checkboxRight: number
  /**
   * The top edge of the visual row that contains the checkbox.
   */
  rowTop: number
  /**
   * The bottom edge of the visual row that contains the checkbox.
   */
  rowBottom: number
}

/**
 * The bounding box of a checkbox, in client coordinates.
 */
export interface CheckboxRectangle {
  left: number
  right: number
  top: number
  bottom: number
}

/**
 * Whether a pointer position lies within the enlarged clickable area of a task
 * checkbox in the main editor: horizontally from the list marker's left edge
 * (or the checkbox's left edge, whichever is further left) to the checkbox's
 * right edge plus `TASK_HIT_AREA_RIGHT_EXTENSION`; vertically the full visual
 * row. All edges are inclusive.
 *
 * @param   {TaskLineGeometry}  geometry  The geometry of the task line
 * @param   {number}            x         The pointer's client x coordinate
 * @param   {number}            y         The pointer's client y coordinate
 *
 * @return  {boolean}                     Whether the position is a hit
 */
export function isInTaskHitArea (geometry: TaskLineGeometry, x: number, y: number): boolean {
  const left = Math.min(geometry.markerLeft, geometry.checkboxLeft)
  const right = geometry.checkboxRight + TASK_HIT_AREA_RIGHT_EXTENSION
  return x >= left && x <= right && y >= geometry.rowTop && y <= geometry.rowBottom
}

/**
 * Whether a pointer position lies within the enlarged clickable area of a task
 * checkbox in a table cell: the checkbox extended by `margin` pixels on every
 * side. All edges are inclusive.
 *
 * @param   {CheckboxRectangle}  checkbox  The checkbox's bounding box
 * @param   {number}             x         The pointer's client x coordinate
 * @param   {number}             y         The pointer's client y coordinate
 * @param   {number}             margin    The margin; defaults to
 *                                         `TABLE_TASK_HIT_AREA_MARGIN`
 *
 * @return  {boolean}                      Whether the position is a hit
 */
export function isInTableTaskHitArea (
  checkbox: CheckboxRectangle,
  x: number,
  y: number,
  margin: number = TABLE_TASK_HIT_AREA_MARGIN
): boolean {
  return x >= checkbox.left - margin && x <= checkbox.right + margin &&
    y >= checkbox.top - margin && y <= checkbox.bottom + margin
}

/**
 * Picks, among several checkboxes whose enlarged areas contain the pointer,
 * the one whose center is vertically closest to it. Neighbouring task lines in
 * a table cell can have overlapping areas.
 *
 * @param   {T[]}                            candidates  The candidates
 * @param   {(T) => CheckboxRectangle}       rectangle   Returns a candidate's
 *                                                       bounding box
 * @param   {number}                         x           The pointer's client x
 * @param   {number}                         y           The pointer's client y
 * @param   {number}                         margin      The margin
 *
 * @return  {T|null}                                     The best hit, or null
 */
export function closestTableTaskHit<T> (
  candidates: T[],
  rectangle: (candidate: T) => CheckboxRectangle,
  x: number,
  y: number,
  margin: number = TABLE_TASK_HIT_AREA_MARGIN
): T|null {
  let best: T|null = null
  let bestDistance = Infinity
  for (const candidate of candidates) {
    const box = rectangle(candidate)
    if (!isInTableTaskHitArea(box, x, y, margin)) {
      continue
    }
    const distance = Math.abs((box.top + box.bottom) / 2 - y)
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}
