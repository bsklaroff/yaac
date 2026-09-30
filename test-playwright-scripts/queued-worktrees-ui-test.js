/*
 * Verifies the queued-worktree UI (docs/queued-worktrees.md) in a real
 * browser, with real pointer and keyboard events, against a live worktree:
 *
 *  1. A sidebar row's hover icons are one `…` menu: Rename, Move to group…,
 *     Queue worktree after this…, Stop….
 *  2. "Queue worktree after this…" opens the create dialog with Start set to
 *     that worktree, the prompt focused, a Queue button, and the branch marked
 *     "latest from origin"; typing a prompt + Enter queues it, and the entry
 *     shows nested under the worktree with a "· queued" meta line.
 *  3. The queued row's own menu queues a second entry after it, which nests
 *     one step deeper (a chain).
 *  3b. The worktree's whole queued set sits behind one "2 queued worktrees"
 *     expander (the chain counted, and no expander of its own), open because
 *     the user just queued into it; clicking it hides both rows and clicking
 *     again brings them back. After a reload the set starts collapsed.
 *  4. Clicking a queued row opens the dialog in edit mode; Save updates it.
 *  5. The row menu's Stop… lists the queued children ("Stop and start 1
 *     queued"), marks the chained one as waiting, and its Edit opens the
 *     create dialog stacked over the stop dialog — typing reaches it, and Esc
 *     closes only it. The stop is then CANCELLED: nothing is stopped.
 *  6. Discard… on the top entry confirms where its child moves; confirming
 *     removes it and splices the child up under the worktree. The child is
 *     then discarded too, leaving nothing queued behind.
 *
 * Needs one running worktree in PROJECT (the first one listed is used; set
 * WORKTREE=<id> to pick another). It is never stopped. Queued entries it
 * makes are discarded by the end; if a check fails midway, discard leftovers
 * from the sidebar.
 *
 * Drives the app the server itself serves (`dist/`), at the origin
 * `$YAAC_DATA_DIR-client/server.json` selects (data dir defaults to ~/.yaac)
 * with no credential, as a loopback origin is this machine's owner — so run
 * `pnpm build` + `yaac server restart` first.
 *
 * Run: PROJECT=<slug> node test-playwright-scripts/queued-worktrees-ui-test.js
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

/** The origin this install's clients dial: `server.json`'s selected entry,
 *  which must be loopback — the script sends no credential. */
function readServerOrigin() {
  const dataDir = process.env.YAAC_DATA_DIR || path.join(os.homedir(), '.yaac')
  const file = `${dataDir}-client/server.json`
  if (!fs.existsSync(file)) throw new Error(`no ${file} — is the server running?`)
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!cfg.enabled || !cfg.url) throw new Error(`no server selected in ${file} — try: yaac server start`)
  const host = new URL(cfg.url).hostname
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
    throw new Error(`${cfg.url} is not loopback; this script only drives a local server`)
  }
  return cfg.url
}

