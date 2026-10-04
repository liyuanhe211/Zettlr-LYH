/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        buildPandocAttributeSectionItems, PANDOC_TARGET_MENU_LABEL
 *
 * Description:     Pure builder of the Pandoc section of the editor context
 *                  menus (requirement R21). Given the editable objects around
 *                  the cursor (see pandoc-attribute-targets.ts), it returns the
 *                  menu items: for tables two top-level toggles (Equal Column
 *                  Widths, Equal Row Heights), then one submenu per object with
 *                  checkboxes for boolean, flag and class keys, radio submenus
 *                  for choice keys, and a final "Edit All…" entry. The items
 *                  only call the two provided callbacks, so this module has no
 *                  dependency on an EditorView and can be unit tested.
 *
 * END HEADER
 */

import type { AnyMenuItem, CheckboxRadioItem, SeparatorItem, SubmenuItem, NormalItem } from '@common/modules/window-register/application-menu-helper'
import {
  PANDOC_ATTRIBUTE_SCHEMA,
  type PandocAttributeKey,
  type PandocAttributeTarget,
  type PandocAttributeTargetKind,
  type PandocAttributeUpdate
} from '@common/pandoc-util/pandoc-attribute-schema'

/** Submenu label per object kind */
export const PANDOC_TARGET_MENU_LABEL: Record<PandocAttributeTargetKind, string> = {
  span: 'Text Attributes',
  image: 'Image Attributes',
  column: 'Column Attributes',
  table: 'Table Attributes',
  block: 'Block Style',
  page: 'Page Attributes'
}

export interface PandocAttributeSectionCallbacks {
  /** Writes the update for the given object back into the document */
  apply: (target: PandocAttributeTarget, update: PandocAttributeUpdate) => void
  /** Opens the attribute popover focused on the given object */
  editAll: (target: PandocAttributeTarget) => void
}

type SubmenuEntry = CheckboxRadioItem|SeparatorItem|SubmenuItem|NormalItem

/**
 * Returns the label shown for a choice value
 *
 * @param   {string}  choice  The choice value
 *
 * @return  {string}          The label
 */
function choiceLabel (choice: string): string {
  return choice === '' ? 'Default' : choice
}

/**
 * Builds a checkbox that toggles a key between "set" and "removed".
 *
 * @param   {PandocAttributeTarget}            target     The object
 * @param   {string}                           key        The key
 * @param   {string}                           label      The item label
 * @param   {boolean}                          checked    Whether the key is on
 * @param   {string}                           onValue    Value written when switching on
 * @param   {PandocAttributeSectionCallbacks}  callbacks  The callbacks
 *
 * @return  {CheckboxRadioItem}                           The item
 */
function toggleItem (
  target: PandocAttributeTarget,
  key: string,
  label: string,
  checked: boolean,
  onValue: string,
  callbacks: PandocAttributeSectionCallbacks
): CheckboxRadioItem {
  return {
    type: 'checkbox',
    label,
    checked,
    action () { callbacks.apply(target, { [key]: checked ? undefined : onValue }) }
  }
}

/**
 * Builds the menu entry for one catalog key, or undefined for keys that need
 * free input (text, number, length, size, color); those are only editable in
 * the popover.
 *
 * @param   {PandocAttributeTarget}            target     The object
 * @param   {PandocAttributeKey}               entry      The catalog entry
 * @param   {PandocAttributeSectionCallbacks}  callbacks  The callbacks
 *
 * @return  {SubmenuEntry|undefined}                      The menu entry
 */
function keyItem (target: PandocAttributeTarget, entry: PandocAttributeKey, callbacks: PandocAttributeSectionCallbacks): SubmenuEntry|undefined {
  const current = target.values[entry.key]

  switch (entry.type) {
    case 'boolean':
      return toggleItem(target, entry.key, entry.label, current === 'true', 'true', callbacks)
    case 'flag':
    case 'class':
      return toggleItem(target, entry.key, entry.label, current !== undefined, '', callbacks)
    case 'choice': {
      const choices = entry.choices ?? []
      return {
        type: 'submenu',
        label: entry.label,
        submenu: choices.map((choice, index): CheckboxRadioItem => {
          // An absent key means the default, i.e., the first choice. A free
          // text value (allowFreeText) matches none of the presets.
          const checked = current === undefined ? index === 0 : current === choice
          return {
            type: 'radio',
            label: choiceLabel(choice),
            checked,
            action () { callbacks.apply(target, { [entry.key]: index === 0 ? undefined : choice }) }
          }
        })
      }
    }
    default:
      return undefined
  }
}

/**
 * Builds the Pandoc section of a context menu. Returns an empty array when
 * there is no editable object; otherwise the items start with a separator so
 * that they can be appended to any existing menu.
 *
 * @param   {PandocAttributeTarget[]}          targets    Objects, innermost first
 * @param   {PandocAttributeSectionCallbacks}  callbacks  What the items do
 *
 * @return  {AnyMenuItem[]}                               The menu items
 */
export function buildPandocAttributeSectionItems (targets: PandocAttributeTarget[], callbacks: PandocAttributeSectionCallbacks): AnyMenuItem[] {
  if (targets.length === 0) {
    return []
  }

  const items: AnyMenuItem[] = [{ type: 'separator' }]

  const table = targets.find(target => target.kind === 'table')
  if (table !== undefined) {
    items.push(
      toggleItem(table, 'col-widths', 'Equal Column Widths', table.values['col-widths'] === 'equal', 'equal', callbacks),
      toggleItem(table, 'row-heights', 'Equal Row Heights', table.values['row-heights'] === 'equal', 'equal', callbacks)
    )
  }

  for (const target of targets) {
    const submenu: SubmenuEntry[] = []
    for (const entry of PANDOC_ATTRIBUTE_SCHEMA[target.kind]) {
      const item = keyItem(target, entry, callbacks)
      if (item !== undefined) {
        submenu.push(item)
      }
    }

    if (submenu.length > 0) {
      submenu.push({ type: 'separator' })
    }

    submenu.push({
      type: 'normal',
      label: 'Edit All…',
      action () { callbacks.editAll(target) }
    })

    items.push({ type: 'submenu', label: PANDOC_TARGET_MENU_LABEL[target.kind], submenu })
  }

  return items
}
