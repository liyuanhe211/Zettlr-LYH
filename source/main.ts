/**
 * @ignore
 * BEGIN HEADER
 *
 * CVM-Role:        <none>
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This is the application's entry file. This gets executed as
 *                  soon as the app starts. Its task is only to hook onto the
 *                  app events and boot the application.
 *
 * END HEADER
 */

import { app } from 'electron'
// NOTE: Imported on a line of its own so that the line above stays as it is
import { crashReporter } from 'electron'
import { existsSync } from 'fs'
import path from 'path'
import { bootApplication, shutdownApplication } from './app/lifecycle'

// Helper function to extract files to open from process.argv
import extractFilesFromArgv, { extractFilesToCloseFromArgv } from './app/util/extract-files-from-argv'
import {
  DATA_DIR,
  DISABLE_HARDWARE_ACCELERATION,
  getCLIArgument,
  handleExitArguments
} from '@providers/cli-provider'
import { getAppServiceContainer, isAppServiceContainerReady } from './app/app-service-container'

handleExitArguments()

// Setting custom data dir for user configuration files.
// Full path or relative path is OK. '~' does not work as expected.
// NOTE: This must happen BEFORE the single instance lock is requested below,
// since the lock lives inside the userData directory: An instance with a
// custom data dir (e.g., the development sandbox started via `yarn start`)
// must not conflict with an instance using the default directory (e.g., a
// regular Zettlr installation running alongside).
let dataDir = getCLIArgument(DATA_DIR)

if (typeof dataDir === 'string') {
  // a path to a custom config dir is provided
  if (!path.isAbsolute(dataDir)) {
    if (app.isPackaged) {
      // Attempt to use the executable file's path as the basis
      dataDir = path.join(path.dirname(app.getPath('exe')), dataDir)
    } else {
      // Attempt to use the repository's root directory as the basis
      dataDir = path.join(__dirname, '../../', dataDir)
    }
  }

  if (isAppServiceContainerReady()) {
    getAppServiceContainer().log.info(`[Application] Using custom data dir: ${dataDir}`)
  }
  app.setPath('userData', dataDir)
  app.setAppLogsPath(path.join(dataDir, 'logs'))
}

// Immediately after launch, check if there is already another instance of
// Zettlr running, and, if so, exit immediately. The arguments (including files)
// from this instance will already be passed to the first instance.
if (!app.requestSingleInstanceLock()) {
  if (!app.isPackaged) {
    // I always forget to close my system install before starting the
    // development app, so let's just add a small reminder to myself.
    console.log('There is another instance of Zettlr running. Did you forget to close that one?')
  }
  app.exit(0)
}

// Zettlr-LYH close tab from the command line: a request to close files
// (`--close-file=<path>`) is only meant for a running instance. If none runs,
// there is no tab to close, so nothing happens and the app does not start.
if (extractFilesToCloseFromArgv(process.argv).length > 0) {
  app.exit(0)
}

// If we reach this point, we are now booting the first instance of Zettlr.

// Zettlr-LYH: Keep a dump of every crash of this app's processes on this
// computer, in app.getPath('crashDumps'). Nothing is ever uploaded. Without a
// connected crash handler, a crashed renderer only reports the exit code
// -36861 (Crashpad's "not connected to handler") instead of its real
// exception. Electron requires this call before the app is ready, and after
// the userData path is set, since the dump directory lies inside it.
crashReporter.start({ uploadToServer: false })

// To show notifications properly on Windows, we must manually set the appUserModelID
// See https://www.electronjs.org/docs/tutorial/notifications#windows
// NOTE: This fork deliberately uses an ID of its own instead of upstream's
// 'com.zettlr.app'. Windows groups taskbar buttons by this ID, so keeping the
// upstream ID would throw this sandbox's window into the same taskbar group as
// a regular Zettlr installation running alongside it.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.zettlr.lyh.app')

  if (!app.isPackaged) {
    const launcherPath = path.resolve(__dirname, '../../Zettlr_LYH.exe')
    app.on('browser-window-created', (_event, window) => {
      // NOTE: Unpackaged, Electron's notification support writes the Start
      // menu shortcut Electron.lnk for the process ID 'com.zettlr.lyh.app';
      // it points to electron.exe and carries its icon. The taskbar takes a
      // window's icon from a shortcut with the window's ID before anything
      // else, so the windows get an ID of their own that no shortcut claims.
      // The taskbar then shows the icon given here, and pinning a window pins
      // the launcher, which preserves the development startup flow.
      window.setAppDetails({
        appId: 'com.zettlr.lyh.window',
        appIconPath: path.join(__dirname, 'assets/icons/icon.ico'),
        appIconIndex: 0,
        ...(existsSync(launcherPath) ? {
          relaunchCommand: `"${launcherPath}"`,
          relaunchDisplayName: 'Zettlr-LYH'
        } : {})
      })
    })
  }
}

