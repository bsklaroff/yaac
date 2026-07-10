/*
 * Verifies a freshly attached session terminal starts with the agent's
 * bottom line visible and that typing reveals nothing new. The bug this
 * guards against ("sessions — especially prewarmed ones — start ever so
 * slightly scrolled down; the bottom line appears when you type"): the old
 * attach shape created the view session *attached*, so the shared window
 * resized twice (client rows-1 with the default status bar, then client
 * rows after `status off`); tmux's shrink discards the row below the
 * agent's cursor (Claude's bottom hint line) and the grow restores a
 * history line at the top instead, shifting the screen down a row — healed
 * only if the agent notices a net size change and repaints. Fixed in
 * pty-bridge attachArgs (detached create, status off first, then attach).
 *
 * Note the xterm layer can't be the culprit: the tmux client holds the
 * alternate screen buffer for the whole attach, so viewportY === baseY === 0
 * always (also asserted here). This reads Terminal objects via the
 * window.__xterms hook SessionTerminal exposes (xterm 6 mirrors no scroll
 * state into the DOM). Per trial it opens the webapp on the session (deep
 * link via ?project=&session=), rAF-samples opacity + viewportY/baseY, logs
 * /pty/attach WS binary frames, captures the last buffer rows before and
 * after a keypress, and fails if the keypress changes them. Between trials
 * the tmux window is resized back to the oversized 500x200 (kubectl exec)
 * so every attach replays the prewarmed-style shrink of a painted screen.
 *
 * Run: node test-playwright-scripts/xterm-attach-scroll-pin-test.js <sessionId>|claim [trials] [dpr] [viewportWxH]
 * e.g. node test-playwright-scripts/xterm-attach-scroll-pin-test.js <id> 5 2 900x520
 * With `claim`, each trial claims a prewarmed spare via POST /session/create
 * (the real "+ New session" fast path), samples its first attach, saves
 * before/after-keypress screenshots to the script's directory, and deletes
 * the session afterwards; trials wait for the pool to respawn a spare.
 * Needs a running server and an existing session for <sessionId> whose agent
 * has booted. Reads port/secret from $YAAC_DATA_DIR/.server.lock (or ~/.yaac).
 * (playwright resolved from the global npm root; browsers under
 * /opt/playwright-browsers)
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)

function requirePlaywright() {
  try {
    return require('playwright')
  } catch {
    const globalRoot = execSync('npm root -g').toString().trim()
    return require(path.join(globalRoot, 'playwright'))
  }
}

function readServerLock() {
  const candidates = [
    process.env.YAAC_DATA_DIR && path.join(process.env.YAAC_DATA_DIR, '.server.lock'),
    path.join(os.homedir(), '.yaac', '.server.lock'),
  ].filter(Boolean)
  for (const p of candidates) {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'))
  }
  throw new Error(`no .server.lock found (tried ${candidates.join(', ')}) — is the server running?`)
}

const TMUX = 'tmux -S /tmp/yaac-tmux/server'

function podName(sessionId) {
  const out = execSync(
    `kubectl get pods -n yaac -l batch.kubernetes.io/job-name=yaac-yaac-${sessionId}`
    + ` -o jsonpath='{.items[0].metadata.name}'`,
  ).toString().trim()
  if (!out) throw new Error(`no pod found for session ${sessionId}`)
  return out
}

/** Reset the session's tmux window to the oversized prewarm dims and restore
 *  automatic (latest-client) sizing so the next attach re-runs the shrink. */
function resetWindow(pod) {
  execSync(
    `kubectl exec -n yaac ${pod} -c session -- sh -c "${TMUX} resize-window -t yaac:^ -x 500 -y 200`
    + ` && ${TMUX} set-option -w -t yaac:^ window-size latest"`,
  )
}

function windowSize(pod) {
  return execSync(
    `kubectl exec -n yaac ${pod} -c session -- sh -c "${TMUX} display -p -t yaac:^`
    + ` '#{window_width}x#{window_height}'"`,
  ).toString().trim()
}

/** Claim a prewarmed spare via the server API; returns its sessionId. */
async function claimSpare(base, auth) {
  const res = await fetch(`${base}/session/create`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ project: 'yaac' }),
  })
  if (!res.ok) throw new Error(`create failed: HTTP ${res.status}`)
  for (const line of (await res.text()).trim().split('\n')) {
    const ev = JSON.parse(line)
    if (ev.type === 'error') throw new Error(`create failed: ${ev.error.message}`)
    if (ev.type === 'result') return ev.result.sessionId
  }
  throw new Error('create stream ended without a result')
}

async function deleteSession(base, auth, sessionId) {
  await fetch(`${base}/session/delete`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  }).catch(() => {})
}

