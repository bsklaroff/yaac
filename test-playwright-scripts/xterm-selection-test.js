/*
 * Verifies the terminal mouse patches (patchForcedSelection,
 * patchKeepSelection and patchClickForwarding in
 * packages/frontend/src/lib/selection.ts) in Chromium with the real xterm.js
 * and trusted Playwright mouse/keyboard events, wired as
 * WorkspaceTerminal.tsx wires them. The unit tests drive the same patches
 * with synthetic events; this checks the gestures a browser really sends.
 *
 * Simulates the mouse modes tmux requests: 1002h (button-event tracking) +
 * 1006h (SGR), re-sent on redraws as tmux does, and 1003h (any-motion,
 * which tmux enables when a pane's TUI subscribes to the mouse). Records
 * everything xterm would send to the pty and checks that:
 *   - a plain click is forwarded as one SGR press + release and selects
 *     nothing, so TUI buttons work without a modifier;
 *   - a plain drag selects locally and sends nothing;
 *   - the selection survives keystrokes, typing, mouse motion under 1002 and
 *     1003, and mouse-mode changes;
 *   - Alt+click and Alt+drag go to tmux (alt bit set, reported once) and
 *     leave the selection alone;
 *   - a click after a selection clears it and still forwards;
 *   - a double-click selects a word.
 *
 * No server needed. Run: node test-playwright-scripts/xterm-selection-test.js
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
const frontendRequire = createRequire(path.join(ROOT, 'packages/frontend/package.json'))
const XTERM_DIR = path.dirname(frontendRequire.resolve('@xterm/xterm/package.json'))

/** Bundles the real selection.ts as an IIFE exposing `window.selpatch`. */
function buildPatchBundle() {
  const esbuild = path.join(ROOT, 'node_modules/.pnpm/node_modules/.bin/esbuild')
  const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xterm-selection-test-')), 'selection.js')
  execFileSync(esbuild, [
    path.join(ROOT, 'packages/frontend/src/lib/selection.ts'),
    '--bundle', '--format=iife', '--global-name=selpatch', '--log-level=warning', `--outfile=${outFile}`,
  ])
  return outFile
}

const { chromium } = requirePlaywright()
const bundle = buildPatchBundle()
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1000, height: 600 } })
page.on('console', (msg) => console.log(`  [page ${msg.type()}] ${msg.text()}`))

await page.setContent(
  '<!DOCTYPE html><html><body style="margin:0"><div id="t" style="width:900px;height:500px"></div></body></html>'
)
await page.addStyleTag({ path: path.join(XTERM_DIR, 'css/xterm.css') })
await page.addScriptTag({ path: path.join(XTERM_DIR, 'lib/xterm.js') })
await page.addScriptTag({ path: bundle })
fs.rmSync(path.dirname(bundle), { recursive: true, force: true })

await page.evaluate(() => {
  const term = new window.Terminal({ cursorBlink: false, altClickMovesCursor: false })
  window.term = term
  window.reports = [] // everything xterm would send to the pty
  term.onData((d) => window.reports.push(d))
  term.open(document.getElementById('t'))
  if (!window.selpatch.patchForcedSelection(term)) console.error('patchForcedSelection failed')
  if (!window.selpatch.patchKeepSelection(term)) console.error('patchKeepSelection failed')
  if (typeof window.selpatch.patchClickForwarding(term) !== 'function') console.error('patchClickForwarding failed')
})

const write = (data) => page.evaluate((d) => new Promise((res) => window.term.write(d, res)), data)
for (let i = 0; i < 8; i++) await write(`line${i} abcdefghijklmnopqrstuvwxyz0123456789\r\n`)
await write('\x1b[?1002h\x1b[?1006h')

