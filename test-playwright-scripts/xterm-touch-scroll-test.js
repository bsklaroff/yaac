#!/usr/bin/env node
/*
 * xterm-touch-scroll-test.js
 *
 * Verifies that a one-finger swipe scrolls a tmux pane on a touch device
 * (packages/frontend/src/lib/touch-scroll.ts), in headless Chromium against a
 * real tmux, with no cluster or server.
 *
 * This can't be a jsdom unit test: it depends on browser behavior. xterm has
 * no touch handling, a touch pan produces no wheel event, a touchmove is
 * only cancelable under `touch-action: none`, and canceling it also
 * suppresses the compatibility click (otherwise patchClickForwarding would
 * send the swipe to the TUI as a click).
 *
 * Pipeline: the real xterm.js with touch-scroll.ts bundled from source, over
 * a WS bridge to `tmux attach` with `mouse on`, so a swipe scrolls only if it
 * becomes an SGR wheel report tmux acts on. Chromium runs in a phone-sized
 * touch context and gestures are sent through CDP as real touch input.
 *
 * Checks:
 *   - unpatched, a swipe scrolls nothing and produces no wheel event;
 *   - patched, swiping down reveals earlier history and swiping up returns
 *     to the bottom;
 *   - patched, a swipe fires no click, and a tap fires exactly one;
 *   - a swipe under the slop threshold is ignored;
 *   - a flick glides well past a held drag of the same length, and a tap
 *     during the glide stops it without a click.
 *
 * Run (inside a yaac dev session; needs tmux and /opt/yaac/streamd for the
 * prebuilt node-pty):
 *   node test-playwright-scripts/xterm-touch-scroll-test.js
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync('/opt/playwright-browsers')) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/playwright-browsers'
}
const pw = (() => {
  try { return require('playwright') } catch {
    return require(path.join(execSync('npm root -g').toString().trim(), 'playwright'))
  }
})()

const WORKSPACE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
// pnpm strict node_modules: xterm resolves only from the frontend package.
const FRONTEND = path.join(WORKSPACE, 'packages/frontend')
const XTERM_DIR = path.dirname(require.resolve('@xterm/xterm/package.json', { paths: [FRONTEND] }))
const FIT_DIR = path.dirname(require.resolve('@xterm/addon-fit/package.json', { paths: [FRONTEND] }))
// node-pty prebuilt in the session image.
const nodePty = require('/opt/yaac/streamd/node_modules/@lydell/node-pty')
const { WebSocketServer } = require('ws')

const HISTORY_LINES = 4000
const sh = (cmd) => execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
}

// tmux with mouse reporting and a deep history.
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'touch-scroll-'))
const SOCK = path.join(stage, 'tmux.sock')
sh(`tmux -S ${SOCK} -f /dev/null new-session -d -s touch -x 120 -y 40`)
sh(`tmux -S ${SOCK} set-option -g history-limit 50000 \\; set-option -g mouse on \\; set-option -g status off`)
// No trailing `clear`: it would wipe the scrollback the swipe reveals.
sh(`tmux -S ${SOCK} send-keys -t touch "seq -f 'history line %g' 1 ${HISTORY_LINES}" Enter`)
await sleep(2500)

const esbuildDir = fs.readdirSync(path.join(WORKSPACE, 'node_modules/.pnpm'))
  .find((d) => d.startsWith('esbuild@'))
const esbuild = require(path.join(WORKSPACE, 'node_modules/.pnpm', esbuildDir, 'node_modules/esbuild'))
const touchBundle = (await esbuild.build({
  entryPoints: [path.join(FRONTEND, 'src/lib/touch-scroll.ts')],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'TouchScroll',
})).outputFiles[0].text

// The handler needs .xterm's touch-action rule, so copy it from the app's
// index.css. The run below checks that touchmoves stay cancelable under
// whatever value it has.
const appCss = fs.readFileSync(path.join(FRONTEND, 'src/index.css'), 'utf8')
const touchActionRule = appCss.match(/\.xterm\s*\{[^}]*touch-action:[^}]*\}/)?.[0]
const touchActionValue = touchActionRule?.match(/touch-action:\s*([^;}]+)/)?.[1].trim()
check(!!touchActionRule, 'index.css sets touch-action on .xterm', `touch-action: ${touchActionValue}`)

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/xterm.css">
<style>
  html,body{margin:0;height:100%;background:#000;overflow:hidden;overscroll-behavior:none}
  #t{height:100%}
  ${touchActionRule ?? ''}
</style>
</head><body><div id="t"></div>
<script src="/xterm.js"></script>
<script src="/addon-fit.js"></script>
<script src="/touch-scroll.js"></script>
<script>
  const params = new URLSearchParams(location.search)
  const m = window.__m = {
    ready: false, clicks: 0, wheels: 0, touchmoves: 0, uncancelable: 0, patchFailed: false,
  }
  const term = new Terminal({ fontSize: 13, fontFamily: 'monospace', cursorBlink: true })
  const fit = new FitAddon.FitAddon()
  term.loadAddon(fit)
  term.open(document.getElementById('t'))
  fit.fit()
  window.__term = term
  if (params.get('patch') === '1') {
    if (!TouchScroll.patchTouchScroll(term)) m.patchFailed = true
  }
  // Counted on the terminal element, where patchClickForwarding listens.
  const el = document.querySelector('.xterm')
  el.addEventListener('click', () => { m.clicks++ })
  el.addEventListener('wheel', () => { m.wheels++ })
  // A touchmove the browser has claimed for panning arrives uncancelable,
  // which the touch-action rule exists to prevent.
  el.addEventListener('touchmove', (e) => {
    m.touchmoves++
    if (!e.cancelable) m.uncancelable++
  }, { passive: true })
  window.__screen = () => {
    const b = term.buffer.active
    const out = []
    for (let y = 0; y < term.rows; y++) {
      out.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? '')
    }
    return out
  }
  const ws = new WebSocket(
    'ws://' + location.host + '/pty?cols=' + term.cols + '&rows=' + term.rows)
  ws.binaryType = 'arraybuffer'
  ws.onmessage = (e) => term.write(new Uint8Array(e.data))
  ws.onopen = () => { m.ready = true }
  const enc = new TextEncoder()
  term.onData((d) => { if (ws.readyState === WebSocket.OPEN) ws.send(enc.encode(d)) })
</script></body></html>`

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const serve = (file, type) => {
    res.writeHead(200, { 'content-type': type })
    res.end(fs.readFileSync(file))
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(PAGE)
  } else if (url.pathname === '/xterm.js') serve(path.join(XTERM_DIR, 'lib/xterm.js'), 'text/javascript')
  else if (url.pathname === '/addon-fit.js') serve(path.join(FIT_DIR, 'lib/addon-fit.js'), 'text/javascript')
  else if (url.pathname === '/xterm.css') serve(path.join(XTERM_DIR, 'css/xterm.css'), 'text/css')
  else if (url.pathname === '/touch-scroll.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' })
    res.end(touchBundle)
  } else {
    res.writeHead(404)
    res.end()
  }
})

const wss = new WebSocketServer({ server })
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x')
  const pty = nodePty.spawn('tmux', ['-S', SOCK, 'attach-session', '-t', 'touch'], {
    name: 'xterm-256color',
    cols: Number(url.searchParams.get('cols')) || 80,
    rows: Number(url.searchParams.get('rows')) || 24,
    env: process.env,
  })
  pty.onData((d) => { if (ws.readyState === 1) ws.send(Buffer.from(d, 'binary')) })
  ws.on('message', (data) => pty.write(Buffer.from(data).toString('binary')))
  ws.on('close', () => { try { pty.kill() } catch { /* gone */ } })
  pty.onExit(() => { try { ws.close() } catch { /* closed */ } })
})
const httpPort = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)))

