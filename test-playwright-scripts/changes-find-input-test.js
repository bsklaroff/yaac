/*
 * Verifies the Changes pane's find input in real Chromium:
 *   - Alt+G opens and focuses the Changes pane, and Cmd/Ctrl+F then moves
 *     focus into the find input, including from a terminal with the pane
 *     already open.
 *   - A query filters the file list (by path or diff content) and the header
 *     shows "n of m files".
 *   - A query matching nothing shows the no-match state.
 *   - Escape clears the query and restores the full list.
 *
 * Needs a running `yaac server` with a live workspace that has changes
 * against its fork base (e.g. `yaac workspace create <project>`, then edit
 * files in it). Reads the port from $YAAC_DATA_DIR/.server.lock (default
 * ~/.yaac), like .claude/skills/run-yaac/driver.mjs.
 *
 * Run: node test-playwright-scripts/changes-find-input-test.js <query> <no-match-query>
 *   <query>          a string matching a strict subset of the changed files
 *   <no-match-query> a string matching none of them
 * (set SCREENSHOT_DIR to also drop PNGs of the focused + filtered states.)
 * (playwright is resolved from the global npm root; browsers live under
 * /opt/playwright-browsers)
 */
import fs from 'node:fs'
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)

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

function readServerLock() {
  const candidates = [
    process.env.YAAC_DATA_DIR && path.join(process.env.YAAC_DATA_DIR, '.server.lock'),
    path.join(os.homedir(), '.yaac', '.server.lock'),
  ].filter(Boolean)
  for (const p of candidates) {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'))
  }
  throw new Error('no .server.lock found — is the server running?')
}

const [query, noMatchQuery] = process.argv.slice(2)
if (!query || !noMatchQuery) {
  console.error('usage: node changes-find-input-test.js <query> <no-match-query>')
  process.exit(1)
}

const FIND = '[aria-label="Find in changes"]'
const failures = []
function check(ok, label, detail = '') {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

async function main() {
  const { chromium } = requirePlaywright()
  const lock = readServerLock()
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  const shotDir = process.env.SCREENSHOT_DIR
  const shot = async (name) => {
    if (!shotDir) return
    const out = path.join(shotDir, `${name}.png`)
    await page.screenshot({ path: out })
    console.log(`  screenshot → ${out}`)
  }

  await page.goto(`http://127.0.0.1:${lock.port}/`)
  // Wait for the workspace to arrive in the /events snapshot.
  await page.waitForTimeout(4000)

  // Lowercase 'Alt+g': a capital G adds shiftKey, which the chord rejects.
  await page.keyboard.press('Alt+g')
  const find = page.locator(FIND)
  await find.waitFor({ state: 'visible', timeout: 10_000 })
  check(true, 'Alt+G opens the Changes pane with a find input')
  await page.waitForTimeout(300)
  await page.keyboard.press('ControlOrMeta+f')
  check(
    await page.evaluate((sel) => document.activeElement === document.querySelector(sel), FIND),
    'find input holds keyboard focus after Alt+G, Cmd/Ctrl+F',
  )
  await page.waitForTimeout(1500) // let the diff load
  const fullCount = await page.locator('text=/^\\d+ files?$/').first().textContent()
  console.log(`  unfiltered header count: ${JSON.stringify(fullCount)}`)
  await shot('changes-find-focused')

  await page.keyboard.type(query)
  await page.waitForTimeout(300)
  const filteredCount = await page.locator('text=/^\\d+ of \\d+ files$/').first().textContent().catch(() => null)
  check(filteredCount !== null, `typing ${JSON.stringify(query)} shows an "n of m files" count`, 'header count did not change')
  console.log(`  filtered header count: ${JSON.stringify(filteredCount)}`)
  // Scope file rows to the pane's scrolling list, since aria-expanded also
  // matches dropdown triggers. The pane is the bg-surface column holding the
  // find input; the list is its overflow-y-auto child.
  const pane = page.locator('div.bg-surface', { has: page.locator(FIND) }).last()
  const rows = await pane.locator('.overflow-y-auto button[aria-expanded]').count()
  const shown = filteredCount ? Number(filteredCount.split(' ')[0]) : NaN
  check(rows === shown && shown > 0, `file rows match the filtered count (${rows} rows, header says ${shown})`)
  await shot('changes-find-filtered')

  await find.fill(noMatchQuery)
  await page.waitForTimeout(300)
  check(
    await page.locator(`text=No files match “${noMatchQuery}”`).isVisible(),
    'a no-match query shows the empty-filter state',
  )

  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  check(await find.inputValue() === '', 'Escape clears the query')
  check(
    await page.locator(`text=${fullCount}`).first().isVisible(),
    'full file list count returns after clearing',
  )

  // From a terminal with the pane open, Alt+G then Cmd/Ctrl+F reaches the
  // input.
  await page.locator('.xterm-helper-textarea').first().focus().catch(() => {})
  await page.keyboard.press('Alt+g')
  await page.waitForTimeout(300)
  await page.keyboard.press('ControlOrMeta+f')
  check(
    await page.evaluate((sel) => document.activeElement === document.querySelector(sel), FIND),
    'Alt+G, Cmd/Ctrl+F re-focuses the find input from a terminal',
  )

  await browser.close()
  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed: ${failures.join('; ')}`)
    process.exit(1)
  }
  console.log('\nChanges find input works end-to-end.')
}

main().catch((e) => { console.error(e); process.exit(1) })
