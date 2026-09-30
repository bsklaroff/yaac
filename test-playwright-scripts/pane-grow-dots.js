#!/usr/bin/env node
/*
 * pane-grow-dots.js
 *
 * Verifies that growing a TUI pane never flashes tmux overflow dots on the
 * right-hand side, and that the tmux window always ends at the xterm grid.
 * The view's window follows its client under `window-size latest` (pty-bridge
 * attachArgs), inside tmux's own resize handling; a window resized by a
 * separate exec instead lags the grown client, which tmux draws around the
 * old window with a column of dots on every row until the exec lands.
 *
 * Opens the workspace titled TITLE, then grows and shrinks the viewport,
 * sampling the visible xterm for trailing-dot rows for 1.2s after each step
 * and comparing the workspace's tmux window (read over its socket, SOCK) with
 * the xterm grid. Screenshot -> ./pane-grow-dots.png. Prints PASS/FAIL.
 *
 * Run (needs a containerless server, no auth, with a TUI workspace open-able;
 * SOCK is the workspace's tmux socket, from `ps -eo args | grep 'tmux -S'`):
 *   SOCK=/tmp/yaac-…/….sock TITLE="My workspace" \
 *     node test-playwright-scripts/pane-grow-dots.js
 * ORIGIN (default http://127.0.0.1:8787) and PROJECT (default yaac) select
 * the server and project.
 */
import { execSync } from 'node:child_process'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/opt/playwright-browsers'
const { chromium } = (() => { try { return require('playwright') } catch { return require(path.join(execSync('npm root -g').toString().trim(), 'playwright')) } })()
const SOCK = process.env.SOCK, TITLE = process.env.TITLE
const win = () => execSync(`tmux -S ${SOCK} list-windows -t yaac -F '#{window_index}:#{window_width}x#{window_height}'`).toString().trim().split('\n')[0].split(':')[1]
const PROBE = () => {
  const vis = [...window.__xterms].filter((t) => t.element && getComputedStyle(t.element).visibility === 'visible')
  const t = vis[0]; if (!t) return null
  let dots = 0
  for (let y = 0; y < t.rows; y++) { const l = t.buffer.active.getLine(t.buffer.active.baseY + y); if (l && /·{2,}\s*$/.test(l.translateToString(false))) dots++ }
  return { grid: `${t.cols}x${t.rows}`, dots }
}
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 900, height: 600 } })
await page.goto(`${process.env.ORIGIN ?? 'http://127.0.0.1:8787'}/?project=${process.env.PROJECT ?? 'yaac'}`)
await page.locator('aside').first().waitFor({ state: 'visible', timeout: 15000 })
await page.locator('aside').getByText(TITLE).first().click()
await page.waitForTimeout(6000)
let fail = false
for (const [w, h] of [[1680, 1050], [1100, 700], [1900, 1150], [1000, 650], [1680, 1050]]) {
  await page.setViewportSize({ width: w, height: h })
  let maxDots = 0, dotFrames = 0, frames = 0
  const t0 = Date.now()
  while (Date.now() - t0 < 1200) {
    const p = await page.evaluate(PROBE); frames++
    if (p && p.dots > 0) { dotFrames++; maxDots = Math.max(maxDots, p.dots) }
  }
  const p = await page.evaluate(PROBE); const wz = win()
  const ok = dotFrames === 0 && wz === p.grid
  if (!ok) fail = true
  console.log(`${ok ? 'PASS' : 'FAIL'} viewport ${w}x${h}: xterm ${p.grid} tmux ${wz} | dot frames ${dotFrames}/${frames} (max ${maxDots} rows)`)
}
await page.screenshot({ path: 'pane-grow-dots.png' })
await browser.close()
console.log(fail ? 'FAIL' : 'PASS')
