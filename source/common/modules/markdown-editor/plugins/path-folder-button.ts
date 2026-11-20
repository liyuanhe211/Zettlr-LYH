/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Path folder button
 * CVM-Role:        View
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Shows a folder button after every path in the visible part
 *                  of the document that exists on disk (R100, spec C12 parts 3
 *                  and 4). Main checks the paths in the background with the
 *                  `check-path-kinds` command; the results are kept in a cache
 *                  shared by all editors of the window. Clicking the button
 *                  asks main to open the folder, or to show the file in its
 *                  folder (`reveal-path`). The button is a view decoration
 *                  only: it never enters the document, the clipboard or any
 *                  export, and clicking it leaves selection and focus alone.
 *                  The button shows the colour folder icon of the Files tree,
 *                  asked from main once per window (`get-explorer-appearance`,
 *                  spec C12 part 7), and the Clarity folder icon until then or
 *                  when that icon is unavailable.
 *
 * END HEADER
 */

import { syntaxTree } from '@codemirror/language'
import { StateEffect, type Extension, type Range } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'
import { findPathCandidates, type PathCandidate } from '../util/path-candidates'

/**
 * What main found at a path (spec C12 2.1)
 */
export type PathKind = 'file' | 'directory' | 'missing' | 'unknown'

interface PathKindRecord {
  kind: PathKind
  /** When the kind was found; -Infinity marks the record as expired */
  checkedAt: number
}

/**
 * A request on the `application` channel
 */
interface ApplicationMessage {
  command: string
  payload: unknown
}

type ApplicationInvoke = (message: ApplicationMessage) => Promise<unknown>

/**
 * The timing of the checks; replaceable by tests only
 */
export interface PathCheckTiming {
  /** How long the view must stay without new triggers before a request */
  mergeDelay: number
  /** The current time in milliseconds */
  clock: () => number
  /** Starts a timer, returns a handle for `cancel` */
  schedule: (callback: () => void, delay: number) => unknown
  /** Stops a timer started with `schedule` */
  cancel: (handle: unknown) => void
}

export const PATH_CHECK_MERGE_DELAY = 300
export const PATH_CHECK_BATCH_SIZE = 256
export const PATH_KIND_LIFETIME = 30000
export const FOLDER_BUTTON_TITLE = 'Open folder in File Explorer'
export const FILE_BUTTON_TITLE = 'Show in File Explorer'

function defaultTiming (): PathCheckTiming {
  return {
    mergeDelay: PATH_CHECK_MERGE_DELAY,
    clock: () => Date.now(),
    schedule: (callback, delay) => setTimeout(callback, delay),
    cancel: handle => { clearTimeout(handle as ReturnType<typeof setTimeout>) }
  }
}

/** The kinds found so far, by cache key, shared by all editors of the window */
const pathKindCache = new Map<string, PathKindRecord>()
/** Paths waiting for the merge timer, by cache key */
const pendingPaths = new Map<string, string>()
/** Cache keys whose check has been sent and not yet answered */
const inFlightKeys = new Set<string>()
/** The editor views showing buttons */
const registeredViews = new Set<EditorView>()

let timing = defaultTiming()
let mergeTimer: { handle: unknown }|undefined
/** Answers arriving after a reset belong to an earlier generation */
let cacheGeneration = 0

/**
 * The folder icon of the Files tree, shared by all editors of the window and
 * requested once (spec C12 part 7.1): not requested yet, requested, obtained
 * as a PNG data URL, or fallen back to the Clarity icon for good.
 */
type FolderIconState =
  | { status: 'unrequested' }
  | { status: 'requesting' }
  | { status: 'obtained', url: string }
  | { status: 'fallback' }

/** The same check as the Files tree applies (file-manager/util/explorer-appearance.ts) */
const FOLDER_ICON_PATTERN = /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/
const FOLDER_ICON_MAXIMUM_LENGTH = 256 * 1024

let folderIconState: FolderIconState = { status: 'unrequested' }
/** Icon answers arriving after a reset belong to an earlier generation */
let folderIconGeneration = 0

