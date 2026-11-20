/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        useConfigStore
 * CVM-Role:        Model
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This model manages the configuration
 *
 * END HEADER
 */

import { type ConfigOptions } from '@providers/config/get-config-template'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import _ from 'underscore'
import { defaultCodeEditingExceptions } from '@common/modules/markdown-editor/util/code-editing-policy'
import { defaultCopyVisibleTextCategories, normalizeCopyVisibleTextCategories, type CopyVisibleTextCategory } from '@common/modules/markdown-editor/util/visible-copy-policy'
import { characterPairLabels, isCharacterPairSettingsUpdate, normalizeCharacterPairSettings, type CharacterPair } from '@common/modules/markdown-editor/util/character-pair-policy'

const ipcRenderer = window.ipc

/**
 * Synchronously retrieves the configuration
 *
 * @return  {ConfigOptions}  The configuration
 */
function retrieveConfig (): ConfigOptions {
  const configuration: ConfigOptions = ipcRenderer.sendSync('config-provider', { command: 'get-config' })
  // The renderer can be hot-reloaded while an older main process is running.
  // Supply only the new editor defaults and preserve every existing setting.
  configuration.display = {
    ...configuration.display,
    editCodeWhenClicked: configuration.display.editCodeWhenClicked ?? false,
    codeEditingExceptions: { ...defaultCodeEditingExceptions, ...configuration.display.codeEditingExceptions },
    copyVisibleTextCategories: normalizeCopyVisibleTextCategories(configuration.display.copyVisibleTextCategories),
    showRevisions: configuration.display.showRevisions ?? true
  }
  // Zettlr-LYH (R84): the revision mode settings, for the same reason
  configuration.editor = {
    ...configuration.editor,
    autoCloseCharacterPairs: normalizeCharacterPairSettings(configuration.editor?.autoCloseCharacterPairs, configuration.editor?.autoCloseBrackets),
    trackChanges: configuration.editor?.trackChanges ?? false,
    revisionAuthor: configuration.editor?.revisionAuthor ?? ''
  }
  return configuration
}

