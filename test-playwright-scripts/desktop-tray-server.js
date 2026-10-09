/*
 * Verifies that the desktop app starts, stops and restarts this machine's
 * server (packages/desktop/README.md, "This machine's server"), against a
 * packaged build and a throwaway containerless install:
 *
 *  1. With no server, the picker offers "Start a server on this Mac" and the
 *     tray says "This Mac's server: stopped". Clicking Start lands the window on the new
 *     server, and the tray then offers Stop.
 *  2. A workspace is created (its agent is a fake `claude` that sleeps, as in
 *     test/e2e-containerless/workspace-suite.test.ts) and shows in the SPA.
 *  3. Tray Stop stops the server and the window falls back to the picker,
 *     while the workspace's agent process keeps running.
 *  4. Tray Start brings the server back, the window lands, and the workspace
 *     is listed as running again.
 *  5. A new build of the CLI (dist/.build-id rewritten, which is what
 *     `pnpm build` or `brew upgrade` changes) makes the tray offer "Restart
 *     this Mac's server to update", and after it the server runs the new build.
 *  6. Quitting the app leaves the server running.
 *
 * The tray is driven through System Events, so the terminal running this
 * needs the macOS Accessibility permission. The app runs the `yaac` on the
 * login-shell PATH, which must be this checkout (`npm install -g .`).
 *
 * Prerequisites: `pnpm build` and `pnpm desktop:package` at the repo root.
 *
 * Run:
 *   node test-playwright-scripts/desktop-tray-server.js
 *
 * Screenshots: $SCREENSHOT_DIR/tray-*.png (default /tmp/yaac-shots).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, finish, requirePlaywright, SHOTS } from './lib.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP = process.env.YAAC_APP
  ?? path.join(REPO, 'packages/desktop/dist-app/mac-arm64/yaac.app/Contents/MacOS/yaac')
const BUILD_ID_FILE = path.join(REPO, 'dist', '.build-id')

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-tray-'))
const ENV = {
  ...process.env,
  YAAC_DATA_DIR: DATA_DIR,
  YAAC_SERVER_PORT: process.env.YAAC_SERVER_PORT ?? '8890',
  // Create returns instead of attaching, and the fake remote is never fetched.
  YAAC_E2E_NO_ATTACH: '1',
  YAAC_E2E_SKIP_FETCH: '1',
}
const AGENT_PID_FILE = path.join(DATA_DIR, 'agent.pid')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function yaac(...args) {
  return execFileSync('yaac', args, { env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function serverStatus() {
  return JSON.parse(yaac('server', 'status', '--json'))
}

function origin() {
  return JSON.parse(fs.readFileSync(`${DATA_DIR}-client/server.json`, 'utf8')).url
}

async function api(route, init = {}) {
  const res = await fetch(`${origin()}/api${route}`, {
    ...init, headers: { 'content-type': 'application/json' },
  })
  if (!res.ok) throw new Error(`${route}: HTTP ${res.status} ${await res.text()}`)
  return res.json()
}

/** Where yaac keeps a pinned agent and a project's files, from shared's own path helpers. */
function internalPaths(projectId) {
  const code = 'import {AGENT_PACKAGES, agentPackagePrefix} from "@yaac/shared/tool-install";'
    + 'import {repoDir, claudeDir} from "@yaac/shared/project-paths";'
    + `console.log(JSON.stringify({ bin: agentPackagePrefix(AGENT_PACKAGES.claude),`
    + ` repo: repoDir(${JSON.stringify(projectId)}), claude: claudeDir(${JSON.stringify(projectId)}) }))`
  const cwd = path.join(REPO, 'packages/test-utils')
  return JSON.parse(execFileSync(path.join(cwd, 'node_modules/.bin/tsx'), ['-e', code], { cwd, env: ENV, encoding: 'utf8' }))
}

function osa(script) {
  return spawnSync('osascript', ['-e', script], { encoding: 'utf8' })
}