// Cell geometry for aiming the mouse at buffer coordinates.
const geo = await page.evaluate(() => {
  const rect = window.term._core.screenElement.getBoundingClientRect()
  const cell = window.term._core._renderService.dimensions.css.cell
  return { left: rect.left, top: rect.top, cw: cell.width, ch: cell.height }
})
const at = (col, row) => [geo.left + geo.cw * (col + 0.5), geo.top + geo.ch * (row + 0.5)]
const selection = () => page.evaluate(() => window.term.getSelection())
const takeReports = () =>
  page.evaluate(() => {
    const r = window.reports.join('')
    window.reports = []
    return r
  })
const count = (r, re) => (r.match(re) || []).length
// SGR press/release for the unmodified left button (code 0).
const PRESS = /\x1b\[<0;\d+;\d+M/g
const RELEASE = /\x1b\[<0;\d+;\d+m/g
const dragSelect = async (row, colFrom, colTo) => {
  await page.mouse.move(...at(colFrom, row))
  await page.mouse.down()
  await page.mouse.move(...at(colTo, row), { steps: 5 })
  await page.mouse.up()
}

// A plain click forwards one press + one release and selects nothing.
await takeReports()
await page.mouse.click(...at(5, 2))
let r = await takeReports()
check('plain click forwards one SGR press + release', count(r, PRESS) === 1 && count(r, RELEASE) === 1, JSON.stringify(r))
check('plain click makes no selection', (await selection()) === '')

// A plain drag selects locally and reports nothing.
await dragSelect(1, 6, 15)
const sel = await selection()
check('plain drag selects text', sel.length > 0, JSON.stringify(sel))
check('plain drag reports nothing to tmux', (await takeReports()) === '')

await page.mouse.move(...at(30, 5))
await page.mouse.move(...at(2, 6))
check('mouse move (1002) keeps selection', (await selection()) === sel)

await page.evaluate(() => window.term.focus())
await page.keyboard.press('ArrowDown')
check('arrow key is sent to pty', (await takeReports()).includes('\x1b[B'))
check('arrow key keeps selection', (await selection()) === sel, JSON.stringify(await selection()))
await page.keyboard.type('hi')
check('typing keeps selection', (await selection()) === sel)

await write('\x1b[?1002h\x1b[?1006h')
check('mode re-assert keeps selection', (await selection()) === sel)
await write('\x1b[?1003h')
check('protocol switch to 1003 keeps selection', (await selection()) === sel)

await takeReports()
await page.mouse.move(...at(25, 3))
await page.mouse.move(...at(28, 4), { steps: 3 })
check('mouse motion is reported to tmux under 1003', (await takeReports()).includes('\x1b[<'))
check('mouse move (1003) keeps selection', (await selection()) === sel, JSON.stringify(await selection()))

// Alt sets bit 8 in the SGR button code: press = <8, drag = <40.
await takeReports()
await page.keyboard.down('Alt')
await dragSelect(2, 4, 12)
await page.keyboard.up('Alt')
r = await takeReports()
check('alt+drag reports mouse to tmux', /\x1b\[<(8|40);/.test(r), JSON.stringify(r.slice(0, 40)))
check('alt+drag leaves the local selection alone', (await selection()) === sel, JSON.stringify(await selection()))

await page.keyboard.down('Alt')
await page.mouse.click(...at(8, 4))
await page.keyboard.up('Alt')
r = await takeReports()
check('alt+click is reported once with the alt bit', count(r, /\x1b\[<8;\d+;\d+M/g) === 1, JSON.stringify(r))
check('alt+click is not also forwarded as a plain click', count(r, PRESS) === 0)

await dragSelect(3, 6, 10)
const sel2 = await selection()
check('new drag replaces selection', sel2.length > 0 && sel2 !== sel, JSON.stringify(sel2))

// The click clears the selection before the mouseup decides to forward.
await takeReports()
await page.mouse.click(...at(2, 6))
r = await takeReports()
check('click after a selection clears it', (await selection()) === '')
check('click after a selection still forwards', count(r, PRESS) === 1 && count(r, RELEASE) === 1, JSON.stringify(r))

await page.mouse.dblclick(...at(3, 7)) // inside "line7"
const word = await selection()
check('double-click selects a word', word.trim().length > 0, JSON.stringify(word))

await browser.close()
finish()
