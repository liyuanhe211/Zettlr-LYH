/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        JevSearch command
 * CVM-Role:        <none>
 * License:         GNU GPL v3
 *
 * Description:     Judges one batch of document chunks against a
 *                  natural-language search description with TypeSafe's Jev
 *                  model and returns, for every chunk in the order given, the
 *                  probability that it contains at least one relevant passage.
 *                  One command sends at most one request, with one noul
 *                  question per chunk; the renderer's JEV Search panel does
 *                  the chunking and batching (source/common/modules/jev-search).
 *                  Probabilities are cached in memory per prompt and chunk
 *                  text, so repeating a search only sends the chunks that are
 *                  not cached yet. Rate-limited (HTTP 429) and overloaded
 *                  (HTTP 529) requests are retried with exponential backoff.
 *                  Specification C4 defines the request, the retries, the
 *                  cache and the result; the API key never reaches the log or
 *                  the result.
 *
 * END HEADER
 */

import { createHash } from 'crypto'
import ZettlrCommand from './zettlr-command'
import {
  JEV_SEARCH_API_KEY_VARIABLE,
  JEV_SEARCH_BASE_OVERHEAD_TOKENS,
  JEV_SEARCH_COMMAND,
  JEV_SEARCH_ENDPOINT,
  JEV_SEARCH_ENDPOINT_OVERRIDE_VARIABLE,
  JEV_SEARCH_MISSING_KEY_MESSAGE,
  JEV_SEARCH_MODEL,
  JEV_SEARCH_PER_CHUNK_OVERHEAD_TOKENS,
  JEV_SEARCH_REQUEST_HARD_LIMIT_TOKENS,
  estimateJevTokens,
  jevSearchQuestion
} from '@dts/common/jev-search'
import type { JevSearchCommandArg, JevSearchResult } from '@dts/common/jev-search'
import type { AppServiceContainer } from 'source/app/app-service-container'

/**
 * Waits before the first, second, third and fourth retry of a request that
 * TypeSafe answered with HTTP 429 or 529; after the fourth retry the command
 * gives up.
 */
export const JEV_SEARCH_RETRY_DELAYS_MILLISECONDS: readonly number[] = [ 2000, 4000, 8000, 16000 ]

/**
 * A single request attempt (sending plus reading the response) taking longer
 * than this is aborted.
 */
export const JEV_SEARCH_REQUEST_TIMEOUT_MILLISECONDS = 120 * 1000

/**
 * How many characters of a failed response's body the error message quotes
 */
export const JEV_SEARCH_ERROR_BODY_CHARACTERS = 300

/**
 * HTTP status codes that are retried: rate limit and service overload
 */
const RETRYABLE_STATUS_CODES = new Set([ 429, 529 ])

/**
 * The cache forgets its oldest entries beyond this many probabilities.
 */
const MAX_CACHE_ENTRIES = 100000

/**
 * Text that replaces the API key wherever it would otherwise show up
 */
const REDACTED_SECRET = '[redacted]'

/**
 * The JSON body of one TypeSafe System One request
 */
export interface JevRequestBody {
  model: string
  state: {
    prompt: string
    chunks: Record<string, string>
  }
  questions: Record<string, { type: 'noul', instructions: string }>
}

/**
 * The part of fetch's options the command uses
 */
export interface JevFetchInit {
  method: 'POST'
  headers: Record<string, string>
  body: string
  signal: AbortSignal
}

/**
 * The part of fetch's response the command uses
 */
export interface JevFetchResponse {
  status: number
  text: () => Promise<string>
}

export type JevFetch = (url: string, init: JevFetchInit) => Promise<JevFetchResponse>

/**
 * Everything the command takes from its surroundings; tests replace these.
 */
export interface JevSearchDependencies {
  /**
   * Sends the HTTP request (default: the global fetch)
   */
  fetch: JevFetch
  /**
   * Resolves after the given time (default: a timer); used between retries
   */
  wait: (milliseconds: number) => Promise<void>
  /**
   * Environment variables consulted for the API key fallback and the
   * endpoint override (default: process.env)
   */
  environment: Record<string, string|undefined>
  /**
   * Time limit of one request attempt
   */
  requestTimeoutMilliseconds: number
}

