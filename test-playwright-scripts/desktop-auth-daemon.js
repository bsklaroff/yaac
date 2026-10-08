/*
 * Verifies the auth daemon the desktop shell bundles: the main process runs
 * dist/auth-daemon.js in an Electron utilityProcess, which connects to the
 * selected server and runs a browser sign-in under node-pty, and Quit stops
 * it.
 *
 *  1. After launch the server reports an auth agent connected.
 *  2. A Claude sign-in started through the server's relay route (as the SPA
 *     card does) runs the stub login CLI in a PTY inside the daemon and
 *     lands an OAuth credential on the server.
 *  3. Quitting the shell disconnects the agent.
 *
 * Uses its own throwaway data dir and server, so it never touches your
 * install; export YAAC_SERVER_PORT to keep that server off the default port.
 *
 * Prerequisites: those of desktop-server-picker.js (`pnpm build`,
 * `pnpm --filter @yaac/desktop build`, the Electron binary and its system
 * libraries, a display or `xvfb-run -a`).
 *
 * Run:
 *   xvfb-run -a node test-playwright-scripts/desktop-auth-daemon.js
 *
 * Set YAAC_DESKTOP_APP to a packaged build's executable (e.g.
 * packages/desktop/dist-app/linux-unpacked/@yaacdesktop, or
 * yaac.app/Contents/MacOS/yaac) to check the asar and node-pty layout too.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, finish, requirePlaywright } from './lib.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DESKTOP = path.join(REPO, 'packages', 'desktop')
const CLI = path.join(REPO, 'dist', 'cli.js')
const CLAUDE_STUB = path.join(REPO, 'packages', 'test-utils', 'src', 'fake-claude-login.cjs')

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-desktop-authd-'))
const CLIENT_DIR = `${DATA_DIR}-client`
const ENV = {
  ...process.env,
  YAAC_DATA_DIR: DATA_DIR,
  // The daemon spawns this in place of `claude auth login`.
  YAAC_E2E_CLAUDE_LOGIN_CLI: JSON.stringify([process.execPath, CLAUDE_STUB]),
}

function yaac(...args) {
  return execFileSync('node', [CLI, ...args], { env: ENV, encoding: 'utf8' })
}

function electronPath() {
  const pkg = path.join(DESKTOP, 'node_modules', 'electron')
  const rel = fs.readFileSync(path.join(pkg, 'path.txt'), 'utf8').trim()
  return path.join(pkg, 'dist', rel)
}

async function poll(fn, timeoutMs) {
  for (const end = Date.now() + timeoutMs; ; await new Promise((r) => setTimeout(r, 250))) {
    const value = await fn().catch(() => undefined)
    if (value) return value
    if (Date.now() > end) return undefined
  }
}

async function main() {
  for (const f of [CLI, path.join(DESKTOP, 'dist', 'auth-daemon.js')]) {
    if (!fs.existsSync(f)) throw new Error(`no ${f} — run \`pnpm build\` and \`pnpm desktop:build\``)
  }
  const { _electron: electron } = requirePlaywright()

  yaac('server', 'start')
  const origin = JSON.parse(fs.readFileSync(path.join(CLIENT_DIR, 'server.json'), 'utf8')).url
  const get = async (p) => (await fetch(`${origin}/api${p}`)).json()
  console.log(`server at ${origin}`)

  const packaged = process.env.YAAC_DESKTOP_APP
  const app = await electron.launch(packaged
    ? { executablePath: packaged, args: [], env: ENV }
    : { executablePath: electronPath(), args: [DESKTOP], cwd: DESKTOP, env: ENV })

  console.log('\n1. the bundled daemon connects')
  const connected = await poll(async () => (await get('/auth/agent')).connected, 30_000)
  check('the server sees an auth agent', connected === true)

  console.log('\n2. a relayed Claude sign-in completes in the daemon')
  const start = await (await fetch(`${origin}/api/auth/claude/login/start`, { method: 'POST' })).json()
  const done = await poll(async () => {
    const view = await get(`/auth/login/${start.id}`)
    return view.status === 'running' ? undefined : view
  }, 30_000)
  check('the sign-in succeeded', done?.status === 'success', JSON.stringify(done))
  const claude = (await get('/auth/list')).toolAuth.find((t) => t.tool === 'claude')
  check('an OAuth credential is stored', claude?.kind === 'oauth', JSON.stringify(claude))

  console.log('\n3. Quit stops the daemon')
  await app.evaluate(({ app: a }) => a.quit())
  await app.waitForEvent('close').catch(() => {})
  const gone = await poll(async () => (await get('/auth/agent')).connected === false, 15_000)
  check('the agent disconnected', gone === true)
}

main()
  .catch((err) => {
    console.error(`\nFAILED: ${err.message}`)
    process.exitCode = 1
  })
  .finally(() => {
    try { yaac('server', 'stop') } catch { /* already stopped */ }
    fs.rmSync(DATA_DIR, { recursive: true, force: true })
    fs.rmSync(CLIENT_DIR, { recursive: true, force: true })
    finish()
  })