const browser = await pw.chromium.launch()
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
})

/** Open a page (patched or not) and wait for the attach redraw to go quiet. */
async function open(patch) {
  // Leave copy mode so every run starts from the bottom.
  try { sh(`tmux -S ${SOCK} send-keys -t touch -X cancel`) } catch { /* not in copy mode */ }
  const page = await ctx.newPage()
  const cdp = await ctx.newCDPSession(page)
  await page.goto(`http://127.0.0.1:${httpPort}/?patch=${patch ? 1 : 0}`)
  await page.waitForFunction(() => window.__m.ready, { timeout: 10_000 })
  await sleep(1500)
  check(!(await page.evaluate(() => window.__m.patchFailed)), `patch installed (patch=${patch ? 1 : 0})`)
  return { page, cdp }
}

/** Drags one finger `dy` px (positive = down), holding for `holdMs` before
 *  lifting; the default hold is long enough that no glide follows. Events
 *  carry explicit timestamps 16ms apart, since the handler measures speed by
 *  event time, so CDP latency doesn't affect it. */
async function swipe(cdp, dy, { steps = 20, id = 1, holdMs = 150, settleMs = 900 } = {}) {
  const x = 195
  let y = dy > 0 ? 250 : 600
  let timestamp = Date.now() / 1000
  const send = (type, touchPoints) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints, timestamp })
  await send('touchStart', [{ x, y, id }])
  for (let i = 0; i < steps; i++) {
    y += dy / steps
    timestamp += 0.016
    await send('touchMove', [{ x, y, id }])
    await sleep(16)
  }
  await sleep(holdMs)
  timestamp += Math.max(holdMs, 16) / 1000
  await send('touchEnd', [])
  await sleep(settleMs) // let the reports round-trip and tmux redraw
}

