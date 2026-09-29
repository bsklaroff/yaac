/*
 * Verifies the create dialog's title and group controls in a real browser,
 * with real mouse and keyboard events:
 *
 *  1. The heading reads "New worktree" with a pencil beside it; clicking the
 *     pencil turns it into a title editor, and Enter commits the typed title
 *     to the heading WITHOUT submitting the dialog.
 *  2. Picking "+ New group" in the Group dropdown swaps it for a focused name
 *     box; Esc in that box goes back to the dropdown and leaves the dialog
 *     open.
 *  3. The branch typeahead sits in a row labeled "Base branch".
 *
 * Creates nothing: it closes the dialog (discarding) at the end.
 *
 * Drives the server `server.json` selects (`$YAAC_DATA_DIR-client`, data dir
 * defaults to ~/.yaac) — run `pnpm build` + `yaac server restart` first, or
 * you are looking at the frontend as it was.
 *
 * Run: node test-playwright-scripts/create-dialog-title-group-test.js
 * (screenshots land in SCREENSHOT_DIR, default /tmp/yaac-shots; playwright is
 *  resolved from the global npm root; browsers live under
 *  /opt/playwright-browsers)
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

const dataDir = process.env.YAAC_DATA_DIR || path.join(os.homedir(), '.yaac')
const server = JSON.parse(fs.readFileSync(`${dataDir}-client/server.json`, 'utf8'))
const shots = process.env.SCREENSHOT_DIR ?? '/tmp/yaac-shots'
fs.mkdirSync(shots, { recursive: true })

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
let failed = false
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`)
  if (!ok) failed = true
}

try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  await page.goto(server.url)
  await page.locator('[aria-label="New worktree"]').first().click({ timeout: 15_000 })
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Agent').waitFor()

  const heading = dialog.getByRole('heading')
  check(await heading.textContent() === 'New worktree', 'heading starts as "New worktree"')
  await dialog.getByRole('button', { name: 'Rename worktree' }).click()
  const titleInput = dialog.getByLabel('Worktree title')
  check(await titleInput.evaluate((el) => el === document.activeElement), 'pencil focuses the title editor')
  await page.keyboard.type('Fix the build')
  await page.screenshot({ path: path.join(shots, 'create-dialog-title-editing.png') })
  await page.keyboard.press('Enter')
  await page.waitForTimeout(200)
  check(await heading.textContent() === 'Fix the build', 'Enter commits the title to the heading')
  check(await dialog.isVisible(), 'Enter in the title editor leaves the dialog open')

  await dialog.getByLabel('Group').selectOption({ label: '+ New group' })
  const nameBox = dialog.getByLabel('New group name')
  // Waits rather than reads at once, so a loaded machine's slow render is
  // not a lost name — typing into nothing would then let Esc close the dialog.
  const focused = await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'New group name',
    null, { timeout: 2000 }).then(() => true, () => false)
  check(focused && await nameBox.isVisible(), '"+ New group" focuses a name box')
  await page.keyboard.type('Release prep')
  await page.waitForTimeout(200)
  await page.screenshot({ path: path.join(shots, 'create-dialog-new-group.png') })
  await page.keyboard.press('Escape')
  const backToList = await dialog.locator('select[aria-label="Group"]').waitFor({ timeout: 2000 })
    .then(() => true, () => false)
  check(backToList, 'Esc goes back to the dropdown')
  check(await dialog.isVisible(), 'Esc in the name box leaves the dialog open')

  const branchRow = dialog.getByLabel('Base branch').locator('xpath=ancestor::div[span][1]')
  check((await branchRow.locator('> span').first().textContent()) === 'Base branch', 'branch input is labeled "Base branch"')
} finally {
  await browser.close()
}
process.exit(failed ? 1 : 0)
