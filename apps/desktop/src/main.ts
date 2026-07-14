/**
 * Entry: wire Electron to the boot flow. Untested glue — the logic lives in
 * the sibling modules (#flow, #mint, #server-process, #messages, #attention,
 * #events, #tray-icon, #menu, #theme-bg, #window-state).
 *
 * The shell is a client of whatever server the target resolution lands on —
 * it never owns the server: close hides to the tray, Quit quits the shell
 * only, and the server keeps running (it was never ours to stop). While in
 * the tray it follows the `/events` stream as a bearer client to surface
 * waiting sessions (dock badge, tray status, notifications). Each window
 * open also ensures the auth-daemon best-effort, like `yaac open` — and
 * like the server, Quit leaves it running (machine-scoped, shared with the
 * CLI; never ours to stop).
 */
import path from 'node:path'
import {
  app, BrowserWindow, dialog, Menu, nativeImage, nativeTheme, Notification, screen, shell, Tray,
} from 'electron'
import WebSocket from 'ws'
import { resolveServerTarget } from '@yaac/shared/server-client'
import { env } from '@yaac/shared/env'
import { AttentionMonitor, badgeText, notificationFor, type WaitingSession } from '#attention'
import { startEventsMonitor, type EventsSocket } from '#events'
import { runFlow } from '#flow'
import { appMenuTemplate } from '#menu'
import { mintWebToken } from '#mint'
import { errorBoxText, splashUrl } from '#messages'
import { ensureAuthDaemonRunning, resolveYaacCommand, runYaacServerStart } from '#server-process'
import { backgroundColorFor } from '#theme-bg'
import { buildTrayBitmap } from '#tray-icon'
import { boundsVisibleOn, readWindowState, saveWindowState } from '#window-state'

app.setName('yaac')

let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let events: { stop: () => void } | null = null
// One monitor for the process lifetime: its first-snapshot seeding suppresses
// a notification burst on launch, and WS reconnects must not re-notify
// ongoing waits.
const attention = new AttentionMonitor()

function resolveTarget(): ReturnType<typeof resolveServerTarget> {
  // The shell ships no server code, so it has no build id to match
  // against the lock — it only needs the server to be live.
  return resolveServerTarget({ requireBuildMatch: false })
}

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
    // No native title bar; the floating traffic lights sit over the SPA's
    // top row, which reserves drag regions for them (see App.tsx).
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 13, y: 7 },
    // The renderer is pure web content from the server origin — no preload,
    // no Node, fully sandboxed.
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Let the attention chime play without a prior click (it fires on a
      // background event — a session flipping to waiting), not a user gesture.
      autoplayPolicy: 'no-user-gesture-required',
    },
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
    void saveWindowState(windowStateFile(), w.getBounds())
    if (!quitting) {
      e.preventDefault()
      w.hide()
    }
  })
  return w
}

/**
 * Run the resolve → start-if-dead → mint flow and land the window on the
 * authed URL. Re-run in full whenever the window must be (re)created: the
 * exchange token is single-use, so each landing needs a fresh mint, and
 * re-running also revives a server that died while the shell sat in the tray.
 */
async function openWindow(): Promise<boolean> {
  if (!win || win.isDestroyed()) win = await createWindow()
  const w = win
  const result = await runFlow({
    resolveTarget,
    startLocalServer: () => runYaacServerStart(
      resolveYaacCommand(app.isPackaged ? process.resourcesPath : null, ['server', 'start']),
      { hydratePath: app.isPackaged },
    ),
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
    dialog.showErrorBox(result.error.title, errorBoxText(result.error))
    return false
  }
  try {
    await w.loadURL(result.url)
    return true
  } catch (err) {
    dialog.showErrorBox('Could not open yaac', err instanceof Error ? err.message : String(err))
    return false
  }
}

function showWindow(): void {
  if (win && !win.isDestroyed()) {
    win.show()
    win.focus()
    return
  }
  // Window gone (e.g. a renderer crash destroyed it) — full re-open. A
  // failure here shows its error box and leaves the shell in the tray for
  // another try, unlike the first boot (which quits).
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
      label: waitingCount > 0 ? `${waitingCount} waiting for input` : 'No sessions waiting',
      enabled: false,
    },
    { type: 'separator' },
    { label: 'Quit yaac', click: () => app.quit() },
  ]))
}

function applyAttention(waitingCount: number, toNotify: WaitingSession[]): void {
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

async function boot(): Promise<void> {
  // Role-based menus: the app presents under its own name and Cmd-C/V/
  // Select-All reach the embedded xterm terminals via editMenu.
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate()))
  if (!await openWindow()) {
    app.quit()
    return
  }
  createTray()
  events = startEventsMonitor({
    resolveTarget,
    openSocket: openEventsSocket,
    onSnapshot: (snapshot) => {
      const { waitingCount, toNotify } = attention.update(snapshot)
      applyAttention(waitingCount, toNotify)
    },
  })
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
