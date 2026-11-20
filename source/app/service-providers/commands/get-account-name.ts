/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        getAccountName, resolveAccountName
 * CVM-Role:        Utility Function
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH revision mode (R84, decision 107): provides the
 *                  default author name that the Revision author dialog fills
 *                  in. On Windows this is the display name of the signed-in
 *                  account; if it is empty, cannot be read, or takes too long,
 *                  the login name is used instead, and if that fails as well,
 *                  an empty string. Other platforms use the login name.
 *
 * END HEADER
 */

import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

/** How long the display name lookup may take before the login name is used */
const displayNameTimeoutMilliseconds = 5000

// A static program; it receives no input. It prints the display name of the
// current account, or nothing. The WinNT provider covers local accounts,
// Microsoft accounts and domain accounts reachable through the domain
// controller; GetUserNameEx (NameDisplay) covers domain accounts whose WinNT
// entry carries no full name.
const windowsDisplayNameProgram = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$displayName = ''
try {
  $account = [ADSI]("WinNT://" + $env:USERDOMAIN + "/" + $env:USERNAME + ",user")
  $displayName = [string]$account.FullName
} catch {
  $displayName = ''
}
if ([string]::IsNullOrWhiteSpace($displayName)) {
  try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class AccountDisplayName {
  [DllImport("secur32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool GetUserNameExW(int nameFormat, StringBuilder name, ref uint size);
  public static string Read() {
    uint size = 1024;
    StringBuilder name = new StringBuilder((int)size);
    return GetUserNameExW(3, name, ref size) ? name.ToString() : "";
  }
}
'@
    $displayName = [AccountDisplayName]::Read()
  } catch {
    $displayName = ''
  }
}
[Console]::Out.Write($displayName.Trim())
`

/** The account information sources; tests replace them with stand-ins */
export interface AccountNameSources {
  /** The operating system platform, as in process.platform */
  platform: NodeJS.Platform
  /** Reads the display name of the account; may reject or never settle */
  readDisplayName: () => Promise<string>
  /** Reads the login name of the account; may throw */
  readLoginName: () => string
  /** How long readDisplayName may take before the login name is used */
  timeoutMilliseconds: number
}

/**
 * Waits for the promise for at most the given time.
 *
 * @param   {Promise<string>}  promise               The pending lookup
 * @param   {number}           timeoutMilliseconds   The time limit
 *
 * @return  {Promise<string>}                        The lookup result; rejects on timeout
 */
async function withTimeout (promise: Promise<string>, timeoutMilliseconds: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout>|undefined
  const timeout = new Promise<never>((resolve, reject) => {
    timer = setTimeout(() => { reject(new Error('The display name lookup timed out')) }, timeoutMilliseconds)
  })
  try {
    return await Promise.race([ promise, timeout ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Returns the trimmed login name, or an empty string if it cannot be read.
 *
 * @param   {AccountNameSources}  sources  The account information sources
 *
 * @return  {string}                       The login name or an empty string
 */
function loginNameOrEmpty (sources: AccountNameSources): string {
  try {
    const loginName = sources.readLoginName()
    return typeof loginName === 'string' ? loginName.trim() : ''
  } catch {
    return ''
  }
}

/**
 * Determines the default revision author name from the given sources: the
 * display name on Windows, falling back to the login name whenever the display
 * name is empty, fails or times out, and to an empty string if the login name
 * cannot be read either.
 *
 * @param   {AccountNameSources}  sources  The account information sources
 *
 * @return  {Promise<string>}              The default author name, possibly empty
 */
export async function resolveAccountName (sources: AccountNameSources): Promise<string> {
  if (sources.platform === 'win32') {
    try {
      const displayName = await withTimeout(sources.readDisplayName(), sources.timeoutMilliseconds)
      if (typeof displayName === 'string' && displayName.trim() !== '') {
        return displayName.trim()
      }
    } catch {
      // Fall back to the login name below
    }
  }
  return loginNameOrEmpty(sources)
}

/**
 * Reads the display name of the current Windows account through PowerShell.
 *
 * @return  {Promise<string>}  The display name, possibly empty; rejects on failure
 */
async function readWindowsDisplayName (): Promise<string> {
  const systemRoot = process.env.SystemRoot
  if (systemRoot === undefined || !path.win32.isAbsolute(systemRoot)) {
    throw new Error('Windows system directory is unavailable')
  }
  const executable = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

  return await new Promise((resolve, reject) => {
    execFile(executable, [
      '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(windowsDisplayNameProgram, 'utf16le').toString('base64')
    ], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: displayNameTimeoutMilliseconds,
      maxBuffer: 64 * 1024
    }, (error, stdout) => {
      if (error !== null) {
        reject(error)
      } else {
        resolve(stdout)
      }
    })
  })
}

let cachedAccountName: Promise<string>|undefined

/**
 * Returns the default revision author name for the current account. The
 * account does not change while the application runs, so the first result is
 * reused.
 *
 * @return  {Promise<string>}  The default author name, possibly empty
 */
export async function getAccountName (): Promise<string> {
  if (cachedAccountName === undefined) {
    cachedAccountName = resolveAccountName({
      platform: process.platform,
      readDisplayName: readWindowsDisplayName,
      readLoginName: () => os.userInfo().username,
      timeoutMilliseconds: displayNameTimeoutMilliseconds
    })
  }
  return await cachedAccountName
}
