/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        isFontRegistered, resolveBundledFontPath,
 *                  buildFontRegistryArguments, parseRegistryQueryOutput,
 *                  ensureBundledFontInstalled,
 *                  createNodeFontInstallDependencies
 * CVM-Role:        Utility Functions
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Installs the font that ships with the app (YaHei Consolas
 *                  Hybrid, used for the text of the document tabs on Windows)
 *                  for the current user if the computer does not have it yet.
 *                  The app itself always uses the font through an @font-face
 *                  rule (see static/fonts/fonts.css); this installation only
 *                  makes the font available to other programs as well. The
 *                  font file is copied into the per-user font folder and
 *                  registered for the current user in the registry, which
 *                  needs no administrator rights. Every failure is only
 *                  logged, so that the installation can never disturb the
 *                  start of the app. Main process only, Windows only.
 *
 *                  Everything that touches the system (registry, file
 *                  system, log) is passed in as dependencies, so that the
 *                  installation logic can be tested without changing the
 *                  system. This module deliberately does not import Electron
 *                  for the same reason; the caller passes the Electron values.
 *
 * END HEADER
 */

import path from 'path'
import { execFile } from 'child_process'
import { constants as fsConstants, promises as fs } from 'fs'

/**
 * The file name of the font, both in the repository (static/fonts), in the
 * resources folder of a packaged app, and in the per-user font folder.
 */
export const BUNDLED_FONT_FILE_NAME = 'YaHei.Consolas.1.12.ttf'

/**
 * The family name of the font. A font counts as installed as soon as a registry
 * value whose name starts with this text exists (e.g., "YaHei Consolas Hybrid
 * (TrueType)" or "YaHei Consolas Hybrid 1.12 (TrueType)").
 */
export const BUNDLED_FONT_FAMILY = 'YaHei Consolas Hybrid'

/**
 * The registry keys that list the installed fonts: the one of the current user
 * (the one this module writes to) and the one of the whole machine.
 */
const USER_FONT_REGISTRY_KEY = 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'
const MACHINE_FONT_REGISTRY_KEY = 'HKLM\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'

/**
 * The name of the registry value that registers the font for the current user.
 */
const FONT_REGISTRY_VALUE_NAME = `${BUNDLED_FONT_FAMILY} (TrueType)`

/**
 * The prefix of every line this module writes to the log.
 */
const LOG_PREFIX = '[BundledFontInstall]'

/**
 * The parts of the log provider that the installation needs.
 */
export interface FontInstallLogger {
  info: (message: string, details?: unknown) => void
  error: (message: string, details?: unknown) => void
}

/**
 * Everything that ensureBundledFontInstalled needs from the outside.
 */
export interface BundledFontInstallDependencies {
  /** The operating system (process.platform); anything but 'win32' disables the installation */
  platform: string
  /** Whether the app runs from a package (Electron's app.isPackaged) */
  isPackaged: boolean
  /** The folder of the app (Electron's app.getAppPath()); the repository folder in development mode */
  appPath: string
  /** The resources folder of a packaged app (process.resourcesPath) */
  resourcesPath: string
  /** The value of the environment variable LOCALAPPDATA, if there is one */
  localAppDataPath: string|undefined
  /** Lists the names of the values under the fonts keys of the registry (user and machine) */
  listRegisteredFontValueNames: () => Promise<string[]>
  /** Whether a file exists */
  fileExists: (filePath: string) => Promise<boolean>
  /** Creates a folder including all missing parent folders; no error if it exists */
  makeDirectory: (directoryPath: string) => Promise<void>
  /** Copies a file; must not overwrite an existing target */
  copyFile: (sourcePath: string, targetPath: string) => Promise<void>
  /** Runs reg.exe with the given arguments; rejects if it fails */
  runRegistryCommand: (argumentList: string[]) => Promise<void>
  /** Where the installation writes what it did and what failed */
  logger: FontInstallLogger
}

/**
 * Tells whether the font is installed, given the names of the registry values
 * under the fonts keys. The font counts as installed if any name starts with
 * the family name of the font, ignoring upper and lower case.
 *
 * @param   {string[]}  valueNames  The names of the registry values
 *
 * @return  {boolean}               True if the font is registered
 */
