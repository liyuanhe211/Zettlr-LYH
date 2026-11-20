import { shallowRef } from 'vue'

export interface ExplorerMetrics {
  iconSize: number
  rowHeight: number
  indent: number
  disclosureWidth: number
  iconTextGap: number
  fontFamily: string
  fontSize: number
}

const MAXIMUM_BATCH_PATHS = 256
const MAXIMUM_CACHED_PATHS = 2048
const MAXIMUM_CACHED_BYTES = 16 * 1024 * 1024

function validMetrics (value: unknown): value is ExplorerMetrics {
  if (typeof value !== 'object' || value === null) {return false}
  const metrics = value as ExplorerMetrics
  return [ 'iconSize', 'rowHeight', 'indent', 'disclosureWidth', 'iconTextGap', 'fontSize' ]
    .every(key => typeof metrics[key as keyof ExplorerMetrics] === 'number' &&
      Number.isFinite(metrics[key as keyof ExplorerMetrics]) &&
      Number(metrics[key as keyof ExplorerMetrics]) >= 0 && Number(metrics[key as keyof ExplorerMetrics]) <= 128) &&
    metrics.iconSize > 0 && metrics.fontSize > 0 && metrics.rowHeight >= metrics.iconSize &&
    typeof metrics.fontFamily === 'string' && metrics.fontFamily.length > 0 && metrics.fontFamily.length <= 256
}

/** One serial, bounded pipeline per renderer; injectable for deterministic cache tests. */
export function createExplorerAppearanceCache (invoke: (paths: string[]) => Promise<unknown>) {
  const metrics = shallowRef<ExplorerMetrics | undefined>()
  const source = shallowRef<'windows' | 'fallback'>('fallback')
  const icons = shallowRef(new Map<string, string | null>())
  const pending = new Set<string>()
  const requested = new Set<string>()
  let cachedBytes = 0
  let running = false
  let scheduled = false
  let unavailable = false
  let warned = false
  let revision = 0

  function request (paths: Iterable<string>): void {
    if (unavailable) {return}
    for (const path of paths) {
      if (path.length === 0 || path.length > 32767 || path.includes('\0')) {continue}
      if (!icons.value.has(path) && !requested.has(path) && pending.size < MAXIMUM_CACHED_PATHS) {pending.add(path)}
    }
    schedule()
  }

  function schedule (): void {
    if (running || scheduled || pending.size === 0 || unavailable) {return}
    scheduled = true
    queueMicrotask(() => { scheduled = false; void fetchBatch() })
  }

  async function fetchBatch (): Promise<void> {
    if (running || unavailable || pending.size === 0) {return}
    const paths = Array.from(pending).slice(0, MAXIMUM_BATCH_PATHS)
    for (const path of paths) { pending.delete(path); requested.add(path) }
    running = true
    const requestRevision = revision
    try {
      const response = await invoke(paths) as { icons?: Record<string, unknown>, metrics?: unknown, source?: unknown } | null
      if (requestRevision !== revision) {return}
      if (response === null || typeof response !== 'object' || !validMetrics(response.metrics) ||
        (response.source !== 'windows' && response.source !== 'fallback') ||
        typeof response.icons !== 'object' || response.icons === null) {throw new Error('Invalid Explorer appearance response')}
      metrics.value = response.metrics
      source.value = response.source
      const updatedIcons = new Map(icons.value)
      for (const path of paths) {
        const candidate = response.icons[path]
        const icon = typeof candidate === 'string' && candidate.length <= 256 * 1024 &&
          /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(candidate) ? candidate : null
        updatedIcons.set(path, icon)
        cachedBytes += icon?.length ?? 0
      }
      while (updatedIcons.size > MAXIMUM_CACHED_PATHS || cachedBytes > MAXIMUM_CACHED_BYTES) {
        const oldestPath = updatedIcons.keys().next().value
        if (oldestPath === undefined) {break}
        cachedBytes -= updatedIcons.get(oldestPath)?.length ?? 0
        updatedIcons.delete(oldestPath)
      }
      icons.value = updatedIcons
    } catch (error) {
      if (requestRevision === revision) {
        unavailable = true
        pending.clear()
        if (!warned) {
          warned = true
          console.warn('[HistoryTree] Windows appearance is unavailable; retaining the existing display. Restart the application after a main-process update.', error)
        }
      }
    } finally {
      running = false
      for (const path of paths) {requested.delete(path)}
      schedule()
    }
  }

  function refresh (paths: Iterable<string>): void {
    revision++
    icons.value = new Map()
    cachedBytes = 0
    pending.clear()
    requested.clear()
    unavailable = false
    request(paths)
  }

  return { metrics, source, icons, request, refresh }
}

export const explorerAppearance = createExplorerAppearanceCache(async paths => await window.ipc.invoke('application', {
  command: 'get-explorer-appearance', payload: { paths }
}))
