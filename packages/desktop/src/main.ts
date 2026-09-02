/**
 * Entry: wire Electron to the boot flow. Untested glue — the logic lives in
 * the sibling modules (#flow, #mint, #server-process, #messages, #attention,
 * #events, #tray-icon, #menu, #theme-bg, #window-state).
 *
 * The shell is a client of whatever server `server.json` names — it never
 * owns one, and never starts one: close hides to the tray, Quit quits the
 * shell only, and the server keeps running (it was never ours to stop).
 * With no server reachable the window shows the picker (`#connect-page`)
 * rather than an error dialog over nothing. While in the tray it follows
 * the `/events` stream as a bearer client to surface waiting worktrees
 * (dock badge, tray status, notifications). Each window
 * open also ensures the auth-daemon best-effort, like `yaac open` — and
 * like the server, Quit leaves it running (machine-scoped, shared with the
 * CLI; never ours to stop).
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
import { AttentionMonitor, badgeText, notificationFor, type WaitingWorktree } from '#attention'
import { startEventsMonitor, type EventsSocket } from '#events'
import { startForwarder, type DesktopForwarder } from '#forwarder'
import { runFlow } from '#flow'
import { connectPageUrl } from '#connect-page'
import { appMenuTemplate } from '#menu'
import { mintWebToken } from '#mint'
import { splashUrl, type LaunchError } from '#messages'
import { ensureAuthDaemonRunning, resolveYaacCommand } from '#server-process'
import {
  addServerRemote, applyServerSwitch, getServerTargets, parseServerSelection, type ServerSwitchDeps,
} from '#server-switch'
import { backgroundColorFor } from '#theme-bg'
import { buildTrayBitmap } from '#tray-icon'
import { appHostFromUrl, hardenGuestWebPreferences, isAllowedPreviewUrl, sanitizeWebviewSrc } from '#webview-guard'
import { boundsVisibleOn, readWindowState, saveWindowState } from '#window-state'
import { createFsTransitionGuard, zoomAction } from '#window-zoom'

app.setName('yaac')

let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
// macOS animates full-screen transitions and documents isFullScreen() as
// stale until enter-/leave-full-screen fires — zoom clicks are ignored while
// a requested transition is in flight so a double-click can't re-request it.
const fsGuard = createFsTransitionGuard()
let events: { stop: () => void } | null = null
let forwarder: DesktopForwarder | null = null
// One monitor per attached server: its first-snapshot seeding suppresses a
// notification burst on launch, and WS reconnects must not re-notify ongoing
// waits. Replaced only on a server switch, where the new server's ongoing
// waits deserve the same silence.
let attention = new AttentionMonitor()
// True while the window is showing the picker rather than a server's SPA.
// A window in that state is not a window to merely re-show: whatever the
// user did about the failure (started a server, ran `yaac remote set`)
// happened OUTSIDE it, and only re-running the flow can notice.
let onConnectPage = false

// The one place a target comes from, shared by the flow, the mint, the
// events socket and the forwarder: `server.json`, like every other client.
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
    // Native backing matched to the OS appearance so resizes don't flash
    // the opposite shell color at the edges.
    backgroundColor: backgroundColorFor(nativeTheme.shouldUseDarkColors),
    // Hide the title bar AND the native traffic lights (setWindowButtonVisibility
    // below) — the SPA draws its own monochrome controls (WindowControls.tsx)
    // and reserves draggable strips (.titlebar-drag) so the window still moves.
    titleBarStyle: 'hidden',
    // The renderer is web content from the server origin — no Node, sandboxed;
    // the preload exposes only the minimal window-control bridge.
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(path.dirname(fileURLToPath(import.meta.url)), 'preload.cjs'),
      // Let the attention chime play without a prior click (it fires on a
      // background event — a worktree flipping to waiting), not a user gesture.
      autoplayPolicy: 'no-user-gesture-required',
      // Enable the <webview> the worktree preview embeds. Guests are hardened
      // and pinned to loopback below (will-attach-webview + web-contents-created).
      webviewTag: true,
    },
  })
  if (process.platform === 'darwin') w.setWindowButtonVisibility(false)
  fsGuard.settle()
  w.on('enter-full-screen', () => fsGuard.settle())
  w.on('leave-full-screen', () => fsGuard.settle())
  // Harden every preview <webview> before it attaches: strip any preload,
  // force Node off / isolation on, and refuse a src off loopback and the
  // attached server's host (where a remote server's forwarded ports live).
  w.webContents.on('will-attach-webview', (_e, webPreferences, params) => {
    hardenGuestWebPreferences(webPreferences as unknown as Record<string, unknown>)
    params.src = sanitizeWebviewSrc(params.src, appHostFromUrl(w.webContents.getURL()))
  })
  w.once('ready-to-show', () => w.show())
  const onThemeChange = (): void => {
    w.setBackgroundColor(backgroundColorFor(nativeTheme.shouldUseDarkColors))
  }
  nativeTheme.on('updated', onThemeChange)
  w.on('closed', () => nativeTheme.removeListener('updated', onThemeChange))
  // The SPA's external links (forwarded ports, upstream docs) are
  // target="_blank": route them to the system browser, never a child window.
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // Close hides to the tray; only an explicit Quit destroys the window.
  w.on('close', (e) => {
    // getNormalBounds(): the last windowed geometry even when the window is
    // currently maximized or full screen.
    void saveWindowState(windowStateFile(), w.getNormalBounds())
    if (!quitting) {
      e.preventDefault()
      w.hide()
    }
  })
  return w
}

/**
 * Run the resolve → mint flow and land the window on the authed URL, or on
 * the picker when there is no server to land on. Re-run in full whenever
 * the window must be (re)created: the exchange token is single-use, so each
 * landing needs a fresh mint, and re-running also picks up a server that
 * came back while the shell sat in the tray.
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
    mintToken: mintWebToken,
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
    // Only now: a shell with no server has nothing to subscribe to, and a
    // retry loop against a target that does not resolve would spin for as
    // long as the window sat on the picker.
    startEvents()
    return true
  } catch (err) {
    dialog.showErrorBox('Could not open yaac', err instanceof Error ? err.message : String(err))
    return false
  }
}

/**
 * Put the window on the picker. Everything that follows a server goes
 * quiet first — there is no server to follow, and a stale badge would
 * claim worktrees are waiting on a server this shell cannot reach.
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
    // Re-resolve when the window is sitting on the picker: the user very
    // likely just went and started a server, and showing them the same
    // stale failure again is the one thing that cannot help.
    if (onConnectPage) void openWindow()
    return
  }
  // Window gone (e.g. a renderer crash destroyed it) — full re-open, which
  // lands on the picker if the server is gone.
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
      label: waitingCount > 0 ? `${waitingCount} waiting for input` : 'No worktrees waiting',
      enabled: false,
    },
    { type: 'separator' },
    { label: 'Quit yaac', click: () => app.quit() },
  ]))
}

function applyAttention(waitingCount: number, toNotify: WaitingWorktree[]): void {
  if (process.platform === 'darwin') app.dock?.setBadge(badgeText(waitingCount))
  updateTray(waitingCount)
  if (!Notification.isSupported()) return
  for (const s of toNotify) {
    const n = new Notification(notificationFor(s))
    n.on('click', () => showWindow())
    n.show()
  }
}

/** Adapt `ws` (which can send the bearer header; native WebSocket can't) to #events. */
function openEventsSocket(url: string, bearer: string): EventsSocket {
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${bearer}` } })
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
  // The same stream drives both: a snapshot carries the attention signal
  // AND the port mappings the server is offering, and this process is the
  // only long-lived client that can bind them (docs/server-in-cluster.md).
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
 * After a server switch: clear the badge/tray, seed a fresh attention
 * monitor (the new server's ongoing waits deserve the same launch
 * silence), and re-run the boot flow so the window lands authed on the new
 * origin. `openWindow` restarts the events socket on success and shows the
 * picker again on failure, so a switch to a server that dies between the
 * probe and the mint lands somewhere useful.
 */
function relandOnNewServer(): void {
  attention = new AttentionMonitor()
  applyAttention(0, [])
  void openWindow()
}

// The SPA's Server settings section (desktop-only) drives these. Handlers
// reply with the outcome before the reland tears the calling renderer down.
const serverSwitchDeps: ServerSwitchDeps = {
  readServerConfig,
  writeServerConfig,
  select: withServerSelected,
  probeServer,
  normalizeUrl: normalizeServerUrl,
}
ipcMain.handle('server:targets', () => getServerTargets(serverSwitchDeps))
// The picker's "Try again": re-run the whole flow. On success the window
// lands on the SPA; on failure it re-renders the picker with the current
// failure and the current rows, so a server registered meanwhile shows up.
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
ipcMain.handle('server:add-remote', async (_e, url: unknown, token: unknown) => {
  if (typeof url !== 'string' || typeof token !== 'string') {
    return { ok: false, error: 'invalid arguments' }
  }
  const outcome = await addServerRemote(url, token, serverSwitchDeps)
  if (outcome.ok) setImmediate(() => relandOnNewServer())
  return outcome
})

// The custom window controls (WindowControls.tsx) drive the window through the
// preload bridge. Registered once, they act on whichever window is current.
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

// Constrain preview <webview> guests: open any new window or navigation off
// the allowed preview hosts (an OAuth hop, an external link) in the system
// browser rather than inside the preview, which stays pinned to the dev
// server — reached via loopback locally, or the attached server's host when
// remote (its forwarded ports bind that interface).
app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (e, url) => {
    const embedderUrl = contents.hostWebContents?.getURL() ?? ''
    if (!isAllowedPreviewUrl(url, appHostFromUrl(embedderUrl))) {
      e.preventDefault()
      if (/^https?:/.test(url)) void shell.openExternal(url)
    }
  })
})

async function boot(): Promise<void> {
  // Role-based menus: the app presents under its own name and Cmd-C/V/
  // Select-All reach the embedded xterm terminals via editMenu.
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate()))
  // No quit-on-failure: a shell that cannot reach a server still has
  // something to offer — the picker that fixes it — and the tray is what
  // keeps it alive while the user goes and starts one.
  await openWindow()
  createTray()
}

void app.whenReady().then(boot)

// Dock icon click (macOS) and tray both reopen the hidden window.
app.on('activate', () => showWindow())

// The tray keeps the shell alive with every window closed (hidden); quitting
// is explicit (tray Quit / Cmd-Q). The server is not ours to stop either way.
app.on('window-all-closed', () => { /* stay in the tray */ })

app.on('before-quit', () => {
  quitting = true
  events?.stop()
  events = null
})
