/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        rewriteShortcutImageLinks, resolveShortcutImagesInSourceFiles
 * CVM-Role:        Utility Function
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Lets exports embed the real image of a Markdown image that
 *                  links a Windows shortcut (.lnk). Pandoc cannot read a
 *                  shortcut as an image, so the image links that end with
 *                  ".lnk" are rewritten in a temporary copy of the Markdown
 *                  file to the file the shortcut points to: written as a path
 *                  relative to the folder the export runs in, or as a file URL
 *                  if there is no relative path (the image is on another
 *                  drive). An absolute path such as E:/Figures/a.png must not
 *                  be written, because browsers and the HTML that Pandoc makes
 *                  take "E:" for a URL scheme. The image title and the Pandoc
 *                  attributes behind the link, such as {width=100%}, are kept
 *                  as they are. Code in fenced code blocks and inline code
 *                  spans is never changed. Main process only; Electron is not
 *                  needed by this module.
 *
 * END HEADER
 */

import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { hasMarkdownExt } from '@common/util/file-extention-checks'

/**
 * Finds the file a shortcut points to: given the absolute path of the .lnk
 * file, returns the absolute path of the existing image, or undefined.
 */
export type ShortcutResolver = (absoluteShortcutPath: string) => string|undefined

/**
 * The result of rewriting the image links of one Markdown text.
 */
export interface ShortcutRewriteResult {
  /** The Markdown text with the shortcut image links rewritten */
  markdown: string
  /** The number of image links that were rewritten */
  resolved: number
  /** The absolute paths of the shortcuts that could not be resolved */
  unresolved: string[]
}

/**
 * Everything the rewriting of one Markdown text shares between its lines.
 */
interface RewriteContext {
  baseDirectory: string
  resolve: ShortcutResolver
  /** Per image address as written in the Markdown: the target path, or undefined */
  targets: Map<string, string|undefined>
  resolved: number
  unresolved: string[]
}

/**
 * The position of an inline image in a line, such as ![alt](<dest> "title").
 */
interface InlineImage {
  /** The image address, without the angle brackets */
  address: string
  /** The index of the first character of the address, with its angle bracket */
  destinationStart: number
  /** The index behind the last character of the address, with its angle bracket */
  destinationEnd: number
  /** The index behind the closing parenthesis of the image */
  end: number
}

/** An address that names a shortcut file; a query string is not supported. */
const SHORTCUT_ADDRESS = /\.lnk$/i

/**
 * Returns the local absolute paths an image address may mean: the address as
 * written and, if percent-encoded, the decoded address. Addresses with a
 * scheme other than file (https:, data:, ...) are no local paths. A single
 * letter before the colon is a drive letter, not a scheme.
 *
 * @param   {string}    address        The address as written in the Markdown
 * @param   {string}    baseDirectory  The folder that relative addresses are
 *                                     relative to
 *
 * @return  {string[]}                 The candidate absolute paths
 */
function localPathsOfAddress (address: string, baseDirectory: string): string[] {
  const variants = [address]
  try {
    const decoded = decodeURI(address)
    if (decoded !== address) {
      variants.push(decoded)
    }
  } catch {
    // Not valid percent-encoding: the address is a plain path
  }

  const localPaths: string[] = []
  for (const variant of variants) {
    if (/^file:\/\//i.test(variant)) {
      try {
        localPaths.push(fileURLToPath(variant))
      } catch {
        // Not a usable file URL on this platform
      }
    } else if (!/^[a-z][a-z0-9+.-]+:/i.test(variant)) {
      localPaths.push(path.isAbsolute(variant) ? variant : path.resolve(baseDirectory, variant))
    }
  }

  return localPaths
}

/**
 * Returns the address by which an image is written into the Markdown: its path
 * relative to the base directory, with forward slashes, or its file URL if no
 * relative path exists (on Windows, if the image is on another drive).
 *
 * @param   {string}  imagePath      The absolute path of the image
 * @param   {string}  baseDirectory  The folder that relative addresses are
 *                                   relative to
 *
 * @return  {string}                 The address to write
 */
