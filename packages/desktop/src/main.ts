/**
 * Electron entry point: untested glue over the sibling modules, which hold
 * the logic.
 *
 * The shell is a client of whatever server `server.json` names. The tray,
 * the picker and the SPA's Server settings also set up, start, stop and
 * restart this machine's servers through `brew` and the `yaac` CLI
 * (local-setup.ts, server-control.ts), but only when asked: Close hides to
 * the tray, and Quit exits the shell and its auth daemon and leaves the
 * server running. With no server reachable the window shows the picker
 * (connect-page.ts). While running it follows `/events` to show waiting
 * workspaces (dock badge, tray, notifications) and to hold the workspaces'
 * port forwards.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, screen, shell, systemPreferences, Tray,
  utilityProcess, type IpcMainInvokeEvent,
} from 'electron'
import { isLoopbackOrigin, resolveServerTarget } from '@yaac/shared/server-api'
import {
  normalizeServerUrl, probeServer, readServerConfig, withServerSelected, writeServerConfig,
} from '@yaac/shared/server-config'
import { env } from '@yaac/shared/env'
import type { DesktopLocalState, DesktopServerOutcome, ProjectSummary, WorkspaceListEntry } from '@yaac/shared/types'
import { AttentionMonitor, badgeText, notificationFor } from '#attention'
import { startEventsMonitor } from '@yaac/shared/events'
import { startForwarder, type DesktopForwarder } from '#forwarder'
import { probeIdentity, runFlow } from '#flow'
import { connectPageUrl } from '#connect-page'
import { CLUSTER_SUPPORTED, createSetupRunner, localView, onPath, setupConfirmation } from '#local-setup'
import { appMenuTemplate } from '#menu'
import { splashUrl, type LaunchError } from '#messages'
import { adoptLoginShellPath, createAuthDaemonRunner, stopLegacyAuthDaemon } from '#server-process'
import {
  createRunYaac, installState, mayControlLocalServers, parseScope, readLocalServer, runServerAction, trayServerItems,
  type LocalServers, type ScopedAction, type ServerScope,
} from '#server-control'
import {
  addServerRemote, applyServerSwitch, getServerTargets, parseServerSelection, removeServer, restoreSelection,
  type ServerSwitchDeps,
} from '#server-switch'
import { backgroundColorFor } from '#theme-bg'
import { buildTrayBitmap } from '#tray-icon'
import { hardenGuestWebPreferences, isAllowedPreviewUrl, isSameOriginNavigation, sanitizeWebviewSrc } from '#webview-guard'
import { boundsVisibleOn, readWindowState, saveWindowState } from '#window-state'
import { createFsTransitionGuard, zoomAction } from '#window-zoom'

app.setName('yaac')

// A second instance would run a second auth daemon, and the two would take
// each other's socket on the server. It hands its launch to this one.
if (!app.requestSingleInstanceLock()) app.exit(0)
app.on('second-instance', () => showWindow())
/*
 * macOS answers a held letter key with its accent picker instead of key
 * repeat, which breaks holding hjkl in a terminal pane. Registered defaults
 * live in memory for this process only, so nothing is written to any plist.
 * The setting is app-wide, so the chat composer loses the picker too; Option
 * dead keys (Option-e e) still type accents.
 */
if (process.platform === 'darwin') {
  systemPreferences.registerDefaults({ ApplePressAndHoldEnabled: false })
}

let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
// Set once the user agrees to quit through a running setup.
let quitCancelsSetup = false
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
let waiting = 0
// This machine's servers as the tray last read them, and the action under way.
let localServers: LocalServers = { server: null, cluster: null }
let brewFound = false
let lastLocalRead = 0
let serverBusy: ScopedAction | null = null
let refreshing: Promise<void> | null = null
// The tray menu as last built, so a change that leaves it alone keeps it open.
let trayMenuKey = ''
/** Counts server actions, so a status read can tell one overlapped it. */
let actionEpoch = 0

const resolveTarget = resolveServerTarget

