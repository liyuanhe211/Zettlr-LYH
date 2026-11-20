/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Split view target selection and command building
 * CVM-Role:        Utility functions
 * License:         GNU GPL v3
 *
 * Description:     Pure helpers behind the explicit split view entries of the
 *                  main window (the toolbar's split button, the View menu's
 *                  Split Editor Right / Down, and the tab context menu's
 *                  Copy to Split View / Move to Split View): choosing the pane
 *                  a tab goes to, deciding whether moving it is possible, and
 *                  building the documents-provider command that performs the
 *                  action. The split direction mapping mirrors the edge
 *                  dropzones of EditorPane.vue. This module imports nothing at
 *                  runtime, so that it stays unit-testable outside of a
 *                  renderer process.
 *
 * END HEADER
 */

import type { DocumentManagerIPCAPI } from 'source/app/service-providers/documents'
import type { BranchNodeJSON, LeafNodeJSON } from 'source/types/common/documents'

/** Extracts panes from an authoritative documents-provider snapshot. */
export function splitEditorPanes (tree: BranchNodeJSON|LeafNodeJSON): LeafNodeJSON[] {
  return tree.type === 'leaf' ? [tree] : tree.nodes.flatMap(splitEditorPanes)
}

/**
 * Builds the right-toggle merge in two phases: preserve every tab first, then
 * remove redundant panes. No close-file command is used, so shared document
 * contents (including unsaved edits) remain loaded. The first pane, its tab
 * order, active file and pins are retained regardless of focus. Additional
 * tabs stay unpinned here because the tab manager groups pinned tabs first;
 * their original pins belong to the saved split and return when it reopens.
 */
export function buildSplitEditorToggleCommands (windowId: string, panes: LeafNodeJSON[], _focusedLeafId: string|undefined): DocumentManagerIPCAPI[] {
  const target = panes[0]
  if (target === undefined) {
    return []
  }
  if (panes.length === 1) {
    return target.activeFile === null ? [] : [buildSplitEditorCommand(windowId, target.id, target.activeFile.path, 'right')]
  }

  const commands: DocumentManagerIPCAPI[] = []
  const retainedPaths = new Set(target.openFiles.map(file => file.path))
  for (const pane of panes) {
    for (const file of pane.openFiles) {
      if (!retainedPaths.has(file.path)) {
        commands.push({ command: 'open-file', payload: { windowId, leafId: target.id, path: file.path, newTab: true } })
        retainedPaths.add(file.path)
      }
    }
  }
  commands.push({ command: 'sort-open-files', payload: { windowId, leafId: target.id, newOrder: [...retainedPaths] } })
  const activePath = target.activeFile?.path ?? retainedPaths.values().next().value
  if (activePath !== undefined) {
    commands.push({ command: 'open-file', payload: { windowId, leafId: target.id, path: activePath, newTab: true } })
  }
  for (const pane of panes.slice(1)) {
    commands.push({ command: 'close-leaf', payload: { windowId, leafId: pane.id } })
  }
  commands.push({ command: 'focus-leaf', payload: { windowId, leafId: target.id } })
  return commands
}

/**
 * Serializes toolbar/menu operations, using a fresh main-process snapshot on
 * each accepted click. Repeated clicks while the operation is pending are
 * ignored. The lock includes renderer layout confirmation and always releases
 * on failure. Failed opens stop before any source pane can be closed.
 */
