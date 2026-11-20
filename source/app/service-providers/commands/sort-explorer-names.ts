import { execFile } from 'node:child_process'
import path from 'node:path'

const maximumNames = 20000
const maximumCharacters = 1000000

// Only this static program is executable. Names enter through UTF-8 JSON stdin.
const windowsSortProgram = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ExplorerNameSort {
  [DllImport("shlwapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
  private static extern int StrCmpLogicalW(string first, string second);
  public static string[] Sort(string[] names) {
    int[] positions = new int[names.Length];
    for (int index = 0; index < positions.Length; index++) positions[index] = index;
    Array.Sort(positions, delegate(int first, int second) {
      int comparison = StrCmpLogicalW(names[first], names[second]);
      return comparison != 0 ? comparison : first.CompareTo(second);
    });
    string[] result = new string[names.Length];
    for (int index = 0; index < positions.Length; index++) result[index] = names[positions[index]];
    return result;
  }
}
'@
  $inputText = [Console]::In.ReadToEnd()
  [string[]]$names = ConvertFrom-Json -InputObject $inputText
  [string[]]$sorted = [ExplorerNameSort]::Sort($names)
  [Console]::Out.Write((ConvertTo-Json -InputObject $sorted -Compress))
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`

function validateNames (payload: unknown): string[] {
  if (!Array.isArray(payload) || payload.length > maximumNames) {
    throw new TypeError('Explorer names must be an array with at most 20000 entries')
  }

  let characters = 0
  const names: string[] = []
  for (const name of payload) {
    if (typeof name !== 'string' || name.includes('\0')) {
      throw new TypeError('Explorer names must be strings without NUL characters')
    }
    characters += name.length
    if (characters > maximumCharacters) {
      throw new RangeError('Explorer names exceed the total character limit')
    }
    names.push(name)
  }
  return names
}

function validatePermutation (names: string[], output: unknown): string[] {
  if (!Array.isArray(output) || output.length !== names.length) {
    throw new Error('Explorer name sorter returned an invalid result')
  }

  const remaining = new Map<string, number>()
  for (const name of names) {
    remaining.set(name, (remaining.get(name) ?? 0) + 1)
  }
  for (const name of output) {
    if (typeof name !== 'string') {
      throw new Error('Explorer name sorter returned an invalid name')
    }
    const count = remaining.get(name) ?? 0
    if (count === 0) {
      throw new Error('Explorer name sorter did not preserve its input names')
    }
    remaining.set(name, count - 1)
  }
  return output.slice() as string[]
}

async function sortWindowsNames (names: string[]): Promise<unknown> {
  const systemRoot = process.env.SystemRoot
  if (systemRoot === undefined || !path.win32.isAbsolute(systemRoot)) {
    throw new Error('Windows system directory is unavailable')
  }
  const executable = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

  return await new Promise((resolve, reject) => {
    const child = execFile(executable, [
      '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(windowsSortProgram, 'utf16le').toString('base64')
    ], { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error !== null) {
        reject(error)
        return
      }
      try {
        resolve(JSON.parse(stdout))
      } catch (error: unknown) {
        reject(error)
      }
    })
    child.stdin?.on('error', reject)
    child.stdin?.end(JSON.stringify(names), 'utf8')
  })
}

/** Creates an isolated cache; the batch callback also permits deterministic tests. */
export function createExplorerNameSorter (
  sortBatch: (names: string[]) => Promise<unknown>
): (payload: unknown) => Promise<string[]> {
  const pending = new Map<string, Promise<string[]>>()
  let lastKey: string | undefined
  let lastResult: string[] = []

  return async (payload: unknown): Promise<string[]> => {
    const names = validateNames(payload)
    const key = JSON.stringify(names)
    if (key === lastKey) {
      return lastResult.slice()
    }
    let operation = pending.get(key)
    if (operation === undefined) {
      operation = (async () => {
        const output = names.length < 2 ? names : await sortBatch(names.slice())
        const result = validatePermutation(names, output)
        lastKey = key
        lastResult = result
        return result
      })()
      pending.set(key, operation)
    }
    try {
      return (await operation).slice()
    } finally {
      if (pending.get(key) === operation) {
        pending.delete(key)
      }
    }
  }
}

const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const cachedSort = createExplorerNameSorter(async names => {
  return process.platform === 'win32' ? await sortWindowsNames(names) : names.sort(naturalCollator.compare)
})

/** Batch name ranking for the renderer's Explorer-style directory tree. */
export async function sortExplorerNames (payload: unknown): Promise<string[]> {
  return await cachedSort(payload)
}
