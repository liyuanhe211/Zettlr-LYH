/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        writeFileSafely, writeFileSafelySync
 * CVM-Role:        Utility function
 * Maintainer:      Zettlr-LYH
 * License:         GNU GPL v3
 *
 * Description:     Writes a file so that a crash or power loss at any moment
 *                  leaves a complete version of it on the disk.
 *
 * END HEADER
 */

import path from 'path'
import { promises as fs, openSync, writeSync, fsyncSync, closeSync, readFileSync, renameSync, rmSync, realpathSync, statSync } from 'fs'
import { randomBytes } from 'crypto'

// ZETTLR-LYH SAFE SAVE
//
// A file is never truncated and rewritten in place. Writing in place leaves a
// window in which a power loss destroys the file: on NTFS the new file size can
// already be on disk while the data is still in the write cache, so the file
// comes back as a run of zero bytes (this happened to a manuscript on
// 2026-11-17, and to config.json after the system crashes of 2026-11-18).
// Instead, the new contents go into a temporary file next to the target, are
// flushed to the disk and read back for comparison, and only then does the
// temporary file replace the target in a single rename. After a crash the
// target therefore holds either the complete old or the complete new text.
// The temporary name contains ".~", which the FSAL watchdog ignores
// (WATCHDOG_IGNORE_PATHS), and chokidar reports the replacement as a plain
// "change", so the document manager recognizes its own save as before.

// Delays before the retries of the final rename. Windows refuses the rename
// while another program (a virus scanner, a sync client, an indexer) holds the
// target open without allowing deletion; such locks are usually short-lived.
const SAFE_SAVE_RENAME_RETRY_DELAYS_MS = [ 50, 100, 200, 400, 800 ]
const SAFE_SAVE_RETRYABLE_ERROR_CODES = new Set([ 'EPERM', 'EBUSY', 'EACCES' ])

/**
 * Returns the code of a Node.js file system error (ENOENT, EPERM, ...).
 */
function errorCodeOf (err: unknown): string|undefined {
  const code = (err as NodeJS.ErrnoException|undefined)?.code
  return typeof code === 'string' ? code : undefined
}

/**
 * Returns a sibling path for a temporary file belonging to filePath.
 */
function safeSaveSiblingPath (filePath: string): string {
  const name = `${path.basename(filePath)}.~zettlr-save-${process.pid}-${randomBytes(4).toString('hex')}`
  return path.join(path.dirname(filePath), name)
}

/**
 * An additional check of the flushed temporary file before it replaces the
 * target, e.g. that the contents parse. It throws to cancel the replacement.
 */
export type SafeWriteVerifier = (readBack: Buffer) => void

/**
 * Writes data into a new file, flushes it to the disk and verifies it by
 * reading it back. Throws (after removing the file) if anything fails.
 */
async function writeFlushedAndVerified (filePath: string, data: Buffer, mode: number|undefined, verify?: SafeWriteVerifier): Promise<void> {
  const handle = await fs.open(filePath, 'wx', mode)
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  const readBack = await fs.readFile(filePath)
  if (!readBack.equals(data)) {
    throw new Error(`The temporary file ${filePath} does not contain what was written (${readBack.length} instead of ${data.length} bytes).`)
  }
  verify?.(readBack)
}

/**
 * Overwrites an existing file in place, flushes it and verifies it. Only used
 * when the target cannot be replaced by a rename.
 */
async function overwriteInPlaceFlushed (filePath: string, data: Buffer): Promise<void> {
  const handle = await fs.open(filePath, 'r+')
  try {
    await handle.truncate(0)
    await handle.write(data, 0, data.length, 0)
    await handle.sync()
  } finally {
    await handle.close()
  }
  const readBack = await fs.readFile(filePath)
  if (!readBack.equals(data)) {
    throw new Error(`The file ${filePath} does not contain what was written (${readBack.length} instead of ${data.length} bytes).`)
  }
}