export function createSplitEditorOperation<PaneState = unknown> (options: {
  windowId: string
  readPanes: () => Promise<LeafNodeJSON[]>
  focusedLeafId: () => string|undefined
  invoke: (command: DocumentManagerIPCAPI) => Promise<unknown>
  confirmLayout: (leafIds: string[]) => Promise<void>
  /** False means missing; an unknown or failed check must reject instead. */
  fileExists?: (path: string) => Promise<boolean>
  /** Captures renderer-owned reading state before a source pane disappears. */
  capturePaneState?: (pane: LeafNodeJSON) => PaneState
  /** Runs on an empty, confirmed pane before any of its files are opened. */
  restorePaneState?: (state: PaneState, leafId: string) => void|Promise<void>
}): (side: SplitSide) => Promise<void> {
  let operationPending = false
  let savedPanes: Array<{ pane: LeafNodeJSON, state: PaneState|undefined }>|undefined
  let keepPreviousSnapshot = false

  const invoke = async (command: DocumentManagerIPCAPI): Promise<void> => {
    const result = await options.invoke(command)
    if (result === false || (command.command === 'open-file' && result !== true)) {
      throw new Error('Could not preserve a split editor tab; merge stopped.')
    }
  }

  const confirmPanes = async (expectedCount: number): Promise<LeafNodeJSON[]> => {
    const updatedPanes = await options.readPanes()
    if (updatedPanes.length !== expectedCount) {
      throw new Error('Split editor layout did not update as expected.')
    }
    await options.confirmLayout(updatedPanes.map(pane => pane.id))
    return updatedPanes
  }

  return async side => {
    if (operationPending) {
      return
    }
    operationPending = true
    let batchToken: string|undefined
    let succeeded = false
    let operationFailed = false
    let retainedPaneOnFailure: LeafNodeJSON|undefined
    let focusedLeafOnFailure: string|undefined
    try {
      const token = await options.invoke({ command: 'tab-limit-batch', payload: { windowId: options.windowId, action: 'begin' } })
      if (typeof token !== 'string' || token.length === 0) {
        throw new Error('Could not pause the open tab limit for the split editor operation.')
      }
      batchToken = token
      const panes = await options.readPanes()
      const focusedLeafId = options.focusedLeafId()
      const target = panes.find(pane => pane.id === focusedLeafId) ?? panes[0]
      if (side === 'right' && panes.length === 1 && savedPanes !== undefined) {
        // Check every path before changing the layout. Missing files are the
        // only omissions; permission, transport and other errors stop recovery.
        const availability = new Map<string, boolean>()
        for (const saved of savedPanes) {
          for (const file of saved.pane.openFiles) {
            if (!availability.has(file.path)) {
              availability.set(file.path, options.fileExists === undefined || await options.fileExists(file.path))
            }
          }
        }
        const restorable = savedPanes.map(saved => ({
          ...saved,
          files: saved.pane.openFiles.filter(file => availability.get(file.path) === true)
        })).filter(saved => saved.files.length > 0 || saved.pane.openFiles.length === 0)
        if (restorable.length === 0) {
          succeeded = true
          return // All saved files were deleted. Keep the current single pane.
        }

        try {
          let currentPanes = panes
          let originLeaf = panes[0].id
          for (const saved of restorable) {
            const previousIds = new Set(currentPanes.map(pane => pane.id))
            // An empty split lets the renderer seed the original reading state
            // before mounting the first editor, and copies no unwanted tab.
            await invoke({ command: 'split-leaf', payload: {
              originWindow: options.windowId, originLeaf, ...splitPlacement('right')
            } })
            currentPanes = await confirmPanes(currentPanes.length + 1)
            const created = currentPanes.filter(pane => !previousIds.has(pane.id))
            if (created.length !== 1) {
              throw new Error('Could not identify the restored split editor pane.')
            }
            const leafId = created[0].id
            if (saved.state !== undefined) {
              await options.restorePaneState?.(saved.state, leafId)
            }
            for (const file of saved.files) {
              await invoke({ command: 'open-file', payload: {
                windowId: options.windowId, leafId, path: file.path, newTab: true
              } })
              if (file.pinned) {
                await invoke({ command: 'set-pinned', payload: {
                  windowId: options.windowId, leafId, path: file.path, pinned: true
                } })
              }
            }
            await invoke({ command: 'sort-open-files', payload: {
              windowId: options.windowId, leafId, newOrder: saved.files.map(file => file.path)
            } })
            const activePath = saved.files.find(file => file.path === saved.pane.activeFile?.path)?.path ?? saved.files[0]?.path
            if (activePath !== undefined) {
              await invoke({ command: 'open-file', payload: { windowId: options.windowId, leafId, path: activePath, newTab: true } })
            }
            const restored = (await options.readPanes()).find(pane => pane.id === leafId)
            if (restored === undefined || restored.openFiles.length !== saved.files.length || !restored.openFiles.every((file, index) => file.path === saved.files[index].path && file.pinned === saved.files[index].pinned) || restored.activeFile?.path !== activePath) {
              throw new Error('Split editor tabs did not restore as expected; the saved split was kept.')
            }
            originLeaf = leafId
          }
          // Opening tabs only activates their own pane; the left pane retains
          // its merged tabs and active document throughout recovery.
          await invoke({ command: 'focus-leaf', payload: { windowId: options.windowId, leafId: panes[0].id } })
          await confirmPanes(panes.length + restorable.length)
          keepPreviousSnapshot = false
          succeeded = true
        } catch (error) {
          // Keep a partially restored layout visible and all source tabs safe.
          // Closing it again must not replace the complete saved snapshot.
          keepPreviousSnapshot = true
          throw error
        }
        return
      }

      const closing = side === 'right' && panes.length > 1
      retainedPaneOnFailure = closing ? panes[0] : undefined
      focusedLeafOnFailure = focusedLeafId
      const pendingSnapshot = closing ? panes.slice(1).map(pane => ({
        pane: { ...pane, openFiles: pane.openFiles.map(file => ({ ...file })), activeFile: pane.activeFile === null ? null : { ...pane.activeFile } },
        state: options.capturePaneState?.(pane)
      })) : undefined
      const commands = side === 'right'
        ? buildSplitEditorToggleCommands(options.windowId, panes, focusedLeafId)
        : target?.activeFile != null ? [buildSplitEditorCommand(options.windowId, target.id, target.activeFile.path, side)] : []
      let checkedSources = false
      for (const command of commands) {
        if (command.command === 'close-leaf' && !checkedSources) {
          // No source can disappear until all expected tabs are present in the
          // retained pane, in the exact append order. Also reject tabs added
          // to a source pane while the asynchronous merge was running.
          const current = await options.readPanes()
          const expectedPaths = [...new Set(panes.flatMap(pane => pane.openFiles.map(file => file.path)))]
          const retained = current.find(pane => pane.id === panes[0].id)
          const sourceUnchanged = panes.slice(1).every(pane => {
            const source = current.find(candidate => candidate.id === pane.id)
            return source !== undefined && source.openFiles.length === pane.openFiles.length && source.openFiles.every((file, index) => file.path === pane.openFiles[index].path)
          })
          if (current.length !== panes.length || !sourceUnchanged || retained?.openFiles.length !== expectedPaths.length || !retained.openFiles.every((file, index) => file.path === expectedPaths[index])) {
            throw new Error('Split editor tabs changed during the merge; source panes were kept.')
          }
          checkedSources = true
        }
        await invoke(command)
      }
      if (commands.length > 0) {
        await confirmPanes(closing ? 1 : panes.length + 1)
        if (pendingSnapshot !== undefined) {
          if (!keepPreviousSnapshot) {
            savedPanes = pendingSnapshot
          }
          keepPreviousSnapshot = false
        }
      }
      succeeded = true
    } catch (error) {
      operationFailed = true
      if (retainedPaneOnFailure?.activeFile != null) {
        try {
          await invoke({ command: 'open-file', payload: {
            windowId: options.windowId, leafId: retainedPaneOnFailure.id,
            path: retainedPaneOnFailure.activeFile.path, newTab: true
          } })
          if (focusedLeafOnFailure !== undefined) {
            await invoke({ command: 'focus-leaf', payload: { windowId: options.windowId, leafId: focusedLeafOnFailure } })
          }
        } catch (restoreError) {
          console.error('Could not restore the active document after a failed split editor merge.', restoreError)
        }
      }
      throw error
    } finally {
      try {
        if (batchToken !== undefined) {
          try {
            const released = await options.invoke({ command: 'tab-limit-batch', payload: {
              windowId: options.windowId, action: 'end', token: batchToken, succeeded
            } })
            if (released !== true) { throw new Error('Could not resume the open tab limit after the split editor operation.') }
          } catch (error) {
            if (!operationFailed) { throw error }
            console.error('Could not release the open tab limit batch after a failed split editor operation.', error)
          }
        }
      } finally { operationPending = false }
    }
  }
}