function addressOfImage (imagePath: string, baseDirectory: string): string {
  const relativePath = path.relative(baseDirectory, imagePath)
  if (relativePath === '' || path.isAbsolute(relativePath)) {
    return pathToFileURL(imagePath).href
  }

  return relativePath.split(path.sep).join('/')
}

/**
 * Follows the shortcut that an image address names.
 *
 * @param   {string}          address  The address as written in the Markdown
 * @param   {RewriteContext}  context  The state of the current rewriting
 *
 * @return  {string|undefined}         The address of the real image (see
 *                                     addressOfImage), or undefined if the
 *                                     address names no shortcut or the shortcut
 *                                     cannot be resolved
 */
function followShortcutAddress (address: string, context: RewriteContext): string|undefined {
  if (!SHORTCUT_ADDRESS.test(address)) {
    return undefined
  }

  if (context.targets.has(address)) {
    return context.targets.get(address)
  }

  const shortcutPaths = localPathsOfAddress(address, context.baseDirectory)
  let target: string|undefined
  for (const shortcutPath of shortcutPaths) {
    const candidate = context.resolve(shortcutPath)
    // Angle brackets and line breaks cannot be written into an image link
    if (candidate !== undefined && !/[<>\r\n]/.test(candidate)) {
      target = addressOfImage(candidate, context.baseDirectory)
      break
    }
  }

  if (target === undefined && shortcutPaths.length > 0 && !context.unresolved.includes(shortcutPaths[0])) {
    context.unresolved.push(shortcutPaths[0])
  }

  context.targets.set(address, target)
  return target
}

/**
 * Reads an inline image that starts at the given "![" in the line. Only the
 * form ![alt](address) and ![alt](address "title") is recognized, in which the
 * address is either written in angle brackets (and may then contain spaces)
 * or contains no spaces and has balanced parentheses.
 *
 * @param   {string}                line   The line of Markdown
 * @param   {number}                start  The index of the "!"
 *
 * @return  {InlineImage|undefined}        The image, or undefined if the text
 *                                         at start is no inline image
 */
function readInlineImage (line: string, start: number): InlineImage|undefined {
  // The alt text ends at the closing bracket that matches the opening one
  let index = start + 2
  let depth = 0
  for (; index < line.length; index++) {
    const character = line[index]
    if (character === '\\') {
      index++
    } else if (character === '[') {
      depth++
    } else if (character === ']') {
      if (depth === 0) {
        break
      }
      depth--
    }
  }

  if (index >= line.length || line[index + 1] !== '(') {
    return undefined
  }

  index += 2
  while (line[index] === ' ' || line[index] === '\t') {
    index++
  }

  const destinationStart = index
  let address: string
  let destinationEnd: number
  if (line[index] === '<') {
    let close = index + 1
    for (; close < line.length; close++) {
      if (line[close] === '\\') {
        close++
      } else if (line[close] === '<') {
        return undefined
      } else if (line[close] === '>') {
        break
      }
    }

    if (close >= line.length) {
      return undefined
    }

    address = line.slice(index + 1, close)
    destinationEnd = close + 1
  } else {
    let close = index
    let parentheses = 0
    for (; close < line.length; close++) {
      const character = line[close]
      if (character === '\\') {
        close++
      } else if (character === ' ' || character === '\t' || character === '\r') {
        break
      } else if (character === '(') {
        parentheses++
      } else if (character === ')') {
        if (parentheses === 0) {
          break
        }
        parentheses--
      }
    }

    address = line.slice(index, close)
    destinationEnd = close
  }

  // Behind the address, only an optional title and the closing parenthesis may follow
  index = destinationEnd
  while (line[index] === ' ' || line[index] === '\t') {
    index++
  }

  if (line[index] === ')') {
    return { address, destinationStart, destinationEnd, end: index + 1 }
  }

  const opener = line[index]
  if (opener !== '"' && opener !== '\'' && opener !== '(') {
    return undefined
  }

  const closer = opener === '(' ? ')' : opener
  let titleEnd = index + 1
  for (; titleEnd < line.length; titleEnd++) {
    if (line[titleEnd] === '\\') {
      titleEnd++
    } else if (line[titleEnd] === closer) {
      break
    }
  }

  if (titleEnd >= line.length) {
    return undefined
  }

  index = titleEnd + 1
  while (line[index] === ' ' || line[index] === '\t') {
    index++
  }

  return line[index] === ')' ? { address, destinationStart, destinationEnd, end: index + 1 } : undefined
}

