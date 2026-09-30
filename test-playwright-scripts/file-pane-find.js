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
 *      covered by workspace-file.test.tsx: headless Chromium has none.)
 *   4. Ctrl+F opens the find bar with its input focused. Typing jumps to the
 *      first match ("1 of N"), Enter steps to "2 of N", the regex toggle
 *      flips, a miss reads "No results", and a catastrophic regex reads "Too
 *      slow to count" while the page stays responsive (counting runs in a
 *      Worker). Toggles have tooltips; the replace field lines up under the
 *      find field; Escape closes the bar and refocuses the editor. The
 *      header's search button also opens it.
 *   5. The explorer's quick-open: ArrowDown moves the highlighted result
 *      and Enter opens that one.
 *   6. For a look: SCREENSHOT_DIR gets explorer.png, find.png and
 *      replace.png.
 *   7. In a wide editor (Settings → Project Config, expanded) the bar sits
 *      at the left, and Escape closes it without closing the dialog.
 *
 * Needs a running containerless `yaac server` (this script writes into the
 * checkout on disk) with one live workspace of the yaac project (see
 * lib.js). It writes pw-long.md into the checkout and removes it.
 *
 * Run: YAAC_DATA_DIR=... node test-playwright-scripts/file-pane-find.js <workspace-id>
 */
import fs from 'node:fs'
import path from 'node:path'
import { requirePlaywright, origin, api, check, finish, SHOTS, DATA_DIR } from './lib.js'

const { chromium } = requirePlaywright()

/** Poll a Node-side predicate; returns its last value. */
async function eventually(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value || Date.now() > deadline) return value
    await new Promise((r) => setTimeout(r, 100))
  }
}

const { workspaces } = await api('/workspace/list')
const wt = workspaces.find((w) => w.workspaceId.startsWith(process.argv[2] ?? '\0'))
if (!wt) {
  console.error('usage: node test-playwright-scripts/file-pane-find.js <live-workspace-id>')
  process.exit(1)
}
const checkout = path.join(DATA_DIR, 'global', 'projects', wt.projectSlug, 'workspaces', wt.workspaceId)
const long = `${'word '.repeat(80)}needle\nshort needle line\nthird needle\n${'a'.repeat(5000)}\n`
fs.writeFileSync(path.join(checkout, 'pw-long.md'), long)

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } })
const load = async () => {
  const query = new URLSearchParams({ project: wt.projectSlug, workspace: wt.workspaceId })
  await page.goto(`${origin}/?${query}`)
  await page.waitForSelector('[aria-label="Browse files"]', { timeout: 20000 })
}
await load()
await page.locator('[aria-label="Browse files"]').click()
const filter = page.locator('[aria-label="Filter files"]')
await filter.waitFor()
await page.screenshot({ path: path.join(SHOTS, 'explorer.png') })
await filter.fill('.md')
const options = page.getByRole('option')
await page.keyboard.press('ArrowDown')
check('ArrowDown highlights the second result', await options.nth(1).getAttribute('aria-selected') === 'true')
const second = await options.nth(1).getAttribute('title')
await page.keyboard.press('Enter')
await page.locator(`span[title="${second}"]`).waitFor({ timeout: 10000 })
check('Enter opens the highlighted result', true)
await filter.fill('pw-long')
await page.keyboard.press('Enter')
const pane = page.locator('div:has(> div > span[title="pw-long.md"])')
const editor = pane.locator('.cm-editor')
await editor.waitFor({ timeout: 10000 })

// 1. Size and wrapping.
const fontPx = () => editor.evaluate((el) => getComputedStyle(el.querySelector('.cm-content')).fontSize)
check('opens at 12px', await fontPx() === '12px', await fontPx())
const overflow = await editor.evaluate((el) => {
  const s = el.querySelector('.cm-scroller')
  return s.scrollWidth - s.clientWidth
})
check('a long line wraps instead of scrolling sideways', overflow <= 1, `overflow ${overflow}px`)

// 2. Save shows only while unsaved.
const save = pane.getByRole('button', { name: 'Save', exact: true })
check('a clean file shows no Save button', await save.count() === 0)
await editor.locator('.cm-content').click()
await page.keyboard.press('Control+End')
await page.keyboard.type('edit')
check('an edit shows Save', await save.isVisible())
check('Save goes once the autosave lands', await eventually(async () => (await save.count()) === 0, 3000))

