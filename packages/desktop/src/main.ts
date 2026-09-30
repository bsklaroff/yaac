/**
 * Electron entry point: untested glue over the sibling modules, which hold
 * the logic.
 *
 * The shell is a client of whatever server `server.json` names and never
 * starts or stops one. Close hides to the tray; Quit exits the shell and
 * leaves the server and the auth daemon running. With no server reachable
 * the window shows the picker (connect-page.ts). While running it follows
 * `/events` to show waiting workspaces (dock badge, tray, notifications) and
 * to hold the workspaces' port forwards.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, screen, shell, Tray,
} from 'electron'
import WebSocket from 'ws'
import { resolveServerTarget } from '@yaac/shared/server-api'
import {
  normalizeServerUrl, probeServer, readServerConfig, withServerSelected, writeServerConfig,
} from '@yaac/shared/server-config'
import { env } from '@yaac/shared/env'
import { AttentionMonitor, badgeText, notificationFor, type WaitingWorkspace } from '#attention'
import { startEventsMonitor, type EventsSocket } from '#events'
import { startForwarder, type DesktopForwarder } from '#forwarder'
import { probeIdentity, runFlow } from '#flow'
import { connectPageUrl } from '#connect-page'
import { appMenuTemplate } from '#menu'
import { splashUrl, type LaunchError } from '#messages'
import { ensureAuthDaemonRunning, resolveYaacCommand } from '#server-process'
import {
  addServerRemote, applyServerSwitch, getServerTargets, parseServerSelection, type ServerSwitchDeps,
} from '#server-switch'
import { backgroundColorFor } from '#theme-bg'
import { buildTrayBitmap } from '#tray-icon'
import { hardenGuestWebPreferences, isAllowedPreviewUrl, sanitizeWebviewSrc } from '#webview-guard'
import { boundsVisibleOn, readWindowState, saveWindowState } from '#window-state'
import { createFsTransitionGuard, zoomAction } from '#window-zoom'

app.setName('yaac')

let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
// Zoom clicks are ignored during a full-screen transition (see window-zoom.ts).
const fsGuard = createFsTransitionGuard()
let events: { stop: () => void } | null = null
let forwarder: DesktopForwarder | null = null
// One monitor per server, kept across WS reconnects so ongoing waits don't
// re-notify. Replaced on a server switch.
let attention = new AttentionMonitor()
// True while the window shows the picker. Re-showing such a window re-runs
// the boot flow, since the user may have fixed things from a terminal.
let onConnectPage = false

const resolveTarget = resolveServerTarget

function windowStateFile(): string {
  return path.join(app.getPath('userData'), 'window-state.json')
}

async function createWindow(): Promise<BrowserWindow> {
  const saved = await readWindowState(windowStateFile())
  const displays = screen.getAllDisplays().map((d) => d.workArea)
  const bounds = saved && boundsVisibleOn(saved, displays) ? saved : null
  const w = new BrowserWindow({
    width: bounds?.width ?? 1280,
    height: bounds?.height ?? 860,
    ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 880,
    minHeight: 560,
    title: 'yaac',
    show: false,
    backgroundColor: backgroundColorFor(nativeTheme.shouldUseDarkColors),
    // The traffic lights are hidden too (setWindowButtonVisibility below); the
    // SPA draws its own controls (WindowControls.tsx) and drag strips.
    titleBarStyle: 'hidden',
    // The renderer is web content from the server: sandboxed, no Node.
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(path.dirname(fileURLToPath(import.meta.url)), 'preload.cjs'),
      // The attention chime plays on a background event, not a user gesture.
      autoplayPolicy: 'no-user-gesture-required',
      // For the workspace preview. Guests are hardened and pinned to loopback
      // below (will-attach-webview, web-contents-created).
      webviewTag: true,
    },
  })
  if (process.platform === 'darwin') w.setWindowButtonVisibility(false)
  fsGuard.settle()
  w.on('enter-full-screen', () => fsGuard.settle())
  w.on('leave-full-screen', () => fsGuard.settle())
  w.webContents.on('will-attach-webview', (_e, webPreferences, params) => {
    hardenGuestWebPreferences(webPreferences as unknown as Record<string, unknown>)
    params.src = sanitizeWebviewSrc(params.src)
  })
  w.once('ready-to-show', () => w.show())
  const onThemeChange = (): void => {
    w.setBackgroundColor(backgroundColorFor(nativeTheme.shouldUseDarkColors))
  }
  nativeTheme.on('updated', onThemeChange)
  w.on('closed', () => nativeTheme.removeListener('updated', onThemeChange))
  // target="_blank" links open in the system browser.
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // Close hides to the tray; only an explicit Quit destroys the window.
  w.on('close', (e) => {
    // getNormalBounds() is the windowed geometry even when maximized.
    void saveWindowState(windowStateFile(), w.getNormalBounds())
    if (!quitting) {
      e.preventDefault()
      w.hide()
    }
  })
  return w
}

/**
 * Run the boot flow and load the server's origin, or the picker when no
 * server will accept this device. Returns whether a server was loaded.
 */
