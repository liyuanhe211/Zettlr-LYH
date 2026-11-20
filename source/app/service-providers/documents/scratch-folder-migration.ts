/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Migration of the old default scratch folder
 * CVM-Role:        Utility
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH R135 (spec C3): the default scratch folder moved
 *                  from Zettlr_Unsaved to Zettlr\__Unsaved inside the documents
 *                  folder. migrateLegacyScratchFolder moves everything directly
 *                  inside the old folder to the new one, except for the old
 *                  _Discarded subfolder, whose entries go to the __Unsaved
 *                  folder of the undo history folder. Every entry is renamed,
 *                  or, if that fails, copied, checked (size and SHA-1) and
 *                  only then removed, so that every file always has at least
 *                  one complete copy. Each move is recorded in the JSON Lines
 *                  file .migration-from-Zettlr_Unsaved.json inside the new
 *                  folder. Links in the moved .md files that point into the
 *                  old folder or, relatively, to existing files are rewritten
 *                  to keep pointing at the same targets. The module does not
 *                  depend on electron, and the file system is injected, so
 *                  that it can be tested directly. It never touches the
 *                  configuration: the caller writes the new default folder
 *                  into it when the result is "completed".
 *
 * END HEADER
 */

import path from 'path'
import { promises as nodeFs, constants as fsConstants } from 'fs'
import { createHash } from 'crypto'
import { buildAbsoluteImageDestination } from '@common/util/paste-image-path'
import {
  SCRATCH_DEFAULT_FOLDER_SEGMENTS,
  SCRATCH_DISCARDED_FOLDER,
  SCRATCH_HISTORY_SUBFOLDER,
  SCRATCH_LEGACY_FOLDER_NAME,
  isLegacyDefaultScratchDirectory,
  resolveScratchDirectory
} from './scratch-notes'

/**
 * Name of the migration record inside the new scratch folder (JSON Lines).
 */
export const SCRATCH_MIGRATION_RECORD_NAME = '.migration-from-Zettlr_Unsaved.json'

/**
 * Suffix of the temporary file a rewritten note is written to before it
 * replaces the moved note.
 */
const REWRITE_TEMPORARY_SUFFIX = '.migration-tmp'

/**
 * An entry of a folder listing, as fs.promises.readdir returns it with
 * withFileTypes.
 */
export interface ScratchMigrationDirectoryEntry {
  name: string
  isDirectory: () => boolean
}

/**
 * The part of fs.Stats that the migration uses.
 */
export interface ScratchMigrationStats {
  size: number
  isDirectory: () => boolean
}

/**
 * The subset of fs.promises that the migration uses. Tests wrap
 * nodeScratchMigrationFileSystem to inject failures.
 */
export interface ScratchMigrationFileSystem {
  readdir: (directory: string, options: { withFileTypes: true }) => Promise<ScratchMigrationDirectoryEntry[]>
  stat: (filePath: string) => Promise<ScratchMigrationStats>
  rename: (oldPath: string, newPath: string) => Promise<void>
  copyFile: (source: string, destination: string, mode?: number) => Promise<void>
  readFile: (filePath: string) => Promise<Buffer>
  writeFile: (filePath: string, data: Buffer) => Promise<void>
  appendFile: (filePath: string, data: string) => Promise<void>
  unlink: (filePath: string) => Promise<void>
  mkdir: (directory: string, options: { recursive: true }) => Promise<unknown>
  rmdir: (directory: string) => Promise<void>
}

/**
 * The real file system, made of fs.promises.
 */
export const nodeScratchMigrationFileSystem: ScratchMigrationFileSystem = {
  readdir: async (directory, options) => await nodeFs.readdir(directory, options),
  stat: async (filePath) => await nodeFs.stat(filePath),
  rename: async (oldPath, newPath) => { await nodeFs.rename(oldPath, newPath) },
  copyFile: async (source, destination, mode) => { await nodeFs.copyFile(source, destination, mode) },
  readFile: async (filePath) => await nodeFs.readFile(filePath),
  writeFile: async (filePath, data) => { await nodeFs.writeFile(filePath, data) },
  appendFile: async (filePath, data) => { await nodeFs.appendFile(filePath, data, 'utf-8') },
  unlink: async (filePath) => { await nodeFs.unlink(filePath) },
  mkdir: async (directory, options) => await nodeFs.mkdir(directory, options),
  rmdir: async (directory) => { await nodeFs.rmdir(directory) }
}

/**
 * The result of a migration (spec C3, R135 revision).
 */
