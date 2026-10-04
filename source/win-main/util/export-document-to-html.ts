/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        exportDocumentToHTML
 * CVM-Role:        Utility Function
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Assembles a standalone HTML document that shows a Markdown
 *                  file the way the main editor displays it (without any of
 *                  the application chrome) and hands it to the main process,
 *                  which embeds local images and writes <name>.html next to
 *                  the source file. Everything that needs the renderer lives
 *                  here: the Markdown-to-HTML conversion with citations,
 *                  Mermaid charts rendered to SVG, the KaTeX stylesheet with
 *                  its fonts embedded, and the colors and fonts of the editor
 *                  theme that is currently active.
 *
 * END HEADER
 */

import DOMPurify from 'dompurify'
import mermaid from 'mermaid'
import { md2html } from '@common/modules/markdown-utils'
import {
  applyCodeHighlighting,
  buildStandaloneHTMLDocument,
  convertSoftLineBreaks,
  enableTaskCheckboxes,
  highlightFencedCodeBlocks,
  markBracketLinkMarks,
  markImageOnlyParagraphs,
  type EditorThemeVariables
} from '@common/modules/markdown-utils/standalone-html-export'
import { defaultVarsDark, defaultVarsLight } from '@common/modules/markdown-editor/theme/editor'
import { pathBasename, pathDirname, pathExtname, resolvePath } from '@common/util/renderer-path-polyfill'
import extractYamlFrontmatter from '@common/util/extract-yaml-frontmatter'
import { CITEPROC_MAIN_DB } from '@dts/common/citeproc'
import { trans } from '@common/i18n-renderer'
import type { WindowControlsIPCAPI } from 'source/app/service-providers/windows'

const ipcRenderer = window.ipc

// DOMPurify's default URI pattern, extended by file: so that images with an
// absolute local path survive sanitizing until the main process embeds them.
const ALLOWED_URI_REGEXP = /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix|file):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i

/**
 * Turns an image link from the Markdown source into a file URL for local
 * images; remote and embedded images are returned unchanged.
 */
