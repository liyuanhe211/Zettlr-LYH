/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        separatorNextToText, isTextControl
 * CVM-Role:        Utility function
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH (R77): decides how tall a vertical separator
 *                  line of the toolbar is. A separator next to a text control
 *                  is as tall as the text buttons; a separator with no text
 *                  control on either side keeps its short default height. The
 *                  decision looks at the nearest visible control on each side,
 *                  so it follows the display settings that hide controls.
 *
 * END HEADER
 */

/**
 * The part of a toolbar control that the decision looks at. Every member of
 * the toolbar's control union fits this shape.
 */
export interface SeparatorNeighborControl {
  type: string
  visible?: unknown
  buttonText?: unknown
}

/**
 * Whether a toolbar control shows text: a button with a non-empty button
 * text, a text control, or a drag-adjust control (R81). Icon buttons, the
 * three-way toggle, ring buttons, search fields, spacers and separators do
 * not.
 *
 * @param   {SeparatorNeighborControl}  control  The control to inspect
 *
 * @return  {boolean}                            True if it is a text control
 */
export function isTextControl (control: SeparatorNeighborControl): boolean {
  if (control.type === 'button') {
    return typeof control.buttonText === 'string' && control.buttonText !== ''
  }
  return control.type === 'text' || control.type === 'drag-adjust'
}

/**
 * Finds the nearest visible control from a position in one direction. A
 * control with `visible === false` is skipped.
 *
 * @param   {SeparatorNeighborControl[]}  controls  All controls of the toolbar
 * @param   {number}                      index     The position of the separator
 * @param   {number}                      step      -1 to look left, +1 to look right
 *
 * @return  {SeparatorNeighborControl|undefined}    The neighbor, or undefined at the end of the list
 */
function nearestVisibleControl (
  controls: readonly SeparatorNeighborControl[],
  index: number,
  step: -1|1
): SeparatorNeighborControl|undefined {
  for (let position = index + step; position >= 0 && position < controls.length; position += step) {
    const control = controls[position]
    if (control.visible !== false) {
      return control
    }
  }
  return undefined
}

/**
 * Whether the separator at the given position takes the height of the text
 * buttons: true if the nearest visible control on either side is a text
 * control. A side that reaches the end of the list, or whose nearest visible
 * control is a spacer, counts as a side without text.
 *
 * @param   {SeparatorNeighborControl[]}  controls  All controls of the toolbar
 * @param   {number}                      index     The position of the separator
 *
 * @return  {boolean}                               True if the separator is as tall as the text buttons
 */
export function separatorNextToText (controls: readonly SeparatorNeighborControl[], index: number): boolean {
  const left = nearestVisibleControl(controls, index, -1)
  const right = nearestVisibleControl(controls, index, 1)
  return (left !== undefined && isTextControl(left)) || (right !== undefined && isTextControl(right))
}