/**
 * Outcome of sending the request, with retries
 */
export type JevPostOutcome = { ok: true, responseText: string } | { ok: false, error: string }

/**
 * Outcome of reading the response
 */
export type JevParseOutcome = { ok: true, probabilities: number[] } | { ok: false, error: string }

/**
 * The messages the command writes to the application log
 */
interface JevSearchLog {
  info: (message: string) => void
  warning: (message: string) => void
  error: (message: string) => void
}

function failure (error: string): JevSearchResult {
  return { ok: false, error }
}

/**
 * Picks the TypeSafe API key: the configured key when it is non-empty after
 * trimming, otherwise the TYPESAFE_API_KEY environment variable when that is
 * non-empty after trimming.
 *
 * @param   {unknown}                           configuredKey  The value of jevSearch.apiKey
 * @param   {Record<string, string|undefined>}  environment    The environment variables
 *
 * @return  {string|undefined}                                 The key, or undefined when there is none
 */
export function resolveJevApiKey (configuredKey: unknown, environment: Record<string, string|undefined>): string|undefined {
  if (typeof configuredKey === 'string' && configuredKey.trim() !== '') {
    return configuredKey.trim()
  }
  const environmentKey = environment[JEV_SEARCH_API_KEY_VARIABLE]
  if (typeof environmentKey === 'string' && environmentKey.trim() !== '') {
    return environmentKey.trim()
  }
  return undefined
}

/**
 * Picks the endpoint: the ZETTLR_TYPESAFE_ENDPOINT environment variable when
 * it is non-empty (only test doubles set it), otherwise TypeSafe's System One
 * endpoint.
 *
 * @param   {Record<string, string|undefined>}  environment  The environment variables
 *
 * @return  {string}                                         The URL to post to
 */
export function resolveJevEndpoint (environment: Record<string, string|undefined>): string {
  const override = environment[JEV_SEARCH_ENDPOINT_OVERRIDE_VARIABLE]
  if (typeof override === 'string' && override.trim() !== '') {
    return override.trim()
  }
  return JEV_SEARCH_ENDPOINT
}

/**
 * The name of a chunk in the request's state and questions
 *
 * @param   {number}  index  Position of the chunk within the request
 *
 * @return  {string}         chunk_<index>
 */
export function jevChunkName (index: number): string {
  return `chunk_${index}`
}

/**
 * Builds the request body: the prompt and the chunks as the state, and one
 * noul question per chunk, both keyed chunk_0, chunk_1, ... in the given
 * order.
 *
 * @param   {string}          prompt  The search description
 * @param   {string[]}        chunks  The chunk texts to send
 *
 * @return  {JevRequestBody}          The body to serialize as JSON
 */
export function buildJevRequestBody (prompt: string, chunks: string[]): JevRequestBody {
  const stateChunks: Record<string, string> = {}
  const questions: Record<string, { type: 'noul', instructions: string }> = {}
  chunks.forEach((chunk, index) => {
    stateChunks[jevChunkName(index)] = chunk
    questions[jevChunkName(index)] = { type: 'noul', instructions: jevSearchQuestion(index) }
  })
  return {
    model: JEV_SEARCH_MODEL,
    state: { prompt, chunks: stateChunks },
    questions
  }
}

/**
 * Estimates the input tokens of a request the way the renderer's batch
 * planner does: the prompt once, the base overhead, and every chunk plus the
 * per-chunk overhead of its question.
 *
 * @param   {string}    prompt  The search description
 * @param   {string[]}  chunks  The chunk texts
 *
 * @return  {number}            Estimated tokens; 0 when there are no chunks
 */
export function estimateJevRequestTokens (prompt: string, chunks: string[]): number {
  if (chunks.length === 0) {
    return 0
  }
  let total = estimateJevTokens(prompt) + JEV_SEARCH_BASE_OVERHEAD_TOKENS
  for (const chunk of chunks) {
    total += estimateJevTokens(chunk) + JEV_SEARCH_PER_CHUNK_OVERHEAD_TOKENS
  }
  return total
}

