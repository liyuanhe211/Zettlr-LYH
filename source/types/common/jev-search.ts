/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        JEV semantic search shared types and constants
 * CVM-Role:        Types
 * License:         GNU GPL v3
 *
 * Description:     Shared between the main-process jev-search command, the
 *                  renderer's JEV Search panel and the chunking module in
 *                  source/common/modules/jev-search. The renderer splits the
 *                  active document into chunks, groups them into batches that
 *                  stay below JEV_SEARCH_REQUEST_TOKEN_BUDGET estimated tokens
 *                  and sends one jev-search command per batch; the command
 *                  asks TypeSafe's Jev model one yes/no question per chunk and
 *                  returns the probability of "yes" for each chunk.
 *
 * END HEADER
 */

/**
 * Name of the command on the 'application' IPC channel
 */
export const JEV_SEARCH_COMMAND = 'jev-search'

/**
 * TypeSafe System One endpoint
 */
export const JEV_SEARCH_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

/**
 * When this environment variable is non-empty, the command posts to its value
 * instead of JEV_SEARCH_ENDPOINT. Only test doubles use it.
 */
export const JEV_SEARCH_ENDPOINT_OVERRIDE_VARIABLE = 'ZETTLR_TYPESAFE_ENDPOINT'

/**
 * Environment variable consulted when the configured API key is empty
 */
export const JEV_SEARCH_API_KEY_VARIABLE = 'TYPESAFE_API_KEY'

export const JEV_SEARCH_MODEL = 'jev-latest'

export const JEV_SEARCH_DEFAULT_MAX_CHUNK_CHARACTERS = 1000
export const JEV_SEARCH_MIN_MAX_CHUNK_CHARACTERS = 200
export const JEV_SEARCH_MAX_MAX_CHUNK_CHARACTERS = 8000

/**
 * Estimated-token budget of one request; the renderer batches chunks so that
 * no request exceeds it.
 */
export const JEV_SEARCH_REQUEST_TOKEN_BUDGET = 16000

/**
 * The command refuses payloads estimated above this. TypeSafe rejects
 * requests above 64k tokens, and the local estimate runs low on some text.
 */
export const JEV_SEARCH_REQUEST_HARD_LIMIT_TOKENS = 60000

/**
 * Estimated tokens the batch planner reserves per request and per chunk for
 * the request skeleton and the question text
 */
export const JEV_SEARCH_BASE_OVERHEAD_TOKENS = 500
export const JEV_SEARCH_PER_CHUNK_OVERHEAD_TOKENS = 80

/**
 * Chunks whose probability reaches this value are listed as hits
 */
export const JEV_SEARCH_HIT_THRESHOLD = 0.3

/**
 * Upper bound of jev-search commands the panel keeps in flight at once
 */
export const JEV_SEARCH_MAX_CONCURRENT_REQUESTS = 3

export const JEV_SEARCH_MISSING_KEY_MESSAGE = 'No TypeSafe API key. Enter it in Preferences → Advanced → JEV Search, or set the TYPESAFE_API_KEY environment variable.'

/**
 * Rough token estimate shared by the batch planner and the command: an ASCII
 * character counts as 1/3.5 token, any other UTF-16 unit (mostly CJK) as 1/1.2.
 *
 * @param   {string}  text  The text to estimate
 *
 * @return  {number}        Estimated tokens, rounded up
 */
export function estimateJevTokens (text: string): number {
  let asciiCount = 0
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) < 128) {
      asciiCount++
    }
  }
  return Math.ceil(asciiCount / 3.5 + (text.length - asciiCount) / 1.2)
}

/**
 * The yes/no question asked about one chunk. A single highly relevant passage
 * is enough for "yes"; the question is not about average relevance.
 *
 * @param   {number}  index  Position of the chunk in the request's state
 *
 * @return  {string}         The instruction text of the noul question
 */
export function jevSearchQuestion (index: number): string {
  return `Does \`chunks.chunk_${index}\` contain at least one passage that is relevant to what the user is searching for, as described in \`prompt\`? Answer yes even if only a single sentence is highly relevant and the rest of the chunk is unrelated.`
}

/**
 * One chunk of a document, produced by splitIntoJevChunks
 */
export interface JevSearchChunk {
  /**
   * Offset of the chunk's first character in the document
   */
  from: number
  /**
   * Offset just past the chunk's last character
   */
  to: number
  /**
   * Always equal to the document's text sliced from `from` to `to`
   */
  text: string
}

/**
 * Payload of the jev-search command: one batch of chunks
 */
export interface JevSearchCommandArg {
  /**
   * What the user is looking for, in natural language
   */
  prompt: string
  /**
   * Chunk texts in document order; each is judged independently
   */
  chunks: string[]
}

/**
 * What the jev-search command returns; the command never rejects.
 */
export interface JevSearchResult {
  /**
   * True when every chunk received a probability
   */
  ok: boolean
  /**
   * Probability of "yes" (0 to 1) per chunk, same order and length as the
   * payload's chunks (present when ok is true)
   */
  probabilities?: number[]
  /**
   * TypeSafe requests actually sent: 0 when every chunk came from the cache
   */
  requestCount?: number
  /**
   * Estimated input tokens of the request actually sent
   */
  estimatedInputTokens?: number
  /**
   * One-line description of what went wrong (present when ok is false)
   */
  error?: string
}
