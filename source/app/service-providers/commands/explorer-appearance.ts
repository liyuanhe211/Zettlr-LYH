import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import path from 'node:path'

export interface ExplorerMetrics {
  iconSize: number
  rowHeight: number
  indent: number
  disclosureWidth: number
  iconTextGap: number
  fontFamily: string
  fontSize: number
}

export interface ExplorerAppearance {
  icons: Record<string, string | null>
  metrics: ExplorerMetrics
  source: 'windows' | 'fallback'
}

const maximumPaths = 256
const maximumPendingIcons = 2048
const maximumCachedIcons = 2048
const maximumConcurrentIcons = 8
const cacheLifetime = 60000
const failureLifetime = 5000
const maximumIconCharacters = 32 * 1024
const fallbackMetrics: ExplorerMetrics = {
  iconSize: 16, rowHeight: 24, indent: 18, disclosureWidth: 18,
  iconTextGap: 4, fontFamily: 'Segoe UI', fontSize: 12
}

// Static executable text only: no renderer values enter this program. The
// control remains hidden throughout its lifetime; no shell window is opened.
// Reference navigation rows are approximately 36 physical px. Assuming the
// screenshot used this machine's measured 144 DPI gives 24 logical px. This is
// a reference-layout minimum, not the default native TreeView's measured height.
// Native measurements still accommodate larger system fonts and icons.
const windowsMetricsProgram = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public static class ExplorerLayoutMeasurement {
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("user32.dll")] static extern int GetSystemMetricsForDpi(int index, uint dpi);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr first, IntPtr second);
  [DllImport("uxtheme.dll", CharSet=CharSet.Unicode)] static extern int SetWindowTheme(IntPtr window, string application, string identifiers);
  public static object Read() {
    IntPtr previousContext = SetThreadDpiAwarenessContext(new IntPtr(-2));
    if (previousContext == IntPtr.Zero) throw new InvalidOperationException("Cannot set measurement DPI awareness");
    try {
      Application.EnableVisualStyles();
      using (TreeView tree = new TreeView())
      using (ImageList images = new ImageList()) {
        tree.Font = SystemFonts.IconTitleFont;
        tree.ShowLines = false;
        tree.ShowRootLines = true;
        tree.ShowPlusMinus = true;
        tree.Size = new Size(640,480);
        IntPtr handle = tree.Handle;
        uint dpi = GetDpiForWindow(handle);
        if (dpi == 0) throw new InvalidOperationException("Cannot read measurement DPI");
        double scale = dpi / 96.0;
        int iconPixels = GetSystemMetricsForDpi(49, dpi);
        images.ImageSize = new Size(iconPixels, iconPixels);
        using (Bitmap placeholder = new Bitmap(iconPixels, iconPixels)) {
          images.Images.Add(placeholder);
          if (images.Handle == IntPtr.Zero) throw new InvalidOperationException("Cannot create measurement image list");
        }
        tree.ImageList = images;
        if (SetWindowTheme(handle, "Explorer", null) != 0) throw new InvalidOperationException("Cannot apply Explorer theme");
        TreeNode node = tree.Nodes.Add("Measurement");
        node.Nodes.Add("Child");
        node.Expand();
        int indentPixels = SendMessage(handle, 0x1106, IntPtr.Zero, IntPtr.Zero).ToInt32();
        int rowPixels = SendMessage(handle, 0x111C, IntPtr.Zero, IntPtr.Zero).ToInt32();
        int gapPixels = node.Bounds.Left - indentPixels - iconPixels;
        if (iconPixels <= 0 || indentPixels <= 0 || rowPixels <= 0 || gapPixels < 0) throw new InvalidOperationException("Invalid native Explorer measurements");
        return new {
          iconSize = iconPixels / scale,
          rowHeight = Math.Max(24.0, rowPixels / scale),
          indent = indentPixels / scale,
          disclosureWidth = indentPixels / scale,
          iconTextGap = gapPixels / scale,
          fontFamily = tree.Font.Name,
          fontSize = tree.Font.SizeInPoints * 96.0 / 72.0
        };
      }
    } finally { SetThreadDpiAwarenessContext(previousContext); }
  }
}
'@
  [Console]::Out.Write(([ExplorerLayoutMeasurement]::Read() | ConvertTo-Json -Compress))
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`

function validatePaths (payload: unknown, platform: string): string[] {
  const paths = (payload as { paths?: unknown } | null)?.paths
  if (!Array.isArray(paths) || paths.length > maximumPaths) {
    throw new TypeError('Explorer appearance requires at most 256 absolute paths')
  }
  let characters = 0
  for (const filePath of paths) {
    if (typeof filePath !== 'string' || filePath.includes('\0') || filePath.length > 32767) {
      throw new TypeError('Explorer paths must be strings without NUL characters, at most 32767 characters each')
    }
    const absolute = platform === 'win32'
      ? /^[a-z]:[\\/]/i.test(filePath) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(filePath)
      : path.posix.isAbsolute(filePath)
    characters += filePath.length
    if (!absolute || characters > 1000000) {
      throw new TypeError('Explorer paths must be absolute and within the total character limit')
    }
  }
  return paths.slice()
}

function validateMetrics (value: unknown): ExplorerMetrics {
  if (value === null || typeof value !== 'object') {
    throw new TypeError('Invalid Explorer metrics')
  }
  const metrics = value as ExplorerMetrics
  for (const key of [ 'iconSize', 'rowHeight', 'indent', 'disclosureWidth', 'iconTextGap', 'fontSize' ] as const) {
    const minimum = key === 'iconTextGap' ? 0 : 1
    if (!Number.isFinite(metrics[key]) || metrics[key] < minimum || metrics[key] > 256) {
      throw new TypeError('Invalid Explorer metric: ' + key)
    }
  }
  if (typeof metrics.fontFamily !== 'string' || metrics.fontFamily.length === 0 || metrics.fontFamily.length > 128 || /[\u0000-\u001f]/.test(metrics.fontFamily)) {
    throw new TypeError('Invalid Explorer font')
  }
  return { ...metrics }
}

/** Reads native metrics in physical pixels, normalizing to CSS logical pixels. */
export async function measureWindowsExplorerMetrics (): Promise<ExplorerMetrics> {
  const systemRoot = process.env.SystemRoot
  if (systemRoot === undefined || !path.win32.isAbsolute(systemRoot)) {
    throw new Error('Windows system directory is unavailable')
  }
  const executable = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const output = await new Promise<string>((resolve, reject) => {
    execFile(executable, [ '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand',
      Buffer.from(windowsMetricsProgram, 'utf16le').toString('base64') ], { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 32768 }, (error, stdout) => {
      if (error !== null) {
        reject(error)
      } else {
        resolve(stdout)
      }
    })
  })
  return validateMetrics(JSON.parse(output))
}

interface AppearanceDependencies {
  loadIcon: (filePath: string) => Promise<string | null>
  loadMetrics: () => Promise<unknown>
  platform?: string
  now?: () => number
  warn?: (message: string) => void
  iconWaitTimeout?: number
}

/** Bounded, expiring caches and a shared concurrency limit across IPC batches. */
export function createExplorerAppearanceService (dependencies: AppearanceDependencies): (payload: unknown) => Promise<ExplorerAppearance> {
  const platform = dependencies.platform ?? process.platform
  const now = dependencies.now ?? Date.now
  const warn = dependencies.warn ?? (() => {})
  const iconWaitTimeout = dependencies.iconWaitTimeout ?? 5000
  const icons = new Map<string, { value: string | null, expires: number }>()
  const pending = new Map<string, Promise<string | null>>()
  const waiting: Array<() => void> = []
  let active = 0
  let metricsCache: { value: ExplorerMetrics, source: 'windows' | 'fallback', expires: number } | undefined
  let metricsPending: Promise<void> | undefined

  async function limitIconRead (filePath: string): Promise<string | null> {
    if (active >= maximumConcurrentIcons) {
      await new Promise<void>(resolve => waiting.push(resolve))
    } else {
      active++
    }
    try {
      const value = await dependencies.loadIcon(filePath)
      if (value === null || value.length > maximumIconCharacters || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) {
        throw new Error('System icon is empty or is not a bounded PNG data URL')
      }
      return value
    } finally {
      const next = waiting.shift()
      if (next !== undefined) {
        next()
      } else {
        active--
      }
    }
  }

  async function loadIcon (filePath: string): Promise<string | null> {
    const key = platform === 'win32' ? path.win32.normalize(filePath).toLowerCase() : filePath
    const cached = icons.get(key)
    if (cached !== undefined && cached.expires > now()) {
      icons.delete(key)
      icons.set(key, cached)
      return cached.value
    }
    const existing = pending.get(key)
    if (existing !== undefined) {
      return await existing
    }
    if (pending.size >= maximumPendingIcons) {
      warn('Explorer icon queue is full; the renderer can retry after the current batch')
      return null
    }
    const operation = (async () => {
      let value: string | null = null
      try { value = await limitIconRead(filePath) } catch (error: unknown) {
        warn('Could not read a system Explorer icon: ' + (error instanceof Error ? error.message : String(error)))
      }
      icons.delete(key)
      icons.set(key, { value, expires: now() + (value === null ? failureLifetime : cacheLifetime) })
      while (icons.size > maximumCachedIcons) {
        icons.delete(icons.keys().next().value!)
      }
      return value
    })()
    pending.set(key, operation)
    try { return await operation } finally { pending.delete(key) }
  }

  async function loadMetrics (): Promise<void> {
    if (metricsCache !== undefined && metricsCache.expires > now()) {
      return
    }
    if (metricsPending === undefined) {
      metricsPending = (async () => {
        try {
          if (platform !== 'win32') {
            throw new Error('Windows Explorer metrics are unavailable on this platform')
          }
          const value = validateMetrics(await dependencies.loadMetrics())
          metricsCache = { value, source: 'windows', expires: now() + cacheLifetime }
        } catch (error: unknown) {
          warn('Using fallback Explorer metrics: ' + (error instanceof Error ? error.message : String(error)))
          metricsCache = { value: { ...fallbackMetrics }, source: 'fallback', expires: now() + failureLifetime }
        }
      })()
    }
    try { await metricsPending } finally { metricsPending = undefined }
  }

  return async (payload: unknown): Promise<ExplorerAppearance> => {
    const paths = validatePaths(payload, platform)
    const uniquePaths = Array.from(new Set(paths))
    const values: Array<string | null> = uniquePaths.map(() => null)
    const reads = Promise.all(uniquePaths.map(async (filePath, index) => { values[index] = await loadIcon(filePath) }))
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<void>(resolve => {
      timer = setTimeout(() => {
        warn('System Explorer icons are still loading; returning available icons until the next refresh')
        resolve()
      }, iconWaitTimeout)
    })
    // A caller deadline does not release a native slot: slow shell extensions
    // cannot accumulate unlimited native work across repeated requests.
    try {
      const completedIcons = Promise.race([ reads, deadline ]).finally(() => { clearTimeout(timer) })
      await Promise.all([ completedIcons, loadMetrics() ])
    } finally {
      clearTimeout(timer)
    }
    const result: Record<string, string | null> = Object.fromEntries(uniquePaths.map((filePath, index) => [ filePath, values[index] ]))
    const metrics = metricsCache!
    return { icons: result, metrics: { ...metrics.value }, source: metrics.source }
  }
}

// Electron's getFileIcon derives the icon from the extension alone, so folders
// and extensionless files receive a drive icon. Those use the Windows stock
// folder (SIID_FOLDER = 3) and unassociated document (SIID_DOCNOASSOC = 0)
// icons instead, extracted at the requested physical pixel size.
const stockIconsProgram = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  Add-Type -AssemblyName System.Drawing
  Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
public static class ExplorerStockIcons {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct StockIconInformation {
    public uint size; public IntPtr icon; public int systemImageIndex; public int iconIndex;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string path;
  }
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)] static extern int SHGetStockIconInfo(uint identifier, uint flags, ref StockIconInformation information);
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)] static extern int SHDefExtractIcon(string iconFile, int index, uint flags, out IntPtr large, IntPtr small, uint size);
  [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr icon);
  public static string Read(uint identifier, int pixels) {
    StockIconInformation information = new StockIconInformation();
    information.size = (uint)Marshal.SizeOf(typeof(StockIconInformation));
    if (SHGetStockIconInfo(identifier, 0, ref information) != 0) throw new InvalidOperationException("Cannot locate stock icon");
    IntPtr handle;
    if (SHDefExtractIcon(information.path, information.iconIndex, 0, out handle, IntPtr.Zero, (uint)pixels) != 0 || handle == IntPtr.Zero) throw new InvalidOperationException("Cannot extract stock icon");
    try {
      using (Icon icon = Icon.FromHandle(handle))
      using (Bitmap bitmap = icon.ToBitmap())
      using (MemoryStream stream = new MemoryStream()) {
        bitmap.Save(stream, ImageFormat.Png);
        return "data:image/png;base64," + Convert.ToBase64String(stream.ToArray());
      }
    } finally { DestroyIcon(handle); }
  }
}
'@
  $pixels = PIXELS
  [Console]::Out.Write((@{ folder = [ExplorerStockIcons]::Read(3, $pixels); document = [ExplorerStockIcons]::Read(0, $pixels) } | ConvertTo-Json -Compress))
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`

