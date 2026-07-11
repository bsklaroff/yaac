import path from 'node:path'
import { existsSync } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { app, BrowserWindow, Tray, Menu, Notification, nativeImage, nativeTheme, screen } from 'electron'
import WebSocket from 'ws'
import { readLock, isLockLive, type DaemonLock } from '@/shared/lock'
import { readBuildId } from '@/shared/build-id'
import {
  ensureDaemonRunning,
  resolveDaemonStartCommand,
  type DaemonStartContext,
} from '@/electron/supervisor'
import { fetchBootstrapCode, buildAuthedRendererUrl } from '@/electron/auth'
import { parseNulEnv } from '@/electron/shell-env'
import {
  AttentionMonitor,
  parseSnapshotMessage,
  badgeText,
  notificationFor,
  type WaitingSession,
} from '@/electron/attention'
import { buildTrayBitmap } from '@/electron/tray-icon'
import { appMenuTemplate } from '@/electron/menu'
import { backgroundColorFor } from '@/electron/theme-bg'
import { readWindowState, saveWindowState, boundsVisibleOn } from '@/electron/window-state'
import { env } from '@/shared/env'

/**
 * yaac desktop — Phase 1 (see plans/electron-app.md).
 *
 * A thin persistent shell: supervise the daemon, load the webapp with auth
 * wired internally, and add the native attention signals a browser tab can't —
 * a tray, a dock badge, and OS notifications for sessions that go "waiting".
 * Closing the window hides to the tray (the daemon keeps running); an explicit
 * quit stops the daemon. Substantive logic lives in the sibling modules
 * (supervisor / auth / attention / tray-icon) so it stays headless-testable;
 * this file is the Electron + child-process wiring.
 */

let win: BrowserWindow | null = null
let tray: Tray | null = null
let daemonLock: DaemonLock | null = null
let quitting = false
let eventsStop = false
const monitor = new AttentionMonitor()
// Attach mode reuses a running daemon without owning it: never start/restart,
// never stop it on quit. Set by YAAC_ELECTRON_ATTACH.
const attach = env.electronAttach

// A dev run (YAAC_ELECTRON_DEV, set by scripts/dev-app.sh) isolates its
// Electron storage + identity from an installed build so both can run side by
// side — paired with the isolated data dir + namespace the dev script sets.
// Must run before the app is ready.
if (env.electronDev) {
  app.setName('yaac (dev)')
  app.setPath('userData', path.join(app.getPath('appData'), 'yaac-dev'))
} else {
  // Ensure the app menu reads "yaac" (not "Electron") even in an unpacked run.
  app.setName('yaac')
}

// --- daemon environment + spawning -----------------------------------------

/**
 * The daemon shells out to kubectl/podman/kind/tmux/brew. A Finder-launched
 * app inherits a minimal PATH, so hydrate it from the user's login shell
 * before spawning anything. Dev launches inherit the terminal PATH, so this
 * only runs in the packaged app. Best-effort: on failure we keep the
 * inherited env and let a missing-binary error surface downstream.
 */
function hydratedDaemonEnv(): NodeJS.ProcessEnv {
  // eslint-disable-next-line no-process-env -- forwarded wholesale to the daemon child, not yaac config
  const base = { ...process.env }
  if (!app.isPackaged) return base
  try {
    // eslint-disable-next-line no-process-env -- SHELL is the OS login shell, not a yaac knob
    const shell = process.env.SHELL ?? '/bin/zsh'
    const dump = execFileSync(shell, ['-lic', 'env -0'], { encoding: 'utf8' })
    const hydrated = parseNulEnv(dump)
    if (hydrated.PATH) base.PATH = hydrated.PATH
  } catch {
    // keep the inherited env
  }
  return base
}

function daemonContext(): DaemonStartContext {
  const repoRoot = process.cwd()
  const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  return {
    override: env.electronDaemonCmd,
    bundled: app.isPackaged,
    execPath: process.execPath,
    // Packaged layout (electron-builder.yml): the daemon + its production
    // node_modules ship unpacked under Resources/daemon, and a standalone
    // Node under Resources/node.
    bundledCliEntry: path.join(process.resourcesPath, 'daemon', 'dist', 'cli.js'),
    nodeRuntime: path.join(process.resourcesPath, 'node', 'node'),
    tsxCli: existsSync(tsxCli) ? tsxCli : null,
    devCliEntry: path.join(repoRoot, 'src', 'cli.ts'),
    nodeBin: env.electronNodeBin,
  }
}

