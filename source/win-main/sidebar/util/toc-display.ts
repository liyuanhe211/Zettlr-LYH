/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Display helpers for the sidebar table of contents
 * CVM-Role:        Utility
 * License:         GNU GPL v3
 *
 * Description:     Pure functions that decide which table of contents entries
 *                  the sidebar shows for a maximum heading level, which of the
 *                  shown entries is highlighted for the cursor position, and
 *                  where a dragged section lands when it is dropped onto an
 *                  entry. All indices refer to the complete table of contents,
 *                  so that data stored per entry (such as the rendered HTML)
 *                  stays aligned. With the maximum level 6 every function
 *                  behaves exactly like the unfiltered table of contents.
 *                  Also contains the list marker of each heading level (R110),
 *                  the reading line that the highlight follows and the scroll
 *                  position that reveals the highlighted entry (R112), and the
 *                  decision which editor carries out a jump to a line (R113).
 *
 * END HEADER
 */

/**
 * The part of a table of contents entry that the display helpers need
 */
export interface TocDisplayEntry {
  /**
   * The one-indexed line number of the heading
   */
  line: number
  /**
   * The Markdown heading level (1-6)
   */
  level: number
}

/**
 * The deepest Markdown heading level; showing up to it shows every entry
 */
export const DEEPEST_HEADING_LEVEL = 6

/**
 * Turns a configured maximum heading level into a whole number from 1 to 6.
 * Missing or unusable values fall back to 6, which shows every entry.
 *
 * @param   {unknown}  value  The configured value
 *
 * @return  {number}          The usable maximum heading level
 */
export function normalizeTocMaxHeadingLevel (value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEEPEST_HEADING_LEVEL
  }
  return Math.min(DEEPEST_HEADING_LEVEL, Math.max(1, Math.round(value)))
}

/**
 * Returns the indices of the entries whose heading level does not exceed the
 * maximum level. The level is the Markdown heading level, not the numbering
 * written into the heading text.
 *
 * @param   {TocDisplayEntry[]|undefined}  entries   The complete table of contents
 * @param   {number}                       maxLevel  The deepest level to show
 *
 * @return  {number[]}                               Indices into the complete list, ascending
 */
export function visibleTocEntryIndices (entries: readonly TocDisplayEntry[]|undefined, maxLevel: number): number[] {
  if (entries == null) {
    return []
  }
  const level = normalizeTocMaxHeadingLevel(maxLevel)
  const indices: number[] = []
  for (let index = 0; index < entries.length; index++) {
    if (entries[index].level <= level) {
      indices.push(index)
    }
  }
  return indices
}

/**
 * Returns the index of the visible entry to highlight: the visible entry whose
 * line does not exceed the cursor line while the next visible entry starts
 * after it. A cursor inside a hidden subsection therefore highlights the
 * nearest visible parent heading; a cursor before the first visible heading
 * highlights nothing.
 *
 * @param   {TocDisplayEntry[]|undefined}  entries         The complete table of contents
 * @param   {number[]}                     visibleIndices  The result of visibleTocEntryIndices
 * @param   {number}                       cursorLine      The one-indexed cursor line
 *
 * @return  {number|undefined}                             An index into the complete list, or undefined
 */
export function activeVisibleTocEntryIndex (
  entries: readonly TocDisplayEntry[]|undefined,
  visibleIndices: readonly number[],
  cursorLine: number
): number|undefined {
  if (entries == null) {
    return undefined
  }
  for (let position = 0; position < visibleIndices.length; position++) {
    const index = visibleIndices[position]
    const nextLine = position + 1 < visibleIndices.length
      ? entries[visibleIndices[position + 1]].line
      : Infinity
    if (cursorLine >= entries[index].line && cursorLine < nextLine) {
      return index
    }
  }
  return undefined
}

/**
 * Returns the line in front of which a section dropped onto the target entry
 * is inserted: the line of the next visible entry after the target, so that
 * hidden subsections of the target are passed over together with it. Returns
 * -1 when no visible entry follows (insert at the end of the document) and
 * undefined when the target index does not exist.
 *
 * @param   {TocDisplayEntry[]|undefined}  entries      The complete table of contents
 * @param   {number}                       targetIndex  The index of the target entry in the complete list
 * @param   {number}                       maxLevel     The deepest level shown
 *
 * @return  {number|undefined}                          The target line, -1, or undefined
 */
