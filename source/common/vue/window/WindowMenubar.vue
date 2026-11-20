<template>
  <div id="menubar" ref="menubarElement">
    <img id="app-logo" src="../../img/image-preview.png" />
    <div
      v-for="(item, idx) in menu"
      v-bind:key="idx"
      class="top-level-item"
      v-on:mousedown.stop.prevent="getSubmenu(item.id!, $event.target as HTMLElement)"
      v-on:mouseenter.stop="maybeExchangeSubmenu(item.id!, $event.target as HTMLElement)"
    >
      <span>
        {{ item.label }}
      </span>
    </div>
    <!--
      Zettlr-LYH (R85): the title in the middle of the menu bar. It stays part
      of the draggable area, so that a double-click maximises or restores the
      window just like a double-click on the empty menu bar.
    -->
    <div
      v-if="centerTitleText !== ''"
      class="center-title"
      v-bind:style="{ left: `${centerTitleLeft}px`, width: `${centerTitleWidth}px` }"
    >{{ centerTitleText }}</div>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Menubar
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Displays a custom-styled menu bar on non-macOS platforms.
 *
 * END HEADER
 */

import showPopupMenu, { type AnyMenuItem, type SubmenuItem } from '@common/modules/window-register/application-menu-helper'
import { ref, onBeforeMount, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { windowTitleCandidates, chooseWindowTitle, centeredTitleBox } from '../../../win-main/util/window-title-path'

const props = defineProps<{
  // Zettlr-LYH (R85): the title shown in the middle of the menu bar. With
  // isPath, text is the full path of the active file and is shortened to the
  // file name with up to three parent directories; otherwise text is shown as
  // is (scratch notes show their tab name). An empty text shows nothing.
  centerTitle?: { text: string, isPath: boolean }
}>()

const ipcRenderer = window.ipc

// Zettlr-LYH (R85): the gap kept between the title and the last menu item, and
// between the title and the window controls
const CENTER_TITLE_MARGIN = 16
// Zettlr-LYH (R85): used only when neither the Window Controls Overlay API nor
// its geometry is available: the Windows caption buttons (minimise, maximise,
// close) are 46 pixels wide each, 138 pixels in total.
const FALLBACK_WINDOW_CONTROLS_WIDTH = 138

interface WindowControlsOverlayLike extends EventTarget {
  visible: boolean
  getTitlebarAreaRect: () => DOMRect
}

const menubarElement = ref<HTMLElement|null>(null)
const centerTitleText = ref<string>('')
const centerTitleLeft = ref<number>(0)
const centerTitleWidth = ref<number>(0)
let centerTitleMeasureContext: CanvasRenderingContext2D|null = null
let centerTitleResizeObserver: ResizeObserver|undefined

const menu = ref<SubmenuItem[]>([])
const currentSubmenu = ref<string|null>(null)
const menuCloseCallback = ref<null|(() => void)|null>(null)

// Can contain a target if a submenu is right now being requested
const targetElement = ref<HTMLElement|null>(null)

onBeforeMount(() => {
  // Listen to messages from the menu provider
  type MenuMessage = { command: 'application-menu', payload: SubmenuItem[] }
  type SubmenuMessage = { command: 'application-submenu', payload: { id: string, submenu: SubmenuItem[] } }

  ipcRenderer.on('menu-provider', (event, { command, payload }: MenuMessage|SubmenuMessage) => {
    if (command === 'application-menu') {
      menu.value = payload
    } else if (command === 'application-submenu') {
      showSubmenu(payload.submenu, payload.id)
    }
  })

  // Send an initial request
  ipcRenderer.send('menu-provider', { command: 'get-application-menu' })

  // Zettlr-LYH (R85): the menu items change the left boundary of the title
  watch(menu, () => { nextTick(updateCenterTitle).catch(err => console.error(err)) })

  // Also make sure to reset the internal state if necessary
  window.addEventListener('mousedown', (_event) => {
    // The closing will be handled automatically by the menu handler
    if (menuCloseCallback.value !== null) {
      menuCloseCallback.value = null
      currentSubmenu.value = null
    }
  })
})

// Zettlr-LYH (R85): choose the title again whenever it, the window width or
// the window controls change
watch(() => props.centerTitle, () => { nextTick(updateCenterTitle).catch(err => console.error(err)) }, { deep: true })

onMounted(() => {
  if (menubarElement.value !== null) {
    centerTitleResizeObserver = new ResizeObserver(() => { updateCenterTitle() })
    centerTitleResizeObserver.observe(menubarElement.value)
  }
  windowControlsOverlay()?.addEventListener('geometrychange', updateCenterTitle)
  updateCenterTitle()
})

onBeforeUnmount(() => {
  centerTitleResizeObserver?.disconnect()
  windowControlsOverlay()?.removeEventListener('geometrychange', updateCenterTitle)
})

/**
 * Zettlr-LYH (R85): the Window Controls Overlay API, if available.
 *
 * @return  {WindowControlsOverlayLike|undefined}  The overlay
 */
function windowControlsOverlay (): WindowControlsOverlayLike|undefined {
  return (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlayLike }).windowControlsOverlay
}

