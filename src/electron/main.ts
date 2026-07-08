import path from 'node:path'
import { existsSync } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { app, BrowserWindow } from 'electron'
import { readLock, isLockLive, type DaemonLock } from '@/shared/lock'
import { readBuildId } from '@/shared/build-id'
import {
  ensureDaemonRunning,
  resolveDaemonStartCommand,
  type DaemonStartContext,
} from '@/electron/supervisor'
import { fetchBootstrapCode, buildAuthedRendererUrl } from '@/electron/auth'
import { parseNulEnv } from '@/electron/shell-env'
import { env } from '@/shared/env'

/**
 * yaac desktop — Phase 0 spike (see plans/electron-app.md).
 *
 * A thin shell: ensure the daemon is running, auto-authenticate, and load
 * the existing webapp in a native window. Tray, notifications, and packaging
 * are later phases. All substantive logic lives in the sibling modules
 * (supervisor / auth / shell-env) so it stays headless-unit-testable; this
 * file is just the wiring that needs the Electron + child-process runtime.
 */

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
    // Packaged layout is finalized in Phase 3; this is the conventional
    // electron-builder resources location for the bundled CLI.
    bundledCliEntry: path.join(process.resourcesPath, 'app', 'dist', 'cli.js'),
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

async function boot(): Promise<void> {
  const lock = await ensureDaemonRunning({
    readBuildId,
    readLock,
    isLockLive,
    runDaemonStart,
    waitForLiveLock,
    log: (m) => console.log(m),
  })
  const code = await fetchBootstrapCode(lock.port, lock.secret)
  const url = buildAuthedRendererUrl(rendererBase(lock.port), code)

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: '#0b0b0d',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  await win.loadURL(url)
}

void app.whenReady().then(boot).catch((err: unknown) => {
  console.error('[electron] failed to start:', err)
})

// Phase 1 replaces this with a tray + close-to-tray (the daemon stays a
// persistent background service). For the spike, quit when the window closes.
app.on('window-all-closed', () => {
  app.quit()
})