async function openWindow(): Promise<boolean> {
  if (!win || win.isDestroyed()) win = await createWindow()
  const w = win
  const result = await runFlow({
    resolveTarget,
    ensureAuthDaemon: (target) => ensureAuthDaemonRunning({
      target,
      command: resolveYaacCommand(
        app.isPackaged ? process.resourcesPath : null,
        ['auth', 'server', 'run'],
      ),
      hydratePath: app.isPackaged,
    }),
    probeIdentity: () => probeIdentity(),
    onStatus: (text) => {
      void w.loadURL(splashUrl(text)).catch(() => { /* superseded by the next load */ })
    },
    rendererBaseUrl: env.desktopRendererUrl,
  })
  if (!result.ok) {
    await showConnectPage(w, result.error)
    return false
  }
  try {
    await w.loadURL(result.url)
    onConnectPage = false
    // Started only once a server is reachable, so the picker doesn't spin a
    // reconnect loop.
    startEvents()
    return true
  } catch (err) {
    dialog.showErrorBox('Could not open yaac', err instanceof Error ? err.message : String(err))
    return false
  }
}

/**
 * Show the picker. Events, forwards and the badge are cleared first so
 * nothing claims state from a server the shell cannot reach.
 */
async function showConnectPage(w: BrowserWindow, error: LaunchError): Promise<void> {
  onConnectPage = true
  events?.stop()
  events = null
  forwarder?.stop()
  forwarder = null
  attention = new AttentionMonitor()
  applyAttention(0, [])
  const targets = await getServerTargets(serverSwitchDeps)
  await w.loadURL(connectPageUrl({ error, targets }))
    .catch((err: unknown) => {
      dialog.showErrorBox(error.title, err instanceof Error ? err.message : String(err))
    })
}

function showWindow(): void {
  if (win && !win.isDestroyed()) {
    win.show()
    win.focus()
    // The user may have started a server since the picker was shown.
    if (onConnectPage) void openWindow()
    return
  }
  // The window was destroyed (e.g. a renderer crash).
  void openWindow()
}

function createTray(): void {
  const bmp = buildTrayBitmap(36)
  const image = nativeImage.createFromBitmap(bmp.data, {
    width: bmp.width, height: bmp.height, scaleFactor: 2,
  })
  image.setTemplateImage(true)
  tray = new Tray(image)
  tray.setToolTip(app.name)
  updateTray(0)
  tray.on('click', () => showWindow())
}

function updateTray(waitingCount: number): void {
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open yaac', click: () => showWindow() },
    { type: 'separator' },
    {
      label: waitingCount > 0 ? `${waitingCount} waiting for input` : 'No workspaces waiting',
      enabled: false,
    },
    { type: 'separator' },
    { label: 'Quit yaac', click: () => app.quit() },
  ]))
}

function applyAttention(waitingCount: number, toNotify: WaitingWorkspace[]): void {
  if (process.platform === 'darwin') app.dock?.setBadge(badgeText(waitingCount))
  updateTray(waitingCount)
  if (!Notification.isSupported()) return
  for (const s of toNotify) {
    const n = new Notification(notificationFor(s))
    n.on('click', () => showWindow())
    n.show()
  }
}