/**
 * Reads the probabilities out of a response body. Every chunk_<i> answer must
 * carry a noul value between 0 and 1; if any of them does not, the whole
 * response counts as failed.
 *
 * @param   {string}           responseText  The response body
 * @param   {number}           chunkCount    How many chunks the request contained
 *
 * @return  {JevParseOutcome}                The probabilities in request order, or the reason for failure
 */
export function parseJevResponse (responseText: string, chunkCount: number): JevParseOutcome {
  let payload: unknown
  try {
    payload = JSON.parse(responseText)
  } catch (error) {
    return { ok: false, error: 'TypeSafe returned a response that is not JSON' }
  }

  if (typeof payload !== 'object' || payload === null) {
    return { ok: false, error: 'TypeSafe returned a response without answers' }
  }
  const answers = (payload as { answers?: unknown }).answers
  if (typeof answers !== 'object' || answers === null) {
    return { ok: false, error: 'TypeSafe returned a response without answers' }
  }

  const probabilities: number[] = []
  for (let index = 0; index < chunkCount; index++) {
    const answer = (answers as Record<string, unknown>)[jevChunkName(index)]
    const probability = typeof answer === 'object' && answer !== null
      ? (answer as { noul?: unknown }).noul
      : undefined
    if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
      return { ok: false, error: `TypeSafe returned no valid probability for ${jevChunkName(index)} of the request` }
    }
    probabilities.push(probability)
  }
  return { ok: true, probabilities }
}

/**
 * The cache key of one chunk under one search description
 *
 * @param   {string}  prompt  The search description
 * @param   {string}  chunk   The chunk text
 *
 * @return  {string}          A SHA-256 hex digest of both together
 */
export function computeJevCacheKey (prompt: string, chunk: string): string {
  // JSON keeps the boundary between prompt and chunk unambiguous
  return createHash('sha256').update(JSON.stringify([ prompt, chunk ])).digest('hex')
}

/**
 * Replaces every occurrence of the secret in the text.
 *
 * @param   {string}            text    Any message
 * @param   {string|undefined}  secret  The API key, if known
 *
 * @return  {string}                    The message without the secret
 */
export function redactSecret (text: string, secret: string|undefined): string {
  if (secret === undefined || secret === '') {
    return text
  }
  return text.split(secret).join(REDACTED_SECRET)
}

/**
 * Describes a non-2xx response in one line: the status code and the start of
 * the response body, whitespace collapsed.
 *
 * @param   {number}  status  The HTTP status code
 * @param   {string}  body    The response body
 *
 * @return  {string}          The error message
 */
export function describeJevHttpFailure (status: number, body: string): string {
  const excerpt = body.replace(/\s+/g, ' ').trim().slice(0, JEV_SEARCH_ERROR_BODY_CHARACTERS)
  return excerpt === ''
    ? `TypeSafe returned HTTP ${status}`
    : `TypeSafe returned HTTP ${status}: ${excerpt}`
}

/**
 * Checks the command's payload.
 *
 * @param   {unknown}           arg  What the renderer sent
 *
 * @return  {string|undefined}       The problem, or undefined when the payload is usable
 */
export function validateJevSearchArg (arg: unknown): string|undefined {
  if (typeof arg !== 'object' || arg === null) {
    return 'No search was given'
  }
  const { prompt, chunks } = arg as { prompt?: unknown, chunks?: unknown }
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    return 'The search description is empty'
  }
  if (!Array.isArray(chunks) || chunks.some(chunk => typeof chunk !== 'string')) {
    return 'The chunks to search must be a list of texts'
  }
  return undefined
}

function describeNetworkError (error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error)
  }
  // Node's fetch reports "fetch failed" and keeps the actual reason in cause
  const cause = (error as { cause?: unknown }).cause
  if (cause instanceof Error && cause.message !== '' && cause.message !== error.message) {
    return `${error.message} (${cause.message})`
  }
  return error.message
}

