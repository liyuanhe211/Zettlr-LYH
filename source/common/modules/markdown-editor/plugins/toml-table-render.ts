/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TOML Table Render
 * CVM-Role:        CodeMirror Plugin
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     The Show Tables setting of the TOML Formatted mode (R128).
 *                  While it is on, a TOML table section whose lines are all
 *                  simple `key = value` lines is shown as a grid of keys,
 *                  values and comments, and consecutive `[[name]]` sections of
 *                  the same name are united into one grid with one row per
 *                  section. A grid is a block replacement widget, so the
 *                  characters of the document stay as they are; the grid only
 *                  hides the source lines, and it gives way to them as soon
 *                  as the cursor or the selection touches them. Clicking a
 *                  cell puts the cursor into the source at that cell.
 *
 *                  The setting itself is global for the whole application: the
 *                  state field below holds it for one editor, and
 *                  setTOMLShowTables() carries a new value to the field of
 *                  every open TOML editor of this window (the editors register
 *                  themselves for that) and to the editors opened later.
 *
 * END HEADER
 */

import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view'
import { StateEffect, StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import { classifyTOMLSections, groupTOMLTableSections, type TOMLTableUnit } from '@common/util/toml-reading'

/**
 * The global value of the Show Tables setting. New editors start with it, and
 * setTOMLShowTables() changes it.
 */
let globalShowTables = false

/**
 * The views that carry the Show Tables state field, so that a new global value
 * can be handed to all of them.
 */
const registeredViews = new Set<EditorView>()

/**
 * Switches the Show Tables setting on or off in the state field of an editor.
 */
export const tomlShowTablesEffect = StateEffect.define<boolean>()

/**
 * The Show Tables setting of an editor. It starts with the global value and
 * only changes through the tomlShowTablesEffect.
 */
export const tomlShowTablesField = StateField.define<boolean>({
  create: () => globalShowTables,
  update (value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(tomlShowTablesEffect)) {
        value = effect.value
      }
    }
    return value
  }
})

/**
 * Registers every view that carries the Show Tables state field, for as long
 * as the view lives.
 */
export const tomlShowTablesRegistration = ViewPlugin.define(view => {
  registeredViews.add(view)
  return {
    destroy: () => { registeredViews.delete(view) }
  }
})

/**
 * Returns the global value of the Show Tables setting.
 *
 * @return  {boolean}  Whether tables are shown as grids
 */
export function getTOMLShowTables (): boolean {
  return globalShowTables
}

/**
 * Sets the global value of the Show Tables setting: it is handed to every open
 * editor whose value differs, and editors that open later start with it. This
 * changes how the document is displayed and never the document itself.
 *
 * @param  {boolean}  show  Whether tables are shown as grids
 */
export function setTOMLShowTables (show: boolean): void {
  globalShowTables = show
  for (const view of registeredViews) {
    if (view.state.field(tomlShowTablesField, false) !== show) {
      view.dispatch({ effects: tomlShowTablesEffect.of(show) })
    }
  }
}

/** One cell of a grid with the position the cursor goes to when it is clicked */
interface GridCell {
  text: string
  position: number
}

/** Everything a grid shows, and the range of the document it replaces */
interface GridModel {
  from: number
  to: number
  /** The line above the grid (`[[name]]`); null if there is none */
  title: string|null
  columns: string[]
  /** The index of the Comment column; -1 if there is none */
  commentColumn: number
  rows: GridCell[][]
}

/**
 * Describes the grid of a unit, if it has one.
 *
 * @param   {TOMLTableUnit}  unit  A normal section, the top-level section or a group of array table sections
 *
 * @return  {GridModel|null}       The grid; null if the unit is shown as source
 */