/**
 * Tells the views that the cache has new results
 */
const pathKindsChangedEffect = StateEffect.define<null>()

/**
 * Returns a function calling main on the `application` channel, or undefined
 * outside Electron, where neither requests nor buttons happen.
 */
function applicationInvoke (): ApplicationInvoke|undefined {
  if (typeof window === 'undefined') {
    return undefined
  }
  const ipc = (window as { ipc?: { invoke?: (channel: string, ...args: unknown[]) => Promise<unknown> } }).ipc
  if (ipc === undefined || typeof ipc.invoke !== 'function') {
    return undefined
  }
  const invoke = ipc.invoke
  return async message => await invoke.call(ipc, 'application', message)
}

function isPathKind (value: unknown): value is PathKind {
  return value === 'file' || value === 'directory' || value === 'missing' || value === 'unknown'
}

/**
 * Whether a cache key needs a (new) check: no record, or an expired one
 */
function needsCheck (key: string, now: number): boolean {
  const record = pathKindCache.get(key)
  return record === undefined || record.checkedAt < now - PATH_KIND_LIFETIME
}

/**
 * Tells every registered view to rebuild its buttons from the cache
 */
function notifyViews (): void {
  for (const view of registeredViews) {
    view.dispatch({ effects: pathKindsChangedEffect.of(null) })
  }
}

/**
 * Queues the candidates that need a check and (re)starts the merge timer, so
 * that the request goes out once the views stay without triggers for the
 * merge delay. Keys already being checked are not queued again.
 *
 * @param  {PathCandidate[]}  candidates  The visible candidates of a view
 */
function schedulePathChecks (candidates: readonly PathCandidate[]): void {
  if (applicationInvoke() === undefined) {
    return
  }

  const now = timing.clock()
  let queued = false
  for (const candidate of candidates) {
    if (inFlightKeys.has(candidate.key) || !needsCheck(candidate.key, now)) {
      continue
    }
    if (!pendingPaths.has(candidate.key)) {
      pendingPaths.set(candidate.key, candidate.path)
    }
    queued = true
  }

  if (!queued) {
    return
  }

  if (mergeTimer !== undefined) {
    timing.cancel(mergeTimer.handle)
  }
  const timer: { handle: unknown } = { handle: undefined }
  timer.handle = timing.schedule(() => {
    if (mergeTimer === timer) {
      mergeTimer = undefined
      void sendPendingChecks()
    }
  }, timing.mergeDelay)
  mergeTimer = timer
}

/**
 * Sends the queued paths to main in batches of at most 256, one batch after
 * the other.
 */
async function sendPendingChecks (): Promise<void> {
  const invoke = applicationInvoke()
  const generation = cacheGeneration
  const now = timing.clock()

  const batch: Array<[ string, string ]> = []
  for (const [ key, path ] of pendingPaths) {
    if (!inFlightKeys.has(key) && needsCheck(key, now)) {
      batch.push([ key, path ])
      inFlightKeys.add(key)
    }
  }
  pendingPaths.clear()

  if (invoke === undefined) {
    for (const [key] of batch) {
      inFlightKeys.delete(key)
    }
    return
  }

  for (let start = 0; start < batch.length; start += PATH_CHECK_BATCH_SIZE) {
    if (generation !== cacheGeneration) {
      return
    }
    await checkPathBatch(invoke, batch.slice(start, start + PATH_CHECK_BATCH_SIZE), generation)
  }
}

/**
 * Reads the `kinds` object of a `check-path-kinds` response
 */
function responseKinds (response: unknown): Record<string, unknown>|undefined {
  if (typeof response !== 'object' || response === null || !('kinds' in response)) {
    return undefined
  }
  const kinds: unknown = response.kinds
  return typeof kinds === 'object' && kinds !== null ? kinds as Record<string, unknown> : undefined
}

/**
 * Checks one batch of paths and writes the results into the cache. A path
 * missing from a valid response counts as `unknown`; when the request fails
 * as a whole, existing records keep their kind and only count as checked.
 */
