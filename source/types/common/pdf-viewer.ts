/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        PDF viewer shared types and constants
 * CVM-Role:        Types
 * License:         GNU GPL v3
 *
 * Description:     Shared between the pdf.js-based PDF viewer in
 *                  source/win-main/file-viewers, the pure text-position
 *                  functions in source/common/modules/pdf-text, the PDF
 *                  support of the JEV Search panel and the PDF++-compatible
 *                  quote and link handling (Zettlr-LYH R59 to R62, contract
 *                  C5). Positions inside a page are expressed exactly like
 *                  the `selection=` parameter of links written by the
 *                  Obsidian plugin PDF++, so that notes taken in Obsidian
 *                  open at the right place in Zettlr and vice versa.
 *
 * END HEADER
 */

/**
 * Options passed to every `page.getTextContent()` call. They equal the ones
 * pdf.js 6.3's TextLayerBuilder uses, so that item numbers computed from the
 * text content match the indices of the text layer's `textDivs`.
 */
export const PDF_TEXT_CONTENT_OPTIONS = {
  includeMarkedContent: true,
  disableNormalization: true
} as const

/**
 * A position inside the text of one page. `index` counts the text content
 * items whose `str` is not undefined, from 0, in their original order (marked
 * content items do not count; empty strings do). `offset` is a UTF-16 offset
 * into that item's `str`, from 0 to `str.length`.
 */
export interface PdfTextPosition {
  index: number
  offset: number
}

/**
 * A range of text inside one page; the begin is included, the end is not
 * (like a DOM Range's endOffset). The four numbers are those of PDF++'s
 * `selection=beginIndex,beginOffset,endIndex,endOffset`.
 */
export interface PdfTextSelection {
  beginIndex: number
  beginOffset: number
  endIndex: number
  endOffset: number
}

/**
 * The text of one page as one string: the items' `str` concatenated in
 * order, with a `\n` appended after every item whose `hasEOL` is true.
 * `itemStarts[k]` is the offset at which item k starts in `text`.
 */
export interface PdfPageText {
  text: string
  itemStarts: number[]
}

/**
 * A place in a PDF: a page (from 1), optionally a range on it and a
 * highlight color name (lowercase, as in PDF++'s `color=`)
 */
export interface PdfLocation {
  page: number
  selection?: PdfTextSelection
  color?: string
}

/**
 * Data of the pdfViewerRequest editor command. The viewer that shows
 * `filePath` in the last focused leaf, as that leaf's active file, scrolls to
 * `location` and highlights it; every other PDF viewer removes its location
 * highlight. A null location only removes the highlight. `scroll` defaults to
 * true; false replaces the highlight without scrolling.
 */
export interface PdfViewerRequest {
  filePath: string
  location: PdfLocation|null
  scroll?: boolean
  /**
   * The quoted text below the clicked link (the `> > ` lines of a PDF++
   * quote), if any. The viewer compares it with the text of the location's
   * selection and, if they differ, looks it up on the page (decision 071, via
   * resolveSelectionBySourceText of source/common/modules/pdf-text).
   */
  sourceText?: string
}

/**
 * Name of the window event the editor dispatches after it has opened the PDF
 * of a clicked link that names a location (R60). Its detail is a
 * PdfLinkLocateDetail; the main window turns it into a pdfViewerRequest.
 */
export const PDF_LINK_LOCATE_EVENT = 'zettlr-lyh-pdf-link-locate'

/**
 * Detail of the PDF_LINK_LOCATE_EVENT window event. `filePath` is the absolute
 * path exactly as it was passed to the documents provider's open-file command;
 * `sourceText` is the quoted text below the link (absent if the link has no
 * selection or is not followed by `> > ` lines).
 */
export interface PdfLinkLocateDetail {
  filePath: string
  location: PdfLocation
  sourceText?: string
}

/**
 * Name under which the location highlight is registered in CSS.highlights
 */
export const PDF_LOCATION_HIGHLIGHT_NAME = 'zettlr-lyh-pdf-location'

/**
 * Background colors of the named highlight colors, taken from the PDF++
 * settings on the author's machine
 */
export const PDF_HIGHLIGHT_COLORS: Record<string, string> = {
  yellow: '#f8efc9',
  red: '#ffd1d1',
  note: '#d6e4f5',
  important: '#e9d3f3'
}

/**
 * Background of a location highlight without a known color name: the amber
 * of the editor's JEV Search highlight (R53)
 */
export const PDF_DEFAULT_HIGHLIGHT_COLOR = 'rgba(224, 160, 0, 0.35)'

/**
 * localStorage key under which the viewer remembers, per absolute file path,
 * the last page and zoom
 */
export const PDF_VIEW_STATE_STORAGE_KEY = 'zettlr-lyh-pdf-view-state'

/**
 * Most recently used files whose view state is kept
 */
export const PDF_VIEW_STATE_MAX_ENTRIES = 200

/**
 * Zoom of a file opened for the first time (PDF++ on the author's machine
 * uses 120 %)
 */
export const PDF_VIEWER_DEFAULT_ZOOM = 1.2

/**
 * What the viewer remembers about one file
 */
export interface PdfViewState {
  page: number
  zoom: number
}