// On systems with virtual GPUs (i.e. VMs), it might be necessary to disable
// hardware acceleration. If the corresponding flag is set, we do so.
// See for more info https://github.com/Zettlr/Zettlr/issues/2127
if (getCLIArgument(DISABLE_HARDWARE_ACCELERATION) === true) {
  app.disableHardwareAcceleration()
}

// *****************************************************************************

// This array will be only useful for macOS since there we have the "open-file"
// event indicating that the user wants to open a file. But this event might be
// emitted before the app is ready and the service container object has been
// instantiated. This is why we need to cache those in this array. After the app
// is booted, we won't need this anymore.
// NOTE: This fork also collects files here that arrive via its Zettlr_LYH.exe
// launcher (see below and the `second-instance` handler).
const filesBeforeOpen: string[] = []

// NOTE: This fork's Zettlr_LYH.exe launcher, which Windows' "Open with" calls
// with the file to open, starts this development sandbox through a chain of
// nested command lines (cmd, corepack, yarn, cross-env, another cmd,
// electron-forge) whose quoting would mangle file paths passed as arguments.
// It therefore hands the files over in this environment variable, separated
// by "|" (a character Windows forbids in paths). The variable is removed so
// that a relaunched app does not open the same files again.
const launcherFiles = process.env.ZETTLR_LYH_FILES_TO_OPEN
if (launcherFiles !== undefined) {
  filesBeforeOpen.push(...extractFilesFromArgv(launcherFiles.split('|')))
  delete process.env.ZETTLR_LYH_FILES_TO_OPEN
}

/**
 * This variable is being used to determine if all service providers have
 * successfully shut down and we can actually quit the app.
 *
 * @var {boolean}
 */
let canQuit: boolean = false

/**
 * Hook into the ready event and initialize the main object creating everything
 * else. It is necessary to wait for the ready event, because prior, some APIs
 * may not work correctly.
 */
app.whenReady().then(() => {
  // Override the about panel options so that a little bit more is being shown.
  // Makes only sense for macOS, as we don't call the showAboutPanel() method
  // programmatically, but either way, it's a little bit nicer.
  app.setAboutPanelOptions({
    applicationName: 'Zettlr',
    applicationVersion: app.getVersion(),
    copyright: `Copyright (c) 2017 - ${(new Date()).getFullYear()} by Hendrik Erz. Licensed via GNU GPL 3.0`,
    // version: If we ever introduce a build number. This defaults to the Electron version.
    credits: 'We would like to thank all contributors to the app, its translators, and those who meticulously update the documentation.',
    authors: ['Hendrik Erz'], // TODO: Somehow generate the contributors list.
    website: 'https://www.zettlr.com/',
    iconPath: process.execPath
  })
  // Immediately boot the application. This function performs some initial
  // checks to make sure the environment is as expected for Zettlr, and boots
  // up the providers.
  bootApplication().then(() => {
    getAppServiceContainer().commands.run('roots-add', filesBeforeOpen.concat(extractFilesFromArgv(process.argv)))
      .catch(err => console.error(err))
  }).catch(err => {
    console.error(err)
    app.exit(1)
  })
}).catch(e => console.error(e))

/**
 * This event will be called if another instance of Zettlr has been opened with
 * the argv of that instance.
 * NOTE from the electron docs: This event is guaranteed to be emitted after
 * the ready event of app gets emitted.
 * @param {Object} event The instance event
 * @param {Array} argv The arguments the second instance had received
 * @param {String} cwd The current working directory
 */
app.on('second-instance', (event, argv, _cwd) => {
  // Zettlr-LYH close tab from the command line: another program asks to close
  // the tabs of some files. Close each one that has no unsaved changes, and do
  // nothing else: no window is shown or focused, and nothing is opened.
  const filesToClose = extractFilesToCloseFromArgv(argv)
  if (filesToClose.length > 0) {
    if (!isAppServiceContainerReady()) {
      return // Still booting: no tab is open yet
    }
    const serviceContainer = getAppServiceContainer()
    for (const filePath of filesToClose) {
      serviceContainer.documents.closeFileIfUnmodified(filePath)
        .then(closed => {
          serviceContainer.log.info(`[Application] Command line request to close ${filePath}: ${closed ? 'closed' : 'not open or has unsaved changes, left alone'}`)
        })
        .catch(err => {
          serviceContainer.log.error(`[Application] Could not close ${filePath} as requested from the command line`, err)
        })
    }
    return
  }

  if (!isAppServiceContainerReady()) {
    // NOTE: Upstream drops the files here. This fork's Zettlr_LYH.exe launcher
    // may hand files over while the app is still booting (e.g., when several
    // files are opened from Explorer at once), so keep them for after boot.
    filesBeforeOpen.push(...extractFilesFromArgv(argv))
    return
  }

  const serviceContainer = getAppServiceContainer()

  serviceContainer.log.info('[Application] A second instance has been opened.')

  // openWindow calls the appropriate function of the windowManager, which deals
  // with the nitty-gritty of actually making the main window visible.
  serviceContainer.windows.showAnyWindow()

  // In case the user wants to open a file/folder with this running instance
  serviceContainer.commands?.run('roots-add', extractFilesFromArgv(argv))
    .catch(err => {
      serviceContainer.log.error('[Application] Error while adding new roots', err)
    })
})