export interface MigrationResult {
  /**
   * not-needed: a custom scratch folder is configured, nothing was touched.
   * completed: everything was moved (or there was no old folder), and the old
   * folder was removed. partial: some entries could not be moved; they and the
   * old folder are still there, and the next migration tries again.
   */
  status: 'not-needed' | 'completed' | 'partial'
  /**
   * The scratch folder to use from now on: the new default folder, or, for
   * not-needed, the configured folder.
   */
  newDirectory: string
  /**
   * The entries that were moved.
   */
  moved: Array<{ from: string, to: string }>
  /**
   * The entries that could not be moved, with the error message.
   */
  failed: Array<{ path: string, reason: string }>
  /**
   * Every link that was rewritten, with the moved file it is in.
   */
  rewrittenLinks: Array<{ file: string, from: string, to: string }>
}

/**
 * What migrateLegacyScratchFolder needs to know.
 */
export interface ScratchMigrationOptions {
  /**
   * The configured scratch folder (configuration key scratchNotesDirectory).
   */
  configured: string
  /**
   * The user's documents folder.
   */
  documentsPath: string
  /**
   * The undo history folder; the old discarded notes go to its __Unsaved
   * subfolder.
   */
  historyRoot: string
  /**
   * The file system to work on.
   */
  fs: ScratchMigrationFileSystem
  /**
   * The clock for the time stamps of the migration record (milliseconds).
   */
  now: () => number
}

/**
 * The existing target of a relative link, found before anything was moved.
 */
interface RelativeLinkTarget {
  /**
   * The absolute path of the target at its old location.
   */
  target: string
  /**
   * True if the link only resolved after percent-decoding it.
   */
  encoded: boolean
}

/** An absolute old-folder address, resolved before any entry is moved. */
interface AbsoluteLinkTarget extends RelativeLinkTarget {
  separator: string
  rest: string
}

/**
 * One entry to migrate.
 */
interface MigrationItem {
  from: string
  to: string
  isDirectory: boolean
  /**
   * For .md files whose links are rewritten: the existing targets of their
   * relative links (null: the target does not exist), by link address.
   * Undefined for all other entries.
   */
  relativeTargets?: Map<string, RelativeLinkTarget|null>
}

/**
 * Where a link address sits in the text of a note.
 */
interface LinkOccurrence {
  start: number
  end: number
  address: string
}

// Markdown links and images: "](" followed by an address in angle brackets, or
// by an address without spaces that may contain one level of balanced
// parentheses. A title after the address is left alone.
const MARKDOWN_ADDRESS_PATTERN = /\]\([ \t]*(?:<([^<>\n]*)>|((?:[^\s()<>]|\([^\s()]*\))+))/g

// The src and href attributes of HTML tags, in double or single quotes
const HTML_ADDRESS_PATTERN = /\b(?:src|href)[ \t]*=[ \t]*(?:"([^"\n]*)"|'([^'\n]*)')/gi

// A URL scheme such as https: or mailto:, or a Windows drive letter
const SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/

// A percent-encoded character, as buildAbsoluteImageDestination writes them
const PERCENT_ENCODING_PATTERN = /%[0-9A-Fa-f]{2}/

/**
 * Returns the error code of a Node.js file system error, if any.
 *
 * @param   {unknown}             error  The caught error
 *
 * @return  {string|undefined}           The error code, e.g. ENOENT
 */
function errorCode (error: unknown): string|undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code: unknown = (error as { code: unknown }).code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}

/**
 * Returns the message of a caught error.
 *
 * @param   {unknown}  error  The caught error
 *
 * @return  {string}          The message
 */
function errorMessage (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Returns the SHA-1 hash of some bytes as hexadecimal digits.
 *
 * @param   {Buffer}  data  The bytes
 *
 * @return  {string}        The hash
 */
function sha1 (data: Buffer): string {
  return createHash('sha1').update(data).digest('hex')
}

/**
 * Percent-decodes a link address; an address that is not valid percent-encoding
 * is returned unchanged.
 *
 * @param   {string}  address  The address
 *
 * @return  {string}           The decoded address
 */
function decodeAddress (address: string): string {
  try {
    return decodeURIComponent(address)
  } catch {
    return address
  }
}

/**
 * Replaces all backslashes with forward slashes.
 *
 * @param   {string}  text  The text
 *
 * @return  {string}        The text with forward slashes only
 */
function toForwardSlashes (text: string): string {
  return text.replace(/\\/g, '/')
}

/**
 * Checks whether something exists at a path. Errors other than "does not
 * exist" count as existing, so that nothing is ever moved onto an entry that
 * merely could not be inspected.
 *
 * @param   {ScratchMigrationFileSystem}  fs        The file system
 * @param   {string}                      filePath  The path
 *
 * @return  {Promise<boolean>}                      True unless the path does not exist
 */
async function entryExists (fs: ScratchMigrationFileSystem, filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath)
    return true
  } catch (error) {
    const code = errorCode(error)
    return code !== 'ENOENT' && code !== 'ENOTDIR'
  }
}

