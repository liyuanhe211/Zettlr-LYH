/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        summarizeRuntimeErrors, archiveRuntimeErrors,
 *                  importLegacyRuntimeErrors, parseLegacyRuntimeErrorLine,
 *                  computeSignature, main
 * CVM-Role:        Utility
 * License:         GNU GPL v3
 *
 * Description:     Developer tool for the runtime error log that Zettlr writes
 *                  to <userData>/runtime-errors/runtime-errors.jsonl (one JSON
 *                  object per line). It has three subcommands:
 *
 *                  summary        Groups the active file by signature and
 *                                 prints one block per group. Read-only.
 *                  archive        Moves every line of one signature into
 *                                 runtime-errors/archive/<YYYY-MM>.jsonl,
 *                                 adding a "resolution" field.
 *                  import-legacy  Converts the "[Runtime Error]" lines of the
 *                                 daily logs in logs/ into entries of the
 *                                 active file, skipping those already there.
 *
 *                  Usage (from the project root):
 *                    node scripts/runtime-error-log.mjs summary
 *                    node scripts/runtime-error-log.mjs archive --signature <signature>
 *                         --status <fixed|harmless|not-reproducible|upstream>
 *                         --note "<note>" [--ref "<reference>"]
 *                    node scripts/runtime-error-log.mjs import-legacy [--since YYYY-MM-DD]
 *
 *                  Every subcommand accepts --data-dir <path> to work on
 *                  another userData directory; the default is the development
 *                  sandbox resources/test-cfg. All logic lives in exported
 *                  functions so that tests can call them; the command line
 *                  entry at the bottom only parses arguments and prints.
 *                  Only Node built-in modules are used.
 *
 * END HEADER
 */

import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { parseArgs } from 'util'

export const ACTIVE_FILE_NAME = 'runtime-errors.jsonl'
export const REVIEWING_FILE_NAME = 'runtime-errors.reviewing.jsonl'
export const ARCHIVE_STATUSES = ['fixed', 'harmless', 'not-reproducible', 'upstream']

const MAXIMUM_MESSAGE_LENGTH = 1000
const MAXIMUM_STACK_LENGTH = 4000
const ELLIPSIS = '…'
const SUPPRESSED_KIND = 'suppressed'
const UNKNOWN_WINDOW = 'Unknown window'
const STACK_FRAMES_IN_SUMMARY = 3
const RUNTIME_ERROR_TAG = '[Runtime Error]'

/** The labels formatRuntimeErrorLogEntry writes, mapped to entry kinds */
const LEGACY_KIND_LABELS = {
  'Uncaught error': 'error',
  'Unhandled promise rejection': 'unhandledrejection'
}

/**
 * An error caused by the user's input or by the state of the files, as
 * opposed to a bug in this script. The command line prints only its message.
 */
export class RuntimeErrorLogCommandError extends Error {
  constructor (message) {
    super(message)
    this.name = 'RuntimeErrorLogCommandError'
  }
}

/**
 * Returns the userData directory of the development sandbox, which
 * `yarn start` launches with --data-dir=resources/test-cfg.
 *
 * @return  {string}  The absolute path of resources/test-cfg
 */
export function getDefaultDataDirectory () {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
  return path.join(scriptDirectory, '..', 'resources', 'test-cfg')
}

/**
 * Returns the paths of all files this script works on.
 *
 * @param   {string}  dataDirectory  The userData directory
 *
 * @return  {object}                 The paths
 */
export function getRuntimeErrorPaths (dataDirectory) {
  const directory = path.join(dataDirectory, 'runtime-errors')
  return {
    directory,
    activeFile: path.join(directory, ACTIVE_FILE_NAME),
    reviewingFile: path.join(directory, REVIEWING_FILE_NAME),
    archiveDirectory: path.join(directory, 'archive'),
    logsDirectory: path.join(dataDirectory, 'logs')
  }
}

/**
 * Pads a number with leading zeros.
 */
function pad (value, length = 2) {
  return String(value).padStart(length, '0')
}

