/*
 * Verifies the Changes pane in real Chromium:
 *   1. Alt+G opens it and Cmd/Ctrl+F then focuses its find input, also from
 *      a terminal with the pane already open.
 *   2. A query filters the file list (header "n of m files", one row per
 *      match); a query matching nothing shows "No files match"; Escape
 *      clears it and restores the full count.
 *   3. Syntax-highlight tokens in the diff resolve to the dark and light
 *      palettes (jsdom cannot resolve the CSS custom properties).
 * SCREENSHOT_DIR gets changes-dark.png and changes-light.png.
 *
 * Needs a running `yaac server` with one live workspace (see lib.js). It
 * writes pw-colors.ts and pw-other.txt into the checkout and removes them.
 *
 * Run: YAAC_DATA_DIR=... node test-playwright-scripts/changes-pane-test.js <workspace-id>
 */
import fs from 'node:fs'
import path from 'node:path'
import { requirePlaywright, origin, api, check, finish, SHOTS, DATA_DIR } from './lib.js'

const { chromium } = requirePlaywright()
const { workspaces } = await api('/workspace/list')
const wt = workspaces.find((w) => w.workspaceId.startsWith(process.argv[2] ?? '\0'))
if (!wt) {
  console.error('usage: node test-playwright-scripts/changes-pane-test.js <live-workspace-id>')
  process.exit(1)
}
const checkout = path.join(DATA_DIR, 'global', 'projects', wt.projectSlug, 'workspaces', wt.workspaceId)
const scratch = ['pw-colors.ts', 'pw-other.txt'].map((f) => path.join(checkout, f))
fs.writeFileSync(scratch[0], 'const answer = 42 // meaning\nexport const s = "hello world"\n')
fs.writeFileSync(scratch[1], 'plain text\n')

const FIND = '[aria-label="Find in changes"]'
const focused = () => page.evaluate((sel) => document.activeElement === document.querySelector(sel), FIND)
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
await page.goto(`${origin}/?${new URLSearchParams({ project: wt.projectSlug, workspace: wt.workspaceId })}`)
await page.locator('.xterm').first().waitFor({ timeout: 20_000 })

// 1. Lowercase 'g': a capital adds shiftKey, which the chord rejects.
await page.keyboard.press('Alt+g')
const find = page.locator(FIND)
await find.waitFor({ timeout: 10_000 })
await page.keyboard.press('ControlOrMeta+f')
check('Alt+G, then Cmd/Ctrl+F focuses the find input', await focused())

// 2. Filtering.
const pane = page.locator('div', { has: find }).filter({ has: page.locator('.overflow-y-auto') }).last()
const total = page.getByText(/^\d+ files?$/).first()
await pane.locator('button[title="pw-other.txt"]').waitFor({ timeout: 15_000 })
const full = await total.textContent()
await page.keyboard.type('pw-colors')
const filtered = await page.getByText(/^\d+ of \d+ files$/).first().textContent().catch(() => null)
const rows = await pane.locator('.overflow-y-auto button[aria-expanded]').count()
check('a query shows "n of m files" with one row per match',
  filtered !== null && Number(filtered.split(' ')[0]) === rows && rows > 0, `${filtered}, ${rows} rows`)
await find.fill('zz-no-such-change')
check('a query matching nothing says so', await page.getByText('No files match “zz-no-such-change”').isVisible())
await page.keyboard.press('Escape')
check('Escape clears the query', await find.inputValue() === '')
check('the full count returns', await total.textContent() === full, full)

// 3. Token colors, following the system theme.
await find.fill('pw-colors')
const row = pane.locator('button[title="pw-colors.ts"]')
if (await row.getAttribute('aria-expanded') !== 'true') await row.click()
await pane.locator('.diff-hl .tok-keyword').first().waitFor()
const EXPECT = {
  dark: { keyword: 'rgb(255, 123, 114)', string: 'rgb(165, 214, 255)', comment: 'rgb(139, 148, 158)', number: 'rgb(121, 192, 255)' },
  light: { keyword: 'rgb(207, 34, 46)', string: 'rgb(10, 48, 105)', comment: 'rgb(110, 119, 129)', number: 'rgb(5, 80, 174)' },
}
for (const [scheme, want] of Object.entries(EXPECT)) {
  await page.emulateMedia({ colorScheme: scheme })
  for (const [tok, color] of Object.entries(want)) {
    const got = await pane.locator(`.diff-hl .tok-${tok}`).first().evaluate((el) => getComputedStyle(el).color)
    check(`${scheme}: tok-${tok} is ${color}`, got === color, got)
  }
  await page.screenshot({ path: path.join(SHOTS, `changes-${scheme}.png`) })
}

// 1 again, from a terminal with the pane open.
await page.locator('.xterm-helper-textarea').first().focus()
await page.keyboard.press('Alt+g')
await page.keyboard.press('ControlOrMeta+f')
check('from a terminal, Alt+G then Cmd/Ctrl+F refocuses the find input', await focused())

await browser.close()
for (const f of scratch) fs.rmSync(f, { force: true })
finish()
