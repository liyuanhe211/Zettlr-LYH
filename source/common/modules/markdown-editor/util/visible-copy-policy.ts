/** Categories shared by editor copy behavior and persisted preferences. */
export const copyVisibleTextCategoryLabels = {
  inlineCode: 'Inline code',
  headings: 'Headings',
  bold: 'Bold',
  italic: 'Italic',
  codeBlocks: 'Code blocks',
  lists: 'Lists',
  math: 'Math (LaTeX without delimiters)',
  images: 'Images (image data)'
} as const

export type CopyVisibleTextCategory = keyof typeof copyVisibleTextCategoryLabels
export type CopyVisibleTextCategories = Record<CopyVisibleTextCategory, boolean>

export const defaultCopyVisibleTextCategories: Readonly<CopyVisibleTextCategories> = {
  inlineCode: true, headings: true, bold: true, italic: true, codeBlocks: true,
  lists: false, math: false, images: false
}

/** Fill missing or invalid keys without retaining unrecognized categories. */
export function normalizeCopyVisibleTextCategories (value: unknown): CopyVisibleTextCategories {
  const normalized = { ...defaultCopyVisibleTextCategories }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return normalized
  }
  for (const category of Object.keys(normalized) as CopyVisibleTextCategory[]) {
    const setting = (value as Record<string, unknown>)[category]
    if (typeof setting === 'boolean') {
      normalized[category] = setting
    }
  }
  return normalized
}