/**
 * Where a tab goes when it is copied or moved to the split view: into a pane
 * that is newly split off the current one, or into an existing pane.
 */
export type SplitViewTarget = { kind: 'new-split' } | { kind: 'existing', leafId: string }

/**
 * The side of the current pane on which a new split appears.
 */
export type SplitSide = 'right'|'down'

export interface SplitViewTargetInput {
  /** The IDs of all editor panes of the window, in window order */
  leafIds: string[]
  /** The pane that holds the tab */
  currentLeafId: string
  /** How many tabs the current pane holds */
  currentTabCount: number
  /** Whether the tab is pinned */
  tabPinned: boolean
}

export interface SplitViewTargetResult {
  target: SplitViewTarget
  /** Whether "Move to Split View" is available for the tab */
  moveEnabled: boolean
}

/**
 * Chooses the pane a tab is copied or moved to. With only one pane in the
 * window, a new split is created to the right of it. Otherwise the tab goes
 * into the next pane in window order; the last pane wraps around to the first.
 *
 * Moving is unavailable for pinned tabs (like the existing Move submenu), and
 * when the window has a single pane that holds only this tab, because the
 * move would close the emptied pane and leave everything as it was.
 *
 * @param   {SplitViewTargetInput}   input  The window's panes and the tab
 *
 * @return  {SplitViewTargetResult}         The target and the move availability
 */