function gridModel (unit: TOMLTableUnit): GridModel|null {
  if (unit.kind === 'array-group') {
    if (!unit.displayable || unit.rows.length === 0) {
      return null
    }
    return {
      from: unit.from,
      to: unit.to,
      title: `[[${unit.name}]]`,
      columns: unit.hasComment ? [ ...unit.columns, 'Comment' ] : [...unit.columns],
      commentColumn: unit.hasComment ? unit.columns.length : -1,
      rows: unit.rows.map(row => {
        // An empty cell and the comment lead the cursor to the end of the header line of the row
        const cells: GridCell[] = row.cells.map(cell => cell === null
          ? { text: '', position: row.headerLineEnd }
          : { text: cell.value, position: cell.valueFrom })
        if (unit.hasComment) {
          cells.push({ text: row.comment, position: row.headerLineEnd })
        }
        return cells
      })
    }
  }

  const { section } = unit
  if (!section.displayable || section.rows.length === 0) {
    return null
  }
  const hasComment = section.rows.some(row => row.comment !== '')
  return {
    // The header line stays as it is; the grid replaces the key lines only
    from: section.rows[0].lineFrom,
    to: section.rows[section.rows.length - 1].lineTo,
    title: null,
    columns: hasComment ? [ 'Key', 'Value', 'Comment' ] : [ 'Key', 'Value' ],
    commentColumn: hasComment ? 2 : -1,
    rows: section.rows.map(row => {
      const cells: GridCell[] = [
        { text: row.key, position: row.keyFrom },
        { text: row.value, position: row.valueFrom }
      ]
      if (hasComment) {
        cells.push({ text: row.comment, position: row.lineTo })
      }
      return cells
    })
  }
}

/**
 * Puts the cursor to a position of the document and focuses the editor. The
 * position lies inside the range of the grid, so the grid gives way to the
 * source.
 *
 * @param  {EditorView}  view      The editor view
 * @param  {number}      position  The position of the cursor
 */
function revealSource (view: EditorView, position: number): void {
  const anchor = Math.max(0, Math.min(Number.isFinite(position) ? position : 0, view.state.doc.length))
  view.dispatch({ selection: { anchor }, userEvent: 'select.pointer' })
  view.focus()
}

/**
 * The grid of a section or of a group of array table sections.
 */
class TOMLGridWidget extends WidgetType {
  private readonly signature: string

  constructor (private readonly model: GridModel) {
    super()
    // The positions are part of the signature, so that a grid that moved
    // because of an edit above it is built anew with the right positions
    this.signature = JSON.stringify(model)
  }

  eq (other: TOMLGridWidget): boolean {
    return other.signature === this.signature
  }

  get estimatedHeight (): number {
    return (this.model.rows.length + 1) * 28 + (this.model.title !== null ? 44 : 0) + 12
  }

  toDOM (view: EditorView): HTMLElement {
    const model = this.model
    const container = document.createElement('div')
    container.className = 'cm-toml-table-widget'

    if (model.title !== null) {
      // Looks like the other table headers of the Formatted mode
      const title = document.createElement('div')
      title.className = 'cm-toml-table-title toml-table-heading'
      title.textContent = model.title
      title.dataset.position = String(model.from)
      container.appendChild(title)
    }

    const table = document.createElement('table')
    const headerRow = table.createTHead().insertRow()
    for (const column of model.columns) {
      const header = document.createElement('th')
      header.textContent = column
      headerRow.appendChild(header)
    }

    const body = table.createTBody()
    for (const row of model.rows) {
      const tableRow = body.insertRow()
      row.forEach((cell, index) => {
        const element = tableRow.insertCell()
        element.className = index === model.commentColumn ? 'cm-toml-cell cm-toml-comment' : 'cm-toml-cell'
        // The text is inserted as text, never as markup
        element.textContent = cell.text
        element.dataset.position = String(cell.position)
      })
    }
    container.appendChild(table)

    container.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      const cell = event.target instanceof Element ? event.target.closest('[data-position]') : null
      const position = cell instanceof HTMLElement && container.contains(cell) ? Number(cell.dataset.position) : model.from
      revealSource(view, position)
    })
    return container
  }

  ignoreEvent (): boolean {
    return true // The click listener handles everything
  }
}

