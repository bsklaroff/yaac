/*
 * Verifies that a tiles-mode column's left divider runs the full height of
 * the pane area, not just its tab strip: the pane body of every column but
 * the first starts one pixel right of the column's edge, so the column's
 * `border-l` stays visible beside it.
 *
 * Needs a server with a live workspace; it uses the first one listed, adds
 * two scratch shells to it and closes them at the end. A workspace created
 * with `yaac workspace create <project> --no-agent` costs nothing. The
 * screenshot goes to $SCREENSHOT_DIR/tiles-divider.png.
 *
 * Run: YAAC_DATA_DIR=~/.yaac node test-playwright-scripts/tiles-column-divider.js
 */
import path from 'node:path'
import { requirePlaywright, origin, api, check, finish, SHOTS } from './lib.js'

const ws = (await api('/workspace/list')).workspaces.find((w) => w.status !== 'stopped')
if (!ws) throw new Error('no live workspace — create one with `yaac workspace create <project> --no-agent`')
const shells = [await api(`/workspace/${ws.workspaceId}/terminals`, { method: 'POST' }),
  await api(`/workspace/${ws.workspaceId}/terminals`, { method: 'POST' })]

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await ctx.addInitScript(() => {
    localStorage.setItem('yaac.viewmode.v1', 'tiles')
    localStorage.removeItem('yaac.layouts.v2')
  })
  const page = await ctx.newPage()
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  await page.goto(`${origin}/?project=${ws.projectId}&workspace=${ws.workspaceId}`)
  await page.locator('section[style]').nth(1).waitFor({ state: 'visible', timeout: 15_000 })
  await page.waitForTimeout(2000)
  await page.screenshot({ path: path.join(SHOTS, 'tiles-divider.png') })

  /* For each column, its left edge, its border width, and the left edge of
   * the pane body positioned over it (the visible absolutely-positioned pane
   * whose top sits below that column's header). */
  const cols = await page.evaluate(() => {
    const area = document.querySelector('section[style]').parentElement
    const panes = [...area.children].filter((el) => el.tagName === 'DIV' && el.style.left
      && getComputedStyle(el).visibility !== 'hidden')
    return [...area.querySelectorAll(':scope > section[style]')].map((s) => {
      const r = s.getBoundingClientRect()
      const pane = panes.map((p) => p.getBoundingClientRect())
        .find((p) => p.left >= r.left && p.left < r.left + r.width / 2)
      return { left: r.left, border: parseFloat(getComputedStyle(s).borderLeftWidth), paneLeft: pane?.left }
    })
  })
  check('there are at least two columns', cols.length >= 2, JSON.stringify(cols))
  check('every column after the first draws a left border', cols.slice(1).every((c) => c.border >= 1), JSON.stringify(cols))
  check('no pane body covers its column\'s border',
    cols.every((c) => c.paneLeft !== undefined && c.paneLeft >= c.left + c.border), JSON.stringify(cols))
} finally {
  await browser.close()
  for (const s of shells) {
    await api(`/workspace/${ws.workspaceId}/terminals/close`, { method: 'POST', body: { target: s.target } })
      .catch((e) => console.log(`  (could not close ${s.name}: ${e.message})`))
  }
}
finish()