async function tap(cdp) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: 400, id: 9 }] })
  await sleep(60)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await sleep(300)
}

/** The first `history line N` on screen: where in the history the pane is. */
const topLine = (rows) => {
  for (const r of rows) {
    const m = r.match(/history line (\d+)/)
    if (m) return Number(m[1])
  }
  return null
}

// 1. Unpatched: swipes don't scroll.
{
  const { page, cdp } = await open(false)
  const before = topLine(await page.evaluate(() => window.__screen()))
  await swipe(cdp, 400)
  const after = topLine(await page.evaluate(() => window.__screen()))
  const m = await page.evaluate(() => window.__m)
  check(before !== null && after === before, 'unpatched: a swipe scrolls nothing',
    `top line ${before} → ${after}`)
  check(m.touchmoves > 0, 'unpatched: touch events do reach the page', `${m.touchmoves} touchmoves`)
  check(m.wheels === 0, 'unpatched: the browser synthesizes no wheel from touch')
  // Logged, not checked: with no handler, Chromium marks moves after the
  // first uncancelable whatever touch-action says.
  console.log(`      (unclaimed gesture: ${m.uncancelable}/${m.touchmoves} moves uncancelable)`)
  await page.close()
}

// 2. Patched: a swipe scrolls, and scrolls back.
{
  const { page, cdp } = await open(true)
  const bottom = topLine(await page.evaluate(() => window.__screen()))
  await swipe(cdp, 400)
  const scrolled = topLine(await page.evaluate(() => window.__screen()))
  check(scrolled !== null && bottom !== null && scrolled < bottom,
    'patched: a swipe down reveals earlier history', `top line ${bottom} → ${scrolled}`)
  // ~400px is roughly one screen; check the order of magnitude only.
  const moved = bottom - scrolled
  check(moved >= 10 && moved <= 120, 'patched: it scrolls about as far as the finger moved',
    `${moved} lines`)

  const midClicks = (await page.evaluate(() => window.__m)).clicks
  check(midClicks === 0, 'patched: a swipe fires no click', `${midClicks} clicks`)

  await swipe(cdp, -400)
  const back = topLine(await page.evaluate(() => window.__screen()))
  check(back !== null && back >= bottom - 2, 'patched: a swipe up returns to the live bottom',
    `top line ${scrolled} → ${back} (bottom ${bottom})`)

  await tap(cdp)
  const tapped = (await page.evaluate(() => window.__m)).clicks
  check(tapped === 1, 'patched: a tap still fires exactly one click', `${tapped} clicks`)

  const atRest = topLine(await page.evaluate(() => window.__screen()))
  await swipe(cdp, 6, { steps: 3 })
  const afterNudge = topLine(await page.evaluate(() => window.__screen()))
  check(afterNudge === atRest, 'patched: a sub-slop nudge scrolls nothing',
    `top line ${atRest} → ${afterNudge}`)

  // This case tests the touch-action value. A slow drag leaves its first
  // moves unclaimed; if touch-action permits any panning, the browser then
  // takes the gesture and later moves are uncancelable. With `none`, the
  // handler picks it up at the slop and scrolls.
  await page.evaluate(() => { window.__m.uncancelable = 0; window.__m.touchmoves = 0 })
  const beforeCreep = topLine(await page.evaluate(() => window.__screen()))
  await swipe(cdp, 400, { steps: 100 }) // 4px per move; the first two are sub-slop
  const afterCreep = topLine(await page.evaluate(() => window.__screen()))
  const creep = await page.evaluate(() => window.__m)
  check(creep.uncancelable === 0, 'patched: a slow drag stays cancelable throughout',
    `${creep.uncancelable}/${creep.touchmoves} uncancelable`)
  check(afterCreep !== null && beforeCreep !== null && beforeCreep - afterCreep >= 10,
    'patched: a drag that creeps through the slop still scrolls',
    `top line ${beforeCreep} → ${afterCreep}`)
  await page.close()
}

