/*
 * Probes the desktop shell's Servers-page IPC gate (main.ts
 * handleFromServersPage) and the overlay view's lifecycle against a real
 * Electron: only the shell's own `data:` page in the overlay view may call
 * the privileged `window.yaacServer` methods.
 *
 *  1. From the SPA (the window's own webContents), every privileged bridge
 *     method is refused, with no overlay open and again with one open.
 *  2. The overlay's page cannot be moved off its `data:` page: a location
 *     change, an anchor click, a form submit and window.open to the server's
 *     origin all leave it where it was (and open in the "browser" instead).
 *  3. Opening and closing the page repeatedly leaves no view or webContents
 *     behind, and the closed view's webContents is destroyed.
 *  4. The view fills the window across a resize and full screen.
 *  5. With the server stopped, Back leaves the window a splash under the
 *     page, and the server's own row (Connect, or Start while the page
 *     still reads it stopped) after a restart brings the SPA back with no
 *     overlay.
 *
 * Prerequisites and display setup as in desktop-server-picker.js.
 *
 * Run:
 *   xvfb-run -a node test-playwright-scripts/desktop-servers-gate-probe.js
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
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-desktop-gate-'))
const CLIENT_DIR = `${DATA_DIR}-client`
const ENV = { ...process.env, YAAC_DATA_DIR: DATA_DIR }

const yaac = (...args) => execFileSync('node', [CLI, ...args], { env: ENV, encoding: 'utf8' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function electronPath() {
  const pkg = path.join(DESKTOP, 'node_modules', 'electron')
  return path.join(pkg, 'dist', fs.readFileSync(path.join(pkg, 'path.txt'), 'utf8').trim())
}

async function until(fn, timeoutMs, what) {
  for (const end = Date.now() + timeoutMs; ; await sleep(250)) {
    if (await fn().catch(() => false)) return
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
  }
}

/** The privileged bridge calls, with arguments the main process would accept. */
const CALLS = [
  ['switchTo', { url: 'http://127.0.0.1:1' }],
  ['addRemote', 'http://127.0.0.1:1'],
  ['remove', { url: 'http://127.0.0.1:1' }],
  ['disconnect'],
  ['serverHealth'],
  ['back'],
  ['startLocal', 'server'],
  ['stopLocal', 'server'],
  ['localState'],
  ['setupLocal', 'cluster'],
  ['cancelSetup'],
]

const callAll = (page) => page.evaluate(async (calls) => {
  const out = {}
  for (const [name, ...args] of calls) {
    try {
      await window.yaacServer[name](...args)
      out[name] = 'ANSWERED'
    } catch (err) {
      out[name] = /only the Servers page/.test(err.message) ? 'refused' : `error: ${err.message}`
    }
  }
  return out
}, CALLS)

const state = (app) => app.evaluate(({ BrowserWindow, webContents }) => {
  const w = BrowserWindow.getAllWindows()[0]
  const { width, height } = w.getContentBounds()
  return {
    content: { width, height },
    views: w.contentView.children.map((v) => ({ ...v.getBounds(), id: v.webContents.id, url: v.webContents.getURL().slice(0, 30) })),
    windowUrl: w.webContents.getURL().slice(0, 40),
    allContents: webContents.getAllWebContents().length,
    opened: globalThis.__opened ?? [],
  }
})

const fits = ({ content, views }) => views.length === 1
  && views[0].x === 0 && views[0].y === 0 && views[0].width === content.width && views[0].height === content.height

async function overlayPage(app) {
  let found
  await until(async () => {
    for (const p of app.windows()) {
      if (await p.evaluate(() => document.querySelector('#add') !== null).catch(() => false)) found = p
    }
    return found
  }, 30_000, 'the Servers page')
  return found
}

async function openOverlay(app, win) {
  await win.click('button[aria-label="Servers"]')
  return overlayPage(app)
}

// A DOM click: a prevented navigation leaves Playwright waiting on page.click.
async function back(app, page) {
  await page.evaluate(() => document.getElementById('back').click())
  await until(async () => (await state(app)).views.length === 0, 30_000, 'the overlay to close')
}

