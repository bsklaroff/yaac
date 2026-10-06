/*
 * Verifies the sidebar header layout: the status chits (plan usage, image
 * builds, git-auth failure) sit on their own row below the project-name
 * strip, so a long project name gets the strip's full width.
 *
 *  1. With no chits to show, the chit row collapses (Tailwind `empty:hidden`).
 *  2. With a git-auth failure injected into every `/api/events` snapshot
 *     frame, the badge renders in the chit row, below the strip and not in
 *     it, and the name group still reaches the strip's button cluster.
 *
 * The failure is faked by rewriting snapshot frames in flight, so no failing
 * credential is needed.
 *
 * Needs a running server with at least one project.
 * Run: YAAC_DATA_DIR=<data dir> node test-playwright-scripts/sidebar-header-rows-test.js
 */
import path from 'node:path'
import { requirePlaywright, origin, check, finish, SHOTS } from './lib.js'

let injectFailure = false
const { chromium } = requirePlaywright()
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))

await page.routeWebSocket(/\/api\/events$/, (route) => {
  const server = route.connectToServer()
  server.onMessage((message) => {
    const parsed = typeof message === 'string' ? JSON.parse(message) : null
    if (injectFailure && parsed?.type === 'snapshot') {
      const fake = [{ host: 'github.com', status: 401, atMs: 1_784_000_000_000 }]
      parsed.data.gitAuthFailures = Object.fromEntries(parsed.data.projects.map((p) => [p.id, fake]))
      route.send(JSON.stringify(parsed))
    } else {
      route.send(message)
    }
  })
})

/** The header's strip, chit row, name group and right-hand button cluster. */
const geometry = () => page.locator('aside').first().evaluate((el) => {
  const strip = el.querySelector('.titlebar-drag')
  const chitRow = strip.nextElementSibling
  const badge = el.querySelector('[aria-label="Git authentication failed"]')
  const r = (n) => n?.getBoundingClientRect().toJSON() ?? null
  return {
    strip: r(strip),
    chitRow: r(chitRow),
    chitRowDisplay: getComputedStyle(chitRow).display,
    chitCount: chitRow.children.length,
    name: r(strip.firstElementChild),
    nameText: strip.firstElementChild.textContent.trim(),
    cluster: r(strip.lastElementChild),
    badge: r(badge),
    badgeInChitRow: chitRow.contains(badge),
    badgeInStrip: strip.contains(badge),
  }
})

await page.goto(`${origin}/`)
await page.locator('aside').first().waitFor({ state: 'visible', timeout: 15_000 })
await page.waitForTimeout(3000)
let g = await geometry()
check('the strip holds the project name', !!g.nameText, g.nameText)
if (g.chitCount === 0) {
  check('an empty chit row collapses', g.chitRowDisplay === 'none', g.chitRowDisplay)
} else {
  console.log(`  (${g.chitCount} chit(s) already showing; skipping the collapse check)`)
}

injectFailure = true
await page.reload()
await page.getByLabel('Git authentication failed').waitFor({ timeout: 15_000 })
g = await geometry()
check('the git-auth badge is in the chit row, not the strip', g.badgeInChitRow && !g.badgeInStrip)
check('the chit row renders below the strip', g.chitRow.top >= Math.floor(g.strip.bottom) - 1,
  `chitRow.top=${g.chitRow.top} strip.bottom=${g.strip.bottom}`)
check('the name group reaches the button cluster', g.cluster.left - g.name.right <= 9,
  `gap=${Math.round(g.cluster.left - g.name.right)}px`)
await page.locator('aside').first().screenshot({ path: path.join(SHOTS, 'sidebar-header.png') })

await browser.close()
finish()