let failures = 0
function check(name, cond, detail = '') {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const PROJECT = process.env.PROJECT
if (!PROJECT) throw new Error('set PROJECT=<slug> to a project with a running worktree')
const SHOTS = process.env.SCREENSHOT_DIR ?? '/tmp/yaac-shots'
const origin = readServerOrigin()

const listRes = await fetch(`${origin}/api/worktree/list?project=${PROJECT}`)
if (!listRes.ok) throw new Error(`listing worktrees failed: HTTP ${listRes.status}`)
const { worktrees } = await listRes.json()
const parent = process.env.WORKTREE
  ? worktrees.find((w) => w.worktreeId.startsWith(process.env.WORKTREE))
  : worktrees.find((w) => !w.stopping)
if (!parent) throw new Error(`no running worktree in ${PROJECT}`)
const parentName = parent.title || parent.prompt || 'New worktree'
const stamp = Date.now()
const first = `pw first ${stamp}`
const second = `pw second ${stamp}`

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  await page.goto(`${origin}/?project=${PROJECT}`)
  fs.mkdirSync(SHOTS, { recursive: true })

  const aside = page.locator('aside')
  const rowOf = (text) => aside.locator('div.group.relative', { hasText: text }).last()
  const pick = async (row, menu, item) => {
    await row.hover()
    await row.getByRole('button', { name: menu }).click()
    await page.getByRole('menuitem', { name: item }).click()
  }
  // A locator wait, not waitForFunction: the page's CSP refuses the
  // in-page polling eval that waitForFunction falls back to.
  const submitWhenReady = async (label) => {
    const button = page.locator('button:not([disabled])', { hasText: new RegExp(`^${label}$`) })
    await button.waitFor({ timeout: 15_000 })
    return button
  }

  const parentRow = rowOf(parentName.slice(0, 30))
  await parentRow.waitFor({ state: 'visible', timeout: 15_000 })

  // (1) One menu, four actions.
  await parentRow.hover()
  await parentRow.getByRole('button', { name: 'Worktree actions' }).click()
  // The menu renders a frame after the click; read it once it has.
  await page.getByRole('menuitem').first().waitFor({ state: 'visible' })
  const items = await page.getByRole('menuitem').allTextContents()
  check('the row menu offers rename, group, queue, stop',
    JSON.stringify(items) === JSON.stringify(['Rename', 'Move to group…', 'Queue worktree after this…', 'Stop…']),
    JSON.stringify(items))
  await page.keyboard.press('Escape')

  // (2) Queue after the worktree.
  await pick(parentRow, 'Worktree actions', 'Queue worktree after this…')
  const prompt = page.getByLabel('Prompt')
  await prompt.waitFor({ state: 'visible' })
  check('Start is the worktree', await page.getByLabel('Start').inputValue() === parent.worktreeId)
  check('the prompt has focus', await prompt.evaluate((el) => el === document.activeElement))
  check('the branch is marked latest from origin', await page.getByText('latest from origin when it starts').isVisible())
  await page.keyboard.type(first)
  await submitWhenReady('Queue')
  await page.screenshot({ path: path.join(SHOTS, 'queue-dialog.png') })
  await page.keyboard.press('Enter')
  await prompt.waitFor({ state: 'detached' })
  const firstRow = rowOf(first)
  await firstRow.waitFor({ state: 'visible', timeout: 10_000 })
  check('the entry nests under its worktree, marked queued',
    (await firstRow.textContent())?.includes('· queued') === true, await firstRow.textContent())

  // (3) Chain a second after the first.
  await pick(firstRow, 'Queued worktree actions', 'Queue worktree after this…')
  await prompt.waitFor({ state: 'visible' })
  await page.keyboard.type(second)
  await (await submitWhenReady('Queue')).click()
  const secondRow = rowOf(second)
  await secondRow.waitFor({ state: 'visible', timeout: 10_000 })
  const indent = async (row) => row.evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft))
  const firstIndent = await indent(firstRow)
  check('a chain nests one step deeper', await indent(secondRow) > firstIndent,
    `${firstIndent} → ${await indent(secondRow)}`)
  await page.screenshot({ path: path.join(SHOTS, 'queued-rows.png') })

  // (3b) One expander for the whole set, chain included.
  const expanders = aside.getByRole('button', { name: /^\d+ queued worktrees?$/ })
  check('one expander, counting the chain', JSON.stringify(await expanders.allTextContents()) === '["2 queued worktrees"]',
    JSON.stringify(await expanders.allTextContents()))
  await expanders.first().click()
  const hidden = await aside.getByText(second).waitFor({ state: 'hidden', timeout: 5_000 }).then(() => true, () => false)
  check('collapsing hides the whole set', hidden && !(await aside.getByText(first).isVisible()))
  await page.waitForTimeout(300) // let the chevron finish turning
  await page.screenshot({ path: path.join(SHOTS, 'queued-collapsed.png') })
  await expanders.first().click()
  check('expanding brings it back',
    await secondRow.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true, () => false))
  await page.reload()
  await expanders.first().waitFor({ state: 'visible', timeout: 15_000 })
  check('a reload starts the set collapsed', !(await aside.getByText(first).isVisible()))
  await expanders.first().click()
  await secondRow.waitFor({ state: 'visible', timeout: 5_000 })

  // (4) Edit on click.
  await firstRow.getByText(first).click()
  await page.getByRole('button', { name: 'Save' }).waitFor({ state: 'visible' })
  await prompt.fill(`${first} edited`)
  await (await submitWhenReady('Save')).click()
  await prompt.waitFor({ state: 'detached' })
  const edited = await aside.getByText(`${first} edited`).waitFor({ timeout: 10_000 }).then(() => true, () => false)
  check('Save updates the queued row', edited)

  // (5) The stop dialog lists them; Edit stacks over it; cancel.
  await pick(parentRow, 'Worktree actions', 'Stop…')
  const stopButton = page.getByRole('button', { name: 'Stop and start 1 queued' })
  check('the stop dialog counts its direct children',
    await stopButton.waitFor({ timeout: 5_000 }).then(() => true, () => false))
  check('the stop button keeps focus', await stopButton.evaluate((el) => el === document.activeElement))
  check('a chained entry is marked as waiting', await page.getByText(/waits for its parent/).isVisible())
  await page.screenshot({ path: path.join(SHOTS, 'stop-dialog.png') })
  await page.getByRole('alertdialog').getByRole('button', { name: 'Edit' }).first().click()
  await prompt.waitFor({ state: 'visible' })
  await prompt.click()
  await page.keyboard.type(' x')
  check('the stacked create dialog takes typing', (await prompt.inputValue()).endsWith(' x'))
  await page.keyboard.press('Escape')
  await prompt.waitFor({ state: 'detached' })
  check('Esc closes only the create dialog', await stopButton.isVisible())
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click()
  await stopButton.waitFor({ state: 'detached' })

  // (6) Discard, with the splice explained.
  await pick(rowOf(`${first} edited`), 'Queued worktree actions', 'Discard…')
  const confirm = page.getByRole('alertdialog')
  const text = await confirm.textContent()
  check('the discard says where its child goes', text?.includes('will start when') === true, text ?? '')
  await confirm.getByRole('button', { name: 'Discard' }).click()
  await aside.getByText(`${first} edited`).waitFor({ state: 'detached', timeout: 10_000 })
  await page.waitForTimeout(500)
  check('the child moves up under the worktree', await indent(rowOf(second)) === firstIndent,
    `${await indent(rowOf(second))} vs ${firstIndent}`)
  await pick(rowOf(second), 'Queued worktree actions', 'Discard…')
  await page.getByRole('alertdialog').getByRole('button', { name: 'Discard' }).click()
  const gone = await aside.getByText(second).waitFor({ state: 'detached', timeout: 10_000 })
    .then(() => true, () => false)
  check('nothing is left queued', gone)
} finally {
  await browser.close()
}
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
