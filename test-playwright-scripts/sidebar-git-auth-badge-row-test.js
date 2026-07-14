/*
 * Verifies the git-auth-failure badge now renders on the sidebar header's
 * second (chit) row — alongside the plan-usage and image-build chits —
 * rather than on the top project-name strip.
 *
 * Rather than stand up a real failing session pod + mock upstream (see
 * git-auth-badge-test.js for that end-to-end path), this rewrites the
 * server-pushed `/events` snapshot in-flight with Playwright's WebSocket
 * routing: every `{type:'snapshot'}` frame gets a fake gitAuthFailures entry
 * for the active project injected before it reaches the app. That is enough
 * to exercise the *layout* — where the badge lands in the DOM — which is all
 * this change touched.
 *
 * Checks:
 *  1. The badge (aria-label "Git authentication failed") is inside the chit
 *     row (the sibling div after the `.titlebar-drag` strip), not the strip.
 *  2. The badge renders strictly below the name strip.
 *
 * Drives the Vite dev server (`pnpm --filter @yaac/frontend dev`, port 1420)
 * against the running yaac server. Reads port/secret from
 * $YAAC_DATA_DIR/.server.lock (or ~/.yaac); mints a one-time token to auth.
 *
 * Run: node test-playwright-scripts/sidebar-git-auth-badge-row-test.js
 * (set SCREENSHOT_DIR to capture the sidebar). (playwright is resolved from
 * the global npm root; browsers live under /opt/playwright-browsers)
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
// A fixed (not Date.now()) epoch so the injected frame is deterministic.
const FAKE_AT_MS = 1_784_000_000_000

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

  // Inject a fake git-auth failure into every snapshot frame, keyed under
  // every project slug the frame already knows about (plus the seeded
  // "yaac"), so it lands on whichever project is active.
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

  const token = await mintToken(lock, { kind: 'one-time' })
  await page.goto(`${APP_URL}/?token=${token}`)
  await page.waitForFunction(() => !window.location.search.includes('token='))

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
