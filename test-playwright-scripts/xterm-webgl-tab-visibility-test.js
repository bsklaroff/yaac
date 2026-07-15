/*
 * Browser test for tab-visibility-gated WebGL contexts
 * (packages/frontend/src/lib/webgl-renderer.ts, createWebglController).
 *
 * The residual black-box bug after the context-budget fix: a backgrounded
 * browser tab gets its GPU contexts reclaimed with requestAnimationFrame
 * paused, so xterm can neither repaint on recovery nor rebuild — and the
 * pane's in-app setVisible(true) state is unchanged, so nothing signals a
 * rebuild. On return the pane is a blank canvas until fresh PTY output happens
 * to repaint it (a brief backgrounding usually keeps the WebSocket open, so no
 * reconnect-driven redraw fires either). The fix mirrors the tab's own
 * visibility: drop the context when the tab hides, rebuild it with a full
 * repaint when it returns.
 *
 * This drives the real bundled controller against a grid of panes that stay
 * setVisible(true) throughout, and flips document.visibilityState (overridden
 * + dispatched, exactly as a browser does) to assert the observable
 * consequence: the count of live WebGL canvases must fall to zero while the
 * tab is "hidden" (even though every pane is on-screen within the app) and
 * come back — with FRESH canvases — when the tab returns.
 *
 * Run: node test-playwright-scripts/xterm-webgl-tab-visibility-test.js
 * (playwright from the global npm root; browsers under
 * /opt/playwright-browsers). Self-contained — no running server needed.
 */
import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const XTERM_DIR = [
  path.join(ROOT, 'node_modules/@xterm/xterm'),
  path.join(ROOT, 'packages/frontend/node_modules/@xterm/xterm'),
].find((d) => fs.existsSync(path.join(d, 'css/xterm.css')))
if (!XTERM_DIR) throw new Error('@xterm/xterm not found — run pnpm install')

const TERMINALS = 4

function requirePlaywright() {
  try {
    return require('playwright')
  } catch {
    const globalRoot = execSync('npm root -g').toString().trim()
    return require(path.join(globalRoot, 'playwright'))
  }
}

function buildRendererBundle() {
  const esbuild = [
    path.join(ROOT, 'node_modules/.bin/esbuild'),
    path.join(ROOT, 'node_modules/.pnpm/node_modules/.bin/esbuild'),
  ].find(fs.existsSync)
  if (!esbuild) throw new Error('esbuild not found under node_modules')
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xterm-webgl-tabvis-test-'))
  const outFile = path.join(outDir, 'webgl-renderer.js')
  execFileSync(esbuild, [
    path.join(ROOT, 'packages/frontend/src/lib/webgl-renderer.ts'),
    '--bundle',
    '--format=iife',
    '--global-name=webglr',
    '--log-level=warning',
    `--outfile=${outFile}`,
  ])
  return { outFile, cleanup: () => fs.rmSync(outDir, { recursive: true, force: true }) }
}

let failures = 0
function check(name, cond, detail = '') {
  const mark = cond ? 'PASS' : 'FAIL'
  if (!cond) failures++
  console.log(`${mark}  ${name}${detail ? `  [${detail}]` : ''}`)
}

async function main() {
  const { chromium } = requirePlaywright()
  const bundle = buildRendererBundle()
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] })
  const context = await browser.newContext({ viewport: { width: 900, height: 500 } })
  const page = await context.newPage()
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`  [page error] ${msg.text()}`)
  })

  await page.setContent(
    '<!DOCTYPE html><html><body style="margin:0;background:#0b0b0d"></body></html>'
  )
  await page.addStyleTag({ path: path.join(XTERM_DIR, 'css/xterm.css') })
  await page.addScriptTag({ path: path.join(XTERM_DIR, 'lib/xterm.js') })
  await page.addScriptTag({ path: bundle.outFile })

  // Install a controllable Page Visibility API, then build N panes and mark
  // every one visible-within-the-app. They stay setVisible(true) for the whole
  // run — only the *tab* flips.
  const supported = await page.evaluate((n) => {
    let vis = 'visible'
    window.__setTab = (state) => {
      vis = state
      document.dispatchEvent(new Event('visibilitychange'))
    }
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => vis })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => vis === 'hidden' })

    window.controllers = []
    for (let i = 0; i < n; i++) {
      const host = document.createElement('div')
      host.id = `t${i}`
      host.style.cssText = `position:absolute;left:${(i % 2) * 440}px;top:${Math.floor(i / 2) * 240}px;width:420px;height:220px`
      document.body.appendChild(host)
      const term = new window.Terminal({ fontSize: 13, fontFamily: 'monospace',
        theme: { background: '#0b0b0d', foreground: '#e7e7ea' } })
      term.open(host)
      term.write('pane ' + i)
      window.controllers.push({ term, host, ctl: window.webglr.createWebglController(term) })
    }
    window.controllers.forEach((c) => c.ctl.setVisible(true))
    return window.controllers[0].host.querySelector('.xterm-screen canvas:not(.xterm-link-layer)') !== null
  }, TERMINALS)

  if (!supported) {
    console.log('SKIP  WebGL2 unavailable in this browser')
    await browser.close(); bundle.cleanup(); process.exit(0)
  }

  const GL = '.xterm-screen canvas:not(.xterm-link-layer)'
  const liveContexts = () => page.evaluate((sel) => document.querySelectorAll(sel).length, GL)
  const canvasIds = () =>
    page.evaluate((sel) => {
      window.__seq = window.__seq || 0
      return window.controllers.map((c) => {
        const cv = c.host.querySelector(sel)
        if (!cv) return null
        if (!cv.dataset.probe) cv.dataset.probe = String(++window.__seq)
        return cv.dataset.probe
      })
    }, GL)
  const setTab = (state) => page.evaluate((s) => window.__setTab(s), state)

  // Foreground + all panes visible: one context per pane.
  let live = await liveContexts()
  check('foreground: one context per visible pane', live === TERMINALS, `live=${live}/${TERMINALS}`)
  const before = await canvasIds()

  // Background the tab: every context released, even though panes stay
  // setVisible(true). This is what stops a backgrounded tab from holding (and
  // then losing, un-recoverably) contexts.
  await setTab('hidden')
  live = await liveContexts()
  check('backgrounded tab releases every context', live === 0, `live=${live}`)

  // Return to foreground: contexts come back, one per pane...
  await setTab('visible')
  live = await liveContexts()
  check('foregrounded tab re-acquires one context per pane', live === TERMINALS, `live=${live}/${TERMINALS}`)

  // ...and they are FRESH canvases (new contexts), not the released ones.
  const after = await canvasIds()
  const allFresh = after.every((id, i) => id !== null && id !== before[i])
  check('re-acquired contexts are fresh, not stale', allFresh,
    `before=[${before}] after=[${after}]`)

  // A pane hidden in-app stays contextless across a tab hide/show.
  await page.evaluate(() => window.controllers[0].ctl.setVisible(false))
  await setTab('hidden')
  await setTab('visible')
  live = await liveContexts()
  check('in-app-hidden pane stays contextless through a tab cycle', live === TERMINALS - 1,
    `live=${live}/${TERMINALS - 1}`)

  await browser.close(); bundle.cleanup()
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(2) })
