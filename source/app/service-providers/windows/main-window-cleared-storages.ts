/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        MAIN_WINDOW_CLEARED_STORAGES
 * CVM-Role:        Utility constant
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     The kinds of session storage that are cleared whenever a
 *                  main window closes. Kept in a module of its own, free of
 *                  Electron imports, so that tests can load it (R94).
 *
 * END HEADER
 */

/**
 * The storages that createMainWindow clears when a main window closes.
 *
 * Local storage is deliberately NOT part of this list (R94). All main windows
 * share the default session, and this fork keeps state in local storage that
 * has to survive a restart:
 *
 * - `zettlr-history-tree-directories-showing-unopened-content`: the folders
 *   whose eye button in the Files section is switched on (R1)
 * - `zettlr-lyh-pdf-view-state`: the last page and zoom of every PDF (R59)
 * - `zettlr-lyh-pdf-quote-settings`: colour and auto-copy of PDF quotes (R60)
 * - `zettlr-lyh-pdf-backlinks-visible`: the PDF backlink highlight switch (R62)
 *
 * Clearing local storage on close used to wipe all four, for every window.
 */
export const MAIN_WINDOW_CLEARED_STORAGES: Array<'cookies' | 'shadercache'> = [
  'cookies', // Nobody needs cookies except for downloading pandoc etc
  'shadercache' // Should never contain anything
]
