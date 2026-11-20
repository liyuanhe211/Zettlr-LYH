/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ZETTLR_LYH_UPDATE_SOURCE, isUpdateSourceConfigured,
 *                  getReleasePage
 * CVM-Role:        Utility
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     The single place that defines where Zettlr-LYH looks for
 *                  application updates (requirement R95). Zettlr-LYH never
 *                  contacts the upstream Zettlr update server; until the user
 *                  decides on an update source of their own, the source below
 *                  is null and the UpdateProvider never sends a request.
 *
 *                  To set up an update source later:
 *                  1. Replace the null below with an object whose `apiUrl`
 *                     answers with the same JSON shape as the upstream API
 *                     (see ServerAPIResponse in ./index.ts: tag_name, name,
 *                     prerelease, html_url, body, published_at, assets, and
 *                     a SHA256SUMS.txt asset), and whose `releasePage` is the
 *                     page users can visit to download releases by hand.
 *                  2. Set `__UPDATES_DISABLED__` back to depend on the
 *                     environment (or to '0') in webpack.main.config.js and
 *                     webpack.renderer.config.js, so that the Help menu entry,
 *                     the preferences and the onboarding page reappear.
 *                  Nothing else in the update code needs to change.
 *
 * END HEADER
 */

/**
 * Describes where Zettlr-LYH looks for updates.
 */
export interface UpdateSource {
  /**
   * The URL that returns the latest release as JSON
   */
  apiUrl: string
  /**
   * The web page listing all releases, shown when no asset fits this computer
   */
  releasePage: string
}

/**
 * The update source of Zettlr-LYH. The user will specify it later
 * (requirement R95); while it is null, no update check is ever performed.
 */
export const ZETTLR_LYH_UPDATE_SOURCE: UpdateSource|null = null

/**
 * Tells whether an update source has been configured. The UpdateProvider
 * returns from its update check without any request when this is false.
 *
 * @param   {UpdateSource|null}  source  The update source to inspect
 *
 * @return  {boolean}                    True only if there is a source
 */
export function isUpdateSourceConfigured (source: UpdateSource|null): source is UpdateSource {
  return source !== null && source.apiUrl.trim() !== ''
}

/**
 * Returns the release page of the given source, or an empty string if no
 * source has been configured.
 *
 * @param   {UpdateSource|null}  source  The update source
 *
 * @return  {string}                     The release page URL or ''
 */
export function getReleasePage (source: UpdateSource|null): string {
  return isUpdateSourceConfigured(source) ? source.releasePage : ''
}
