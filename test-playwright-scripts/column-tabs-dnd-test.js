#!/usr/bin/env node
/*
 * column-tabs-dnd-test.js
 *
 * Verifies the equal-width-columns window manager's drag-and-drop in tiles
 * mode against a running server with one active session that has several
 * terminals (agent + a few shells):
 *   1. baseline: every pane is its own equal-width column (N columns, one tab
 *      each);
 *   2. drag a shell tab onto the Agent column's centre band -> it becomes a
 *      second tab of the Agent column (N-1 columns; Agent column has 2 tabs);
 *   3. drag that shell tab out to the right edge -> it becomes its own column
 *      again (back to N columns, one tab each).
 * A column is counted by its per-column "New shell tab" (+) button; each
 * column's tabs are the non-empty button labels in its header. Screenshots
 * land in /tmp/yaac-shots/dnd-*.png. Prints PASS/FAIL and leaves the session
 * untouched (it is not created or deleted here).
 *
 * Run (needs a running server + one active multi-terminal session):
 *   node test-playwright-scripts/column-tabs-dnd-test.js
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync('/opt/playwright-browsers')) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/playwright-browsers'
}
const pw = (() => {
  try { return require('playwright') } catch {
    return require(path.join(execSync('npm root -g').toString().trim(), 'playwright'))
  }
})()
function readLock() {
  for (const p of [
    process.env.YAAC_DATA_DIR && path.join(process.env.YAAC_DATA_DIR, '.server.lock'),
    path.join(os.homedir(), '.yaac', '.server.lock'),
  ].filter(Boolean)) if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'))
  throw new Error('no .server.lock — is the server running?')
}
const lock = readLock()
const origin = `http://127.0.0.1:${lock.port}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function mintToken() {
  const r = await fetch(`${origin}/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${lock.secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'one-time' }),
  })
  if (r.status !== 201) throw new Error(`token mint HTTP ${r.status}`)
  return (await r.json()).token
}

// Per-column tab labels: each tiles column is a <section> carrying a
// "New shell tab" (+) button; its tabs are the non-empty button labels.
const readColumns = (page) => page.evaluate(() => {
  const secs = [...document.querySelectorAll('section')]
    .filter((s) => s.querySelector('[aria-label="New shell tab"]'))
  return secs.map((s) => [...s.querySelectorAll('button')]
    .map((b) => (b.textContent || '').trim())
    .filter(Boolean))
})

async function tabBox(page, name) {
  return page.getByRole('button', { name, exact: true }).first().boundingBox()
}
// Drag from a point to a point crossing the 5px threshold with real pointer moves.
async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 12, from.y + 12, { steps: 4 })
  await page.mouse.move(to.x, to.y, { steps: 12 })
  await page.mouse.up()
  await sleep(600)
}

async function main() {
  fs.mkdirSync('/tmp/yaac-shots', { recursive: true })
  const browser = await pw.chromium.launch()
  let pass = false
  try {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    // Force tiles mode; start from a clean layout so the columns match the
    // live windows one-to-one.
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('yaac.viewmode.v1', 'tiles')
        localStorage.removeItem('yaac.layouts.v2')
      } catch { /* ignore */ }
    })
    const page = await ctx.newPage()
    page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
    const token = await mintToken()
    await page.goto(`${origin}/?token=${token}&project=yaac`)
    await page.waitForFunction(() => !window.location.search.includes('token='), { timeout: 15000 })
    // Select the (single) active session from the sidebar.
    await page.locator('aside').getByText('New session').first().click({ timeout: 15000 })
    // Wait for the tiles columns to render.
    await page.locator('[aria-label="New shell tab"]').first().waitFor({ state: 'visible', timeout: 15000 })
    await sleep(2500)

    const base = await readColumns(page)
    console.log('baseline columns:', JSON.stringify(base))
    await page.screenshot({ path: '/tmp/yaac-shots/dnd-1-baseline.png' })
    // Every column holds exactly one tab, and there is more than one column.
    const baselineOk = base.length >= 3 && base.every((c) => c.length === 1)

    // Pick a shell tab to move and the Agent column to drop it into.
    const shell = base.map((c) => c[0]).find((t) => t.startsWith('shell'))
    if (!shell) throw new Error('no shell column to drag')
    const src = await tabBox(page, shell)
    // Agent column centre band -> drop as a tab.
    const agentSecBox = await page.evaluate(() => {
      const sec = [...document.querySelectorAll('section')]
        .find((s) => s.querySelector('[aria-label="New shell tab"]')
          && [...s.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === 'Agent'))
      if (!sec) return null
      const r = sec.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height }
    })
    if (!agentSecBox) throw new Error('no Agent column found')
    await drag(page,
      { x: src.x + src.width / 2, y: src.y + src.height / 2 },
      { x: agentSecBox.x + agentSecBox.w / 2, y: agentSecBox.y + agentSecBox.h / 2 })

    const merged = await readColumns(page)
    console.log('after merge-into-Agent:', JSON.stringify(merged))
    await page.screenshot({ path: '/tmp/yaac-shots/dnd-2-tabbed.png' })
    const agentCol = merged.find((c) => c.includes('Agent'))
    const mergedOk = merged.length === base.length - 1
      && agentCol && agentCol.includes('Agent') && agentCol.includes(shell)

    // Now drag the shell tab (living in the Agent column) back out to the far
    // right edge -> its own column again.
    const ws = await page.locator('.relative.isolate.min-h-0.flex-1').first().boundingBox()
    const src2 = await tabBox(page, shell)
    await drag(page,
      { x: src2.x + src2.width / 2, y: src2.y + src2.height / 2 },
      { x: ws.x + ws.width - 8, y: ws.y + ws.height / 2 })

    const split = await readColumns(page)
    console.log('after drag-out:', JSON.stringify(split))
    await page.screenshot({ path: '/tmp/yaac-shots/dnd-3-split.png' })
    const splitOk = split.length === base.length && split.every((c) => c.length === 1)

    console.log(`checks: baseline=${baselineOk} merge=${mergedOk} split=${splitOk}`)
    pass = baselineOk && mergedOk && splitOk
    console.log(pass ? 'PASS: columns tab-merge and split via drag' : 'FAIL: see column dumps above')
  } finally {
    await browser.close()
  }
  process.exit(pass ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(2) })