async function waitForSpare(base, auth) {
  for (let i = 0; i < 60; i++) {
    const out = execSync(
      'kubectl get pods -n yaac -l yaac.prewarmed=true'
      + ` -o jsonpath='{range .items[*]}{.status.phase}{"\\n"}{end}'`,
    ).toString()
    if (out.split('\n').includes('Running')) return
    await new Promise((r) => setTimeout(r, 5000))
  }
  throw new Error('no prewarmed spare became Running within 5min')
}

async function runTrial(browser, base, code, sessionId, label, dpr, vw, vh, shotPrefix) {
  const page = await browser.newPage({
    viewport: { width: vw, height: vh },
    deviceScaleFactor: dpr,
    bypassCSP: true,
  })
  page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))
  try {
    await page.addInitScript(() => {
      // Log every /pty/attach binary frame (time + size) without disturbing
      // the app's own handler: intercept the onmessage assignment and
      // dispatch through a wrapping listener.
      const OrigWS = window.WebSocket
      window.__wsFrames = []
      window.WebSocket = class extends OrigWS {
        constructor(...args) {
          super(...args)
          if (String(args[0]).includes('/pty/attach')) {
            let handler = null
            Object.defineProperty(this, 'onmessage', {
              set: (fn) => { handler = fn },
              get: () => handler,
              configurable: true,
            })
            this.addEventListener('message', (e) => {
              if (typeof e.data !== 'string') {
                window.__wsFrames.push({ t: performance.now(), bytes: e.data.byteLength })
              }
              if (handler) handler.call(this, e)
            })
          }
        }
      }
      // rAF-sample the first terminal SessionTerminal exposes; subscribe to
      // its scroll/resize events for exact ordering.
      window.__samples = []
      window.__events = []
      let hooked = null
      const tick = () => {
        const term = window.__xterms ? [...window.__xterms][0] : undefined
        if (term && hooked !== term) {
          hooked = term
          term.onScroll((y) => window.__events.push({ t: performance.now(), ev: 'scroll', y }))
          term.onResize((s) => window.__events.push({
            t: performance.now(), ev: 'resize', cols: s.cols, rows: s.rows,
          }))
        }
        if (term && term.element) {
          const c = term.element.parentElement
          const buf = term.buffer.active
          window.__samples.push({
            t: performance.now(),
            op: getComputedStyle(c).opacity,
            vy: buf.viewportY,
            by: buf.baseY,
            len: buf.length,
            rows: term.rows,
            cols: term.cols,
          })
        }
        if (!window.__done) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })

    // Deep link straight to the session: URL selection wins over localStorage.
    await page.goto(`${base}/?bootstrap=${code}&project=yaac&session=${sessionId}`)
    await page.waitForFunction(() => window.__samples.length > 0, null, { timeout: 60_000 })
    await page.waitForFunction(
      () => window.__samples.some((s) => s.op === '1'),
      null,
      { timeout: 15_000 },
    )
    // Watch for post-reveal drift, then poke a key: if the attach ate the
    // agent's bottom line, the repaint the keypress forces makes it appear —
    // the user-visible symptom. Capture the bottom rows around the press.
    await page.waitForTimeout(2500)
    if (shotPrefix) await page.screenshot({ path: `${shotPrefix}-pre-key.png` })
    const bottomRows = () => page.evaluate(() => {
      const t = [...window.__xterms][0]
      const buf = t.buffer.active
      const rows = []
      for (let y = t.rows - 3; y < t.rows; y++) {
        rows.push(buf.getLine(buf.baseY + y)?.translateToString(true) ?? '')
      }
      return rows
    })
    const rowsPre = await bottomRows()
    const tKey = await page.evaluate(() => performance.now())
    await page.click('.xterm-screen')
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(500)
    const rowsPost = await bottomRows()
    if (shotPrefix) await page.screenshot({ path: `${shotPrefix}-post-key.png` })

    const data = await page.evaluate(() => {
      window.__done = true
      return { samples: window.__samples, events: window.__events, wsFrames: window.__wsFrames }
    })

    const { samples, events, wsFrames } = data
    const revealIdx = samples.findIndex((s) => s.op === '1')
    const reveal = samples[revealIdx]
    const off = (s) => s.by - s.vy // rows above bottom
    const post = samples.slice(revealIdx).filter((s) => s.t < tKey)
    const preKey = post[post.length - 1]
    const afterKey = samples.filter((s) => s.t >= tKey + 100)
    const end = afterKey[afterKey.length - 1]

    const fmt = (ms) => `${Math.round(ms - reveal.t)}ms`
    console.log(`\n=== trial ${label} (dpr=${dpr} ${vw}x${vh}) ===`)
    console.log(`grid ${reveal.cols}x${reveal.rows}; reveal at t=${Math.round(reveal.t)}ms;`
      + ` offAtReveal=${off(reveal)} rows (vy=${reveal.vy} by=${reveal.by} len=${reveal.len})`)
    const drift = post.filter((s) => off(s) !== 0)
    console.log(`post-reveal frames off-bottom: ${drift.length}/${post.length}`
      + (drift.length ? ` (first at ${fmt(drift[0].t)}, off=${off(drift[0])})` : ''))
    console.log(`pre-key: off=${off(preKey)} rows; after key: off=${end ? off(end) : '?'}`
      + ` (vy ${preKey.vy} -> ${end?.vy})`)
    const lateWs = wsFrames.filter((f) => f.t > reveal.t)
    console.log(`ws frames: total=${wsFrames.length}`
      + ` (${wsFrames.reduce((a, f) => a + f.bytes, 0)}B), after reveal=${lateWs.length}`
      + (lateWs.length ? ` [${lateWs.slice(0, 8).map((f) => `${fmt(f.t)}:${f.bytes}B`).join(' ')}]` : ''))
    console.log(`term events: ${events.slice(-14)
      .map((e) => `${fmt(e.t)}:${e.ev}${e.ev === 'scroll' ? `=${e.y}` : `=${e.cols}x${e.rows}`}`)
      .join(' ') || '(none)'}`)
    // The keypress must reveal nothing: same bottom rows before and after
    // (ArrowRight is visually inert in an idle agent input box), and the
    // bottom row must not be blank while upper rows have content (the
    // eaten-hint-line shape).
    const changed = rowsPre.join('\n') !== rowsPost.join('\n')
    const bottomBlank = rowsPre[2].trim() === '' && rowsPre.some((r) => r.trim() !== '')
    console.log(`bottom rows pre-key: ${JSON.stringify(rowsPre.map((r) => r.slice(0, 40)))}`)
    if (changed) console.log(`CHANGED post-key:    ${JSON.stringify(rowsPost.map((r) => r.slice(0, 40)))}`)
    return {
      offAtReveal: off(reveal),
      offPreKey: off(preKey),
      keySnap: preKey.vy !== end?.vy,
      keyRevealed: changed,
      bottomBlank,
    }
  } finally {
    await page.close()
  }
}

