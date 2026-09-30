/*
 * Verifies the visibility-gated WebGL renderer (createWebglController in
 * packages/frontend/src/lib/webgl-renderer.ts).
 *
 * Each xterm terminal using the WebGL renderer holds its own WebGL2 context,
 * and browsers cap live contexts per page (~16 in Chrome). The webapp keeps
 * every opened pane mounted, so without gating the browser evicts the
 * oldest context and that terminal goes blank until poked (xterm.js#4379).
 * The controller releases a pane's context when it is hidden and acquires a
 * new one when it is shown.
 *
 * Runs the real controller (bundled from source) on a set of terminals in
 * headless Chromium. The WebGL renderer adds one GL <canvas> per active
 * terminal, so the number of GL canvases must always equal the number of
 * visible panes, not mounted ones. Also checks that a re-shown pane gets a
 * new canvas (a fresh context).
 *
 * Run: node test-playwright-scripts/xterm-webgl-context-budget-test.js
 * No running server needed.
 */
import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// @xterm/xterm is a frontend dep that pnpm may not hoist to the root.
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

  // N terminals, each with its own controller, all initially hidden.
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
    // Confirm WebGL2 is available at all.
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

  // The addon adds a WebGL canvas and a 2D .xterm-link-layer canvas; only
  // the first holds a WebGL2 context.
  const GL_CANVAS = '.xterm-screen canvas:not(.xterm-link-layer)'
  const liveContexts = () =>
    page.evaluate((sel) => document.querySelectorAll(sel).length, GL_CANVAS)
  // Stamps an id on each new GL canvas, so a replaced canvas reports a new id.
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

  check('no contexts while all panes hidden', (await liveContexts()) === 0, `live=${await liveContexts()}`)

  await setVisible([true, true, false, false, false, false])
  let live = await liveContexts()
  check('contexts track visible count, not mounted count', live === 2, `live=${live}/${TERMINALS}`)
  const before = await canvasIds()

  await setVisible([false, false, true, true, false, false])
  live = await liveContexts()
  check('hiding releases and showing re-acquires (still 2)', live === 2, `live=${live}`)

  // Terminal 0's context was released on hide, so re-showing needs a new one.
  await setVisible([true, false, true, true, false, false])
  const after = await canvasIds()
  check('re-shown pane gets a fresh WebGL context', after[0] !== null && after[0] !== before[0],
    `before=${before[0]} after=${after[0]}`)

  await setVisible([true, true, true, true, true, true])
  live = await liveContexts()
  check('all-visible holds one context per pane', live === TERMINALS, `live=${live}/${TERMINALS}`)

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