async function main() {
  const { _electron: electron } = requirePlaywright()
  yaac('server', 'start')
  const origin = JSON.parse(fs.readFileSync(path.join(CLIENT_DIR, 'server.json'), 'utf8')).url
  console.log(`server at ${origin}`)

  const app = await electron.launch({ executablePath: electronPath(), args: [DESKTOP], cwd: DESKTOP, env: ENV })
  // Record openExternal instead of launching a browser.
  await app.evaluate(({ shell }) => {
    globalThis.__opened = []
    shell.openExternal = async (url) => { globalThis.__opened.push(url) }
  })
  const win = await app.firstWindow()
  await until(() => win.evaluate((o) => location.origin === o && !!document.querySelector('button[aria-label="Servers"]'), origin), 60_000, 'the SPA')

  console.log('\n1. privileged calls from the SPA')
  const bare = await callAll(win)
  check('all refused with no overlay', Object.values(bare).every((v) => v === 'refused'), JSON.stringify(bare))
  let page = await openOverlay(app, win)
  const over = await callAll(win)
  check('all refused with the overlay open', Object.values(over).every((v) => v === 'refused'), JSON.stringify(over))
  const own = await page.evaluate(() => window.yaacServer.localState().then(() => 'answered', (e) => e.message))
  check('the overlay page itself is answered', own === 'answered', own)

  console.log('\n2. moving the overlay off its data: page')
  const viewId = (await state(app)).views[0].id
  const attempts = {
    'location.href': (o) => { location.href = o },
    'anchor click': (o) => { const a = document.createElement('a'); a.href = o; document.body.append(a); a.click() },
    'form submit': (o) => { const f = document.createElement('form'); f.action = o; f.method = 'get'; document.body.append(f); f.submit() },
    'window.open': (o) => { window.open(o) },
    'location.replace': (o) => { location.replace(o) },
  }
  for (const [name, fn] of Object.entries(attempts)) {
    await page.evaluate(fn, origin).catch(() => {})
    await sleep(800)
    const s = await state(app)
    check(`${name}: overlay still on data:`, s.views.length === 1 && s.views[0].id === viewId && s.views[0].url.startsWith('data:'), JSON.stringify(s.views))
  }
  check('each attempt went to the browser instead', (await state(app)).opened.length >= 4, JSON.stringify((await state(app)).opened))

  console.log('\n3. open/close leaks')
  await back(app, page)
  const baseline = (await state(app)).allContents
  const closedDestroyed = await app.evaluate(({ webContents }, id) => !webContents.fromId(id) || webContents.fromId(id).isDestroyed(), viewId)
  check('the closed view\'s webContents is gone', closedDestroyed)
  for (let i = 0; i < 5; i++) {
    page = await openOverlay(app, win)
    await back(app, page)
  }
  const after = await state(app)
  check('five open/close cycles leave no views or webContents', after.views.length === 0 && after.allContents === baseline,
    `baseline ${baseline}, after ${after.allContents}`)

  console.log('\n4. bounds')
  page = await openOverlay(app, win)
  check('fills the window', fits(await state(app)), JSON.stringify(await state(app)))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(true))
  await sleep(1500)
  check('fills it in full screen', fits(await state(app)), JSON.stringify(await state(app)))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(false))
  await sleep(1500)
  check('and after leaving full screen', fits(await state(app)), JSON.stringify(await state(app)))
  await back(app, page)

  console.log('\n5. server stops, then its row after a restart')
  yaac('server', 'stop')
  page = await openOverlay(app, win).catch(() => null)
  if (page) {
    await page.evaluate(() => document.getElementById('back').click())
    await until(async () => (await state(app)).windowUrl.startsWith('data:'), 60_000, 'the splash under the page')
    const s = await state(app)
    check('the window under the page is a data: splash', s.windowUrl.startsWith('data:') && s.views.length === 1, JSON.stringify(s))
    yaac('server', 'start')
    page = await overlayPage(app)
    await page.evaluate(() => document.querySelector('#install-server button.connect, #install-server button.start').click())
    await until(() => win.evaluate((o) => location.origin === o, origin), 60_000, 'the SPA again')
    await until(async () => (await state(app)).views.length === 0, 10_000, 'no overlay')
    check('the server\'s row restores the SPA with no overlay', true)
  }

  await Promise.race([app.close().catch(() => {}), sleep(5000)])
  try { app.process().kill('SIGKILL') } catch { /* gone */ }
}

main()
  .catch((err) => {
    console.error(`\nFAILED: ${err.stack}`)
    process.exitCode = 1
  })
  .finally(() => {
    try { yaac('server', 'stop') } catch { /* already stopped */ }
    fs.rmSync(DATA_DIR, { recursive: true, force: true })
    fs.rmSync(CLIENT_DIR, { recursive: true, force: true })
    finish()
  })