async function checkPathBatch (invoke: ApplicationInvoke, batch: Array<[ string, string ]>, generation: number): Promise<void> {
  let kinds: Record<string, unknown>|undefined
  try {
    kinds = responseKinds(await invoke({ command: 'check-path-kinds', payload: { paths: batch.map(([ , path ]) => path) } }))
  } catch {
    kinds = undefined
  }

  if (generation !== cacheGeneration) {
    return
  }

  const checkedAt = timing.clock()
  for (const [ key, path ] of batch) {
    inFlightKeys.delete(key)
    let kind: PathKind
    if (kinds !== undefined) {
      const answer = kinds[path]
      kind = isPathKind(answer) ? answer : 'unknown'
    } else {
      kind = pathKindCache.get(key)?.kind ?? 'unknown'
    }
    pathKindCache.set(key, { kind, checkedAt })
  }

  notifyViews()

  if (folderIconState.status === 'unrequested') {
    const iconPath = folderIconRequestPath(batch)
    if (iconPath !== undefined) {
      void requestFolderIcon(invoke, iconPath)
    }
  }
}

/**
 * Removes repeated and trailing separators, keeping a leading UNC `\\`
 */
function trimSeparators (path: string): string {
  const unc = path.startsWith('\\\\')
  const collapsed = path.replace(/\\+/g, '\\').replace(/\\$/, '')
  return unc ? '\\' + collapsed : collapsed
}

/**
 * Whether a path is a drive root (`C:\`) or the root of a network share
 * (`\\server\share`); main answers both with a drive icon instead of the
 * folder icon.
 */
function isRootPath (path: string): boolean {
  const trimmed = trimSeparators(path)
  return /^[A-Za-z]:$/.test(trimmed) || /^\\\\[^\\]+\\[^\\]+$/.test(trimmed)
}

/**
 * The folder containing a file path, or undefined when the path has no
 * separator after its root
 */
function parentFolder (path: string): string|undefined {
  const trimmed = trimSeparators(path)
  const separator = trimmed.lastIndexOf('\\')
  if (separator <= 1) {
    return undefined
  }
  const parent = trimmed.slice(0, separator)
  return /^[A-Za-z]:$/.test(parent) ? parent + '\\' : parent
}

/**
 * Picks the path whose icon is asked for (spec C12 7.1): the first folder of
 * the batch that is not a root; when the batch holds only files, the folder of
 * the first file whose folder is not a root.
 */
function folderIconRequestPath (batch: Array<[ string, string ]>): string|undefined {
  const files: string[] = []
  for (const [ key, path ] of batch) {
    const kind = pathKindCache.get(key)?.kind
    if (kind === 'directory' && !isRootPath(path)) {
      return path
    }
    if (kind === 'file') {
      files.push(path)
    }
  }
  for (const path of files) {
    const parent = parentFolder(path)
    if (parent !== undefined && !isRootPath(parent)) {
      return parent
    }
  }
  return undefined
}

/**
 * Reads the icon of one path from a `get-explorer-appearance` response; only
 * a Windows icon in the same format the Files tree accepts counts.
 */
function responseFolderIcon (response: unknown, path: string): string|undefined {
  if (typeof response !== 'object' || response === null) {
    return undefined
  }
  const { icons, source } = response as { icons?: unknown, source?: unknown }
  if (source !== 'windows' || typeof icons !== 'object' || icons === null) {
    return undefined
  }
  const icon: unknown = (icons as Record<string, unknown>)[path]
  if (typeof icon !== 'string' || icon.length > FOLDER_ICON_MAXIMUM_LENGTH || !FOLDER_ICON_PATTERN.test(icon)) {
    return undefined
  }
  return icon
}

/**
 * Asks main once for the folder icon of the Files tree, then lets every view
 * rebuild its buttons. Any failure falls back to the Clarity icon for good.
 */
