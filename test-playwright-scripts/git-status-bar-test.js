/*
 * Verifies the git status bar above a workspace's panes in real Chromium:
 *   1. The bar says, in words, where HEAD stands against the reference branch
 *      ("Up to date with origin/main · fetched 5m ago", "3 commits ahead of
 *      origin/main", ...), with a branch icon before the ref, and agrees with
 *      GET /api/workspace/:id/git-status.
 *   2. The pane area never changes height while the bar loads, so no pane
 *      refits and no SIGWINCH reaches the agent's TUI.
 * SCREENSHOT_DIR gets git-status-bar.png.
 *
 * Needs a running `yaac server` with one live workspace (see lib.js).
 *
 * Run: YAAC_DATA_DIR=... node test-playwright-scripts/git-status-bar-test.js <workspace-id>
 */
import path from 'node:path'
import { requirePlaywright, origin, api, check, finish, SHOTS } from './lib.js'

const { chromium } = requirePlaywright()
const { workspaces } = await api('/workspace/list')
const wt = workspaces.find((w) => w.workspaceId.startsWith(process.argv[2] ?? '\0'))
if (!wt) {
  console.error('usage: node test-playwright-scripts/git-status-bar-test.js <live-workspace-id>')
  process.exit(1)
}
const status = await api(`/workspace/${wt.workspaceId}/git-status`)
console.log('git-status:', JSON.stringify(status))

/** The sentence the bar starts with; the fetch age follows. */
function expectedLine({ base, comparison: c }) {
  const n = (k) => `${k} commit${k === 1 ? '' : 's'}`
  if (!c) return `No branch named ${base} to compare with`
  if (c.ahead === 0 && c.behind === 0) return `Up to date with ${c.ref}`
  if (c.behind === 0) return `${n(c.ahead)} ahead of ${c.ref}`
  if (c.ahead === 0) return `${n(c.behind)} behind ${c.ref}`
  return `${n(c.ahead)} ahead of, ${n(c.behind)} behind ${c.ref}`
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } })
// Record every height the pane area takes once it holds a pane.
await page.addInitScript(() => {
  window.__heights = []
  const sample = () => {
    const el = document.querySelector('div.relative.isolate.flex-1')
    if (el?.querySelector('.xterm')) {
      const h = el.getBoundingClientRect().height
      if (window.__heights.at(-1) !== h) window.__heights.push(h)
    }
    requestAnimationFrame(sample)
  }
  requestAnimationFrame(sample)
})
await page.goto(`${origin}/?${new URLSearchParams({ project: wt.projectId, workspace: wt.workspaceId })}`)

const want = expectedLine(status)
const bar = page.locator('span.truncate', { hasText: want }).first()
await bar.waitFor({ timeout: 15_000 }).catch(() => {})
// innerText breaks the line at the ref's inline-flex box; it renders as one.
const text = (await bar.innerText().catch(() => '')).replace(/\s+/g, ' ')
check(`the bar reads "${want}"`, text.startsWith(want), text)
check('the bar says when the ref was fetched',
  !status.comparison?.fetchedAt || / · fetched \d+[smhd] ago$/.test(text), text)
check('a branch icon sits before the ref', await bar.locator('svg').count() === 1)
await page.waitForTimeout(1000)
const heights = await page.evaluate(() => window.__heights)
check('the pane area keeps one height while the bar loads', heights.length === 1, JSON.stringify(heights))

await page.screenshot({ path: path.join(SHOTS, 'git-status-bar.png') })
await browser.close()
finish()
