#!/usr/bin/env node
/*
 * session-switch-flash.js
 *
 * Verifies that switching between sessions never flashes tmux overflow dots
 * on the right side of the pane. Each view's tmux window follows its client
 * under `window-size latest` (attachArgs in pty-bridge.ts), and hidden panes
 * keep a frozen rect (WorkspaceView), so a switch only flips visibility and
 * never resizes. A regression shows as dotRows > 0 in the visible buffer
 * right after a switch, or as grid sizes changing across switches.
 *
 * Opens the first two sessions in the sidebar (A, then B), then switches
 * B->A->B->A->B, sampling the visible terminal for rows ending in `··` every
 * ~80ms for ~1.2s after each switch. Screenshots go to
 * /tmp/yaac-shots/switch-*.png. Prints PASS/FAIL.
 *
 * Run (needs a running server and >= 2 sessions; PROJECT picks the project
 * slug when the default one has fewer than two):
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
// Reports the visible terminal's grid and dot rows, plus every mounted grid
// (hidden grids must not change size on a switch).
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
  const project = process.env.PROJECT ? `project=${process.env.PROJECT}` : ''
  await page.goto(`${origin}/?${project}`)
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 15000 })
  await page.waitForTimeout(2000)

  // In the sidebar text, a session's title is the line before its "Nm ago".
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