/**
 * Callout type written by Copy as Quote (PDF++ setting `calloutType`)
 */
export const PDF_QUOTE_CALLOUT_TYPE = 'PDF'

/**
 * Color names offered by the viewer's color picker, in palette order; the
 * first one is the default (PDF++ setting `defaultColor`)
 */
export const PDF_QUOTE_COLOR_NAMES = [ 'yellow', 'red', 'note', 'important' ]

/**
 * What formatPdfQuote needs to write one quote in PDF++'s "Quote in callout"
 * format
 */
export interface PdfQuoteParts {
  /**
   * Link target as it appears between the parentheses: the encoded path,
   * `#` and the fragment
   */
  linkTarget: string
  /**
   * Link text, e.g. 《Ekins 2021, UV-adVISor》P8
   */
  displayText: string
  /**
   * Quoted text, already passed through toQuoteText
   */
  text: string
  /**
   * Color name written into the callout header
   */
  color: string
}

/**
 * One JEV Search chunk of a PDF (R61). Chunks never span pages; `from` and
 * `to` are offsets into that page's PdfPageText.text, and `text` always
 * equals that text sliced from `from` to `to`.
 */
export interface PdfJevSearchChunk {
  page: number
  from: number
  to: number
  text: string
}

/**
 * How a PDF link is written in a note: a Markdown link `[text](target)` or a
 * PDF++ wiki link `[[contents]]` (R62, contract C11)
 */
export type PdfLinkSyntax = 'markdown' | 'wiki'

/**
 * One PDF link found in a note by scanPdfLinks, not yet resolved to a file
 */
export interface PdfNoteLink {
  /**
   * Line of the link, from 1, as CodeMirror counts lines
   */
  line: number
  syntax: PdfLinkSyntax
  /**
   * True if the link is preceded by `!` (`![[a.pdf#...]]`, `![x](a.pdf#...)`)
   */
  embed: boolean
  /**
   * The path as written: for Markdown links still percent-encoded, with angle
   * brackets removed; for wiki links the part before `|` and `#`
   */
  writtenPath: string
  /**
   * Result of parsePdfLinkFragment; its color comes only from the link's own
   * `&color=`
   */
  location: PdfLocation
  /**
   * Bracketed text of a Markdown link, text after `|` of a wiki link, or an
   * empty string
   */
  displayText: string
  /**
   * Color of the `> [!PDF|color]` callout header the link stands in (trimmed,
   * lowercase; an empty string for `[!PDF|]`); undefined if the link is not on
   * a callout header line
   */
  calloutColor?: string
  /**
   * The `> > ` quoted text below the link (extractQuotedSourceText), if any
   */
  sourceText?: string
}

/**
 * A PDF link resolved to the PDF it points to
 */
export interface PdfBacklink extends PdfNoteLink {
  /**
   * Absolute path of the note
   */
  notePath: string
  /**
   * Absolute path of the PDF the link resolves to
   */
  pdfPath: string
  /**
   * Highlight color name (lowercase) as determined by resolveBacklinkColor
   */
  color: string
}

/**
 * What resolvePdfLinkPath needs to know about the file system. `listFiles`
 * returns every file below `root` recursively, as absolute paths;
 * `ignoreCase` is true on Windows and macOS.
 */
export interface PdfPathEnvironment {
  workspaceRoots: string[]
  exists: (path: string) => Promise<boolean>
  listFiles: (root: string) => Promise<string[]>
  ignoreCase: boolean
}

/**
 * Prefix of the CSS.highlights names of the backlink highlights; the full
 * name is `${PDF_BACKLINK_HIGHLIGHT_PREFIX}-${colorKey}`, colorKey being
 * yellow, red, note, important or default
 */
export const PDF_BACKLINK_HIGHLIGHT_PREFIX = 'zettlr-pdf-backlink'

/**
 * localStorage key under which the viewer remembers, for all PDFs, whether
 * backlink highlights are shown
 */
export const PDF_BACKLINKS_VISIBLE_STORAGE_KEY = 'zettlr-lyh-pdf-backlinks-visible'

/**
 * Opacity of the backlink highlight backgrounds; the location highlight is
 * drawn opaque above them (decision on question 597)
 */
export const PDF_BACKLINK_HIGHLIGHT_ALPHA = 0.6

/**
 * Time the mouse must rest on a backlink highlight before the popup appears
 */
export const PDF_BACKLINK_HOVER_DELAY_MS = 300

/**
 * Name of the window event the PDF viewer dispatches to open the note of a
 * backlink; its detail is a PdfBacklinkOpenDetail, handled by App.vue
 */
export const PDF_BACKLINK_OPEN_EVENT = 'zettlr-pdf-backlink-open'

/**
 * Detail of the PDF_BACKLINK_OPEN_EVENT window event
 */
export interface PdfBacklinkOpenDetail {
  notePath: string
  lineNumber: number
  pdfLeafId: string
}

/**
 * Payload of the `pdf-backlinks-updated` broadcast: absolute paths of the
 * PDFs whose backlinks changed, or null after a full rebuild
 */
export interface PdfBacklinksUpdatedMessage {
  pdfPaths: string[]|null
}
