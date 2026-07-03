/*
 * Browser test for the webapp terminal's selection patches
 * (src/frontend/lib/selection.ts), driven the same way a user drives it:
 * real Chromium, real xterm.js from the repo's node_modules, real (trusted)
 * mouse/keyboard events via Playwright.
 *
 * Simulates tmux by enabling the mouse-tracking modes tmux requests:
 *   1002h (button-event tracking) + 1006h (SGR), re-asserted on "redraws"
 *   the way tmux does, and 1003h (any-motion tracking — what tmux forwards
 *   when a pane TUI subscribes to the mouse).
 *
 * Covers: plain drag = local selection with nothing reported to the pty;
 * Alt+drag = SGR mouse reports to the pty; and the selection surviving
 * keystrokes, typing, bare mouse motion under 1003, and mouse-mode churn.
 *
 * Run: node test-playwright-scripts/xterm-selection-test.js
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
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xterm-selection-test-'))
  const outFile = path.join(outDir, 'selection-patch.js')
  execFileSync(esbuild, [
    path.join(ROOT, 'src/frontend/lib/selection.ts'),
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
  const dragSelect = async (row, colFrom, colTo) => {
    const from = at(colFrom, row)
    const to = at(colTo, row)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 5 })
    await page.mouse.up()
  }

  // --- 1. plain drag selects locally, nothing reported to tmux ---
  await takeReports()
  await dragSelect(1, 6, 15)
  const sel = await selection()
  check('plain drag selects text', sel.length > 0, JSON.stringify(sel))
  check('plain drag reports nothing to tmux', (await takeReports()) === '')

  // --- 2. bare mouse move under 1002 (no motion tracking) ---
  await page.mouse.move(...Object.values(at(30, 5)))
  await page.mouse.move(...Object.values(at(2, 6)))
  check('mouse move (1002) keeps selection', (await selection()) === sel)

  // --- 3. keyboard input ---
  await page.evaluate(() => window.term.focus())
  await page.keyboard.press('ArrowDown')
  check('arrow key is sent to pty', (await takeReports()).includes('\x1b[B'))
  check('arrow key keeps selection', (await selection()) === sel, JSON.stringify(await selection()))
  await page.keyboard.type('hi')
  check('typing keeps selection', (await selection()) === sel)

  // --- 4. tmux redraw churn: redundant DECSET of the current mode ---
  await write('\x1b[?1002h\x1b[?1006h')
  check('mode re-assert keeps selection', (await selection()) === sel, JSON.stringify(await selection()))

  // --- 5. protocol switch to any-motion (TUI subscribed to the mouse) ---
  await write('\x1b[?1003h')
  check('protocol switch keeps selection', (await selection()) === sel, JSON.stringify(await selection()))

  // --- 6. bare mouse move under 1003: motion IS reported, selection stays ---
  await takeReports()
  await page.mouse.move(...Object.values(at(25, 3)))
  await page.mouse.move(...Object.values(at(28, 4)), { steps: 3 })
  check('mouse motion is reported to tmux under 1003', (await takeReports()).includes('\x1b[<'))
  check('mouse move (1003) keeps selection', (await selection()) === sel, JSON.stringify(await selection()))

  // --- 7. alt+drag is handed to tmux and leaves the selection alone ---
  await takeReports()
  await page.keyboard.down('Alt')
  await dragSelect(2, 4, 12)
  await page.keyboard.up('Alt')
  const altReports = await takeReports()
  // SGR button codes carry the alt-modifier bit (8): press = <8, drag = <40.
  check('alt+drag reports mouse to tmux', /\x1b\[<(8|40);/.test(altReports), JSON.stringify(altReports.slice(0, 40)))
  check('alt+drag leaves the local selection alone', (await selection()) === sel, JSON.stringify(await selection()))

  // --- 8. a new plain drag replaces the selection; a click clears it ---
  await dragSelect(3, 6, 10)
  const sel2 = await selection()
  check('new drag replaces selection', sel2.length > 0 && sel2 !== sel, JSON.stringify(sel2))
  const spot = at(1, 7)
  await page.mouse.click(spot.x, spot.y)
  check('plain click clears selection', (await selection()) === '')

  await browser.close()
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