const distDir = path.dirname(fileURLToPath(import.meta.url))
const authDaemonReady = Promise.all([adoptLoginShellPath(), stopLegacyAuthDaemon()])
const authDaemon = createAuthDaemonRunner((baseUrl) => utilityProcess.fork(
  path.join(distDir, 'auth-daemon.js'), [baseUrl], { serviceName: 'yaac auth daemon' },
))
const runYaac = createRunYaac()
const setup = createSetupRunner(() => updateTray(), path.join(app.getPath('userData'), 'unfinished-setups.json'))
// A `brew upgrade` or a server started from a terminal shows up within this.
const LOCAL_SERVER_POLL_MS = 60_000
// A renderer asking for this Mac's state gets a read at most this old.
const LOCAL_STATE_FRESH_MS = 5000

function localState(): DesktopLocalState {
  return localView({
    local: localServers,
    busy: serverBusy,
    setup: setup.current(),
    unfinished: setup.unfinished(),
    brew: brewFound,
    clusterSupported: CLUSTER_SUPPORTED,
  })
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
    backgroundColor: backgroundColorFor(nativeTheme.shouldUseDarkColors),
    // The traffic lights are hidden too (setWindowButtonVisibility below); the
    // SPA draws its own controls (WindowControls.tsx) and drag strips.
    titleBarStyle: 'hidden',
    // The renderer is web content from the server: sandboxed, no Node.
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(distDir, 'preload.cjs'),
      // The attention chime plays on a background event, not a user gesture.
      autoplayPolicy: 'no-user-gesture-required',
      // For the workspace preview. Guests are hardened and pinned to loopback
      // below (will-attach-webview, web-contents-created).
      webviewTag: true,
      // Chromium's PDF viewer, for a PDF opened in a file pane.
      plugins: true,
    },
  })
  if (process.platform === 'darwin') w.setWindowButtonVisibility(false)
  fsGuard.settle()
  w.on('enter-full-screen', () => fsGuard.settle())
  w.on('leave-full-screen', () => fsGuard.settle())
  // Only the shell moves the window to another origin (loadURL fires no
  // will-navigate), so the preload bridge stays with the pages it loaded.
  w.webContents.on('will-navigate', (e, url) => {
    if (isSameOriginNavigation(w.webContents.getURL(), url)) return
    e.preventDefault()
    if (/^https?:/.test(url)) void shell.openExternal(url)
  })
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
    ensureAuthDaemon: async (target) => {
      await authDaemonReady
      authDaemon.ensure(target)
    },
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
  applyAttention(0, [], [])
  const targets = await getServerTargets(serverSwitchDeps)
  await refreshLocalServer()
  await w.loadURL(connectPageUrl({ error, targets, local: localState() }))
    .catch((err: unknown) => {
      dialog.showErrorBox(error.title, err instanceof Error ? err.message : String(err))
    })
}

/**
 * Show one setup on its own, from the tray. The page stays until the setup
 * lands the window on its server or the user goes back; events and
 * forwards for the selected server keep running underneath.
 */
async function showSetupPage(scope: ServerScope): Promise<void> {
  if (!win || win.isDestroyed()) win = await createWindow()
  const w = win
  w.show()
  w.focus()
  onConnectPage = false
  const targets = await getServerTargets(serverSwitchDeps)
  await w.loadURL(connectPageUrl({ error: { title: 'Set up yaac on this Mac' }, targets, local: localState(), setup: scope }))
    .catch(() => { /* superseded by the next load */ })
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
  updateTray()
  tray.on('click', () => showWindow())
  setInterval(() => void refreshLocalServer(), LOCAL_SERVER_POLL_MS)
}

function updateTray(): void {
  if (!tray) return
  const items = trayServerItems(localState())
  // Rebuilding swaps the tray's menu, which empties it if it is open.
  const key = JSON.stringify({ items, waiting })
  if (key === trayMenuKey) return
  trayMenuKey = key
  const serverItems = items.map((item) => ({
    label: item.label,
    enabled: item.action !== undefined,
    click: () => {
      const action = item.action
      if (action?.action === 'setup') void showSetupPage(action.scope)
      else if (action) void trayServerAction(action)
    },
  }))
  const menu = Menu.buildFromTemplate([
    { label: 'Open yaac', click: () => showWindow() },
    { type: 'separator' },
    {
      label: waiting > 0 ? `${waiting} waiting for input` : 'No workspaces waiting',
      enabled: false,
    },
    { type: 'separator' },
    ...serverItems,
    ...(serverItems.length > 0 ? [{ type: 'separator' as const }] : []),
    { label: 'Quit yaac', click: () => app.quit() },
  ])
  // An open menu cannot change, so this refresh is for the next opening.
  menu.on('menu-will-show', () => void refreshLocalServer())
  tray.setContextMenu(menu)
}