/**
 * Checks whether a link target exists. Any error counts as "does not exist",
 * so that a link is only rewritten if its target was certainly there.
 *
 * @param   {ScratchMigrationFileSystem}  fs        The file system
 * @param   {string}                      filePath  The target
 *
 * @return  {Promise<boolean>}                      True if the target exists
 */
async function linkTargetExists (fs: ScratchMigrationFileSystem, filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * Returns the names in a folder, or none if the folder does not exist.
 *
 * @param   {ScratchMigrationFileSystem}  fs         The file system
 * @param   {string}                      directory  The folder
 *
 * @return  {Promise<string[]>}                      The names of its entries
 */
async function namesIn (fs: ScratchMigrationFileSystem, directory: string): Promise<string[]> {
  try {
    return (await fs.readdir(directory, { withFileTypes: true })).map(entry => entry.name)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return []
    }
    throw error
  }
}

/**
 * Returns the given name, or, if it is taken (compared case-insensitively),
 * the first free name with _2, _3, ... appended: before the extension for a
 * file, at the end for a folder. The returned name is marked as taken.
 *
 * @param   {string}       name         The wanted name
 * @param   {boolean}      isDirectory  Whether the entry is a folder
 * @param   {Set<string>}  takenNames   The lower-case names already taken
 *
 * @return  {string}                    The free name
 */
function allocateName (name: string, isDirectory: boolean, takenNames: Set<string>): string {
  const extension = isDirectory ? '' : path.extname(name)
  const stem = name.slice(0, name.length - extension.length)

  let candidate = name
  let counter = 2
  while (takenNames.has(candidate.toLowerCase())) {
    candidate = `${stem}_${counter}${extension}`
    counter++
  }

  takenNames.add(candidate.toLowerCase())
  return candidate
}

/**
 * Finds the addresses of Markdown links and images and of HTML src and href
 * attributes in the text of a note, in the order they appear, without overlaps.
 *
 * @param   {string}            text  The text of the note
 *
 * @return  {LinkOccurrence[]}        The addresses and where they are
 */
function findLinkAddresses (text: string): LinkOccurrence[] {
  const occurrences: LinkOccurrence[] = []

  for (const match of text.matchAll(MARKDOWN_ADDRESS_PATTERN)) {
    const address = match[1] ?? match[2]
    if (address === undefined || address === '' || match.index === undefined) {
      continue
    }
    // An address in angle brackets is followed by the closing ">"
    const end = match.index + match[0].length - (match[1] !== undefined ? 1 : 0)
    occurrences.push({ start: end - address.length, end, address })
  }

  for (const match of text.matchAll(HTML_ADDRESS_PATTERN)) {
    const address = match[1] ?? match[2]
    if (address === undefined || address === '' || match.index === undefined) {
      continue
    }
    // The address is followed by the closing quote
    const end = match.index + match[0].length - 1
    occurrences.push({ start: end - address.length, end, address })
  }

  occurrences.sort((first, second) => first.start - second.start)

  const result: LinkOccurrence[] = []
  let lastEnd = -1
  for (const occurrence of occurrences) {
    if (occurrence.start >= lastEnd) {
      result.push(occurrence)
      lastEnd = occurrence.end
    }
  }

  return result
}

/**
 * Checks whether a link address is a relative file path: not empty, not a
 * fragment, not a URL, and not an absolute or root-relative path.
 *
 * @param   {string}   address  The address
 *
 * @return  {boolean}           True if the address is a relative path
 */
function isRelativeAddress (address: string): boolean {
  if (address === '' || address.startsWith('#') || address.startsWith('/') || address.startsWith('\\')) {
    return false
  }

  if (SCHEME_PATTERN.test(address)) {
    return false
  }

  return !path.isAbsolute(address)
}

/**
 * Turns the text of a note into a string only if the bytes are valid UTF-8, so
 * that rewriting never damages a file in another encoding. A byte order mark
 * stays part of the string.
 *
 * @param   {Buffer}       data  The bytes of the note
 *
 * @return  {string|null}        The text, or null if it is not valid UTF-8
 */
function decodeNoteText (data: Buffer): string|null {
  const text = data.toString('utf8')
  return Buffer.from(text, 'utf8').equals(data) ? text : null
}

/**
 * The migration of one old default scratch folder. Holds the paths, the plan
 * and the result while the migration runs.
 */
