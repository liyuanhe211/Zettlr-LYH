/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Reading position memory of the PDF viewer
 * CVM-Role:        Utility function
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH R59 (contract C5, section "阅读位置记忆"):
 *                  remembers, per absolute file path, the last page and zoom
 *                  of every PDF opened in the viewer. The records are kept as
 *                  one JSON array under PDF_VIEW_STATE_STORAGE_KEY, the most
 *                  recently used file first, and at most
 *                  PDF_VIEW_STATE_MAX_ENTRIES files are kept. The functions
 *                  receive the storage as an argument (in the viewer:
 *                  window.localStorage) and import neither Vue nor pdf.js, so
 *                  that mocha can test them directly. Broken or unreadable
 *                  storage contents never throw; they fall back to the
 *                  default state.
 *
 * END HEADER
 */

import {
  PDF_VIEW_STATE_MAX_ENTRIES,
  PDF_VIEW_STATE_STORAGE_KEY,
  PDF_VIEWER_DEFAULT_ZOOM,
  type PdfViewState
} from 'source/types/common/pdf-viewer'

/**
 * Smallest zoom pdf.js accepts (MIN_SCALE in pdfjs-dist/web/pdf_viewer.mjs)
 */
export const PDF_VIEWER_MIN_ZOOM = 0.1

/**
 * Largest zoom pdf.js accepts (MAX_SCALE in pdfjs-dist/web/pdf_viewer.mjs)
 */
export const PDF_VIEWER_MAX_ZOOM = 25

/**
 * The part of the Web Storage interface these functions use; localStorage
 * satisfies it, tests pass an in-memory stand-in
 */
export type PdfViewStateStorage = Pick<Storage, 'getItem'|'setItem'>

/**
 * One stored record: the view state of the file at `path`
 */
interface PdfViewStateEntry extends PdfViewState {
  path: string
}

/**
 * The view state of a file that was never opened before: page 1 at the
 * default zoom
 *
 * @return  {PdfViewState}  A new default state object
 */
export function defaultPdfViewState (): PdfViewState {
  return { page: 1, zoom: PDF_VIEWER_DEFAULT_ZOOM }
}

/**
 * Whether a value is a usable view state: a page number that is a positive
 * integer and a finite zoom within the range pdf.js accepts
 *
 * @param   {unknown}  value  Any value, e.g. a parsed storage record
 *
 * @return  {boolean}         True if the value can be used as is
 */
export function isValidPdfViewState (value: unknown): value is PdfViewState {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const { page, zoom } = value as Record<string, unknown>
  return typeof page === 'number' && Number.isInteger(page) && page >= 1 &&
    typeof zoom === 'number' && Number.isFinite(zoom) &&
    zoom >= PDF_VIEWER_MIN_ZOOM && zoom <= PDF_VIEWER_MAX_ZOOM
}

/**
 * Reads the stored records. Anything that cannot be read (no value, invalid
 * JSON, not an array, a storage that throws) yields an empty list; single
 * records with a missing path or an invalid state are dropped, and of several
 * records for the same path only the first (most recent) one is kept.
 *
 * @param   {PdfViewStateStorage}  storage  The storage to read from
 *
 * @return  {PdfViewStateEntry[]}           The valid records, most recent first
 */
function readEntries (storage: PdfViewStateStorage): PdfViewStateEntry[] {
  let parsed: unknown
  try {
    const raw = storage.getItem(PDF_VIEW_STATE_STORAGE_KEY)
    if (raw === null) {
      return []
    }
    parsed = JSON.parse(raw)
  } catch {
    return []
  }

  if (!Array.isArray(parsed)) {
    return []
  }

  const entries: PdfViewStateEntry[] = []
  const seenPaths = new Set<string>()
  for (const record of parsed as unknown[]) {
    if (!isValidPdfViewState(record)) {
      continue
    }

    const path = (record as unknown as Record<string, unknown>).path
    if (typeof path !== 'string' || path === '' || seenPaths.has(path)) {
      continue
    }

    seenPaths.add(path)
    entries.push({ path, page: record.page, zoom: record.zoom })
  }

  return entries
}

/**
 * Returns the remembered page and zoom of a file, or the default state if the
 * file is not remembered or the storage contents are unusable. Reading does
 * not change the order of the records.
 *
 * @param   {PdfViewStateStorage}  storage   The storage to read from
 * @param   {string}               filePath  The absolute path of the PDF
 *
 * @return  {PdfViewState}                   A new state object
 */
export function readPdfViewState (storage: PdfViewStateStorage, filePath: string): PdfViewState {
  const entry = readEntries(storage).find(candidate => candidate.path === filePath)
  if (entry === undefined) {
    return defaultPdfViewState()
  }

  return { page: entry.page, zoom: entry.zoom }
}

/**
 * Remembers the page and zoom of a file: its record moves to the front, and
 * the least recently used records beyond PDF_VIEW_STATE_MAX_ENTRIES are
 * dropped. An invalid state is not stored. Unusable storage contents are
 * replaced; a storage that throws (e.g. because it is full) is ignored.
 *
 * @param   {PdfViewStateStorage}  storage   The storage to write to
 * @param   {string}               filePath  The absolute path of the PDF
 * @param   {PdfViewState}         state     The state to remember
 */
export function writePdfViewState (storage: PdfViewStateStorage, filePath: string, state: PdfViewState): void {
  if (filePath === '' || !isValidPdfViewState(state)) {
    return
  }

  const entries = readEntries(storage).filter(entry => entry.path !== filePath)
  entries.unshift({ path: filePath, page: state.page, zoom: state.zoom })

  try {
    storage.setItem(PDF_VIEW_STATE_STORAGE_KEY, JSON.stringify(entries.slice(0, PDF_VIEW_STATE_MAX_ENTRIES)))
  } catch {
    // Storage full or unavailable: the position is simply not remembered
  }
}
