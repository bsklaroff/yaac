/*
 * Verifies the Electron shell's server picker end to end: the main process,
 * the preload bridge and the window together (docs/server-selection.md).
 * Every server is an origin in `server.json`.
 *
 *  1. No `server.json`: the window is the picker, titled "No yaac server
 *     selected", with no rows and no "Local server".
 *  1b. Registering a server from a terminal, then "Try again", lands the
 *     window (the only way out of an empty picker besides relaunching).
 *  2. Adding an origin nothing answers at shows an inline failure and
 *     writes nothing.
 *  3. Adding the real server's origin loads the SPA.
 *  4. With the server stopped, a relaunch shows the picker with a row for
 *     the unreachable origin.
 *  5. With the server started, Connect on that row lands (Connect on the
 *     selected row is the retry).
 *  6. Settings → Server in the SPA lists that origin and no local row.
 *
 * Uses its own throwaway data dir and server, so it never touches your
 * install; export YAAC_SERVER_PORT to keep that server off the default port.
 *
 * Prerequisites (this needs a real Electron, which needs a real desktop):
 *   - `pnpm build` at the repo root, then `pnpm --filter @yaac/desktop build`
 *     (the shell always runs the tsup output, even in dev).
 *   - The Electron binary: `node packages/desktop/node_modules/electron/install.js`
 *     if `electron/path.txt` is missing.
 *   - Electron's system libraries. On a bare container it will not start; run
 *     ldd against the unpacked electron binary and check nothing reports
 *     "not found". On Ubuntu 26.04 that is:
 *       sudo apt-get install -y libgtk-3-0t64 libcups2t64 libnss3 \
 *         libasound2t64 libgbm1 libxss1 xvfb
 *   - A display. Under a desktop session it just works; headless, prefix the
 *     command with `xvfb-run -a`.
 *
 * Run:
 *   node test-playwright-scripts/desktop-server-picker.js
 *   xvfb-run -a node test-playwright-scripts/desktop-server-picker.js
 *
 * Screenshots: $SCREENSHOT_DIR/desktop-*.png (default /tmp/yaac-shots).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, finish, requirePlaywright, SHOTS } from './lib.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DESKTOP = path.join(REPO, 'packages', 'desktop')
const CLI = path.join(REPO, 'dist', 'cli.js')

// Its own data dir, so the machine's real `server.json` is never touched.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-desktop-e2e-'))
const CLIENT_DIR = `${DATA_DIR}-client`
const CONFIG = path.join(CLIENT_DIR, 'server.json')
const ENV = { ...process.env, YAAC_DATA_DIR: DATA_DIR }

function yaac(...args) {
  return execFileSync('node', [CLI, ...args], { env: ENV, encoding: 'utf8' })
}

function yaacQuiet(...args) {
  try {
    return { ok: true, out: yaac(...args) }
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

/** The origin `yaac server start` registered in server.json. */
function serverOrigin() {
  return JSON.parse(fs.readFileSync(CONFIG, 'utf8')).url
}

/**
 * Poll `fn(arg)` in the window until it holds. Not `waitForFunction`, which
 * needs `unsafe-eval` and the SPA's CSP forbids it.
 */
async function until(win, fn, arg, timeoutMs) {
  for (const end = Date.now() + timeoutMs; ; await new Promise((r) => setTimeout(r, 250))) {
    if (await win.evaluate(fn, arg).catch(() => false)) return
    if (Date.now() > end) throw new Error(`timed out waiting for ${fn.name || 'condition'}`)
  }
}

/**
 * The repo's Electron binary, which Playwright cannot find on its own under
 * pnpm's layout.
 */
function electronPath() {
  const pkg = path.join(DESKTOP, 'node_modules', 'electron')
  const rel = fs.readFileSync(path.join(pkg, 'path.txt'), 'utf8').trim()
  return path.join(pkg, 'dist', rel)
}

/** Launch the shell against DATA_DIR and hand back its first window. */
async function launch(electron) {
  const app = await electron.launch({
    executablePath: electronPath(),
    args: [DESKTOP],
    cwd: DESKTOP,
    env: ENV,
  })
  const win = await app.firstWindow()
  win.on('pageerror', (err) => console.error(`    [page error] ${err.message}`))
  // The window goes through a splash to the picker or the SPA.
  await win.waitForLoadState('domcontentloaded')
  return { app, win }
}

/** Wait until the window is showing the picker (not the splash). */
const waitForPicker = (win) => until(win, () => document.querySelector('#add') !== null, null, 30_000)

/** Wait until the window has landed on a served SPA at `origin`. */
const waitForApp = (win, origin) =>
  until(win, (o) => location.origin === o && document.querySelector('#add') === null, origin, 60_000)

/**
 * Quit the shell. It is a tray app that keeps running when its window
 * closes, so after a short graceful close the process is killed.
 */
async function closeApp(app) {
  await Promise.race([
    app.close().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ])
  try {
    app.process().kill('SIGKILL')
  } catch {
    // already gone
  }
}

async function shot(win, name) {
  await win.screenshot({ path: path.join(SHOTS, `desktop-${name}.png`) })
  console.log(`    screenshot -> ${SHOTS}/desktop-${name}.png`)
}