/** What the grid field holds: the units, and the widgets derived from them */
interface GridState {
  show: boolean
  units: TOMLTableUnit[]
  decorations: DecorationSet
}

/** Splits the document into the units that are shown as one grid each */
function tableUnits (state: EditorState): TOMLTableUnit[] {
  return groupTOMLTableSections(classifyTOMLSections(state.doc.toString()))
}

/**
 * Builds the widgets for all units whose range the selection does not touch.
 *
 * @param   {EditorState}      state  The editor state
 * @param   {TOMLTableUnit[]}  units  The units of the document
 *
 * @return  {DecorationSet}           One block replacement per grid
 */
function gridDecorations (state: EditorState, units: TOMLTableUnit[]): DecorationSet {
  const decorations: Array<Range<Decoration>> = []
  for (const unit of units) {
    const model = gridModel(unit)
    if (model === null || model.from >= model.to) {
      continue
    }
    // The selection touches the range if it ends in it, starts in it or lies around it
    if (state.selection.ranges.some(range => range.from <= model.to && range.to >= model.from)) {
      continue
    }
    decorations.push(Decoration.replace({ widget: new TOMLGridWidget(model), block: true }).range(model.from, model.to))
  }
  return Decoration.set(decorations, true)
}

const noGrids: GridState = { show: false, units: [], decorations: Decoration.none }

/**
 * Shows the grids while the Show Tables state field is on. The document is
 * analysed again after every change of the document and when the setting is
 * switched on; the widgets are built again after every change of the document
 * or the selection. The field belongs to the Formatted mode, since the Raw Text
 * mode never shows grids; the setting itself lives in tomlShowTablesField.
 */
export const tomlTableRenderField = StateField.define<GridState>({
  create (state) {
    if (state.field(tomlShowTablesField, false) !== true) {
      return noGrids
    }
    const units = tableUnits(state)
    return { show: true, units, decorations: gridDecorations(state, units) }
  },
  update (value, transaction) {
    if (transaction.state.field(tomlShowTablesField, false) !== true) {
      return value.show ? noGrids : value
    }
    if (value.show && !transaction.docChanged && transaction.selection === undefined) {
      return value
    }
    const units = transaction.docChanged || !value.show ? tableUnits(transaction.state) : value.units
    return { show: true, units, decorations: gridDecorations(transaction.state, units) }
  },
  // Block widgets have to come directly from a state field
  provide: field => EditorView.decorations.from(field, value => value.decorations)
})

/**
 * The look of the grids: a plain table in the code font, with the borders and
 * the header background of the table of the HTML block renderer. Long values
 * wrap inside their cell.
 */
const tomlGridTheme = EditorView.baseTheme({
  '.cm-toml-table-widget': {
    display: 'block',
    margin: '4px 0',
    cursor: 'text',
    fontFamily: 'Inconsolata, "Liberation Mono", Consolas, monospace',
    overflowX: 'auto',
    // The editor content preserves whitespace, the grid must not add any
    whiteSpace: 'normal',
    textIndent: '0',
    '& table': {
      borderCollapse: 'collapse',
      width: '100%'
    },
    '& th, & td': {
      border: '1px solid rgba(128, 128, 128, 0.5)',
      padding: '3px 8px',
      textAlign: 'left',
      verticalAlign: 'top',
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere'
    },
    '& th': {
      backgroundColor: 'rgba(128, 128, 128, 0.12)',
      fontWeight: '700'
    },
    '& td.cm-toml-comment': {
      opacity: '0.75'
    }
  }
})

/**
 * Zettlr-LYH (R128): the grids of the Show Tables setting, for the Formatted
 * mode of a TOML document. Needs tomlShowTablesField in the editor state.
 */
export const tomlTableRender: Extension = [ tomlTableRenderField, tomlGridTheme ]
