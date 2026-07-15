/*
 * Pixel-level browser test for WebGL context-eviction *recovery*
 * (packages/frontend/src/lib/webgl-renderer.ts, createWebglController).
 *
 * The context-budget test proves hidden panes release their contexts; this
 * one proves the part the user actually sees: a terminal whose live context
 * the browser force-evicts (LRU, "too many active WebGL contexts") must NOT
 * stay a blank/black box. The controller's onContextLoss handler is supposed
 * to dispose the dead addon, acquire a fresh context, and repaint — after the
 * addon's own ~3s restoration grace window. Each check here paints solid
 * colored content into real xterm terminals driven by the real bundled
 * controller, applies GPU-context pressure, then screenshots the page and
 * measures the colored-pixel fraction inside every terminal's box.
 *
 * Scenarios:
 *  1. baseline — all panes visible and painted
 *  2. eviction storm (20 throwaway WebGL contexts) against visible panes →
 *     every pane must repaint within the grace window + margin
 *  3. explicit loseContext() with a restoreContext() 1s later (the addon's
 *     own webglcontextrestored path) → pane must repaint
 *  4. eviction while panes are hidden, then re-shown → panes must repaint
 *
 * Run: node test-playwright-scripts/xterm-webgl-eviction-recovery-test.js
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

const TERMINALS = 6
// The controller replaces a dead context only after the addon's ~3s
// context-restoration grace window; give it that plus scheduling margin.
const RECOVERY_MS = 6000

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
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xterm-webgl-evict-test-'))
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  const page = await context.newPage()
  const events = []
  page.on('console', (msg) => {
    const t = msg.text()
    if (/webglcontext|webgl context|WebGL2 unavailable/i.test(t)) events.push(t)
    if (msg.type() === 'error') console.log(`  [page error] ${t}`)
  })

  await page.setContent(
    '<!DOCTYPE html><html><body style="margin:0;background:#0b0b0d"></body></html>'
  )
  await page.addStyleTag({ path: path.join(XTERM_DIR, 'css/xterm.css') })
  await page.addScriptTag({ path: path.join(XTERM_DIR, 'lib/xterm.js') })
  await page.addScriptTag({ path: bundle.outFile })

  // Build a grid of visible terminals, each painted with solid green rows —
  // dense enough that "did it render" is a plain pixel-fraction question.
  const supported = await page.evaluate((n) => {
    window.controllers = []
    for (let i = 0; i < n; i++) {
      const host = document.createElement('div')
      host.id = `t${i}`
      host.style.cssText =
        `position:absolute;left:${(i % 3) * 420}px;top:${Math.floor(i / 3) * 240}px;` +
        'width:400px;height:220px'
      document.body.appendChild(host)
      const term = new window.Terminal({
        fontSize: 13,
        fontFamily: 'monospace',
        theme: { background: '#0b0b0d', foreground: '#e7e7ea' },
      })
      term.open(host)
      // Solid green-background rows across the full grid.
      for (let r = 0; r < term.rows - 1; r++) {
        term.write(`\x1b[42m${' '.repeat(term.cols)}\x1b[0m\r\n`)
      }
      window.controllers.push({ term, host, ctl: window.webglr.createWebglController(term) })
    }
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

  await page.evaluate(() => window.controllers.forEach((c) => c.ctl.setVisible(true)))

  // Screenshot the page, decode it back in-page (img → 2D canvas), and return
  // each terminal's green-pixel fraction. Screenshots are compositor truth —
  // reading the WebGL canvas directly would lie (preserveDrawingBuffer=false).
  const greenFractions = async () => {
    const png = await page.screenshot()
    return page.evaluate(async (b64) => {
      const img = new Image()
      img.src = `data:image/png;base64,${b64}`
      await img.decode()
      const cv = document.createElement('canvas')
      cv.width = img.width
      cv.height = img.height
      const ctx = cv.getContext('2d')
      ctx.drawImage(img, 0, 0)
      return window.controllers.map((c) => {
        const r = c.host.getBoundingClientRect()
        const data = ctx.getImageData(r.x, r.y, r.width, r.height).data
        let green = 0
        const total = data.length / 4
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 1] > 100 && data[i] < 100 && data[i + 2] < 100) green++
        }
        return green / total
      })
    }, png.toString('base64'))
  }
  const fmt = (fr) => fr.map((f) => f.toFixed(2)).join(',')

  // 1. Baseline: every visible pane painted.
  let fr = await greenFractions()
  check('baseline: all visible panes painted', fr.every((f) => f > 0.5), fmt(fr))

  // 2. Eviction storm: 20 throwaway contexts force Chrome to evict the
  // terminals' contexts (oldest-first LRU). The controller must bring every
  // pane back. Keep the throwaways referenced so GC can't quietly free them.
  await page.evaluate(() => {
    window.__hogs = []
    for (let i = 0; i < 20; i++) {
      const cv = document.createElement('canvas')
      cv.width = 64
      cv.height = 64
      const gl = cv.getContext('webgl2')
      if (gl) {
        gl.clearColor(0, 0, 0, 1)
        gl.clear(gl.COLOR_BUFFER_BIT)
      }
      window.__hogs.push({ cv, gl })
    }
  })
  await page.waitForTimeout(RECOVERY_MS)
  fr = await greenFractions()
  check('eviction storm: every pane repaints', fr.every((f) => f > 0.5), fmt(fr))
  const lossEvents = events.filter((t) => /webglcontextlost/.test(t)).length
  check('eviction storm actually evicted terminal contexts', lossEvents > 0,
    `${lossEvents} webglcontextlost console events`)

  // 3. Explicit lose→restore inside the grace window: the addon's own
  // webglcontextrestored path must reinitialize and repaint (no controller
  // involvement — the addon instance survives).
  await page.evaluate(() => {
    const host = window.controllers[0].host
    const cv = host.querySelector('.xterm-screen canvas:not(.xterm-link-layer)')
    const gl = cv.getContext('webgl2')
    window.__lose0 = gl.getExtension('WEBGL_lose_context')
    window.__lose0.loseContext()
  })
  await page.waitForTimeout(1000)
  await page.evaluate(() => window.__lose0.restoreContext())
  await page.waitForTimeout(1500)
  fr = await greenFractions()
  check('lose→restore within grace window repaints', fr[0] > 0.5, fmt(fr))

  // 4. Eviction while hidden, then re-show: hiding released the context, so
  // the storm can't touch these panes; re-showing must acquire + paint.
  await page.evaluate(() => window.controllers.forEach((c) => c.ctl.setVisible(false)))
  await page.evaluate(() => {
    for (let i = 0; i < 8; i++) {
      const cv = document.createElement('canvas')
      const gl = cv.getContext('webgl2')
      window.__hogs.push({ cv, gl })
    }
  })
  await page.waitForTimeout(500)
  await page.evaluate(() => window.controllers.forEach((c) => c.ctl.setVisible(true)))
  await page.waitForTimeout(RECOVERY_MS)
  fr = await greenFractions()
  check('re-show after hidden-time eviction repaints', fr.every((f) => f > 0.5), fmt(fr))

  console.log('\nContext events observed:')
  for (const t of events) console.log(`  ${t}`)

  await browser.close()
  bundle.cleanup()
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
