/*
 * Verifies the Electron shell's first-run onboarding end to end: the
 * picker's setup choices, a setup run in the background with its progress,
 * a cancel, and the landing on the new server (packages/desktop/README.md,
 * "Setup").
 *
 * The app runs with a PATH holding a stand-in `brew` and no `yaac`, so it
 * sees a Mac with nothing installed. The stand-in brew answers the setup's
 * probes, and its `install bsklaroff/yaac/yaac-server` puts a `yaac` on
 * that PATH which runs this repo's dist/cli.js. Everything after the
 * install is real: `yaac server start` starts a server in a throwaway data
 * dir, and the window lands on it.
 *
 *  1. The picker leads with both setups, each with its commands. The
 *     cluster one is enabled only on macOS arm64.
 *  2. "Copy commands" copies.
 *  3. A containerless setup whose brew install hangs shows its steps and
 *     output, and Cancel stops it and marks the step cancelled.
 *  4. Run again: the trust step is skipped as done, the install runs, the
 *     server starts, and the window lands on its origin.
 *  5. The SPA's Settings → Server shows that server running, with a Stop,
 *     and the cluster setup (or why this machine cannot run it).
 *
 * Prerequisites: as for desktop-server-picker.js (`pnpm build`, then
 * `pnpm --filter @yaac/desktop build`, an Electron binary, its system
 * libraries and a display, or `xvfb-run -a`).
 *
 * Run:
 *   node test-playwright-scripts/desktop-onboarding.js
 *   xvfb-run -a node test-playwright-scripts/desktop-onboarding.js
 *
 * Screenshots: $SCREENSHOT_DIR/desktop-onboarding-*.png (default /tmp/yaac-shots).
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

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-onboarding-'))
const DATA_DIR = path.join(SCRATCH, 'data')
const CLIENT_DIR = `${DATA_DIR}-client`
const BIN = path.join(SCRATCH, 'bin')
const CALLS = path.join(SCRATCH, 'brew-calls')
/** While this exists, the stand-in `brew install` hangs, for the cancel case. */
const SLOW = path.join(SCRATCH, 'slow')
const NODE_DIR = path.dirname(process.execPath)

/*
 * The app adopts its login shell's PATH. This "shell" runs the script it is
 * handed with the PATH it inherited, so the app sees BIN and no other yaac.
 */
const SHELL = path.join(SCRATCH, 'shell')
const PATH = `${BIN}:${NODE_DIR}:/usr/bin:/bin`
const ENV = { ...process.env, YAAC_DATA_DIR: DATA_DIR, PATH, SHELL }

function write(file, text) {
  fs.writeFileSync(file, text, { mode: 0o755 })
}

function setUpFakes() {
  fs.mkdirSync(BIN, { recursive: true })
  write(SHELL, '#!/bin/sh\nshift\neval "$1"\n')
  // What the formula install puts on PATH.
  write(path.join(SCRATCH, 'yaac'), `#!/bin/sh\nexec node '${CLI}' "$@"\n`)
  write(path.join(BIN, 'brew'), `#!/bin/sh
echo "brew $*" >> '${CALLS}'
case "$*" in
  'trust --tap --json=v1') if [ -e '${SCRATCH}/trusted' ]; then echo '["bsklaroff/yaac"]'; else echo '[]'; fi ;;
  'list --formula --versions yaac-server') exit 1 ;;
  'trust bsklaroff/yaac') touch '${SCRATCH}/trusted'; echo 'Trusted tap: bsklaroff/yaac' ;;
  'install bsklaroff/yaac/yaac-server')
    echo '==> Fetching bsklaroff/yaac/yaac-server'
    if [ -e '${SLOW}' ]; then sleep 600; fi
    cp '${SCRATCH}/yaac' '${BIN}/yaac'
    echo '==> Pouring yaac-server' ;;
  *) echo "unexpected: brew $*" >&2; exit 99 ;;
esac
`)
}

function electronPath() {
  const pkg = path.join(DESKTOP, 'node_modules', 'electron')
  const rel = fs.readFileSync(path.join(pkg, 'path.txt'), 'utf8').trim()
  return path.join(pkg, 'dist', rel)
}

/** Poll `fn(arg)` in the window until it holds (the SPA's CSP forbids waitForFunction). */
async function until(win, fn, arg, timeoutMs) {
  for (const end = Date.now() + timeoutMs; ; await new Promise((r) => setTimeout(r, 250))) {
    if (await win.evaluate(fn, arg).catch(() => false)) return
    if (Date.now() > end) throw new Error(`timed out waiting for ${fn.name || 'condition'}`)
  }
}

async function closeApp(app) {
  await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))])
  try {
    app.process().kill('SIGKILL')
  } catch {
    // already gone
  }
}

async function shot(win, name) {
  await win.screenshot({ path: path.join(SHOTS, `desktop-onboarding-${name}.png`) })
  console.log(`    screenshot -> ${SHOTS}/desktop-onboarding-${name}.png`)
}

const stepStates = (win) => win.$$eval('#run-steps li', (lis) => lis.map((li) => `${li.className}: ${li.textContent}`))