/**
 * Zettlr-LYH (R85): the left edge of the window controls (minimise, maximise,
 * close), in window coordinates. The title bar area reported by the Window
 * Controls Overlay API ends where the controls begin (the same values as the
 * CSS variables titlebar-area-x and titlebar-area-width). Without it, the
 * controls are assumed to take the rightmost 138 pixels of the window.
 *
 * @return  {number}  The left edge of the window controls
 */
function windowControlsLeftEdge (): number {
  const overlay = windowControlsOverlay()
  if (overlay?.visible === true) {
    const rect = overlay.getTitlebarAreaRect()
    if (rect.width > 0) {
      return rect.x + rect.width
    }
  }

  return window.innerWidth - FALLBACK_WINDOW_CONTROLS_WIDTH
}

/**
 * Zettlr-LYH (R85): the right edge of the last menu item (or of the logo when
 * the menu has not arrived yet), in window coordinates.
 *
 * @param   {HTMLElement}  menubar  The menu bar
 *
 * @return  {number}                The right edge
 */
function menuItemsRightEdge (menubar: HTMLElement): number {
  const items = menubar.querySelectorAll<HTMLElement>('div.top-level-item, img#app-logo')
  let right = 0
  for (const item of Array.from(items)) {
    right = Math.max(right, item.getBoundingClientRect().right)
  }
  return right
}

/**
 * Zettlr-LYH (R85): returns a function measuring the rendered width of a text
 * in the font of the menu bar, which the title inherits.
 *
 * @param   {HTMLElement}  menubar  The menu bar
 *
 * @return  {(text: string) => number}  The measuring function
 */
function createTitleMeasure (menubar: HTMLElement): (text: string) => number {
  if (centerTitleMeasureContext === null) {
    centerTitleMeasureContext = document.createElement('canvas').getContext('2d')
  }

  const context = centerTitleMeasureContext
  if (context === null) {
    // Without a canvas, estimate a generous average character width
    return (text: string) => Array.from(text).length * 8
  }

  const style = window.getComputedStyle(menubar)
  context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  return (text: string) => context.measureText(text).width
}

/**
 * Zettlr-LYH (R85): chooses the title candidate that fits between the menu
 * items and the window controls and positions the title element.
 */
function updateCenterTitle (): void {
  const menubar = menubarElement.value
  const source = props.centerTitle
  if (menubar === null || source === undefined || source.text === '') {
    centerTitleText.value = ''
    return
  }

  const candidates = source.isPath ? windowTitleCandidates(source.text) : [source.text]
  if (candidates.length === 0) {
    centerTitleText.value = ''
    return
  }

  const measure = createTitleMeasure(menubar)
  const box = centeredTitleBox(
    window.innerWidth,
    menuItemsRightEdge(menubar),
    windowControlsLeftEdge(),
    CENTER_TITLE_MARGIN,
    measure(candidates[candidates.length - 1])
  )

  // Two pixels of slack absorb the rounding between the canvas measurement and
  // the rendered text, so that the text never overflows its element and the
  // element always stays strictly inside the box.
  const availableWidth = Math.max(0, Math.floor(box.width) - 2)
  const chosen = chooseWindowTitle(candidates, measure, availableWidth)
  const textWidth = Math.ceil(measure(chosen.text)) + 1
  const menubarLeft = menubar.getBoundingClientRect().left

  centerTitleText.value = chosen.text
  centerTitleWidth.value = textWidth
  centerTitleLeft.value = box.left + (box.width - textWidth) / 2 - menubarLeft
}

