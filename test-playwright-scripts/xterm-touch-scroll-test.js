#!/usr/bin/env node
/*
 * xterm-touch-scroll-test.js
 *
 * Verifies that a one-finger swipe scrolls a tmux pane on a touch device —
 * the behavior packages/frontend/src/lib/touch-scroll.ts exists to provide —
 * in a real headless Chromium against a real tmux, with no cluster or server.
 *
 * It matters here rather than in a unit test because every part of the claim
 * is a browser fact jsdom cannot have an opinion about: that xterm ships no
 * touch handling of its own, that a touch pan synthesizes no wheel event, that
 * `touch-action: none` is what lets a touchmove be canceled, and that
 * canceling it also suppresses the compatibility click (so a swipe cannot also
 * press whatever it started over — patchClickForwarding would hand that to the
 * TUI).
 *
 * The pipeline is the real @xterm/xterm bundle, with the real touch-scroll
 * source bundled from disk at runtime, over a WS bridge into a `tmux attach`
 * running with `mouse on` — so a swipe scrolls only if it becomes an SGR wheel
 * report tmux acts on. Chromium runs in a phone-sized touch context and the
 * gestures are dispatched through CDP as real touch input.
 *
 * Checks (PASS/FAIL per line):
 *   - unpatched, a swipe scrolls nothing and synthesizes no wheel (the bug);
 *   - patched, a swipe down reveals earlier history, and back up returns to
 *     the live bottom of the pane;
 *   - patched, a swipe fires no click, while a tap still fires exactly one;
 *   - a swipe under the slop threshold is left alone entirely.
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
// The prebuilt in-pod pty binding (the session image ships it built).
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

// ── tmux with mouse reporting and a deep history ────────────────────────────
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'touch-scroll-'))
const SOCK = path.join(stage, 'tmux.sock')
sh(`tmux -S ${SOCK} -f /dev/null new-session -d -s touch -x 120 -y 40`)
sh(`tmux -S ${SOCK} set-option -g history-limit 50000 \\; set-option -g mouse on \\; set-option -g status off`)
// No trailing `clear`: its E3 erase would wipe the very scrollback the swipe
// has to reveal.
sh(`tmux -S ${SOCK} send-keys -t touch "seq -f 'history line %g' 1 ${HISTORY_LINES}" Enter`)
await sleep(2500)

// ── Bundle the real touch-scroll source for the browser ─────────────────────
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

// The one CSS rule the handler depends on, taken from the app's own
// stylesheet rather than restated — a swipe is only cancelable if the browser
// was told not to pan (see index.css). Whatever value is in there is what gets
// tested: the invariant is that one-finger touchmoves stay cancelable, which
// the run below measures rather than assuming from the keyword.
const appCss = fs.readFileSync(path.join(FRONTEND, 'src/index.css'), 'utf8')
const touchActionRule = appCss.match(/\.xterm\s*\{[^}]*touch-action:[^}]*\}/)?.[0]
const touchActionValue = touchActionRule?.match(/touch-action:\s*([^;}]+)/)?.[1].trim()
check(!!touchActionRule, 'index.css sets touch-action on .xterm', `touch-action: ${touchActionValue}`)

// ── Harness page ────────────────────────────────────────────────────────────
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
  // A touchmove the browser has already claimed for its own panning arrives
  // uncancelable — which is the failure this whole CSS rule exists to prevent.
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

// ── Browser ─────────────────────────────────────────────────────────────────
const browser = await pw.chromium.launch()
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
})

/** Open a page (patched or not) and wait for the attach redraw to go quiet. */
async function open(patch) {
  // Leave copy mode so every run scrolls from the same bottom-of-history
  // baseline.
  try { sh(`tmux -S ${SOCK} send-keys -t touch -X cancel`) } catch { /* not in copy mode */ }
  const page = await ctx.newPage()
  const cdp = await ctx.newCDPSession(page)
  await page.goto(`http://127.0.0.1:${httpPort}/?patch=${patch ? 1 : 0}`)
  await page.waitForFunction(() => window.__m.ready, { timeout: 10_000 })
  await sleep(1500)
  check(!(await page.evaluate(() => window.__m.patchFailed)), `patch installed (patch=${patch ? 1 : 0})`)
  return { page, cdp }
}