export function isFontRegistered (valueNames: string[]): boolean {
  const prefix = BUNDLED_FONT_FAMILY.toLowerCase()
  return valueNames.some(valueName => valueName.trim().toLowerCase().startsWith(prefix))
}

/**
 * Returns the path of the font file that ships with the app: in the resources
 * folder of a packaged app, and in static/fonts of the repository in
 * development mode.
 *
 * @param   {Object}  input  Whether the app is packaged, and its app and
 *                           resources folders
 *
 * @return  {string}         The path of the font file
 */
export function resolveBundledFontPath (input: { isPackaged: boolean, appPath: string, resourcesPath: string }): string {
  if (input.isPackaged) {
    return path.join(input.resourcesPath, BUNDLED_FONT_FILE_NAME)
  }

  return path.join(input.appPath, 'static', 'fonts', BUNDLED_FONT_FILE_NAME)
}

/**
 * Builds the arguments for reg.exe that register the font file for the current
 * user: "reg.exe add HKCU\...\Fonts /v "YaHei Consolas Hybrid (TrueType)" /t
 * REG_SZ /d "<file>" /f". As the arguments are passed as a list, no quoting is
 * needed.
 *
 * @param   {string}    targetPath  The full path of the installed font file
 *
 * @return  {string[]}              The arguments for reg.exe
 */
export function buildFontRegistryArguments (targetPath: string): string[] {
  return [
    'add',
    USER_FONT_REGISTRY_KEY,
    '/v',
    FONT_REGISTRY_VALUE_NAME,
    '/t',
    'REG_SZ',
    '/d',
    targetPath,
    '/f'
  ]
}

/**
 * Extracts the names of the values from the output of "reg.exe query <key>".
 * The output lists the key on an unindented line, followed by one indented
 * line per value, which has the form "    <name>    REG_SZ    <data>".
 *
 * @param   {string}    output  The output of reg.exe query
 *
 * @return  {string[]}          The names of the values
 */
export function parseRegistryQueryOutput (output: string): string[] {
  const valueNames: string[] = []

  for (const line of output.split(/\r?\n/)) {
    const match = /^\s+(\S.*?)\s+REG_[A-Z_]+(?:\s|$)/.exec(line)
    if (match !== null) {
      valueNames.push(match[1])
    }
  }

  return valueNames
}

/**
 * Turns anything that was thrown into text for the log.
 */
