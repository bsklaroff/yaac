/*
 * Verifies the git status bar above a workspace's panes in real Chromium:
 *   1. The bar says, in words, where HEAD stands against the reference branch
 *      ("Up to date with origin/main · fetched 5m ago", "3 commits ahead of
 *      origin/main", ...), with a branch icon before the ref, and agrees with
 *      GET /workspace/:id/git-status.
 *   2. The pane area never changes height while the bar loads, so no pane
 *      refits and no SIGWINCH reaches the agent's TUI.
 *   3. The sidebar row has no base-branch label.
 * Leaves a screenshot in SCREENSHOT_DIR.
 *
 * Needs a running `yaac server` with one live workspace. Run `pnpm build &&
 * yaac server restart` first, or you are looking at the frontend `dist/` held
 * when the server started.
 *
 * Run: node test-playwright-scripts/git-status-bar-test.js <workspace-id>
 * (SCREENSHOT_DIR defaults to /tmp/yaac-shots; YAAC_DATA_DIR to ~/.yaac.
 * playwright is resolved from the global npm root; browsers live under
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

const workspaceId = process.argv[2]
if (!workspaceId) {
  console.error('usage: node test-playwright-scripts/git-status-bar-test.js <workspace-id>')
  process.exit(1)
}

const failures = []
function check(ok, label, detail = '') {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

/** The sentence the bar starts with; the fetch age follows. */
function expectedLine({ base, comparison: c }) {
  const n = (k) => `${k} commit${k === 1 ? '' : 's'}`
  if (!c) return `No branch named ${base} to compare with`
  if (c.ahead === 0 && c.behind === 0) return `Up to date with ${c.ref}`
  if (c.behind === 0) return `${n(c.ahead)} ahead of ${c.ref}`
  if (c.ahead === 0) return `${n(c.behind)} behind ${c.ref}`
  return `${n(c.ahead)} ahead of, ${n(c.behind)} behind ${c.ref}`
}

async function main() {
  const lock = readServerLock()
  const origin = `http://127.0.0.1:${lock.port}`
  const auth = { authorization: `Bearer ${lock.secret}` }
  const { workspaces } = await (await fetch(`${origin}/api/workspace/list`, { headers: auth })).json()
  const wt = workspaces.find((w) => w.workspaceId.startsWith(workspaceId))
  if (!wt) throw new Error(`no running workspace ${workspaceId}`)
  const status = await (await fetch(`${origin}/api/workspace/${wt.workspaceId}/git-status`, { headers: auth })).json()
  console.log('git-status:', JSON.stringify(status))

  const token = await (await fetch(`${origin}/tokens`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'one-time' }),
  })).json().then((b) => b.token).catch(() => undefined)

  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1400, height: 800 } })
  // Record every height the pane area takes once it holds a pane.
  await page.addInitScript(() => {
    window.__wsHeights = []
    const sample = () => {
      const el = document.querySelector('div.relative.isolate.flex-1')
      if (el?.querySelector('section')) {
        const h = el.getBoundingClientRect().height
        if (window.__wsHeights.at(-1) !== h) window.__wsHeights.push(h)
      }
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
  const query = new URLSearchParams({ project: wt.projectSlug, workspace: wt.workspaceId, ...(token ? { token } : {}) })
  await page.goto(`${origin}/?${query}`)
  await page.waitForSelector('[aria-label="Browse files"]', { timeout: 20000 })

  const want = expectedLine(status)
  const bar = page.getByText(want)
  await bar.waitFor({ timeout: 15000 }).catch(() => {})
  // innerText breaks the line at the ref's inline-flex box; it renders as one.
  const text = (await bar.first().innerText().catch(() => '')).replace(/\s+/g, ' ')
  check(text.startsWith(want), `the bar reads "${want}"`, text)
  check(!status.comparison?.fetchedAt || / · fetched \d+[smhd] ago$/.test(text), 'the bar says when the ref was fetched', text)
  check(await bar.first().locator('svg').count() === 1, 'a branch icon sits before the ref')
  await page.waitForTimeout(1000)
  const heights = await page.evaluate(() => window.__wsHeights)
  check(heights.length === 1, 'the pane area keeps one height while the bar loads', JSON.stringify(heights))

  const sidebarBranch = page.locator('span.font-mono.text-\\[11px\\]', { hasText: status.base ?? '\u0000' })
  check(await sidebarBranch.count() === 0, 'the sidebar row has no base-branch label')

  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const shot = path.join(SHOT_DIR, 'git-status-bar.png')
  await page.screenshot({ path: shot })
  console.log(`screenshot: ${shot}`)
  await browser.close()
  if (failures.length) {
    console.error(`${failures.length} check(s) failed`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
