/*
 * Verifies the sidebar header layout: the plan-usage and image-build chits
 * sit on their own row below the project-name strip, so a long project name
 * gets the strip's full width.
 *
 * Checks against the rendered DOM:
 *  1. The name is in the `.titlebar-drag` top strip.
 *  2. The chit row (UsageBadge + ImageBuildIndicator) is the next sibling div
 *     and renders below the strip.
 *  3. With no chits to show, the row collapses to zero height
 *     (Tailwind `empty:hidden`).
 *  4. The name group spans nearly the full strip width.
 *
 * Drives the Vite dev server (`pnpm --filter @yaac/frontend dev`, port 1420),
 * which serves live source and proxies API calls to the running yaac server.
 * Loopback needs no credential.
 *
 * Run: node test-playwright-scripts/sidebar-header-rows-test.js
 * (set SCREENSHOT_DIR to capture the sidebar). Needs a running server
 * (`yaac server start`) and the dev server on :1420.
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
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

let failures = 0
function check(name, cond, detail = '') {
  const mark = cond ? 'PASS' : 'FAIL'
  if (!cond) failures++
  console.log(`${mark}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const APP_URL = process.env.APP_URL ?? 'http://localhost:1420'
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await ctx.newPage()
  page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))

  await page.goto(`${APP_URL}/`)

  const aside = page.locator('aside').first()
  await aside.waitFor({ state: 'visible', timeout: 15_000 })
  // Give the /events snapshot time to populate the chits.
  await page.waitForTimeout(4000)

  const geom = await aside.evaluate((el) => {
    const strip = el.querySelector('.titlebar-drag')
    const rows = Array.from(el.querySelectorAll(':scope > div > div'))
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
    // Only the +/hide-sidebar buttons should sit right of the name group.
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
