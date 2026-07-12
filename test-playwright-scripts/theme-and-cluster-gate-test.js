/*
 * Verifies the light/dark theming and the first-run cluster gate ported from
 * the electron-planning branch:
 *  1. Landing authed (token → cookie) renders the workspace dark by default
 *     (html[data-theme=system], dark --color-base background), with the
 *     sidebar as a floating card and its compact empty state.
 *  2. Settings → Theme → Light flips html[data-theme] to 'light' live, the
 *     shell recolors (near-white base), and yaac.theme.v1 persists it; a
 *     cookie-only reload comes back already light (no-flash inline script).
 *  3. The sidebar's Hide toggle collapses it and the session bar grows the
 *     Show-sidebar reopen affordance (only visible while collapsed).
 *  4. When GET /cluster/check reports not-ok (true in a nested yaac session,
 *     where the probe pod can't run), the ClusterSetup gate replaces the
 *     workspace. The Set up button is NOT clicked (it would recreate the
 *     cluster).
 *
 * Run: node test-playwright-scripts/theme-and-cluster-gate-test.js
 * (set SCREENSHOT_DIR to capture dark/light/gate states)
 * Needs a running server serving the built SPA (`yaac server start` with
 * dist/frontend present); reads port/secret from $YAAC_DATA_DIR/.server.lock
 * (or ~/.yaac). (playwright is resolved from the global npm root; browsers
 * live under /opt/playwright-browsers)
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
function loadPlaywright() {
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim()
    return require(path.join(globalRoot, 'playwright'))
  } catch {
    return require('playwright')
  }
}
const { chromium } = loadPlaywright()

const dataDir = process.env.YAAC_DATA_DIR ?? path.join(os.homedir(), '.yaac')
const lock = JSON.parse(fs.readFileSync(path.join(dataDir, '.server.lock'), 'utf8'))
const origin = `http://127.0.0.1:${lock.port}`
const shotDir = process.env.SCREENSHOT_DIR
const shot = async (page, name) => {
  if (shotDir) await page.screenshot({ path: path.join(shotDir, name), fullPage: true })
}

const fail = (msg) => { throw new Error(`FAIL: ${msg}`) }

async function mintToken() {
  const res = await fetch(`${origin}/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${lock.secret}` },
    body: JSON.stringify({ kind: 'one-time' }),
  })
  if (res.status !== 201) fail(`mint: HTTP ${res.status}`)
  return (await res.json()).token
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
})
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })

  // 1. Land authed, default (system) theme on a dark-preferring browser.
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto(`${origin}/?token=${await mintToken()}`)
  await page.getByText('No project selected').waitFor({ timeout: 15000 })
  const theme0 = await page.evaluate(() => document.documentElement.dataset.theme)
  if (theme0 !== 'system') fail(`expected data-theme=system on first visit, got ${theme0}`)
  const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  if (darkBg !== 'rgb(15, 15, 18)') fail(`dark --color-base body bg, got ${darkBg}`) // #0f0f12
  const aside = page.locator('aside')
  const asideClass = await aside.getAttribute('class')
  if (!asideClass.includes('rounded-lg') || !asideClass.includes('border-hairline')) {
    fail(`sidebar is not the floating card: ${asideClass}`)
  }
  await shot(page, '1-dark-workspace.png')

  // 2. Settings → Theme → Light.
  await page.getByTitle('Settings').click()
  await page.getByText('Theme', { exact: true }).waitFor()
  await page.getByText('Light', { exact: true }).click()
  const theme1 = await page.evaluate(() => document.documentElement.dataset.theme)
  if (theme1 !== 'light') fail(`expected data-theme=light after picking Light, got ${theme1}`)
  const stored = await page.evaluate(() => localStorage.getItem('yaac.theme.v1'))
  if (stored !== 'light') fail(`expected yaac.theme.v1=light persisted, got ${stored}`)
  await page.keyboard.press('Escape')
  const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  if (lightBg !== 'rgb(252, 252, 251)') fail(`light --color-base body bg, got ${lightBg}`) // #fcfcfb
  await shot(page, '2-light-workspace.png')

  // Cookie-only reload lands already-light (pre-paint inline script).
  await page.goto(origin)
  await page.getByText('No project selected').waitFor({ timeout: 15000 })
  const theme2 = await page.evaluate(() => document.documentElement.dataset.theme)
  if (theme2 !== 'light') fail(`expected light to survive a reload, got ${theme2}`)

  // 3. Sidebar hide/show round-trip.
  await page.getByTitle('Hide sidebar').click()
  if (await page.locator('aside').count() !== 0) fail('sidebar still present after Hide')
  await page.getByTitle('Show sidebar').waitFor({ timeout: 5000 })
  await shot(page, '3-sidebar-hidden.png')
  await page.getByTitle('Show sidebar').click()
  await page.locator('aside').waitFor({ timeout: 5000 })
  if (await page.getByTitle('Show sidebar').count() !== 0) {
    fail('Show-sidebar affordance should render only while collapsed')
  }

  // 4. The cluster gate flips in once the (slow, probe-driven) check lands.
  await page.getByText('Set up yaac').waitFor({ timeout: 120000 })
  await page.getByRole('button', { name: 'Set up' }).waitFor()
  await shot(page, '4-cluster-gate.png')

  console.log('PASS: theme switching, no-flash reload, sidebar toggle, cluster gate')
} finally {
  await browser.close()
}
