/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Preferences scroll spy
 * CVM-Role:        Utility function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Pure helper that decides which preferences group is the
 *                  "active" one while the user scrolls through the long page.
 *                  It has no DOM access so that it can be tested directly.
 *
 * END HEADER
 */

/**
 * How many pixels below the top edge of the scroll container a group heading
 * may be and still count as the active one. The tolerance absorbs rounding
 * differences between `offsetTop` and `scrollTop` after a programmatic scroll.
 */
export const ACTIVE_GROUP_OFFSET = 8

/**
 * Determines which group is active for a given scroll position.
 *
 * - If the container is scrolled all the way down, the last group is active.
 *   This is the only way to reach a short group at the end of the page that can
 *   never have its heading scrolled to the top edge. A container that is not
 *   scrollable at all is not "scrolled down", so this rule does not apply to it.
 * - Otherwise the active group is the last one whose heading top does not lie
 *   further than `offset` pixels below the current top edge of the viewport.
 * - The result is never negative; an empty list yields 0.
 *
 * @param   {number[]}  sectionTops      The top position of every group heading
 *                                       inside the scroll container (in the
 *                                       order in which the groups appear).
 * @param   {number}    scrollTop        The current scroll position.
 * @param   {number}    viewportHeight   The visible height of the container.
 * @param   {number}    scrollHeight     The full scrollable height.
 * @param   {number}    offset           Tolerance below the top edge.
 *
 * @return  {number}                     The index of the active group.
 */
export function findActiveGroupIndex (
  sectionTops: number[],
  scrollTop: number,
  viewportHeight: number,
  scrollHeight: number,
  offset: number = ACTIVE_GROUP_OFFSET
): number {
  if (sectionTops.length === 0) {
    return 0
  }

  // One pixel of slack, because fractional layout positions can leave the
  // container a fraction of a pixel short of its maximum scroll position.
  const isScrollable = scrollHeight > viewportHeight
  if (isScrollable && scrollTop + viewportHeight >= scrollHeight - 1) {
    return sectionTops.length - 1
  }

  let active = 0
  for (let i = 0; i < sectionTops.length; i++) {
    if (sectionTops[i] <= scrollTop + offset) {
      active = i
    }
  }

  return active
}
