/*
 * Verifies the sidebar header layout after the plan-usage ("fable") and
 * image-build chits were moved off the project-name strip onto their own
 * row below it, so a long project name gets the full width of the top strip.
 *
 * Structural checks against the real rendered DOM:
 *  1. The name lives in the `.titlebar-drag` top strip.
 *  2. The chit row (UsageBadge + ImageBuildIndicator) is a sibling div that
 *     renders strictly BELOW that strip (its top >= the strip's bottom).
 *  3. When neither chit has anything to show the row collapses to zero height
 *     (Tailwind `empty:hidden`), leaving no dead vertical gap.
 *  4. The name group spans (nearly) the full strip width — the chits no
 *     longer share the top row.
 *
 * Drives the Vite dev server (`pnpm --filter @yaac/frontend dev`, port 1420),
 * which serves live source and proxies /auth,/project,/events,... to the
 * running yaac server. A one-time token is minted over the server's API
 * using the lock secret and exchanged for the session cookie.
 *
 * Run: node test-playwright-scripts/sidebar-header-rows-test.js
 * (set SCREENSHOT_DIR to capture the sidebar). Needs a running server
 * (`yaac server start`) and the dev server on :1420; reads port/secret from
 * $YAAC_DATA_DIR/.server.lock (or ~/.yaac). (playwright is resolved from the
 * global npm root; browsers live under /opt/playwright-browsers)
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)

function requirePlaywright() {
  try {
    return require('playwright')
  } catch {
    const globalRoot = execSync('npm root -g').toString().trim()
    return require(path.join(globalRoot, 'playwright'))
  }
}

function readServerLock() {
  const candidates = [
    process.env.YAAC_DATA_DIR && path.join(process.env.YAAC_DATA_DIR, '.server.lock'),
    path.join(os.homedir(), '.yaac', '.server.lock'),
  ].filter(Boolean)
  for (const p of candidates) {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'))
  }
  throw new Error(`no .server.lock found (tried ${candidates.join(', ')}) — is the server running?`)
}

let failures = 0
function check(name, cond, detail = '') {
  const mark = cond ? 'PASS' : 'FAIL'
  if (!cond) failures++
  console.log(`${mark}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const APP_URL = process.env.APP_URL ?? 'http://localhost:1420'
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR

async function mintToken(lock, body) {
  const res = await fetch(`http://127.0.0.1:${lock.port}/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${lock.secret}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (res.status !== 201) throw new Error(`mint failed: HTTP ${res.status}`)
  return (await res.json()).token
}

const { chromium } = requirePlaywright()
const lock = readServerLock()
const browser = await chromium.launch()
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await ctx.newPage()
  page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))

  const token = await mintToken(lock, { kind: 'one-time' })
  await page.goto(`${APP_URL}/?token=${token}`)
  await page.waitForFunction(() => !window.location.search.includes('token='))

  // The seeded env has a single project → auto-selected. Wait for its header.
  const aside = page.locator('aside').first()
  await aside.waitFor({ state: 'visible', timeout: 15_000 })
  // Give the pushed /events snapshot a beat to populate usage/build chits.
  await page.waitForTimeout(4000)

  const geom = await aside.evaluate((el) => {
    const strip = el.querySelector('.titlebar-drag')
    const rows = Array.from(el.querySelectorAll(':scope > div > div'))
    // The chit row is the sibling div right after the .titlebar-drag strip.
    const chitRow = strip?.nextElementSibling ?? null
    const chits = chitRow
      ? Array.from(chitRow.children).map((c) => c.getAttribute('aria-label') || c.textContent?.trim() || c.tagName)
      : []
    const nameGroup = strip?.firstElementChild ?? null
    const r = (n) => (n ? n.getBoundingClientRect() : null)
    return {
      strip: r(strip),
      chitRow: r(chitRow),
      chitRowDisplay: chitRow ? getComputedStyle(chitRow).display : null,
      chitRowClass: chitRow ? chitRow.className : null,
      chits,
      // The chits must have left the top strip — none of its descendants
      // should be the usage/plan pill anymore.
      usageInStrip: !!strip?.querySelector('[aria-label="Show plan usage"]'),
      nameGroup: r(nameGroup),
      nameText: nameGroup?.textContent?.trim(),
      rowCount: rows.length,
    }
  })

  console.log('  header geometry:', JSON.stringify(geom, null, 2))

  check('header strip exists and holds the name', !!geom.strip && !!geom.nameText, geom.nameText)
  check('a chit row div follows the name strip', !!geom.chitRow, geom.chitRowClass)
  check('no chit remains on the top name strip', !geom.usageInStrip)

  if (geom.chits.length > 0) {
    check('chit row renders strictly below the name strip',
      geom.chitRow.top >= Math.floor(geom.strip.bottom) - 1,
      `chitRow.top=${geom.chitRow.top} strip.bottom=${geom.strip.bottom}`)
    // The name group (flex-1) reaches the action buttons: only the small
    // +/hide-sidebar cluster + padding sit to its right.
    check('name group extends to the action-button cluster',
      geom.strip.right - geom.nameGroup.right <= 90,
      `gap-to-right=${Math.round(geom.strip.right - geom.nameGroup.right)}px`)
    console.log(`  chits present on the second row: ${geom.chits.join(', ')}`)
  } else {
    check('empty chit row collapses to zero height (empty:hidden)',
      geom.chitRow.height === 0 || geom.chitRowDisplay === 'none',
      `height=${geom.chitRow?.height} display=${geom.chitRowDisplay}`)
    console.log('  (no chits to show in this env — verified the row collapses)')
  }

  if (SCREENSHOT_DIR) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true })
    await aside.screenshot({ path: path.join(SCREENSHOT_DIR, 'sidebar-header.png') })
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'workspace-full.png') })
    console.log(`  screenshots written to ${SCREENSHOT_DIR}`)
  }

  await ctx.close()
} finally {
  await browser.close()
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
