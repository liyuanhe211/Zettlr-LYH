/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        tryMakeValidUri function
 * CVM-Role:        <none>
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Non-throwing wrapper around makeValidUri. Returns null
 *                  when the URI cannot be turned into a valid URL.
 *
 * END HEADER
 */

import makeValidUri from './make-valid-uri'

/**
 * Returns a valid URI like makeValidUri, but returns null instead of throwing
 * when the input cannot be parsed (e.g. "https://" or a host with spaces).
 *
 * @param   {string}       uri   The URI to check
 * @param   {string}       base  The base which can be used to make uri absolute
 *
 * @return  {string|null}        The absolute, parsed string, or null.
 */
export default function tryMakeValidUri (uri: string, base: string = ''): string | null {
  try {
    return makeValidUri(uri, base)
  } catch {
    return null
  }
}