class ScratchFolderMigration {
  private readonly fs: ScratchMigrationFileSystem
  private readonly now: () => number
  private readonly caseInsensitive = process.platform === 'win32'

  private readonly legacyDirectory: string
  private readonly newDirectory: string
  private readonly historyDirectory: string
  private readonly recordPath: string

  /**
   * The old _Discarded folder as it is spelled on disk, if it exists.
   */
  private discardedDirectory: string|undefined = undefined
  /**
   * The new path of every entry to migrate, by the comparison key of its old path.
   */
  private readonly mapping = new Map<string, string>()
  private readonly items: MigrationItem[] = []
  /** A null entry means the absolute target did not exist before migration. */
  private readonly absoluteTargets = new Map<string, AbsoluteLinkTarget|null>()

  readonly moved: MigrationResult['moved'] = []
  readonly failed: MigrationResult['failed'] = []
  readonly rewrittenLinks: MigrationResult['rewrittenLinks'] = []

  constructor (options: ScratchMigrationOptions) {
    this.fs = options.fs
    this.now = options.now
    this.legacyDirectory = path.join(options.documentsPath, SCRATCH_LEGACY_FOLDER_NAME)
    this.newDirectory = path.join(options.documentsPath, ...SCRATCH_DEFAULT_FOLDER_SEGMENTS)
    this.historyDirectory = path.join(options.historyRoot, SCRATCH_HISTORY_SUBFOLDER)
    this.recordPath = path.join(this.newDirectory, SCRATCH_MIGRATION_RECORD_NAME)
  }

  /**
   * Runs the whole migration.
   *
   * @return  {Promise<MigrationResult>}  The result
   */
  async run (): Promise<MigrationResult> {
    try {
      const legacyStats = await this.fs.stat(this.legacyDirectory)
      if (!legacyStats.isDirectory()) {
        this.failed.push({ path: this.legacyDirectory, reason: 'The old scratch folder is not a folder' })
        return this.result()
      }
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return this.result() // Nothing to migrate
      }
      this.failed.push({ path: this.legacyDirectory, reason: errorMessage(error) })
      return this.result()
    }

    try {
      await this.plan()
    } catch (error) {
      this.failed.push({ path: this.legacyDirectory, reason: errorMessage(error) })
      return this.result()
    }

    try {
      await this.fs.mkdir(this.newDirectory, { recursive: true })
    } catch (error) {
      this.failed.push({ path: this.newDirectory, reason: errorMessage(error) })
      return this.result()
    }

    let historyDirectoryReady = false
    for (const item of this.items) {
      if (this.isInHistoryDirectory(item) && !historyDirectoryReady) {
        try {
          await this.fs.mkdir(this.historyDirectory, { recursive: true })
          historyDirectoryReady = true
        } catch (error) {
          this.failed.push({ path: item.from, reason: errorMessage(error) })
          continue
        }
      }

      await this.migrateItem(item)
    }

    if (this.failed.length === 0) {
      await this.removeLegacyFolders()
    }

