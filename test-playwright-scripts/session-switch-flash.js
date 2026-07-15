#!/usr/bin/env node
/*
 * session-switch-flash.js
 *
 * Verifies that switching between sessions (and tabs) never flashes tmux
 * overflow dots on the right-hand side of the pane. Kept-alive terminals are
 * pinned under per-view `window-size manual` (pty-bridge attachArgs), so a
 * pane resize round-trips a resize-window exec to the pod; hidden panes
 * therefore keep a frozen rect (SessionView) so switches are pure visibility
 * flips with no resize at all. A regression shows up here as dotRows > 0 in
 * the visible xterm buffer right after a switch, or as grids changing across
 * switches.
 *
 * Drives the first two sessions in the sidebar: opens A, opens B, then
 * switches B→A→B, sampling the visible terminal's buffer for trailing-dot
 * rows (·· at line end) at ~80ms for ~1.2s after each switch. Screenshots go
 * to /tmp/yaac-shots/switch-*.png. Prints PASS/FAIL.
 *
 * Run (needs a running server and >= 2 open-able sessions; PROJECT selects
 * the project slug when the auto-selected one has fewer than two):
 *   PROJECT=yaac node test-playwright-scripts/session-switch-flash.js
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
function requirePlaywright() {
  try { return require('playwright') } catch {
    return require(path.join(execSync('npm root -g').toString().trim(), 'playwright'))
  }
}
function readServerLock() {
  const candidates = [
    process.env.YAAC_DATA_DIR && path.join(process.env.YAAC_DATA_DIR, '.server.lock'),
    path.join(os.homedir(), '.yaac', '.server.lock'),
  ].filter(Boolean)
  for (const p of candidates) if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'))
  throw new Error('no .server.lock found — is the server running?')
}
async function mintToken(lock) {
  const res = await fetch(`http://127.0.0.1:${lock.port}/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${lock.secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'one-time' }),
  })
  if (res.status !== 201) throw new Error(`token mint failed: HTTP ${res.status}`)
  return (await res.json()).token
}

// The VISIBLE terminal's grid + trailing-dot rows, and all mounted grids
// (frozen-rect regression check: hidden grids must not move on a switch).
const PROBE = () => {
  const xs = window.__xterms
  if (!xs) return { error: 'no __xterms' }
  const terms = [...(xs.values ? xs.values() : Object.values(xs))]
  const vis = terms.filter((t) => t.element && getComputedStyle(t.element).visibility === 'visible')
  const dotRows = (term) => {
    const buf = term.buffer.active
    let n = 0
    for (let y = 0; y < term.rows; y++) {
      const l = buf.getLine(buf.baseY + y)
      if (l && /·{2,}\s*$/.test(l.translateToString(false))) n++
    }
    return n
  }
  return {
    grids: terms.map((t) => `${t.cols}x${t.rows}`).join(','),
    visible: vis.map((t) => `${t.cols}x${t.rows}:dots=${dotRows(t)}`).join(','),
    maxDots: Math.max(0, ...vis.map(dotRows)),
  }
}

const lock = readServerLock()
const origin = `http://127.0.0.1:${lock.port}`
const { chromium } = requirePlaywright()
const browser = await chromium.launch()
let fail = false
try {
  const ctx = await browser.newContext({ viewport: { width: 1680, height: 1050 }, deviceScaleFactor: 2 })
  const page = await ctx.newPage()
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  const token = await mintToken(lock)
  const project = process.env.PROJECT ? `project=${process.env.PROJECT}&` : ''
  await page.goto(`${origin}/?${project}token=${token}`)
  for (let i = 0; i < 60; i++) {
    if (!(await page.evaluate(() => !window.location.search.includes('token=')))) await page.waitForTimeout(250)
    else break
  }
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 15000 })
  await page.waitForTimeout(2000)

  // Session titles: in the sidebar's text, each session row renders its title
  // on the line right before its "Nm ago" line.
  const titles = await page.evaluate(() => {
    const lines = (document.querySelector('aside')?.innerText ?? '').split('\n').map((l) => l.trim())
    const out = []
    for (let i = 1; i < lines.length; i++) {
      if (/^\d+[smhd] ago$|^just now$/.test(lines[i]) && lines[i - 1]) out.push(lines[i - 1])
    }
    return out
  })
  if (titles.length < 2) throw new Error(`need >= 2 sessions in the sidebar, found ${titles.length} (try PROJECT=<slug>)`)
  const clickSession = (t) => page.locator('aside').getByText(t.slice(0, 12), { exact: false }).first().click()
  console.log(`sessions: A="${titles[0]}" B="${titles[1]}"`)

  const dir = '/tmp/yaac-shots'; fs.mkdirSync(dir, { recursive: true })
  await clickSession(titles[0]); await page.waitForTimeout(5000) // open A (first attach settles)
  await clickSession(titles[1]); await page.waitForTimeout(5000) // open B

  let shot = 0
  const watchSwitch = async (label, title) => {
    await clickSession(title)
    for (let i = 0; i < 15; i++) {
      const p = await page.evaluate(PROBE)
      if (p.maxDots > 0) {
        fail = true
        await page.screenshot({ path: path.join(dir, `switch-FAIL-${label}-${i}.png`) })
        console.log(`  ${label} t+${i * 80}ms DOTS VISIBLE: ${p.visible} (grids ${p.grids})`)
      } else if (i === 0 || i === 7 || i === 14) {
        console.log(`  ${label} t+${i * 80}ms clean: ${p.visible} (grids ${p.grids})`)
      }
      if (i === 2) await page.screenshot({ path: path.join(dir, `switch-${label}-${shot++}.png`) })
      await page.waitForTimeout(80)
    }
  }
  await watchSwitch('B->A', titles[0])
  await watchSwitch('A->B', titles[1])
  await watchSwitch('B->A2', titles[0])
  await watchSwitch('A->B2', titles[1])
  console.log(fail ? 'FAIL: overflow dots flashed during a switch' : 'PASS: no dots on any switch')
} catch (err) {
  fail = true
  console.error(`error: ${err instanceof Error ? err.stack : String(err)}`)
} finally {
  await browser.close()
}
process.exit(fail ? 1 : 0)
