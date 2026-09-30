/*
 * Verifies the sidebar server chit (ServerBadge.tsx) in Chromium, and is the
 * way to look at it by hand: the chit renders only when the Electron
 * preload's `window.yaacServer` bridge exists, so a plain browser never
 * shows it.
 *
 *  1. No bridge (plain browser tab): no chit.
 *  2. Bridge injected before load (as the preload does): the chit sits in
 *     the sidebar's status-chit row, shows the origin's host:port, and
 *     clicking it opens Settings on the Server section.
 *  3. Bridge injected after load (the devtools recipe): paste the bridge,
 *     then toggle the sidebar. Nothing subscribes to `window.yaacServer`, so
 *     the chit appears only after a re-render.
 *
 * Screenshots land in /tmp/yaac-shots/server-badge-*.png.
 *
 * Drives the app the server serves from `dist/`, reading the port from
 * $YAAC_DATA_DIR/.server.lock, so run `pnpm build` + `yaac server restart`
 * first to see current frontend code.
 *
 * Run: node test-playwright-scripts/server-badge-chit-test.js
 * Needs a running server (`yaac server start` / `pnpm watch`).
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
  throw new Error('no .server.lock found — is the server running?')
}

const SHOTS = '/tmp/yaac-shots'
const CHIT = '[aria-label="Open server settings"]'
// Copied from packages/frontend/src/lib/store.ts; keep in sync by hand.
const MIN_SIDEBAR_WIDTH = 180
const MAX_SIDEBAR_WIDTH = 640

/** The bridge stub, injected before or after load (and the devtools recipe). */
const BRIDGE = () => {
  window.yaacServer = {
    targets: () => Promise.resolve({
      current: 'https://alpha.ts.net',
      saved: ['https://alpha.ts.net'],
    }),
    switchTo: () => Promise.resolve({ ok: true }),
    addRemote: () => Promise.resolve({ ok: true }),
  }
}

async function openApp(page, lock) {
  await page.goto(`http://127.0.0.1:${lock.port}/`)
  // Wait on a locator, not waitForFunction: the app's CSP has no
  // 'unsafe-eval', which a string predicate evaluated in the page trips.
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 15_000 })
}

async function main() {
  const { chromium } = requirePlaywright()
  const lock = readServerLock()
  fs.mkdirSync(SHOTS, { recursive: true })
  const browser = await chromium.launch()
  const failures = []
  const check = (ok, label) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}`)
    if (!ok) failures.push(label)
  }

  // 1. Plain browser: no bridge, no chit.
  {
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
    page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
    await openApp(page, lock)
    check(await page.locator(CHIT).count() === 0, 'plain browser shows no server chit')
    await page.locator('aside').first().screenshot({ path: path.join(SHOTS, 'server-badge-absent.png') })
    await page.close()
  }

  // 2. Bridge injected before load, as the Electron preload does.
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await context.addInitScript(BRIDGE)
  const page = await context.newPage()
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  await openApp(page, lock)

  const chit = page.locator(CHIT).first()
  check(await chit.isVisible(), 'desktop shell shows the server chit')

  const label = (await chit.textContent()).trim()
  const expected = await page.evaluate(() => window.location.host)
  check(label === expected, `chit names the origin host (want ${expected}, got ${JSON.stringify(label)})`)
  check((await chit.getAttribute('title')).includes(await page.evaluate(() => window.location.origin)),
    'chit tooltip carries the full origin')

  check(await chit.evaluate((el) => el.parentElement.className.includes('empty:hidden')),
    'chit sits in the sidebar status-chit row')

  await page.locator('aside').first().screenshot({ path: path.join(SHOTS, 'server-badge-sidebar.png') })
  await page.screenshot({ path: path.join(SHOTS, 'server-badge-app.png') })

  await chit.click()
  await page.getByText('Add a server').waitFor({ timeout: 10_000 })
  check(true, 'clicking the chit opens Settings on the Server section')
  await page.screenshot({ path: path.join(SHOTS, 'server-badge-settings.png') })
  await page.keyboard.press('Escape')
  await page.close()

  // 2b. The chit uses the width a wide sidebar gives it and truncates only
  // when the row is too narrow. The local origin is a short loopback host,
  // so a long tailscale-style host is swapped into the label to measure.
  for (const [width, shouldFit] of [[MAX_SIDEBAR_WIDTH, true], [MIN_SIDEBAR_WIDTH, false]]) {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await ctx.addInitScript(BRIDGE)
    await ctx.addInitScript((px) => {
      localStorage.setItem('yaac.sidebarwidth.v1', String(px))
    }, width)
    const p = await ctx.newPage()
    p.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
    await openApp(p, lock)

    const m = await p.locator(CHIT).first().evaluate((el) => {
      const span = el.querySelector('span')
      const before = span.textContent
      span.textContent = 'yaac-dev.tail9edf1.ts.net:8787'
      const row = el.parentElement.getBoundingClientRect()
      const box = el.getBoundingClientRect()
      const out = {
        maxWidth: getComputedStyle(el).maxWidth,
        width: Math.round(box.width),
        truncated: span.scrollWidth > span.clientWidth + 1,
        overflowsRow: box.right > row.right + 1,
      }
      span.textContent = before
      return out
    })
    check(m.maxWidth === 'none', `chit carries no width cap (got ${m.maxWidth})`)
    check(m.truncated === !shouldFit,
      `long host ${shouldFit ? 'fits' : 'truncates'} at sidebar ${width}px `
      + `(width ${m.width}px, truncated=${m.truncated})`)
    check(!m.overflowsRow, `chit stays inside the row at sidebar ${width}px`)
    if (shouldFit) {
      await p.locator('aside').first().screenshot({
        path: path.join(SHOTS, 'server-badge-wide-sidebar.png'),
      })
    }
    await p.close()
  }

  // 3. The devtools recipe: bridge pasted after load, then a re-render.
  {
    const p = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
    p.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
    await openApp(p, lock)
    await p.evaluate(BRIDGE)
    check(await p.locator(CHIT).count() === 0, 'pasted bridge alone does not repaint the chit')
    // Hiding and showing the sidebar re-renders the chit row.
    await p.locator('[aria-label="Hide sidebar"]').first().click()
    await p.locator('[aria-label="Show sidebar"]').first().click()
    await p.locator(CHIT).first().waitFor({ state: 'visible', timeout: 10_000 })
    check(true, 'chit appears after toggling the sidebar')
    await p.close()
  }

  await browser.close()
  console.log(failures.length === 0
    ? `\nAll checks passed. Shots in ${SHOTS}/server-badge-*.png`
    : `\n${failures.length} FAILED: ${failures.join(', ')}`)
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
