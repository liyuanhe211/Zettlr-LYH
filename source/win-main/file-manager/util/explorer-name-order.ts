import { shallowRef } from 'vue'

const naturalNameOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const MAXIMUM_CACHED_NAMES = 20000
const MAXIMUM_CACHED_CHARACTERS = 1000000
const knownNames = new Set<string>()
let cachedCharacters = 0
// A snapshot is published only when it covers every registered name. Adding
// names switches the whole tree to natural ordering until that batch resolves.
const nativeNameRanks = shallowRef<Map<string, number> | undefined>(undefined)
let requestScheduled = false
let requestInFlight = false
let nativeOrderingUnavailable = false
let revision = 0

/** Register a complete group before comparing it; registration is not done in computed getters. */
export function requestExplorerNameOrder (names: Iterable<string>): void {
  if (nativeOrderingUnavailable) {
    return
  }

  let addedNames = false
  for (const name of names) {
    if (!knownNames.has(name)) {
      knownNames.add(name)
      cachedCharacters += name.length
      addedNames = true
    }
    if (knownNames.size > MAXIMUM_CACHED_NAMES || cachedCharacters > MAXIMUM_CACHED_CHARACTERS) {
      // Bound the window-wide cache even in sessions visiting very many folders.
      // Keep one consistent natural order until the next renderer lifetime.
      knownNames.clear()
      cachedCharacters = 0
      nativeOrderingUnavailable = true
      nativeNameRanks.value = undefined
      revision++
      console.warn('[HistoryTree] Name cache exceeded 20000 names or 1000000 characters; using natural name ordering.')
      return
    }
  }

  if (addedNames) {
    revision++
    nativeNameRanks.value = undefined
    scheduleNameOrderRequest()
  }
}

/** Reads the reactive, complete rank snapshot so dependent Vue computations refresh. */
export function compareExplorerNames (first: string, second: string): number {
  const ranks = nativeNameRanks.value
  if (ranks !== undefined) {
    const firstRank = ranks.get(first)
    const secondRank = ranks.get(second)
    if (firstRank !== undefined && secondRank !== undefined) {
      return firstRank - secondRank
    }
  }
  return naturalNameOrder.compare(first, second)
}

function scheduleNameOrderRequest (): void {
  if (requestScheduled || requestInFlight || nativeOrderingUnavailable) {
    return
  }
  requestScheduled = true
  queueMicrotask(() => {
    requestScheduled = false
    void fetchNameOrder()
  })
}

async function fetchNameOrder (): Promise<void> {
  if (requestInFlight || nativeOrderingUnavailable || knownNames.size === 0) {
    return
  }

  requestInFlight = true
  const requestedRevision = revision
  const names = Array.from(knownNames)
  try {
    const sortedNames: unknown = await window.ipc.invoke('application', {
      command: 'sort-explorer-names',
      payload: names
    })
    if (nativeOrderingUnavailable) {
      return
    }
    if (!Array.isArray(sortedNames) || sortedNames.length !== names.length ||
      new Set(sortedNames).size !== names.length ||
      !sortedNames.every(name => typeof name === 'string' && knownNames.has(name))) {
      throw new Error('Invalid Explorer name ordering response')
    }
    if (requestedRevision === revision && !nativeOrderingUnavailable) {
      nativeNameRanks.value = new Map(sortedNames.map((name, index) => [ name, index ]))
    }
  } catch (error) {
    nativeOrderingUnavailable = true
    knownNames.clear()
    cachedCharacters = 0
    nativeNameRanks.value = undefined
    console.warn('[HistoryTree] Explorer name ordering is unavailable; using natural name ordering.', error)
  } finally {
    requestInFlight = false
    if (requestedRevision !== revision && !nativeOrderingUnavailable) {
      scheduleNameOrderRequest()
    }
  }
}
