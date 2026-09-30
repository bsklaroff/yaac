/*
 * Verifies that the WebGL terminal renderer
 * (packages/frontend/src/lib/webgl-renderer.ts) shows no seams between rows.
 * xterm's DOM renderer lays rows out in CSS pixels, so at fractional
 * devicePixelRatios (browser zoom, hidpi scaling) rounding leaves hairlines
 * of background between rows, slicing up solid-colored output. The WebGL
 * renderer draws in device pixels and should have none.
 *
 * Renders a block of solid red rows (terminal options as in
 * WorkspaceTerminal.tsx) at several DPRs, screenshots at device scale, and
 * counts pixel rows inside the block with no red. The DOM renderer is the
 * control and must seam at some fractional DPR, proving the harness can see
 * the bug. The WebGL renderer (via the real createWebglController) must show
 * zero seams at every DPR.
 *
 * Run: node test-playwright-scripts/xterm-webgl-row-gaps-test.js
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

const DPRS = [1, 1.25, 1.5, 2]
const BLOCK_ROWS = 20

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
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xterm-webgl-gaps-test-'))
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
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
