/*
 * Verifies two things about the packaged desktop app and this machine's
 * server (packages/desktop/README.md, "This machine's server"), against a
 * throwaway containerless install:
 *
 *  A. A window showing a REMOTE server stays on it. Tray Start, tray
 *     "Restart this Mac's server to update" (offered after dist/.build-id is
 *     rewritten, as a `brew upgrade` would) and tray Stop each act on this
 *     Mac's server, while server.json's selection and the window stay on
 *     the remote origin.
 *  B. A Finder-style launch (`open`, so launchd's minimal PATH) whose login
 *     shell never runs `brew shellenv` still finds a `yaac` in
 *     /opt/homebrew/bin. First, as a control, with no `yaac` there, the tray
 *     says "No yaac CLI on PATH". Then, with /opt/homebrew/bin/yaac
 *     symlinked to this checkout's dist/cli.js, the tray reads the server
 *     and its Start works (so Homebrew's `node` serves the shebang too). The
 *     symlink is removed afterwards. Skipped if /opt/homebrew/bin/yaac
 *     already exists.
 *
 * REMOTE_URL is a server this device can load, e.g. one on your tailnet
 * (default: the one ~/.yaac-client/server.json selects). It only gets page
 * loads. The tray is driven through System Events, so the terminal running
 * this needs the macOS Accessibility permission.
 *
 * Prerequisites: `pnpm build` and `pnpm desktop:package` at the repo root,
 * and `yaac` on the login-shell PATH being this checkout (`npm install -g .`).
 *
 * Run:
 *   node test-playwright-scripts/desktop-tray-remote-path.js
 *
 * Screenshots: $SCREENSHOT_DIR/remote-*.png (default /tmp/yaac-shots).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, finish, requirePlaywright, SHOTS } from './lib.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP_BUNDLE = path.join(REPO, 'packages/desktop/dist-app/mac-arm64/yaac.app')
const APP = path.join(APP_BUNDLE, 'Contents/MacOS/yaac')
const BUILD_ID_FILE = path.join(REPO, 'dist', '.build-id')
const BREW_YAAC = '/opt/homebrew/bin/yaac'
const REMOTE = process.env.REMOTE_URL
  ?? JSON.parse(fs.readFileSync(path.join(os.homedir(), '.yaac-client/server.json'), 'utf8')).url

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-remote-'))
const ENV = { ...process.env, YAAC_DATA_DIR: DATA_DIR, YAAC_SERVER_PORT: process.env.YAAC_SERVER_PORT ?? '8890' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function yaac(...args) {
  return execFileSync('yaac', args, { env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}
const serverStatus = () => JSON.parse(yaac('server', 'status', '--json'))
const serverJson = () => JSON.parse(fs.readFileSync(`${DATA_DIR}-client/server.json`, 'utf8'))

function osa(script) {
  return spawnSync('osascript', ['-e', script], { encoding: 'utf8' })
}

function trayItems(pid) {
  const r = osa(`tell application "System Events" to tell (first process whose unix id is ${pid})
    click menu bar item 1 of menu bar 2
    delay 0.5
    set names to name of every menu item of menu 1 of menu bar item 1 of menu bar 2
    key code 53
    return names
  end tell`)
  if (r.status !== 0) throw new Error(`osascript: ${r.stderr}`)
  return r.stdout.trim().split(', ').filter((n) => n !== 'missing value')
}

function clickTray(pid, label) {
  const r = osa(`tell application "System Events" to tell (first process whose unix id is ${pid})
    click menu bar item 1 of menu bar 2
    delay 0.5
    click menu item "${label}" of menu 1 of menu bar item 1 of menu bar 2
  end tell`)
  if (r.status !== 0) throw new Error(`osascript: ${r.stderr}`)
}

async function waitFor(what, fn, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs
  for (;;) {
    let last
    try {
      last = await fn()
      if (last) return last
    } catch (err) {
      last = err
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what} (last: ${last})`)
    await sleep(1000)
  }
}

const waitTray = (pid, label, timeoutMs) => waitFor(`tray "${label}"`, () => trayItems(pid).includes(label), timeoutMs)

/** The selection is still the remote, and the loopback origin is saved beside it. */
function selectionKept() {
  const cfg = serverJson()
  return cfg.url === REMOTE && cfg.enabled === true
}