const stockIcons = new Map<number, Promise<{ folder: string, document: string }>>()

async function readStockIcons (pixels: number): Promise<{ folder: string, document: string }> {
  const systemRoot = process.env.SystemRoot
  if (systemRoot === undefined || !path.win32.isAbsolute(systemRoot)) {
    throw new Error('Windows system directory is unavailable')
  }
  // Only a validated integer enters the program text
  if (!Number.isInteger(pixels) || pixels < 16 || pixels > 256) {
    throw new RangeError('Invalid stock icon size')
  }
  const executable = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const program = stockIconsProgram.replace('PIXELS', String(pixels))
  const output = await new Promise<string>((resolve, reject) => {
    execFile(executable, [ '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand',
      Buffer.from(program, 'utf16le').toString('base64') ], { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 2 * maximumIconCharacters + 1024 }, (error, stdout) => {
      if (error !== null) {
        reject(error)
      } else {
        resolve(stdout)
      }
    })
  })
  const value = JSON.parse(output) as { folder?: unknown, document?: unknown }
  if (typeof value.folder !== 'string' || typeof value.document !== 'string') {
    throw new Error('Invalid stock icon output')
  }
  return { folder: value.folder, document: value.document }
}

/** Memoized per pixel size; a failed read is retried on the next request. */
async function readStockIcon (kind: 'folder' | 'document', pixels: number): Promise<string> {
  let pending = stockIcons.get(pixels)
  if (pending === undefined) {
    pending = readStockIcons(pixels)
    stockIcons.set(pixels, pending)
    pending.catch(() => { stockIcons.delete(pixels) })
  }
  return (await pending)[kind]
}