/** Drag one finger `dy` px from the middle of the screen (positive = down). */
async function swipe(cdp, dy, { steps = 20, id = 1 } = {}) {
  const x = 195
  let y = dy > 0 ? 250 : 600
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id }] })
  for (let i = 0; i < steps; i++) {
    y += dy / steps
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id }] })
    await sleep(16)
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await sleep(900) // let the reports round-trip and tmux redraw
}

async function tap(cdp) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: 400, id: 9 }] })
  await sleep(60)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await sleep(300)
}

/** The lowest `history line N` visible, which is where in the history the
 *  pane is sitting. */
const topLine = (rows) => {
  for (const r of rows) {
    const m = r.match(/history line (\d+)/)
    if (m) return Number(m[1])
  }
  return null
}

// ── 1. Unpatched: the bug ───────────────────────────────────────────────────
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
  // Not a check: with no handler to claim it, Chromium marks every move after
  // the first uncancelable regardless of the touch-action value — which is why
  // cancelability is only meaningful to assert on the patched page below.
  console.log(`      (unclaimed gesture: ${m.uncancelable}/${m.touchmoves} moves uncancelable)`)
  await page.close()
}

// ── 2. Patched: the swipe scrolls, and comes back ───────────────────────────
{
  const { page, cdp } = await open(true)
  const bottom = topLine(await page.evaluate(() => window.__screen()))
  await swipe(cdp, 400)
  const scrolled = topLine(await page.evaluate(() => window.__screen()))
  check(scrolled !== null && bottom !== null && scrolled < bottom,
    'patched: a swipe down reveals earlier history', `top line ${bottom} → ${scrolled}`)
  // ~400px of travel at a 5-line report every ~5 cell-heights is roughly one
  // screen; assert the order of magnitude, not an exact line count.
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

  // Under the slop the gesture is left entirely alone.
  const atRest = topLine(await page.evaluate(() => window.__screen()))
  await swipe(cdp, 6, { steps: 3 })
  const afterNudge = topLine(await page.evaluate(() => window.__screen()))
  check(afterNudge === atRest, 'patched: a sub-slop nudge scrolls nothing',
    `top line ${atRest} → ${afterNudge}`)

  // The discriminating case for the CSS value. A drag that creeps through the
  // slop leaves the first moves unclaimed, which is the browser's cue to
  // decide the gesture is its own — under any touch-action that still permits
  // it something, every later move then arrives uncancelable and the rest of
  // the swipe is lost. Under a value that permits nothing, the handler picks
  // it up at the slop and scrolls normally.
  await page.evaluate(() => { window.__m.uncancelable = 0; window.__m.touchmoves = 0 })
  const beforeCreep = topLine(await page.evaluate(() => window.__screen()))
  await swipe(cdp, 400, { steps: 100 }) // 4px a move — the first two are sub-slop
  const afterCreep = topLine(await page.evaluate(() => window.__screen()))
  const creep = await page.evaluate(() => window.__m)
  check(creep.uncancelable === 0, 'patched: a slow drag stays cancelable throughout',
    `${creep.uncancelable}/${creep.touchmoves} uncancelable`)
  check(afterCreep !== null && beforeCreep !== null && beforeCreep - afterCreep >= 10,
    'patched: a drag that creeps through the slop still scrolls',
    `top line ${beforeCreep} → ${afterCreep}`)
  await page.close()
}

await browser.close()
server.close()
wss.close()
try { sh(`tmux -S ${SOCK} kill-server`) } catch { /* already gone */ }
fs.rmSync(stage, { recursive: true, force: true })

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
