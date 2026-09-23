/*
 * Verifies the file explorer and editor panes end-to-end in real Chromium
 * (docs/file-editor.md):
 *   1. Alt+E opens the explorer with its filter focused; typing part of a
 *      name and pressing Enter opens that file (quick-open). A second file
 *      opens from the tree.
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
 *
 * Needs a running containerless `yaac server` (this script edits the checkout
 * directly on disk to play the agent) with one live worktree whose project
 * has a tracked README — e.g. `yaac project add
 * https://github.com/octocat/Hello-World.git` then `yaac worktree create
 * hello-world`. Run `pnpm build && yaac server restart` first, or you are
 * looking at the frontend `dist/` held when the server started. It writes
 * pw-a.ts, pw-b.ts, .gitignore and node_modules/pkg into the checkout.
 *
 * Run: node test-playwright-scripts/file-editor.js <worktree-id>
 * (set SCREENSHOT_DIR to change where the final screenshot lands; defaults to
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
  console.error('usage: node test-playwright-scripts/file-editor.js <worktree-id>')
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
  const lock = readServerLock()
  const origin = `http://127.0.0.1:${lock.port}`
  const auth = { authorization: `Bearer ${lock.secret}` }
  const { worktrees } = await (await fetch(`${origin}/worktree/list`, { headers: auth })).json()
  const wt = worktrees.find((w) => w.worktreeId.startsWith(worktreeId))
  if (!wt) throw new Error(`no running worktree ${worktreeId}`)
  const checkout = path.join(DATA_DIR, 'global', 'projects', wt.projectSlug, 'worktrees', wt.worktreeId)
  const onDisk = (rel) => fs.readFileSync(path.join(checkout, rel), 'utf8')
  fs.writeFileSync(path.join(checkout, 'pw-a.ts'), 'export const a = 1\n')
  fs.writeFileSync(path.join(checkout, 'pw-b.ts'), 'export const b = 2\n')
  fs.writeFileSync(path.join(checkout, '.gitignore'), 'node_modules/\n')
  fs.mkdirSync(path.join(checkout, 'node_modules', 'pkg'), { recursive: true })
  fs.writeFileSync(path.join(checkout, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
  fs.rmSync(path.join(checkout, 'pwdir'), { recursive: true, force: true })

  const token = await (await fetch(`${origin}/tokens`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'one-time' }),
  })).json().then((b) => b.token).catch(() => undefined)

  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
  const puts = []
  page.on('request', (req) => { if (req.method() === 'PUT' && req.url().includes('/file')) puts.push(req.postData()) })
  const query = new URLSearchParams({ project: wt.projectSlug, worktree: wt.worktreeId, ...(token ? { token } : {}) })
  await page.goto(`${origin}/?${query}`)
  await page.waitForSelector('[aria-label="Browse files"]', { timeout: 20000 })
  await page.locator('.xterm').first().click()

  // 1. Quick-open.
  await page.keyboard.press('Alt+KeyE')
  const filter = page.locator('[aria-label="Filter files"]')
  await filter.waitFor()
  check(await filter.evaluate((el) => el === document.activeElement), 'Alt+E focuses the explorer filter')
  await page.keyboard.type('pwa')
  await page.keyboard.press('Enter')
  const editorOf = (rel) => page.locator(`div:has(> div > span[title="${rel}"]) .cm-content`)
  await editorOf('pw-a.ts').waitFor({ timeout: 10000 })
  check(await editorOf('pw-a.ts').innerText().then((t) => t.includes('export const a')), 'Enter opens the top match')
  await filter.fill('')
  await page.locator('button[title="pw-b.ts"]').click()
  await editorOf('pw-b.ts').waitFor({ timeout: 10000 })
  check(true, 'a second file opens from the tree')

  // 2. Autosave, then Ctrl+S.
  await page.getByRole('button', { name: /^pw-a\.ts$/ }).first().click()
  await editorOf('pw-a.ts').click()
  await page.keyboard.press('End')
  await page.keyboard.type(' // edited')
  check(await page.locator('[aria-label="Unsaved changes"]').isVisible(), 'an edit shows the dirty dot')
  const cleared = await eventually(async () => !(await page.locator('[aria-label="Unsaved changes"]').count()), 3000)
  check(cleared, 'the dirty dot clears by itself after ~1 s')
  check(onDisk('pw-a.ts').includes('// edited'), 'the autosaved bytes are on disk')
  await page.keyboard.type(' again')
  await page.keyboard.press('Control+KeyS')
  const fast = await eventually(() => onDisk('pw-a.ts').includes('again'), 500)
  check(fast, 'Ctrl+S saves at once')

  // 3. Ctrl+S in a terminal saves nothing; the shortcuts list.
  const before = puts.length
  await page.locator('.xterm').first().click()
  await page.keyboard.press('Control+KeyS')
  await page.waitForTimeout(1500)
  check(puts.length === before, 'Ctrl+S in a terminal pane saves no file')
  await page.keyboard.press('Control+KeyQ') // XON, in case the shell took the XOFF
  await page.locator('[title="Settings"]').first().click()
  await page.getByText('Shortcuts', { exact: true }).first().click()
  const settings = await page.locator('[role="dialog"]').innerText()
  check(settings.includes('Open file tree'), 'Settings → Shortcuts lists "Open file tree"')
  check(!/save/i.test(settings), 'Settings → Shortcuts has no save entry')
  await page.keyboard.press('Escape')

  // 4. Changes on disk: a clean buffer reloads, a dirty one gets the banner.
  await page.getByRole('button', { name: /^pw-b\.ts$/ }).first().click()
  fs.appendFileSync(path.join(checkout, 'pw-b.ts'), 'export const fromShell = 3\n')
  const reloaded = await eventually(() => editorOf('pw-b.ts').innerText().then((t) => t.includes('fromShell')), 5000)
  check(reloaded, 'a clean buffer reloads in place')
  await page.getByRole('button', { name: /^pw-a\.ts$/ }).first().click()
  await editorOf('pw-a.ts').click()
  await page.keyboard.type(' dirty')
  fs.writeFileSync(path.join(checkout, 'pw-a.ts'), 'export const a = 99\n')
  const banner = await eventually(() => page.getByRole('alert').filter({ hasText: 'Changed on disk' }).count(), 5000)
  check(banner > 0, 'a dirty buffer gets the conflict banner')
  await page.getByRole('button', { name: 'Reload' }).click()

  // 5. Ignored files.
  await page.getByRole('button', { name: /^Files$/ }).first().click()
  await page.locator('[aria-label="Show ignored files"]').click()
  await page.locator('button[title="node_modules"]').click()
  await page.locator('button[title="node_modules/pkg"]').click()
  await page.locator('button[title="node_modules/pkg/index.js"]').click()
  await editorOf('node_modules/pkg/index.js').waitFor({ timeout: 10000 })
  check(true, 'a file inside an ignored folder opens')

  // 7 (first half). Colors: untracked green.
  await page.getByRole('button', { name: /^Files$/ }).first().click()
  const tint = (rel) => page.locator(`button[title="${rel}"] span.truncate`).getAttribute('class')
  check((await tint('pw-b.ts'))?.includes('3fb950'), 'an untracked file is green')

  // 6. Create, rename, delete. The header's New file creates in the selected
  // folder, so select a root-level row first.
  await page.locator('button[title="pw-b.ts"]').click()
  await page.getByRole('button', { name: /^Files$/ }).first().click()
  await page.locator('[aria-label="New file"]').click()
  await page.locator('[aria-label="Name"]').fill('pwdir/b/new.ts')
  await page.keyboard.press('Enter')
  await editorOf('pwdir/b/new.ts').waitFor({ timeout: 10000 })
  check(fs.existsSync(path.join(checkout, 'pwdir/b/new.ts')), 'New file creates it with its folders and opens it')
  await page.getByRole('button', { name: /^Files$/ }).first().click()
  await page.locator('button[title="pwdir/b/new.ts"]').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  await page.locator('[aria-label="Name"]').fill('renamed.ts')
  await page.keyboard.press('Enter')
  const followed = await eventually(() => page.getByRole('button', { name: /^renamed\.ts$/ }).count(), 5000)
  check(followed > 0, 'the open pane follows a rename')
  await page.getByRole('button', { name: /^Files$/ }).first().click()
  await page.locator('button[title="pwdir"]').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  const dialog = await page.locator('[role="alertdialog"]').innerText()
  check(/pwdir.*1 file/.test(dialog), 'the delete confirm counts the folder’s files', dialog)
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  const gone = await eventually(async () => !fs.existsSync(path.join(checkout, 'pwdir'))
    && !(await page.getByRole('button', { name: /^renamed\.ts$/ }).count()), 5000)
  check(gone, 'deleting the folder removes it and closes its pane')

  // 7 (second half). Colors: an edited tracked file is yellow.
  fs.appendFileSync(path.join(checkout, 'README'), '\nedited\n')
  const yellow = await eventually(async () => (await tint('README'))?.includes('d29922'), 8000)
  check(yellow, 'an edited tracked file is yellow')

  fs.mkdirSync(SHOT_DIR, { recursive: true })
  await page.screenshot({ path: path.join(SHOT_DIR, 'file-editor.png') })
  await browser.close()
  if (failures.length) {
    console.log(`\n${failures.length} check(s) failed`)
    process.exit(1)
  }
  console.log('\nall checks passed')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
