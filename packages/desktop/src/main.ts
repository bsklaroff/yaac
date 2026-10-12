/**
 * Electron entry point: untested glue over the sibling modules, which hold
 * the logic.
 *
 * The shell is a client of whatever server `server.json` names. Which one
 * is chosen on its own Servers page (servers-page.ts), shown when no server
 * is reachable and opened on request from the SPA or the tray. That page and
 * the tray also set up, start, stop and restart this machine's servers
 * through `brew` and the `yaac` CLI (local-setup.ts, server-control.ts), but
 * only when asked: Close hides to the tray, and Quit exits the shell and its
 * auth daemon and leaves the server running. While running it follows
 * `/events` to show waiting workspaces (dock badge, notifications) and
 * to hold the workspaces' port forwards.
 */
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, screen, shell, systemPreferences, Tray,
  utilityProcess, WebContentsView,
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
import { CLUSTER_SUPPORTED, createSetupRunner, localView, onPath, setupConfirmation } from '#local-setup'
import { appMenuTemplate } from '#menu'
import { splashUrl, type LaunchError } from '#messages'
import { serversPageUrl } from '#servers-page'
import { adoptLoginShellPath, createAuthDaemonRunner, stopLegacyAuthDaemon } from '#server-process'
import {
  createRunYaac, installOrigin, installState, parseScope, readLocalServer, runServerAction, trayServerItems,
  type LocalServers, type ScopedAction, type ServerScope,
} from '#server-control'
import {
  addServerRemote, applyServerSwitch, disconnect, getServerTargets, onTailnet, parseServerSelection, removeServer,
  restoreSelection, serverHealth, type ServerSwitchDeps,
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
/*
 * Set while the window shows the Servers page, with why no server is
 * reachable, or without when it was opened over a server's page.
 * Re-showing an unreachable window re-runs the boot flow, since the user
 * may have fixed things from a terminal.
 */
let serversPage: { error?: LaunchError } | null = null
/*
 * The view the Servers page renders in, laid over the window's own page.
 * Going back to the server the page was opened over removes it, so the
 * SPA underneath never reloads.
 */
let pageView: { view: WebContentsView, close: () => void } | null = null
// This machine's servers as the tray last read them, and the action under way.
let localServers: LocalServers = { server: null, cluster: null }
let brewFound = false
let serverBusy: ScopedAction | null = null
let refreshing: Promise<void> | null = null
// The tray menu as last built, so a change that leaves it alone keeps it open.
let trayMenuKey = ''
/** Counts server actions, so a status read can tell one overlapped it. */
let actionEpoch = 0
/** The Servers page's calls still awaiting a reply, other than its reads. */
let pageCallsInFlight = 0

const resolveTarget = resolveServerTarget

const distDir = path.dirname(fileURLToPath(import.meta.url))
const PRELOAD = path.join(distDir, 'preload.cjs')
const authDaemonReady = Promise.all([adoptLoginShellPath(), stopLegacyAuthDaemon()])
const authDaemon = createAuthDaemonRunner((baseUrl) => utilityProcess.fork(
  path.join(distDir, 'auth-daemon.js'), [baseUrl], { serviceName: 'yaac auth daemon' },
))
const runYaac = createRunYaac()
const setup = createSetupRunner(() => updateTray(), path.join(app.getPath('userData'), 'unfinished-setups.json'))
// A `brew upgrade` or a server started from a terminal shows up within this.
const LOCAL_SERVER_POLL_MS = 60_000

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
      preload: PRELOAD,
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
  w.on('closed', () => {
    nativeTheme.removeListener('updated', onThemeChange)
    pageView?.close()
  })
  // target="_blank" links open in the system browser.
  w.webContents.setWindowOpenHandler(openInBrowser)
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

function openInBrowser({ url }: { url: string }): { action: 'deny' } {
  if (/^https?:/.test(url)) void shell.openExternal(url)
  return { action: 'deny' }
}

/**
 * The Servers page's view over `w`, added if it is not there yet. It has
 * the window's preload, and every link it follows opens in the browser.
 */
function showPageView(w: BrowserWindow): WebContentsView {
  if (pageView) return pageView.view
  const view = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: PRELOAD },
  })
  view.setBackgroundColor(backgroundColorFor(nativeTheme.shouldUseDarkColors))
  const fit = (): void => {
    const { width, height } = w.getContentBounds()
    view.setBounds({ x: 0, y: 0, width, height })
  }
  fit()
  w.contentView.on('bounds-changed', fit)
  view.webContents.setWindowOpenHandler(openInBrowser)
  view.webContents.on('will-navigate', (e, url) => {
    e.preventDefault()
    openInBrowser({ url })
  })
  w.contentView.addChildView(view)
  view.webContents.focus()
  pageView = {
    view,
    close: () => {
      pageView = null
      if (!w.isDestroyed()) {
        w.contentView.removeListener('bounds-changed', fit)
        w.contentView.removeChildView(view)
        w.webContents.focus()
      }
      view.webContents.close()
    },
  }
  return view
}

