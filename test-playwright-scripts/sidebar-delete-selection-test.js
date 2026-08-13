/*
 * Verifies where the selection lands when the open worktree is deleted from
 * the sidebar, in real Chromium against the running server.
 *
 *  1. Deleting the selected worktree selects the row BELOW it — not the first
 *     waiting one, not the top row.
 *  2. Deleting the bottom row falls back to the row above it, skipping the
 *     row left behind as a greyed "stopping…" placeholder by step 1 (a
 *     terminating row isn't selectable, so it can't inherit the selection).
 *  3. A worktree that vanishes from under the open pane — deleted by the CLI
 *     here, the stale reaper in the wild — hands the pane to the topmost
 *     remaining row instead of leaving a dead one on screen. There is no
 *     neighbour to walk to in that case: nothing local knows it is going.
 *
 * Selection is read from the URL, which `persistSelection` mirrors on every
 * change (?project=…&worktree=<id>) — an unambiguous readout that doesn't
 * depend on which class marks the selected row.
 *
 * Needs a running `yaac server` with at least FOUR live worktrees in the
 * selected project (`yaac worktree create <project>` ×4), and it DELETES three
 * of them — run it against worktrees you are willing to lose. Reads the port
 * + lock secret from $YAAC_DATA_DIR/.server.lock and drives the app the
 * server serves out of `dist/`, so run `pnpm build` + `yaac server restart`
 * first or you are testing the frontend as it was.
 *
 * Run: node test-playwright-scripts/sidebar-delete-selection-test.js
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
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
    return require(path.join(execSync('npm root -g').toString().trim(), 'playwright'))
  }
}
function readServerLock() {
  const candidates = [
    process.env.YAAC_DATA_DIR && path.join(process.env.YAAC_DATA_DIR, '.server.lock'),
    path.join(os.homedir(), '.yaac', '.server.lock'),
  ].filter(Boolean)
  for (const p of candidates) if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'))
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

/** The worktree id the URL says is open. */
const selectedId = (page) => new URL(page.url()).searchParams.get('worktree')

const lock = readServerLock()
const { chromium } = requirePlaywright()
const browser = await chromium.launch()
const failures = []
const check = (label, actual, expected) => {
  const ok = actual === expected
  failures.push(...(ok ? [] : [`${label}: expected ${expected}, got ${actual}`]))
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label} -> ${actual}`)
}

try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await ctx.newPage()
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))

  await page.goto(`http://127.0.0.1:${lock.port}/?token=${await mintToken(lock)}`)
  await page.waitForFunction(() => !window.location.search.includes('token='), { timeout: 15_000 })
  const rows = page.locator('[aria-label="Ungrouped worktrees"] > div')
  await rows.first().waitFor({ state: 'visible', timeout: 15_000 })
  await page.waitForTimeout(3000)

  // Row order top-to-bottom, as ids: click each row and read the URL back.
  const ids = []
  const count = await rows.count()
  if (count < 4) throw new Error(`need at least 4 worktree rows, found ${count}`)
  for (let i = 0; i < count; i++) {
    await rows.nth(i).locator('button').first().click()
    await page.waitForTimeout(250)
    ids.push(selectedId(page))
  }
  console.log(`sidebar rows, top to bottom: ${ids.join(', ')}`)

  // Rows are addressed by id, not by index: a terminating row disappears the
  // moment the server's cleanup lands, so an index captured a step ago can
  // point at a different worktree by the time it is used. Clicking a row
  // selects it, which is how its index is identified — and the last click is
  // always the row about to be acted on.
  const selectRow = async (id) => {
    const n = await rows.count()
    for (let i = 0; i < n; i++) {
      await rows.nth(i).locator('button').first().click()
      await page.waitForTimeout(250)
      if (selectedId(page) === id) return i
    }
    throw new Error(`no sidebar row for ${id}`)
  }
  const deleteSelectedRow = async (id) => {
    const i = await selectRow(id)
    await rows.nth(i).hover()
    await rows.nth(i).locator('[aria-label="Delete worktree"]').click()
    await page.locator('text=Delete worktree?').waitFor({ state: 'visible', timeout: 5000 })
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await page.waitForTimeout(500)
  }
  /** Wait for the selection to settle somewhere other than `from`. */
  const awaitSelectionChange = async (from) => {
    for (let i = 0; i < 40 && selectedId(page) === from; i++) await page.waitForTimeout(500)
    return selectedId(page)
  }

  // 1. A worktree deleted outside the app, with its pane open: no neighbour
  //    can inherit, so the top row takes over.
  await selectRow(ids[1])
  check('middle row selected', selectedId(page), ids[1])
  execSync(`yaac worktree stop ${ids[1]}`, { stdio: 'ignore' })
  check('worktree vanished -> topmost row', await awaitSelectionChange(ids[1]), ids[0])

  // 2. Deleting the open worktree in the app hands the selection downward.
  await deleteSelectedRow(ids[2])
  check('delete selected -> row below', selectedId(page), ids[3])

  // 3. ids[3] is now both selected and the bottom row, and everything between
  //    it and the top row is a greyed "stopping…" placeholder. The fallback
  //    goes up, and a terminating row can't take the selection.
  await deleteSelectedRow(ids[3])
  check('delete bottom row -> row above, skipping the stopping ones', selectedId(page), ids[0])

  fs.mkdirSync('/tmp/yaac-shots', { recursive: true })
  await page.screenshot({ path: '/tmp/yaac-shots/sidebar-delete-selection.png' })
  console.log('screenshot -> /tmp/yaac-shots/sidebar-delete-selection.png')
} catch (err) {
  failures.push(`error: ${err instanceof Error ? err.message : String(err)}`)
} finally {
  await browser.close()
}

console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\nFAILURES:\n${failures.join('\n')}`)
process.exit(failures.length === 0 ? 0 : 1)
