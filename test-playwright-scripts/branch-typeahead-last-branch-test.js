/*
 * Verifies the create dialog's Branch typeahead and the remembered branch
 * (`projects.lastBranch`) in a real browser, with real keyboard/touch events:
 *
 *  1. Typed text is a search: Create is disabled while it is open, Enter
 *     picks the top match (never creates), a search matching nothing says
 *     "No matches", and Escape / blur revert to the chosen branch without
 *     closing the dialog.
 *  2. A create from a picked branch is remembered: reopening the dialog opens
 *     on it (and the project summary carries `lastBranch`).
 *  3. A remembered branch origin no longer lists falls back to origin's
 *     default — simulated by routing the branches API to drop it, since the
 *     project's real origin cannot be edited from here.
 *  4. Branches API slow: the remembered branch is shown but Create waits
 *     for the list, and falls back once the list drops it. Failing: the
 *     remembered branch is dropped and Create is left to origin's default.
 *  5. On a phone viewport, a tap on a suggestion row picks it.
 *
 * Creates ONE real worktree in the chosen project from BRANCH (a non-default
 * branch that exists on its origin) and stops it at the end.
 *
 * Drives the app the server itself serves (`dist/`), at the port in
 * $YAAC_DATA_DIR/server-local/.server.lock — run `pnpm build` +
 * `yaac server restart` first. Needs a credential for the project's
 * last-used agent.
 *
 * Run: PROJECT=<slug> BRANCH=<branch> SEARCH=<substring of BRANCH>
 *        node test-playwright-scripts/branch-typeahead-last-branch-test.js
 * (SCREENSHOT_DIR defaults to /tmp/yaac-shots; playwright is resolved from
 *  the global npm root; browsers live under /opt/playwright-browsers)
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
  const dataDir = process.env.YAAC_DATA_DIR ?? path.join(os.homedir(), '.yaac')
  const candidates = [
    path.join(dataDir, 'server-local', '.server.lock'),
    path.join(dataDir, '.server.lock'),
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'))
  }
  throw new Error(`no .server.lock found (tried ${candidates.join(', ')}) — is the server running?`)
}

let failures = 0
function check(name, cond, detail = '') {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}
function note(name, detail) {
  console.log(`NOTE  ${name}  [${detail}]`)
}

const PROJECT = process.env.PROJECT
const BRANCH = process.env.BRANCH
const SEARCH = process.env.SEARCH ?? BRANCH?.slice(0, 8)
if (!PROJECT || !BRANCH) throw new Error('set PROJECT=<slug> and BRANCH=<non-default branch on origin>')
const SHOTS = process.env.SCREENSHOT_DIR ?? '/tmp/yaac-shots'
const lock = readServerLock()
const origin = `http://127.0.0.1:${lock.port}`
// A loopback origin is this machine's owner: no credential.
const auth = {}

async function listWorktrees() {
  const res = await fetch(`${origin}/api/worktree/list?project=${PROJECT}`, { headers: auth })
  return (await res.json()).worktrees
}

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
let createdId = null
try {
  fs.mkdirSync(SHOTS, { recursive: true })
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await ctx.newPage()
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  await page.goto(`${origin}/?project=${PROJECT}`)
  await page.getByTitle('New worktree').first().waitFor({ state: 'visible', timeout: 15_000 })

  const branch = page.getByLabel('Base branch', { exact: true })
  const prompt = page.getByLabel('Prompt')
  const create = page.getByRole('button', { name: 'Create', exact: true })
  const open = async () => {
    await page.keyboard.press('Alt+KeyN')
    await prompt.waitFor({ state: 'visible' })
    // A locator wait, not waitForFunction: the app's CSP refuses the eval
    // that polling a function needs.
    await create.and(page.locator('button:enabled')).waitFor({ timeout: 15_000 })
  }
  // The dialog's own close button, not Escape: after a reload a live
  // worktree's terminal can hold focus, and Escape then goes to it.
  const close = async () => {
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
    await prompt.waitFor({ state: 'detached' })
  }
  // Let the instant list and the background refresh both land.
  const settle = () => page.waitForTimeout(2500)

  // (1) The typeahead.
  await open()
  await settle()
  const before = await branch.inputValue()
  note('dialog opens on', before)
  await branch.click()
  await branch.fill(SEARCH)
  check('Create is disabled while a branch search is open', await create.isDisabled())
  await page.keyboard.press('Enter')
  check('Enter picks the top match', (await branch.inputValue()) === BRANCH, await branch.inputValue())
  check('…and did not create (dialog still open)', await prompt.isVisible())
  check('Create is enabled again after the pick', await create.isEnabled())

  await branch.fill('zzz-no-such-branch')
  check('a search matching nothing says so', await page.getByText('No matches').isVisible())
  await page.keyboard.press('Enter')
  check('Enter on no match does not create', await prompt.isVisible())
  await page.keyboard.press('Escape')
  check('Escape reverts to the picked branch', (await branch.inputValue()) === BRANCH, await branch.inputValue())
  check('…without closing the dialog', await prompt.isVisible())

  await branch.fill('ma')
  await prompt.click()
  check('blur reverts to the picked branch', (await branch.inputValue()) === BRANCH, await branch.inputValue())
  await page.screenshot({ path: path.join(SHOTS, 'branch-typeahead-picked.png') })

  // (2) Create, then reopen: remembered.
  const knownIds = new Set((await listWorktrees()).map((w) => w.worktreeId))
  await create.click()
  await prompt.waitFor({ state: 'detached' })
  for (let i = 0; i < 60 && createdId === null; i++) {
    const fresh = (await listWorktrees()).find((w) => !knownIds.has(w.worktreeId))
    if (fresh) createdId = fresh.worktreeId
    else await page.waitForTimeout(1000)
  }
  check('the create produced a worktree', createdId !== null, createdId ?? 'none')
  await page.waitForTimeout(1500)
  await open()
  await settle()
  check('reopening opens on the remembered branch', (await branch.inputValue()) === BRANCH, await branch.inputValue())
  await close()

  // (3) Origin no longer lists it: the dialog falls back to origin's default.
  const real = await (await fetch(`${origin}/api/project/${PROJECT}/branches`, { headers: auth })).json()
  // A reload can abort a request mid-route; that one no longer matters.
  const dropIt = async (route) => {
    try {
      const res = await route.fetch()
      const body = await res.json()
      await route.fulfill({ response: res, json: { ...body, branches: body.branches.filter((b) => b !== BRANCH) } })
    } catch { /* the page moved on */ }
  }
  await page.route(`**/api/project/${PROJECT}/branches**`, dropIt)
  // The dialog's query is cached from the last open: reload so it refetches.
  await page.reload()
  await page.getByTitle('New worktree').first().waitFor({ state: 'visible', timeout: 15_000 })
  await open()
  await settle()
  check('a remembered branch origin dropped falls back to the default',
    (await branch.inputValue()) === real.defaultBranch, await branch.inputValue())
  await page.screenshot({ path: path.join(SHOTS, 'branch-typeahead-fallback.png') })
  await close()
  await page.unroute(`**/api/project/${PROJECT}/branches**`, dropIt)

  // (4a) The branches API fails.
  const fail = (route) => route.fulfill({ status: 500, json: { error: { code: 'INTERNAL', message: 'boom' } } })
  await page.route(`**/api/project/${PROJECT}/branches**`, fail)
  await page.reload()
  await page.getByTitle('New worktree').first().waitFor({ state: 'visible', timeout: 15_000 })
  await open()
  await settle()
  check('branches API failing: the remembered branch is dropped', (await branch.inputValue()) === '',
    await branch.inputValue())
  check('branches API failing: Create is enabled, for origin\'s default', await create.isEnabled())
  await close()
  await page.unroute(`**/api/project/${PROJECT}/branches**`, fail)

  // (4b) The branches API is slow, and origin dropped the branch.
  const slow = async (route) => {
    await new Promise((r) => setTimeout(r, 6000))
    await dropIt(route)
  }
  await page.route(`**/api/project/${PROJECT}/branches**`, slow)
  await page.reload()
  await page.getByTitle('New worktree').first().waitFor({ state: 'visible', timeout: 15_000 })
  await page.keyboard.press('Alt+KeyN')
  await prompt.waitFor({ state: 'visible' })
  await page.waitForTimeout(1000)
  check('slow branches API: the remembered branch shows before the list lands',
    (await branch.inputValue()) === BRANCH, await branch.inputValue())
  check('slow branches API: Create waits for the list', await create.isDisabled())
  await page.waitForTimeout(7000)
  check('slow branches API: once the list drops it, the field falls back',
    (await branch.inputValue()) === real.defaultBranch, await branch.inputValue())
  check('slow branches API: …and Create is enabled', await create.isEnabled())
  await close()
  await page.unroute(`**/api/project/${PROJECT}/branches**`, slow)
  await ctx.close()

  // (5) Phone: tap a suggestion row.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  const mpage = await phone.newPage()
  await mpage.goto(`${origin}/?project=${PROJECT}`)
  await mpage.getByTitle('New worktree').first().waitFor({ state: 'visible', timeout: 15_000 })
  await mpage.getByTitle('New worktree').first().tap()
  const mbranch = mpage.getByLabel('Base branch', { exact: true })
  await mbranch.waitFor({ state: 'visible' })
  await mpage.waitForTimeout(2500)
  await mbranch.tap()
  await mbranch.fill(real.defaultBranch)
  await mpage.locator('ul li', { hasText: real.defaultBranch }).first().tap()
  check('phone: a tapped suggestion is picked', (await mbranch.inputValue()) === real.defaultBranch,
    await mbranch.inputValue())
  await mpage.screenshot({ path: path.join(SHOTS, 'branch-typeahead-phone.png') })
  await phone.close()
} finally {
  await browser.close()
  if (createdId !== null) {
    try {
      execSync(`yaac worktree stop ${createdId}`, { stdio: 'ignore' })
      console.log(`stopped ${createdId}`)
    } catch {
      console.log(`could not stop ${createdId} — stop it by hand`)
    }
  }
}
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
