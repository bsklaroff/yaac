#!/usr/bin/env node
/*
 * scroll-wheel-pipeline-test.js
 *
 * Verifies the two tmux-scroll optimizations end-to-end in a real headless
 * Chromium against a real tmux, without needing a cluster or a session:
 *
 *   1. streamd output micro-batching (dockerfiles/streamd/batcher.js): the
 *      same wheel gesture must produce fewer, larger pty data messages from
 *      the workspace streamd than from the pre-change copy baked into the
 *      session image at /opt/yaac/streamd.
 *   2. frontend wheel pacing (packages/frontend/src/lib/wheel-pacing.ts,
 *      bundled from source at runtime): a fast flick's wheel reports must be
 *      released at a bounded per-frame rate with a capped backlog, so the
 *      pane stops scrolling when the gesture stops.
 *
 * The reproduced pipeline is xterm.js (the real @xterm/xterm bundle, with
 * tmux `mouse on` driving SGR wheel reports) <-WS-> an in-script bridge that
 * mimics the server's per-frame WS forwarding and adds LINK_DELAY_MS of
 * one-way latency <-frame codec-> streamd `pty` stream -> `tmux attach`.
 * Three configs isolate the changes: old streamd + stock wheel (shipped
 * baseline), new streamd + stock wheel (batching alone), new streamd + paced
 * wheel (the full change). Prints per-config metrics and PASS/FAIL:
 *   - bytes(old) ≈ bytes(new-unpaced) while messages drop (batching merges,
 *     never adds);
 *   - paced report rate is bounded (≤ ~2/frame + backlog) and few reports
 *     trail the gesture end;
 *   - every config really scrolls (copy-mode history visible on screen).
 *
 * Run (inside a yaac dev session; needs tmux and /opt/yaac/streamd for the
 * old daemon + prebuilt node-pty):
 *   node test-playwright-scripts/scroll-wheel-pipeline-test.js
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
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
const OLD_STREAMD = '/opt/yaac/streamd'
// pnpm strict node_modules: xterm resolves only from the frontend package.
const FRONTEND = path.join(WORKSPACE, 'packages/frontend')
const XTERM_DIR = path.dirname(require.resolve('@xterm/xterm/package.json', { paths: [FRONTEND] }))
const FIT_DIR = path.dirname(require.resolve('@xterm/addon-fit/package.json', { paths: [FRONTEND] }))

const LINK_DELAY_MS = 30 // one-way; stands in for the relay/port-forward hops
const WHEEL_EVENTS = 40 // one hard flick
const HISTORY_LINES = 8000
const QUIET_MS = 1200

const sh = (cmd) => execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── Stage the new streamd where its node-pty resolves (prebuilt in-pod) ─────
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-pipeline-'))
const NEW_STREAMD = path.join(stage, 'new')
fs.mkdirSync(NEW_STREAMD)
for (const f of ['streamd.js', 'framing.js', 'batcher.js']) {
  fs.copyFileSync(path.join(WORKSPACE, 'dockerfiles/streamd', f), path.join(NEW_STREAMD, f))
}
fs.copyFileSync(path.join(OLD_STREAMD, 'package.json'), path.join(NEW_STREAMD, 'package.json'))
fs.symlinkSync(path.join(OLD_STREAMD, 'node_modules'), path.join(NEW_STREAMD, 'node_modules'))

// ── Bundle the real wheel-pacing source for the browser ─────────────────────
const esbuildDir = fs.readdirSync(path.join(WORKSPACE, 'node_modules/.pnpm'))
  .find((d) => d.startsWith('esbuild@'))
const esbuild = require(path.join(WORKSPACE, 'node_modules/.pnpm', esbuildDir, 'node_modules/esbuild'))
const pacingBundle = (await esbuild.build({
  entryPoints: [path.join(WORKSPACE, 'packages/frontend/src/lib/wheel-pacing.ts')],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'WheelPacing',
})).outputFiles[0].text

// ── Per-variant tmux + streamd daemons ──────────────────────────────────────
const daemons = {} // variant -> { port, sock, close }
async function startVariant(variant, moduleDir) {
  const { createStreamd } = await import(path.join(moduleDir, 'streamd.js'))
  const sock = path.join(stage, `tmux-${variant}.sock`)
  sh(`tmux -S ${sock} -f /dev/null new-session -d -s bench -x 200 -y 50`)
  sh(`tmux -S ${sock} set-option -g history-limit 50000 \\; set-option -g mouse on \\; set-option -g status off`)
  // No trailing `clear`: its E3 erase wipes the very scrollback the wheel
  // gesture needs to reveal.
  sh(`tmux -S ${sock} send-keys -t bench "seq -f 'history line %g :: abcdefghijklmnopqrstuvwxyz 0123456789' 1 ${HISTORY_LINES}" Enter`)
  const daemon = createStreamd({ token: 'bench', port: 0, host: '127.0.0.1' })
  const port = await daemon.listen()
  daemons[variant] = {
    port,
    sock,
    close: async () => {
      await daemon.close()
      try { sh(`tmux -S ${sock} kill-server`) } catch { /* already gone */ }
    },
  }
}
await startVariant('old', OLD_STREAMD)
await startVariant('new', NEW_STREAMD)
await sleep(3000) // let both seq fills finish