/**
 * This gets executed when the user wants to open a file on macOS.
 */
app.on('open-file', (e, filePath) => {
  e.preventDefault() // Need to explicitly set this b/c we're handling this

  if (isAppServiceContainerReady()) {
    const serviceContainer = getAppServiceContainer()
    serviceContainer.log.info(`[Application] Opening file ${filePath}.`)
    serviceContainer.windows.showAnyWindow()
    serviceContainer.commands.run('roots-add', [filePath])
      .catch((err) => {
        serviceContainer.log.error('[Application] Error while adding new roots', err)
      })
  } else {
    // The Zettlr object has yet to be created -> cache it
    filesBeforeOpen.push(filePath)
  }
})

/**
 * Quit as soon as all windows are closed. Except if
 * `system.leaveAppRunning` is true or on macOS.
 */
app.on('window-all-closed', function () {
  if (!isAppServiceContainerReady()) {
    return
  }

  const { config } = getAppServiceContainer()
  const { leaveAppRunning } = config.get().system
  if (!leaveAppRunning && process.platform !== 'darwin') {
    // On OS X it is common for applications and their menu bar
    // to stay active until the user quits explicitly with Cmd + Q
    app.quit()
  }
})

/**
 * Hook into the will-quit event to make sure we are able to shut down our app
 * properly.
 */
app.on('will-quit', function (event) {
  if (!canQuit) {
    // Prevent immediate shutdown and allow the process to shut down first
    event.preventDefault()
  } else {
    return // Don't prevent quitting, but we don't need to shut down again.
  }

  shutdownApplication()
    .then(() => {
      // Now we can safely quit the app. Set the flag so that the callback
      // won't stop the shutdown, and programmatically quit the app.
      canQuit = true
      app.quit()
    })
    .catch(err => console.error(err))
})

/**
 * On macOS, open a new window as soon as the user re-activates the app.
 */
app.on('activate', function () {
  if (isAppServiceContainerReady()) {
    getAppServiceContainer().windows.showAnyWindow()
  }
})

/**
 * Turns whatever was thrown or rejected into a message and, if available, a
 * stack trace.
 *
 * @param   {unknown}  reason  The thrown value or the rejection reason
 *
 * @return  {{ message: string, stack?: string }}  The message and the stack trace
 */
function describeMainProcessError (reason: unknown): { message: string, stack?: string } {
  if (reason instanceof Error) {
    return { message: `${reason.name}: ${reason.message}`, stack: reason.stack }
  }

  if (typeof reason === 'string') {
    return { message: reason }
  }

  try {
    return { message: JSON.stringify(reason) ?? String(reason) }
  } catch (_err) {
    return { message: String(reason) }
  }
}

/**
 * Writes an error that nothing in the main process handled to the general log
 * and to the runtime error log (requirement R99), without a dialog. Before the
 * service container is ready, it only goes to the console. This must never
 * throw, since it runs inside the handlers for uncaught errors.
 *
 * @param   {string}   description  The general log's description of the error
 * @param   {'unhandledrejection'|'uncaughtException'}  kind  The kind of error
 * @param   {unknown}  reason       The thrown value or the rejection reason
 */
function recordMainProcessError (
  description: string,
  kind: 'unhandledrejection'|'uncaughtException',
  reason: unknown
): void {
  try {
    if (!isAppServiceContainerReady()) {
      console.error(description, reason)
      return
    }

    const { log } = getAppServiceContainer()
    log.error(description, reason)
    const { message, stack } = describeMainProcessError(reason)
    log.recordRuntimeError({ process: 'main', window: 'main', kind, message, stack })
  } catch (err) {
    console.error(description, reason, err)
  }
}

/**
 * Hook into the unhandledRejection-event to prevent nasty error messages when
 * a Promise is rejected somewhere.
 */
process.on('unhandledRejection', (err: unknown) => {
  recordMainProcessError('[Application] Unhandled rejection received', 'unhandledrejection', err)
})

/**
 * Take over uncaught exceptions, so that Electron does not show its "A
 * JavaScript error occurred in the main process" dialog. The error is logged
 * silently and the application keeps running (requirement R99).
 */
process.on('uncaughtException', (err: Error) => {
  recordMainProcessError('[Application] Uncaught exception received', 'uncaughtException', err)
})