async function main() {
  const sessionId = process.argv[2]
  const trials = Number(process.argv[3] ?? 5)
  const dpr = Number(process.argv[4] ?? 2)
  const [vw, vh] = (process.argv[5] ?? '900x520').split('x').map(Number)
  if (!sessionId) {
    throw new Error('usage: node xterm-attach-scroll-pin-test.js <sessionId> [trials] [dpr] [WxH]')
  }

  const { chromium } = requirePlaywright()
  const lock = readServerLock()
  const base = `http://127.0.0.1:${lock.port}`
  const auth = { authorization: `Bearer ${lock.secret}` }
  const claimMode = sessionId === 'claim'
  const pod = claimMode ? null : podName(sessionId)
  if (pod) console.log(`session pod: ${pod}; window ${windowSize(pod)}`)

  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] })
  const results = []
  try {
    for (let i = 1; i <= trials; i++) {
      let trialSession = sessionId
      let shotPrefix = null
      if (claimMode) {
        console.log(`waiting for a prewarmed spare…`)
        await waitForSpare(base, auth)
        trialSession = await claimSpare(base, auth)
        shotPrefix = path.join(os.tmpdir(), `scroll-pin-claim-${i}`)
        console.log(`claimed spare ${trialSession} (screenshots at ${shotPrefix}-*.png)`)
      } else if (i > 1) {
        // Give the server time to reap the previous view session, then
        // restore the oversized window and let the agent repaint at it.
        await new Promise((r) => setTimeout(r, 1500))
        resetWindow(pod)
        await new Promise((r) => setTimeout(r, 3000))
        console.log(`window reset to ${windowSize(pod)}`)
      }
      const codeRes = await fetch(`${base}/auth/bootstrap-code`, { headers: auth })
      if (!codeRes.ok) throw new Error(`bootstrap-code failed: HTTP ${codeRes.status}`)
      const { code } = await codeRes.json()
      try {
        results.push(
          await runTrial(browser, base, code, trialSession, `${i}/${trials}`, dpr, vw, vh, shotPrefix))
      } finally {
        if (claimMode) await deleteSession(base, auth, trialSession)
      }
    }
  } finally {
    await browser.close()
  }

  const bad = results.filter((r) => r.offPreKey !== 0 || r.keySnap || r.keyRevealed || r.bottomBlank)
  console.log(`\n${bad.length}/${results.length} trials failed`
    + ` (offAtReveal rows: ${results.map((r) => r.offAtReveal).join(',')};`
    + ` keySnap: ${results.map((r) => r.keySnap).join(',')};`
    + ` keypress changed bottom rows: ${results.map((r) => r.keyRevealed).join(',')};`
    + ` bottom row blank: ${results.map((r) => r.bottomBlank).join(',')})`)
  console.log(bad.length === 0 ? 'ALL PASS' : 'FAILURES')
  process.exit(bad.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