// The frame codec (identical old/new; use the workspace copy).
const { FrameParser, encodeFrame, FRAME_DATA } = await import(path.join(NEW_STREAMD, 'framing.js'))

// ── Harness page ─────────────────────────────────────────────────────────────
const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/xterm.css">
<style>html,body{margin:0;height:100%;background:#000}#t{height:100%}</style>
</head><body><div id="t"></div>
<script src="/xterm.js"></script>
<script src="/addon-fit.js"></script>
<script src="/pacing.js"></script>
<script>
  const params = new URLSearchParams(location.search)
  const m = window.__m = { recv: [], sent: [], gestureStart: 0, gestureEnd: 0, ready: false }
  const term = new Terminal({ fontSize: 13, fontFamily: 'monospace', cursorBlink: true })
  const fit = new FitAddon.FitAddon()
  term.loadAddon(fit)
  term.open(document.getElementById('t'))
  fit.fit()
  window.__term = term
  if (params.get('pacing') === '1') {
    if (!WheelPacing.patchWheelPacing(term)) m.pacingFailed = true
  }
  const dec = new TextDecoder('utf-8', { fatal: false })
  const count = (s, n) => s.split(n).length - 1
  const ws = new WebSocket(
    'ws://' + location.host + '/pty?variant=' + params.get('variant')
    + '&cols=' + term.cols + '&rows=' + term.rows)
  ws.binaryType = 'arraybuffer'
  ws.onmessage = (e) => {
    const bytes = new Uint8Array(e.data)
    const text = dec.decode(bytes)
    m.recv.push({ t: performance.now(), bytes: bytes.length,
      torn: count(text, '\\x1b[?25l') !== count(text, '\\x1b[?25h') })
    term.write(bytes)
  }
  ws.onopen = () => { m.ready = true }
  const enc = new TextEncoder()
  term.onData((d) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(enc.encode(d))
      if (d.includes('\\x1b[<')) m.sent.push({ t: performance.now(), len: d.length })
    }
  })
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
  else if (url.pathname === '/pacing.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' })
    res.end(pacingBundle)
  } else {
    res.writeHead(404)
    res.end()
  }
})

// WS bridge: one message per pty data frame (as the production bridge sends),
// with LINK_DELAY_MS of one-way delay each direction (FIFO timers keep order).
const { WebSocketServer } = require('ws')
const wss = new WebSocketServer({ server })
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x')
  const { port, sock } = daemons[url.searchParams.get('variant')]
  const cols = Number(url.searchParams.get('cols')) || 80
  const rows = Number(url.searchParams.get('rows')) || 24
  const conn = net.connect(port, '127.0.0.1')
  conn.setNoDelay(true)
  const parser = new FrameParser()
  let sawReply = false
  let buf = Buffer.alloc(0)
  conn.on('connect', () => {
    conn.write(JSON.stringify({
      token: 'bench', kind: 'pty',
      cmd: ['tmux', '-S', sock, 'attach-session', '-t', 'bench'],
      cols, rows,
    }) + '\n')
  })
  conn.on('data', (chunk) => {
    if (!sawReply) {
      buf = Buffer.concat([buf, chunk])
      const nl = buf.indexOf(0x0a)
      if (nl < 0) return
      sawReply = true
      chunk = buf.subarray(nl + 1)
      if (chunk.length === 0) return
    }
    for (const f of parser.feed(chunk)) {
      if (f.type !== FRAME_DATA) continue
      const payload = f.payload
      setTimeout(() => { if (ws.readyState === 1) ws.send(payload) }, LINK_DELAY_MS)
    }
  })
  ws.on('message', (data) => {
    setTimeout(() => conn.write(encodeFrame(FRAME_DATA, Buffer.from(data))), LINK_DELAY_MS)
  })
  ws.on('close', () => conn.destroy())
  conn.on('close', () => { try { ws.close() } catch { /* closed */ } })
  conn.on('error', () => { try { ws.close() } catch { /* closed */ } })
})
const httpPort = await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port))
})