/**
 * Run the boot flow and load the server's origin, or the Servers page when
 * no server will accept this device. Returns whether a server was loaded.
 * Leaving the Servers page for the server it was opened over only closes
 * the page, uncovering that server's page with its events still running.
 * While the Servers page shows, the flow's progress goes to the page's own
 * status line rather than a splash, which would replace the covered page.
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
      if (!pageView) void w.loadURL(splashUrl(text)).catch(() => { /* superseded by the next load */ })
    },
    rendererBaseUrl: env.desktopRendererUrl,
  })
  if (!result.ok) {
    await showUnreachable(w, result.error)
    return false
  }
  const back = serversPage !== null && !serversPage.error && isSameOriginNavigation(w.webContents.getURL(), result.url)
  try {
    if (!back) await w.loadURL(result.url)
    serversPage = null
    pageView?.close()
    // Started only once a server is reachable, so the Servers page doesn't
    // spin a reconnect loop.
    if (!back) startEvents()
    // A landing often follows a start from a terminal; read it now, so the
    // Servers page opens on current state.
    void refreshLocalServer()
    return true
  } catch (err) {
    dialog.showErrorBox('Could not open yaac', err instanceof Error ? err.message : String(err))
    return false
  }
}

/**
 * Show the Servers page because no server is reachable. Events, forwards
 * and the badge are cleared first, and the page it covers emptied, so
 * nothing claims state from a server the shell cannot reach.
 */
async function showUnreachable(w: BrowserWindow, error: LaunchError): Promise<void> {
  serversPage = { error }
  events?.stop()
  events = null
  forwarder?.stop()
  forwarder = null
  attention = new AttentionMonitor()
  applyAttention(0, [], [])
  await renderServersPage(w)
  if (!w.webContents.getURL().startsWith('data:')) {
    await w.loadURL(splashUrl('')).catch(() => { /* superseded by the next load */ })
  }
}

/**
 * Open the Servers page on request, from the SPA or the tray, with one
 * setup opened if `setup` names it. The page stays until the user goes back
 * or picks a server; events and forwards for the selected server keep
 * running underneath.
 */
async function openServersPage(setup?: ServerScope): Promise<void> {
  if (!win || win.isDestroyed()) win = await createWindow()
  win.show()
  win.focus()
  serversPage ??= {}
  await renderServersPage(win, setup)
}

/**
 * Render the Servers page afresh. It renders from the last read of this
 * Mac's installs, so it shows at once even though a read runs the CLI
 * twice, then reads them again in the background and renders once more if
 * that, or whether Tailscale is up, changed while the page still shows. It
 * leaves alone a page with a call or server action under way, since the
 * reply to it, an error included, goes to the page that made it; the action
 * itself moves the window or renders the page again when it ends. Only
 * before the first read is there nothing to render from, so that one is
 * waited for. A page the window has left by the time the reads return,
 * as when a start lands it meanwhile, is not shown.
 */
