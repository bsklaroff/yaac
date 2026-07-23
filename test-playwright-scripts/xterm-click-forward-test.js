/*
 * Browser test for the webapp terminal's click-forwarding patch
 * (patchClickForwarding in packages/frontend/src/lib/selection.ts), driven the
 * way a user drives it: real Chromium, real xterm.js from node_modules, real
 * (trusted) mouse events via Playwright.
 *
 * Simulates tmux `mouse on` with button-event + SGR tracking (1002h + 1006h),
 * wires the terminal exactly like SessionTerminal.tsx (patchForcedSelection +
 * patchKeepSelection + patchClickForwarding), captures everything xterm would
 * send to the pty, and asserts the behavior the patch promises:
 *
 *   - a plain single click is forwarded as one SGR press+release (button 0),
 *     so a TUI button is clickable with no modifier — and it makes no
 *     selection;
 *   - a plain drag still selects locally and forwards NO click (copy path
 *     untouched);
 *   - a plain click after a prior (kept-alive) selection still forwards, i.e.
 *     the leftover selection doesn't swallow the click;
 *   - an Alt+click is reported to tmux exactly once (by xterm itself, with the
 *     alt-modifier bit) and NOT also forwarded by our patch — no double click;
 *   - a double-click still selects a word (copy via double-click survives).
 *
 * Run: node test-playwright-scripts/xterm-click-forward-test.js
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
// @xterm/xterm is a dep of packages/frontend and isn't hoisted to the repo
// root, so resolve it from there rather than assuming a root node_modules path.
const frontendRequire = createRequire(path.join(ROOT, 'packages/frontend/package.json'))
const XTERM_DIR = path.dirname(frontendRequire.resolve('@xterm/xterm/package.json'))

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync('/opt/playwright-browsers')) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/playwright-browsers'
}

function requirePlaywright() {
  try {
    return require('playwright')
  } catch {
    const globalRoot = execSync('npm root -g').toString().trim()
    return require(path.join(globalRoot, 'playwright'))
  }
}

// Bundle the real selection.ts (types stripped, IIFE global) into a temp dir.
function buildPatchBundle() {
  const esbuild = [
    path.join(ROOT, 'node_modules/.bin/esbuild'),
    path.join(ROOT, 'node_modules/.pnpm/node_modules/.bin/esbuild'),
  ].find(fs.existsSync)
  if (!esbuild) throw new Error('esbuild not found under node_modules')
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xterm-click-forward-test-'))
  const outFile = path.join(outDir, 'selection-patch.js')
  execFileSync(esbuild, [
    path.join(ROOT, 'packages/frontend/src/lib/selection.ts'),
    '--bundle',
    '--format=iife',
    '--global-name=selpatch',
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
  const patch = buildPatchBundle()
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1000, height: 600 } })
  page.on('console', (msg) => console.log(`  [page ${msg.type()}] ${msg.text()}`))

  await page.setContent(
    '<!DOCTYPE html><html><body style="margin:0"><div id="t" style="width:900px;height:500px"></div></body></html>'
  )
  await page.addStyleTag({ path: path.join(XTERM_DIR, 'css/xterm.css') })
  await page.addScriptTag({ path: path.join(XTERM_DIR, 'lib/xterm.js') })
  await page.addScriptTag({ path: patch.outFile })
  patch.cleanup()

  // Build the terminal wired exactly like SessionTerminal.tsx.
  await page.evaluate(() => {
    const term = new window.Terminal({ cursorBlink: false, altClickMovesCursor: false })
    window.term = term
    window.reports = [] // everything xterm would send to the pty
    term.onData((d) => window.reports.push(d))
    term.open(document.getElementById('t'))
    if (!window.selpatch.patchForcedSelection(term)) console.error('patchForcedSelection failed')
    if (!window.selpatch.patchKeepSelection(term)) console.error('patchKeepSelection failed')
    if (typeof window.selpatch.patchClickForwarding(term) !== 'function') {
      console.error('patchClickForwarding failed')
    }
  })

  const write = (data) =>
    page.evaluate((d) => new Promise((res) => window.term.write(d, res)), data)

  for (let i = 0; i < 8; i++) await write(`line${i} abcdefghijklmnopqrstuvwxyz0123456789\r\n`)
  // tmux `mouse on`: button-event tracking + SGR encoding.
  await write('\x1b[?1002h\x1b[?1006h')

  // Cell geometry for aiming the mouse at buffer coordinates.
  const geo = await page.evaluate(() => {
    const rect = window.term._core.screenElement.getBoundingClientRect()
    const cell = window.term._core._renderService.dimensions.css.cell
    return { left: rect.left, top: rect.top, cw: cell.width, ch: cell.height }
  })
  const at = (col, row) => ({
    x: geo.left + geo.cw * (col + 0.5),
    y: geo.top + geo.ch * (row + 0.5),
  })
  const selection = () => page.evaluate(() => window.term.getSelection())
  const takeReports = () =>
    page.evaluate(() => {
      const r = window.reports.join('')
      window.reports = []
      return r
    })
  // SGR press/release for the plain (unmodified) left button: code 0.
  const plainPresses = (r) => r.match(/\x1b\[<0;\d+;\d+M/g) || []
  const plainReleases = (r) => r.match(/\x1b\[<0;\d+;\d+m/g) || []

  // --- 1. a plain single click forwards exactly one press + one release ---
  await takeReports()
  const spot = at(5, 2)
  await page.mouse.click(spot.x, spot.y)
  const clickReports = await takeReports()
  check(
    'plain click forwards one SGR press (button 0)',
    plainPresses(clickReports).length === 1,
    JSON.stringify(clickReports)
  )
  check('plain click forwards one SGR release (button 0)', plainReleases(clickReports).length === 1)
  check('plain click makes no selection', (await selection()) === '')

  // --- 2. a plain drag still selects and forwards no click ---
  await takeReports()
  const from = at(6, 3)
  const to = at(15, 3)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 5 })
  await page.mouse.up()
  const dragSel = await selection()
  const dragReports = await takeReports()
  check('plain drag selects text', dragSel.length > 0, JSON.stringify(dragSel))
  check('plain drag forwards no click', !dragReports.includes('\x1b[<'), JSON.stringify(dragReports))

  // --- 3. a plain click after a leftover selection still forwards ---
  // The prior drag's selection is kept alive; the click must still reach the
  // TUI (a single click resets the selection, so nothing is "selected" at the
  // mouseup that decides to forward).
  await takeReports()
  const spot3 = at(2, 6)
  await page.mouse.click(spot3.x, spot3.y)
  const afterSelReports = await takeReports()
  check(
    'click after a selection still forwards',
    plainPresses(afterSelReports).length === 1 && plainReleases(afterSelReports).length === 1,
    JSON.stringify(afterSelReports)
  )
  check('that click cleared the leftover selection', (await selection()) === '')

  // --- 4. Alt+click is reported once by xterm and NOT double-forwarded ---
  // Under Alt, shouldForceSelection is false, so xterm reports the click itself
  // with the alt-modifier bit (button code 8). Our patch must stay out of the
  // way: no second, unmodified (code 0) report.
  await takeReports()
  await page.keyboard.down('Alt')
  const spot4 = at(8, 4)
  await page.mouse.click(spot4.x, spot4.y)
  await page.keyboard.up('Alt')
  const altReports = await takeReports()
  const altPresses = altReports.match(/\x1b\[<8;\d+;\d+M/g) || []
  check('alt+click is reported to tmux (alt bit set)', altPresses.length === 1, JSON.stringify(altReports))
  check('alt+click is not also forwarded as a plain click', plainPresses(altReports).length === 0)

  // --- 5. double-click still selects a word (copy via double-click works) ---
  await takeReports()
  const spot5 = at(3, 7) // inside "line7"
  await page.mouse.dblclick(spot5.x, spot5.y)
  const word = await selection()
  check('double-click selects a word', word.trim().length > 0, JSON.stringify(word))

  await browser.close()
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
