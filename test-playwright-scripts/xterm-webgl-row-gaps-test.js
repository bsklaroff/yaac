/*
 * Browser test for the webapp terminal's WebGL renderer fix
 * (src/frontend/lib/webgl-renderer.ts): xterm's stock DOM renderer lays rows
 * out on the CSS-pixel grid, and at fractional devicePixelRatios (browser
 * zoom, hidpi scaling) the per-row rounding leaves hairline seams of page
 * background between adjacent rows — the "extra blank space that slices up
 * solid-colored animations". The WebGL renderer rasterizes on the
 * device-pixel grid and must not show any seams.
 *
 * Renders a block of solid red rows (terminal options copied from
 * SessionTerminal.tsx) at several devicePixelRatios, screenshots at device
 * scale, and scans pixel rows inside the block for seams: rows containing no
 * red at all. The DOM renderer runs as the control — expected to seam at at
 * least one fractional DPR, proving the harness can see the bug — and the
 * WebGL renderer (via the real enableWebglRenderer, bundled from source)
 * must render zero seam rows at every DPR.
 *
 * Run: node test-playwright-scripts/xterm-webgl-row-gaps-test.js
 * (playwright is resolved from the global npm root; browsers live under
 * /opt/playwright-browsers)
 */
import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const XTERM_DIR = path.join(ROOT, 'node_modules/@xterm/xterm')

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
    path.join(ROOT, 'apps/frontend/src/lib/webgl-renderer.ts'),
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
 * Render the solid block with the given renderer at the given DPR and count
 * seam rows: device-pixel rows inside the block with no red pixel at all.
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

  // Terminal options mirror SessionTerminal.tsx.
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
    return wantWebgl ? window.webglr.enableWebglRenderer(term) : null
  }, useWebgl)
  if (useWebgl && !webglLoaded) {
    await context.close()
    return { error: 'WebGL addon failed to load (no WebGL2 in this browser)' }
  }

  // A block of rows fully painted with a solid red background.
  await page.evaluate(
    (rows) =>
      new Promise((res) => {
        const line = '\x1b[48;2;255;0;0m' + ' '.repeat(window.term.cols) + '\x1b[0m\r\n'
        window.term.write(line.repeat(rows), res)
      }),
    BLOCK_ROWS
  )
  // One settled frame: both renderers paint on rAF after the write parses.
  await page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))))

  const shot = await page.locator('.xterm-screen').screenshot({ scale: 'device' })

  // Decode in-page (browser PNG decoder + 2D canvas) and scan pixel rows.
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
  // SwiftShader flags keep WebGL2 available in headless runs without a GPU.
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
  // Control: the harness must be able to see the bug it guards against.
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
