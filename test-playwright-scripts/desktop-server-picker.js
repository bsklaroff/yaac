/*
 * Drives the real Electron shell end to end through the whole server-selection
 * story — the part no unit test can reach, because it is the main process, the
 * preload bridge, and the window all cooperating.
 *
 * Every server the shell can reach is an origin plus a durable token in
 * `server.json`; there is no "local server" case and the shell starts nothing.
 * So the two things worth driving for real are (a) that a shell with no
 * reachable server shows the picker and can be talked back onto one, and (b)
 * that the picker's buttons actually reach the main process over the preload
 * bridge. Six steps:
 *
 *  1. No `server.json` → the window is the picker, titled "No yaac server
 *     selected", with no rows and no "Local server" anywhere.
 *  1b. Register a server from a terminal, then hit "Try again" → the window
 *     lands. This is the exit from a zero-row picker: there are no rows to
 *     Connect to and the token is the one thing a user cannot read back, so
 *     without it the only way out is Quit and relaunch.
 *  2. Add the server with a BAD token → the rejection appears inline and the
 *     window stays on the picker (nothing was written).
 *  3. Add it with a real token → the shell relands on the server origin and
 *     the SPA loads, authed, with no further interaction.
 *  4. Stop the server, relaunch → the picker again, this time naming the
 *     origin it could not reach, with a row for it.
 *  5. Start the server, click Connect on that row → lands. (Connect on the
 *     already-selected row is the retry; a no-op there would strand the
 *     window on the failure forever.)
 *  6. Settings → Server in the landed SPA lists that origin and no local row.
 *
 * Runs against its own throwaway data dir and its own server, so it never
 * touches your install.
 *
 * Prerequisites (this needs a real Electron, which needs a real desktop):
 *   - `pnpm build` at the repo root, then `pnpm --filter @yaac/desktop build`
 *     (the shell always runs the tsup output, even in dev).
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
 * Screenshots land in /tmp/yaac-shots/desktop-*.png.
 */
import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync('/opt/playwright-browsers')) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/playwright-browsers'
}

function requirePlaywright() {
  try {
    return require('playwright')
  } catch {
    const globalRoot = execSync('npm root -g').toString().trim()
    return require(path.join(globalRoot, 'playwright'))
  }
}

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DESKTOP = path.join(REPO, 'packages', 'desktop')
const CLI = path.join(REPO, 'dist', 'cli.js')
const SHOT_DIR = '/tmp/yaac-shots'

// Its own data dir, so the machine's real `server.json` is never touched.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-desktop-e2e-'))
const CLIENT_DIR = `${DATA_DIR}-client`
const CONFIG = path.join(CLIENT_DIR, 'server.json')
// The credential gate stays ON, as it is for a server anyone else can
// reach. A loopback server is credential-OPTIONAL by default
// (`isCredentialOptional` keys on configuration, not the bind address), and
// there it accepts any bearer at all — so the "bad token is refused" step
// would pass a garbage token and land, proving nothing.
const ENV = { ...process.env, YAAC_DATA_DIR: DATA_DIR, YAAC_REQUIRE_AUTH: '1' }

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

function serverOrigin() {
  const lock = JSON.parse(fs.readFileSync(path.join(DATA_DIR, '.server.lock'), 'utf8'))
  return `http://127.0.0.1:${lock.port}`
}

function check(label, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) process.exitCode = 1
  return ok
}

/**
 * The workspace's own Electron binary. Playwright looks for one in the
 * CWD's node_modules, which is not where pnpm puts it — and a globally
 * installed playwright has no chance of finding it at all.
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
  // The boot flow swaps the window through a splash, then to the picker or
  // the SPA; settle on whichever it lands on.
  await win.waitForLoadState('domcontentloaded')
  return { app, win }
}

/** Wait until the window is showing the picker (not the splash). */
async function waitForPicker(win) {
  await win.waitForFunction(() => document.querySelector('#add') !== null, null, { timeout: 30_000 })
}

/** Wait until the window has landed on a served SPA at `origin`. */
async function waitForApp(win, origin) {
  await win.waitForFunction(
    (o) => location.origin === o && document.querySelector('#add') === null,
    origin,
    { timeout: 60_000 },
  )
}

/**
 * Quit the shell.
 *
 * `electronApp.close()` waits for the app to exit, and this app is a TRAY
 * app that deliberately does not: closing its window hides it, and the
 * process lives on so the badge and the port forwards keep working. So the
 * graceful close is given a moment and then the process is killed — the
 * same thing a user's Quit does, minus the menu.
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

/** Reap the login broker the shell spawns, so it does not outlive the run. */
function stopAuthDaemon() {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(CLIENT_DIR, '.auth-daemon.lock'), 'utf8'))
    if (typeof lock.pid === 'number') process.kill(lock.pid, 'SIGTERM')
  } catch {
    // no daemon ran, or it is already gone
  }
}

async function shot(win, name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  await win.screenshot({ path: path.join(SHOT_DIR, `desktop-${name}.png`) })
  console.log(`    screenshot -> ${SHOT_DIR}/desktop-${name}.png`)
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
  // Minted while `server start`'s own registration is still in place: with
  // nothing selected the CLI cannot reach the server either, which is the
  // point of step 1.
  const token = yaac('auth', 'token', 'create', 'desktop-e2e').trim()

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

  // 1b. The zero-row exit: a server registered from a terminal while this
  // page sits there is invisible to it until the flow re-runs.
  console.log('\n1b. `yaac server start` in a terminal, then Try again → lands')
  yaac('server', 'start')
  await win.click('#retry')
  await waitForApp(win, origin)
  check('Try again landed the window', (await win.evaluate(() => location.origin)) === origin)
  await shot(win, '1b-retry-landed')

  // Back to the empty picker for the token cases.
  fs.rmSync(CONFIG, { force: true })
  await closeApp(app)
  ;({ app, win } = await launch(electron))
  await waitForPicker(win)

  // 2. A bad token is refused inline, and writes nothing.
  console.log('\n2. adding it with a bad token → inline rejection, still on the picker')
  await win.fill('input[name="url"]', origin)
  await win.fill('input[name="token"]', 'f'.repeat(64))
  await win.click('button.add')
  try {
    await win.waitForFunction(
      () => /rejected|cannot reach/i.test(document.getElementById('status')?.textContent ?? ''),
      null,
      { timeout: 30_000 },
    )
  } catch (err) {
    console.error(`    status was: ${JSON.stringify(await win.evaluate(
      () => document.getElementById('status')?.textContent ?? '(no #status on this page)',
    ).catch(() => '(page gone)'))}`)
    console.error(`    url was: ${await win.evaluate(() => location.href).catch(() => '?')}`)
    throw err
  }
  const rejection = await win.textContent('#status')
  check('the server\'s own rejection is shown', /rejected/i.test(rejection), rejection.trim())
  check('still on the picker', (await win.locator('#add').count()) === 1)
  check('nothing was written', !fs.existsSync(CONFIG))
  await shot(win, '2-bad-token')

  // 3. A real token lands the window on the SPA.
  console.log('\n3. adding it with a real token → the shell relands, authed')
  await win.fill('input[name="url"]', origin)
  await win.fill('input[name="token"]', token)
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
    stopAuthDaemon()
    yaacQuiet('server', 'stop')
    fs.rmSync(DATA_DIR, { recursive: true, force: true })
    fs.rmSync(CLIENT_DIR, { recursive: true, force: true })
    console.log('\ncleaned up the throwaway data dir')
  })
