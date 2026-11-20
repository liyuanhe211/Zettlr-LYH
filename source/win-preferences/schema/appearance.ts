/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Appearance Preferences Schema
 * CVM-Role:        Model
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Exports the appearance tab schema.
 *
 * END HEADER
 */

import { trans } from '@common/i18n-renderer'
import { type PreferencesFieldset } from '../App.vue'
import { PreferencesGroups } from './_preferences-groups'
import { ProgrammaticallyOpenableWindows } from '@providers/commands/open-aux-window'
import type { ConfigOptions } from 'source/app/service-providers/config/get-config-template'

const ipcRenderer = window.ipc

export function getAppearanceFields (config: ConfigOptions): PreferencesFieldset[] {
  return [
    {
      title: trans('Dark mode'),
      group: PreferencesGroups.Appearance,
      titleField: {
        type: 'switch',
        model: 'darkMode'
      },
      help: undefined, // TODO,
      fields: [
        { type: 'separator' },
        {
          type: 'radio',
          label: trans('Schedule dark mode automatically'),
          model: 'autoDarkMode',
          inline: true,
          options: {
            off: trans('Do not automatically switch'),
            system: trans('Follow operating system'),
            schedule: trans('Follow custom schedule')
          }
        },
        {
          type: 'style-group',
          style: 'columns',
          fields: [
            {
              type: 'time',
              label: trans('Start dark mode at'),
              model: 'autoDarkModeStart',
              inline: true,
              disabled: config.autoDarkMode !== 'schedule'
            },
            {
              type: 'time',
              label: trans('End dark mode at'),
              model: 'autoDarkModeEnd',
              inline: true,
              disabled: config.autoDarkMode !== 'schedule'
            }
          ]
        }
      ]
    },
    {
      title: trans('Editor Theme'),
      infoString: trans('Select a color and font theme for the editor.'),
      group: PreferencesGroups.Appearance,
      titleField: {
        type: 'select',
        model: 'darkModeEditor',
        inline: true,
        options: {
          match: trans('Follow App'),
          light: trans('Light Theme'),
          dark: trans('Dark Theme')
        }
      },
      help: undefined, // TODO
      fields: [
        { type: 'separator' },
        {
          type: 'theme',
          model: 'display.theme',
          options: {
            berlin: {
              textColor: 'white',
              backgroundColor: '#1cb27e',
              name: 'Berlin',
              fontFamily: 'inherit',
              description: 'An all-time classic: This theme has been part of Zettlr since the very beginning. A modern theme featuring the signatory green color and a sans-serif font.'
            },
            frankfurt: {
              textColor: 'white',
              backgroundColor: '#1d75b3',
              name: 'Frankfurt',
              fontFamily: 'Crimson',
              description: 'In line with the spirit of the time-honoured Frankfurt School, this theme features a mature serif font paired with royal blue.'
            },
            bielefeld: {
              textColor: 'black',
              backgroundColor: '#ffffdc',
              name: 'Bielefeld',
              fontFamily: 'Liberation Mono',
              description: 'With its mellow orange and a monospaced font, this theme gets you as reminiscent of Niklas Luhmann\'s heyday as possible.'
            },
            'karl-marx-stadt': {
              textColor: 'white',
              backgroundColor: '#dc2d2d',
              name: 'Karl-Marx-Stadt',
              fontFamily: 'inherit',
              description: 'City names change, but their spirit remains: A forceful red complements this theme\'s progressive appeal and sans-serif font.'
            },
            bordeaux: {
              textColor: '#dc2d2d',
              backgroundColor: '#fffff8',
              name: 'Bordeaux',
              fontFamily: 'Inconsolata',
              description: 'Design made in France: Enjoy writing with this theme\'s unagitated colors and beautiful monospaced font.'
            }
          }
        }
      ]
    },
    {
      title: trans('Toolbar buttons'),
      infoString: trans('Select which buttons should be shown on the toolbar. Some buttons cannot be hidden.'),
      group: PreferencesGroups.Appearance,
      help: undefined, // TODO
      fields: [
        { type: 'separator' },
        {
          type: 'form-text',
          display: 'sub-heading',
          contents: trans('Show buttons')
        },
        {
          type: 'style-group',
          style: 'columns',
          label: trans('Left section'),
          fields: [
            {
              type: 'checkbox',
              label: trans('Open settings'),
              model: 'displayToolbarButtons.showOpenPreferencesButton'
            },
            {
              type: 'checkbox',
              label: trans('New file'),
              model: 'displayToolbarButtons.showNewFileButton'
            },
            {
              type: 'checkbox',
              label: trans('Previous file'),
              model: 'displayToolbarButtons.showPreviousFileButton'
            },
            {
              type: 'checkbox',
              label: trans('Next file'),
              model: 'displayToolbarButtons.showNextFileButton'
            }
          ]
        },
        { type: 'separator' },
        {
          type: 'style-group',
          style: 'columns',
          label: trans('Center section'),
          fields: [
            {
              type: 'checkbox',
              label: trans('Insert comment'),
              model: 'displayToolbarButtons.showMarkdownCommentButton'
            },
            {
              type: 'checkbox',
              label: trans('Insert link'),
              model: 'displayToolbarButtons.showMarkdownLinkButton'
            },
            {
              type: 'checkbox',
              label: trans('Insert image'),
              model: 'displayToolbarButtons.showMarkdownImageButton'
            },
            {
              type: 'checkbox',
              label: trans('Insert task list'),
              model: 'displayToolbarButtons.showMarkdownMakeTaskListButton'
            },
            {
              type: 'checkbox',
              label: trans('Insert table'),
              model: 'displayToolbarButtons.showInsertTableButton'
            },
            {
              type: 'checkbox',
              label: trans('Insert footnote'),
              model: 'displayToolbarButtons.showInsertFootnoteButton'
            }
          ]
        },
        { type: 'separator' },
        {
          type: 'style-group',
          style: 'columns',
          label: trans('Right section'),
          fields: [
            {
              type: 'checkbox',
              label: trans('Word/character counter'),
              model: 'displayToolbarButtons.showDocumentInfoText'
            },
            {
              type: 'checkbox',
              label: trans('Pomodoro timer'),
              model: 'displayToolbarButtons.showPomodoroButton'
            }
          ]
        }
      ]
    },
    {
      title: trans('Custom CSS'),
      group: PreferencesGroups.Appearance,
      fields: [
        {
          type: 'button',
          label: trans('Open CSS editor'),
          onClick: () => {
            ipcRenderer.invoke('application', {
              command: 'open-aux-window',
              payload: {
                window: ProgrammaticallyOpenableWindows.AssetsWindow,
                hash: 'tab-custom-css-control'
              }
            })
              .catch(err => console.error(err))
          }
        }
      ]
    }
  ]
}