/** Adapt `ws` to #events. */
function openEventsSocket(url: string): EventsSocket {
  const socket = new WebSocket(url)
  const rawToString = (data: Buffer | ArrayBuffer | Buffer[]): string => {
    if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
    return Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8')
  }
  return {
    onMessage: (cb) => socket.on('message', (data) => cb(rawToString(data))),
    // Error and close both end the connection; #events dedupes the pair.
    onClose: (cb) => {
      socket.on('close', cb)
      socket.on('error', cb)
    },
    close: () => socket.close(),
  }
}

function startEvents(): void {
  events?.stop()
  forwarder?.stop()
  // Each snapshot carries both the attention signal and the port forwards
  // on offer (docs/port-forward-tunnel.md).
  forwarder = startForwarder({ resolveTarget })
  events = startEventsMonitor({
    resolveTarget,
    openSocket: openEventsSocket,
    onSnapshot: (snapshot) => {
      const { waitingCount, toNotify } = attention.update(snapshot)
      applyAttention(waitingCount, toNotify)
      forwarder?.apply(snapshot)
    },
  })
}

/**
 * After a server switch: reset the badge and attention monitor, then re-run
 * the boot flow to load the new origin (or the picker if it fails).
 */
function relandOnNewServer(): void {
  attention = new AttentionMonitor()
  applyAttention(0, [])
  void openWindow()
}

// Server picker IPC. Handlers reply before relanding, which destroys the
// calling page.
const serverSwitchDeps: ServerSwitchDeps = {
  readServerConfig,
  writeServerConfig,
  select: withServerSelected,
  probeServer,
  normalizeUrl: normalizeServerUrl,
}
ipcMain.handle('server:targets', () => getServerTargets(serverSwitchDeps))
// The picker's "Try again". A failure re-renders the picker with fresh rows.
ipcMain.handle('server:retry', async () => {
  const ok = await openWindow()
  return ok ? { ok: true } : { ok: false, error: 'still no server' }
})
ipcMain.handle('server:switch', async (_e, raw: unknown) => {
  const sel = parseServerSelection(raw)
  if (!sel) return { ok: false, error: 'invalid selection' }
  const outcome = await applyServerSwitch(sel, serverSwitchDeps)
  if (outcome.ok) setImmediate(() => relandOnNewServer())
  return outcome
})
ipcMain.handle('server:add-remote', async (_e, url: unknown) => {
  if (typeof url !== 'string') return { ok: false, error: 'invalid arguments' }
  const outcome = await addServerRemote(url, serverSwitchDeps)
  if (outcome.ok) setImmediate(() => relandOnNewServer())
  return outcome
})

// Window controls from WindowControls.tsx, via the preload bridge.
ipcMain.on('window:minimize', () => win?.minimize())
ipcMain.on('window:toggle-maximize', (_e, altKey: unknown) => {
  if (!win || fsGuard.active()) return
  const action = zoomAction({
    platform: process.platform,
    altKey: altKey === true,
    isFullScreen: win.isFullScreen(),
    isMaximized: win.isMaximized(),
  })
  if (action === 'enter-full-screen' || action === 'exit-full-screen') {
    fsGuard.begin()
    win.setFullScreen(action === 'enter-full-screen')
  } else if (action === 'unmaximize') win.unmaximize()
  else win.maximize()
})
ipcMain.on('window:close', () => win?.close())
ipcMain.on('window:open-external', (_e, url: unknown) => {
  if (typeof url === 'string' && /^https?:/.test(url)) void shell.openExternal(url)
})

// Preview <webview> guests stay on loopback; new windows and off-loopback
// navigations open in the system browser instead.
app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (e, url) => {
    if (!isAllowedPreviewUrl(url)) {
      e.preventDefault()
      if (/^https?:/.test(url)) void shell.openExternal(url)
    }
  })
})

async function boot(): Promise<void> {
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate()))
  // A failed boot still shows the picker, so the shell keeps running.
  await openWindow()
  createTray()
}

void app.whenReady().then(boot)

// Dock icon click (macOS) and tray both reopen the hidden window.
app.on('activate', () => showWindow())

// Stay in the tray; quitting is explicit (tray Quit or Cmd-Q).
app.on('window-all-closed', () => { /* stay in the tray */ })

app.on('before-quit', () => {
  quitting = true
  events?.stop()
  events = null
})