/**
 * Re-read this machine's servers for the tray. Callers share one read in
 * flight, and a read that an action overlapped is dropped, since it may
 * describe the server from before the action.
 */
function refreshLocalServer(): Promise<void> {
  refreshing ??= readLocalServerState().finally(() => { refreshing = null })
  return refreshing
}

async function readLocalServerState(): Promise<void> {
  if (serverBusy) return
  const epoch = actionEpoch
  lastLocalRead = Date.now()
  // The login-shell PATH is what finds `yaac` and `brew`.
  await authDaemonReady
  const [server, cluster, brew] = await Promise.all([
    readLocalServer(runYaac, 'server'), readLocalServer(runYaac, 'cluster'), onPath('brew'),
  ])
  if (serverBusy || epoch !== actionEpoch) return
  localServers = { server, cluster }
  brewFound = brew
  // An install finished from a terminal is no longer the app's to set up.
  for (const scope of setup.unfinished()) {
    if (installState(localServers, scope) === 'running') setup.forget(scope)
  }
  updateTray()
}

/**
 * Set up, start, stop or restart one of this machine's servers. A start
 * selects it (a restart only when no other server is selected), so a window
 * showing a remote server puts that selection back and stays where it is.
 * A setup lands on the server it made wherever the window was. Otherwise
 * the window reloads the selected server after a start or restart, and
 * moves to the picker after a stop if it was showing that server.
 */
async function serverAction(scoped: ScopedAction): Promise<DesktopServerOutcome> {
  if (serverBusy) return { ok: false, error: 'a server action is already running' }
  const { scope, action } = scoped
  serverBusy = scoped
  actionEpoch++
  updateTray()
  await authDaemonReady
  const remote = action === 'setup' || onConnectPage || await showingLocalServer() ? null : await readServerConfig()
  const outcome = action === 'setup' ? await setup.run(scope) : await runServerAction({ scope, action }, runYaac)
  if (remote) await restoreSelection(remote, serverSwitchDeps)
  serverBusy = null
  await refreshing
  await refreshLocalServer()
  if (!outcome.ok) return outcome
  if (!remote && (action !== 'stop' || await showingLocalServer())) setImmediate(() => void openWindow())
  if (outcome.hostCheckFailures) {
    void dialog.showMessageBox({
      type: 'warning',
      message: 'The server is running, but this Mac cannot run every workspace yet',
      detail: `yaac host check:\n\n${outcome.hostCheckFailures}`,
    })
  }
  return { ok: true }
}

async function trayServerAction(scoped: ScopedAction): Promise<void> {
  const outcome = await serverAction(scoped)
  if (!outcome.ok) dialog.showErrorBox(`Could not ${scoped.action} the server`, outcome.error)
}

async function showingLocalServer(): Promise<boolean> {
  try {
    return isLoopbackOrigin((await resolveTarget()).baseUrl)
  } catch {
    return false
  }
}

