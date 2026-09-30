#!/usr/bin/env node
/*
 * scroll-wheel-pipeline-test.js
 *
 * Verifies frontend wheel pacing (packages/frontend/src/lib/wheel-pacing.ts,
 * bundled from source) end-to-end in headless Chromium against a real tmux,
 * with no server or workspace: a fast flick's wheel reports are sent at a
 * bounded per-frame rate with a capped backlog, so scrolling stops when the
 * gesture stops.
 *
 * Pipeline: xterm.js (tmux `mouse on` sends SGR wheel reports) <-WS-> an
 * in-script bridge that forwards like the server and adds LINK_DELAY_MS of
 * one-way latency <-frame codec-> this checkout's streamd `pty` stream
 * (dockerfiles/streamd) -> `tmux attach`. Two configs, stock and paced
 * wheel, compared on the same pipeline. Output batching in streamd has its
 * own unit test (dockerfiles/streamd/test/batcher.test.ts).
 *
 * Run (inside a yaac dev session; needs tmux, and /opt/yaac/streamd for its
 * prebuilt node-pty):
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

// Stage this checkout's streamd beside the baked copy's prebuilt node-pty.
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-pipeline-'))
const STREAMD = path.join(stage, 'streamd')
fs.cpSync(path.join(WORKSPACE, 'dockerfiles/streamd'), STREAMD, { recursive: true })
fs.symlinkSync('/opt/yaac/streamd/node_modules', path.join(STREAMD, 'node_modules'))

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

const { createStreamd } = await import(path.join(STREAMD, 'streamd.js'))
const { FrameParser, encodeFrame, FRAME_DATA } = await import(path.join(STREAMD, 'framing.js'))
const sock = path.join(stage, 'tmux.sock')
sh(`tmux -S ${sock} -f /dev/null new-session -d -s bench -x 200 -y 50`)
sh(`tmux -S ${sock} set-option -g history-limit 50000 \\; set-option -g mouse on \\; set-option -g status off`)
// No trailing `clear`: it would wipe the scrollback the test scrolls into.
sh(`tmux -S ${sock} send-keys -t bench "seq -f 'history line %g :: abcdefghijklmnopqrstuvwxyz 0123456789' 1 ${HISTORY_LINES}" Enter`)
const daemon = createStreamd({ token: 'bench', port: 0, host: '127.0.0.1' })
const port = await daemon.listen()
await sleep(3000) // let the `seq` fill finish

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
  const ws = new WebSocket(
    'ws://' + location.host + '/pty?cols=' + term.cols + '&rows=' + term.rows)
  ws.binaryType = 'arraybuffer'
  ws.onmessage = (e) => {
    m.recv.push({ t: performance.now() })
    term.write(new Uint8Array(e.data))
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

// WS bridge: one message per pty data frame, as the server sends, delayed
// LINK_DELAY_MS each way (FIFO timers keep order).
const { WebSocketServer } = require('ws')
const wss = new WebSocketServer({ server })
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x')
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

// Drives one config in the browser and collects its metrics.
async function runConfig(browser, pacing) {
  // Leave copy mode so each run starts from the bottom.
  try { sh(`tmux -S ${sock} send-keys -t bench -X cancel`) } catch { /* not in copy mode */ }
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  await page.goto(`http://127.0.0.1:${httpPort}/?pacing=${pacing ? 1 : 0}`)
  await page.waitForFunction(() => window.__m.ready, { timeout: 10_000 })
  await page.waitForFunction(() => {
    const m = window.__m
    return m.recv.length > 0 && performance.now() - m.recv[m.recv.length - 1].t > 800
  }, { timeout: 20_000 })
  if (pacing) {
    const failed = await page.evaluate(() => window.__m.pacingFailed === true)
    if (failed) throw new Error('patchWheelPacing reported missing internals')
  }
  // Dispatch the flick in-page: CDP mouse.wheel takes ~30ms per event, far
  // slower than a real gesture. Synthetic WheelEvents hit the same handlers.
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
    // Peak send count over any 100ms window.
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
      tailMs: m.recv.length
        ? Math.round(m.recv[m.recv.length - 1].t - m.gestureEnd) : 0,
      topLine: topLine.slice(0, 40),
      scrolled: (() => {
        const n = /history line (\d+)/.exec(topLine)
        return n !== null && Number(n[1]) < 7900
      })(),
    }
  })
  await page.close()
  return { label: pacing ? 'paced wheel' : 'stock wheel', ...r }
}

const browser = await pw.chromium.launch()
let failures = 0
try {
  const results = [await runConfig(browser, false), await runConfig(browser, true)]
  const [stock, paced] = results
  console.log(JSON.stringify(results, null, 2))
  const check = (name, ok) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
    if (!ok) failures++
  }
  check('every config scrolled into history', results.every((r) => r.scrolled))
  // 2/frame @60Hz ≈ 12 per 100ms; allow headroom for frame jitter.
  check(`pacing bounds the report rate (peak/100ms ${stock.peakReportsPer100ms} -> ${paced.peakReportsPer100ms})`,
    paced.peakReportsPer100ms <= 16 && paced.peakReportsPer100ms < stock.peakReportsPer100ms)
  check(`paced backlog stays capped after the gesture (${paced.reportsAfterEnd} trailing reports)`,
    paced.reportsAfterEnd <= 8)
  check(`pacing drops the over-rate excess of a hard flick (${stock.reportsSent} -> ${paced.reportsSent})`,
    paced.reportsSent < stock.reportsSent)
} finally {
  await browser.close()
  server.close()
  await daemon.close()
  try { sh(`tmux -S ${sock} kill-server`) } catch { /* already gone */ }
  fs.rmSync(stage, { recursive: true, force: true })
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