async function partA() {
  yaac('remote', 'set', REMOTE)
  const { _electron: electron } = requirePlaywright()
  const app = await electron.launch({ executablePath: APP, args: [`--user-data-dir=${DATA_DIR}-ui-a`], env: ENV })
  const pid = app.process().pid
  try {
    const win = await app.firstWindow()
    const onRemote = () => win.url().startsWith(REMOTE)
    await waitFor('window on the remote', onRemote)
    await win.screenshot({ path: path.join(SHOTS, 'remote-1-on-remote.png') })

    await waitTray(pid, "Start this Mac's server")
    clickTray(pid, "Start this Mac's server")
    await waitTray(pid, "Stop this Mac's server", 90_000)
    await sleep(2000)
    check('tray Start starts this Mac\'s server', serverStatus().running === true)
    check('after Start, server.json still selects the remote', selectionKept(), JSON.stringify(serverJson()))
    check('after Start, the loopback origin is saved', serverJson().saved.some((s) => s.url.startsWith('http://127.0.0.1:')))
    check('after Start, the window stays on the remote', onRemote(), win.url())

    const newBuildId = crypto.randomBytes(32).toString('hex')
    fs.writeFileSync(BUILD_ID_FILE, `${newBuildId}\n`)
    await waitTray(pid, "Restart this Mac's server to update")
    clickTray(pid, "Restart this Mac's server to update")
    await waitTray(pid, "Stop this Mac's server", 90_000)
    await sleep(2000)
    check('tray Restart runs the new build', serverStatus().serverBuildId === newBuildId)
    check('after Restart, server.json still selects the remote', selectionKept(), JSON.stringify(serverJson()))
    check('after Restart, the window stays on the remote', onRemote(), win.url())

    clickTray(pid, "Stop this Mac's server")
    await waitTray(pid, "Start this Mac's server", 90_000)
    await sleep(2000)
    check('after Stop, the window stays on the remote', onRemote() && selectionKept(), win.url())
    await win.screenshot({ path: path.join(SHOTS, 'remote-2-after-actions.png') })
  } finally {
    await app.close().catch(() => {})
  }
}

/** Launch the bundle through LaunchServices, as Finder does, and return its pid. */
async function finderLaunch(shell, userData) {
  execFileSync('open', ['-n', '-a', APP_BUNDLE,
    '--env', `SHELL=${shell}`, '--env', `YAAC_DATA_DIR=${DATA_DIR}`, '--env', `YAAC_SERVER_PORT=${ENV.YAAC_SERVER_PORT}`,
    '--args', `--user-data-dir=${userData}`])
  return waitFor('the launched app', () => {
    const r = spawnSync('pgrep', ['-n', '-f', `yaac.app/Contents/MacOS/yaac .*--user-data-dir=${userData}`], { encoding: 'utf8' })
    return r.status === 0 ? Number(r.stdout.trim()) : undefined
  })
}

async function quit(pid) {
  clickTray(pid, 'Quit yaac')
  await waitFor('the app to quit', () => spawnSync('kill', ['-0', String(pid)]).status !== 0)
}

async function partB() {
  if (fs.existsSync(BREW_YAAC)) {
    check(`part B skipped: ${BREW_YAAC} already exists`, true)
    return
  }
  // A login shell whose rc sets a PATH with no Homebrew and no nvm in it.
  const shell = path.join(DATA_DIR, 'login-sh')
  fs.writeFileSync(shell, '#!/bin/sh\nPATH=/usr/bin:/bin:/usr/sbin:/sbin\nshift\neval "$1"\n', { mode: 0o755 })

  let pid = await finderLaunch(shell, `${DATA_DIR}-ui-b1`)
  try {
    await waitTray(pid, 'No yaac CLI on PATH')
    check('control: with no yaac in Homebrew\'s bin, the tray finds none', true)
  } finally {
    await quit(pid)
  }

  fs.symlinkSync(path.join(REPO, 'dist/cli.js'), BREW_YAAC)
  try {
    pid = await finderLaunch(shell, `${DATA_DIR}-ui-b2`)
    try {
      await waitTray(pid, "This Mac's server: stopped")
      check('a Finder launch finds yaac in Homebrew\'s bin', true)
      clickTray(pid, "Start this Mac's server")
      await waitTray(pid, "Stop this Mac's server", 90_000)
      check('and its Start runs it under Homebrew\'s node', serverStatus().running === true)
      clickTray(pid, "Stop this Mac's server")
      await waitTray(pid, "Start this Mac's server", 90_000)
    } finally {
      await quit(pid)
    }
  } finally {
    fs.rmSync(BREW_YAAC, { force: true })
  }
}

const originalBuildId = fs.readFileSync(BUILD_ID_FILE, 'utf8')
try {
  await partA()
  fs.writeFileSync(BUILD_ID_FILE, originalBuildId)
  await partB()
} catch (err) {
  check(`unexpected error: ${err.stack ?? err}`, false)
} finally {
  fs.writeFileSync(BUILD_ID_FILE, originalBuildId)
  if (fs.lstatSync(BREW_YAAC, { throwIfNoEntry: false })?.isSymbolicLink()
    && fs.readlinkSync(BREW_YAAC) === path.join(REPO, 'dist/cli.js')) fs.rmSync(BREW_YAAC)
  spawnSync('yaac', ['server', 'stop'], { env: ENV })
  if (!process.env.KEEP_DATA) {
    for (const d of [DATA_DIR, `${DATA_DIR}-client`, `${DATA_DIR}-ui-a`, `${DATA_DIR}-ui-b1`, `${DATA_DIR}-ui-b2`]) {
      fs.rmSync(d, { recursive: true, force: true })
    }
  }
}
finish()
