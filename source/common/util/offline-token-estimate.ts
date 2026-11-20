/**
 * Estimates tokens from UTF-8 bytes without a model tokenizer or network access.
 * This deliberately transparent heuristic is not an exact Claude token count.
 */
export function estimateOfflineTokens (text: string): number {
  return estimateOfflineTokensInRanges([text])
}

/** Adds source bytes across ranges without joining text or rounding each range. */
export function estimateOfflineTokensInRanges (textRanges: Iterable<string>): number {
  const encoder = new TextEncoder()
  let bytes = 0
  for (const text of textRanges) {
    bytes += encoder.encode(text).length
  }
  return Math.ceil(bytes / 4)
}
