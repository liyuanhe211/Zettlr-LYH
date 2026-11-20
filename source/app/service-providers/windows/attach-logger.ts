/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        attachLogger function
 * CVM-Role:        Utility function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Adds an event listener that receives log messages
 *                  from the web contents.
 *
 * END HEADER
 */

import type LogProvider from '@providers/log'
import { type BrowserWindow } from 'electron'
import path from 'path'

/**
 * Attaches the global log interface to the webContents in order to save
 * messages from the BrowserWindows into our global log files to make sure we
 * can debug errors in the renderers even if the application has been shut down.
 *
 * @param   {BrowserWindow}  win  The BrowserWindow to attach to
 * @param   {string}         id   A human-readable identifier for the window
 */
export default function attachLogger (logger: LogProvider, win: BrowserWindow, id: string): void {
  // See: https://www.electronjs.org/docs/api/web-contents#event-console-message
  win.webContents.on('console-message', ({ message, sourceId, lineNumber, level }) => {
    // Prepare the generic log message and then log it using the appropriate
    // logger interface.
    const logMessage = `[R] [${id}] ${message} (${path.basename(sourceId)}:${lineNumber})`
    switch (level) {
      case 'debug': // Verbose
        logger.verbose(logMessage)
        break
      case 'info': // Info
        logger.info(logMessage)
        break
      case 'warning': // Warning
        logger.warning(logMessage)
        break
      case 'error': // Error
        logger.error(logMessage)
        break
    }
  })

  // A blank (white) window leaves no trace in the renderer's own console, so
  // record the events that can cause one from the main process' side.
  win.webContents.on('render-process-gone', (_event, details) => {
    logger.error(`[Window Manager] [${id}] Renderer process gone: ${details.reason} (exit code ${details.exitCode})`)
    // Requirement R99: also keep it in the runtime error log
    const title = !win.isDestroyed() ? win.getTitle() : ''
    logger.recordRuntimeError({
      process: 'renderer',
      window: title !== '' ? title : 'Unknown window',
      kind: 'render-process-gone',
      message: `${details.reason} (exit code ${details.exitCode})`
    })
  })
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame) {
      logger.error(`[Window Manager] [${id}] Failed to load ${validatedURL}: ${errorDescription} (${errorCode})`)
    }
  })
  win.on('unresponsive', () => {
    logger.warning(`[Window Manager] [${id}] Window became unresponsive`)
  })
  win.on('responsive', () => {
    logger.info(`[Window Manager] [${id}] Window is responsive again`)
  })
}