function getSubmenu (menuID: string, target: HTMLElement): void {
  targetElement.value = target
  ipcRenderer.send('menu-provider', {
    command: 'get-application-submenu',
    payload: menuID
  })
}

function maybeExchangeSubmenu (menuID: string, targetElement: HTMLElement): void {
  if (currentSubmenu.value === null) {
    return
  }

  if (currentSubmenu.value !== menuID) {
    getSubmenu(menuID, targetElement)
  }
}

/**
 * Displays a submenu of a top-level menu item
 *
 * @param   {AnyMenuItem[]}  items     The items in serialized form
 * @param   {string}      attachTo  The MenuItem.id of the item to attach to
 */
function showSubmenu (items: AnyMenuItem[], attachTo: string): void {
  if (targetElement.value === null) {
    return console.error('Cannot show application menu: Target item has not been found.')
  }

  const rect = targetElement.value.getBoundingClientRect()
  if (rect === undefined) {
    return console.error('Cannot show application menu: Target has not been found!')
  }

  // Reset the application menu if shown
  if (menuCloseCallback.value !== null) {
    menuCloseCallback.value()
    menuCloseCallback.value = null
  }

  if (currentSubmenu.value === attachTo) {
    // Emulate a toggle by not showing the same submenu again
    currentSubmenu.value = null
    return
  }

  // Display a new menu
  const point = { x: rect.left, y: rect.top + rect.height }
  menuCloseCallback.value = showPopupMenu(point, items, (clickedID) => {
    // Trigger a click on the "real" menu item in the back
    ipcRenderer.send('menu-provider', {
      command: 'click-menu-item',
      payload: clickedID
    })

    // Reset the menu state, since the callback indicates the menu is now
    // closed.
    menuCloseCallback.value = null
    currentSubmenu.value = null
  })

  // Save the original ID for easy access
  currentSubmenu.value = attachTo
  targetElement.value = null // Reset
}
</script>

<style lang="css" scoped>
#menubar {
  height: env(titlebar-area-height, 30px);
  line-height: env(titlebar-area-height, 30px);
  width: 100%;
  background-color: var(--grey-0);
  color: var(--grey-6);
  /* Use the system font with a somewhat smaller font-size */
  font-family: inherit;
  font-size: 12px;
  display: flex;
  justify-content: left;
  align-items: center;
  gap: 6px;
  padding: 4px 0;

  /* If the menubar is shown, this indicates there's no title bar, hence we
  need the menubar to be draggable. */
  -webkit-app-region: drag;

  /* Zettlr-LYH (R85): anchor for the centred title */
  position: relative;

  div.center-title {
    position: absolute;
    top: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    white-space: nowrap;
    overflow: hidden;
    color: var(--grey-6);
    /* Stays draggable, so that double-clicks maximise or restore the window */
    -webkit-app-region: drag;
  }

  img#app-logo {
    height: 18px;
    margin-left: 8px;
    width: auto;
  }

  div.top-level-item {
    padding: 0 10px;
    height: 100%;
    display: flex;
    align-items: center;
    border-radius: 4px;
    /* Don't drag the top-level menubar items */
    -webkit-app-region: no-drag;

    &:hover {
      background-color: rgba(0, 0, 0, .2);
    }
  }
}

body.dark #menubar {
  background-color: var(--grey-6);
  color: var(--grey-0);
}

body.dark #menubar div.center-title {
  color: var(--grey-0);
}
</style>
