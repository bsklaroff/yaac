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
 *  6. A page from a server off loopback (a stand-in on this machine's LAN
 *     address) cannot set up, start, stop, cancel or read this Mac's
 *     servers through the bridge, nor can a loopback page that is not one
 *     of this Mac's installs (a stand-in for a port the app forwards for a
 *     remote server), which the remote page moves the window to.
 *  7. Quitting during a setup asks first, then cancels it: the hanging
 *     `yaac server start`'s child is gone once the app has exited.
 *
 * The native confirmation before each setup is answered from the main
 * process (declined once, then accepted), since Playwright cannot click a
 * native dialog.
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
import http from 'node:http'
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
/** While this exists, the stand-in `brew install` and `yaac server start` hang, for the cancel and quit cases. */
const SLOW = path.join(SCRATCH, 'slow')
/** The hanging install's child, which a cancel must kill. */
const SLEEP_PID = path.join(SCRATCH, 'sleep-pid')
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
  // What the formula install puts on PATH. While SLOW exists its
  // `server start` hangs first, for the quit case.
  write(path.join(SCRATCH, 'yaac'), `#!/bin/sh
if [ "$1 $2" = "server start" ] && [ -e '${SLOW}' ]; then sleep 600 & echo $! > '${SLEEP_PID}'; wait; fi
exec node '${CLI}' "$@"
`)
  write(path.join(BIN, 'brew'), `#!/bin/sh
echo "brew $*" >> '${CALLS}'
case "$*" in
  'trust --tap --json=v1') if [ -e '${SCRATCH}/trusted' ]; then echo '["bsklaroff/yaac"]'; else echo '[]'; fi ;;
  'list --formula --versions yaac-server') exit 1 ;;
  'trust bsklaroff/yaac') touch '${SCRATCH}/trusted'; echo 'Trusted tap: bsklaroff/yaac' ;;
  'install bsklaroff/yaac/yaac-server')
    echo '==> Fetching bsklaroff/yaac/yaac-server'
    if [ -e '${SLOW}' ]; then sleep 600 & echo $! > '${SLEEP_PID}'; wait; fi
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
  // Answer native dialogs from here, recording what each said.
  await app.evaluate(({ dialog }) => {
    globalThis.dialogs = []
    globalThis.answer = 1
    dialog.showMessageBox = async (...args) => {
      const opts = args.at(-1)
      globalThis.dialogs.push(`${opts.message}\n${opts.detail ?? ''}`)
      return { response: globalThis.answer, checkboxChecked: false }
    }
  })
  const dialogs = () => app.evaluate(() => globalThis.dialogs)
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

    console.log('\n3. a declined confirmation runs nothing; a hanging brew install → progress, then Cancel')
    await app.evaluate(() => { globalThis.answer = 0 })
    await win.click('button.setup[data-scope="server"]')
    await until(win, () => /not started/.test(document.getElementById('status')?.textContent ?? ''), null, 10_000)
    const asked = (await dialogs())[0] ?? ''
    check('the confirmation names the tap it trusts', asked.includes('trusts the Homebrew tap bsklaroff/yaac'), asked)
    check('declining ran no command', !fs.existsSync(CALLS))
    await app.evaluate(() => { globalThis.answer = 1 })
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

    console.log('\n6. pages that are not this Mac\'s installs cannot drive its servers')
    // Serves a page that calls every local-server method and reports what came back.
    const prober = () => http.createServer((req, res) => {
      const json = (body) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
      if (req.url === '/api/health') return json({ ok: true, buildId: 'remote' })
      if (req.url === '/api/whoami') return json({ kind: 'local', userId: 'remote' })
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>probe</title><script>
        (async () => {
          const b = window.yaacServer, out = {}
          const calls = { setup: () => b.setupLocal('server'), stop: () => b.stopLocal('server'),
            start: () => b.startLocal('server'), cancel: () => b.cancelSetup(), state: () => b.localState() }
          for (const [k, f] of Object.entries(calls)) {
            try { out[k] = await f() } catch { out[k] = 'rejected' }
          }
          document.title = JSON.stringify(out)
        })()
      </script>`)
    })
    const listen = async (server, host) => {
      await new Promise((r) => server.listen(0, host, r))
      return `http://${host}:${server.address().port}`
    }
    const refusedAll = async (where) => {
      await until(win, (o) => location.origin === o && document.title.startsWith('{'), where, 30_000)
      const out = JSON.parse(await win.title())
      const refused = ['setup', 'stop', 'start', 'cancel'].every((k) => out[k]?.ok === false && /own pages/.test(out[k].error))
      check(`a page at ${where} was refused setup, stop, start and cancel`, refused, JSON.stringify(out))
      check(`and could not read this Mac's state`, out.state === 'rejected')
    }
    const lan = Object.values(os.networkInterfaces()).flat().find((a) => a.family === 'IPv4' && !a.internal)?.address
    const remote = prober()
    const forwarded = prober()
    try {
      const forwardedOrigin = await listen(forwarded, '127.0.0.1')
      const brewCalls = fs.readFileSync(CALLS, 'utf8')
      const dialogCount = (await dialogs()).length
      if (lan) {
        const remoteOrigin = await listen(remote, lan)
        await win.evaluate((url) => window.yaacServer.addRemote(url), remoteOrigin)
        await refusedAll(remoteOrigin)
      } else {
        console.log('    (no non-loopback address here — the direct remote case is skipped)')
      }
      // The page now showing moves the window to a loopback port it controls.
      await win.evaluate((url) => window.yaacServer.addRemote(url), forwardedOrigin)
      await refusedAll(forwardedOrigin)
      check('no command ran and no confirmation showed',
        fs.readFileSync(CALLS, 'utf8') === brewCalls && (await dialogs()).length === dialogCount)
      const status = JSON.parse(execFileSync('node', [CLI, 'server', 'status', '--json'], { env: ENV, encoding: 'utf8' }))
      check('this Mac\'s server is still running', status.running === true)
    } finally {
      remote.close()
      forwarded.close()
    }

    console.log('\n7. Quit during a setup → asks, cancels it, then quits')
    await win.evaluate((url) => window.yaacServer.switchTo({ url }), origin)
    await until(win, (o) => location.origin === o, origin, 30_000)
    // This time `yaac server start` hangs.
    fs.rmSync(SLEEP_PID, { force: true })
    fs.writeFileSync(SLOW, '')
    const begun = await win.evaluate(() => window.yaacServer.setupLocal('server'))
    check('a loopback page may start a setup', begun.ok === true, JSON.stringify(begun))
    for (const end = Date.now() + 30_000; !fs.existsSync(SLEEP_PID); await new Promise((r) => setTimeout(r, 200))) {
      if (Date.now() > end) throw new Error('the install never started')
    }
    const sleeper = Number(fs.readFileSync(SLEEP_PID, 'utf8'))
    // "Keep running" first: the app stays, and so does the setup.
    await app.evaluate(() => { globalThis.answer = 0 })
    await app.evaluate(({ app: electronApp }) => electronApp.quit())
    await new Promise((r) => setTimeout(r, 1000))
    check('Quit asks first', /setup is still running/.test((await dialogs()).at(-1)), (await dialogs()).at(-1))
    check('"Keep running" keeps the setup', (await win.evaluate(() => window.yaacServer.localState())).setup.phase === 'running')
    await app.evaluate(() => { globalThis.answer = 1 })
    const exited = new Promise((r) => app.process().once('exit', r))
    await app.evaluate(({ app: electronApp }) => electronApp.quit())
    await Promise.race([exited, new Promise((r) => setTimeout(r, 20_000))])
    check('the app exited', app.process().exitCode !== null || app.process().signalCode !== null)
    let alive = true
    try {
      process.kill(sleeper, 0)
    } catch {
      alive = false
    }
    check('the setup\'s command was killed, not orphaned', !alive)
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