function applyAttention(
  waitingCount: number,
  toNotify: WorkspaceListEntry[],
  projects: ProjectSummary[],
): void {
  if (process.platform === 'darwin') app.dock?.setBadge(badgeText(waitingCount))
  if (waiting !== waitingCount) {
    waiting = waitingCount
    updateTray()
  }
  if (!Notification.isSupported()) return
  for (const s of toNotify) {
    const n = new Notification(notificationFor(s, projects))
    n.on('click', () => showWindow())
    n.show()
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
    onSnapshot: (snapshot) => {
      const { waitingCount, toNotify } = attention.update(snapshot)
      applyAttention(waitingCount, toNotify, snapshot.projects)
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
  applyAttention(0, [], [])
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
/**
 * Whether an IPC call comes from a page allowed to drive this Mac's
 * servers: the main window's top frame, showing the picker or one of this
 * Mac's running servers. Checked against the frame's URL when the call
 * arrives, since that is what is showing, and against a read of the
 * installs at most LOCAL_STATE_FRESH_MS old: a server stopped from a
 * terminal frees its port for a forward to take.
 */
async function fromLocalPage(e: IpcMainInvokeEvent): Promise<boolean> {
  if (Date.now() - lastLocalRead > LOCAL_STATE_FRESH_MS) await refreshLocalServer()
  try {
    const frame = e.senderFrame
    return e.sender === win?.webContents && frame?.parent === null && mayControlLocalServers(frame.url, localServers)
  } catch {
    // The frame is gone.
    return false
  }
}
const NOT_LOCAL: DesktopServerOutcome = { ok: false, error: 'only this Mac\'s own pages can drive its servers' }

// Start and stop buttons in the picker and the SPA. The reply comes back
// before the window lands, which replaces the calling page.
ipcMain.handle('server:start-local', async (e, raw: unknown) => {
  if (!await fromLocalPage(e)) return NOT_LOCAL
  const scope = parseScope(raw)
  return scope ? serverAction({ scope, action: 'start' }) : { ok: false, error: 'invalid arguments' }
})
ipcMain.handle('server:stop-local', async (e, raw: unknown) => {
  if (!await fromLocalPage(e)) return NOT_LOCAL
  const scope = parseScope(raw)
  return scope ? serverAction({ scope, action: 'stop' }) : { ok: false, error: 'invalid arguments' }
})
// This Mac's installs and setup, which the picker and the SPA poll. A
// refusal is a rejection, so the SPA leaves its "This Mac" area out.
ipcMain.handle('server:local', async (e) => {
  if (!await fromLocalPage(e)) throw new Error(NOT_LOCAL.error)
  return localState()
})
// A setup runs only once the user confirms it in a native dialog, then in
// the background: the reply comes once it has begun, renderers follow it
// through `server:local`, and it lands the window when it ends.
ipcMain.handle('server:setup', async (e, raw: unknown): Promise<DesktopServerOutcome> => {
  if (!await fromLocalPage(e)) return NOT_LOCAL
  const scope = parseScope(raw)
  if (!scope) return { ok: false, error: 'invalid arguments' }
  if (serverBusy) return { ok: false, error: 'a server action is already running' }
  if (localState().choices[scope].blocked === 'unsupported') return { ok: false, error: 'this Mac cannot run a local cluster' }
  const { message, detail } = setupConfirmation(scope)
  // Cancel is the default: the page chooses when this appears, so a key
  // pressed for something else must not consent.
  const options = { type: 'question' as const, buttons: ['Cancel', 'Set up'], defaultId: 0, cancelId: 0, message, detail }
  const { response } = await (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options))
  if (response !== 1) return { ok: false, error: 'setup not started' }
  if (serverBusy) return { ok: false, error: 'a server action is already running' }
  void serverAction({ scope, action: 'setup' })
  return { ok: true }
})
ipcMain.handle('server:setup-cancel', async (e) => {
  if (!await fromLocalPage(e)) return NOT_LOCAL
  void setup.cancel()
  return { ok: true }
})
// Removal never touches the selected server, so the window stays put.
ipcMain.handle('server:remove', async (_e, raw: unknown) => {
  const sel = parseServerSelection(raw)
  if (!sel) return { ok: false, error: 'invalid selection' }
  return removeServer(sel, serverSwitchDeps)
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

/*
 * A setup's commands run in their own process group, so quitting would
 * leave one running with no reader for its output, to die at whatever
 * point it next writes. Quit asks first, and cancels the setup cleanly.
 */
app.on('before-quit', (e) => {
  if (setup.current()?.phase === 'running' && !quitCancelsSetup) {
    e.preventDefault()
    void dialog.showMessageBox({
      type: 'warning',
      buttons: ['Keep running', 'Cancel setup and quit'],
      defaultId: 0,
      cancelId: 0,
      message: 'A setup is still running',
      detail: 'Quitting cancels it. Run it again later to pick up where it stopped.',
    }).then(async ({ response }) => {
      if (response !== 1) return
      quitCancelsSetup = true
      await setup.cancel()
      app.quit()
    })
    return
  }
  quitting = true
  events?.stop()
  events = null
  authDaemon.stop()
})