/**
 * Writes data to filePath so that a crash or power loss at any moment leaves
 * a complete version of the file on the disk (see "ZETTLR-LYH SAFE SAVE").
 *
 * @param  {string}                     filePath  The file to write
 * @param  {Buffer}                     data      The complete new contents
 * @param  {(message: string) => void}  warn      Reports the fallback path
 * @param  {SafeWriteVerifier}          verify    Optional check of the flushed temporary file
 */
export async function writeFileSafely (filePath: string, data: Buffer, warn: (message: string) => void, verify?: SafeWriteVerifier): Promise<void> {
  // Write through symbolic links instead of replacing the link with a file.
  let targetPath = filePath
  try {
    targetPath = await fs.realpath(filePath)
  } catch (err) {
    if (errorCodeOf(err) !== 'ENOENT') {
      throw err
    }
  }

  let mode: number|undefined
  try {
    mode = (await fs.stat(targetPath)).mode & 0o7777
  } catch (err) {
    if (errorCodeOf(err) !== 'ENOENT') {
      throw err
    }
  }

  const temporaryPath = safeSaveSiblingPath(targetPath)
  try {
    await writeFlushedAndVerified(temporaryPath, data, mode, verify)
  } catch (err) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {})
    throw err
  }

  let lastError: unknown
  for (let attempt = 0; attempt <= SAFE_SAVE_RENAME_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      await new Promise(resolve => setTimeout(resolve, SAFE_SAVE_RENAME_RETRY_DELAYS_MS[attempt - 1]))
    }
    try {
      await fs.rename(temporaryPath, targetPath)
      return
    } catch (err) {
      lastError = err
      if (!SAFE_SAVE_RETRYABLE_ERROR_CODES.has(errorCodeOf(err) ?? '')) {
        break
      }
    }
  }

  // The target could not be replaced. If it exists, overwrite it in place: the
  // flushed temporary file stays on the disk as a complete copy until the
  // overwrite has been flushed and verified, so no moment is unprotected.
  const lastErrorCode = errorCodeOf(lastError) ?? ''
  const targetExists = await fs.stat(targetPath).then(() => true, () => false)
  if (!targetExists || !SAFE_SAVE_RETRYABLE_ERROR_CODES.has(lastErrorCode)) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {})
    throw lastError
  }

  warn(`[Safe save] Could not replace ${targetPath} (${lastErrorCode}); overwriting it in place. A complete copy stays at ${temporaryPath} until the overwrite is verified.`)
  await overwriteInPlaceFlushed(targetPath, data)
  await fs.rm(temporaryPath, { force: true })
}

/**
 * Synchronous variant of writeFileSafely for the last write before the process
 * exits, where an asynchronous write may never finish. It writes, flushes and
 * verifies a temporary file and replaces the target with one rename; it does
 * not wait and retry when the rename is refused, but leaves the target
 * untouched and throws, so the previous complete version stays on the disk.
 *
 * @param  {string}             filePath  The file to write
 * @param  {Buffer}             data      The complete new contents
 * @param  {SafeWriteVerifier}  verify    Optional check of the flushed temporary file
 */
export function writeFileSafelySync (filePath: string, data: Buffer, verify?: SafeWriteVerifier): void {
  let targetPath = filePath
  try {
    targetPath = realpathSync(filePath)
  } catch (err) {
    if (errorCodeOf(err) !== 'ENOENT') {
      throw err
    }
  }

  let mode: number|undefined
  try {
    mode = statSync(targetPath).mode & 0o7777
  } catch (err) {
    if (errorCodeOf(err) !== 'ENOENT') {
      throw err
    }
  }

  const temporaryPath = safeSaveSiblingPath(targetPath)
  try {
    const descriptor = openSync(temporaryPath, 'wx', mode)
    try {
      let offset = 0
      while (offset < data.length) {
        offset += writeSync(descriptor, data, offset, data.length - offset)
      }
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    const readBack = readFileSync(temporaryPath)
    if (!readBack.equals(data)) {
      throw new Error(`The temporary file ${temporaryPath} does not contain what was written (${readBack.length} instead of ${data.length} bytes).`)
    }
    verify?.(readBack)
    renameSync(temporaryPath, targetPath)
  } catch (err) {
    try {
      rmSync(temporaryPath, { force: true })
    } catch {}
    throw err
  }
}
