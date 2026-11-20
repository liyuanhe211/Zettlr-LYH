import type ConfigProvider from '@providers/config'
import type LogProvider from '@providers/log'
import { BrowserWindow, type BrowserWindowConstructorOptions } from 'electron'
import attachLogger from './attach-logger'
import setWindowChrome from './set-window-chrome'
import type { WindowPosition } from './types'

/** Creates the independent, non-modal recent history window. */
export default function createRecentFilesWindow (logger: LogProvider, config: ConfigProvider, position: WindowPosition): BrowserWindow {
  const options: BrowserWindowConstructorOptions = {
    title: 'Recent Files',
    acceptFirstMouse: true,
    minWidth: 400,
    minHeight: 250,
    width: position.width,
    height: position.height,
    x: position.x,
    y: position.y,
    show: false,
    fullscreenable: false,
    webPreferences: {
      sandbox: true,
      preload: RECENT_FILES_PRELOAD_WEBPACK_ENTRY
    }
  }
  setWindowChrome(config, options)
  const window = new BrowserWindow(options)
  window.loadURL(RECENT_FILES_WEBPACK_ENTRY).catch(error => {
    logger.error(`Could not load Recent Files: ${String(error.message)}`, error)
  })
  attachLogger(logger, window, 'Recent Files Window')
  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) {
      window.show()
    }
  })
  return window
}