async function requestFolderIcon (invoke: ApplicationInvoke, path: string): Promise<void> {
  folderIconState = { status: 'requesting' }
  const generation = folderIconGeneration
  let icon: string|undefined
  try {
    icon = responseFolderIcon(await invoke({ command: 'get-explorer-appearance', payload: { paths: [path] } }), path)
  } catch {
    icon = undefined
  }

  if (generation !== folderIconGeneration) {
    return
  }

  folderIconState = icon !== undefined ? { status: 'obtained', url: icon } : { status: 'fallback' }
  notifyViews()
}

/**
 * The data URL of the folder icon, or undefined while the Clarity icon shows
 */
function folderIconUrl (): string|undefined {
  return folderIconState.status === 'obtained' ? folderIconState.url : undefined
}

/**
 * Asks main to open the folder or show the file. When main finds nothing at
 * the path any more, the path is recorded as missing and its buttons vanish.
 */
async function revealPath (path: string, key: string): Promise<void> {
  const invoke = applicationInvoke()
  if (invoke === undefined) {
    return
  }

  const generation = cacheGeneration
  let response: unknown
  try {
    response = await invoke({ command: 'reveal-path', payload: { path } })
  } catch {
    return
  }

  if (generation !== cacheGeneration) {
    return
  }

  if (typeof response === 'object' && response !== null && 'result' in response && response.result === 'missing') {
    pathKindCache.set(key, { kind: 'missing', checkedAt: timing.clock() })
    notifyViews()
  }
}

/**
 * Coming back to the window expires every record and checks the visible
 * paths of all editors again; the expired records keep showing their buttons
 * until the new results arrive.
 */
function handleWindowFocus (): void {
  for (const record of pathKindCache.values()) {
    record.checkedAt = Number.NEGATIVE_INFINITY
  }
  for (const view of registeredViews) {
    view.plugin(pathFolderButtonPlugin)?.scheduleVisibleChecks()
  }
}

function registerView (view: EditorView): void {
  if (registeredViews.size === 0 && typeof window !== 'undefined') {
    window.addEventListener('focus', handleWindowFocus)
  }
  registeredViews.add(view)
}

function unregisterView (view: EditorView): void {
  registeredViews.delete(view)
  if (registeredViews.size === 0 && typeof window !== 'undefined') {
    window.removeEventListener('focus', handleWindowFocus)
  }
}

/**
 * The button after a path. It contains only the icon, no text: the folder
 * icon of the Files tree once obtained, the Clarity folder icon otherwise.
 */
class PathFolderButtonWidget extends WidgetType {
  constructor (
    readonly path: string,
    readonly key: string,
    readonly kind: 'file' | 'directory',
    /** The data URL of the folder icon; undefined shows the Clarity icon */
    readonly iconUrl: string|undefined
  ) {
    super()
  }

  eq (other: PathFolderButtonWidget): boolean {
    return other.path === this.path && other.kind === this.kind && other.iconUrl === this.iconUrl
  }

  toDOM (_view: EditorView): HTMLElement {
    const button = document.createElement('span')
    button.className = 'cm-path-folder-button'
    button.setAttribute('role', 'button')
    const title = this.kind === 'directory' ? FOLDER_BUTTON_TITLE : FILE_BUTTON_TITLE
    button.setAttribute('title', title)
    button.setAttribute('aria-label', title)

    if (this.iconUrl !== undefined) {
      const image = document.createElement('img')
      image.className = 'cm-path-folder-icon'
      image.setAttribute('src', this.iconUrl)
      image.setAttribute('alt', '')
      image.setAttribute('draggable', 'false')
      button.appendChild(image)
    } else {
      const icon = document.createElement('cds-icon')
      icon.setAttribute('shape', 'folder')
      button.appendChild(icon)
    }

    // Keeps selection, cursor and focus where they are
    button.addEventListener('mousedown', event => {
      event.preventDefault()
    })
    button.addEventListener('click', event => {
      if (event.button !== 0) {
        return
      }
      event.preventDefault()
      void revealPath(this.path, this.key)
    })

    return button
  }

  ignoreEvent (_event: Event): boolean {
    return true // The editor leaves all events on the button alone
  }
}

/**
 * Finds the visible candidates, queues their checks and shows the buttons of
 * the paths found to exist.
 */