export function resolveSplitViewTarget (input: SplitViewTargetInput): SplitViewTargetResult {
  const { leafIds, currentLeafId, currentTabCount, tabPinned } = input
  const otherLeafIds = leafIds.filter(leafId => leafId !== currentLeafId)

  let target: SplitViewTarget
  if (otherLeafIds.length === 0) {
    target = { kind: 'new-split' }
  } else {
    const currentIndex = leafIds.indexOf(currentLeafId)
    const nextLeafId = currentIndex < 0
      ? otherLeafIds[0]
      : leafIds[(currentIndex + 1) % leafIds.length]
    target = { kind: 'existing', leafId: nextLeafId }
  }

  const onlyTabOfOnlyPane = target.kind === 'new-split' && currentTabCount <= 1
  return { target, moveEnabled: !tabPinned && !onlyTabOfOnlyPane }
}

/**
 * Maps a split side onto the split-leaf command's direction and insertion,
 * exactly as the edge dropzones of EditorPane.vue do it (the right edge splits
 * horizontally and inserts after, the bottom edge splits vertically and
 * inserts after).
 *
 * @param   {SplitSide}  side  The side the new pane appears on
 *
 * @return  {{ direction: 'horizontal'|'vertical', insertion: 'before'|'after' }}
 */
export function splitPlacement (side: SplitSide): { direction: 'horizontal'|'vertical', insertion: 'before'|'after' } {
  return {
    direction: side === 'right' ? 'horizontal' : 'vertical',
    insertion: 'after'
  }
}

/**
 * Builds the command that splits the given pane and opens a second view of a
 * file in the new pane (the toolbar button and the View menu items).
 *
 * @param   {string}     windowId  The window
 * @param   {string}     leafId    The pane to split
 * @param   {string}     filePath  The file to show in the new pane
 * @param   {SplitSide}  side      Where the new pane appears
 *
 * @return  {DocumentManagerIPCAPI}  The documents-provider command
 */
export function buildSplitEditorCommand (windowId: string, leafId: string, filePath: string, side: SplitSide): DocumentManagerIPCAPI {
  const { direction, insertion } = splitPlacement(side)
  return {
    command: 'split-leaf',
    payload: {
      originWindow: windowId,
      originLeaf: leafId,
      direction,
      insertion,
      path: filePath,
      copy: true
    }
  }
}

export interface SplitViewTabActionInput extends SplitViewTargetInput {
  /** Copy keeps the original tab; move closes it */
  action: 'copy'|'move'
  windowId: string
  filePath: string
}

/**
 * Builds the command behind the tab context menu's "Copy to Split View" and
 * "Move to Split View". Returns undefined when the move is unavailable.
 *
 * - Copy into a new split: split-leaf with the path and copy set.
 * - Copy into an existing pane: open-file in a new tab of that pane (an
 *   already open tab of the file is merely activated).
 * - Move into a new split: split-leaf with the path (the same as dropping the
 *   tab onto the right edge of its own pane).
 * - Move into an existing pane: move-file.
 *
 * @param   {SplitViewTabActionInput}  input  The tab, its pane and the action
 *
 * @return  {DocumentManagerIPCAPI|undefined}  The documents-provider command
 */
export function buildSplitViewTabCommand (input: SplitViewTabActionInput): DocumentManagerIPCAPI|undefined {
  const { action, windowId, currentLeafId, filePath } = input
  const { target, moveEnabled } = resolveSplitViewTarget(input)

  if (action === 'move' && !moveEnabled) {
    return undefined
  }

  if (target.kind === 'new-split') {
    if (action === 'copy') {
      return buildSplitEditorCommand(windowId, currentLeafId, filePath, 'right')
    }

    const { direction, insertion } = splitPlacement('right')
    return {
      command: 'split-leaf',
      payload: {
        originWindow: windowId,
        originLeaf: currentLeafId,
        direction,
        insertion,
        path: filePath
      }
    }
  }

  if (action === 'copy') {
    return {
      command: 'open-file',
      payload: { windowId, leafId: target.leafId, path: filePath, newTab: true }
    }
  }

  return {
    command: 'move-file',
    payload: {
      originWindow: windowId,
      targetWindow: windowId,
      originLeaf: currentLeafId,
      targetLeaf: target.leafId,
      path: filePath
    }
  }
}