/** Preserve an actual high-DPI representation instead of exporting default 1x. */
export async function readSystemExplorerIcon (filePath: string): Promise<string | null> {
  const { app, screen } = await import('electron')
  const displayScale = Math.max(1, ...screen.getAllDisplays().map(display => display.scaleFactor))
  if (process.platform === 'win32') {
    const normalized = path.win32.normalize(filePath)
    const isDriveRoot = path.win32.parse(normalized).root === normalized
    if (!isDriveRoot) {
      const isDirectory = (await stat(filePath)).isDirectory()
      if (isDirectory || !path.win32.basename(normalized).includes('.')) {
        return await readStockIcon(isDirectory ? 'folder' : 'document', Math.round(16 * displayScale))
      }
    }
  }
  let icon = await app.getFileIcon(filePath, { size: 'small' })
  if (icon.isEmpty()) {
    return null
  }
  let representationScale = Math.max(1, ...icon.getScaleFactors())
  if (icon.getSize().width * representationScale < 16 * displayScale) {
    const larger = await app.getFileIcon(filePath, { size: 'normal' })
    if (!larger.isEmpty()) {
      icon = larger
      representationScale = Math.max(1, ...icon.getScaleFactors())
    }
  }
  return icon.toDataURL({ scaleFactor: representationScale })
}

const getCachedAppearance = createExplorerAppearanceService({
  loadIcon: readSystemExplorerIcon,
  loadMetrics: measureWindowsExplorerMetrics,
  warn: message => console.warn('[Explorer appearance] ' + message)
})

export async function getExplorerAppearance (payload: unknown): Promise<ExplorerAppearance> {
  return await getCachedAppearance(payload)
}