    return this.result()
  }

  /**
   * Returns the result of the migration so far.
   *
   * @return  {MigrationResult}  The result
   */
  private result (): MigrationResult {
    return {
      status: this.failed.length === 0 ? 'completed' : 'partial',
      newDirectory: this.newDirectory,
      moved: this.moved,
      failed: this.failed,
      rewrittenLinks: this.rewrittenLinks
    }
  }

  /**
   * Returns the key under which a path is compared: resolved, and lower-cased
   * on Windows.
   *
   * @param   {string}  filePath  The path
   *
   * @return  {string}            The comparison key
   */
  private key (filePath: string): string {
    const resolved = path.resolve(filePath)
    return this.caseInsensitive ? resolved.toLowerCase() : resolved
  }

  /**
   * Checks whether an entry goes to the undo history folder.
   *
   * @param   {MigrationItem}  item  The entry
   *
   * @return  {boolean}              True if it comes from the old _Discarded folder
   */
  private isInHistoryDirectory (item: MigrationItem): boolean {
    return this.key(path.dirname(item.to)) === this.key(this.historyDirectory)
  }

  /**
   * Lists every entry to migrate and its new path, resolving name conflicts,
   * and finds the existing targets of the links in the .md files,
   * all before anything is moved.
   */
  private async plan (): Promise<void> {
    const entries = (await this.fs.readdir(this.legacyDirectory, { withFileTypes: true }))
      .slice()
      .sort((first, second) => first.name < second.name ? -1 : first.name > second.name ? 1 : 0)

    const newTakenNames = new Set((await namesIn(this.fs, this.newDirectory)).map(name => name.toLowerCase()))
    const historyTakenNames = new Set((await namesIn(this.fs, this.historyDirectory)).map(name => name.toLowerCase()))

    const discardedEntries: ScratchMigrationDirectoryEntry[] = []
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.toLowerCase() === SCRATCH_DISCARDED_FOLDER.toLowerCase() && this.discardedDirectory === undefined) {
        this.discardedDirectory = path.join(this.legacyDirectory, entry.name)
        discardedEntries.push(...(await this.fs.readdir(this.discardedDirectory, { withFileTypes: true })))
        continue
      }

      const isDirectory = entry.isDirectory()
      const to = path.join(this.newDirectory, allocateName(entry.name, isDirectory, newTakenNames))
      this.addItem(path.join(this.legacyDirectory, entry.name), to, isDirectory)
    }

    if (this.discardedDirectory !== undefined) {
      discardedEntries.sort((first, second) => first.name < second.name ? -1 : first.name > second.name ? 1 : 0)
      for (const entry of discardedEntries) {
        const isDirectory = entry.isDirectory()
        const to = path.join(this.historyDirectory, allocateName(entry.name, isDirectory, historyTakenNames))
        this.addItem(path.join(this.discardedDirectory, entry.name), to, isDirectory)
      }
    }

    for (const item of this.items) {
      if (!item.isDirectory && item.from.toLowerCase().endsWith('.md')) {
        item.relativeTargets = await this.findRelativeTargets(item.from)
      }
    }
  }

  /**
   * Adds an entry to the plan.
   *
   * @param   {string}   from         The old path
   * @param   {string}   to           The new path
   * @param   {boolean}  isDirectory  Whether the entry is a folder
   */
  private addItem (from: string, to: string, isDirectory: boolean): void {
    this.items.push({ from, to, isDirectory })
    this.mapping.set(this.key(from), to)
  }

  /**
   * Reads a note at its old location and snapshots absolute old-folder targets
   * as well as the existing targets of its relative links.
   *
   * @param   {string}  notePath  The old path of the note
   *
   * @return  {Promise<Map<string, RelativeLinkTarget|null>|undefined>}  The
   *          targets by address, or undefined if the note cannot be read as
   *          UTF-8 (then none of its links are rewritten)
   */
  private async findRelativeTargets (notePath: string): Promise<Map<string, RelativeLinkTarget|null>|undefined> {
    let text: string|null
    try {
      text = decodeNoteText(await this.fs.readFile(notePath))
    } catch {
      return undefined
    }

    if (text === null) {
      return undefined
    }

    const noteDirectory = path.dirname(notePath)
    const targets = new Map<string, RelativeLinkTarget|null>()
    for (const { address } of findLinkAddresses(text)) {
      if (!this.absoluteTargets.has(address)) {
        const absolute = this.resolveAbsoluteAddress(address)
        if (absolute !== null) {
          this.absoluteTargets.set(address, await linkTargetExists(this.fs, absolute.target) ? absolute : null)
        }
      }
      if (targets.has(address) || !isRelativeAddress(address)) {
        continue
      }

      let found: RelativeLinkTarget|null = null
      const decoded = decodeAddress(address)
      const candidates = decoded === address ? [address] : [ address, decoded ]
      for (const candidate of candidates) {
        const target = path.resolve(noteDirectory, candidate)
        if (await linkTargetExists(this.fs, target)) {
          found = { target, encoded: candidate !== address }
          break
        }
      }

      targets.set(address, found)
    }

    return targets
  }

  /**
   * Moves one entry, records the move, and rewrites the links of a moved note.
   * A failure is recorded in the result; it never stops the migration.
   *
   * @param   {MigrationItem}  item  The entry
   */
  private async migrateItem (item: MigrationItem): Promise<void> {
    try {
      if (await entryExists(this.fs, item.to)) {
        throw new Error(`${item.to} already exists`)
      }
      await this.moveEntry(item)
    } catch (error) {
      this.failed.push({ path: item.from, reason: errorMessage(error) })
      return
    }

    this.moved.push({ from: item.from, to: item.to })
    await this.appendRecord({ time: this.now(), from: item.from, to: item.to })

    if (item.relativeTargets !== undefined) {
      await this.rewriteLinks(item, item.relativeTargets)
    }
  }

  /**
   * Appends one line to the migration record. The record only documents the
   * migration, so a failure to write it does not stop anything.
   *
   * @param   {Record<string, unknown>}  line  The line to append
   */
  private async appendRecord (line: Record<string, unknown>): Promise<void> {
    try {
      await this.fs.appendFile(this.recordPath, JSON.stringify(line) + '\n')
    } catch {
      // The record is informational only
    }
  }

  /**
   * Moves an entry: renames it, or, if that fails, copies it, checks the copy
   * and then removes the original.
   *
   * @param   {MigrationItem}  item  The entry
   */
  private async moveEntry (item: MigrationItem): Promise<void> {
    try {
      await this.fs.rename(item.from, item.to)
      return
    } catch (renameError) {
      const created: Array<{ path: string, isDirectory: boolean }> = []
      try {
        if (item.isDirectory) {
          await this.copyDirectory(item.from, item.to, created)
        } else {
          await this.copyFile(item.from, item.to, created)
        }
      } catch (copyError) {
        await this.removeCreated(created)
        throw new Error(`Renaming failed (${errorMessage(renameError)}), and copying failed as well (${errorMessage(copyError)})`)
      }

      if (!item.isDirectory) {
        try {
          await this.fs.unlink(item.from)
        } catch (unlinkError) {
          // Keep the original, which is complete, and remove the copy
          await this.removeCreated(created)
          throw new Error(`Copied, but the original could not be removed (${errorMessage(unlinkError)})`)
        }
        return
      }

      try {
        await this.removeTree(item.from)
      } catch (removeError) {
        // Some originals may already be gone, so the complete copy stays
        throw new Error(`Copied to ${item.to}, but the original folder could not be removed completely (${errorMessage(removeError)})`)
      }
    }
  }

  /**
   * Copies a file without overwriting anything, and checks that the copy has
   * the same size and SHA-1 hash as the original.
   *
   * @param   {string}  from     The original
   * @param   {string}  to       The copy
   * @param   {Array}   created  Receives the paths this function created
   */
  private async copyFile (from: string, to: string, created: Array<{ path: string, isDirectory: boolean }>): Promise<void> {
    await this.fs.copyFile(from, to, fsConstants.COPYFILE_EXCL)
    created.push({ path: to, isDirectory: false })

    const originalStats = await this.fs.stat(from)
    const copyStats = await this.fs.stat(to)
    if (originalStats.size !== copyStats.size) {
      throw new Error(`The copy of ${from} has a different size`)
    }

    if (sha1(await this.fs.readFile(from)) !== sha1(await this.fs.readFile(to))) {
      throw new Error(`The copy of ${from} has a different SHA-1 hash`)
    }
  }

  /**
   * Copies a folder with everything in it, checking every copied file.
   *
   * @param   {string}  from     The original folder
   * @param   {string}  to       The copy
   * @param   {Array}   created  Receives the paths this function created
   */
  private async copyDirectory (from: string, to: string, created: Array<{ path: string, isDirectory: boolean }>): Promise<void> {
    if (await entryExists(this.fs, to)) {
      throw new Error(`${to} already exists`)
    }
    await this.fs.mkdir(to, { recursive: true })
    created.push({ path: to, isDirectory: true })

    for (const entry of await this.fs.readdir(from, { withFileTypes: true })) {
      const source = path.join(from, entry.name)
      const destination = path.join(to, entry.name)
      if (entry.isDirectory()) {
        await this.copyDirectory(source, destination, created)
      } else {
        await this.copyFile(source, destination, created)
      }
    }
  }

  /**
   * Removes, as far as possible, the copies made by a failed copy, newest first.
   * The originals are still complete, so nothing is lost if this fails.
   *
   * @param   {Array}  created  The paths the copy created
   */
  private async removeCreated (created: Array<{ path: string, isDirectory: boolean }>): Promise<void> {
    for (const entry of created.slice().reverse()) {
      try {
        if (entry.isDirectory) {
          await this.fs.rmdir(entry.path)
        } else {
          await this.fs.unlink(entry.path)
        }
      } catch {
        // Leave it; the original is complete
      }
    }
  }

  /**
   * Removes a folder with everything in it.
   *
   * @param   {string}  directory  The folder
   */
  private async removeTree (directory: string): Promise<void> {
    for (const entry of await this.fs.readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await this.removeTree(entryPath)
      } else {
        await this.fs.unlink(entryPath)
      }
    }
    await this.fs.rmdir(directory)
  }

  /**
   * Removes the emptied old _Discarded folder and the old scratch folder. A
   * failure is recorded, so that the next migration tries again.
   */
  private async removeLegacyFolders (): Promise<void> {
    const folders = this.discardedDirectory !== undefined
      ? [ this.discardedDirectory, this.legacyDirectory ]
      : [this.legacyDirectory]

    for (const folder of folders) {
      try {
        await this.fs.rmdir(folder)
      } catch (error) {
        this.failed.push({ path: folder, reason: errorMessage(error) })
        return
      }
    }
  }

  /**
   * Returns where a path inside the old scratch folder ends up after the
   * migration; paths outside of it are returned unchanged. Entries that are not
   * in the plan (or not moved yet) are assumed to keep their name.
   *
   * @param   {string}  oldPath  The old path
   *
   * @return  {string}           The new path
   */
  private mapLegacyPath (oldPath: string): string {
    const relative = path.relative(this.legacyDirectory, oldPath)
    if (relative === '') {
      return this.newDirectory
    }

    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) {
      return oldPath
    }

    const segments = relative.split(path.sep)
    const firstEntry = path.join(this.legacyDirectory, segments[0])

    if (this.discardedDirectory !== undefined && this.key(firstEntry) === this.key(this.discardedDirectory)) {
      if (segments.length === 1) {
        return this.historyDirectory
      }
      const itemPath = path.join(this.discardedDirectory, segments[1])
      const mapped = this.mapping.get(this.key(itemPath)) ?? path.join(this.historyDirectory, segments[1])
      return path.join(mapped, ...segments.slice(2))
    }

    const mapped = this.mapping.get(this.key(firstEntry)) ?? path.join(this.newDirectory, segments[0])
    return path.join(mapped, ...segments.slice(1))
  }

  /**
   * Rewrites the links of a moved note and writes it back if anything changed,
   * keeping its byte order mark and line endings. Every rewritten link is
   * recorded in the result and in the migration record.
   *
   * @param   {MigrationItem}                         item             The moved note
   * @param   {Map<string, RelativeLinkTarget|null>}  relativeTargets  The targets of its relative links
   */
  private async rewriteLinks (item: MigrationItem, relativeTargets: Map<string, RelativeLinkTarget|null>): Promise<void> {
    const temporaryPath = item.to + REWRITE_TEMPORARY_SUFFIX
    try {
      const text = decodeNoteText(await this.fs.readFile(item.to))
      if (text === null) {
        return
      }

      const newNoteDirectory = path.dirname(item.to)
      const rewrites: Array<{ occurrence: LinkOccurrence, to: string }> = []
      for (const occurrence of findLinkAddresses(text)) {
        const rewritten = this.rewriteAddress(occurrence.address, newNoteDirectory, relativeTargets)
        if (rewritten !== null && rewritten !== occurrence.address) {
          rewrites.push({ occurrence, to: rewritten })
        }
      }

      if (rewrites.length === 0) {
        return
      }

      let newText = ''
      let position = 0
      for (const { occurrence, to } of rewrites) {
        newText += text.slice(position, occurrence.start) + to
        position = occurrence.end
      }
      newText += text.slice(position)

      await this.fs.writeFile(temporaryPath, Buffer.from(newText, 'utf8'))
      await this.fs.rename(temporaryPath, item.to)

      for (const { occurrence, to } of rewrites) {
        this.rewrittenLinks.push({ file: item.to, from: occurrence.address, to })
        await this.appendRecord({ time: this.now(), file: item.to, from: occurrence.address, to })
      }
    } catch (error) {
      // The note itself has been moved intact; only its links stay as they were
      try {
        await this.fs.unlink(temporaryPath)
      } catch {
        // There may be no temporary file
      }
      await this.appendRecord({ time: this.now(), file: item.to, error: `Links not rewritten: ${errorMessage(error)}` })
    }
  }

  /**
   * Returns the rewritten form of one link address of a moved note, or null if
   * it stays as it is.
   *
   * @param   {string}  address           The address
   * @param   {string}  newNoteDirectory  The folder the note is in now
   * @param   {Map}     relativeTargets   The targets of the note's relative
   *                                      links, resolved at its old location
   *
   * @return  {string|null}               The new address, or null
   */
  private rewriteAddress (
    address: string,
    newNoteDirectory: string,
    relativeTargets: Map<string, RelativeLinkTarget|null>
  ): string|null {
    const absolute = this.rewriteAbsoluteAddress(address)
    if (absolute !== null) {
      return absolute
    }

    const info = relativeTargets.get(address)
    if (info === undefined || info === null) {
      return null // Not relative, or the target did not exist
    }

    const newTarget = this.mapLegacyPath(info.target)
    const relative = path.relative(newNoteDirectory, newTarget)
    if (relative === '') {
      return null
    }

    const oldRelative = path.normalize(info.encoded ? decodeAddress(address) : address)
    const unchanged = this.caseInsensitive
      ? oldRelative.toLowerCase() === relative.toLowerCase()
      : oldRelative === relative
    if (unchanged) {
      return null
    }

    const separator = address.includes('\\') ? '\\' : '/'
    const styled = relative.split(path.sep).join(separator)
    return info.encoded ? buildAbsoluteImageDestination(styled) : styled
  }

  /**
   * Resolves an address that starts with the absolute path of the old scratch
   * folder, written with backslashes, with forward slashes, or with forward
   * slashes and percent-encoding (R126), preserving its address style for a
   * rewrite after the note has moved.
   *
   * @param   {string}       address  The address
   *
   * @return  {AbsoluteLinkTarget|null}  The old target, or null if the address
   *                                  does not start with the old folder
   */
  private resolveAbsoluteAddress (address: string): AbsoluteLinkTarget|null {
    const forwardPrefix = toForwardSlashes(this.legacyDirectory)
    const encodedPrefix = buildAbsoluteImageDestination(this.legacyDirectory)
    const prefixes: Array<{ prefix: string, encoded: boolean }> = encodedPrefix !== forwardPrefix
      ? [{ prefix: encodedPrefix, encoded: true }, { prefix: forwardPrefix, encoded: false }]
      : [{ prefix: forwardPrefix, encoded: false }]

    for (const { prefix, encoded } of prefixes) {
      if (address.length < prefix.length) {
        continue
      }

      const head = address.slice(0, prefix.length)
      const sameHead = this.caseInsensitive
        ? toForwardSlashes(head).toLowerCase() === prefix.toLowerCase()
        : toForwardSlashes(head) === prefix
      const next = address.charAt(prefix.length)
      if (!sameHead || (next !== '' && next !== '/' && next !== '\\')) {
        continue
      }

      const separator = head.includes('\\') ? '\\' : '/'
      // If the folder path needs no encoding, both spellings look alike; an
      // address that contains encoded characters is then treated as encoded.
      const isEncoded = encoded || (encodedPrefix === forwardPrefix && separator === '/' && PERCENT_ENCODING_PATTERN.test(address))

      const rest = address.slice(prefix.length)
      const decodedRest = isEncoded ? decodeAddress(rest) : rest
      return { target: path.join(this.legacyDirectory, toForwardSlashes(decodedRest)), encoded: isEncoded, separator, rest }
    }

    return null
  }

  /** Rewrites only targets that were present before any migration moves. */
  private rewriteAbsoluteAddress (address: string): string|null {
    const target = this.absoluteTargets.get(address)
    if (target === undefined || target === null) {
      return null
    }

    const newTarget = this.mapLegacyPath(target.target)
    const decodedRest = target.encoded ? decodeAddress(target.rest) : target.rest
    const plainTarget = path.join(this.newDirectory, toForwardSlashes(decodedRest))
    if (this.key(plainTarget) === this.key(newTarget)) {
      return this.formatAbsolute(this.newDirectory, target.encoded, target.separator) + target.rest
    }
    return this.formatAbsolute(newTarget, target.encoded, target.separator)
  }

  /**
   * Writes an absolute path in the style of a link address.
   *
   * @param   {string}     filePath   The path
   * @param   {boolean}    encoded    Whether to use forward slashes and percent-encoding
   * @param   {string}     separator  The separator to use otherwise
   *
   * @return  {string}                The address
   */
  private formatAbsolute (filePath: string, encoded: boolean, separator: string): string {
    if (encoded) {
      return buildAbsoluteImageDestination(filePath)
    }

    return separator === '/' ? toForwardSlashes(filePath) : filePath.replace(/\//g, '\\')
  }
}

