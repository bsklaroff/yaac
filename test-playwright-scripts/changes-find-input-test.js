/*
 * Verifies the Changes pane's find (search) input end-to-end in real Chromium:
 *   - Alt+F opens the Changes pane and moves focus into the find input
 *     (window-capture shortcut in SessionView + pending-focus consumption in
 *     SessionChanges) — including when pressed again while the pane is open.
 *   - Typing a query filters the file list (path or diff-content match) and
 *     the header switches to an "n of m files" count.
 *   - A query matching nothing shows the no-match state.
 *   - Escape clears the query and restores the full list.
 *
 * Needs a running `yaac server` with at least one live session whose worktree
 * has uncommitted changes (the pane diffs the session worktree against its
 * fork base) — e.g. `yaac session create <project>`, then edit files in the
 * pod. Reads the port + lock secret from $YAAC_DATA_DIR/.server.lock
 * (falling back to ~/.yaac) exactly like .claude/skills/run-yaac/driver.mjs.
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

async function mintToken(lock) {
  const res = await fetch(`http://127.0.0.1:${lock.port}/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${lock.secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'one-time' }),
  })
  if (res.status !== 201) throw new Error(`token mint failed: HTTP ${res.status}`)
  return (await res.json()).token
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

  const token = await mintToken(lock)
  await page.goto(`http://127.0.0.1:${lock.port}/?token=${token}`)
  await page.waitForFunction(() => !window.location.search.includes('token='), { timeout: 15_000 })
  // Wait for the session's workspace (the pushed /events snapshot) to arrive.
  await page.waitForTimeout(4000)

  // Alt+F ('Alt+f': a capital F would add shiftKey, which the chord rejects).
  await page.keyboard.press('Alt+f')
  const find = page.locator(FIND)
  await find.waitFor({ state: 'visible', timeout: 10_000 })
  check(true, 'Alt+F opens the Changes pane with a find input')
  check(
    await page.evaluate((sel) => document.activeElement === document.querySelector(sel), FIND),
    'find input holds keyboard focus after Alt+F',
  )
  await page.waitForTimeout(1500) // let the diff load
  const fullCount = await page.locator('text=/^\\d+ files?$/').first().textContent()
  console.log(`  unfiltered header count: ${JSON.stringify(fullCount)}`)
  await shot('changes-find-focused')

  // Typing filters the list down (query is expected to match a strict subset).
  await page.keyboard.type(query)
  await page.waitForTimeout(300)
  const filteredCount = await page.locator('text=/^\\d+ of \\d+ files$/').first().textContent().catch(() => null)
  check(filteredCount !== null, `typing ${JSON.stringify(query)} shows an "n of m files" count`, 'header count did not change')
  console.log(`  filtered header count: ${JSON.stringify(filteredCount)}`)
  // File rows scoped to the changes pane's scrolling list (aria-expanded alone
  // also matches popover triggers — the app's dropdowns and the pane's own
  // base-branch picker): the pane root is the one bg-surface column that
  // contains the find input, and the file list is its overflow-y-auto child.
  const pane = page.locator('div.bg-surface', { has: page.locator(FIND) }).last()
  const rows = await pane.locator('.overflow-y-auto button[aria-expanded]').count()
  const shown = filteredCount ? Number(filteredCount.split(' ')[0]) : NaN
  check(rows === shown && shown > 0, `file rows match the filtered count (${rows} rows, header says ${shown})`)
  await shot('changes-find-filtered')

  // A hopeless query shows the no-match state.
  await find.fill(noMatchQuery)
  await page.waitForTimeout(300)
  check(
    await page.locator(`text=No files match “${noMatchQuery}”`).isVisible(),
    'a no-match query shows the empty-filter state',
  )

  // Escape clears the query; the full list comes back.
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  check(await find.inputValue() === '', 'Escape clears the query')
  check(
    await page.locator(`text=${fullCount}`).first().isVisible(),
    'full file list count returns after clearing',
  )

  // With the pane already open and focus elsewhere, Alt+F re-focuses the input.
  await page.locator('.xterm-helper-textarea').first().focus().catch(() => {})
  await page.keyboard.press('Alt+f')
  await page.waitForTimeout(300)
  check(
    await page.evaluate((sel) => document.activeElement === document.querySelector(sel), FIND),
    'Alt+F re-focuses the find input when the pane is already open',
  )

  await browser.close()
  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed: ${failures.join('; ')}`)
    process.exit(1)
  }
  console.log('\nChanges find input works end-to-end.')
}

main().catch((e) => { console.error(e); process.exit(1) })
