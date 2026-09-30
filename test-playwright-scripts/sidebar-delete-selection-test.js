/*
 * Verifies where the selection lands when the open workspace is deleted,
 * in Chromium against the running server.
 *
 *  1. A workspace that disappears from under the open pane (stopped by the
 *     CLI here, by the stale reaper in practice) hands the pane to the
 *     topmost remaining row. Nothing local knew it was going, so there is no
 *     neighbour to pick.
 *  2. Deleting the selected workspace in the app selects the row below it.
 *  3. Deleting the bottom row falls back to the row above, skipping rows
 *     still shown as greyed "stopping…" placeholders, which can't be
 *     selected.
 *
 * The selection is read from the URL (?project=…&workspace=<id>), which
 * `persistSelection` keeps in sync.
 *
 * Needs a running `yaac server` with at least FOUR live workspaces in the
 * selected project (`yaac workspace create <project>` x4). It DELETES three
 * of them, so use workspaces you can lose. Reads the port from
 * $YAAC_DATA_DIR/.server.lock and drives the app served from `dist/`, so run
 * `pnpm build` + `yaac server restart` first.
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
/** The workspace id the URL says is open. */
const selectedId = (page) => new URL(page.url()).searchParams.get('workspace')

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

  await page.goto(`http://127.0.0.1:${lock.port}/`)
  const rows = page.locator('[aria-label="Ungrouped workspaces"] > div')
  await rows.first().waitFor({ state: 'visible', timeout: 15_000 })
  await page.waitForTimeout(3000)

  // Record row order as ids by clicking each row and reading the URL.
  const ids = []
  const count = await rows.count()
  if (count < 4) throw new Error(`need at least 4 workspace rows, found ${count}`)
  for (let i = 0; i < count; i++) {
    await rows.nth(i).locator('button').first().click()
    await page.waitForTimeout(250)
    ids.push(selectedId(page))
  }
  console.log(`sidebar rows, top to bottom: ${ids.join(', ')}`)

  // Find rows by id, not index: a stopping row disappears once cleanup
  // finishes, which shifts indexes. Leaves the target row selected.
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
    await rows.nth(i).locator('[aria-label="Stop workspace"]').click()
    await page.locator('text=Stop workspace?').waitFor({ state: 'visible', timeout: 5000 })
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    await page.waitForTimeout(500)
  }
  /** Wait for the selection to settle somewhere other than `from`. */
  const awaitSelectionChange = async (from) => {
    for (let i = 0; i < 40 && selectedId(page) === from; i++) await page.waitForTimeout(500)
    return selectedId(page)
  }

  // 1. Stopped outside the app while open: the top row takes over.
  await selectRow(ids[1])
  check('middle row selected', selectedId(page), ids[1])
  execSync(`yaac workspace stop ${ids[1]}`, { stdio: 'ignore' })
  check('workspace vanished -> topmost row', await awaitSelectionChange(ids[1]), ids[0])

  // 2. Deleted in the app: the row below takes over.
  await deleteSelectedRow(ids[2])
  check('delete selected -> row below', selectedId(page), ids[3])

  // 3. ids[3] is selected and at the bottom, with only stopping rows between
  //    it and the top row, so the selection goes up to ids[0].
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
