/*
 * Verifies the file explorer header's styled tooltips in real Chromium
 * (docs/file-editor.md): hovering the show/hide ignored toggle, New file,
 * New folder and Collapse all each pops a tooltip naming it, and none of
 * them also carries a native `title` that would double up. The go-to-file
 * field has neither: its placeholder already says what it is, shortcut
 * included. SCREENSHOT_DIR
 * gets explorer-tooltip.png.
 *
 * Needs a running containerless `yaac server` with one live worktree. Run
 * `pnpm build && yaac server restart` first, or you are looking at the
 * frontend `dist/` held when the server started.
 *
 * Run: node test-playwright-scripts/file-explorer-tooltips.js <worktree-id>
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
  console.error('usage: node test-playwright-scripts/file-explorer-tooltips.js <worktree-id>')
  process.exit(1)
}

const failures = []
function check(ok, label, detail = '') {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const lock = readServerLock()
  const origin = `http://127.0.0.1:${lock.port}`
  const auth = { authorization: `Bearer ${lock.secret}` }
  const { worktrees } = await (await fetch(`${origin}/worktree/list`, { headers: auth })).json()
  const wt = worktrees.find((w) => w.worktreeId.startsWith(worktreeId))
  if (!wt) throw new Error(`no running worktree ${worktreeId}`)
  const token = (await (await fetch(`${origin}/tokens`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'one-time' }),
  })).json().catch(() => ({}))).token

  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1400, height: 800 } })
  const query = new URLSearchParams({ project: wt.projectSlug, worktree: wt.worktreeId, ...(token ? { token } : {}) })
  await page.goto(`${origin}/?${query}`)
  await page.waitForSelector('[aria-label="Browse files"]', { timeout: 20000 })
  await page.locator('[aria-label="Browse files"]').click()
  await page.locator('[aria-label="Filter files"]').waitFor()

  const controls = [
    [page.getByRole('button', { name: /ignored files$/ }), /^(Show|Hide) ignored files$/],
    [page.getByRole('button', { name: 'New file', exact: true }), /^New file$/],
    [page.getByRole('button', { name: 'New folder', exact: true }), /^New folder$/],
    [page.getByRole('button', { name: 'Collapse all folders' }), /^Collapse all folders$/],
  ]
  for (const [control, want] of controls) {
    await control.hover()
    const popup = page.locator('[role="tooltip"], [data-side]').filter({ hasText: want })
    const shown = await popup.first().waitFor({ timeout: 2000 }).then(() => true, () => false)
    const text = shown ? (await popup.first().innerText()).replace(/\s+/g, ' ') : ''
    check(shown, `hovering shows "${text || want}"`)
    check(await control.getAttribute('title') === null, `${want} has no native title too`)
    if (want.source.includes('New folder')) await page.screenshot({ path: path.join(SHOT_DIR, 'explorer-tooltip.png') })
    await page.mouse.move(0, 0)
    await page.waitForTimeout(200)
  }

  const field = page.locator('label:has([aria-label="Filter files"])')
  await field.hover()
  await page.waitForTimeout(800)
  check(await page.locator('[data-side]').filter({ hasText: 'Go to file' }).count() === 0,
    'hovering the go-to-file field shows no tooltip')
  check(await field.getAttribute('title') === null && await field.locator('input').getAttribute('title') === null,
    'the go-to-file field has no native title')
  const placeholder = await field.locator('input').getAttribute('placeholder')
  check(/^Go to file… \(\S+\)$/.test(placeholder), 'the placeholder carries the shortcut', placeholder)

  await browser.close()
  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed`)
    process.exit(1)
  }
  console.log('\nall checks passed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
