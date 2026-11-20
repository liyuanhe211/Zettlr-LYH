/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Version metadata formatting
 * CVM-Role:        Utility
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH version information (R136): formats the
 *                  modification time and the byte size of one version of a
 *                  file for the dialogs that list several versions (used by
 *                  the backup restore choice, R50). A missing or invalid value
 *                  is shown as "unknown", independently for each field. The
 *                  dialog for files modified on disk that used to live here
 *                  has been replaced by the comparison view (R138). This
 *                  module is pure (no Electron imports) so it can be tested in
 *                  isolation.
 *
 * END HEADER
 */

/** Formats only valid version metadata; missing fields stay independently unknown. */
export function formatVersionTimestamp (timestamp: number|undefined, formatTime: (timestamp: number) => string): string {
  return typeof timestamp === 'number' && Number.isFinite(timestamp) && !Number.isNaN(new Date(timestamp).getTime())
    ? formatTime(timestamp)
    : 'unknown'
}

/** Zero bytes is a known size, including for empty editor and cached versions. */
export function formatVersionSize (bytes: number|undefined, formatSize: (bytes: number) => string): string {
  return typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes >= 0 ? formatSize(bytes) : 'unknown'
}