async function renderServersPage(w: BrowserWindow, setup?: ServerScope): Promise<void> {
  const page = serversPage
  const machine = (): { local: DesktopLocalState, tailnet: boolean } => ({ local: localState(), tailnet: serverSwitchDeps.tailnetUp() })
  const load = async (): Promise<string> => {
    const shown = machine()
    const targets = await getServerTargets(serverSwitchDeps)
    if (serversPage !== page) return ''
    await showPageView(w).webContents.loadURL(serversPageUrl({ error: page?.error, targets, setup, ...shown }))
      .catch(() => { /* superseded by the next load */ })
    return JSON.stringify(shown)
  }
  if (!localServers.server && !localServers.cluster) await refreshLocalServer()
  const shown = await load()
  void refreshLocalServer().then(async () => {
    const still = serversPage === page && pageView !== null
    const idle = !serverBusy && pageCallsInFlight === 0
    if (still && idle && JSON.stringify(machine()) !== shown) await load()
  })
}

function showWindow(): void {
  if (win && !win.isDestroyed()) {
    win.show()
    win.focus()
    // The user may have started a server since the page was shown.
    if (serversPage?.error) void openWindow()
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
  const key = JSON.stringify(items)
  if (key === trayMenuKey) return
  trayMenuKey = key
  const serverItems = items.map((item) => ({
    label: item.label,
    enabled: item.action !== undefined,
    click: () => {
      const action = item.action
      if (action?.action === 'setup') void openServersPage(action.scope)
      else if (action) void trayServerAction(action)
    },
  }))
  const menu = Menu.buildFromTemplate([
    { label: 'Servers…', click: () => void openServersPage() },
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
 * A setup, and a start or restart from the Servers page, lands on the
 * server it selects; otherwise the window reloads the selected server
 * after a start or restart. Stopping the selected server disconnects the
 * window, which moves to the Servers page; any other stop leaves the window
 * where it is, rendering the page again if it shows.
 */
async function serverAction(scoped: ScopedAction): Promise<DesktopServerOutcome> {
  if (serverBusy) return { ok: false, error: 'a server action is already running' }
  const { scope, action } = scoped
  serverBusy = scoped
  actionEpoch++
  updateTray()
  const origin = installOrigin(localServers, scope)
  await authDaemonReady
  const remote = action === 'setup' || serversPage || await showingLocalServer() ? null : await readServerConfig()
  const outcome = action === 'setup' ? await setup.run(scope) : await runServerAction({ scope, action }, runYaac)
  if (remote) await restoreSelection(remote, serverSwitchDeps)
  serverBusy = null
  await refreshing
  await refreshLocalServer()
  if (!outcome.ok) return outcome
  if (action === 'stop') {
    const cfg = await readServerConfig()
    if (cfg && cfg.url === origin) setImmediate(() => void openWindow())
    else if (serversPage) setImmediate(() => void openServersPage())
  } else if (!remote) setImmediate(() => void openWindow())
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
  forwarder = startForwarder({
    resolveTarget,
    onRemaps: (remaps) => { if (win && !win.isDestroyed()) win.webContents.send('forward:remaps', remaps) },
  })
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
 * the boot flow to load the new origin (or the Servers page if it fails).
 */
function relandOnNewServer(): void {
  attention = new AttentionMonitor()
  applyAttention(0, [], [])
  void openWindow()
}

// The Servers page's IPC. Handlers reply before relanding, which destroys
// the calling page.
const serverSwitchDeps: ServerSwitchDeps = {
  readServerConfig,
  writeServerConfig,
  select: withServerSelected,
  probeServer,
  normalizeUrl: normalizeServerUrl,
  tailnetUp: () => onTailnet(networkInterfaces()),
}

/**
 * Answer `channel` for the Servers page alone: the top frame of its view
 * showing a `data:` page, which only the shell loads, since the view
 * follows no navigation. No server's page may
 * switch servers or drive this Mac's, so a remote server cannot move the
 * machine onto one it chooses, nor a port forwarded onto loopback pass for
 * one of this Mac's servers. Calls other than `reads` count as in flight
 * until they reply (`renderServersPage`).
 */
function handleFromServersPage<T>(
  channel: string, listener: (raw: unknown) => Promise<T>, opts: { reads?: boolean } = {},
): void {
  ipcMain.handle(channel, (e, raw: unknown) => {
    let fromPage = false
    try {
      const frame = e.senderFrame
      fromPage = e.sender === pageView?.view.webContents && frame?.parent === null && frame.url.startsWith('data:')
    } catch {
      // The frame is gone.
    }
    if (!fromPage) throw new Error('only the Servers page can change servers')
    if (opts.reads) return listener(raw)
    pageCallsInFlight++
    return listener(raw).finally(() => { pageCallsInFlight-- })
  })
}

// "Try again", or "Back" over a server. A failure renders the page afresh.
handleFromServersPage('server:retry', async (): Promise<DesktopServerOutcome> => {
  const ok = await openWindow()
  return ok ? { ok: true } : { ok: false, error: 'still no server' }
})
handleFromServersPage('server:switch', async (raw): Promise<DesktopServerOutcome> => {
  const sel = parseServerSelection(raw)
  if (!sel) return { ok: false, error: 'invalid selection' }
  const outcome = await applyServerSwitch(sel, serverSwitchDeps)
  if (outcome.ok) setImmediate(() => relandOnNewServer())
  return outcome
})
handleFromServersPage('server:add-remote', async (url): Promise<DesktopServerOutcome> => {
  if (typeof url !== 'string') return { ok: false, error: 'invalid arguments' }
  const outcome = await addServerRemote(url, serverSwitchDeps)
  if (outcome.ok) setImmediate(() => relandOnNewServer())
  return outcome
})
// Leaves the machine with no server, so the window lands on this page again.
handleFromServersPage('server:disconnect', async (): Promise<DesktopServerOutcome> => {
  const outcome = await disconnect(serverSwitchDeps)
  if (outcome.ok) setImmediate(() => relandOnNewServer())
  return outcome
})
// Removal never touches the selected server, so the page renders again.
handleFromServersPage('server:remove', async (raw): Promise<DesktopServerOutcome> => {
  const sel = parseServerSelection(raw)
  if (!sel) return { ok: false, error: 'invalid selection' }
  const options = {
    type: 'question' as const, buttons: ['Cancel', 'Remove'], defaultId: 0, cancelId: 0,
    message: `Remove ${sel.url}?`,
    detail: 'It leaves this machine\'s server list, for the app and the yaac CLI alike. The server itself keeps '
      + 'running; add it again to reconnect.',
  }
  const { response } = await (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options))
  const outcome = response === 1 ? await removeServer(sel, serverSwitchDeps) : { ok: true as const }
  if (outcome.ok) setImmediate(() => void openServersPage())
  return outcome
})
// Start and stop buttons. The reply comes back before the window moves on.
handleFromServersPage('server:start-local', async (raw): Promise<DesktopServerOutcome> => {
  const scope = parseScope(raw)
  return scope ? serverAction({ scope, action: 'start' }) : { ok: false, error: 'invalid arguments' }
})
handleFromServersPage('server:stop-local', async (raw): Promise<DesktopServerOutcome> => {
  const scope = parseScope(raw)
  return scope ? serverAction({ scope, action: 'stop' }) : { ok: false, error: 'invalid arguments' }
})
// Which saved servers are down or refuse this device, asked once as the page loads.
handleFromServersPage('server:health', () => serverHealth(serverSwitchDeps), { reads: true })
// This Mac's installs and setup, which the page polls.
handleFromServersPage('server:local', () => Promise.resolve(localState()), { reads: true })
// A setup runs only once the user confirms it in a native dialog, then in
// the background: the reply comes once it has begun, the page follows it
// through `server:local`, and it lands the window when it ends.
handleFromServersPage('server:setup', async (raw): Promise<DesktopServerOutcome> => {
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
handleFromServersPage('server:setup-cancel', (): Promise<DesktopServerOutcome> => {
  void setup.cancel()
  return Promise.resolve({ ok: true })
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
// The SPA's Servers button and server badge, which can only be clicked in
// a focused window, so a page cannot use it to raise a hidden one.
ipcMain.on('window:show-servers', (e) => {
  if (e.sender === win?.webContents && win.isFocused()) void openServersPage()
})
ipcMain.on('window:open-external', (_e, url: unknown) => {
  if (typeof url === 'string' && /^https?:/.test(url)) void shell.openExternal(url)
})
// The forwards bound at a local port other than the one the server offers,
// for the SPA's preview pane (forwarder.ts). Updates arrive on the same
// channel.
ipcMain.handle('forward:remaps', () => forwarder?.remaps() ?? [])

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
  // A failed boot still shows the Servers page, so the shell keeps running.
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
