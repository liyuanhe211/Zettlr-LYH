/** Read validated local image resources for same-origin PNG conversion. */
import path from 'node:path'
import { readFile } from 'node:fs/promises'

export interface ImageFileBytes { bytes: Uint8Array, mime: string }

const imageMimeTypes: Record<string, string> = {
  '.png': 'image/png', '.apng': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg', '.jpe': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
  '.ico': 'image/x-icon', '.avif': 'image/avif', '.tif': 'image/tiff', '.tiff': 'image/tiff'
}

function imagePath (payload: unknown): string|undefined {
  if (typeof payload !== 'string' || payload.includes('\0') || payload.length > 32767) { return undefined }
  let filename = payload
  if (/^(safe-)?file:\/\//i.test(filename)) {
    try {
      const url = new URL(filename)
      filename = decodeURIComponent(url.pathname)
      if (url.hostname !== '') { filename = `//${url.hostname}${filename}` }
      if (/^\/[A-Z]:/i.test(filename)) { filename = filename.slice(1) }
    } catch { return undefined }
  }
  const absolute = process.platform === 'win32'
    ? /^[A-Z]:[\\/]/i.test(filename) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(filename)
    : path.isAbsolute(filename)
  return absolute ? filename : undefined
}

function hasSvgRoot (contents: Buffer): boolean {
  let text = contents.toString('utf8').replace(/^\uFEFF/, '').trimStart()
  const declaration = /^<\?xml\s[^]*?\?>/i.exec(text)
  if (declaration !== null) { text = text.slice(declaration[0].length).trimStart() }
  let doctype = false
  while (true) {
    if (text.startsWith('<!--')) {
      const end = text.indexOf('-->')
      if (end < 0) { return false }
      text = text.slice(end + 3).trimStart()
    } else if (!doctype && /^<!DOCTYPE\s+svg\b/i.test(text)) {
      let quote = ''
      let subsetDepth = 0
      let end = -1
      for (let index = 0; index < text.length; index++) {
        const character = text[index]
        if (quote !== '') {
          if (character === quote) { quote = '' }
        } else if (character === '"' || character === "'") {
          quote = character
        } else if (character === '[') {
          subsetDepth++
        } else if (character === ']') {
          subsetDepth--
        } else if (character === '>' && subsetDepth === 0) {
          end = index
          break
        }
      }
      if (end < 0) { return false }
      text = text.slice(end + 1).trimStart()
      doctype = true
    } else {
      return /^<svg(?:\s|\/?>)/i.test(text)
    }
  }
}

function hasImageHeader (contents: Buffer, mime: string): boolean {
  switch (mime) {
    case 'image/png': return contents.length >= 24 && contents.subarray(0, 8).equals(Buffer.from([ 137, 80, 78, 71, 13, 10, 26, 10 ]))
    case 'image/jpeg': return contents.length >= 3 && contents[0] === 255 && contents[1] === 216 && contents[2] === 255
    case 'image/gif': return /^GIF8[79]a$/.test(contents.subarray(0, 6).toString('ascii'))
    case 'image/webp': return contents.length >= 12 && contents.subarray(0, 4).toString('ascii') === 'RIFF' && contents.subarray(8, 12).toString('ascii') === 'WEBP'
    case 'image/bmp': return contents.length >= 14 && contents.subarray(0, 2).toString('ascii') === 'BM'
    case 'image/x-icon': return contents.length >= 6 && contents.subarray(0, 4).equals(Buffer.from([ 0, 0, 1, 0 ]))
    case 'image/avif': return contents.length >= 16 && contents.subarray(4, 8).toString('ascii') === 'ftyp' && /avif|avis/.test(contents.subarray(8, 64).toString('ascii'))
    case 'image/tiff': return contents.length >= 4 && (contents.subarray(0, 4).equals(Buffer.from([ 73, 73, 42, 0 ])) || contents.subarray(0, 4).equals(Buffer.from([ 77, 77, 0, 42 ])))
    case 'image/svg+xml': return hasSvgRoot(contents)
    default: return false
  }
}

/** Returns null for invalid requests, non-image resources, or read failures. */
export async function readImageFileBytes (payload: unknown): Promise<ImageFileBytes|null> {
  const filename = imagePath(payload)
  if (filename === undefined) { return null }
  const mime = imageMimeTypes[path.extname(filename).toLowerCase()]
  if (mime === undefined) { return null }
  try {
    const contents = await readFile(filename)
    if (!hasImageHeader(contents, mime)) { return null }
    return { bytes: new Uint8Array(contents), mime }
  } catch { return null }
}