/**
 * Formats a date as local ISO 8601 with milliseconds and time zone offset,
 * e.g. 2026-10-14T11:20:28.000+08:00 (same format as the program writes).
 *
 * @param   {Date}    date  The date
 *
 * @return  {string}        The timestamp
 */
export function formatLocalTimestamp (date) {
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absoluteOffset = Math.abs(offsetMinutes)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`
}

/**
 * Formats the local calendar date of a date as YYYY-MM-DD.
 */
function formatLocalDate (date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Shortens text to at most maximumLength characters; shortened text ends with
 * an ellipsis and is then exactly maximumLength characters long.
 */
function truncate (text, maximumLength) {
  if (text.length <= maximumLength) {
    return text
  }
  return text.slice(0, maximumLength - ELLIPSIS.length) + ELLIPSIS
}

/**
 * Returns the function name of the first frame of a stack trace, or an empty
 * string if there is no stack, no recognisable frame, or the first frame has
 * no function name. Understands V8 frames ("at name (url:line:col)",
 * "at url:line:col") and Firefox frames ("name@url:line:col"). Must stay in
 * step with getFirstFrameFunctionName in
 * source/app/service-providers/log/runtime-error-log.ts.
 *
 * @param   {string|undefined}  stack  The stack trace
 *
 * @return  {string}                   The function name
 */
export function getFirstFrameFunctionName (stack) {
  if (typeof stack !== 'string') {
    return ''
  }
  const lines = stack.split(/\r?\n/).map(line => line.trim())

  const v8Frame = lines.find(line => line.startsWith('at '))
  if (v8Frame !== undefined) {
    const frame = v8Frame.slice(3).trim()
    // "name (location)" has a function name; a bare "location" has none
    const match = /^(.+?) \((.*)\)$/.exec(frame)
    if (match === null) {
      return ''
    }
    return match[1].replace(/^async /, '').trim()
  }

  for (const line of lines) {
    const match = /^([^@]*)@(.+):\d+:\d+$/.exec(line)
    if (match !== null) {
      return match[1].trim()
    }
  }

  return ''
}

/**
 * Computes the 12-hex-character signature of an error: the SHA-1 of kind,
 * the message with every run of digits replaced by N, and the function name
 * of the first stack frame, joined by "|". Must stay in step with
 * computeSignature in source/app/service-providers/log/runtime-error-log.ts.
 *
 * @param   {string}            kind     The entry kind
 * @param   {string}            message  The untruncated message
 * @param   {string|undefined}  stack    The stack trace, if any
 *
 * @return  {string}                     The signature
 */
export function computeSignature (kind, message, stack) {
  const normalisedMessage = message.replace(/\d+/g, 'N')
  const functionName = getFirstFrameFunctionName(stack)
  return createHash('sha1')
    .update(`${kind}|${normalisedMessage}|${functionName}`, 'utf8')
    .digest('hex')
    .slice(0, 12)
}

/**
 * Reads a JSON Lines file. Empty lines are dropped; every other line keeps
 * its original text, and its parsed object if it is a JSON object.
 *
 * @param   {string}  filePath  The file
 *
 * @return  {Array<{text: string, entry: object|null}>}  The lines
 */
function readJsonLines (filePath) {
  const content = fs.readFileSync(filePath, 'utf8')
  const lines = []
  for (const text of content.split(/\r?\n/)) {
    if (text.trim() === '') {
      continue
    }
    let entry = null
    try {
      const parsed = JSON.parse(text)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        entry = parsed
      }
    } catch (error) {
      entry = null
    }
    lines.push({ text, entry })
  }
  return lines
}

/**
 * Appends lines to a file, creating it if necessary. If the file does not end
 * with a line break, one is inserted first so that no two lines merge.
 *
 * @param   {string}    filePath  The file
 * @param   {string[]}  lines     The lines, without line breaks
 */
function appendLines (filePath, lines) {
  if (lines.length === 0) {
    return
  }
  let prefix = ''
  if (fs.existsSync(filePath)) {
    const size = fs.statSync(filePath).size
    if (size > 0) {
      const descriptor = fs.openSync(filePath, 'r')
      try {
        const lastByte = Buffer.alloc(1)
        fs.readSync(descriptor, lastByte, 0, 1, size - 1)
        if (lastByte[0] !== 0x0A) {
          prefix = '\n'
        }
      } finally {
        fs.closeSync(descriptor)
      }
    }
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.appendFileSync(filePath, prefix + lines.join('\n') + '\n', 'utf8')
}

/**
 * Turns a timestamp into a number for sorting; unreadable timestamps sort
 * first.
 */
function timeValue (time) {
  const value = typeof time === 'string' ? Date.parse(time) : NaN
  return Number.isNaN(value) ? -Infinity : value
}

/**
 * Returns the first frames of a stack trace (the lines after the message).
 *
 * @param   {string|undefined}  stack   The stack trace
 * @param   {number}            count   How many frames
 *
 * @return  {string[]}                  The frames, trimmed
 */
export function getStackFrames (stack, count) {
  if (typeof stack !== 'string') {
    return []
  }
  return stack.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.startsWith('at ') || /^[^@\s]*@.+:\d+:\d+$/.test(line))
    .slice(0, count)
}

/**
 * Groups the active runtime error log by signature. Suppression markers (kind
 * "suppressed") are counted in the group of their signature, not grouped on
 * their own. Read-only.
 *
 * @param   {object}  options                The options
 * @param   {string}  options.dataDirectory  The userData directory
 *
 * @return  {object}                         The summary: activeFile, exists,
 *                                           entryCount, suppressedCount,
 *                                           unparsableLineCount,
 *                                           unmatchedSuppressedSignatures and
 *                                           groups (newest last occurrence
 *                                           first)
 */
export function summarizeRuntimeErrors ({ dataDirectory }) {
  const { activeFile } = getRuntimeErrorPaths(dataDirectory)
  const result = {
    activeFile,
    exists: fs.existsSync(activeFile),
    entryCount: 0,
    suppressedCount: 0,
    unparsableLineCount: 0,
    unmatchedSuppressedSignatures: [],
    groups: []
  }
  if (!result.exists) {
    return result
  }

  const groups = new Map()
  const suppressedBySignature = new Map()
  for (const { entry } of readJsonLines(activeFile)) {
    if (entry === null || typeof entry.signature !== 'string') {
      result.unparsableLineCount++
      continue
    }

    if (entry.kind === SUPPRESSED_KIND) {
      result.suppressedCount++
      suppressedBySignature.set(entry.signature, (suppressedBySignature.get(entry.signature) ?? 0) + 1)
      continue
    }

    result.entryCount++
    let group = groups.get(entry.signature)
    if (group === undefined) {
      group = { signature: entry.signature, count: 0, firstTime: entry.time, lastTime: entry.time, latest: entry }
      groups.set(entry.signature, group)
    }
    group.count++
    if (timeValue(entry.time) < timeValue(group.firstTime)) {
      group.firstTime = entry.time
    }
    if (timeValue(entry.time) >= timeValue(group.lastTime)) {
      group.lastTime = entry.time
      group.latest = entry
    }
  }

  for (const [signature, count] of suppressedBySignature) {
    if (!groups.has(signature)) {
      result.unmatchedSuppressedSignatures.push({ signature, count })
    }
  }

  result.groups = [...groups.values()]
    .sort((left, right) => timeValue(right.lastTime) - timeValue(left.lastTime))
    .map(group => ({
      signature: group.signature,
      count: group.count,
      suppressedCount: suppressedBySignature.get(group.signature) ?? 0,
      firstTime: group.firstTime,
      lastTime: group.lastTime,
      kind: group.latest.kind,
      process: group.latest.process,
      window: group.latest.window,
      message: group.latest.message,
      location: group.latest.location,
      stackFrames: getStackFrames(group.latest.stack, STACK_FRAMES_IN_SUMMARY)
    }))
  return result
}

/**
 * Turns a summary into the text the command line prints.
 *
 * @param   {object}  summary  The result of summarizeRuntimeErrors
 *
 * @return  {string}           The text
 */
export function formatSummary (summary) {
  if (!summary.exists) {
    return `No runtime error log found at ${summary.activeFile}. Nothing to review.`
  }

  const lines = [
    `Runtime error log: ${summary.activeFile}`,
    `${summary.entryCount} entries in ${summary.groups.length} groups, ` +
      `${summary.suppressedCount} suppression markers, ${summary.unparsableLineCount} unparsable lines`
  ]
  summary.groups.forEach((group, index) => {
    const suppressed = group.suppressedCount > 0 ? ` (+${group.suppressedCount} suppression markers)` : ''
    lines.push('')
    lines.push(`[${index + 1}] ${group.signature}  ${group.count}x${suppressed}`)
    lines.push(`    first:    ${group.firstTime}`)
    lines.push(`    last:     ${group.lastTime}`)
    lines.push(`    kind:     ${group.kind}  (${group.process ?? 'unknown process'}, ${group.window ?? UNKNOWN_WINDOW})`)
    lines.push(`    message:  ${group.message}`)
    if (group.location !== undefined) {
      lines.push(`    location: ${group.location}`)
    }
    group.stackFrames.forEach((frame, frameIndex) => {
      lines.push(`    ${frameIndex === 0 ? 'stack:   ' : '         '} ${frame}`)
    })
  })
  for (const { signature, count } of summary.unmatchedSuppressedSignatures) {
    lines.push('')
    lines.push(`${count} suppression markers of signature ${signature} without any remaining entry`)
  }
  return lines.join('\n')
}

/**
 * Puts the lines of a reviewing file back into the active file and deletes
 * the reviewing file. Appending (instead of renaming back) never overwrites
 * lines the program wrote meanwhile.
 *
 * @param   {object}  paths  The result of getRuntimeErrorPaths
 *
 * @return  {number}         How many lines were put back
 */
function restoreReviewingFile (paths) {
  const lines = readJsonLines(paths.reviewingFile).map(line => line.text)
  appendLines(paths.activeFile, lines)
  fs.unlinkSync(paths.reviewingFile)
  return lines.length
}

/**
 * Moves every line of one signature, suppression markers included, from the
 * active file into the archive file of the current month, adding the field
 * resolution: { date, status, note, ref }. The active file is first renamed to
 * runtime-errors.reviewing.jsonl, so that the program can keep writing into a
 * fresh active file; the remaining lines are then appended to the active file
 * after anything the program wrote meanwhile, and the reviewing file is
 * deleted. A reviewing file left by an interrupted earlier run is put back
 * into the active file first.
 *
 * @param   {object}    options                The options
 * @param   {string}    options.dataDirectory  The userData directory
 * @param   {string}    options.signature      The signature to archive
 * @param   {string}    options.status         One of ARCHIVE_STATUSES
 * @param   {string}    options.note           One sentence on what was done
 * @param   {string}    [options.ref]          Commit, requirement or decision
 * @param   {Date}      [options.now]          The time of archiving
 * @param   {Function}  [options.afterRename]  Test hook, called after the
 *                                             rename and before writing back
 *
 * @return  {object}  archivedCount, keptCount, archiveFile,
 *                    recoveredLineCount
 */
export function archiveRuntimeErrors ({ dataDirectory, signature, status, note, ref = '', now = new Date(), afterRename }) {
  if (typeof signature !== 'string' || signature.trim() === '') {
    throw new RuntimeErrorLogCommandError('Missing --signature.')
  }
  if (!ARCHIVE_STATUSES.includes(status)) {
    throw new RuntimeErrorLogCommandError(`--status must be one of: ${ARCHIVE_STATUSES.join(', ')}.`)
  }
  if (typeof note !== 'string' || note.trim() === '') {
    throw new RuntimeErrorLogCommandError('Missing --note: describe in one sentence how the error was dealt with.')
  }
  const reference = typeof ref === 'string' ? ref : ''
  const wantedSignature = signature.trim()

  const paths = getRuntimeErrorPaths(dataDirectory)
  let recoveredLineCount = 0
  if (fs.existsSync(paths.reviewingFile)) {
    recoveredLineCount = restoreReviewingFile(paths)
  }

  if (!fs.existsSync(paths.activeFile)) {
    throw new RuntimeErrorLogCommandError(`No runtime error log found at ${paths.activeFile}. Nothing to archive.`)
  }

  try {
    fs.renameSync(paths.activeFile, paths.reviewingFile)
  } catch (error) {
    throw new RuntimeErrorLogCommandError(
      `Could not rename ${paths.activeFile} (${error.message}). ` +
      'It may be in use by Zettlr right now; nothing was changed, please try again.'
    )
  }

  let lines
  try {
    if (typeof afterRename === 'function') {
      afterRename()
    }
    lines = readJsonLines(paths.reviewingFile)
  } catch (error) {
    restoreReviewingFile(paths)
    throw error
  }

  const archived = []
  const kept = []
  for (const line of lines) {
    if (line.entry !== null && line.entry.signature === wantedSignature) {
      archived.push(line)
    } else {
      kept.push(line.text)
    }
  }

  if (archived.length === 0) {
    restoreReviewingFile(paths)
    throw new RuntimeErrorLogCommandError(
      `Signature ${wantedSignature} does not occur in ${paths.activeFile}. Nothing was archived.`
    )
  }

  const resolution = { date: formatLocalDate(now), status, note: note.trim(), ref: reference }
  const archiveFile = path.join(paths.archiveDirectory, `${now.getFullYear()}-${pad(now.getMonth() + 1)}.jsonl`)
  try {
    appendLines(archiveFile, archived.map(line => JSON.stringify({ ...line.entry, resolution })))
  } catch (error) {
    restoreReviewingFile(paths)
    throw new RuntimeErrorLogCommandError(`Could not write ${archiveFile} (${error.message}). Nothing was archived.`)
  }

  // If this fails, the reviewing file stays; the next archive run puts it back
  appendLines(paths.activeFile, kept)
  fs.unlinkSync(paths.reviewingFile)

  return { archivedCount: archived.length, keptCount: kept.length, archiveFile, recoveredLineCount }
}

/**
 * Parses the part of a daily log line that starts with "[Runtime Error]", in
 * the format of formatRuntimeErrorLogEntry:
 *   [Runtime Error] [<window>] <Uncaught error|Unhandled promise rejection>:
 *   <message>[ (<location>)][ | Stack: <frames joined by " --> ">]
 * Fields that cannot be recognised fall back to "Unknown window", "error" and
 * the whole text as the message.
 *
 * @param   {string}  text  The text from "[Runtime Error]" on
 *
 * @return  {object}        window, kind, message, location?, stack?
 */
export function parseLegacyRuntimeErrorLine (text) {
  const rest = text.startsWith(RUNTIME_ERROR_TAG) ? text.slice(RUNTIME_ERROR_TAG.length).trimStart() : text
  const kindLabels = Object.keys(LEGACY_KIND_LABELS).join('|')
  const match = new RegExp(`^\\[(.*?)\\] (${kindLabels}): `).exec(rest)
  if (match === null) {
    const windowMatch = /^\[([^\]]*)\]/.exec(rest)
    return {
      window: windowMatch !== null && windowMatch[1] !== '' ? windowMatch[1] : UNKNOWN_WINDOW,
      kind: 'error',
      message: text
    }
  }

  const parsed = {
    window: match[1] !== '' ? match[1] : UNKNOWN_WINDOW,
    kind: LEGACY_KIND_LABELS[match[2]]
  }
  let body = rest.slice(match[0].length)

  const stackIndex = body.indexOf(' | Stack: ')
  if (stackIndex >= 0) {
    parsed.stack = body.slice(stackIndex + ' | Stack: '.length).split(' --> ').join('\n')
    body = body.slice(0, stackIndex)
  }

  const locationMatch = /^([\s\S]*) \(([^\s()]+)\)$/.exec(body)
  if (locationMatch !== null) {
    parsed.message = locationMatch[1]
    parsed.location = locationMatch[2]
  } else {
    parsed.message = body
  }
  return parsed
}

/**
 * Builds an error log entry from one "[Runtime Error]" line of a daily log.
 *
 * @param   {string}  fileDate  The date in the log file name, YYYY-MM-DD
 * @param   {string}  clock     The time at the start of the line, HH:MM:SS
 * @param   {string}  text      The text from "[Runtime Error]" on
 *
 * @return  {object}            The entry, fields in the program's order
 */
export function buildLegacyEntry (fileDate, clock, text) {
  const [year, month, day] = fileDate.split('-').map(Number)
  const [hours, minutes, seconds] = clock.split(':').map(Number)
  const parsed = parseLegacyRuntimeErrorLine(text)

  const entry = {
    time: formatLocalTimestamp(new Date(year, month - 1, day, hours, minutes, seconds, 0)),
    process: 'renderer',
    window: parsed.window,
    kind: parsed.kind,
    message: truncate(parsed.message, MAXIMUM_MESSAGE_LENGTH)
  }
  if (parsed.location !== undefined) {
    entry.location = parsed.location
  }
  if (parsed.stack !== undefined) {
    entry.stack = truncate(parsed.stack, MAXIMUM_STACK_LENGTH)
  }
  entry.signature = computeSignature(parsed.kind, parsed.message, parsed.stack)
  return entry
}

/**
 * Counts the time plus signature keys of every entry already recorded: in the
 * active file, a leftover reviewing file, and all archive files.
 *
 * @param   {object}  paths  The result of getRuntimeErrorPaths
 *
 * @return  {Map<string, number>}  Key to number of occurrences
 */
function collectExistingKeys (paths) {
  const files = [paths.activeFile, paths.reviewingFile]
  if (fs.existsSync(paths.archiveDirectory)) {
    for (const name of fs.readdirSync(paths.archiveDirectory)) {
      if (name.endsWith('.jsonl')) {
        files.push(path.join(paths.archiveDirectory, name))
      }
    }
  }

  const keys = new Map()
  for (const file of files) {
    if (!fs.existsSync(file)) {
      continue
    }
    for (const { entry } of readJsonLines(file)) {
      if (entry !== null) {
        const key = `${entry.time}|${entry.signature}`
        keys.set(key, (keys.get(key) ?? 0) + 1)
      }
    }
  }
  return keys
}

/**
 * Converts the "[Runtime Error]" lines of the daily logs (logs/YYYY-MM-DD.log)
 * into error log entries and appends them to the active file. Lines whose
 * time plus signature is already recorded are skipped; the comparison counts
 * occurrences, so two identical lines in the same second are both imported
 * once and never again.
 *
 * @param   {object}  options                The options
 * @param   {string}  options.dataDirectory  The userData directory
 * @param   {string}  [options.since]        Skip logs before this date
 *
 * @return  {object}  activeFile, logsDirectory, scannedFileCount,
 *                    importedCount, skippedCount
 */
export function importLegacyRuntimeErrors ({ dataDirectory, since }) {
  if (since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    throw new RuntimeErrorLogCommandError('--since must be a date in the form YYYY-MM-DD.')
  }

  const paths = getRuntimeErrorPaths(dataDirectory)
  const result = {
    activeFile: paths.activeFile,
    logsDirectory: paths.logsDirectory,
    scannedFileCount: 0,
    importedCount: 0,
    skippedCount: 0
  }
  if (!fs.existsSync(paths.logsDirectory)) {
    return result
  }

  const logFiles = fs.readdirSync(paths.logsDirectory)
    .filter(name => /^\d{4}-\d{2}-\d{2}\.log$/.test(name))
    .map(name => name.slice(0, 10))
    .filter(fileDate => since === undefined || fileDate >= since)
    .sort()

  const existingKeys = collectExistingKeys(paths)
  const newLines = []
  // A line starts with the time, optionally followed by a level tag such as [Error]
  const linePattern = /^\[(\d{2}:\d{2}:\d{2})\] (?:\[[^\]]*\] )?(\[Runtime Error\] .*)$/
  for (const fileDate of logFiles) {
    result.scannedFileCount++
    const content = fs.readFileSync(path.join(paths.logsDirectory, `${fileDate}.log`), 'utf8')
    for (const line of content.split(/\r?\n/)) {
      const match = linePattern.exec(line)
      if (match === null) {
        continue
      }
      const entry = buildLegacyEntry(fileDate, match[1], match[2])
      const key = `${entry.time}|${entry.signature}`
      const existing = existingKeys.get(key) ?? 0
      if (existing > 0) {
        existingKeys.set(key, existing - 1)
        result.skippedCount++
        continue
      }
      newLines.push(JSON.stringify(entry))
      result.importedCount++
    }
  }

  appendLines(paths.activeFile, newLines)
  return result
}

const USAGE = [
  'Usage: node scripts/runtime-error-log.mjs <command> [options]',
  '',
  'Commands:',
  '  summary                      Group the runtime error log by signature (read-only)',
  '  archive --signature <signature> --status <fixed|harmless|not-reproducible|upstream>',
  '          --note "<note>" [--ref "<reference>"]',
  '                               Move all lines of a signature into the monthly archive',
  '  import-legacy [--since YYYY-MM-DD]',
  '                               Import the [Runtime Error] lines of the daily logs',
  '',
  'Options:',
  '  --data-dir <path>            userData directory (default: resources/test-cfg)'
].join('\n')

/**
 * The command line entry: parses the arguments, runs the subcommand and
 * prints the result.
 *
 * @param   {string[]}  argv  The arguments after the script path
 *
 * @return  {number}          The exit code
 */
export function main (argv) {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        'data-dir': { type: 'string' },
        signature: { type: 'string' },
        status: { type: 'string' },
        note: { type: 'string' },
        ref: { type: 'string' },
        since: { type: 'string' },
        help: { type: 'boolean', short: 'h' }
      }
    })
  } catch (error) {
    console.error(`Error: ${error.message}\n\n${USAGE}`)
    return 1
  }

  const { values, positionals } = parsed
  const command = positionals[0]
  if (values.help === true || command === undefined) {
    console.log(USAGE)
    return values.help === true ? 0 : 1
  }
  if (positionals.length > 1) {
    console.error(`Error: Unexpected argument "${positionals[1]}".\n\n${USAGE}`)
    return 1
  }

  const dataDirectory = values['data-dir'] !== undefined ? path.resolve(values['data-dir']) : getDefaultDataDirectory()
  try {
    if (command === 'summary') {
      console.log(formatSummary(summarizeRuntimeErrors({ dataDirectory })))
    } else if (command === 'archive') {
      const result = archiveRuntimeErrors({
        dataDirectory,
        signature: values.signature,
        status: values.status,
        note: values.note,
        ref: values.ref
      })
      if (result.recoveredLineCount > 0) {
        console.log(`Put ${result.recoveredLineCount} lines of a leftover ${REVIEWING_FILE_NAME} back into the log first.`)
      }
      console.log(`Archived ${result.archivedCount} lines of signature ${values.signature.trim()} to ${result.archiveFile}; ${result.keptCount} other lines remain.`)
    } else if (command === 'import-legacy') {
      const result = importLegacyRuntimeErrors({ dataDirectory, since: values.since })
      if (result.scannedFileCount === 0) {
        console.log(`No daily logs to scan in ${result.logsDirectory}.`)
      } else {
        console.log(`Scanned ${result.scannedFileCount} daily logs: imported ${result.importedCount} entries into ${result.activeFile}, skipped ${result.skippedCount} already recorded.`)
      }
    } else {
      console.error(`Error: Unknown command "${command}".\n\n${USAGE}`)
      return 1
    }
  } catch (error) {
    if (error instanceof RuntimeErrorLogCommandError) {
      console.error(`Error: ${error.message}`)
      return 1
    }
    throw error
  }
  return 0
}

/**
 * Whether this file was started directly (not imported by a test).
 */
function isDirectRun () {
  if (process.argv[1] === undefined) {
    return false
  }
  const scriptPath = fileURLToPath(import.meta.url)
  const startedPath = path.resolve(process.argv[1])
  return process.platform === 'win32'
    ? scriptPath.toLowerCase() === startedPath.toLowerCase()
    : scriptPath === startedPath
}

if (isDirectRun()) {
  process.exitCode = main(process.argv.slice(2))
}