/**
 * Finds the start of the backtick run of exactly the given length that closes
 * an inline code span.
 *
 * @param   {string}  line    The line of Markdown
 * @param   {number}  from    The index to start searching at
 * @param   {number}  length  The number of backticks of the opening run
 *
 * @return  {number}          The index of the closing run, or -1
 */
function findClosingBackticks (line: string, from: number, length: number): number {
  let index = from
  while (index < line.length) {
    if (line[index] !== '`') {
      index++
      continue
    }

    let runEnd = index
    while (runEnd < line.length && line[runEnd] === '`') {
      runEnd++
    }

    if (runEnd - index === length) {
      return index
    }

    index = runEnd
  }

  return -1
}

/**
 * Rewrites the shortcut images of one line that is not in a fenced code block.
 *
 * @param   {string}          line     The line of Markdown, without its "\n"
 * @param   {RewriteContext}  context  The state of the current rewriting
 *
 * @return  {string}                   The rewritten line
 */
function rewriteLine (line: string, context: RewriteContext): string {
  let output = ''
  let index = 0
  while (index < line.length) {
    const character = line[index]

    if (character === '\\') {
      // The next character is escaped and cannot start any markup
      output += line.slice(index, index + 2)
      index += 2
    } else if (character === '`') {
      let runEnd = index
      while (runEnd < line.length && line[runEnd] === '`') {
        runEnd++
      }

      // Inline code is copied unchanged; an unclosed backtick run is plain text
      const closing = findClosingBackticks(line, runEnd, runEnd - index)
      const codeEnd = closing >= 0 ? closing + (runEnd - index) : runEnd
      output += line.slice(index, codeEnd)
      index = codeEnd
    } else if (character === '!' && line[index + 1] === '[') {
      const image = readInlineImage(line, index)
      if (image === undefined) {
        output += character
        index++
        continue
      }

      const target = followShortcutAddress(image.address, context)
      if (target === undefined) {
        output += line.slice(index, image.end)
      } else {
        context.resolved++
        output += line.slice(index, image.destinationStart) + `<${target}>` + line.slice(image.destinationEnd, image.end)
      }
      index = image.end
    } else if (character === '<' && /^<img[\s/>]/i.test(line.slice(index, index + 5)) && line.indexOf('>', index) >= 0) {
      const tagEnd = line.indexOf('>', index) + 1
      output += line.slice(index, tagEnd).replace(
        /(\ssrc\s*=\s*)(["'])(.*?)\2/i,
        (match: string, prefix: string, quote: string, address: string) => {
          const target = followShortcutAddress(address, context)
          if (target === undefined || target.includes(quote)) {
            return match
          }

          context.resolved++
          return `${prefix}${quote}${target}${quote}`
        }
      )
      index = tagEnd
    } else {
      output += character
      index++
    }
  }

  return output
}

/**
 * Replaces the image links that name a shortcut (".lnk") by the file the
 * shortcut points to: its path relative to the base directory (with forward
 * slashes), or its file URL if there is no relative path. An inline image is
 * written with the address in angle brackets, an HTML image without them.
 * Handles inline images, written as
 * ![alt](<address.lnk> "title") or ![alt](address.lnk), and HTML <img> tags
 * with a src attribute, on a single line. Relative addresses are relative to
 * the base directory. An address with percent-encoding is first tried as it is
 * written and then decoded. Fenced code blocks and inline code are not
 * changed, and neither are shortcuts that cannot be resolved.
 *
 * @param   {string}           markdown       The Markdown text
 * @param   {string}           baseDirectory  The folder that relative image
 *                                            addresses are relative to
 * @param   {ShortcutResolver} resolve        Finds the image of a shortcut
 *
 * @return  {ShortcutRewriteResult}           The new text, the number of
 *                                            rewritten links, and the
 *                                            shortcuts that did not resolve
 */
export function rewriteShortcutImageLinks (markdown: string, baseDirectory: string, resolve: ShortcutResolver): ShortcutRewriteResult {
  if (!/\.lnk/i.test(markdown)) {
    return { markdown, resolved: 0, unresolved: [] }
  }

  const context: RewriteContext = {
    baseDirectory,
    resolve,
    targets: new Map(),
    resolved: 0,
    unresolved: []
  }

  const lines = markdown.split('\n')
  let fence: { character: string, length: number }|undefined
  for (const [ lineIndex, line ] of lines.entries()) {
    const text = line.replace(/\r$/, '')

    if (fence !== undefined) {
      const closing = /^\s*(`{3,}|~{3,})\s*$/.exec(text)
      if (closing !== null && closing[1][0] === fence.character && closing[1].length >= fence.length) {
        fence = undefined
      }
      continue
    }

    const opening = /^\s*(`{3,}|~{3,})(.*)$/.exec(text)
    if (opening !== null && !(opening[1][0] === '`' && opening[2].includes('`'))) {
      fence = { character: opening[1][0], length: opening[1].length }
      continue
    }

    lines[lineIndex] = rewriteLine(line, context)
  }

  return {
    markdown: lines.join('\n'),
    resolved: context.resolved,
    unresolved: context.unresolved
  }
}

/**
 * Replaces every Markdown source file with an image link to a shortcut by a
 * temporary copy in which the link points to the real image. The copies keep
 * their file names and live in a fresh temporary directory, one subdirectory
 * per file. The export runs in the working directory of the document, so the
 * relative paths of the other images keep working as with the unchanged files.
 *
 * @param   {string[]}          inputFiles       The source files
 * @param   {Function}          baseDirectoryFor Returns the folder that the
 *                                               relative image addresses of a
 *                                               source file are relative to
 * @param   {ShortcutResolver}  resolve          Finds the image of a shortcut
 * @param   {string}            temporaryRoot    The folder for the temporary
 *                                               directory (the temp folder of
 *                                               the system by default)
 *
 * @return  {Promise}                            The files to export, the
 *                                               directory to delete
 *                                               afterwards (if one was created),
 *                                               the number of rewritten links,
 *                                               and the shortcuts that did not
 *                                               resolve
 */
export async function resolveShortcutImagesInSourceFiles (
  inputFiles: string[],
  baseDirectoryFor: (inputFile: string) => string,
  resolve: ShortcutResolver,
  temporaryRoot: string = os.tmpdir()
): Promise<{ inputFiles: string[], temporaryDirectory: string|undefined, resolved: number, unresolved: string[] }> {
  let temporaryDirectory: string|undefined
  let resolved = 0
  const unresolved: string[] = []
  const preparedFiles: string[] = []

  try {
    for (const [ index, inputFile ] of inputFiles.entries()) {
      if (!hasMarkdownExt(inputFile)) {
        preparedFiles.push(inputFile)
        continue
      }

      const markdown = await fs.readFile(inputFile, 'utf8')
      const rewritten = rewriteShortcutImageLinks(markdown, baseDirectoryFor(inputFile), resolve)
      for (const shortcutPath of rewritten.unresolved) {
        if (!unresolved.includes(shortcutPath)) {
          unresolved.push(shortcutPath)
        }
      }

      if (rewritten.markdown === markdown) {
        preparedFiles.push(inputFile)
        continue
      }

      if (temporaryDirectory === undefined) {
        temporaryDirectory = await fs.mkdtemp(path.join(temporaryRoot, 'zettlr-resolved-shortcuts-'))
      }

      const fileDirectory = path.join(temporaryDirectory, String(index))
      await fs.mkdir(fileDirectory, { recursive: true })
      const preparedFile = path.join(fileDirectory, path.basename(inputFile))
      await fs.writeFile(preparedFile, rewritten.markdown, { encoding: 'utf8' })
      preparedFiles.push(preparedFile)
      resolved += rewritten.resolved
    }
  } catch (error) {
    if (temporaryDirectory !== undefined) {
      await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined)
    }
    throw error
  }

  return { inputFiles: preparedFiles, temporaryDirectory, resolved, unresolved }
}
