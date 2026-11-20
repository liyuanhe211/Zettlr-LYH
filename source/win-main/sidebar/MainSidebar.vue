<template>
  <div id="sidebar">
    <SidebarSegmentBar
      v-bind:segments="tabs"
      v-bind:current-id="currentTab"
      v-on:select="setCurrentTab($event)"
    ></SidebarSegmentBar>

    <!-- Now the tab containers -->
    <div id="sidebar-tab-container">
      <ToCTab
        v-show="currentTab === 'toc'"
        v-on:move-section="emit('move-section', $event)"
        v-on:jump-to-line="emit('jump-to-line', $event)"
      ></ToCTab>
      <ReferencesTab v-show="currentTab === 'references'"></ReferencesTab>
      <RelatedFilesTab v-show="currentTab === 'relatedFiles'"></RelatedFilesTab>
      <OtherFilesTab v-show="currentTab === 'attachments'"></OtherFilesTab>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Sidebar
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This component renders the sidebar.
 *
 * END HEADER
 */

import { trans } from '@common/i18n-renderer'
import SidebarSegmentBar, { type SidebarSegment } from './SidebarSegmentBar.vue'
import { computed } from 'vue'
import ToCTab from './ToCTab.vue'
import ReferencesTab from './ReferencesTab.vue'
import RelatedFilesTab from './RelatedFilesTab.vue'
import OtherFilesTab from './OtherFilesTab.vue'
import { useConfigStore } from 'source/pinia'

const configStore = useConfigStore()

const emit = defineEmits<{
  (e: 'move-section', data: { from: number, to: number }): void
  (e: 'jump-to-line', line: number): void
}>()

const currentTab = computed(() => configStore.config.window.currentSidebarTab)

// R111: text buttons of a segmented control instead of icons
const tabs: SidebarSegment[] = [
  {
    id: 'toc',
    target: 'sidebar-toc',
    label: trans('Outline')
  },
  {
    id: 'references',
    target: 'sidebar-bibliography',
    label: trans('References')
  },
  {
    id: 'relatedFiles',
    target: 'sidebar-related-files',
    label: trans('Related')
  },
  {
    id: 'attachments',
    target: 'sidebar-files',
    label: trans('Attachments')
  }
]

function setCurrentTab (which: string): void {
  configStore.setConfigValue('window.currentSidebarTab', which)
}
</script>

<style lang="less">
body {
  @button-margin: 5px;
  @border-radius: 5px;
  @button-size: 5px;
  @button-icon-size: 5px;

  // R111: the colours of the PyQt6 design language: a light grey frame, a white
  // content panel below a thin divider, no rounded corners or shadows
  #sidebar {
    background-color: #f5f6f8;
    color: #1f2227;
    font-family: system-ui, "Microsoft YaHei UI", sans-serif;
    height: 100%;
    width: 100%;
    overflow: hidden;
    display: flex;
    flex-direction: column;

    #sidebar-tab-container {
      flex: 1 1 auto;
      min-height: 0;
      padding: 10px;
      overflow-y: auto;
      background-color: #ffffff;
    }

    #open-dir-external {
      padding: @button-margin;
      border-radius: @border-radius;
      display: inline-block;
      width: @button-size;
      height: @button-size;

      clr-icon {
        width: @button-icon-size;
        height: @button-icon-size;
      }
    }

    h1 {
      font-size: 16px;
      margin: 10px 0;
    }

    // Table of Contents entries
    div.toc-entry-container {
      // Clever calculation based on the data-level property
      // margin-left: calc(attr(data-level) * 10px);
      display: flex;
      margin-bottom: 10px;

      // The list marker of the entry (R110): one character, centred in a
      // fixed width so that the texts of one level start in one column
      div.toc-level {
        flex-shrink: 0;
        width: 1em;
        padding: 0px 4px 0px 0px;
        text-align: center;
        font-weight: bold;
        color: var(--system-accent-color, --c-primary);
      }

      div.toc-entry {
        flex-grow: 3;
        cursor: pointer;
        &:hover { text-decoration: underline; }
      }

      div.toc-entry-active {
        font-weight: bold;
        color: var(--system-accent-color);
      }
    }

    div.related-files-container {
      div.related-file {
        // NOTE: The margin + height equal 42, which was the automatic height
        // before we fixed it here. We have to fix it because the Recycle
        // scroller requires completely fixed heights.
        margin-bottom: 10px;
        display: flex;
        align-items: center;
        padding: 5px 5px;
        height: 35px;
        overflow: hidden;

        &:hover { background-color: rgb(200, 200, 200); }

        span.filename {
          font-size: 11px;
          flex-grow: 8;
          // The next four properties together ensure that we show at most two
          // lines with a nice ellipsis (…) to indicate cut-off lines.
          overflow: hidden;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
        }

        span.icons {
          display: inline-block;
          border-radius: 4px;
          padding: 2px;
          flex-grow: 2;
          flex-shrink: 0;
          text-align: right;
        }
      }
    }
  }

  &.dark {
    #sidebar {
      background-color: rgba(30, 30, 30, 1);
      color: rgb(230, 230, 230);

      #sidebar-tab-container { background-color: rgba(30, 30, 30, 1); }

      div.related-files-container div.related-file:hover {
        background-color: rgb(80, 80, 80);
      }
    }
  }
}

body.darwin, body.linux {
  div#sidebar {
    background-color: transparent;

    div.related-files-container {
      div.related-file { border-radius: 4px; }
    }
  }

  &.dark {
    div#sidebar {
      background-color: transparent;
    }
  }
}
</style>
