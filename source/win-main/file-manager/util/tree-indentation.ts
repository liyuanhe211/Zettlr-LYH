/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Tree indentation constants
 * CVM-Role:        Utility
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Holds the horizontal indentation the file manager applies
 *                  per nesting level. Both trees in the left hand pane import
 *                  it so that the Files section and the Workspaces section can
 *                  never drift apart.
 *
 * END HEADER
 */

/**
 * How many pixels every nesting level adds to the indentation of a row.
 */
export const TREE_INDENT_PER_LEVEL = 8

/**
 * How many pixels of indentation a row at the outermost level already has.
 */
export const TREE_INDENT_BASE = 6
