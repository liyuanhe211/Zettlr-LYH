/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Pandoc PPTX preview scroll mapping
 * CVM-Role:        Utility function
 * License:         GNU GPL v3
 *
 * Description:     Pure functions behind the synchronized scrolling between a
 *                  Markdown editor and its pandoc PPTX preview. Every page
 *                  contributes one anchor: the scroll offset at which its
 *                  first source line (startLine) sits at the top of the
 *                  editor, paired with the scroll offset at which its preview
 *                  card sits at the top of the preview list. Scroll offsets in
 *                  between are mapped by piecewise linear interpolation
 *                  between neighbouring anchors, in either direction. The
 *                  module has no DOM or editor dependencies, so that it can
 *                  be unit-tested in isolation.
 *
 * END HEADER
 */

/**
 * A pair of corresponding scroll offsets: `source` on the side being scrolled,
 * `target` on the side that follows.
 */
export interface ScrollAnchor {
  source: number
  target: number
}

function clamp (value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}

/**
 * Turns the per-page offset pairs into a mapping table that is safe to
 * interpolate over.
 *
 * The table always starts at (0, 0) and ends at (sourceMaximum, targetMaximum),
 * so that both sides reach their very top and very bottom together. Every page
 * pair is clamped into the scrollable range of each side first (a page near the
 * end of a short list cannot actually be scrolled to the top). Pairs that would
 * make either coordinate go backwards (for example stale positions while a side
 * re-lays out) are dropped, so the table is non-decreasing in both coordinates
 * and therefore remains valid when inverted.
 *
 * @param   {ScrollAnchor[]}  pagePairs      One pair per page, in page order
 * @param   {number}          sourceMaximum  Largest scroll offset of the source
 * @param   {number}          targetMaximum  Largest scroll offset of the target
 *
 * @return  {ScrollAnchor[]}                 The mapping table
 */
export function buildScrollAnchors (pagePairs: ScrollAnchor[], sourceMaximum: number, targetMaximum: number): ScrollAnchor[] {
  const safeSourceMaximum = Math.max(0, sourceMaximum)
  const safeTargetMaximum = Math.max(0, targetMaximum)
  const anchors: ScrollAnchor[] = [{ source: 0, target: 0 }]

  const candidates = [
    ...pagePairs.map(pair => ({
      source: clamp(pair.source, 0, safeSourceMaximum),
      target: clamp(pair.target, 0, safeTargetMaximum)
    })),
    { source: safeSourceMaximum, target: safeTargetMaximum }
  ]

  for (const candidate of candidates) {
    if (!Number.isFinite(candidate.source) || !Number.isFinite(candidate.target)) {
      continue
    }
    const previous = anchors[anchors.length - 1]
    if (candidate.source < previous.source || candidate.target < previous.target) {
      continue
    }
    anchors.push(candidate)
  }

  return anchors
}

/**
 * Swaps source and target of every anchor, turning an editor-to-preview table
 * into a preview-to-editor table (valid because built tables are
 * non-decreasing in both coordinates).
 *
 * @param   {ScrollAnchor[]}  anchors  A table from buildScrollAnchors
 *
 * @return  {ScrollAnchor[]}           The inverted table
 */
export function invertScrollAnchors (anchors: ScrollAnchor[]): ScrollAnchor[] {
  return anchors.map(anchor => ({ source: anchor.target, target: anchor.source }))
}

/**
 * Maps a scroll offset of the source side to the corresponding offset of the
 * target side.
 *
 * - No anchors: undefined (nothing to map against).
 * - At or before the first anchor: the first anchor's target (clamped).
 * - At or after the last anchor: the last anchor's target (clamped).
 * - In between: linear interpolation between the two neighbouring anchors.
 *   Where several anchors share the same source offset, the last of them
 *   applies from that offset on.
 *
 * @param   {ScrollAnchor[]}  anchors   Non-decreasing in source
 * @param   {number}          position  The source offset
 *
 * @return  {number|undefined}          The target offset
 */
export function mapScrollPosition (anchors: ScrollAnchor[], position: number): number|undefined {
  if (anchors.length === 0) {
    return undefined
  }

  if (position <= anchors[0].source) {
    return anchors[0].target
  }

  for (let index = 1; index < anchors.length; index++) {
    const next = anchors[index]
    if (position < next.source) {
      const previous = anchors[index - 1]
      const fraction = (position - previous.source) / (next.source - previous.source)
      return previous.target + fraction * (next.target - previous.target)
    }
  }

  return anchors[anchors.length - 1].target
}

/**
 * Finds the page a source line belongs to: the last page whose startLine is
 * not after the line. A line before the first page belongs to the first page.
 *
 * @param   {number[]}  startLines  The pages' 0-based start lines, ascending
 * @param   {number}    line        A 0-based source line
 *
 * @return  {number|undefined}      The page index, undefined without pages
 */
export function findPageIndexForLine (startLines: number[], line: number): number|undefined {
  if (startLines.length === 0) {
    return undefined
  }

  let pageIndex = 0
  for (let index = 0; index < startLines.length; index++) {
    if (startLines[index] <= line) {
      pageIndex = index
    } else {
      break
    }
  }
  return pageIndex
}