async function main() {
  if (!fs.existsSync(CLI)) throw new Error(`no ${CLI} — run \`pnpm build\` at the repo root first`)
  if (!fs.existsSync(path.join(DESKTOP, 'dist', 'main.js'))) {
    throw new Error('no packages/desktop/dist/main.js — run `pnpm --filter @yaac/desktop build`')
  }
  setUpFakes()
  const { _electron: electron } = requirePlaywright()
  const app = await electron.launch({ executablePath: electronPath(), args: [DESKTOP], cwd: DESKTOP, env: ENV })
  const win = await app.firstWindow()
  win.on('pageerror', (err) => console.error(`    [page error] ${err.message}`))
  try {
    console.log('1. no yaac on PATH → the picker leads with both setups')
    await until(win, () => document.querySelector('#choice-server') !== null, null, 30_000)
    const body = await win.textContent('body')
    check('offers the containerless setup', body.includes('This Mac (containerless)'))
    check('offers the cluster setup', body.includes('Local Kubernetes cluster (kind)'))
    check('shows the containerless commands',
      (await win.textContent('#commands-server')).includes('brew install bsklaroff/yaac/yaac-server'))
    check('shows the cluster commands', (await win.textContent('#commands-cluster')).includes('yaac cluster install'))
    const clusterOn = !(await win.isDisabled('button.setup[data-scope="cluster"]'))
    const supported = process.platform === 'darwin' && process.arch === 'arm64'
    check(`the cluster setup is ${supported ? 'enabled' : 'disabled'} here`, clusterOn === supported)
    await shot(win, '1-choices')

    console.log('\n2. Copy commands')
    await win.click('button.copy[data-scope="server"]')
    await until(win, () => document.getElementById('status')?.textContent === 'Copied.', null, 5000)
    const copied = await app.evaluate(({ clipboard }) => clipboard.readText())
    check('the clipboard holds the commands', copied.startsWith('brew trust bsklaroff/yaac'), copied)

    console.log('\n3. a hanging brew install → progress, then Cancel')
    fs.writeFileSync(SLOW, '')
    await win.click('button.setup[data-scope="server"]')
    await until(win, () => /Fetching/.test(document.getElementById('run-log')?.textContent ?? ''), null, 30_000)
    check('the trust step ran', (await stepStates(win))[0].startsWith('done'), (await stepStates(win))[0])
    check('the install step is running', (await stepStates(win))[1].startsWith('running'))
    check('the other setup is off meanwhile', await win.isDisabled('button.setup[data-scope="server"]'))
    await shot(win, '3-running')
    await win.click('#run-cancel')
    await until(win, () => document.getElementById('run-title')?.textContent === 'Setup cancelled', null, 15_000)
    check('the install step is cancelled', (await stepStates(win))[1].startsWith('cancelled'))
    await shot(win, '3-cancelled')

    console.log('\n4. run again → skips the trust, installs, starts, lands')
    fs.rmSync(SLOW)
    await win.click('button.setup[data-scope="server"]')
    await until(win, () => location.protocol === 'http:', null, 120_000)
    const origin = JSON.parse(fs.readFileSync(path.join(CLIENT_DIR, 'server.json'), 'utf8')).url
    check('landed on the new server', (await win.evaluate(() => location.origin)) === origin, origin)
    const calls = fs.readFileSync(CALLS, 'utf8').trim().split('\n')
    check('trusted the tap once', calls.filter((c) => c === 'brew trust bsklaroff/yaac').length === 1, calls.join(', '))
    await shot(win, '4-landed')

    console.log('\n5. Settings → Server shows this Mac\'s installs')
    const settings = win.locator('button[aria-label="Settings"], button[title="Settings"]').first()
    // The SPA may still be rendering just after the landing.
    await settings.waitFor({ timeout: 15_000 }).catch(() => {})
    if (await settings.count()) {
      await settings.click()
      const server = win.getByText('Server', { exact: true }).first()
      if (await server.count()) await server.click()
      await until(win, () => document.body.textContent.includes('Containerless server'), null, 15_000)
      const text = await win.textContent('body')
      check('lists the containerless server as running', /Containerless server\s*Running/.test(text))
      check('offers to stop it', (await win.getByRole('button', { name: 'Stop' }).count()) === 1)
      check(supported ? 'offers the cluster setup' : 'says the cluster needs Apple silicon',
        supported ? (await win.getByRole('button', { name: 'Set up…' }).count()) === 1 : text.includes('needs macOS on Apple silicon'))
      await shot(win, '5-settings')
    } else {
      console.log('    (settings button not found — check by hand)')
    }
  } finally {
    await closeApp(app)
  }
}

main()
  .catch((err) => {
    console.error(`\nFAILED: ${err.message}`)
    process.exitCode = 1
  })
  .finally(() => {
    try {
      execFileSync('node', [CLI, 'server', 'stop'], { env: ENV, stdio: 'ignore' })
    } catch {
      // never started
    }
    fs.rmSync(SCRATCH, { recursive: true, force: true })
    fs.rmSync(CLIENT_DIR, { recursive: true, force: true })
    console.log('\ncleaned up the scratch dir')
    finish()
  })
