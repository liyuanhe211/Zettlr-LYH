/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Pandoc two-column layout builder
 * CVM-Role:        Utility
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Builds the pandoc two-column fenced div that the "Split Slide"
 *                  editor command inserts around a selection. The text-to-text
 *                  part is kept here, apart from the editor command itself, so
 *                  that the splitting rules can be tested without an editor.
 *
 * END HEADER
 */

/**
 * A line that holds nothing but one image. Such lines go into the right column.
 */
const IMAGE_ONLY_LINE_PATTERN = /^\s*!\[[^\]]*\]\([^)]*\)\s*$/

export interface PandocColumnsReplacement {
  /**
   * The text that replaces the selected lines
   */
  text: string
  /**
   * Where the cursor goes, as an offset into `text`
   */
  cursorOffset: number
}

/**
 * Drops blank lines from both ends of the list (blank lines inside are kept,
 * because they separate paragraphs of the same column)
 */
function stripOuterBlankLines (lines: string[]): string[] {
  const result = [...lines]
  while (result.length > 0 && result[0].trim() === '') {
    result.shift()
  }
  while (result.length > 0 && result[result.length - 1].trim() === '') {
    result.pop()
  }
  return result
}

/**
 * Splits the selected lines into a pandoc two-column layout: image-only lines
 * go into the right column and everything else into the left one (the
 * text-left / image-right slide pattern, 65/35). A selection without any image
 * line is split 50/50 and its right column stays empty, with the cursor placed
 * inside it; an empty selection yields the bare skeleton with the cursor in the
 * left column.
 *
 * @param   {string}  selectedText  The selection, expanded to whole lines
 *
 * @return  {PandocColumnsReplacement}  The replacement and the cursor offset
 */
export function buildPandocColumns (selectedText: string): PandocColumnsReplacement {
  const selectedLines = selectedText.split('\n')
  const imageLines = stripOuterBlankLines(selectedLines.filter(line => IMAGE_ONLY_LINE_PATTERN.test(line)))
  const otherLines = stripOuterBlankLines(selectedLines.filter(line => !IMAGE_ONLY_LINE_PATTERN.test(line)))
  const hasImages = imageLines.length > 0
  const leftWidth = hasImages ? '65%' : '50%'
  const rightWidth = hasImages ? '35%' : '50%'
  const leftContent = otherLines.join('\n')
  const rightContent = imageLines.join('\n\n')

  const prefix = `:::: {.columns}\n::: {.column width="${leftWidth}"}\n`
  const middle = `\n:::\n::: {.column width="${rightWidth}"}\n`
  const suffix = '\n:::\n::::'

  // Put the cursor into the left column when it is empty, otherwise at the end
  // of the right column (which is its start when that column is empty)
  const cursorOffset = leftContent === ''
    ? prefix.length
    : prefix.length + leftContent.length + middle.length + rightContent.length

  return { text: prefix + leftContent + middle + rightContent + suffix, cursorOffset }
}
