/*
 * Verifies the auth daemon the desktop shell bundles: the main process runs
 * dist/auth-daemon.js in an Electron utilityProcess, which connects to the
 * selected server and catches a sign-in's loopback redirect, and Quit stops
 * it.
 *
 *  1. After launch the server reports an auth daemon connected.
 *  2. A Claude sign-in started for the daemon (as the SPA card does in the
 *     app) redirects, once the fake vendor approves it, to the daemon's
 *     loopback listener, and the server stores an OAuth credential.
 *  3. Quitting the shell disconnects the daemon.
 *
 * The server talks to the fake vendor of
 * packages/test-utils/src/fake-vendor-oauth.ts, loaded through tsx, and the
 * script plays the browser by fetching the authorize URL.
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
 * yaac.app/Contents/MacOS/yaac) to check the packaged layout too.
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

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-desktop-authd-'))
const CLIENT_DIR = `${DATA_DIR}-client`
const ENV = { ...process.env, YAAC_DATA_DIR: DATA_DIR }
let vendor

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
  const { tsImport } = await import(path.join(REPO, 'node_modules', 'tsx', 'dist', 'esm', 'api', 'index.mjs'))
  const fake = await tsImport(path.join(REPO, 'packages', 'test-utils', 'src', 'fake-vendor-oauth.ts'), import.meta.url)
  vendor = await fake.startFakeVendorOAuth()
  ENV.YAAC_E2E_VENDOR_OAUTH_ORIGIN = vendor.origin

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
  check('the server sees an auth daemon', connected === true)

  console.log('\n2. a Claude sign-in comes back through the daemon')
  const start = await (await fetch(`${origin}/api/auth/claude/login/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback: 'auth-daemon' }),
  })).json()
  check('the daemon catches the redirect, so no code is asked for', start.acceptsCode === false, JSON.stringify(start))
  const page = await poll(async () => {
    const text = await (await fetch(start.url)).text()
    return text.includes('Signed in') ? text : undefined
  }, 15_000)
  check('the daemon answers the browser', page !== undefined)
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
  check('the daemon disconnected', gone === true)
}

main()
  .catch((err) => {
    console.error(`\nFAILED: ${err.message}`)
    process.exitCode = 1
  })
  .finally(() => {
    try { yaac('server', 'stop') } catch { /* already stopped */ }
    void vendor?.close()
    fs.rmSync(DATA_DIR, { recursive: true, force: true })
    fs.rmSync(CLIENT_DIR, { recursive: true, force: true })
    finish()
  })