function describeError (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Makes sure that the font that ships with the app is installed for the current
 * user. It does nothing except on Windows. If the registry already lists the
 * font (for the user or for the machine), it does nothing either. Otherwise, it
 * copies the font file into the per-user font folder (an existing file there is
 * never overwritten, but is registered all the same) and registers it with
 * reg.exe.
 *
 * It never throws and shows no dialog: whatever fails is only written to the
 * log, so the start of the app is not affected. If the registration fails after
 * the file was copied, the next start tries the registration again.
 *
 * @param   {BundledFontInstallDependencies}  dependencies  The system access
 *                                                          and the log
 */
export async function ensureBundledFontInstalled (dependencies: BundledFontInstallDependencies): Promise<void> {
  if (dependencies.platform !== 'win32') {
    return
  }

  const logger = dependencies.logger

  try {
    const valueNames = await dependencies.listRegisteredFontValueNames()
    if (isFontRegistered(valueNames)) {
      return
    }
  } catch (error) {
    logger.error(`${LOG_PREFIX} Could not read the installed fonts from the registry, so the font ${BUNDLED_FONT_FAMILY} is not installed: ${describeError(error)}`, error)
    return
  }

  if (dependencies.localAppDataPath === undefined || dependencies.localAppDataPath === '') {
    logger.error(`${LOG_PREFIX} Could not install the font ${BUNDLED_FONT_FAMILY}: the environment variable LOCALAPPDATA is not set.`)
    return
  }

  const bundledFontPath = resolveBundledFontPath(dependencies)
  const targetDirectory = path.join(dependencies.localAppDataPath, 'Microsoft', 'Windows', 'Fonts')
  const targetPath = path.join(targetDirectory, BUNDLED_FONT_FILE_NAME)

  try {
    if (!await dependencies.fileExists(targetPath)) {
      await dependencies.makeDirectory(targetDirectory)
      await dependencies.copyFile(bundledFontPath, targetPath)
      logger.info(`${LOG_PREFIX} Copied the font ${BUNDLED_FONT_FAMILY} from ${bundledFontPath} to ${targetPath}.`)
    }
  } catch (error) {
    logger.error(`${LOG_PREFIX} Could not copy the font ${BUNDLED_FONT_FAMILY} from ${bundledFontPath} to ${targetPath}: ${describeError(error)}`, error)
    return
  }

  try {
    await dependencies.runRegistryCommand(buildFontRegistryArguments(targetPath))
    logger.info(`${LOG_PREFIX} Registered the font ${BUNDLED_FONT_FAMILY} (${targetPath}) for the current user.`)
  } catch (error) {
    logger.error(`${LOG_PREFIX} Could not register the font ${BUNDLED_FONT_FAMILY} in the registry: ${describeError(error)}`, error)
  }
}

/**
 * Runs reg.exe and returns what it printed. Rejects if reg.exe cannot be run or
 * exits with an error.
 */
function runRegistryTool (argumentList: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'reg.exe',
      argumentList,
      { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, standardOutput) => {
        if (error !== null) {
          reject(error)
        } else {
          resolve(standardOutput)
        }
      }
    )
  })
}

/**
 * Lists the names of the values under the fonts keys of the registry, both of
 * the current user and of the whole machine. A key that cannot be read (for
 * example, because it does not exist) is skipped; only if no key can be read at
 * all, this rejects.
 */
async function listRegisteredFontValueNames (): Promise<string[]> {
  const registryKeys = [ USER_FONT_REGISTRY_KEY, MACHINE_FONT_REGISTRY_KEY ]
  const valueNames: string[] = []
  const failures: unknown[] = []

  for (const registryKey of registryKeys) {
    try {
      valueNames.push(...parseRegistryQueryOutput(await runRegistryTool([ 'query', registryKey ])))
    } catch (error) {
      failures.push(error)
    }
  }

  if (failures.length === registryKeys.length) {
    throw new Error(`reg.exe could not read any fonts key: ${failures.map(describeError).join('; ')}`)
  }

  return valueNames
}

/**
 * Creates the dependencies for ensureBundledFontInstalled that access the real
 * system: the registry through reg.exe, and the real file system. This is the
 * only place that touches the system; it is deliberately kept out of
 * ensureBundledFontInstalled.
 *
 * @param   {Object}  options  The values that come from Electron, and the log
 *
 * @return  {BundledFontInstallDependencies}  The dependencies
 */
export function createNodeFontInstallDependencies (options: {
  isPackaged: boolean
  appPath: string
  resourcesPath: string
  logger: FontInstallLogger
}): BundledFontInstallDependencies {
  return {
    platform: process.platform,
    isPackaged: options.isPackaged,
    appPath: options.appPath,
    resourcesPath: options.resourcesPath,
    localAppDataPath: process.env.LOCALAPPDATA,
    listRegisteredFontValueNames,
    fileExists: async (filePath: string): Promise<boolean> => {
      try {
        await fs.access(filePath)
        return true
      } catch (error) {
        return false
      }
    },
    makeDirectory: async (directoryPath: string): Promise<void> => {
      await fs.mkdir(directoryPath, { recursive: true })
    },
    // COPYFILE_EXCL makes the copy fail instead of overwriting a file that
    // appeared in the meantime.
    copyFile: async (sourcePath: string, targetPath: string): Promise<void> => {
      await fs.copyFile(sourcePath, targetPath, fsConstants.COPYFILE_EXCL)
    },
    runRegistryCommand: async (argumentList: string[]): Promise<void> => {
      await runRegistryTool(argumentList)
    },
    logger: options.logger
  }
}