function localImageSourceToFileURL (source: string, documentDirectory: string): string {
  if (/^(?:https?|data|blob):/i.test(source)) {
    return source
  }

  let decoded = source
  try {
    decoded = decodeURI(source)
  } catch {
    // Keep the raw link if it is not valid percent-encoding
  }

  const absolute = resolvePath(documentDirectory, decoded).replace(/\\/g, '/')
  return 'file:///' + encodeURI(absolute.replace(/^\/+/, '')).replace(/#/g, '%23').replace(/\?/g, '%3F')
}

/**
 * Reads the --zettlr-editor-* variables from a mounted editor, so that the
 * export uses the theme, font, and dark or light mode the user currently sees.
 */
function readEditorThemeVariables (): { variables: EditorThemeVariables, darkMode: boolean } {
  const darkMode = window.config.get('darkMode') === true
  const defaults = darkMode ? defaultVarsDark : defaultVarsLight
  const variables: EditorThemeVariables = {}
  const editorElement = document.querySelector('.main-editor-wrapper .cm-editor') ?? document.querySelector('.cm-editor')
  const computed = editorElement !== null ? getComputedStyle(editorElement) : undefined

  for (const [ name, fallback ] of Object.entries(defaults)) {
    const value = computed?.getPropertyValue(name).trim() ?? ''
    variables[name] = value !== '' ? value : String(fallback)
  }

  // The body text color and the background of the scroller are resolved
  // separately, since they may be set by the theme without a variable.
  const scroller = editorElement?.querySelector('.cm-scroller')
  if (scroller != null) {
    const scrollerStyle = getComputedStyle(scroller)
    variables['--export-text-color'] = scrollerStyle.color
    variables['--export-background-color'] = scrollerStyle.backgroundColor
    variables['--export-font-size'] = scrollerStyle.fontSize
  }

  return { variables, darkMode }
}

/**
 * Reads a font file and returns it as a data URI.
 */
async function fetchAsDataURI (url: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`)
  }
  const blob = await response.blob()
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
      } else {
        reject(new Error(`Cannot read ${url} as a data URI`))
      }
    }
    reader.onerror = () => { reject(reader.error ?? new Error(`Cannot read ${url}`)) }
    reader.readAsDataURL(blob)
  })
}

/**
 * Collects the KaTeX rules from the stylesheets loaded into this window and
 * embeds the WOFF2 fonts they reference, so that formulas render with the same
 * fonts as in the editor without any external file.
 */
async function collectKatexStylesheet (): Promise<string> {
  const rules: string[] = []

  for (const sheet of Array.from(document.styleSheets)) {
    let cssRules: CSSRuleList
    try {
      cssRules = sheet.cssRules
    } catch {
      continue // Stylesheets from other origins cannot be read
    }

    const baseURL = sheet.href ?? document.baseURI
    for (const rule of Array.from(cssRules)) {
      if (rule instanceof CSSFontFaceRule) {
        const family = rule.style.getPropertyValue('font-family')
        if (!family.includes('KaTeX')) {
          continue
        }

        const source = rule.style.getPropertyValue('src')
        const woff2 = /url\(\s*["']?([^"')]+\.woff2[^"')]*)["']?\s*\)/i.exec(source)
        if (woff2 === null) {
          rules.push(rule.cssText)
          continue
        }

        try {
          const dataURI = await fetchAsDataURI(new URL(woff2[1], baseURL).href)
          const descriptors = [ 'font-family', 'font-style', 'font-weight', 'font-display' ]
            .map(name => [ name, rule.style.getPropertyValue(name) ])
            .filter(([ , value ]) => value !== '')
            .map(([ name, value ]) => `${name}: ${value};`)
          rules.push(`@font-face { ${descriptors.join(' ')} src: url("${dataURI}") format("woff2"); }`)
        } catch (err) {
          console.warn('[Export to HTML] Could not embed a KaTeX font', err)
          rules.push(rule.cssText)
        }
      } else if (rule.cssText.includes('.katex')) {
        rules.push(rule.cssText)
      }
    }
  }

  return rules.join('\n')
}

/**
 * Replaces the Mermaid code blocks in the parsed document by their rendered
 * SVG charts, just as the editor displays them.
 */
async function renderMermaidCharts (container: Document): Promise<void> {
  const codeElements = Array.from(container.querySelectorAll('pre > code'))
    .filter(code => code.classList.contains('language-mermaid') || /(?:^|\s)language-\{.*\.mermaid.*\}/i.test(code.className))

  let index = 0
  for (const code of codeElements) {
    const pre = code.parentElement!
    const chart = container.createElement('div')
    chart.classList.add('mermaid-chart')
    try {
      const result = await mermaid.render(`exportMermaidGraph${Date.now()}${index++}`, code.textContent ?? '')
      chart.innerHTML = DOMPurify.sanitize(result.svg, { USE_PROFILES: { svg: true, svgFilters: true } })
    } catch (err) {
      chart.classList.add('error')
      chart.textContent = `${trans('Could not render Graph:')}\n\n${err instanceof Error ? err.message : String(err)}`
    }
    pre.replaceWith(chart)
  }
}

/**
 * Exports the saved contents of the given Markdown file as a standalone HTML
 * document next to the file.
 *
 * @param   {string}  filePath  The absolute path of the Markdown file
 *
 * @return  {Promise}  The written HTML file and whether it was opened, or false
 */
export async function exportDocumentToHTML (filePath: string): Promise<{ path: string, opened: boolean }|false> {
  const contents: unknown = await ipcRenderer.invoke('application', {
    command: 'get-file-contents',
    payload: filePath
  })

  if (typeof contents !== 'string') {
    console.error(`[Export to HTML] Could not read ${filePath}`)
    return false
  }

  const documentDirectory = pathDirname(filePath)
  const { frontmatter } = extractYamlFrontmatter(contents)
  const library = frontmatter !== null && typeof frontmatter.bibliography === 'string'
    ? frontmatter.bibliography
    : CITEPROC_MAIN_DB
  const title = frontmatter !== null && typeof frontmatter.title === 'string' && frontmatter.title.trim() !== ''
    ? frontmatter.title.trim()
    : pathBasename(filePath, pathExtname(filePath))

  const zknLinkFormat: 'link|title'|'title|link' = window.config.get('zkn.linkFormat') ?? 'link|title'
  const rawHTML = await md2html(contents, {
    referenceSectionTitle: trans('References'),
    onCitation: window.getCitationCallback(library),
    onBibliography: async (citations) => {
      return await ipcRenderer.invoke('citeproc-provider', {
        command: 'get-bibliography',
        payload: { database: library, citations }
      })
    },
    zknLinkFormat,
    onImageSrc: (source) => localImageSourceToFileURL(source, documentDirectory),
    htmlBlockWrapperClass: 'html-block-preview'
  })

  const cleanHTML = DOMPurify.sanitize(rawHTML, { ALLOWED_URI_REGEXP })

  // DOMParser yields an inert document: nothing is loaded or executed here.
  const parsed = new DOMParser().parseFromString(`<body>${cleanHTML}</body>`, 'text/html')
  applyCodeHighlighting(parsed, highlightFencedCodeBlocks(contents, { zknLinkParserConfig: { format: zknLinkFormat } }))
  await renderMermaidCharts(parsed)
  convertSoftLineBreaks(parsed)
  markImageOnlyParagraphs(parsed)
  markBracketLinkMarks(parsed)
  enableTaskCheckboxes(parsed)
  const bodyHTML = parsed.body.innerHTML

  const { variables, darkMode } = readEditorThemeVariables()
  const extraStylesheets: string[] = []
  if (bodyHTML.includes('class="katex')) {
    extraStylesheets.push(await collectKatexStylesheet())
  }

  const html = buildStandaloneHTMLDocument({
    title,
    bodyHTML,
    themeVariables: variables,
    darkMode,
    imageMaxWidthPercent: Number(window.config.get('display.imageWidth') ?? 100),
    imageMaxHeightPercent: Number(window.config.get('display.imageHeight') ?? 50),
    extraStylesheets
  })

  const result: { path: string, opened: boolean }|false = await ipcRenderer.invoke('application', {
    command: 'export-html',
    payload: { path: filePath, html }
  })

  return result
}

/**
 * Exports the file to HTML and, unless the main process already opened the
 * result ("Open after export"), reveals it in the file browser. This is the
 * entry point for every Export to HTML action in the main window.
 *
 * @param   {string}  filePath  The absolute path of the Markdown file
 */
export async function exportToHTMLAndShow (filePath: string): Promise<void> {
  const result = await exportDocumentToHTML(filePath)
  if (result !== false && !result.opened) {
    ipcRenderer.send('window-controls', {
      command: 'show-item-in-folder',
      payload: { itemPath: result.path }
    } satisfies WindowControlsIPCAPI)
  }
}