/**
 * Posts the request body, retrying HTTP 429 and 529 after the delays in
 * JEV_SEARCH_RETRY_DELAYS_MILLISECONDS. Other non-2xx statuses, network
 * errors and timeouts end the attempt at once. Never rejects; the error
 * messages may still contain the API key if the server echoed it, so callers
 * redact them.
 *
 * @param   {object}  options  Endpoint, key, body and the dependencies to use
 *
 * @return  {Promise<JevPostOutcome>}  The 2xx response body, or the reason for failure
 */
export async function postJevRequest (options: {
  endpoint: string
  apiKey: string
  body: JevRequestBody
  fetch: JevFetch
  wait: (milliseconds: number) => Promise<void>
  timeoutMilliseconds: number
  log: JevSearchLog
}): Promise<JevPostOutcome> {
  const serializedBody = JSON.stringify(options.body)
  const headers = {
    'Authorization': `Bearer ${options.apiKey}`,
    'Content-Type': 'application/json'
  }

  for (let retry = 0; ; retry++) {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, options.timeoutMilliseconds)
    let status: number
    let responseText: string
    try {
      const response = await options.fetch(options.endpoint, {
        method: 'POST',
        headers,
        body: serializedBody,
        signal: controller.signal
      })
      status = response.status
      responseText = await response.text()
    } catch (error) {
      if (controller.signal.aborted) {
        return { ok: false, error: `The TypeSafe request timed out after ${options.timeoutMilliseconds / 1000} seconds` }
      }
      return { ok: false, error: `Could not reach TypeSafe: ${describeNetworkError(error)}` }
    } finally {
      clearTimeout(timer)
    }

    if (status >= 200 && status < 300) {
      return { ok: true, responseText }
    }

    if (RETRYABLE_STATUS_CODES.has(status) && retry < JEV_SEARCH_RETRY_DELAYS_MILLISECONDS.length) {
      const delay = JEV_SEARCH_RETRY_DELAYS_MILLISECONDS[retry]
      options.log.warning(`[JevSearch] TypeSafe answered HTTP ${status}; retrying in ${delay / 1000} s (retry ${retry + 1} of ${JEV_SEARCH_RETRY_DELAYS_MILLISECONDS.length})`)
      await options.wait(delay)
      continue
    }

    return { ok: false, error: describeJevHttpFailure(status, responseText) }
  }
}

export default class JevSearch extends ZettlrCommand {
  /**
   * Probability per computeJevCacheKey(prompt, chunk); lives as long as the
   * application and is never written to disk
   */
  private readonly cache: Map<string, number>
  private readonly dependencies: JevSearchDependencies

  constructor (app: AppServiceContainer, dependencies: Partial<JevSearchDependencies> = {}) {
    super(app, JEV_SEARCH_COMMAND)
    this.cache = new Map()
    this.dependencies = {
      fetch: dependencies.fetch ?? (async (url, init) => await fetch(url, init)),
      wait: dependencies.wait ?? (async (milliseconds) => { await new Promise(resolve => setTimeout(resolve, milliseconds)) }),
      environment: dependencies.environment ?? process.env,
      requestTimeoutMilliseconds: dependencies.requestTimeoutMilliseconds ?? JEV_SEARCH_REQUEST_TIMEOUT_MILLISECONDS
    }
  }

