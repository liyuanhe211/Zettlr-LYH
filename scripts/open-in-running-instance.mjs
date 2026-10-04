/**
 * Hands files to an already running Zettlr development sandbox (the instance
 * that `yarn start` launches with --data-dir=resources/test-cfg), or reports
 * that none is running. The Zettlr_LYH.exe launcher, which is registered as
 * the Windows "Open with" handler for Markdown files, calls this first.
 *
 * Run it with Electron itself, not with node:
 *   node_modules\electron\dist\electron.exe scripts\open-in-running-instance.mjs [--data-dir=PATH] [files...]
 *
 * It requests the same single instance lock as the sandbox (the lock lives in
 * the userData directory, see source/main.ts). If the sandbox holds the lock,
 * Electron passes this process's command line, files included, to the
 * sandbox's `second-instance` handler, which opens them. This never touches
 * the webpack build, so the running instance stays intact. It opens no window
 * of its own either way.
 *
 * Exit codes:
 *   0  The files were handed to the running sandbox (without files: the
 *      sandbox merely brings its window to the front).
 *   2  No sandbox is running. This process got the lock and released it
 *      again without opening anything.
 */

import { app } from 'electron'
import path from 'path'
import { fileURLToPath } from 'url'

const EXIT_HANDED_OVER = 0
const EXIT_NO_RUNNING_INSTANCE = 2

// Same default as scripts/test-gui/index.mjs, which starts the sandbox.
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const dataDirArgument = process.argv.find(argument => argument.startsWith('--data-dir='))
const dataDirectory = dataDirArgument !== undefined
  ? path.resolve(dataDirArgument.slice('--data-dir='.length))
  : path.join(scriptDirectory, '../resources/test-cfg')

app.setPath('userData', dataDirectory)

if (app.requestSingleInstanceLock()) {
  app.releaseSingleInstanceLock()
  app.exit(EXIT_NO_RUNNING_INSTANCE)
} else {
  app.exit(EXIT_HANDED_OVER)
}
