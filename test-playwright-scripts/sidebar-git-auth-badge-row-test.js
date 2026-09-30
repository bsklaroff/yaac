/*
 * Verifies the git-auth-failure badge renders on the sidebar header's chit
 * row (with the plan-usage and image-build chits), not on the project-name
 * strip above it.
 *
 * Instead of a real failing session pod (git-auth-badge-test.js covers that
 * end to end), this rewrites each `/events` snapshot frame in flight with
 * Playwright's WebSocket routing, adding a fake gitAuthFailures entry. That
 * is enough to check where the badge lands in the layout.
 *
 * Checks:
 *  1. The badge (aria-label "Git authentication failed") is inside the chit
 *     row, the div after the `.titlebar-drag` strip.
 *  2. The badge renders below the name strip.
 *
 * Drives the Vite dev server (`pnpm --filter @yaac/frontend dev`, port 1420)
 * against the running yaac server.
 *
 * Run: node test-playwright-scripts/sidebar-git-auth-badge-row-test.js
 * (set SCREENSHOT_DIR to capture the sidebar).
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
// Fixed so the injected frame is deterministic.
const FAKE_AT_MS = 1_784_000_000_000

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await ctx.newPage()
  page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))

  // Key the fake failure under every slug in the frame (plus "yaac") so it
  // lands on whichever project is active.
  await page.routeWebSocket(/\/events$/, (route) => {
    const server = route.connectToServer()
    server.onMessage((message) => {
      if (typeof message === 'string') {
        try {
          const parsed = JSON.parse(message)
          if (parsed?.type === 'snapshot' && parsed.data) {
            const slugs = new Set(['yaac', ...Object.keys(parsed.data.gitAuthFailures ?? {})])
            const fake = [{ host: 'github.com', status: 401, atMs: FAKE_AT_MS }]
            parsed.data.gitAuthFailures = Object.fromEntries([...slugs].map((s) => [s, fake]))
            route.send(JSON.stringify(parsed))
            return
          }
        } catch { /* not JSON — forward as-is */ }
      }
      route.send(message)
    })
  })

  await page.goto(`${APP_URL}/`)

  const aside = page.locator('aside').first()
  await aside.waitFor({ state: 'visible', timeout: 15_000 })

  const badge = aside.getByLabel('Git authentication failed')
  await badge.waitFor({ state: 'visible', timeout: 15_000 })

  const geom = await aside.evaluate((el) => {
    const strip = el.querySelector('.titlebar-drag')
    const chitRow = strip?.nextElementSibling ?? null
    const badgeEl = el.querySelector('[aria-label="Git authentication failed"]')
    const r = (n) => (n ? n.getBoundingClientRect() : null)
    return {
      strip: r(strip),
      badgeInChitRow: !!chitRow && chitRow.contains(badgeEl),
      badgeInStrip: !!strip && strip.contains(badgeEl),
      badge: r(badgeEl),
      chitRowChildren: chitRow
        ? Array.from(chitRow.children).map((c) => c.getAttribute('aria-label') || c.textContent?.trim())
        : [],
    }
  })
  console.log('  chit-row children:', JSON.stringify(geom.chitRowChildren))

  check('git-auth badge is in the chit row, not the name strip',
    geom.badgeInChitRow && !geom.badgeInStrip,
    `inChitRow=${geom.badgeInChitRow} inStrip=${geom.badgeInStrip}`)
  check('git-auth badge renders below the name strip',
    geom.badge.top >= Math.floor(geom.strip.bottom) - 1,
    `badge.top=${Math.round(geom.badge.top)} strip.bottom=${geom.strip.bottom}`)

  if (SCREENSHOT_DIR) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true })
    await aside.screenshot({ path: path.join(SCREENSHOT_DIR, 'sidebar-git-auth-row.png') })
    console.log(`  screenshot written to ${SCREENSHOT_DIR}/sidebar-git-auth-row.png`)
  }

  await ctx.close()
} finally {
  await browser.close()
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
