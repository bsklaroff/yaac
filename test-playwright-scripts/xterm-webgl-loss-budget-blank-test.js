/*
 * Reproduces the residual blanking after the visibility-gated WebGL fix
 * (packages/frontend/src/lib/webgl-renderer.ts, createWebglController).
 *
 * Hypothesis: when a visible pane's context is lost more than
 * MAX_CONTEXT_LOSSES times in one visible stretch, the controller's
 * onContextLoss handler disposes the dead addon (xterm falls back to the DOM
 * renderer) but the give-up branch returns WITHOUT calling term.refresh().
 * The DOM renderer only paints on the next write/refresh, so the pane is left
 * blank until external output or a manual scroll forces a repaint — exactly
 * the "black box until you scroll up and down" symptom the fix was meant to
 * kill. This test drives the real bundled controller, forces >3 context
 * losses on a visible pane via WEBGL_lose_context, and screenshots to measure
 * whether the pane's painted content survives.
 *
 * Control: a pane that loses its context only ONCE (within budget) must
 * recover — proving the harness sees recovery when the code path allows it.
 *
 * Run: node test-playwright-scripts/xterm-webgl-loss-budget-blank-test.js
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
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xterm-webgl-blank-test-'))
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
  const context = await browser.newContext({ viewport: { width: 900, height: 320 } })
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

  // Two side-by-side terminals painted solid green: index 0 = "within budget"
  // control (1 loss), index 1 = "over budget" (>3 losses).
  const supported = await page.evaluate(() => {
    window.controllers = []
    for (let i = 0; i < 2; i++) {
      const host = document.createElement('div')
      host.id = `t${i}`
      host.style.cssText = `position:absolute;left:${i * 440}px;top:0;width:420px;height:300px`
      document.body.appendChild(host)
      const term = new window.Terminal({ fontSize: 13, fontFamily: 'monospace',
        theme: { background: '#0b0b0d', foreground: '#e7e7ea' } })
      term.open(host)
      for (let r = 0; r < term.rows - 1; r++) term.write(`\x1b[42m${' '.repeat(term.cols)}\x1b[0m\r\n`)
      window.controllers.push({ term, host, ctl: window.webglr.createWebglController(term) })
    }
    window.controllers.forEach((c) => c.ctl.setVisible(true))
    return window.controllers[0].host.querySelector('.xterm-screen canvas:not(.xterm-link-layer)') !== null
  })
  if (!supported) {
    console.log('SKIP  WebGL2 unavailable in this browser')
    await browser.close(); bundle.cleanup(); process.exit(0)
  }

  const greenFractions = async () => {
    const png = await page.screenshot()
    return page.evaluate(async (b64) => {
      const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode()
      const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height
      const ctx = cv.getContext('2d'); ctx.drawImage(img, 0, 0)
      return window.controllers.map((c) => {
        const r = c.host.getBoundingClientRect()
        const data = ctx.getImageData(r.x, r.y, r.width, r.height).data
        let green = 0; const total = data.length / 4
        for (let i = 0; i < data.length; i += 4)
          if (data[i + 1] > 100 && data[i] < 100 && data[i + 2] < 100) green++
        return green / total
      })
    }, png.toString('base64'))
  }
  const fmt = (fr) => fr.map((f) => f.toFixed(2)).join(',')

  // Lose the CURRENT gl context of a given terminal N times, waiting out the
  // ~3s grace window between each so onContextLoss fires and the controller
  // re-acquires — accumulating the loss count.
  const loseNTimes = async (idx, n) => {
    for (let k = 0; k < n; k++) {
      const ok = await page.evaluate((i) => {
        const host = window.controllers[i].host
        const cv = host.querySelector('.xterm-screen canvas:not(.xterm-link-layer)')
        if (!cv) return false
        const gl = cv.getContext('webgl2')
        const ext = gl && gl.getExtension('WEBGL_lose_context')
        if (!ext) return false
        ext.loseContext()
        return true
      }, idx)
      if (!ok) return k // no live context to lose (already gave up)
      await page.waitForTimeout(3800) // addon grace window (~3s) + margin
    }
    return n
  }

  let fr = await greenFractions()
  check('baseline: both panes painted', fr.every((f) => f > 0.5), fmt(fr))

  // Control: pane 0 loses its context ONCE (within the budget of 3). Must recover.
  await loseNTimes(0, 1)
  fr = await greenFractions()
  check('within-budget pane recovers after 1 loss', fr[0] > 0.5, `pane0=${fr[0].toFixed(2)}`)

  // Repro: pane 1 loses its context 4 times (exceeds MAX_CONTEXT_LOSSES=3).
  // After the 4th loss the controller gives up. Does the pane stay painted
  // (via the DOM-renderer fallback) or go blank?
  const lost = await loseNTimes(1, 4)
  await page.waitForTimeout(500)
  fr = await greenFractions()
  console.log(`  (pane 1: forced ${lost} context losses)`)
  check('over-budget pane still shows content after give-up', fr[1] > 0.5,
    `pane1=${fr[1].toFixed(2)} — 0.00 == blank box, the residual bug`)

  // Does external output (a fresh write, like the agent printing a line, or a
  // tmux repaint on scroll) bring the blank pane back? This is the user's
  // "scroll up and down to see it again" workaround.
  await page.evaluate(() => {
    const t = window.controllers[1].term
    for (let r = 0; r < t.rows - 1; r++) t.write(`\x1b[42m${' '.repeat(t.cols)}\x1b[0m\r\n`)
  })
  await page.waitForTimeout(300)
  fr = await greenFractions()
  check('over-budget pane repaints once new output arrives (the workaround)', fr[1] > 0.5,
    `pane1=${fr[1].toFixed(2)}`)

  await browser.close(); bundle.cleanup()
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(2) })
