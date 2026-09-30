/*
 * Verifies the file explorer and editor panes end-to-end in real Chromium
 * (docs/file-editor.md):
 *   1. Alt+E opens the explorer with its filter focused; typing part of a
 *      name and pressing Enter opens that file (quick-open). A second file
 *      opens from the tree. The explorer header's buttons show styled
 *      tooltips and no native title; the go-to-file field shows neither,
 *      and its placeholder carries the shortcut.
 *   2. An edit shows the dirty dot, which clears by itself ~1 s later, and
 *      the bytes are on disk. A second edit saved with Ctrl+S lands at once.
 *   3. Ctrl+S in a terminal pane saves nothing (it is the shell's key there),
 *      and Settings → Shortcuts lists "Open file tree" but no save entry.
 *   4. A clean buffer reloads in place when the file changes on disk; a dirty
 *      one gets the "Changed on disk" banner instead.
 *   5. "Show ignored" reveals node_modules/, which expands, and a file in it
 *      opens.
 *   6. New file `pwdir/b/new.ts` from the header opens in a pane; a rename
 *      from the context menu takes the open pane with it; deleting its folder
 *      from the context menu (confirmed) closes it.
 *   7. Tree colors: green for untracked, yellow for an edited tracked file.
 * SCREENSHOT_DIR gets explorer-tooltip.png and file-editor.png.
 *
 * Needs a running containerless `yaac server` (this script edits the checkout
 * directly on disk to play the agent) with one live workspace of the yaac
 * project (see lib.js). It writes pw-a.ts, pw-b.ts, a node_modules/pw-pkg and a
 * README.md edit into the checkout, and reverts them at the end.
 *
 * Run: YAAC_DATA_DIR=... node test-playwright-scripts/file-editor.js <workspace-id>
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
  console.error('usage: node test-playwright-scripts/file-editor.js <live-workspace-id>')
  process.exit(1)
}
const checkout = path.join(DATA_DIR, 'global', 'projects', wt.projectSlug, 'workspaces', wt.workspaceId)
const onDisk = (rel) => fs.readFileSync(path.join(checkout, rel), 'utf8')
fs.writeFileSync(path.join(checkout, 'pw-a.ts'), 'export const a = 1\n')
fs.writeFileSync(path.join(checkout, 'pw-b.ts'), 'export const b = 2\n')
fs.mkdirSync(path.join(checkout, 'node_modules', 'pw-pkg'), { recursive: true })
fs.writeFileSync(path.join(checkout, 'node_modules', 'pw-pkg', 'index.js'), 'module.exports = 1\n')
fs.rmSync(path.join(checkout, 'pwdir'), { recursive: true, force: true })
const readme = onDisk('README.md')

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
const puts = []
page.on('request', (req) => { if (req.method() === 'PUT' && req.url().includes('/file')) puts.push(req.postData()) })
const query = new URLSearchParams({ project: wt.projectSlug, workspace: wt.workspaceId })
await page.goto(`${origin}/?${query}`)
await page.waitForSelector('[aria-label="Browse files"]', { timeout: 20000 })
await page.locator('.xterm').first().click()

// 1. Quick-open.
await page.keyboard.press('Alt+KeyE')
const filter = page.locator('[aria-label="Filter files"]')
await filter.waitFor()
check('Alt+E focuses the explorer filter', await filter.evaluate((el) => el === document.activeElement))

// 1b. Header controls show a styled tooltip and no native title; the
// go-to-file field has neither, since its placeholder names it.
for (const name of ['Show ignored files', 'New file', 'New folder', 'Collapse all folders']) {
  const control = page.getByRole('button', { name, exact: true })
  await control.hover()
  const tip = page.locator('[role="tooltip"], [data-side]').filter({ hasText: name })
  check(`hovering "${name}" shows its tooltip`, await tip.first().waitFor({ timeout: 2000 }).then(() => true, () => false))
  check(`"${name}" has no native title`, await control.getAttribute('title') === null)
  if (name === 'New folder') await page.screenshot({ path: path.join(SHOTS, 'explorer-tooltip.png') })
  await page.mouse.move(0, 0)
}
const field = page.locator('label:has([aria-label="Filter files"])')
await field.hover()
await page.waitForTimeout(800)
check('hovering the go-to-file field shows no tooltip',
  await page.locator('[data-side]').filter({ hasText: 'Go to file' }).count() === 0)
check('the go-to-file field has no native title',
  await field.getAttribute('title') === null && await filter.getAttribute('title') === null)
const placeholder = await filter.getAttribute('placeholder')
check('the placeholder carries the shortcut', /^Go to file… \(\S+\)$/.test(placeholder), placeholder)
await filter.focus()

await page.keyboard.type('pwa')
await page.keyboard.press('Enter')
const editorOf = (rel) => page.locator(`div:has(> div > span[title="${rel}"]) .cm-content`)
await editorOf('pw-a.ts').waitFor({ timeout: 10000 })
check('Enter opens the top match', await editorOf('pw-a.ts').innerText().then((t) => t.includes('export const a')))
await filter.fill('')
await page.locator('button[title="pw-b.ts"]').click()
await editorOf('pw-b.ts').waitFor({ timeout: 10000 })
check('a second file opens from the tree', true)

// 2. Autosave, then Ctrl+S.
await page.getByRole('button', { name: /^pw-a\.ts$/ }).first().click()
await editorOf('pw-a.ts').click()
await page.keyboard.press('End')
await page.keyboard.type(' // edited')
check('an edit shows the dirty dot', await page.locator('[aria-label="Unsaved changes"]').isVisible())
const cleared = await eventually(async () => !(await page.locator('[aria-label="Unsaved changes"]').count()), 3000)
check('the dirty dot clears by itself after ~1 s', cleared)
check('the autosaved bytes are on disk', onDisk('pw-a.ts').includes('// edited'))
await page.keyboard.type(' again')
await page.keyboard.press('Control+KeyS')
const fast = await eventually(() => onDisk('pw-a.ts').includes('again'), 500)
check('Ctrl+S saves at once', fast)

// 3. Ctrl+S in a terminal saves nothing; the shortcuts list.
const before = puts.length
await page.locator('.xterm').first().click()
await page.keyboard.press('Control+KeyS')
await page.waitForTimeout(1500)
check('Ctrl+S in a terminal pane saves no file', puts.length === before)
await page.keyboard.press('Control+KeyQ') // XON, in case the shell took the XOFF
await page.locator('[title="Settings"]').first().click()
await page.getByText('Shortcuts', { exact: true }).first().click()
const settings = await page.locator('[role="dialog"]').innerText()
check('Settings → Shortcuts lists "Open file tree"', settings.includes('Open file tree'))
check('Settings → Shortcuts has no save entry', !/save/i.test(settings))
await page.keyboard.press('Escape')

// 4. Changes on disk: a clean buffer reloads, a dirty one gets the banner.
await page.getByRole('button', { name: /^pw-b\.ts$/ }).first().click()
fs.appendFileSync(path.join(checkout, 'pw-b.ts'), 'export const fromShell = 3\n')
const reloaded = await eventually(() => editorOf('pw-b.ts').innerText().then((t) => t.includes('fromShell')), 5000)
check('a clean buffer reloads in place', reloaded)
await page.getByRole('button', { name: /^pw-a\.ts$/ }).first().click()
await editorOf('pw-a.ts').click()
await page.keyboard.type(' dirty')
fs.writeFileSync(path.join(checkout, 'pw-a.ts'), 'export const a = 99\n')
const banner = await eventually(() => page.getByRole('alert').filter({ hasText: 'Changed on disk' }).count(), 5000)
check('a dirty buffer gets the conflict banner', banner > 0)
await page.getByRole('button', { name: 'Reload' }).click()

// 5. Ignored files.
await page.getByRole('button', { name: /^Files$/ }).first().click()
await page.locator('[aria-label="Show ignored files"]').click()
await page.locator('button[title="node_modules"]').click()
await page.locator('button[title="node_modules/pw-pkg"]').click()
await page.locator('button[title="node_modules/pw-pkg/index.js"]').click()
await editorOf('node_modules/pw-pkg/index.js').waitFor({ timeout: 10000 })
check('a file inside an ignored folder opens', true)

// 7 (first half). Colors: untracked green.
await page.getByRole('button', { name: /^Files$/ }).first().click()
const tint = (rel) => page.locator(`button[title="${rel}"] span.truncate`).getAttribute('class')
check('an untracked file is green', (await tint('pw-b.ts'))?.includes('3fb950'))

// 6. Create, rename, delete. New file uses the selected folder, so select
// a root-level row first.
await page.locator('button[title="pw-b.ts"]').click()
await page.getByRole('button', { name: /^Files$/ }).first().click()
await page.locator('[aria-label="New file"]').click()
await page.locator('[aria-label="Name"]').fill('pwdir/b/new.ts')
await page.keyboard.press('Enter')
await editorOf('pwdir/b/new.ts').waitFor({ timeout: 10000 })
check('New file creates it with its folders and opens it', fs.existsSync(path.join(checkout, 'pwdir/b/new.ts')))
await page.getByRole('button', { name: /^Files$/ }).first().click()
await page.locator('button[title="pwdir/b/new.ts"]').click({ button: 'right' })
await page.getByRole('menuitem', { name: 'Rename' }).click()
await page.locator('[aria-label="Name"]').fill('renamed.ts')
await page.keyboard.press('Enter')
const followed = await eventually(() => page.getByRole('button', { name: /^renamed\.ts$/ }).count(), 5000)
check('the open pane follows a rename', followed > 0)
await page.getByRole('button', { name: /^Files$/ }).first().click()
await page.locator('button[title="pwdir"]').click({ button: 'right' })
await page.getByRole('menuitem', { name: 'Delete' }).click()
const dialog = await page.locator('[role="alertdialog"]').innerText()
check('the delete confirm counts the folder’s files', /pwdir.*1 file/.test(dialog), dialog)
await page.getByRole('button', { name: 'Delete', exact: true }).click()
const gone = await eventually(async () => !fs.existsSync(path.join(checkout, 'pwdir'))
  && !(await page.getByRole('button', { name: /^renamed\.ts$/ }).count()), 5000)
check('deleting the folder removes it and closes its pane', gone)

// 7 (second half). Colors: an edited tracked file is yellow.
fs.appendFileSync(path.join(checkout, 'README.md'), '\nedited\n')
const yellow = await eventually(async () => (await tint('README.md'))?.includes('d29922'), 8000)
check('an edited tracked file is yellow', yellow)

await page.screenshot({ path: path.join(SHOTS, 'file-editor.png') })
await browser.close()
fs.writeFileSync(path.join(checkout, 'README.md'), readme)
for (const rel of ['pw-a.ts', 'pw-b.ts', 'node_modules/pw-pkg']) fs.rmSync(path.join(checkout, rel), { recursive: true, force: true })
finish()