// ── Drive one config in the browser and collect its metrics ─────────────────
async function runConfig(browser, { variant, pacing, label }) {
  // Configs sharing a variant share its tmux server: leave copy mode so each
  // run scrolls from the same bottom-of-history baseline.
  try { sh(`tmux -S ${daemons[variant].sock} send-keys -t bench -X cancel`) } catch { /* not in copy mode */ }
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  await page.goto(`http://127.0.0.1:${httpPort}/?variant=${variant}&pacing=${pacing ? 1 : 0}`)
  await page.waitForFunction(() => window.__m.ready, { timeout: 10_000 })
  // Wait for the attach redraw to go quiet.
  await page.waitForFunction(() => {
    const m = window.__m
    return m.recv.length > 0 && performance.now() - m.recv[m.recv.length - 1].t > 800
  }, { timeout: 20_000 })
  if (pacing) {
    const failed = await page.evaluate(() => window.__m.pacingFailed === true)
    if (failed) throw new Error('patchWheelPacing reported missing internals')
  }
  // One hard flick, dispatched in-page: CDP mouse.wheel round-trips are
  // ~30ms each, far slower than a real gesture's event rate. Synthetic
  // WheelEvents hit the same xterm listener (and the same custom handler).
  await page.evaluate(async (events) => {
    const m = window.__m
    m.recv = []
    m.sent = []
    const el = document.querySelector('.xterm-screen')
    const r = el.getBoundingClientRect()
    const opts = {
      deltaY: -120, deltaMode: 0, bubbles: true, cancelable: true,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    }
    m.gestureStart = performance.now()
    for (let i = 0; i < events; i++) {
      el.dispatchEvent(new WheelEvent('wheel', opts))
      await new Promise((res) => setTimeout(res, 2))
    }
    m.gestureEnd = performance.now()
  }, WHEEL_EVENTS)
  await page.waitForFunction((quiet) => {
    const m = window.__m
    const last = Math.max(
      m.recv.length ? m.recv[m.recv.length - 1].t : 0,
      m.sent.length ? m.sent[m.sent.length - 1].t : 0,
      m.gestureEnd)
    return performance.now() - last > quiet
  }, QUIET_MS, { timeout: 30_000 })

  const r = await page.evaluate(() => {
    const m = window.__m
    const topLine = window.__term.buffer.active.getLine(0)?.translateToString(true) ?? ''
    // Peak send rate over any 100ms window (the pacing bound check).
    const times = m.sent.map((s) => s.t).sort((a, b) => a - b)
    let peak100 = 0
    for (let i = 0; i < times.length; i++) {
      let j = i
      while (j < times.length && times[j] - times[i] <= 100) j++
      peak100 = Math.max(peak100, j - i)
    }
    return {
      reportsSent: m.sent.length,
      reportsAfterEnd: m.sent.filter((s) => s.t > m.gestureEnd).length,
      peakReportsPer100ms: peak100,
      gestureMs: Math.round(m.gestureEnd - m.gestureStart),
      recvMessages: m.recv.length,
      recvBytes: m.recv.reduce((a, x) => a + x.bytes, 0),
      avgMessageBytes: m.recv.length
        ? Math.round(m.recv.reduce((a, x) => a + x.bytes, 0) / m.recv.length) : 0,
      tornMessages: m.recv.filter((x) => x.torn).length,
      tailMs: m.recv.length
        ? Math.round(m.recv[m.recv.length - 1].t - m.gestureEnd) : 0,
      topLine: topLine.slice(0, 40),
      // Scrolled = the top row shows a history line well above the tail.
      scrolled: (() => {
        const n = /history line (\d+)/.exec(topLine)
        return n !== null && Number(n[1]) < 7900
      })(),
    }
  })
  fs.mkdirSync('/tmp/yaac-shots', { recursive: true })
  await page.screenshot({ path: `/tmp/yaac-shots/scroll-pipeline-${variant}-${pacing ? 'paced' : 'stock'}.png` })
  await page.close()
  return { label, ...r }
}

const browser = await pw.chromium.launch()
let failures = 0
try {
  const configs = [
    { variant: 'old', pacing: false, label: 'old streamd + stock wheel (shipped)' },
    { variant: 'new', pacing: false, label: 'new streamd + stock wheel (batching only)' },
    { variant: 'new', pacing: true, label: 'new streamd + paced wheel (full change)' },
  ]
  const results = []
  for (const c of configs) results.push(await runConfig(browser, c))
  const [oldStock, newStock, newPaced] = results

  console.log(JSON.stringify(results, null, 2))
  const check = (name, ok) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
    if (!ok) failures++
  }
  check('every config scrolled into history', results.every((r) => r.scrolled))
  check(`batching cuts message count (${oldStock.recvMessages} -> ${newStock.recvMessages})`,
    newStock.recvMessages < oldStock.recvMessages)
  check(`batching does not inflate bytes (${oldStock.recvBytes} -> ${newStock.recvBytes})`,
    newStock.recvBytes < oldStock.recvBytes * 1.15)
  check(`batching does not tear more cursor toggles (${oldStock.tornMessages} -> ${newStock.tornMessages})`,
    newStock.tornMessages <= oldStock.tornMessages)
  // 2/frame @60Hz ≈ 12 per 100ms; allow headroom for frame jitter.
  check(`pacing bounds the report rate (peak/100ms ${newStock.peakReportsPer100ms} -> ${newPaced.peakReportsPer100ms})`,
    newPaced.peakReportsPer100ms <= 16 && newPaced.peakReportsPer100ms < newStock.peakReportsPer100ms)
  check(`paced backlog stays capped after the gesture (${newPaced.reportsAfterEnd} trailing reports)`,
    newPaced.reportsAfterEnd <= 8)
  check(`pacing drops the over-rate excess of a hard flick (${newStock.reportsSent} -> ${newPaced.reportsSent})`,
    newPaced.reportsSent < newStock.reportsSent)
} finally {
  await browser.close()
  server.close()
  for (const d of Object.values(daemons)) await d.close()
  fs.rmSync(stage, { recursive: true, force: true })
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