/** The tray menu's labels. Opening the menu also refreshes it for the next opening. */
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

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A project from a local repo, registered as the e2e suites do, with a fake claude. */
async function addProject() {
  const id = crypto.randomUUID()
  const paths = internalPaths(id)
  const src = path.join(DATA_DIR, 'src')
  fs.mkdirSync(src)
  for (const args of [['init', '-q'], ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']]) {
    execFileSync('git', args, { cwd: src })
  }
  fs.mkdirSync(path.dirname(paths.repo), { recursive: true })
  execFileSync('git', ['clone', '-q', src, paths.repo])
  fs.mkdirSync(paths.claude, { recursive: true })
  await api('/project/register', { method: 'POST', body: JSON.stringify({ id, name: 'tray-demo', remoteUrl: 'https://github.com/test/tray-demo.git' }) })
  const { id: credentialId } = await api('/auth/git/credentials', { method: 'POST', body: JSON.stringify({ name: 'tray token', token: 'ghp_tray_test' }) })
  await api(`/project/${id}/git-credential`, { method: 'PUT', body: JSON.stringify({ credentialId }) })
  yaac('auth', 'fake', 'claude-oauth')
  const bin = path.join(paths.bin, 'bin', 'claude')
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  fs.writeFileSync(bin, `#!/bin/sh\necho $$ > '${AGENT_PID_FILE}'\nexec sleep 2147483647\n`, { mode: 0o755 })
}

const originalBuildId = fs.readFileSync(BUILD_ID_FILE, 'utf8')
const { _electron: electron } = requirePlaywright()
const app = await electron.launch({ executablePath: APP, args: [`--user-data-dir=${DATA_DIR}-ui`], env: ENV })
const pid = app.process().pid
let workspaceId
try {
  const win = await app.firstWindow()
  const shot = (name) => win.screenshot({ path: path.join(SHOTS, `tray-${name}.png`) })

  // 1. First run: the picker and the tray both offer a start.
  await win.waitForSelector('#start-local', { timeout: 30_000 })
  await shot('1-first-run')
  check('picker offers Start a server on this Mac', true)
  await waitTray(pid, "Start this Mac's server")
  check('tray says the server is stopped', trayItems(pid).includes("This Mac's server: stopped"))
  await win.click('#start-local')
  await waitFor('window on the server', () => win.url().startsWith('http://127.0.0.1:'))
  await shot('1-landed')
  check('Start lands the window on the new server', serverStatus().running === true)
  await waitTray(pid, "Stop this Mac's server")
  check('tray then offers Stop', true)

  // 2. A workspace, shown in the SPA.
  await addProject()
  yaac('workspace', 'create', 'tray-demo', '--tool', 'claude', '--mode', 'tui')
  workspaceId = await waitFor('the workspace running', () => {
    const line = yaac('workspace', 'list').split('\n').find((l) => l.includes('tray-demo'))
    return line && fs.existsSync(AGENT_PID_FILE) ? line.trim().split(/\s+/)[0] : undefined
  })
  const agentPid = Number(fs.readFileSync(AGENT_PID_FILE, 'utf8'))
  await win.reload()
  await waitFor('the workspace in the SPA', async () => (await win.content()).includes('tray-demo'))
  await shot('2-workspace')
  check(`workspace ${workspaceId} runs, agent pid ${agentPid}`, alive(agentPid))

  // 3. Tray Stop: the server goes, the agent stays, the window shows the picker.
  clickTray(pid, "Stop this Mac's server")
  await waitFor('the picker', () => win.url().startsWith('data:'))
  await win.waitForSelector('#start-local')
  await shot('3-stopped')
  check('Stop stops the server', serverStatus().running === false)
  check('the agent survives the stop', alive(agentPid))
  await waitTray(pid, "Start this Mac's server")

  // 4. Tray Start: the server and the workspace come back.
  clickTray(pid, "Start this Mac's server")
  await waitFor('window on the server', () => win.url().startsWith('http://127.0.0.1:'))
  await waitFor('the workspace listed again', () => yaac('workspace', 'list').includes(workspaceId))
  await waitFor('the workspace in the SPA', async () => (await win.content()).includes('tray-demo'))
  await shot('4-restarted')
  check('Start brings the workspace back, same agent', alive(agentPid) && serverStatus().running === true)

  // 5. A newer CLI build: the tray offers a restart that runs it.
  const newBuildId = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(BUILD_ID_FILE, `${newBuildId}\n`)
  await waitTray(pid, "Restart this Mac's server to update")
  check('tray offers a restart to update', trayItems(pid).includes("This Mac's server: running an older build"))
  clickTray(pid, "Restart this Mac's server to update")
  await waitTray(pid, "Stop this Mac's server", 90_000)
  check('the restarted server runs the new build', serverStatus().serverBuildId === newBuildId)

  // 6. Quit leaves the server running.
  await app.close()
  check('Quit leaves the server running', serverStatus().running === true)
} catch (err) {
  check(`unexpected error: ${err.stack ?? err}`, false)
} finally {
  fs.writeFileSync(BUILD_ID_FILE, originalBuildId)
  await app.close().catch(() => {})
  if (workspaceId) spawnSync('yaac', ['workspace', 'stop', workspaceId], { env: ENV })
  spawnSync('yaac', ['server', 'stop'], { env: ENV })
  if (!process.env.KEEP_DATA) fs.rmSync(DATA_DIR, { recursive: true, force: true })
}
finish()