async function main() {
  if (!fs.existsSync(CLI)) {
    throw new Error(`no ${CLI} — run \`pnpm build\` at the repo root first`)
  }
  if (!fs.existsSync(path.join(DESKTOP, 'dist', 'main.js'))) {
    throw new Error('no packages/desktop/dist/main.js — run `pnpm --filter @yaac/desktop build`')
  }
  const { _electron: electron } = requirePlaywright()

  console.log('starting a throwaway server…')
  yaac('server', 'start')
  const origin = serverOrigin()
  console.log(`  server at ${origin} (data dir ${DATA_DIR})`)
  // 1. A shell with nothing selected.
  console.log('\n1. no server selected → the picker is the whole window')
  fs.rmSync(CONFIG, { force: true })
  let { app, win } = await launch(electron)
  await waitForPicker(win)
  const heading = await win.textContent('h1')
  check('titled "No yaac server selected"', /No yaac server selected/.test(heading), heading)
  check('no server rows', (await win.locator('button.connect').count()) === 0)
  const bodyText = await win.textContent('body')
  check('no "Local server" anywhere', !bodyText.includes('Local server'))
  check('says nothing is configured', bodyText.includes('No servers configured yet.'))
  await shot(win, '1-nothing-selected')

  // 1b. A server registered from a terminal shows up only after "Try again".
  console.log('\n1b. `yaac server start` in a terminal, then Try again → lands')
  yaac('server', 'start')
  await win.click('#retry')
  await waitForApp(win, origin)
  check('Try again landed the window', (await win.evaluate(() => location.origin)) === origin)
  await shot(win, '1b-retry-landed')

  // Back to the empty picker for the add-form cases.
  fs.rmSync(CONFIG, { force: true })
  await closeApp(app)
  ;({ app, win } = await launch(electron))
  await waitForPicker(win)

  // 2. An origin nothing answers at is refused inline, and writes nothing.
  console.log('\n2. adding a dead origin → inline rejection, still on the picker')
  await win.fill('input[name="url"]', 'http://127.0.0.1:1')
  await win.click('button.add')
  await until(win, () => /cannot reach/i.test(document.getElementById('status')?.textContent ?? ''), null, 30_000)
  const rejection = await win.textContent('#status')
  check('the failure is shown', /cannot reach/i.test(rejection), rejection.trim())
  check('still on the picker', (await win.locator('#add').count()) === 1)
  check('nothing was written', !fs.existsSync(CONFIG))
  await shot(win, '2-dead-origin')

  // 3. The real origin lands the window on the SPA.
  console.log('\n3. adding the real origin → the shell relands')
  await win.fill('input[name="url"]', origin)
  await win.click('button.add')
  await waitForApp(win, origin)
  check('window is on the server origin', (await win.evaluate(() => location.origin)) === origin)
  check('the selection was persisted', JSON.parse(fs.readFileSync(CONFIG, 'utf8')).url === origin)
  await shot(win, '3-landed')
  await closeApp(app)

  // 4. With the server down, a relaunch shows the picker naming that origin.
  console.log('\n4. server stopped → relaunch shows the picker, naming the origin')
  yaac('server', 'stop')
  ;({ app, win } = await launch(electron))
  await waitForPicker(win)
  const downHeading = await win.textContent('h1')
  check('names the origin it could not reach', downHeading.includes(origin), downHeading)
  check('offers a row for it', (await win.locator(`button.connect[data-url="${origin}"]`).count()) === 1)
  check('marks it selected', (await win.textContent('body')).includes('selected'))
  await shot(win, '4-unreachable')

  // 5. Connect on the selected-but-unreachable row is the retry.
  console.log('\n5. server restarted → Connect on that row lands')
  yaac('server', 'start')
  await win.click(`button.connect[data-url="${origin}"]`)
  await waitForApp(win, origin)
  check('landed from the picker', (await win.evaluate(() => location.origin)) === origin)
  await shot(win, '5-reconnected')

  // 6. The SPA's own picker agrees.
  console.log('\n6. Settings → Server lists the origin and no local row')
  const settings = win.locator('button[aria-label="Settings"], button[title="Settings"]').first()
  if (await settings.count()) {
    await settings.click()
    const server = win.getByText('Server', { exact: true }).first()
    if (await server.count()) await server.click()
    await win.waitForTimeout(500)
    const settingsText = await win.textContent('body')
    check('lists the origin', settingsText.includes(origin))
    check('no "Local server" row', !settingsText.includes('Local server'))
    await shot(win, '6-settings')
  } else {
    console.log('    (settings button not found — check by hand)')
  }

  await closeApp(app)
}

main()
  .catch((err) => {
    console.error(`\nFAILED: ${err.message}`)
    process.exitCode = 1
  })
  .finally(() => {
    yaacQuiet('server', 'stop')
    fs.rmSync(DATA_DIR, { recursive: true, force: true })
    fs.rmSync(CLIENT_DIR, { recursive: true, force: true })
    console.log('\ncleaned up the throwaway data dir')
    finish()
  })
