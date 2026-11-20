/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        General Preferences Schema
 * CVM-Role:        Model
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Exports the general tab schema.
 *
 * END HEADER
 */

import { trans } from '@common/i18n-renderer'
import { type PreferencesFieldset } from '../App.vue'
import { PreferencesGroups } from './_preferences-groups'

export function getGeneralFields (appLangOptions: Record<string, string>): PreferencesFieldset[] {
  const updateSetting: PreferencesFieldset = {
    title: trans('Updates'),
    infoString: trans('If you installed Zettlr via a package manager, you should disable this.'),
    group: PreferencesGroups.General,
    help: undefined, // TODO
    fields: [
      {
        type: 'checkbox',
        label: trans('Automatically check for updates'),
        model: 'system.checkForUpdates'
      }
    ]
  }

  const updatesDisabledSetting: PreferencesFieldset = {
    title: trans('Updates'),
    group: PreferencesGroups.General,
    // Zettlr-LYH requirement R95: updates from upstream Zettlr are off
    infoString: trans('Zettlr-LYH does not check for updates from the official Zettlr. An update source for Zettlr-LYH has not been set up yet.'),
    fields: []
  }

  return [
    {
      title: trans('Application language'),
      group: PreferencesGroups.General,
      titleField: {
        type: 'select',
        model: 'appLang',
        options: appLangOptions
      },
      help: undefined, // TODO
      fields: []
    },
    {
      title: trans('Autosave'),
      infoString: trans('Should Zettlr automatically save changes to your documents?'),
      group: PreferencesGroups.General,
      help: undefined, // TODO
      fields: [
        {
          // TODO: Move off to switch in title
          type: 'radio',
          model: 'editor.autoSave',
          inline: true,
          options: {
            off: trans('Never'),
            immediately: trans('Immediately'),
            delayed: trans('After a short delay')
          }
        }
      ]
    },
    {
      title: trans('Default image folder'),
      infoString: trans('Automatically suggests this folder to save images to, and searches this folder to propose "other files".'),
      group: PreferencesGroups.General,
      help: undefined, // TODO
      fields: [
        {
          type: 'directory',
          reset: true,
          model: 'editor.defaultSaveImagePath'
        },
        {
          type: 'form-text',
          display: 'info',
          contents: trans('Click "Select folder…" or type an absolute or relative path directly into the input field.')
        }
      ]
    },
    {
      title: trans('Unsaved notes'),
      infoString: trans('Ctrl+N creates a new note in this folder and saves it there automatically. You choose its final name and location when you save it. Closed notes you did not save are moved to the "__Unsaved" folder inside the undo history folder. If left empty, the folder "Zettlr\\__Unsaved" inside your documents folder is used.'),
      group: PreferencesGroups.General,
      help: undefined, // TODO
      fields: [
        {
          type: 'directory',
          label: trans('Folder for unsaved notes created with Ctrl+N'),
          model: 'scratchNotesDirectory',
          placeholder: trans('Path to folder'),
          reset: ''
        }
      ]
    },
    {
      // Zettlr-LYH (R135): where the undo history is saved on disk
      title: trans('Undo history'),
      infoString: trans('Every undo step is saved in this folder, so you can still undo after switching tabs, closing a file, or restarting Zettlr. Steps older than 30 days are removed; closed unsaved notes are kept. If left empty, the folder "Zettlr\\__History" inside your documents folder is used.'),
      group: PreferencesGroups.General,
      help: undefined,
      fields: [
        {
          type: 'directory',
          label: trans('Undo history folder'),
          model: 'undoHistoryDirectory',
          placeholder: trans('Path to folder'),
          reset: ''
        }
      ]
    },
    {
      title: trans('Behavior'),
      group: PreferencesGroups.General,
      help: undefined, // TODO
      fields: [
        {
          type: 'checkbox',
          label: trans('Avoid opening files in new tabs if possible'),
          model: 'system.avoidNewTabs'
        },
        {
          type: 'number',
          label: trans('Maximum open saved tabs per window (0 = unlimited)'),
          model: 'system.maxOpenTabs',
          min: 0,
          max: Number.MAX_SAFE_INTEGER
        },
        {
          type: 'form-text',
          display: 'info',
          contents: trans('Pinned tabs, unsaved notes, and documents with unsaved changes are excluded. When the limit is exceeded, the least recently focused eligible tab is closed.')
        }
      ]
    },
    ...(__UPDATES_DISABLED__ === '0' ? [updateSetting] : [updatesDisabledSetting])
  ]
}
