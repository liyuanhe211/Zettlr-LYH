/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Editor font zoom arithmetic
 * CVM-Role:        Utility functions
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Pure helpers behind zooming the editor font size with
 *                  Ctrl plus the mouse wheel: normalizing the wheel delta of
 *                  the three possible delta modes into pixels, accumulating
 *                  those pixels into whole zoom steps (high-resolution wheels
 *                  and trackpads report only a few pixels per event), and
 *                  clamping the resulting font size into the supported range.
 *                  This module deliberately imports nothing, so that it stays
 *                  unit-testable outside of a renderer process.
 *
 * END HEADER
 */

/**
 * The smallest editor font size the zoom will go down to, in pixels.
 */
export const MINIMUM_EDITOR_FONT_SIZE = 8

/**
 * The largest editor font size the zoom will go up to, in pixels.
 */
export const MAXIMUM_EDITOR_FONT_SIZE = 72

/**
 * The default editor font size, in pixels. Mirrors the default of the
 * `editor.fontSize` configuration option and is used as the fallback whenever
 * a font size turns out not to be a finite number.
 */
export const DEFAULT_EDITOR_FONT_SIZE = 18

/**
 * How many pixels of accumulated wheel movement make up one zoom step, that
 * is, a change of the font size by one pixel. This is also what one line or
 * one page of wheel movement counts as.
 */
export const WHEEL_DELTA_PER_ZOOM_STEP = 100

/**
 * Converts the vertical delta of a wheel event into pixels, regardless of
 * which unit the event reports it in.
 *
 * @param   {number}  deltaY     The `deltaY` of the wheel event
 * @param   {number}  deltaMode  The `deltaMode` of the wheel event (0 =
 *                               pixels, 1 = lines, 2 = pages)
 *
 * @return  {number}             The movement in pixels; 0 for unusable input
 */
export function normalizeWheelDelta (deltaY: number, deltaMode: number): number {
  if (!Number.isFinite(deltaY)) {
    return 0
  }

  // Chromium on Windows reports pixels (DOM_DELTA_PIXEL); lines and pages are
  // each counted as one full zoom step.
  if (deltaMode === 1 || deltaMode === 2) {
    return deltaY * WHEEL_DELTA_PER_ZOOM_STEP
  }

  return deltaY
}

/**
 * Turns a negative zero into a positive zero and leaves every other value
 * untouched. Dividing or negating can produce a negative zero, which strict
 * equality checks (`Object.is`, and with it `assert.strictEqual`) treat as a
 * different value from zero, so the functions here never hand one out.
 *
 * @param   {number}  value  The value to normalize
 *
 * @return  {number}         The value, with a negative zero turned positive
 */
function withoutNegativeZero (value: number): number {
  return value === 0 ? 0 : value
}

/**
 * Adds the movement of one wheel event to the movement carried over from the
 * previous events and splits the total into whole zoom steps plus a remainder
 * that has to be carried over again.
 *
 * Note the sign flip: scrolling up yields a negative `deltaY` but has to
 * enlarge the font, so the returned font size delta is the negated step count.
 *
 * @param   {number}  carriedDelta     The remainder of the previous events
 * @param   {number}  normalizedDelta  This event's movement, in pixels
 *
 * @return  {{ fontSizeDelta: number, carriedDelta: number }}  By how many
 *          pixels to change the font size, and the new remainder
 */
export function accumulateZoomSteps (
  carriedDelta: number,
  normalizedDelta: number
): { fontSizeDelta: number, carriedDelta: number } {
  const total = carriedDelta + normalizedDelta
  if (!Number.isFinite(total)) {
    return { fontSizeDelta: 0, carriedDelta: 0 }
  }

  const stepCount = Math.trunc(total / WHEEL_DELTA_PER_ZOOM_STEP)
  return {
    fontSizeDelta: withoutNegativeZero(-stepCount),
    carriedDelta: withoutNegativeZero(total - stepCount * WHEEL_DELTA_PER_ZOOM_STEP)
  }
}

/**
 * Rounds a font size and confines it to the supported range.
 *
 * @param   {number}  fontSize  The font size in pixels
 *
 * @return  {number}            A whole font size within the supported range
 */
export function clampEditorFontSize (fontSize: number): number {
  if (!Number.isFinite(fontSize)) {
    return DEFAULT_EDITOR_FONT_SIZE
  }

  return Math.min(
    MAXIMUM_EDITOR_FONT_SIZE,
    Math.max(MINIMUM_EDITOR_FONT_SIZE, Math.round(fontSize))
  )
}

/**
 * Applies a font size delta to the current font size, keeping the result
 * within the supported range.
 *
 * @param   {number}  currentFontSize  The font size before the zoom
 * @param   {number}  fontSizeDelta    By how many pixels to change it
 *
 * @return  {number}                   The font size after the zoom
 */
export function nextEditorFontSize (currentFontSize: number, fontSizeDelta: number): number {
  return clampEditorFontSize(clampEditorFontSize(currentFontSize) + fontSizeDelta)
}