class PathFolderButtonView {
  decorations: DecorationSet = Decoration.none
  private candidates: PathCandidate[] = []

  constructor (private readonly view: EditorView) {
    registerView(view)
    this.refresh()
  }

  update (update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
      this.refresh()
    } else if (update.transactions.some(transaction => transaction.effects.some(effect => effect.is(pathKindsChangedEffect)))) {
      this.decorations = this.buildDecorations()
    }
  }

  /**
   * Queues the checks of the current visible candidates
   */
  scheduleVisibleChecks (): void {
    schedulePathChecks(this.candidates)
  }

  destroy (): void {
    unregisterView(this.view)
  }

  private refresh (): void {
    if (applicationInvoke() === undefined) {
      this.candidates = []
      this.decorations = Decoration.none
      return
    }
    this.candidates = findPathCandidates(this.view.state, this.view.visibleRanges)
    schedulePathChecks(this.candidates)
    this.decorations = this.buildDecorations()
  }

  private buildDecorations (): DecorationSet {
    const ranges: Array<Range<Decoration>> = []
    const iconUrl = folderIconUrl()
    for (const candidate of this.candidates) {
      const kind = pathKindCache.get(candidate.key)?.kind
      if (kind === 'file' || kind === 'directory') {
        const widget = new PathFolderButtonWidget(candidate.path, candidate.key, kind, iconUrl)
        ranges.push(Decoration.widget({ widget, side: 1 }).range(candidate.at))
      }
    }
    return Decoration.set(ranges, true)
  }
}

const pathFolderButtonPlugin = ViewPlugin.fromClass(PathFolderButtonView, {
  decorations: value => value.decorations
})

const pathFolderButtonTheme = EditorView.baseTheme({
  '.cm-path-folder-button': {
    display: 'inline-block',
    width: '1em',
    height: '1em',
    lineHeight: '1em',
    marginLeft: '0.2em',
    verticalAlign: '-0.15em',
    borderRadius: '3px',
    cursor: 'pointer',
    userSelect: 'none'
  },
  '.cm-path-folder-button:hover': {
    backgroundColor: 'rgba(0, 0, 0, 0.08)'
  },
  '&dark .cm-path-folder-button:hover': {
    backgroundColor: 'rgba(255, 255, 255, 0.12)'
  },
  // The folder icon of the Files tree keeps its own colours in both themes
  '.cm-path-folder-button .cm-path-folder-icon': {
    display: 'block',
    width: '1em',
    height: '1em',
    objectFit: 'contain'
  },
  // The Clarity fallback keeps its earlier look
  '.cm-path-folder-button cds-icon': {
    display: 'block',
    width: '1em',
    height: '1em',
    color: 'currentColor',
    opacity: '0.7'
  },
  '.cm-path-folder-button:hover cds-icon': {
    opacity: '1'
  }
})

/**
 * The folder buttons after existing paths (R100, spec C12)
 */
export const pathFolderButton: Extension = [ pathFolderButtonPlugin, pathFolderButtonTheme ]

/**
 * For tests only: empties the cache and the queues, stops the merge timer,
 * drops answers still on their way and restores the default timing.
 */
export function resetPathFolderButtonForTesting (): void {
  if (mergeTimer !== undefined) {
    timing.cancel(mergeTimer.handle)
    mergeTimer = undefined
  }
  pathKindCache.clear()
  pendingPaths.clear()
  inFlightKeys.clear()
  cacheGeneration++
  timing = defaultTiming()
  resetFolderIconStateForTesting()
}

/**
 * For tests only: forgets the folder icon, so that the next check asks for it
 * again, and drops icon answers still on their way.
 */
export function resetFolderIconStateForTesting (): void {
  folderIconState = { status: 'unrequested' }
  folderIconGeneration++
}

/**
 * For tests only: replaces parts of the timing (merge delay, clock, timer
 * functions); the other parts keep their current values.
 *
 * @param  {Partial<PathCheckTiming>}  replacement  The parts to replace
 */
export function setPathCheckTimingForTesting (replacement: Partial<PathCheckTiming>): void {
  timing = { ...timing, ...replacement }
}
