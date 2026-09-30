/*
 * Verifies the WebGL terminal renderer (createWebglController in
 * packages/frontend/src/lib/webgl-renderer.ts), bundled from source and run
 * on the real xterm.js in headless Chromium (SwiftShader supplies WebGL2).
 *
 * Context budget: every WebGL xterm holds its own WebGL2 context, and
 * browsers cap live contexts per page (~16 in Chrome). The webapp keeps every
 * opened pane mounted, so the controller releases a pane's context when it is
 * hidden and acquires a new one when it is shown. The renderer adds one GL
 * <canvas> per active terminal, so the GL canvas count must equal the number
 * of visible panes, and a re-shown pane must get a new canvas.
 *
 * Row seams: xterm's DOM renderer lays rows out in CSS pixels, so at
 * fractional devicePixelRatios rounding leaves hairlines of background
 * between rows. A block of solid red rows is rendered at several DPRs and
 * the pixel rows inside it with no red are counted. The DOM renderer is the
 * control and must seam somewhere, proving the harness can see the bug; the
 * WebGL renderer must show none at every DPR.
 *
 * No server needed. Run: node test-playwright-scripts/xterm-webgl-test.js
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, finish, requirePlaywright } from './lib.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// @xterm/xterm is a dep of packages/frontend only (not hoisted to the root).
const XTERM_DIR = path.dirname(
  createRequire(path.join(ROOT, 'packages/frontend/package.json')).resolve('@xterm/xterm/package.json'))

const TERMINALS = 6
const DPRS = [1, 1.25, 1.5, 2]
const BLOCK_ROWS = 20

// Bundle the real webgl-renderer.ts (with the addon inlined) as an IIFE.
function buildRendererBundle() {
  const esbuild = path.join(ROOT, 'node_modules/.pnpm/node_modules/.bin/esbuild')
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xterm-webgl-test-'))
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

/** Checks that live GL contexts track visible panes, not mounted ones. */
async function checkContextBudget(browser, bundleFile) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`  [page error] ${msg.text()}`)
  })
  await page.setContent(
    '<!DOCTYPE html><html><body style="margin:0;background:#0b0b0d"></body></html>'
  )
  await page.addStyleTag({ path: path.join(XTERM_DIR, 'css/xterm.css') })
  await page.addScriptTag({ path: path.join(XTERM_DIR, 'lib/xterm.js') })
  await page.addScriptTag({ path: bundleFile })

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
    check('WebGL2 is available', false)
    return
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

  await page.close()
}

/**
 * Renders the red block with the given renderer and DPR, and counts seam
 * rows: device-pixel rows inside the block with no red pixel.
 */
async function measureSeams(browser, bundleFile, dpr, useWebgl) {
  const context = await browser.newContext({
    viewport: { width: 900, height: 520 },
    deviceScaleFactor: dpr,
  })
  const page = await context.newPage()
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`  [page error] ${msg.text()}`)
  })
  await page.setContent(
    '<!DOCTYPE html><html><body style="margin:0;background:#0b0b0d">' +
      '<div id="t" style="width:860px;height:480px"></div></body></html>'
  )
  await page.addStyleTag({ path: path.join(XTERM_DIR, 'css/xterm.css') })
  await page.addScriptTag({ path: path.join(XTERM_DIR, 'lib/xterm.js') })
  await page.addScriptTag({ path: bundleFile })

  // Terminal options as in WorkspaceTerminal.tsx.
  const webglLoaded = await page.evaluate((wantWebgl) => {
    const term = new window.Terminal({
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      cursorBlink: false,
      altClickMovesCursor: false,
      theme: { background: '#0b0b0d', foreground: '#e7e7ea', selectionBackground: '#3a3d4d' },
    })
    window.term = term
    term.open(document.getElementById('t'))
    if (!wantWebgl) return null
    window.webglr.createWebglController(term).setVisible(true)
    // Only the WebGL renderer adds a <canvas> to the screen element.
    return document.querySelector('.xterm-screen canvas') !== null
  }, useWebgl)
  if (useWebgl && !webglLoaded) {
    await context.close()
    return { error: 'WebGL addon failed to load (no WebGL2 in this browser)' }
  }

  await page.evaluate(
    (rows) =>
      new Promise((res) => {
        const line = '\x1b[48;2;255;0;0m' + ' '.repeat(window.term.cols) + '\x1b[0m\r\n'
        window.term.write(line.repeat(rows), res)
      }),
    BLOCK_ROWS
  )
  // Wait two frames: both renderers paint on rAF after the write.
  await page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))))

  const shot = await page.locator('.xterm-screen').screenshot({ scale: 'device' })

  // Decode the PNG in the page and scan pixel rows.
  const result = await page.evaluate(async (b64) => {
    const img = new Image()
    img.src = 'data:image/png;base64,' + b64
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = img.width
    canvas.height = img.height
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(img, 0, 0)
    const { data } = ctx.getImageData(0, 0, img.width, img.height)
    const isRed = (i) => data[i] >= 200 && data[i + 1] <= 60 && data[i + 2] <= 60
    const rowHasRed = []
    for (let y = 0; y < img.height; y++) {
      let has = false
      for (let x = 0; x < img.width; x++) {
        if (isRed(4 * (y * img.width + x))) {
          has = true
          break
        }
      }
      rowHasRed.push(has)
    }
    const first = rowHasRed.indexOf(true)
    const last = rowHasRed.lastIndexOf(true)
    if (first === -1) return { seams: -1, blockPx: 0 }
    let seams = 0
    for (let y = first; y <= last; y++) if (!rowHasRed[y]) seams++
    return { seams, blockPx: last - first + 1, imgH: img.height }
  }, shot.toString('base64'))

  await context.close()
  if (result.seams === -1) return { error: 'no red block found in screenshot' }
  return result
}

async function main() {
  const { chromium } = requirePlaywright()
  const bundle = buildRendererBundle()
  // SwiftShader keeps WebGL2 available in headless runs without a GPU.
  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
  })

  await checkContextBudget(browser, bundle.outFile)

  let domSeamsAnywhere = 0
  for (const dpr of DPRS) {
    const dom = await measureSeams(browser, bundle.outFile, dpr, false)
    const webgl = await measureSeams(browser, bundle.outFile, dpr, true)
    const domDetail = dom.error ?? `seams=${dom.seams} blockPx=${dom.blockPx}`
    const webglDetail = webgl.error ?? `seams=${webgl.seams} blockPx=${webgl.blockPx}`
    console.log(`      dpr=${dpr}: DOM ${domDetail}; WebGL ${webglDetail}`)
    if (!dom.error) domSeamsAnywhere += dom.seams
    check(`webgl renderer has no row seams at dpr=${dpr}`, !webgl.error && webgl.seams === 0, webglDetail)
  }
  check(
    'DOM renderer control reproduces row seams at some fractional DPR',
    domSeamsAnywhere > 0,
    `total control seams: ${domSeamsAnywhere}`
  )

  await browser.close()
  bundle.cleanup()
  finish()
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
