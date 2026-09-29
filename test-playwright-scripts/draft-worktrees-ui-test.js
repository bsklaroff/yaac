/*
 * Verifies draft worktrees (docs/draft-worktrees.md) in a real browser, with
 * real pointer and keyboard events:
 *
 *  1. With no drafts the sidebar has no Drafts section.
 *  2. Closing the create dialog with no prompt asks nothing.
 *  3. Escape with a prompt typed asks Save / Discard / Keep editing, and a
 *     second Escape (on the question) goes back to the form with the prompt
 *     intact — it does not close both dialogs.
 *  4. Save draft closes both and puts the draft in a collapsible Drafts
 *     section at the top of the sidebar; collapsing hides its rows.
 *  5. Clicking the draft reopens the dialog on its prompt and permission mode;
 *     closing it unchanged asks nothing.
 *  6. Editing its prompt and clicking × asks to save changes; saving updates
 *     the row in place (still one draft).
 *  7. Discard (on a new dialog's prompt) closes without saving anything.
 *  8. The row's Discard… deletes the draft, and the section disappears.
 *
 * Creates no worktree. Drafts it saves are discarded by the end; if a check
 * fails midway, discard leftovers from the sidebar.
 *
 * Drives the app the server itself serves (`dist/`) over loopback, reading
 * the port from $YAAC_DATA_DIR/server-local/.server.lock (data dir defaults
 * to ~/.yaac) — so run `pnpm build` + `yaac server restart` first.
 *
 * Run: PROJECT=<slug> node test-playwright-scripts/draft-worktrees-ui-test.js
 * (SCREENSHOT_DIR for screenshots; defaults to /tmp/yaac-shots.
 *  playwright is resolved from the global npm root; browsers live under
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

function readServerLock() {
  const dataDir = process.env.YAAC_DATA_DIR ?? path.join(os.homedir(), '.yaac')
  const p = path.join(dataDir, 'server-local', '.server.lock')
  if (!fs.existsSync(p)) throw new Error(`no ${p} — is the server running?`)
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

let failures = 0
function check(name, cond, detail = '') {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const PROJECT = process.env.PROJECT
if (!PROJECT) throw new Error('set PROJECT=<slug>')
const SHOTS = process.env.SCREENSHOT_DIR ?? '/tmp/yaac-shots'
const lock = readServerLock()
const origin = `http://127.0.0.1:${lock.port}`

const stamp = Date.now()
const idea = `pw draft ${stamp}`

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  await page.goto(`${origin}/?project=${PROJECT}`)
  fs.mkdirSync(SHOTS, { recursive: true })

  const aside = page.locator('aside')
  const drafts = aside.getByRole('group', { name: 'Drafts' })
  const prompt = page.getByLabel('Prompt')
  const question = page.getByRole('alertdialog')
  const open = async () => {
    await aside.getByRole('button', { name: 'New worktree' }).click()
    await prompt.waitFor({ state: 'visible' })
  }
  await aside.getByRole('button', { name: 'New worktree' }).waitFor({ timeout: 15_000 })

  // (1) Nothing to show.
  check('no Drafts section without drafts', await drafts.count() === 0)

  // (2) An empty prompt closes silently.
  await open()
  await page.keyboard.press('Escape')
  await prompt.waitFor({ state: 'detached' })
  check('an empty dialog closes without asking', await question.count() === 0)

  // (3) A typed prompt asks; Escape on the question returns to the form.
  await open()
  await page.keyboard.type(idea)
  await page.getByLabel('Permissions').selectOption('plan')
  await prompt.click()
  await page.keyboard.press('Escape')
  await question.waitFor({ state: 'visible' })
  check('a typed prompt asks before closing', (await question.textContent())?.includes('Save as a draft?') === true)
  // Let the scale-in finish: focus lands, and the screenshot shows the card.
  await page.waitForTimeout(300)
  check('Save draft has focus',
    await question.getByRole('button', { name: 'Save draft' }).evaluate((el) => el === document.activeElement))
  await page.screenshot({ path: path.join(SHOTS, 'draft-question.png') })
  await page.keyboard.press('Escape')
  await question.waitFor({ state: 'detached' })
  check('Escape on the question keeps the form and its prompt',
    await prompt.isVisible() && await prompt.inputValue() === idea)

  // (4) Save it.
  await page.keyboard.press('Escape')
  await question.getByRole('button', { name: 'Save draft' }).click()
  await prompt.waitFor({ state: 'detached' })
  await drafts.waitFor({ state: 'visible', timeout: 10_000 })
  check('the draft shows in a Drafts section', (await drafts.textContent())?.includes(idea) === true)
  check('the section leads the list', await drafts.evaluate((el) => el.previousElementSibling === null))
  await page.screenshot({ path: path.join(SHOTS, 'drafts-section.png') })
  await drafts.getByRole('button', { name: /Drafts/ }).click()
  check('collapsing hides the rows', !(await drafts.getByText(idea).isVisible()))
  await drafts.getByRole('button', { name: /Drafts/ }).click()

  // (5) Reopen it; unchanged, a close asks nothing.
  await drafts.getByText(idea).click()
  await prompt.waitFor({ state: 'visible' })
  check('reopens on its prompt', await prompt.inputValue() === idea)
  check('and its permission mode', await page.getByLabel('Permissions').inputValue() === 'plan')
  await page.keyboard.press('Escape')
  await prompt.waitFor({ state: 'detached' })
  check('closing an unchanged draft asks nothing', await question.count() === 0)

  // (6) Edit and save changes via ×.
  await drafts.getByText(idea).click()
  await prompt.waitFor({ state: 'visible' })
  await prompt.fill(`${idea} edited`)
  await page.getByRole('button', { name: 'Close' }).click()
  await question.waitFor({ state: 'visible' })
  check('an edited draft asks to save changes',
    (await question.textContent())?.includes('Save changes to this draft?') === true)
  await question.getByRole('button', { name: 'Save changes' }).click()
  await prompt.waitFor({ state: 'detached' })
  await drafts.getByText(`${idea} edited`).waitFor({ timeout: 10_000 })
  check('the row updates in place, still one draft', await drafts.getByText(idea).count() === 1)

  // (7) Discard on the question keeps nothing.
  await open()
  await page.keyboard.type(`${idea} throwaway`)
  await page.keyboard.press('Escape')
  await question.getByRole('button', { name: 'Discard' }).click()
  await prompt.waitFor({ state: 'detached' })
  await page.waitForTimeout(500)
  check('Discard saves nothing', await drafts.getByText(`${idea} throwaway`).count() === 0)

  // (8) Discard the draft from its row.
  const row = drafts.locator('div.group.relative', { hasText: idea })
  await row.hover()
  await row.getByRole('button', { name: 'Draft actions' }).click()
  await page.getByRole('menuitem', { name: 'Discard…' }).click()
  await question.getByRole('button', { name: 'Discard' }).click()
  const gone = await drafts.waitFor({ state: 'detached', timeout: 10_000 }).then(() => true, () => false)
  check('discarding the last draft removes the section', gone)
} finally {
  await browser.close()
}
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
