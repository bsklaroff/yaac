/*
 * Verifies the settle gate on freshly created sessions
 * (src/frontend/lib/attach-settle.ts wired into SessionTerminal): when a new
 * session is created from the webapp, its terminal must stay invisible
 * (opacity 0) from the moment it mounts until the tmux attach repaint
 * settles, then reveal exactly once — with real rendered agent content
 * already on screen. This is the fix for the flash/jitter of the attach-time
 * shrink-reflow (the session window is created oversized; see
 * session-create.ts) that used to play out in front of the user.
 *
 * Drives the real stack: the running yaac server's webapp in real Chromium,
 * clicking "+ New session" → "Claude Code" and rAF-sampling the new
 * terminal's computed opacity + rendered row text from DOM-mount through
 * reveal. Also covers the "Connecting…" notice shown while the gate holds
 * (it must fade in during the hold and be gone once the terminal reveals).
 * Scrollback pinning is NOT asserted here: the tmux client keeps xterm in
 * the alternate buffer for the whole attach, so there is no scrollback to
 * drift in (the old .xterm-viewport scrollTop check was vacuous on xterm 6
 * anyway — that element no longer scrolls). The bottom-line-eaten attach bug
 * lives at the tmux layer and is covered by
 * xterm-attach-scroll-pin-test.js instead.
 *
 * Run: node test-playwright-scripts/session-create-no-flash-test.js
 * Needs a running server (`yaac server start`) with a project configured;
 * reads the port/secret from $YAAC_DATA_DIR/.server.lock (or ~/.yaac).
 * The created session is deleted at the end via the server API.
 * (playwright is resolved from the global npm root; browsers live under
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

let failures = 0
function check(name, cond, detail = '') {
  const mark = cond ? 'PASS' : 'FAIL'
  if (!cond) failures++
  console.log(`${mark}  ${name}${detail ? `  [${detail}]` : ''}`)
}

async function main() {
  const { chromium } = requirePlaywright()
  const lock = readServerLock()
  const base = `http://127.0.0.1:${lock.port}`
  const auth = { authorization: `Bearer ${lock.secret}` }

  const codeRes = await fetch(`${base}/auth/bootstrap-code`, { headers: auth })
  if (!codeRes.ok) throw new Error(`bootstrap-code failed: HTTP ${codeRes.status}`)
  const { code } = await codeRes.json()

  const browser = await chromium.launch()
  // bypassCSP: the webapp ships script-src 'self', which blocks the
  // eval-based page functions Playwright's waitForFunction relies on.
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, bypassCSP: true })
  page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))

  let createdSessionId = null
  try {
    await page.goto(`${base}/?bootstrap=${code}`)
    await page.waitForSelector('[title="New session"]', { timeout: 15_000 })
    // Let any pre-existing session's terminal finish mounting so the sampler's
    // baseline captures it and only the new session's terminal is tracked.
    await page.waitForTimeout(1500)

    // Sample every animation frame, from before the create so the terminal's
    // very first painted frame is covered. Terminals already mounted (other
    // sessions) are baselined and ignored; the sampler follows the first
    // container that appears after it starts.
    await page.evaluate(() => {
      const containerOf = (x) => x.parentElement // SessionTerminal's div wraps .xterm
      const baseline = new Set([...document.querySelectorAll('.xterm')].map(containerOf))
      const samples = []
      let tracked = null
      const t0 = performance.now()
      const tick = () => {
        if (!tracked) {
          for (const x of document.querySelectorAll('.xterm')) {
            const c = containerOf(x)
            if (!baseline.has(c)) { tracked = c; break }
          }
        }
        if (tracked) {
          // The connecting notice is the terminal container's sibling overlay.
          const notice = tracked.parentElement.querySelector('.animate-fade-in')
          // Rendered content is read from the buffer via the window.__xterms
          // hook (SessionTerminal): the WebGL renderer paints to a canvas, so
          // the DOM .xterm-rows stay empty and can't be sampled.
          const term = [...(window.__xterms ?? [])]
            .find((t) => t.element && t.element.parentElement === tracked)
          let textLen = 0
          if (term) {
            const buf = term.buffer.active
            for (let y = 0; y < term.rows; y++) {
              textLen += buf.getLine(buf.baseY + y)?.translateToString(true).trim().length ?? 0
            }
          }
          samples.push({
            t: Math.round(performance.now() - t0),
            opacity: getComputedStyle(tracked).opacity,
            textLen,
            notice: notice ? Number(getComputedStyle(notice).opacity) : null,
          })
        }
        if (!window.__noflashDone) requestAnimationFrame(tick)
      }
      window.__noflashSamples = samples
      requestAnimationFrame(tick)
    })

    await page.click('[title="New session"]')
    await page.getByRole('menuitem', { name: 'Claude', exact: true }).click()
    console.log('session create clicked; waiting for the terminal to mount…')

    // The provisioning placeholder shows while the server builds the session;
    // the terminal mounts when the session lands in the snapshot. Cold
    // creates take a while (pod start + agent boot).
    await page.waitForFunction(() => window.__noflashSamples.length > 0, null, { timeout: 300_000 })
    console.log('terminal mounted; waiting for reveal…')
    await page.waitForFunction(
      () => window.__noflashSamples.some((s) => s.opacity === '1'),
      null,
      { timeout: 10_000 },
    )
    // A few extra frames to catch any flicker back to hidden after reveal.
    await page.waitForTimeout(500)
    const samples = await page.evaluate(() => {
      window.__noflashDone = true
      return window.__noflashSamples
    })

    const firstVisible = samples.findIndex((s) => s.opacity === '1')
    const preReveal = samples.slice(0, firstVisible)
    const postReveal = samples.slice(firstVisible)
    const revealSample = samples[firstVisible]

    check('terminal mounted hidden', samples[0].opacity === '0',
      `first sample opacity=${samples[0].opacity}`)
    check('stayed hidden until reveal (no flicker on)', preReveal.every((s) => s.opacity === '0'),
      `${preReveal.length} hidden frames over ${revealSample.t - samples[0].t}ms`)
    // The gate defers quiet/cap reveals while the buffer is blank, so the
    // reveal frame must already have content in the terminal buffer.
    check('revealed with content already rendered', revealSample.textLen > 0,
      `buffer text length at reveal=${revealSample.textLen}`)
    check('reveal is one-way (no flicker off)', postReveal.every((s) => s.opacity === '1'),
      `${postReveal.length} visible frames`)
    check('revealed within the gate policy (< 4s of mount)', revealSample.t - samples[0].t < 4000,
      `mount→reveal ${revealSample.t - samples[0].t}ms`)

    // Connecting notice: fades in immediately while the gate holds (only
    // assertable when the hold outlasts the fade) and is unmounted once the
    // terminal reveals.
    const hiddenMs = revealSample.t - samples[0].t
    if (hiddenMs > 300) {
      check('notice visible during the hold',
        preReveal.some((s) => s.notice > 0),
        `hold lasted ${hiddenMs}ms`)
    } else {
      console.log(`SKIP  notice visible during the hold  [hold only ${hiddenMs}ms]`)
    }
    check('notice gone after reveal', postReveal.every((s) => s.notice === null),
      `${postReveal.length} visible frames`)

    // The session id, for cleanup: the create auto-opened the new session,
    // and the selection is persisted to localStorage.
    createdSessionId = await page.evaluate(() => {
      try {
        return JSON.parse(localStorage.getItem('yaac.selection.v1') ?? '{}').sessionId ?? null
      } catch {
        return null
      }
    })
  } finally {
    await browser.close()
    if (createdSessionId) {
      const del = await fetch(`${base}/session/delete`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: createdSessionId }),
      }).catch((e) => ({ ok: false, status: String(e) }))
      console.log(`cleanup: deleted session ${createdSessionId} (ok=${del.ok ?? del.status})`)
    } else {
      console.log('cleanup: no session id captured — delete the test session manually')
    }
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