const daemonEnv = hydratedDaemonEnv()

/**
 * Run `yaac daemon <mode>` and resolve once it exits 0. `daemon start` is
 * itself short-lived — it spawns the detached `daemon run` and returns — so
 * awaiting its exit is the right signal.
 */
function runDaemonStart(mode: 'start' | 'restart'): Promise<void> {
  const cmd = resolveDaemonStartCommand(mode, daemonContext())
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd.bin, cmd.args, {
      stdio: 'inherit',
      env: { ...daemonEnv, ...cmd.extraEnv },
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`daemon ${mode} exited with code ${String(code)}`))
    })
  })
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitForLiveLock(timeoutMs: number): Promise<DaemonLock> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const lock = await readLock()
    if (lock && await isLockLive(lock)) return lock
    await delay(100)
  }
  throw new Error('daemon did not become ready in time')
}

function rendererBase(port: number): string {
  return env.electronRendererUrl ?? `http://127.0.0.1:${port}/`
}

/**
 * The build id the app compares against the daemon's lock. Packaged, the app's
 * own PACKAGE_ROOT (Resources/app) has no `.build-id` — read the bundled
 * daemon's instead, which is exactly what its spawned daemon reports, so the
 * reuse/restart decision is consistent. In dev, the default (repo root /
 * YAAC_BUILD_ID) applies.
 */
function readAppBuildId(): Promise<string> {
  return app.isPackaged
    ? readBuildId(path.join(process.resourcesPath, 'daemon', 'dist'))
    : readBuildId()
}

// --- window -----------------------------------------------------------------

async function createWindow(url: string): Promise<void> {
  // Restore the last window bounds, unless they'd land off every display (a
  // monitor was unplugged) — then fall back to default, centered.
  const stateFile = path.join(app.getPath('userData'), 'window-state.json')
  const saved = await readWindowState(stateFile)
  const displays = screen.getAllDisplays().map((d) => d.workArea)
  const restore = saved && boundsVisibleOn(saved, displays) ? saved : null

  win = new BrowserWindow({
    width: restore?.width ?? 1280,
    height: restore?.height ?? 860,
    x: restore?.x,
    y: restore?.y,
    minWidth: 880,
    minHeight: 560,
    show: false,
    // Match the OS appearance so a light-mode window doesn't flash the dark
    // shell at the edges during a resize. Kept in sync below.
    backgroundColor: backgroundColorFor(nativeTheme.shouldUseDarkColors),
    // Modern macOS chrome: hide the title bar and let the traffic lights float
    // over the UI. The webapp reserves a draggable top strip for them when it
    // detects Electron (src/frontend/App.tsx + .titlebar-drag).
    titleBarStyle: 'hiddenInset',
    // Centered on the rail region (x0–72) so the lights line up with the chips
    // below them, which are centered in that same region.
    trafficLightPosition: { x: 14, y: 7 },
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })
  // Reveal only once the renderer has painted — no empty flash on open.
  win.once('ready-to-show', () => win?.show())
  // Follow live OS light/dark switches (System mode) for the native backing.
  const onThemeChange = (): void => win?.setBackgroundColor(backgroundColorFor(nativeTheme.shouldUseDarkColors))
  nativeTheme.on('updated', onThemeChange)
  win.on('closed', () => nativeTheme.removeListener('updated', onThemeChange))
  win.on('close', (e) => {
    // Persist bounds on every close (fires on hide-to-tray and on quit).
    if (win) void saveWindowState(stateFile, win.getBounds())
    // Close hides to the tray; the daemon keeps running and notifications keep
    // firing. A real quit sets `quitting` (tray Quit / Cmd-Q → before-quit).
    if (!quitting) {
      e.preventDefault()
      win?.hide()
    }
  })
  win.on('closed', () => { win = null })
  void win.loadURL(url)
}

