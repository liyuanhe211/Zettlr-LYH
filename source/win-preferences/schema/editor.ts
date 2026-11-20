/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Editor Preferences Schema
 * CVM-Role:        Model
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Exports the editor tab schema.
 *
 * END HEADER
 */

import { trans } from '@common/i18n-renderer'
import { type PreferencesFieldset } from '../App.vue'
import { PreferencesGroups } from './_preferences-groups'
import type { ConfigOptions } from 'source/app/service-providers/config/get-config-template'
import { codeEditingCategoryLabels } from '@common/modules/markdown-editor/util/code-editing-policy'
import { copyVisibleTextCategoryLabels } from '@common/modules/markdown-editor/util/visible-copy-policy'
import { characterPairLabels, normalizeCharacterPairSettings } from '@common/modules/markdown-editor/util/character-pair-policy'
import { useConfigStore } from 'source/pinia/config'

export function getEditorFields (config: ConfigOptions): PreferencesFieldset[] {
  return [
    {
      title: trans('Input mode'),
      infoString: trans('The input mode determines how you interact with the editor. We recommend keeping this setting at "Normal". Only choose "Vim" or "Emacs" if you know what this implies.'),
      group: PreferencesGroups.Editor,
      titleField: {
        type: 'select',
        model: 'editor.inputMode',
        options: {
          default: 'Normal',
          emacs: 'Emacs',
          vim: 'Vim'
        }
      },
      help: undefined, // TODO
      fields: []
    },
    {
      title: trans('Writing direction'),
      infoString: trans('We are currently planning on re-introducing bidirectional writing support, which will then be configurable here.'),
      group: PreferencesGroups.Editor,
      help: undefined, // TODO
      fields: [
        // TODO: Add field for LTR/RTL
      ]
    },
    {
      title: trans('Markdown rendering'),
      infoString: trans('Check to enable live rendering of various Markdown elements to formatted appearance. This hides formatting characters (such as **text**) or renders images instead of their link.'),
      group: PreferencesGroups.Editor,
      help: undefined, // TODO
      fields: [
        { type: 'separator' },
        {
          type: 'radio',
          label: trans('Choose between preview mode ("WYSIWYG) or raw mode ("WYSIWYM").'),
          model: 'display.renderingMode',
          inline: true,
          options: {
            preview: trans('Preview mode'),
            raw: trans('Raw mode')
          }
        },
        { type: 'separator' },
        {
          type: 'form-text',
          display: 'plain',
          contents: trans('Enable the following renderers in preview mode:')
        },
        {
          type: 'style-group',
          style: 'columns',
          fields: [
            {
              type: 'checkbox',
              label: trans('Render citations'),
              model: 'display.renderCitations',
              disabled: config.display.renderingMode === 'raw'
            },
            {
              type: 'checkbox',
              label: trans('Render iframes'),
              model: 'display.renderIframes',
              disabled: config.display.renderingMode === 'raw'
            },
            {
              type: 'checkbox',
              label: trans('Render images'),
              model: 'display.renderImages',
              disabled: config.display.renderingMode === 'raw'
            },
            {
              type: 'checkbox',
              label: trans('Render links'),
              model: 'display.renderLinks',
              disabled: config.display.renderingMode === 'raw'
            },
            {
              type: 'checkbox',
              label: trans('Render formulae'),
              model: 'display.renderMath',
              disabled: config.display.renderingMode === 'raw'
            },
            {
              type: 'checkbox',
              label: trans('Render tasks'),
              model: 'display.renderTasks',
              disabled: config.display.renderingMode === 'raw'
            },
            {
              type: 'checkbox',
              label: trans('Hide heading characters'),
              model: 'display.renderHTags',
              disabled: config.display.renderingMode === 'raw'
            },
            {
              type: 'checkbox',
              label: trans('Render emphasis'),
              model: 'display.renderEmphasis',
              disabled: config.display.renderingMode === 'raw'
            },
            {
              type: 'checkbox',
              label: trans('Render pandoc divs and spans'),
              model: 'display.renderPandoc',
              disabled: config.display.renderingMode === 'raw'
            },
            {
              type: 'checkbox',
              label: trans('Render admonitions'),
              model: 'display.renderAdmonitions',
              disabled: config.display.renderingMode === 'raw'
            },
            {
              type: 'checkbox',
              label: trans('Render horizontal rules'),
              model: 'display.renderHorizontalRules',
              disabled: config.display.renderingMode === 'raw'
            }
          ]
        },
        { type: 'separator' },
        {
          type: 'checkbox',
          label: trans('Show Markdown syntax when the cursor is adjacent or inside an element'),
          info: trans('If disabled, the editor will not show the Markdown syntax if the cursor is adjacent to the element.'),
          model: 'display.previewModeShowSyntaxWhenCursorIsAdjacent'
        }
      ]
    },
    {
      title: 'Auto Show Code',
      infoString: 'Control whether clicking a rendered element reveals its Markdown source. Raw mode continues to show the entire source.',
      group: PreferencesGroups.Editor,
      fields: [
        {
          type: 'checkbox',
          label: 'Auto Show Code',
          info: 'Also controls the Auto Show Code button in the main toolbar.',
          model: 'display.editCodeWhenClicked'
        },
        { type: 'separator' },
        {
          type: 'form-text',
          display: 'plain',
          contents: 'When the Auto Show Code button is off, reveal source on cursor entry for the following types:'
        },
        {
          type: 'style-group',
          style: 'columns',
          fields: Object.entries(codeEditingCategoryLabels).map(([ category, label ]) => ({
            type: 'checkbox' as const,
            label,
            model: `display.codeEditingExceptions.${category}`
          }))
        }
      ]
    },
    {
      // Zettlr-LYH (R84, spec C10): revision mode
      title: 'Track changes',
      infoString: 'Record insertions and deletions as tracked changes with your author name, and choose whether they are shown.',
      group: PreferencesGroups.Editor,
      fields: [
        {
          type: 'checkbox',
          label: 'Track changes',
          info: 'Also controls the Track Changes button in the main toolbar.',
          model: 'editor.trackChanges'
        },
        {
          type: 'checkbox',
          label: 'Show revisions',
          info: 'When off, the editor shows the text as if all changes were accepted. Also controls the Show Revisions button in the main toolbar.',
          model: 'display.showRevisions'
        },
        {
          type: 'text',
          label: 'Revision author',
          placeholder: 'Your name',
          info: 'Recorded with every tracked change. If empty, the Track Changes button asks for it.',
          model: 'editor.revisionAuthor'
        }
      ]
    },
    {
      title: 'Copy rendered elements',
      infoString: 'When Markdown source is hidden, copy visible text from one enabled element or part of it. Selections extending outside that element keep the original Markdown. Cut and drag keep the original Markdown.',
      group: PreferencesGroups.Editor,
      fields: [
        {
          type: 'style-group',
          style: 'columns',
          fields: Object.entries(copyVisibleTextCategoryLabels).map(([ category, label ]) => ({
            type: 'checkbox' as const,
            label,
            model: `display.copyVisibleTextCategories.${category}`,
            info: category === 'math' ? 'Copy the LaTeX expression without its $ or $$ delimiters.'
              : category === 'images' ? 'Copy image data when only one rendered image is selected.'
                : category === 'codeBlocks' ? 'Copy selected code without fences or language information, including multiple lines within one code block.' : undefined
          }))
        }
      ]
    },
    {
      title: trans('Default Formatting Characters'),
      infoString: trans('Select the characters Zettlr should use when marking text as bold or italic.'),
      group: PreferencesGroups.Editor,
      fields: [
        {
          type: 'style-group',
          style: 'columns',
          fields: [
            {
              type: 'radio',
              model: 'editor.boldFormatting',
              options: {
                '**': '**' + trans('Bold') + '**',
                __: '__' + trans('Bold') + '__'
              }
            },
            {
              type: 'radio',
              model: 'editor.italicFormatting',
              options: {
                '*': '*' + trans('Italics') + '*',
                _: '_' + trans('Italics') + '_'
              }
            },
            {
              type: 'radio',
              model: 'editor.highlightFormatting',
              options: {
                'span': '[' + trans('Highlight') + ']{.mark}',
                '==': '==' + trans('Highlight') + '=='
              }
            }
          ]
        },
      ]
    },
    {
      title: trans('Markdown Style'),
      infoString: trans('Check your Markdown documents for style issues'),
      group: PreferencesGroups.Editor,
      fields: [
        {
          type: 'checkbox',
          label: trans('Enable Markdown Linter'),
          model: 'editor.lint.markdown'
        }
      ]
    },
    {
      title: trans('Table Editor'),
      group: PreferencesGroups.Editor,
      titleField: {
        type: 'switch',
        model: 'editor.enableTableHelper'
      },
      help: undefined, // TODO
      fields: [
        // { type: 'separator' },
        {
          type: 'form-text',
          display: 'info',
          contents: trans('The Table Editor is an interactive interface that simplifies creation and editing of tables. It provides buttons for common functionality, and takes care of Markdown formatting.')
        }
      ]
    },
    {
      title: trans('Status bar'),
      infoString: trans('The status bar is a section for various quick controls and shows information about the current document. It is shown for both Markdown and code editors.'),
      group: PreferencesGroups.Editor,
      help: undefined, // TODO
      fields: [
        {
          type: 'checkbox',
          label: trans('Show status bar'),
          model: 'editor.showStatusbar'
        }
      ]
    },
    {
      title: trans('Distraction-free mode'),
      infoString: trans('Customize the appearance of the editor when the distraction-free mode is active.'),
      group: PreferencesGroups.Editor,
      help: undefined, // TODO
      fields: [
        {
          type: 'checkbox',
          label: trans('Mute non-focused lines in distraction-free mode'),
          model: 'muteLines'
        },
        {
          type: 'checkbox',
          label: trans('Hide toolbar in distraction-free mode'),
          model: 'display.hideToolbarInDistractionFree'
        }
      ]
    },
    {
      title: trans('Word counter'),
      group: PreferencesGroups.Editor,
      help: undefined, // TODO
      fields: [
        {
          type: 'checkbox',
          label: trans('Show character count instead of word count'),
          model: 'editor.countChars'
        }
      ]
    },
    {
      title: trans('Readability mode'),
      infoString: trans('Choose the algorithm to calculate readability scores.'),
      group: PreferencesGroups.Editor,
      help: undefined, // TODO
      fields: [
        {
          type: 'select',
          inline: true,
          label: trans('Readability Algorithm:'),
          model: 'editor.readabilityAlgorithm',
          options: {
            'dale-chall': 'Dale-Chall',
            'gunning-fog': 'Gunning-Fog',
            'coleman-liau': 'Coleman/Liau',
            'automated-readability': 'Automated Readability Index (ARI)'
          }
        }
      ]
    },
    // Zettlr-LYH: the "Image size" group (display.imageWidth and
    // display.imageHeight) was removed. The editor never used these settings,
    // and Export to HTML now sizes images by the editor's rules as well.
    {
      // Zettlr-LYH (R64): indentation and background of rendered blockquotes
      title: trans('Blockquotes'),
      infoString: trans('Indent rendered blockquotes on both sides and choose their background color. While the cursor is inside a blockquote, it shows neither.'),
      group: PreferencesGroups.Editor,
      help: undefined, // TODO
      fields: [
        {
          type: 'number',
          label: trans('Indentation on each side (in em):'),
          inline: true,
          min: 0,
          max: 10,
          reset: 2,
          model: 'display.blockquoteIndent'
        },
        {
          type: 'control-grid',
          header: [ '', trans('Background color'), '' ],
          rows: [
            [
              { type: 'form-text', display: 'plain', contents: trans('Light mode') },
              { type: 'color', model: 'display.blockquoteBackgroundLight' },
              { type: 'checkbox', label: trans('Transparent'), model: 'display.blockquoteBackgroundLightTransparent' }
            ],
            [
              { type: 'form-text', display: 'plain', contents: trans('Dark mode') },
              { type: 'color', model: 'display.blockquoteBackgroundDark' },
              { type: 'checkbox', label: trans('Transparent'), model: 'display.blockquoteBackgroundDarkTransparent' }
            ]
          ]
        }
      ]
    },
    {
      // Zettlr-LYH: size and weight of the six heading levels
      title: trans('Headings'),
      infoString: trans('Size of each heading level relative to the body text, and whether it is bold.'),
      group: PreferencesGroups.Editor,
      help: undefined, // TODO
      fields: [
        {
          type: 'control-grid',
          header: [ '', trans('Size (relative to body text)'), '' ],
          rows: [
            [
              { type: 'form-text', display: 'plain', contents: trans('Level %s', 1) },
              { type: 'number', min: 0.5, max: 5, step: 0.1, reset: 2, model: 'display.headingSize1' },
              { type: 'checkbox', label: trans('Bold'), model: 'display.headingBold1' }
            ],
            [
              { type: 'form-text', display: 'plain', contents: trans('Level %s', 2) },
              { type: 'number', min: 0.5, max: 5, step: 0.1, reset: 1.8, model: 'display.headingSize2' },
              { type: 'checkbox', label: trans('Bold'), model: 'display.headingBold2' }
            ],
            [
              { type: 'form-text', display: 'plain', contents: trans('Level %s', 3) },
              { type: 'number', min: 0.5, max: 5, step: 0.1, reset: 1.5, model: 'display.headingSize3' },
              { type: 'checkbox', label: trans('Bold'), model: 'display.headingBold3' }
            ],
            [
              { type: 'form-text', display: 'plain', contents: trans('Level %s', 4) },
              { type: 'number', min: 0.5, max: 5, step: 0.1, reset: 1.3, model: 'display.headingSize4' },
              { type: 'checkbox', label: trans('Bold'), model: 'display.headingBold4' }
            ],
            [
              { type: 'form-text', display: 'plain', contents: trans('Level %s', 5) },
              { type: 'number', min: 0.5, max: 5, step: 0.1, reset: 1, model: 'display.headingSize5' },
              { type: 'checkbox', label: trans('Bold'), model: 'display.headingBold5' }
            ],
            [
              { type: 'form-text', display: 'plain', contents: trans('Level %s', 6) },
              { type: 'number', min: 0.5, max: 5, step: 0.1, reset: 1, model: 'display.headingSize6' },
              { type: 'checkbox', label: trans('Bold'), model: 'display.headingBold6' }
            ]
          ]
        }
      ]
    },
    {
      title: trans('Font size'),
      group: PreferencesGroups.Editor,
      help: undefined, // TODO
      fields: [
        {
          type: 'number',
          label: trans('Font size in pixels:'),
          inline: true,
          model: 'editor.fontSize'
        },
        {
          type: 'number',
          label: 'Line number font size in pixels (0 = editor size minus 4):',
          inline: true,
          min: 0,
          max: 96,
          reset: 0,
          model: 'editor.lineNumberFontSize'
        }
      ]
    },
    {
      title: trans('Indentation'),
      group: PreferencesGroups.Editor,
      help: undefined, // TODO
      infoString: trans('Adjust your editor indentation settings'),
      fields: [
        {
          type: 'number',
          label: trans('Tab size (in number of spaces)'),
          inline: true,
          min: 2, max: 10,
          model: 'editor.indentUnit'
        },
        {
          type: 'checkbox',
          label: trans('Indent using tabs instead of spaces'),
          model: 'editor.indentWithTabs'
        },
        {
          type: 'checkbox',
          label: trans('Always indent the current line when pressing Tab'),
          info: trans('Zettlr always indents the line for list items. Turn this setting on to always indent any line.'),
          model: 'editor.alwaysIndentLineOnTab'
        }
      ]
    },
    {
      title: trans('Snippet Autocompletion'),
      group: PreferencesGroups.Editor,
      help: undefined, // TODO
      infoString: trans('Control the snippet autocompletion functionality'),
      fields: [
        {
          type: 'select',
          inline: true,
          label: trans('Autocomplete trigger character:'),
          model: 'editor.snippetAutocompleteTriggerCharacter',
          options: {
            ':': ':',
            '/': '/',
            '%': '%',
          }
        },
        {
          type: 'checkbox',
          label: trans('Suggest emojis during autocompletion'),
          model: 'editor.autocompleteSuggestEmojis'
        }
      ]
    },
    {
      title: trans('Other settings'),
      group: PreferencesGroups.Editor,
      help: undefined, // TODO
      fields: [
        {
          type: 'checkbox',
          label: trans('Show formatting toolbar below the toolbar'),
          model: 'editor.showFormattingToolbar'
        },
        {
          type: 'checkbox',
          label: trans('Show line numbers for Markdown files'),
          model: 'editor.showMarkdownLineNumbers'
        },
        {
          type: 'checkbox',
          label: trans('Highlight whitespace'),
          model: 'editor.showWhitespace'
        },
        {
          type: 'checkbox',
          label: trans('Show link previews'),
          model: 'editor.showLinkPreviews'
        },
        {
          type: 'checkbox',
          label: trans('Accept autocomplete suggestion with Enter'),
          model: 'editor.autocompleteWithEnter'
        },
        {
          type: 'checkbox',
          label: trans('Accept autocomplete suggestion with Tab'),
          model: 'editor.autocompleteWithTab'
        }
      ]
    },
    {
      title: 'Automatically close matching character pairs',
      infoString: 'Only pairs supported by the current language are closed. Quote options include triple quotes where supported. Code fences completes a closing fence (``` or ~~~) when Enter is pressed after three or more backticks or tildes. Smart quote replacement and wrapping use their existing settings and rules.',
      group: PreferencesGroups.Editor,
      fields: [
        {
          type: 'style-group',
          style: 'columns',
          fields: Object.entries(characterPairLabels).map(([ pair, label ]) => ({
            type: 'checkbox' as const,
            label,
            model: `editor.autoCloseCharacterPairs.${pair}`
          }))
        },
        {
          type: 'button',
          label: 'Select all',
          onClick: () => {
            useConfigStore().setConfigValue('editor.autoCloseCharacterPairs', normalizeCharacterPairSettings(undefined))
          }
        },
        {
          type: 'button',
          label: 'Deselect all',
          onClick: () => {
            useConfigStore().setConfigValue('editor.autoCloseCharacterPairs', normalizeCharacterPairSettings(undefined, false))
          }
        }
      ]
    }
  ]
}
