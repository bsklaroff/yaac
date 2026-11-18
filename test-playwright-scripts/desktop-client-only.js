/*
 * Verifies the desktop app on Linux and Windows, where it is a client only
 * (packages/desktop/README.md): it neither sets up nor manages this
 * machine's installs, and keeps the native window frame.
 *
 *  1. With nothing registered, the window is the Servers page, with no
 *     setup and no install rows, even with a `yaac` CLI around.
 *  2. The menu bar is a File menu (holding Quit) in place of the macOS app
 *     menu, auto-hidden.
 *  3. A server started from a terminal (`yaac server start`, which registers
 *     it in server.json) is where the app lands on its next launch, and the
 *     SPA draws no window controls of its own.
 *
 * Step 3 needs the CLI bundle (`pnpm build` at the repo root) and tmux; it
 * is skipped without `dist/cli.js`, leaving a launch smoke test. Uses its own throwaway data dir, client dir
 * and server port (YAAC_SERVER_PORT, default 8891), so it never touches
 * your install.
 *
 * The app under test is this platform and arch's unpacked build in
 * packages/desktop/dist-app/ (`pnpm desktop:package`, or what
 * `pnpm desktop:release-linux` leaves beside its artifacts), or the
 * executable YAAC_DESKTOP_APP names. On a bare Linux
 * box it needs Electron's system libraries (see desktop-server-picker.js)
 * and a display.
 *
 * Run:
 *   xvfb-run -a node test-playwright-scripts/desktop-client-only.js   # Linux, headless
 *   node test-playwright-scripts/desktop-client-only.js               # Windows, or a desktop session
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, finish, requirePlaywright, SHOTS } from './lib.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI = path.join(REPO, 'dist', 'cli.js')
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-client-only-'))
const ENV = { ...process.env, YAAC_DATA_DIR: DATA_DIR, YAAC_SERVER_PORT: process.env.YAAC_SERVER_PORT ?? '8891' }

/** The packaged executable: YAAC_DESKTOP_APP, else the unpacked build for this platform and arch. */
function appPath() {
  if (process.env.YAAC_DESKTOP_APP) return process.env.YAAC_DESKTOP_APP
  const platform = process.platform === 'win32' ? 'win' : 'linux'
  const dir = `${platform}${process.arch === 'arm64' ? '-arm64' : ''}-unpacked`
  const exe = path.join(REPO, 'packages', 'desktop', 'dist-app', dir, platform === 'win' ? 'yaac.exe' : 'yaac-desktop')
  if (!fs.existsSync(exe)) throw new Error(`no ${exe} — run \`pnpm desktop:package\``)
  return exe
}

const yaac = (...args) => execFileSync(process.execPath, [CLI, ...args], { env: ENV, encoding: 'utf8' })

async function launch(electron) {
  // A container has no setuid chrome-sandbox.
  const args = process.platform === 'linux' ? ['--no-sandbox'] : []
  return electron.launch({ executablePath: appPath(), args, env: ENV })
}

/** The page among the app's windows and views that satisfies `fn`. */
async function pageWhere(app, fn, timeoutMs = 30_000) {
  for (const end = Date.now() + timeoutMs; ; await new Promise((r) => setTimeout(r, 250))) {
    for (const page of app.windows()) {
      if (await page.evaluate(fn).catch(() => false)) return page
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${fn.name || 'a page'}`)
  }
}

/** Quit the app, which stays in the tray when its window closes. */
async function quit(app) {
  await Promise.race([
    app.evaluate(({ app: a }) => a.quit()).then(() => app.waitForEvent('close')).catch(() => {}),
    new Promise((r) => setTimeout(r, 5000)),
  ])
  try { app.process().kill('SIGKILL') } catch { /* gone */ }
}

const { _electron: electron } = requirePlaywright()
let serverStarted = false
try {
  console.log('1. nothing registered → the Servers page, with no setup')
  let app = await launch(electron)
  try {
    const page = await pageWhere(app, () => document.querySelector('#add') !== null)
    check('titled "No yaac server selected"', /No yaac server selected/.test(await page.textContent('h1')))
    check('offers no setup', (await page.locator('button.setup').count()) === 0)
    check('lists no install of this machine', (await page.locator('[id^="install-"]').count()) === 0)
    check('says nothing about setting up here', !(await page.innerText('body')).includes('Set up'))
    await page.screenshot({ path: path.join(SHOTS, 'desktop-client-only-servers.png') })

    console.log('\n2. the menu bar')
    const menu = await app.evaluate(({ BrowserWindow, Menu }) => ({
      top: Menu.getApplicationMenu().items.map((i) => i.label),
      file: Menu.getApplicationMenu().items[0].submenu.items.map((i) => i.role),
      autoHide: BrowserWindow.getAllWindows()[0].isMenuBarAutoHide(),
    }))
    check('leads with a File menu holding Quit', menu.top[0] === 'File' && menu.file.includes('quit'), JSON.stringify(menu))
    check('is auto-hidden', menu.autoHide === true)
  } finally {
    await quit(app)
  }

  if (!fs.existsSync(CLI)) {
    console.log(`\n3. skipped: no ${CLI} (run \`pnpm build\` to cover a server started from a terminal)`)
  } else {
    console.log('\n3. a server started from a terminal')
    yaac('server', 'start')
    serverStarted = true
    const origin = JSON.parse(fs.readFileSync(`${DATA_DIR}-client/server.json`, 'utf8')).url
    app = await launch(electron)
    try {
      const spa = await pageWhere(app, function spaLoaded() {
        return document.querySelector('#root')?.childElementCount > 0
      }, 60_000)
      check('the app lands on it', new URL(spa.url()).origin === origin, spa.url())
      // The rail's Servers button shows once the rail, where macOS draws the controls, has rendered.
      await spa.getByLabel('Servers', { exact: true }).waitFor({ timeout: 30_000 })
      check('the SPA draws no window controls', (await spa.getByLabel('Close window').count()) === 0)
      await spa.screenshot({ path: path.join(SHOTS, 'desktop-client-only-spa.png') })
    } finally {
      await quit(app)
    }
  }
} finally {
  if (serverStarted) {
    try { yaac('server', 'stop') } catch { /* already down */ }
  }
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
  fs.rmSync(`${DATA_DIR}-client`, { recursive: true, force: true })
}
finish()