/**
 * Show the window, recreating it if it was destroyed. Recreation needs a fresh
 * bootstrap code because the previous one was single-use.
 */
async function showWindow(): Promise<void> {
  if (win) {
    win.show()
    win.focus()
    return
  }
  if (!daemonLock) return
  const code = await fetchBootstrapCode(daemonLock.port, daemonLock.secret)
  await createWindow(buildAuthedRendererUrl(rendererBase(daemonLock.port), code))
}

// --- tray + attention -------------------------------------------------------

function createTray(): void {
  const { data, width, height } = buildTrayBitmap(36)
  const icon = nativeImage.createFromBitmap(data, { width, height, scaleFactor: 2 })
  icon.setTemplateImage(true)
  tray = new Tray(icon)
  tray.on('click', () => void showWindow())
  updateTray(0)
}

function updateTray(waitingCount: number): void {
  if (!tray) return
  const status = waitingCount > 0 ? `${waitingCount} waiting for input` : 'No sessions waiting'
  tray.setToolTip(waitingCount > 0 ? `yaac — ${waitingCount} waiting` : 'yaac')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open yaac', click: () => void showWindow() },
    { type: 'separator' },
    { label: status, enabled: false },
    { type: 'separator' },
    { label: 'Quit yaac', click: () => app.quit() },
  ]))
}

function applyAttention(waitingCount: number, toNotify: WaitingSession[]): void {
  if (process.platform === 'darwin') app.dock?.setBadge(badgeText(waitingCount))
  updateTray(waitingCount)
  if (Notification.isSupported()) {
    for (const s of toNotify) {
      const { title, body } = notificationFor(s)
      const n = new Notification({ title, body })
      n.on('click', () => void showWindow())
      n.show()
    }
  }
}

/**
 * Subscribe the main process to the daemon's `/events` stream (bearer auth
 * from the lock) so the badge + notifications update even with the window
 * closed. Reconnects on drop until quit.
 */
function startEventsMonitor(lock: DaemonLock): void {
  const open = (): void => {
    const ws = new WebSocket(`ws://127.0.0.1:${lock.port}/events`, {
      headers: { authorization: `Bearer ${lock.secret}` },
    })
    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8')
      const snap = parseSnapshotMessage(text)
      if (!snap) return
      const { waitingCount, toNotify } = monitor.update(snap)
      applyAttention(waitingCount, toNotify)
    })
    ws.on('close', () => { if (!eventsStop) setTimeout(open, 1500) })
    ws.on('error', () => { /* the close handler schedules a reconnect */ })
  }
  open()
}

// --- lifecycle --------------------------------------------------------------

async function boot(): Promise<void> {
  daemonLock = await ensureDaemonRunning({
    readBuildId: readAppBuildId,
    readLock,
    isLockLive,
    runDaemonStart,
    waitForLiveLock,
    allowStart: !attach,
    log: (m) => console.log(m),
  })
  createTray()
  startEventsMonitor(daemonLock)
  const code = await fetchBootstrapCode(daemonLock.port, daemonLock.secret)
  await createWindow(buildAuthedRendererUrl(rendererBase(daemonLock.port), code))
}

void app.whenReady().then(() => {
  // Proper macOS menu (yaac app menu + Edit menu for terminal copy/paste).
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate()))
  return boot()
}).catch((err: unknown) => {
  console.error('[electron] failed to start:', err)
})

// Reopen from the dock (macOS) or a second launch.
app.on('activate', () => void showWindow())

// Do NOT quit when the window closes — stay alive in the tray so the daemon
// keeps running and attention signals keep firing.
app.on('window-all-closed', () => { /* intentionally no quit */ })

// An explicit quit (tray Quit / Cmd-Q) stops the daemon. Agent sessions are
// Kubernetes Jobs, so they survive — they just stop being watched until the
// app reopens.
app.on('before-quit', () => {
  quitting = true
  eventsStop = true
  // Attach mode never owns the daemon, so it leaves it running on quit.
  if (!attach && daemonLock) {
    try {
      process.kill(daemonLock.pid, 'SIGTERM')
    } catch {
      // already gone
    }
  }
})
