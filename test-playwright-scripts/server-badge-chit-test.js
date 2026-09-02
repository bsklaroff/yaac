/*
 * Shows and verifies the sidebar server chit (ServerBadge.tsx) in real
 * Chromium, and doubles as the way to LOOK at it by hand — the chit only
 * renders behind the `window.yaacServer` bridge the Electron preload
 * installs, so a plain browser tab never shows it and there is nothing to
 * eyeball without standing the bridge up.
 *
 *  1. No bridge (plain browser tab): no chit. This is the shipped behavior —
 *     a browser already names its origin in the URL bar.
 *  2. Bridge injected pre-load (what the preload does): the chit sits in the
 *     sidebar's status-chit row beside the usage pill, showing host:port of
 *     the origin, and clicking it opens Settings on the Server section.
 *  3. Bridge injected POST-load, the recipe for poking at this from devtools:
 *     paste the bridge, then toggle the sidebar to force a React re-render.
 *     Nothing subscribes to `window.yaacServer`, so without a re-render the
 *     chit does not appear on its own.
 *
 * Screenshots land in /tmp/yaac-shots/server-badge-*.png — the cropped
 * sidebar ones are the useful ones to look at.
 *
 * Drives the app the server itself serves (`dist/`), reading the port + lock
 * secret from $YAAC_DATA_DIR/.server.lock — so run `pnpm build` +
 * `yaac server restart` first, or you are looking at the frontend as it was.
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

async function mintToken(lock) {
  const res = await fetch(`http://127.0.0.1:${lock.port}/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${lock.secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'one-time' }),
  })
  if (res.status !== 201) throw new Error(`token mint failed: HTTP ${res.status}`)
  return (await res.json()).token
}

const SHOTS = '/tmp/yaac-shots'
const CHIT = '[aria-label="Open server settings"]'
// Kept in sync with store.ts by hand — this is a standalone node script, not
// part of the frontend's module graph.
const MIN_SIDEBAR_WIDTH = 180
const MAX_SIDEBAR_WIDTH = 640

/** The bridge body, shared by the pre-load and post-load paths — and the
 *  same text the devtools recipe in the header pastes. */
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
  const token = await mintToken(lock)
  await page.goto(`http://127.0.0.1:${lock.port}/?token=${token}`)
  // waitForURL, not waitForFunction: the app's CSP has no 'unsafe-eval', and
  // a string predicate evaluated in the page trips it once the served
  // document (rather than the pre-navigation one) is current.
  await page.waitForURL((url) => !url.searchParams.has('token'), { timeout: 15_000 })
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

  // --- 1. Plain browser: no bridge → no chit.
  {
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
    page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
    await openApp(page, lock)
    check(await page.locator(CHIT).count() === 0, 'plain browser shows no server chit')
    await page.locator('aside').first().screenshot({ path: path.join(SHOTS, 'server-badge-absent.png') })
    await page.close()
  }

  // --- 2. Bridge injected pre-load, as the Electron preload does.
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

  // The chit belongs to the sidebar's chit row, beside the usage pill.
  check(await chit.evaluate((el) => el.parentElement.className.includes('empty:hidden')),
    'chit sits in the sidebar status-chit row')

  await page.locator('aside').first().screenshot({ path: path.join(SHOTS, 'server-badge-sidebar.png') })
  await page.screenshot({ path: path.join(SHOTS, 'server-badge-app.png') })

  // Clicking opens settings on the Server section — the one place the chit
  // leads, and the reason it is gated on the same bridge that section is.
  await chit.click()
  await page.getByText('Add a server').waitFor({ timeout: 10_000 })
  check(true, 'clicking the chit opens Settings on the Server section')
  await page.screenshot({ path: path.join(SHOTS, 'server-badge-settings.png') })
  await page.keyboard.press('Escape')
  await page.close()

  // --- 2b. The chit takes the room a wide sidebar gives it, and only
  // truncates when the row really is too narrow. This is measured against a
  // long host stuffed into the label, because the origin under test is a
  // short loopback one — a tailscale host is what exposes a width cap.
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

  // --- 3. The devtools recipe: bridge pasted post-load, then a re-render.
  {
    const p = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
    p.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
    await openApp(p, lock)
    await p.evaluate(BRIDGE)
    check(await p.locator(CHIT).count() === 0, 'pasted bridge alone does not repaint the chit')
    // Hide + show the sidebar: the cheapest re-render of the row that has it.
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