export function sectionDropTargetLine (
  entries: readonly TocDisplayEntry[]|undefined,
  targetIndex: number,
  maxLevel: number
): number|undefined {
  if (entries == null || !Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= entries.length) {
    return undefined
  }
  const level = normalizeTocMaxHeadingLevel(maxLevel)
  for (let index = targetIndex + 1; index < entries.length; index++) {
    if (entries[index].level <= level) {
      return entries[index].line
    }
  }
  return -1
}

/**
 * The list markers of the heading levels, repeated every three levels like the
 * default markers of nested unordered lists in browsers (R110)
 */
const TOC_BULLETS = [ '•', '◦', '▪' ]

/**
 * Returns the list marker shown in front of an entry of the given heading
 * level: a filled circle for the levels 1 and 4, a hollow circle for 2 and 5
 * and a small filled square for 3 and 6. Levels outside 1 to 6 are clamped
 * into that range; unusable values count as level 1.
 *
 * @param   {number}  level  The Markdown heading level
 *
 * @return  {string}         The list marker
 */
export function tocBulletForLevel (level: number): string {
  const usableLevel = typeof level === 'number' && Number.isFinite(level)
    ? Math.min(DEEPEST_HEADING_LEVEL, Math.max(1, Math.round(level)))
    : 1
  return TOC_BULLETS[(usableLevel - 1) % TOC_BULLETS.length]
}

/**
 * Returns the scroll position of the table of contents panel that reveals an
 * entry (R112). An entry that is completely visible leaves the position
 * unchanged. An entry above the visible area ends up the margin below the top
 * edge, an entry below it the margin above the bottom edge. An entry that does
 * not fit together with both margins is aligned at the top. The result is
 * never negative. All values are in pixels within the scrolled content.
 *
 * @param   {number}  entryTop        Top of the entry
 * @param   {number}  entryBottom     Bottom of the entry
 * @param   {number}  panelScrollTop  Current scroll position of the panel
 * @param   {number}  panelHeight     Visible height of the panel
 * @param   {number}  margin          Space to keep between entry and edge
 *
 * @return  {number}                  The scroll position to use
 */
export function tocScrollOffsetToReveal (
  entryTop: number,
  entryBottom: number,
  panelScrollTop: number,
  panelHeight: number,
  margin: number
): number {
  const visibleBottom = panelScrollTop + panelHeight
  if (entryTop >= panelScrollTop && entryBottom <= visibleBottom) {
    return panelScrollTop
  }
  const alignedAtTop = Math.max(0, entryTop - margin)
  if (entryTop < panelScrollTop || entryBottom - entryTop + 2 * margin > panelHeight) {
    return alignedAtTop
  }
  return Math.max(0, entryBottom + margin - panelHeight)
}

/**
 * The reading line of the active editor: the line at one third of its visible
 * height, together with the pane and the file it belongs to (R112)
 */
export interface TocReadingLine {
  leafId: string
  filePath: string
  line: number
}

/**
 * Returns the one-indexed line that the highlight of the table of contents
 * follows, or undefined if the reading line belongs to another pane or file
 * than the one the table of contents currently shows (for example while a
 * JSON viewer, which reports no reading line, is active).
 *
 * @param   {TocReadingLine|undefined}  readingLine     The last reported reading line
 * @param   {string|undefined}          activeLeafId    The pane whose contents the sidebar shows
 * @param   {string|undefined}          activeFilePath  The active file of that pane
 *
 * @return  {number|undefined}                          The line, or undefined
 */
export function tocReadingLine (
  readingLine: TocReadingLine|undefined,
  activeLeafId: string|undefined,
  activeFilePath: string|undefined
): number|undefined {
  if (readingLine === undefined || activeLeafId === undefined || activeFilePath === undefined) {
    return undefined
  }
  if (readingLine.leafId !== activeLeafId || readingLine.filePath !== activeFilePath) {
    return undefined
  }
  return readingLine.line
}

/**
 * Decides whether an editor carries out a jump to a line (R113). The jump has
 * to concern the file of the editor. A jump that names a pane (from the table
 * of contents) is carried out only by the editor of that pane; a jump without
 * a pane (search results, PDF backlinks and other sources) is carried out by
 * every editor that shows the file.
 *
 * @param   {Object}   request         The data of the jump command
 * @param   {string}   editorFilePath  The file shown by the editor
 * @param   {string}   editorLeafId    The pane of the editor
 *
 * @return  {boolean}                  Whether the editor jumps
 */
export function shouldEditorJump (
  request: { filePath?: unknown, leafId?: unknown },
  editorFilePath: string,
  editorLeafId: string
): boolean {
  if (request.filePath !== editorFilePath) {
    return false
  }
  if (typeof request.leafId === 'string') {
    return request.leafId === editorLeafId
  }
  return true
}