// 3. Size controls, persisted.
const sizeMenu = pane.getByRole('button', { name: 'Text size' })
await sizeMenu.click()
await page.getByRole('button', { name: 'Larger text' }).click()
await page.getByRole('button', { name: 'Larger text' }).click()
check('the menu\'s + twice makes 14px', await fontPx() === '14px', await fontPx())
await page.screenshot({ path: path.join(SHOTS, 'text-size.png') })
await load()
await editor.waitFor({ timeout: 10000 })
check('the size survives a reload', await fontPx() === '14px', await fontPx())
await sizeMenu.click()
await page.getByRole('button', { name: 'Reset' }).click()
check('Reset goes back to 12px', await fontPx() === '12px', await fontPx())
await page.keyboard.press('Escape')
await editor.locator('.cm-content').click()
await page.keyboard.press('Control+Minus')
check('Ctrl+- makes 11px', await fontPx() === '11px', await fontPx())
await page.keyboard.press('Control+Equal')
await page.keyboard.press('Control+Equal')
check('Ctrl+= twice makes 13px', await fontPx() === '13px', await fontPx())
await page.keyboard.press('Control+Digit0')
check('Ctrl+0 resets', await fontPx() === '12px', await fontPx())

// 4. Find.
await editor.locator('.cm-content').click()
await page.keyboard.press('Control+Home')
await page.keyboard.press('Control+KeyF')
const find = pane.getByRole('textbox', { name: 'Find', exact: true })
await find.waitFor()
check('Ctrl+F focuses the find input', await find.evaluate((el) => el === document.activeElement))
await page.keyboard.type('needle')
const status = pane.getByRole('status')
check('typing jumps to "1 of 3"', await eventually(async () => (await status.innerText()) === '1 of 3'), await status.innerText())
await page.keyboard.press('Enter')
check('Enter steps to "2 of 3"', await eventually(async () => (await status.innerText()) === '2 of 3'), await status.innerText())
await page.keyboard.press('Shift+Enter')
check('Shift+Enter steps back', await eventually(async () => (await status.innerText()) === '1 of 3'), await status.innerText())
await pane.getByRole('button', { name: 'Show replace' }).click()
await pane.getByRole('textbox', { name: 'Replace' }).fill('pin')
const box = async (loc) => loc.evaluate((el) => {
  const r = (el.closest('.rounded.border') ?? el).getBoundingClientRect()
  return { left: r.left, right: r.right }
})
const findBox = await box(find)
const replaceBox = await box(pane.getByRole('textbox', { name: 'Replace' }))
check('the replace field lines up under the find field',
  Math.abs(findBox.left - replaceBox.left) < 1 && Math.abs(findBox.right - replaceBox.right) < 1,
  JSON.stringify({ findBox, replaceBox }))
const prev = await pane.getByRole('button', { name: 'Previous match' }).boundingBox()
check('the arrows sit right against the find field', prev.x - findBox.right < 8, `gap ${prev.x - findBox.right}px`)
await pane.getByRole('button', { name: 'Match case' }).hover()
const tip = page.getByText('Only matches with the same capitalization')
check('hovering a toggle explains it', await tip.waitFor({ timeout: 3000 }).then(() => true, () => false))
await page.screenshot({ path: path.join(SHOTS, 'replace.png') })
await find.hover()
await pane.getByRole('button', { name: 'Hide replace' }).click()
await pane.getByRole('button', { name: 'Regular expression' }).click()
check('the regex toggle flips', await pane.getByRole('button', { name: 'Regular expression' }).getAttribute('aria-pressed') === 'true')
await find.fill('ne+dle\\d')
check('a miss reads "No results"', await eventually(async () => (await status.innerText()) === 'No results'), await status.innerText())
await find.fill('ne+dle')
await page.screenshot({ path: path.join(SHOTS, 'find.png') })
// A regex that backtracks forever on the long `aaa…` line: the worker is
// killed and the page stays responsive.
await find.fill('(a|aa)+b')
const start = Date.now()
const slow = await eventually(async () => (await status.innerText()) === 'Too slow to count', 6000)
check('a runaway regex reads "Too slow to count"', slow, await status.innerText())
check('the page stays responsive', Date.now() - start < 6000 && await page.evaluate(() => 1 + 1) === 2)
await find.fill('ne+dle')
await pane.getByRole('button', { name: 'Regular expression' }).click()
await find.focus()
await page.keyboard.press('Escape')
check('Escape closes the find bar', await eventually(async () => (await find.count()) === 0))
check('focus returns to the editor', await editor.evaluate((el) => el.contains(document.activeElement)))
await pane.getByRole('button', { name: /^Find/ }).click()
check('the header search button opens it', await eventually(async () => (await find.count()) === 1))

// 7. In the expanded Project Config editor the bar sits at the left, and
//    Escape closes only the bar.
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
check('in a wide editor the bar sits at the left', findLeft - editorLeft < 48, `${findLeft - editorLeft}px in`)
await page.keyboard.press('Escape')
check('Escape closes the bar in a settings dialog', await eventually(async () => (await dialogFind.count()) === 0))
check('and leaves the dialog open', await dialog.locator('.cm-content').isVisible())

await browser.close()
fs.rmSync(path.join(checkout, 'pw-long.md'), { force: true })
finish()
