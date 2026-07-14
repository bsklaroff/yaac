/*
 * Browser test for the visibility-gated WebGL renderer
 * (packages/frontend/src/lib/webgl-renderer.ts, createWebglController).
 *
 * The bug: every xterm terminal that turns on the WebGL renderer holds its own
 * live WebGL2 context, and browsers cap how many contexts a page may keep
 * (~16 in Chrome). The webapp keeps every session/pane ever opened mounted
 * (hidden ones parked off-screen), so the contexts pile up past the cap and
 * the browser force-evicts the least-recently-used one — leaving that terminal
 * a blank/black canvas until it's poked back to life (the "scroll to refresh"
 * symptom, xterm.js#4379). The fix binds a terminal's WebGL context to its
 * visibility: hidden panes release their context; showing re-acquires one.
 *
 * This drives the real createWebglController (bundled from source) against a
 * grid of terminals in headless Chromium and asserts the observable
 * consequence: the WebGL renderer appends exactly one <canvas> to a terminal's
 * screen element while active and removes it on dispose, so the count of live
 * terminal canvases must always equal the number of *visible* panes — never
 * the total mounted count. It also confirms a re-shown pane gets a *fresh*
 * context (a new canvas element) rather than a stale one, and that context is
 * repainted.
 *
 * Run: node test-playwright-scripts/xterm-webgl-context-budget-test.js
 * (playwright is resolved from the global npm root; browsers live under
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
// pnpm's strict layout doesn't hoist @xterm/xterm to the repo root — it's a
// frontend dep — so probe the package-local symlink too.
const XTERM_DIR = [
  path.join(ROOT, 'node_modules/@xterm/xterm'),
  path.join(ROOT, 'packages/frontend/node_modules/@xterm/xterm'),
].find((d) => fs.existsSync(path.join(d, 'css/xterm.css')))
if (!XTERM_DIR) throw new Error('@xterm/xterm not found — run pnpm install')

const TERMINALS = 6

function requirePlaywright() {
  try {
    return require('playwright')
  } catch {
    const globalRoot = execSync('npm root -g').toString().trim()
    return require(path.join(globalRoot, 'playwright'))
  }
}

// Bundle the real webgl-renderer.ts (with the addon inlined) as an IIFE.
function buildRendererBundle() {
  const esbuild = [
    path.join(ROOT, 'node_modules/.bin/esbuild'),
    path.join(ROOT, 'node_modules/.pnpm/node_modules/.bin/esbuild'),
  ].find(fs.existsSync)
  if (!esbuild) throw new Error('esbuild not found under node_modules')
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xterm-webgl-budget-test-'))
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
  // SwiftShader keeps WebGL2 available in headless runs without a GPU.
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] })
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } })
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

  // Build N terminals, each with its own controller, all initially hidden.
  const supported = await page.evaluate((n) => {
    window.controllers = []
    for (let i = 0; i < n; i++) {
      const host = document.createElement('div')
      host.id = `t${i}`
      host.style.cssText = 'width:400px;height:180px'
      document.body.appendChild(host)
      const term = new window.Terminal({
        fontSize: 13,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        theme: { background: '#0b0b0d', foreground: '#e7e7ea' },
      })
      term.open(host)
      term.write('hello from terminal ' + i)
      window.controllers.push({ term, host, ctl: window.webglr.createWebglController(term) })
    }
    // Sanity: WebGL2 must actually be available for this run to mean anything.
    const probe = window.controllers[0]
    probe.ctl.setVisible(true)
    const ok = probe.host.querySelector('.xterm-screen canvas:not(.xterm-link-layer)') !== null
    probe.ctl.setVisible(false)
    return ok
  }, TERMINALS)

  if (!supported) {
    console.log('SKIP  WebGL2 unavailable in this browser (no --enable-unsafe-swiftshader?)')
    await browser.close()
    bundle.cleanup()
    process.exit(0)
  }

  // Count live WebGL contexts. The addon adds two canvases to a terminal's
  // screen element — the WebGL render canvas (no class) and a 2D
  // .xterm-link-layer canvas — but only the former holds a WebGL2 context and
  // counts against the browser's context budget, so match `:not(.link-layer)`.
  const GL_CANVAS = '.xterm-screen canvas:not(.xterm-link-layer)'
  const liveContexts = () =>
    page.evaluate((sel) => document.querySelectorAll(sel).length, GL_CANVAS)
  // Identity of each terminal's current GL canvas, to prove re-show swaps it.
  // Stamps a fresh id on any canvas element not seen before, so a replaced
  // canvas (new context) reports a different id than the one it replaced.
  const canvasIds = () =>
    page.evaluate((sel) => {
      window.__probeSeq = window.__probeSeq || 0
      return window.controllers.map((c) => {
        const cv = c.host.querySelector(sel)
        if (!cv) return null
        if (!cv.dataset.probe) cv.dataset.probe = String(++window.__probeSeq)
        return cv.dataset.probe
      })
    }, GL_CANVAS)

  const setVisible = (mask) =>
    page.evaluate((m) => {
      window.controllers.forEach((c, i) => c.ctl.setVisible(!!m[i]))
    }, mask)

  // All hidden: nobody holds a context.
  check('no contexts while all panes hidden', (await liveContexts()) === 0, `live=${await liveContexts()}`)

  // Show 2 of 6: exactly 2 contexts, even though all 6 are mounted.
  await setVisible([true, true, false, false, false, false])
  let live = await liveContexts()
  check('contexts track visible count, not mounted count', live === 2, `live=${live}/${TERMINALS}`)
  const before = await canvasIds()

  // Hide those 2, show a different 2: contexts move, never exceed visible.
  await setVisible([false, false, true, true, false, false])
  live = await liveContexts()
  check('hiding releases and showing re-acquires (still 2)', live === 2, `live=${live}`)

  // Re-show terminal 0: it must get a FRESH canvas (new context), not a stale
  // one — the whole point, since the old context was released on hide.
  await setVisible([true, false, true, true, false, false])
  const after = await canvasIds()
  check('re-shown pane gets a fresh WebGL context', after[0] !== null && after[0] !== before[0],
    `before=${before[0]} after=${after[0]}`)

  // Show all: contexts == mounted count (the visible-pane ceiling).
  await setVisible([true, true, true, true, true, true])
  live = await liveContexts()
  check('all-visible holds one context per pane', live === TERMINALS, `live=${live}/${TERMINALS}`)

  // Hide all: everything released.
  await setVisible([false, false, false, false, false, false])
  live = await liveContexts()
  check('hiding everything releases every context', live === 0, `live=${live}`)

  await browser.close()
  bundle.cleanup()
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
