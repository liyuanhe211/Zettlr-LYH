/** Window-local rules for limiting saved, unpinned document tabs. */
export interface TabLimitIdentity { leafId: string, filePath: string }

export interface TabLimitEntry extends TabLimitIdentity {
  pinned: boolean
  scratch: boolean
  modified: boolean
  ready: boolean
  blocked: boolean
  lastFocused: number
}

export function normalizeTabLimit (value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

export function selectTabLimitCandidates (
  tabs: readonly TabLimitEntry[], limit: unknown, protectedTab?: TabLimitIdentity
): TabLimitIdentity[] {
  const maximum = normalizeTabLimit(limit)
  if (maximum === 0) { return [] }
  const eligible = tabs.filter(tab => !tab.pinned && !tab.scratch && !tab.modified && tab.ready)
  const excess = eligible.length - maximum
  if (excess <= 0) { return [] }
  return eligible.map((tab, index) => ({ tab, index }))
    .filter(({ tab }) => !tab.blocked && !(tab.leafId === protectedTab?.leafId && tab.filePath === protectedTab.filePath))
    .sort((left, right) => left.tab.lastFocused - right.tab.lastFocused || left.index - right.index)
    .slice(0, excess)
    .map(({ tab }) => ({ leafId: tab.leafId, filePath: tab.filePath }))
}
