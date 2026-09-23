/*
 * Verifies the file pane's text size, wrapping, Save button and find bar in
 * real Chromium (docs/file-editor.md):
 *   1. A file opens at the default 12px text, with no horizontal scroll: a
 *      long line wraps.
 *   2. The clean pane shows no Save button; an edit shows it, and it goes
 *      again once the autosave lands.
 *   3. The header's "Aa" menu steps the size and resets it, and the size
 *      survives a reload (localStorage); Ctrl+= / Ctrl+- / Ctrl+0 in the
 *      editor do the same. (That they stop the browser's own zoom is
 *      covered by worktree-file.test.tsx: headless Chromium has none.)
 *   4. Ctrl+F opens the app's find bar with its input focused; typing jumps
 *      to the first match and shows "1 of N"; Enter steps to "2 of N";
 *      the regex toggle flips; a miss reads "No results"; a regex that
 *      backtracks forever reads "Too slow to count" while the page keeps
 *      answering (the count runs in a Worker); hovering a toggle
 *      shows a tooltip explaining it; the replace field lines up under the
 *      find field, with the buttons right against them; Escape closes it
 *      and hands focus back to the editor. The header's search button opens
 *      it too.
 *   5. The explorer's quick-open: ArrowDown moves the highlighted result
 *      and Enter opens that one.
 *   6. For a look: SCREENSHOT_DIR gets explorer.png, find.png and
 *      replace.png.
 *   7. In a wide editor (Settings → Project Config, expanded) the bar sits
 *      at the left, and Escape closes it without closing the dialog.
 *
 * Needs a running containerless `yaac server` with one live worktree whose
 * checkout has a README.md (any worktree of the yaac project will do). Run
 * `pnpm build && yaac server restart` first, or you are looking at the
 * frontend `dist/` held when the server started. It writes pw-long.md into
 * the checkout and edits it.
 *
 * Run: node test-playwright-scripts/file-pane-find.js <worktree-id>
 * (set SCREENSHOT_DIR to change where screenshots land; defaults to
 * /tmp/yaac-shots. YAAC_DATA_DIR defaults to ~/.yaac.)
 * (playwright is resolved from the global npm root; browsers live under
 * /opt/playwright-browsers)
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync('/opt/playwright-browsers')) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/playwright-browsers'
}
const { chromium } = (() => {
  try {
    return require('playwright')
  } catch {
    return require(path.join(execSync('npm root -g').toString().trim(), 'playwright'))
  }
})()

const SHOT_DIR = process.env.SCREENSHOT_DIR ?? '/tmp/yaac-shots'
const DATA_DIR = process.env.YAAC_DATA_DIR ?? path.join(os.homedir(), '.yaac')

function readServerLock() {
  for (const p of [path.join(DATA_DIR, 'server-local', '.server.lock'), path.join(DATA_DIR, '.server.lock')]) {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'))
  }
  throw new Error('no .server.lock found — is the server running? try: yaac server start')
}

const worktreeId = process.argv[2]
if (!worktreeId) {
  console.error('usage: node test-playwright-scripts/file-pane-find.js <worktree-id>')
  process.exit(1)
}

const failures = []
function check(ok, label, detail = '') {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

async function eventually(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value || Date.now() > deadline) return value
    await new Promise((r) => setTimeout(r, 100))
  }
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const lock = readServerLock()
  const origin = `http://127.0.0.1:${lock.port}`
  const auth = { authorization: `Bearer ${lock.secret}` }
  const { worktrees } = await (await fetch(`${origin}/worktree/list`, { headers: auth })).json()
  const wt = worktrees.find((w) => w.worktreeId.startsWith(worktreeId))
  if (!wt) throw new Error(`no running worktree ${worktreeId}`)
  const checkout = path.join(DATA_DIR, 'global', 'projects', wt.projectSlug, 'worktrees', wt.worktreeId)
  const long = `${'word '.repeat(80)}needle\nshort needle line\nthird needle\n${'a'.repeat(5000)}\n`
  fs.writeFileSync(path.join(checkout, 'pw-long.md'), long)

  const mint = async () => (await (await fetch(`${origin}/tokens`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'one-time' }),
  })).json().catch(() => ({}))).token

  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1400, height: 800 } })
  const load = async () => {
    const token = await mint()
    const query = new URLSearchParams({ project: wt.projectSlug, worktree: wt.worktreeId, ...(token ? { token } : {}) })
    await page.goto(`${origin}/?${query}`)
    await page.waitForSelector('[aria-label="Browse files"]', { timeout: 20000 })
  }
  await load()
  await page.locator('[aria-label="Browse files"]').click()
  const filter = page.locator('[aria-label="Filter files"]')
  await filter.waitFor()
  await page.screenshot({ path: path.join(SHOT_DIR, 'explorer.png') })
  await filter.fill('.md')
  const options = page.getByRole('option')
  await page.keyboard.press('ArrowDown')
  check(await options.nth(1).getAttribute('aria-selected') === 'true', 'ArrowDown highlights the second result')
  const second = await options.nth(1).getAttribute('title')
  await page.keyboard.press('Enter')
  await page.locator(`span[title="${second}"]`).waitFor({ timeout: 10000 })
  check(true, 'Enter opens the highlighted result')
  await filter.fill('pw-long')
  await page.keyboard.press('Enter')
  const pane = page.locator('div:has(> div > span[title="pw-long.md"])')
  const editor = pane.locator('.cm-editor')
  await editor.waitFor({ timeout: 10000 })

  // 1. Size and wrapping.
  const fontPx = () => editor.evaluate((el) => getComputedStyle(el.querySelector('.cm-content')).fontSize)
  check(await fontPx() === '12px', 'opens at 12px', await fontPx())
  const overflow = await editor.evaluate((el) => {
    const s = el.querySelector('.cm-scroller')
    return s.scrollWidth - s.clientWidth
  })
  check(overflow <= 1, 'a long line wraps instead of scrolling sideways', `overflow ${overflow}px`)

  // 2. Save shows only while unsaved.
  const save = pane.getByRole('button', { name: 'Save', exact: true })
  check(await save.count() === 0, 'a clean file shows no Save button')
  await editor.locator('.cm-content').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('edit')
  check(await save.isVisible(), 'an edit shows Save')
  check(await eventually(async () => (await save.count()) === 0, 3000), 'Save goes once the autosave lands')

  // 3. Size controls, persisted.
  const sizeMenu = pane.getByRole('button', { name: 'Text size' })
  await sizeMenu.click()
  await page.getByRole('button', { name: 'Larger text' }).click()
  await page.getByRole('button', { name: 'Larger text' }).click()
  check(await fontPx() === '14px', 'the menu\'s + twice makes 14px', await fontPx())
  await page.screenshot({ path: path.join(SHOT_DIR, 'text-size.png') })
  await load()
  await editor.waitFor({ timeout: 10000 })
  check(await fontPx() === '14px', 'the size survives a reload', await fontPx())
  await sizeMenu.click()
  await page.getByRole('button', { name: 'Reset' }).click()
  check(await fontPx() === '12px', 'Reset goes back to 12px', await fontPx())
  await page.keyboard.press('Escape')
  await editor.locator('.cm-content').click()
  await page.keyboard.press('Control+Minus')
  check(await fontPx() === '11px', 'Ctrl+- makes 11px', await fontPx())
  await page.keyboard.press('Control+Equal')
  await page.keyboard.press('Control+Equal')
  check(await fontPx() === '13px', 'Ctrl+= twice makes 13px', await fontPx())
  await page.keyboard.press('Control+Digit0')
  check(await fontPx() === '12px', 'Ctrl+0 resets', await fontPx())

  // 4. Find.
  await editor.locator('.cm-content').click()
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('Control+KeyF')
  const find = pane.getByRole('textbox', { name: 'Find', exact: true })
  await find.waitFor()
  check(await find.evaluate((el) => el === document.activeElement), 'Ctrl+F focuses the find input')
  await page.keyboard.type('needle')
  const status = pane.getByRole('status')
  check(await eventually(async () => (await status.innerText()) === '1 of 3'), 'typing jumps to "1 of 3"', await status.innerText())
  await page.keyboard.press('Enter')
  check(await eventually(async () => (await status.innerText()) === '2 of 3'), 'Enter steps to "2 of 3"', await status.innerText())
  await page.keyboard.press('Shift+Enter')
  check(await eventually(async () => (await status.innerText()) === '1 of 3'), 'Shift+Enter steps back', await status.innerText())
  await pane.getByRole('button', { name: 'Show replace' }).click()
  await pane.getByRole('textbox', { name: 'Replace' }).fill('pin')
  const box = async (loc) => loc.evaluate((el) => {
    const r = (el.closest('.rounded.border') ?? el).getBoundingClientRect()
    return { left: r.left, right: r.right }
  })
  const findBox = await box(find)
  const replaceBox = await box(pane.getByRole('textbox', { name: 'Replace' }))
  check(Math.abs(findBox.left - replaceBox.left) < 1 && Math.abs(findBox.right - replaceBox.right) < 1,
    'the replace field lines up under the find field', JSON.stringify({ findBox, replaceBox }))
  const prev = await pane.getByRole('button', { name: 'Previous match' }).boundingBox()
  check(prev.x - findBox.right < 8, 'the arrows sit right against the find field', `gap ${prev.x - findBox.right}px`)
  await pane.getByRole('button', { name: 'Match case' }).hover()
  const tip = page.getByText('Only matches with the same capitalization')
  check(await tip.waitFor({ timeout: 3000 }).then(() => true, () => false), 'hovering a toggle explains it')
  await page.screenshot({ path: path.join(SHOT_DIR, 'replace.png') })
  await find.hover()
  await pane.getByRole('button', { name: 'Hide replace' }).click()
  await pane.getByRole('button', { name: 'Regular expression' }).click()
  check(await pane.getByRole('button', { name: 'Regular expression' }).getAttribute('aria-pressed') === 'true', 'the regex toggle flips')
  await find.fill('ne+dle\\d')
  check(await eventually(async () => (await status.innerText()) === 'No results'), 'a miss reads "No results"', await status.innerText())
  await find.fill('ne+dle')
  await page.screenshot({ path: path.join(SHOT_DIR, 'find.png') })
  // A regex that backtracks forever on the long `aaa…` line: the worker is
  // killed, and the page never stops answering.
  await find.fill('(a|aa)+b')
  const start = Date.now()
  const slow = await eventually(async () => (await status.innerText()) === 'Too slow to count', 6000)
  check(slow, 'a runaway regex reads "Too slow to count"', await status.innerText())
  check(Date.now() - start < 6000 && await page.evaluate(() => 1 + 1) === 2, 'the page stays responsive')
  await find.fill('ne+dle')
  await pane.getByRole('button', { name: 'Regular expression' }).click()
  await find.focus()
  await page.keyboard.press('Escape')
  check(await eventually(async () => (await find.count()) === 0), 'Escape closes the find bar')
  check(await editor.evaluate((el) => el.contains(document.activeElement)), 'focus returns to the editor')
  await pane.getByRole('button', { name: /^Find/ }).click()
  check(await eventually(async () => (await find.count()) === 1), 'the header search button opens it')

  // 7. A wide editor — Settings → Project Config, expanded: the bar sits at
  //    the left rather than floating to the middle, and Escape closes the
  //    bar alone, not the dialog around it.
  await page.keyboard.press('Escape')
  await page.locator('[title="Settings"]').first().click()
  await page.locator('button', { hasText: 'Project Config' }).first().click()
  await page.getByRole('button', { name: 'Expand editor' }).first().click()
  const dialog = page.getByRole('dialog').last()
  await dialog.locator('.cm-content').click()
  await page.keyboard.press('Control+KeyF')
  const dialogFind = dialog.getByRole('textbox', { name: 'Find', exact: true })
  await dialogFind.waitFor()
  const editorLeft = (await dialog.locator('.cm-editor').boundingBox()).x
  const findLeft = await dialogFind.evaluate((el) => el.closest('.rounded.border').getBoundingClientRect().left)
  check(findLeft - editorLeft < 48, 'in a wide editor the bar sits at the left', `${findLeft - editorLeft}px in`)
  await page.keyboard.press('Escape')
  check(await eventually(async () => (await dialogFind.count()) === 0), 'Escape closes the bar in a settings dialog')
  check(await dialog.locator('.cm-content').isVisible(), 'and leaves the dialog open')

  await browser.close()
  fs.rmSync(path.join(checkout, 'pw-long.md'), { force: true })
  if (failures.length) {
    console.log(`\n${failures.length} failed`)
    process.exit(1)
  }
  console.log('\nall passed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