export const useConfigStore = defineStore('config', () => {
  const config = ref<ConfigOptions>(retrieveConfig())

  // Throttle the retrieve function to once per 50ms. We want the config to
  // update some values extremely frequently, and with the throttle in place, we
  // ensure that the (sometimes heavy) config updaters don't cause lag.
  const throttledRetrieve = _.throttle(() => {
    config.value = retrieveConfig()
  }, 50)

  // Listen to subsequent changes
  ipcRenderer.on('config-provider', (event, { command }) => {
    if (command === 'update') {
      throttledRetrieve()
    }
  })

  function setConfigValue (property: string, value: unknown): boolean {
    if (property === 'editor.autoCloseCharacterPairs' || property.startsWith('editor.autoCloseCharacterPairs.')) {
      return setCharacterPairs(property, value)
    }
    if (property === 'display.editorMarginSingle' || property === 'display.editorMarginSplit') {
      return setEditorMargin(property, value)
    }
    if (property === 'display.copyVisibleTextCategories' || property.startsWith('display.copyVisibleTextCategories.')) {
      return setCopyVisibleTextCategories(property, value)
    }
    const isCodeEditingSetting = property === 'display.editCodeWhenClicked' ||
      property === 'display.codeEditingExceptions' || property.startsWith('display.codeEditingExceptions.')
    if (!isCodeEditingSetting) {
      return ipcRenderer.sendSync('config-provider', {
        command: 'set-config-single', payload: { key: property, val: value }
      })
    }
    try {
      let key = property
      let setting = value
      let expected = value
      if (isCodeEditingSetting) {
        const current: ConfigOptions = ipcRenderer.sendSync('config-provider', { command: 'get-config' })
        const parts = property.split('.').slice(1)
        if (property === 'display.editCodeWhenClicked') {
          if (typeof value !== 'boolean') {return false}
        } else if (property === 'display.codeEditingExceptions') {
          if (value === null || typeof value !== 'object' || Array.isArray(value) ||
            Object.entries(value).some(([ category, enabled ]) => !Object.prototype.hasOwnProperty.call(defaultCodeEditingExceptions, category) || typeof enabled !== 'boolean')) {return false}
          setting = { ...defaultCodeEditingExceptions, ...current.display.codeEditingExceptions, ...value }
          expected = setting
        } else if (parts.length !== 2 || !Object.prototype.hasOwnProperty.call(defaultCodeEditingExceptions, parts[1]) || typeof value !== 'boolean') {
          return false
        }
        let existing: any = current.display
        for (const part of parts) {existing = existing?.[part]}
        // Older main processes reject unknown dotted keys, but accept the
        // existing display object. Migrate that object without losing settings.
        if (existing === undefined) {
          const display = {
            ...current.display,
            editCodeWhenClicked: current.display.editCodeWhenClicked ?? false,
            codeEditingExceptions: { ...defaultCodeEditingExceptions, ...current.display.codeEditingExceptions }
          }
          if (property === 'display.editCodeWhenClicked') {
            display.editCodeWhenClicked = value as boolean
          } else if (property === 'display.codeEditingExceptions') {
            display.codeEditingExceptions = setting as typeof display.codeEditingExceptions
          } else {
            const category = parts[1]
            display.codeEditingExceptions[category as keyof typeof defaultCodeEditingExceptions] = value as boolean
          }
          key = 'display'
          setting = display
        }
      }
      const result = ipcRenderer.sendSync('config-provider', {
        command: 'set-config-single',
        payload: { key, val: setting }
      })
      // Old main processes return undefined even after a successful save.
      // Read the authoritative value before declaring success or updating Vue.
      const current: ConfigOptions = ipcRenderer.sendSync('config-provider', { command: 'get-config' })
      let actual: any = current
      for (const part of property.split('.')) {actual = actual?.[part]}
      config.value = retrieveConfig()
      return result !== false && _.isEqual(actual, expected)
    } catch (error) {
      console.error(`Could not save configuration setting ${property}`, error)
      return false
    }
  }

  function setEditorMargin (property: 'display.editorMarginSingle'|'display.editorMarginSplit', value: unknown): boolean {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 2000) {
      return false
    }
    try {
      // Use the raw main-process object, rather than renderer defaults or a
      // stale Vue snapshot, when migrating an unknown leaf through display.
      const current: ConfigOptions = ipcRenderer.sendSync('config-provider', { command: 'get-config' })
      const settingName = property === 'display.editorMarginSplit' ? 'editorMarginSplit' : 'editorMarginSingle'
      const missing = current.display[settingName] === undefined
      const key = missing ? 'display' : property
      const setting = missing ? { ...current.display, [settingName]: value } : value
      const result = ipcRenderer.sendSync('config-provider', {
        command: 'set-config-single', payload: { key, val: setting }
      })
      const saved: ConfigOptions = ipcRenderer.sendSync('config-provider', { command: 'get-config' })
      config.value = retrieveConfig()
      // A legacy undefined reply is successful only when the authoritative
      // read contains the value and every unrelated display setting survives.
      return (result === true || result === undefined) && saved.display[settingName] === value &&
        _.isEqual(_.omit(saved.display, settingName), _.omit(current.display, settingName))
    } catch (error) {
      console.error(`Could not save configuration setting ${property}`, error)
      return false
    }
  }

  function setCharacterPairs (property: string, value: unknown): boolean {
    const parts = property.split('.')
    const dictionaryUpdate = parts.length === 2
    if (dictionaryUpdate) {
      if (!isCharacterPairSettingsUpdate(value)) {return false}
    } else if (parts.length !== 3 || !Object.prototype.hasOwnProperty.call(characterPairLabels, parts[2]) || typeof value !== 'boolean') {
      return false
    }
    try {
      const current: ConfigOptions = ipcRenderer.sendSync('config-provider', { command: 'get-config' })
      const settings = normalizeCharacterPairSettings(current.editor.autoCloseCharacterPairs, current.editor.autoCloseBrackets)
      if (dictionaryUpdate) {
        Object.assign(settings, value)
      } else {
        settings[parts[2] as CharacterPair] = value as boolean
      }
      // A renderer hot reload can introduce this setting before the running
      // main process knows its dotted key. Preserve its real parent object.
      const missing = current.editor.autoCloseCharacterPairs === undefined
      const key = missing ? 'editor' : 'editor.autoCloseCharacterPairs'
      const setting = missing ? { ...current.editor, autoCloseCharacterPairs: settings } : settings
      const result = ipcRenderer.sendSync('config-provider', {
        command: 'set-config-single', payload: { key, val: setting }
      })
      const saved: ConfigOptions = ipcRenderer.sendSync('config-provider', { command: 'get-config' })
      config.value = retrieveConfig()
      // Do not mistake normalized renderer defaults for a successful save.
      // The main process must contain the complete requested dictionary and
      // retain every unrelated editor preference.
      return (result === true || result === undefined) &&
        _.isEqual(saved.editor.autoCloseCharacterPairs, settings) &&
        _.isEqual(_.omit(saved.editor, 'autoCloseCharacterPairs'), _.omit(current.editor, 'autoCloseCharacterPairs'))
    } catch (error) {
      console.error(`Could not save configuration setting ${property}`, error)
      return false
    }
  }

  function setCopyVisibleTextCategories (property: string, value: unknown): boolean {
    const parts = property.split('.')
    const dictionaryUpdate = parts.length === 2
    if (dictionaryUpdate) {
      if (value === null || typeof value !== 'object' || Array.isArray(value) ||
        Object.entries(value).some(([ category, enabled ]) => !Object.prototype.hasOwnProperty.call(defaultCopyVisibleTextCategories, category) || typeof enabled !== 'boolean')) {return false}
    } else if (parts.length !== 3 || !Object.prototype.hasOwnProperty.call(defaultCopyVisibleTextCategories, parts[2]) || typeof value !== 'boolean') {
      return false
    }
    try {
      const current: ConfigOptions = ipcRenderer.sendSync('config-provider', { command: 'get-config' })
      const categories = normalizeCopyVisibleTextCategories(current.display.copyVisibleTextCategories)
      if (dictionaryUpdate) {
        Object.assign(categories, value)
      } else {
        categories[parts[2] as CopyVisibleTextCategory] = value as boolean
      }
      // Older main processes cannot set the new dotted key. Updating the
      // existing display object preserves the new value across hot reloads.
      const missing = current.display.copyVisibleTextCategories === undefined
      const key = missing ? 'display' : 'display.copyVisibleTextCategories'
      const setting = missing ? { ...current.display, copyVisibleTextCategories: categories } : categories
      const result = ipcRenderer.sendSync('config-provider', { command: 'set-config-single', payload: { key, val: setting } })
      const saved: ConfigOptions = ipcRenderer.sendSync('config-provider', { command: 'get-config' })
      config.value = retrieveConfig()
      return result !== false && saved.display.copyVisibleTextCategories !== undefined &&
        _.isEqual(normalizeCopyVisibleTextCategories(saved.display.copyVisibleTextCategories), categories)
    } catch (error) {
      console.error(`Could not save configuration setting ${property}`, error)
      return false
    }
  }

  return { config, setConfigValue }
})