/**
 * Migrates the old default scratch folder Zettlr_Unsaved inside the documents
 * folder to the new default Zettlr\__Unsaved (R135, spec C3). Nothing happens
 * (not-needed) if a custom scratch folder is configured. Without an old folder,
 * the result is completed with nothing moved. Otherwise every entry directly
 * inside the old folder moves to the new folder, and every entry of the old
 * _Discarded folder to the __Unsaved folder of the undo history folder; taken
 * names receive _2, _3, ... Links in the moved notes are rewritten. If every
 * entry was moved, the emptied old folders are removed and the result is
 * completed; otherwise nothing is removed and the result is partial, and the
 * next call moves what is left. The caller writes the new default folder into
 * the configuration if the result is completed.
 *
 * @param   {ScratchMigrationOptions}   options  The configured folder, the
 *                                               documents and undo history
 *                                               folders, the file system and
 *                                               the clock
 *
 * @return  {Promise<MigrationResult>}           The result
 */
export async function migrateLegacyScratchFolder (options: ScratchMigrationOptions): Promise<MigrationResult> {
  if (!isLegacyDefaultScratchDirectory(options.configured, options.documentsPath)) {
    return {
      status: 'not-needed',
      newDirectory: resolveScratchDirectory(options.configured, options.documentsPath),
      moved: [],
      failed: [],
      rewrittenLinks: []
    }
  }

  return await new ScratchFolderMigration(options).run()
}
