/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        useScratchNotesOnDisk, SCRATCH_NOTES_RECHECK_DELAY
 * CVM-Role:        Utility function
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Keeps the list of the scratch notes in the scratch folder on
 *                  disk (the list-scratch-notes command of the main process),
 *                  which Unsaved Files shows next to the scratch notes open as
 *                  tabs (R144). The list is fetched when the component that
 *                  uses it is set up, whenever the key given by that component
 *                  changes (it stands for the set of open tabs and the scratch
 *                  folder), once more shortly afterwards, since a scratch note
 *                  is written to disk a moment after its last edit, and when
 *                  the window gets the focus again, which picks up scratch
 *                  notes that were created, renamed or deleted elsewhere. It
 *                  must be called from a component's setup function.
 *
 * END HEADER
 */

import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { parseScratchNotesOnDisk, type ScratchNoteOnDisk } from './unsaved-tab-paths'

/**
 * Milliseconds after a change of the key until the list is fetched a second
 * time. A scratch note is written to disk one second after its last edit, so
 * a note edited just before its tab went away has its content on disk by now.
 */
export const SCRATCH_NOTES_RECHECK_DELAY = 1500

/**
 * Provides the scratch notes in the scratch folder on disk.
 *
 * @param   {() => string}                 refreshKey  Returns a string that changes whenever the list may have changed
 *
 * @return  {Ref<ScratchNoteOnDisk[]>}                 The scratch notes on disk, empty until the first answer
 */
export function useScratchNotesOnDisk (refreshKey: () => string): Ref<ScratchNoteOnDisk[]> {
  const notes = ref<ScratchNoteOnDisk[]>([])
  let latestRequest = 0
  let recheckTimer: ReturnType<typeof setTimeout>|undefined
  let unmounted = false

  async function refresh (): Promise<void> {
    const request = ++latestRequest
    try {
      const result: unknown = await window.ipc.invoke('application', { command: 'list-scratch-notes' })
      if (unmounted || request !== latestRequest) {
        return
      }

      const parsed = parseScratchNotesOnDisk(result)
      if (JSON.stringify(parsed) !== JSON.stringify(notes.value)) {
        notes.value = parsed
      }
    } catch (error) {
      console.error(error)
    }
  }

  function refreshAndReport (): void {
    refresh().catch(error => console.error(error))
  }

  function scheduleRecheck (): void {
    if (recheckTimer !== undefined) {
      clearTimeout(recheckTimer)
    }

    recheckTimer = setTimeout(() => {
      recheckTimer = undefined
      refreshAndReport()
    }, SCRATCH_NOTES_RECHECK_DELAY)
  }

  watch(refreshKey, () => {
    refreshAndReport()
    scheduleRecheck()
  }, { immediate: true })

  onMounted(() => { window.addEventListener('focus', refreshAndReport) })

  onBeforeUnmount(() => {
    unmounted = true
    window.removeEventListener('focus', refreshAndReport)
    if (recheckTimer !== undefined) {
      clearTimeout(recheckTimer)
      recheckTimer = undefined
    }
  })

  return notes
}
