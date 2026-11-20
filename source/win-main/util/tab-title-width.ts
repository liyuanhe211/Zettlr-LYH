/**
 * Fits document-tab text into a 31-unit budget without changing file names.
 * ASCII and other narrow code points use one unit; fullwidth CJK characters
 * and emoji use two. The ellipsis uses one unit. This is a logical text budget,
 * not a measurement of glyph pixels or Unicode grapheme clusters.
 */

export const MAXIMUM_TAB_TITLE_WIDTH = 31
const ELLIPSIS = '…'
const DIRECTORY_WRAPPER_WIDTH = 3 // The space and the two square brackets
const MINIMUM_TITLE_BUDGET = 10

export interface TabTitleInput {
  path: string
  title: string
  directory?: string
}

export interface TabTitleParts {
  title: string
  directory?: string
}

/** Counts fullwidth East Asian code points and emoji as two narrow cells. */
function codePointWidth (character: string): number {
  const codePoint = character.codePointAt(0) ?? 0
  const fullwidth = codePoint >= 0x1100 && (
    codePoint <= 0x115f || codePoint === 0x2329 || codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0x3247 && codePoint !== 0x303f) ||
    (codePoint >= 0x3250 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0xa4c6) ||
    (codePoint >= 0xa960 && codePoint <= 0xa97c) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6b) ||
    (codePoint >= 0xff01 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1b000 && codePoint <= 0x1b122) ||
    (codePoint >= 0x1f200 && codePoint <= 0x1f251) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  )
  const emoji = /\p{Extended_Pictographic}/u.test(character) ||
    (codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff)
  return fullwidth || emoji ? 2 : 1
}

/** Counts Unicode code points, never UTF-16 surrogate halves. */
export function tabTitleWidth (text: string): number {
  return Array.from(text).reduce((width, character) => width + codePointWidth(character), 0)
}

function takePrefix (characters: string[], budget: number): string {
  let text = ''
  let width = 0
  for (const character of characters) {
    const characterWidth = codePointWidth(character)
    if (width + characterWidth > budget) {
      break
    }
    text += character
    width += characterWidth
  }
  return text
}

/** Keeps the beginning, or both ends for a directory, with a counted ellipsis. */
function shortenText (text: string, budget: number, keepBothEnds = false): string {
  if (tabTitleWidth(text) <= budget) {
    return text
  }
  if (budget <= 0) {
    return ''
  }

  const characters = Array.from(text)
  const remaining = budget - tabTitleWidth(ELLIPSIS)
  if (!keepBothEnds) {
    return takePrefix(characters, remaining) + ELLIPSIS
  }

  const prefixBudget = Math.ceil(remaining / 2)
  const prefix = takePrefix(characters, prefixBudget)
  const suffix = Array.from(takePrefix([...characters].reverse(), remaining - tabTitleWidth(prefix))).reverse().join('')
  return prefix + ELLIPSIS + suffix
}

function directoryBudget (title: string): number {
  return MAXIMUM_TAB_TITLE_WIDTH - DIRECTORY_WRAPPER_WIDTH - Math.min(tabTitleWidth(title), MINIMUM_TITLE_BUDGET)
}

/**
 * Reserves space for the directory before shortening the file title. Directory
 * labels still come from tab-label-disambiguation.ts. If middle shortening
 * collides, stable path-ordered numbers keep equally named tabs distinguishable.
 * The active tab hides its directory after collision handling, so switching
 * tabs does not renumber the remaining labels.
 */
export function computeTabTitleParts (entries: TabTitleInput[], activePath?: string): Map<string, TabTitleParts> {
  const parts = new Map<string, TabTitleParts>()
  const collisions = new Map<string, TabTitleInput[]>()
  for (const entry of entries) {
    const directory = entry.directory === undefined
      ? undefined
      : shortenText(entry.directory, directoryBudget(entry.title), true)
    parts.set(entry.path, { title: entry.title, directory })
    if (directory !== undefined) {
      const key = JSON.stringify([ entry.title.toLowerCase(), directory.toLowerCase() ])
      const group = collisions.get(key) ?? []
      group.push(entry)
      collisions.set(key, group)
    }
  }

  for (const group of collisions.values()) {
    if (group.length < 2) {
      continue
    }
    const ordered = [...group].sort((first, second) => first.path < second.path ? -1 : first.path > second.path ? 1 : 0)
    ordered.forEach((entry, index) => {
      const marker = ' #' + String(index + 1)
      const directory = shortenText(entry.directory ?? '', directoryBudget(entry.title) - tabTitleWidth(marker), true) + marker
      parts.set(entry.path, { title: entry.title, directory })
    })
  }

  for (const entry of entries) {
    const directory = entry.path === activePath ? undefined : parts.get(entry.path)?.directory
    const titleBudget = MAXIMUM_TAB_TITLE_WIDTH - (directory === undefined ? 0 : tabTitleWidth(directory) + DIRECTORY_WRAPPER_WIDTH)
    parts.set(entry.path, { title: shortenText(entry.title, titleBudget), directory })
  }
  return parts
}
