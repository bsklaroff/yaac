/**
 * Verifies a sidebar group's stopped-worktree controls against a live server:
 *
 *  1. The header counts active members against all of them — `(1/2)`.
 *  2. The header's `…` menu (Group actions) offers Rename, Pin/Unpin, Show
 *     stopped worktrees and Delete group; stopped rows are hidden until
 *     "Show stopped worktrees" is picked, and hidden again by "Hide…".
 *  3. In a group whose members have all stopped, the caret and the menu item
 *     are one toggle: the caret shows the stopped rows, the menu then offers
 *     "Hide…" and picking it collapses the caret again.
 *
 * Precondition (set up with the CLI against the server under test):
 *   MIXED_GROUP  — a group with one running and at least one stopped member
 *   STOPPED_GROUP — a pinned group whose only members are stopped
 * e.g. `yaac group create yaac Release; yaac group create yaac Parked`
 *      (created first, so both are pinned), then
 *      `yaac worktree create yaac --group Release` twice and
 *      `yaac worktree create yaac --group Parked` once, and
 *      `yaac worktree stop` one Release member and the Parked one.
 *
 * Run: MIXED_GROUP=Release STOPPED_GROUP=Parked \
 *        node test-playwright-scripts/group-stopped-toggle-test.js
 * (PROJECT defaults to yaac; screenshots land in /tmp/yaac-shots, APP_URL
 * overrides the server origin. playwright is resolved from the global npm
 * root; browsers live under /opt/playwright-browsers.)
 */
import fs from 'node:fs'
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'
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

const SHOTS = process.env.SCREENSHOT_DIR ?? '/tmp/yaac-shots'
const PROJECT = process.env.PROJECT ?? 'yaac'
const MIXED = process.env.MIXED_GROUP ?? 'Release'
const STOPPED = process.env.STOPPED_GROUP ?? 'Parked'
const origin = process.env.APP_URL ?? 'http://127.0.0.1:8787'

let failed = 0
function check(name, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failed++
}

const { chromium } = requirePlaywright()
fs.mkdirSync(SHOTS, { recursive: true })
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.goto(`${origin}/?project=${PROJECT}`)

const section = (name) => page.locator(`aside [role="group"][aria-label="${name}"]`)
const ghosts = (name) => section(name).locator('button[title="Read this worktree\'s conversation"]')
const caret = (name) => section(name).locator('button[aria-expanded]').first()
async function pick(name, item) {
  await caret(name).hover()
  await section(name).getByRole('button', { name: 'Group actions' }).first().click()
  await page.getByRole('menuitem', { name: item }).click()
  await page.getByRole('menu').waitFor({ state: 'detached' })
}

await section(MIXED).waitFor({ timeout: 20_000 })
await page.waitForTimeout(1500)

// 1. counts
check(`${MIXED} header reads (active/total)`, /\(1\/\d+\)/.test(await caret(MIXED).innerText()))
check(`${STOPPED} header reads (0/n)`, /\(0\/\d+\)/.test(await caret(STOPPED).innerText()))

// 2. the mixed group's menu
check('stopped rows start hidden', await ghosts(MIXED).count() === 0)
await caret(MIXED).hover()
await section(MIXED).getByRole('button', { name: 'Group actions' }).first().click()
const items = await page.getByRole('menuitem').allInnerTexts()
check(`menu items: ${items.join(', ')}`,
  ['Rename', 'Show stopped worktrees', 'Delete group'].every((i) => items.includes(i)))
await page.screenshot({ path: path.join(SHOTS, 'group-menu.png') })
await page.getByRole('menuitem', { name: 'Show stopped worktrees' }).click()
await page.getByRole('menu').waitFor({ state: 'detached' })
check('Show reveals the stopped rows', await ghosts(MIXED).count() > 0)
await page.screenshot({ path: path.join(SHOTS, 'group-shown.png') })
await pick(MIXED, 'Hide stopped worktrees')
check('Hide hides them again', await ghosts(MIXED).count() === 0)

// 3. the all-stopped group: caret and menu are one toggle
check(`${STOPPED} starts collapsed`, await caret(STOPPED).getAttribute('aria-expanded') === 'false')
await caret(STOPPED).click()
check('caret shows the stopped rows', await ghosts(STOPPED).count() > 0)
await pick(STOPPED, 'Hide stopped worktrees')
check('menu Hide hides them', await ghosts(STOPPED).count() === 0)
check('...and collapses the caret', await caret(STOPPED).getAttribute('aria-expanded') === 'false')
await pick(STOPPED, 'Show stopped worktrees')
check('menu Show expands the caret', await caret(STOPPED).getAttribute('aria-expanded') === 'true')
await caret(STOPPED).click()
check('caret hides them again', await ghosts(STOPPED).count() === 0)

await browser.close()
console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
process.exit(failed ? 1 : 0)
