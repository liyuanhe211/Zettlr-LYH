/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Zoom helpers of the PDF viewer
 * CVM-Role:        Utility function
 * License:         GNU GPL v3
 *
 * Description:     Zettlr-LYH R59 (contract C5): two rules the viewer follows
 *                  whenever the zoom changes, kept free of Vue and pdf.js so
 *                  that mocha can test them.
 *                  First, pdf.js scrolls back to the place it last recorded
 *                  when it sets a new zoom, and it records the place only in
 *                  an animation frame after scrolling. A zoom right after going
 *                  to a page, or any zoom in a window that draws no frames
 *                  (hidden or covered), therefore went back to the page shown
 *                  before. changeZoomKeepingPlace records the place first.
 *                  Second, the zoom levels Page Width, Page Fit and Auto have
 *                  to be computed again when the pages area changes its size.
 *                  A resize observer reports that only when the window draws a
 *                  frame; needsFitZoomUpdate lets a timer compare the size the
 *                  levels were last computed for with the size now, so that a
 *                  change the observer has not reported is applied as well.
 *
 * END HEADER
 */

/**
 * The zoom levels that pdf.js computes from the page and container size;
 * they have to be computed again whenever the container changes its size
 */
export const FIT_ZOOM_VALUES: readonly string[] = [ 'page-width', 'page-fit', 'auto' ]

/**
 * The size of the pages area, in CSS pixels (clientWidth and clientHeight)
 */
export interface PagesAreaSize {
  width: number
  height: number
}

/**
 * The part of pdf.js' PDFViewer that changeZoomKeepingPlace uses
 */
export interface PlaceRecordingViewer {
  // Records the place shown (and the current page) from the scroll position
  update: () => void
}

/**
 * Changes the zoom after recording the place shown, so that pdf.js keeps the
 * place the reader sees now instead of one it recorded earlier
 *
 * @param   {PlaceRecordingViewer}  pdfViewer  The pdf.js viewer
 * @param   {Function}              change     Sets the new zoom on pdfViewer
 */
export function changeZoomKeepingPlace (pdfViewer: PlaceRecordingViewer, change: () => void): void {
  pdfViewer.update()
  change()
}

/**
 * Whether the zoom has to be computed again for the current size of the
 * pages area: only for Page Width, Page Fit and Auto, only while the area is
 * shown (a hidden area has a zero size), and only if the size differs from
 * the one the zoom was last computed for (or it was never computed)
 *
 * @param   {string}               scaleValue   pdf.js' currentScaleValue
 * @param   {PagesAreaSize|null}   appliedSize  The size last computed for, if any
 * @param   {PagesAreaSize}        currentSize  The size now
 *
 * @return  {boolean}                           True if it has to be computed again
 */
export function needsFitZoomUpdate (scaleValue: string, appliedSize: PagesAreaSize|null, currentSize: PagesAreaSize): boolean {
  if (!FIT_ZOOM_VALUES.includes(scaleValue)) {
    return false
  }

  if (currentSize.width === 0 || currentSize.height === 0) {
    return false
  }

  return appliedSize === null || appliedSize.width !== currentSize.width || appliedSize.height !== currentSize.height
}