  /**
   * Judges every chunk of the batch against the search description.
   *
   * @param   {string}               evt  The event name
   * @param   {JevSearchCommandArg}  arg  The search description and the chunks
   *
   * @return  {Promise<JevSearchResult>}  One probability per chunk, or the reason for failure; never rejects
   */
  async run (evt: string, arg: JevSearchCommandArg): Promise<JevSearchResult> {
    let apiKey: string|undefined
    try {
      const problem = validateJevSearchArg(arg)
      if (problem !== undefined) {
        this._app.log.warning(`[JevSearch] Refused the request: ${problem}`)
        return failure(problem)
      }
      const { prompt, chunks } = arg

      if (chunks.length === 0) {
        return { ok: true, probabilities: [], requestCount: 0, estimatedInputTokens: 0 }
      }

      const payloadTokens = estimateJevRequestTokens(prompt, chunks)
      if (payloadTokens > JEV_SEARCH_REQUEST_HARD_LIMIT_TOKENS) {
        const error = `The batch is too large for one request: about ${payloadTokens} estimated tokens, the limit is ${JEV_SEARCH_REQUEST_HARD_LIMIT_TOKENS}`
        this._app.log.error(`[JevSearch] ${error} (${chunks.length} chunks)`)
        return failure(error)
      }

      apiKey = resolveJevApiKey(this._app.config.get().jevSearch.apiKey, this.dependencies.environment)
      if (apiKey === undefined) {
        this._app.log.warning('[JevSearch] No TypeSafe API key is configured; no request was sent')
        return failure(JEV_SEARCH_MISSING_KEY_MESSAGE)
      }

      // Look every chunk up in the cache; identical uncached chunks are sent
      // only once.
      const cacheKeys = chunks.map(chunk => computeJevCacheKey(prompt, chunk))
      const probabilities = cacheKeys.map(key => this.cache.get(key))
      const keysToSend: string[] = []
      const chunksToSend: string[] = []
      const queuedKeys = new Set<string>()
      probabilities.forEach((probability, index) => {
        if (probability === undefined && !queuedKeys.has(cacheKeys[index])) {
          queuedKeys.add(cacheKeys[index])
          keysToSend.push(cacheKeys[index])
          chunksToSend.push(chunks[index])
        }
      })

      if (chunksToSend.length === 0) {
        this._app.log.info(`[JevSearch] All ${chunks.length} chunk(s) came from the cache; no request was sent`)
        return { ok: true, probabilities: probabilities as number[], requestCount: 0, estimatedInputTokens: 0 }
      }

      const estimatedInputTokens = estimateJevRequestTokens(prompt, chunksToSend)
      const cachedCount = probabilities.filter(probability => probability !== undefined).length
      this._app.log.info(`[JevSearch] Judging ${chunksToSend.length} chunk(s) (${cachedCount} of ${chunks.length} from the cache), about ${estimatedInputTokens} estimated tokens`)

      const startedAt = Date.now()
      const posted = await postJevRequest({
        endpoint: resolveJevEndpoint(this.dependencies.environment),
        apiKey,
        body: buildJevRequestBody(prompt, chunksToSend),
        fetch: this.dependencies.fetch,
        wait: this.dependencies.wait,
        timeoutMilliseconds: this.dependencies.requestTimeoutMilliseconds,
        log: this._app.log
      })
      const elapsed = Date.now() - startedAt

      if (!posted.ok) {
        const error = redactSecret(posted.error, apiKey)
        this._app.log.error(`[JevSearch] Request for ${chunksToSend.length} chunk(s) failed after ${elapsed} ms: ${error}`)
        return failure(error)
      }

      const parsed = parseJevResponse(posted.responseText, chunksToSend.length)
      if (!parsed.ok) {
        const error = redactSecret(parsed.error, apiKey)
        this._app.log.error(`[JevSearch] Response for ${chunksToSend.length} chunk(s) after ${elapsed} ms was unusable: ${error}`)
        return failure(error)
      }

      const received = new Map<string, number>()
      parsed.probabilities.forEach((probability, index) => {
        received.set(keysToSend[index], probability)
        this.remember(keysToSend[index], probability)
      })

      const result = cacheKeys.map((key, index) => probabilities[index] ?? received.get(key)!)
      this._app.log.info(`[JevSearch] Judged ${chunksToSend.length} chunk(s) in ${elapsed} ms`)
      return { ok: true, probabilities: result, requestCount: 1, estimatedInputTokens }
    } catch (error) {
      const message = redactSecret(error instanceof Error ? error.message : String(error), apiKey)
      this._app.log.error(`[JevSearch] Search failed: ${message}`)
      return failure(message)
    }
  }

  /**
   * Stores a probability, forgetting the oldest entries beyond the cache size.
   */
  private remember (key: string, probability: number): void {
    this.cache.delete(key)
    this.cache.set(key, probability)
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.cache.delete(oldest)
    }
  }
}