// 3. Patched: a flick glides, and a tap stops the glide.
{
  const { page, cdp } = await open(true)
  const bottom = topLine(await page.evaluate(() => window.__screen()))
  await swipe(cdp, 200, { steps: 8 }) // held: a drag
  const dragged = topLine(await page.evaluate(() => window.__screen()))
  const dragLines = bottom - dragged
  // Same travel, lifted while moving (~1.5px/ms).
  await swipe(cdp, 200, { steps: 8, holdMs: 0, settleMs: 3000 })
  const flicked = topLine(await page.evaluate(() => window.__screen()))
  const flickLines = dragged - flicked
  check(dragLines > 0 && flickLines >= dragLines * 3,
    'patched: a flick glides on well past the same drag', `drag ${dragLines} lines, flick ${flickLines} lines`)

  // Flick again and tap mid-glide, but only after confirming it is gliding,
  // so the stop and no-click checks are meaningful.
  const clicks = (await page.evaluate(() => window.__m)).clicks
  await swipe(cdp, 200, { steps: 8, holdMs: 0, settleMs: 150 })
  const gliding = topLine(await page.evaluate(() => window.__screen()))
  await sleep(100)
  const stillGliding = topLine(await page.evaluate(() => window.__screen()))
  const glided = gliding !== null && stillGliding !== null
    && flicked - stillGliding > dragLines && stillGliding < gliding
  check(glided, 'patched: the second flick is still gliding before the tap',
    `top line ${flicked} → ${gliding} → ${stillGliding}`)
  if (glided) {
    await tap(cdp)
    const caught = topLine(await page.evaluate(() => window.__screen()))
    await sleep(2000)
    const later = topLine(await page.evaluate(() => window.__screen()))
    check(later === caught, 'patched: a tap stops a glide where it is', `top line ${caught} → ${later}`)
    const tapClicks = (await page.evaluate(() => window.__m)).clicks - clicks
    check(tapClicks === 0, 'patched: the tap that stops a glide fires no click', `${tapClicks} clicks`)
  }
  await page.close()
}

await browser.close()
server.close()
wss.close()
try { sh(`tmux -S ${SOCK} kill-server`) } catch { /* already gone */ }
fs.rmSync(stage, { recursive: true, force: true })

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
