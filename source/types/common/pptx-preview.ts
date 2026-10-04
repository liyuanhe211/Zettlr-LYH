/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Pandoc PPTX preview shared types
 * CVM-Role:        Types
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Types shared between the main-process pptx-preview command
 *                  and the renderer preview pane. The command converts pandoc
 *                  slide Markdown into per-slide PNG renderings through a
 *                  resident Python worker and publishes its state over the
 *                  PPTX_PREVIEW_EVENT_CHANNEL broadcast channel.
 *
 * END HEADER
 */

/**
 * Broadcast channel on which the main process publishes preview state updates.
 * The payload of every message is a { state: PptxPreviewState } object.
 */
export const PPTX_PREVIEW_EVENT_CHANNEL = 'pptx-preview-event'

/**
 * Payload of the 'pptx-preview' command on the 'application' IPC channel.
 */
export interface PptxPreviewCommandArg {
  /**
   * 'open' starts a preview session for the file and runs a first conversion
   * cycle; 'refresh' re-runs a cycle over the current document content;
   * 'close' ends the session (the disk cache is kept).
   */
  action: 'open'|'refresh'|'close'
  /**
   * Absolute path of the Markdown document being previewed
   */
  filePath: string
}

/**
 * An overflow finding of the conversion pipeline's detection step: the text of
 * a shape exceeds its placeholder box, so the page needs splitting in the
 * Markdown source.
 */
export interface PptxPreviewOverflowEntry {
  /**
   * Name of the offending shape on the slide
   */
  shape: string
  /**
   * By how many points the text exceeds the box
   */
  excessPt: number
}

/**
 * An undersized-text finding: text below the template's minimum font size
 * (caption text boxes excepted).
 */
export interface PptxPreviewUndersizedEntry {
  /**
   * Name of the offending shape on the slide
   */
  shape: string
  /**
   * The effective font size found
   */
  sizePt: number
  /**
   * The first characters of the offending text run
   */
  snippet: string
}

/**
 * One source page (chunk) of the previewed document. A chunk normally renders
 * to exactly one slide image, but pandoc splits some page contents (for
 * example a table mixed with other content) into several slides, in which case
 * all resulting images belong to this chunk.
 */
export interface PptxPreviewSlide {
  /**
   * Content hash of the chunk (also the cache key of its rendered images)
   */
  key: string
  /**
   * 'ready' when images are available, 'pending' while conversion is queued or
   * running, 'error' when the chunk's conversion batch failed
   */
  status: 'pending'|'ready'|'error'
  /**
   * Absolute paths of the rendered PNG images (empty while pending)
   */
  images: string[]
  /**
   * Overflow findings for this chunk's slides (ready chunks only)
   */
  overflow: PptxPreviewOverflowEntry[]
  /**
   * Undersized-text findings for this chunk's slides (ready chunks only)
   */
  undersized: PptxPreviewUndersizedEntry[]
  /**
   * 0-based line number where this chunk starts in the Markdown source
   */
  startLine: number
  /**
   * Present on status 'error': a one-line description of what failed
   */
  errorMessage?: string
}

/**
 * The complete published state of one preview session. States are published
 * whole (idempotently) after planning and after every finished batch, so the
 * renderer can always replace its previous state.
 */
export interface PptxPreviewState {
  /**
   * Absolute path of the previewed Markdown document
   */
  filePath: string
  /**
   * Increases by one with every conversion cycle; within a cycle, successive
   * publishes carry the same generation
   */
  generation: number
  /**
   * True while conversion batches of the current cycle are still outstanding
   */
  building: boolean
  /**
   * Number of chunks still pending in the current cycle
   */
  pendingCount: number
  /**
   * All pages of the document in source order
   */
  slides: PptxPreviewSlide[]
  /**
   * Absolute path of the .potx template this cycle rendered against
   */
  referenceDoc: string
  /**
   * 'document' when the template came from the document's configuration
   * comment, 'default' when it is the application's built-in template
   */
  referenceDocSource: 'document'|'default'
  /**
   * Present when the whole cycle failed (worker unavailable, template missing)
   */
  error?: string
}
