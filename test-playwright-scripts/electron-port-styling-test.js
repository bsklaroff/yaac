/*
 * Verifies some desktop-oriented frontend styling:
 *  1. Dark elevated surfaces: --color-surface resolves to #1b1b21, so cards
 *     and popups stand out from the base.
 *  2. The project rail is 64px (w-16) wide with 40px chips. (WindowControls
 *     render only in Electron.)
 *  3. The workspace header's "Changes" button opens the review-diff pane:
 *     "No changes yet" for a clean checkout, a file list otherwise.
 *
 * Run: node test-playwright-scripts/electron-port-styling-test.js
 * (set SCREENSHOT_DIR to capture the workspace and changes-pane states)
 * Needs a running server serving the built SPA (`yaac server start` with
 * dist/frontend present) and at least one running workspace for step 3;
 * reads port from $YAAC_DATA_DIR/.server.lock (or ~/.yaac).
 * (playwright is resolved from the global npm root; browsers live under
 * /opt/playwright-browsers)
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

async function main() {
  const browser = await chromium.launch()
  // Force dark: headless Chromium reports light for the 'system' default.
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
  try {
    await page.goto(`${origin}/`)
    await page.waitForSelector('main', { timeout: 15000 })
    // Wait for the first WS snapshot to hydrate the rail (project chips).
    await page.waitForSelector('button[title="yaac"]', { timeout: 15000 }).catch(() => {})

    // 1. Lifted dark surfaces.
    const surface = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--color-surface').trim())
    if (surface !== '#1b1b21') fail(`--color-surface is ${surface}, want #1b1b21 (lifted)`)
    console.log('OK surface lift: --color-surface =', surface)

    // 2. Rail width and chip size, measured via the settings gear's column.
    const rail = page.locator('div.w-16.shrink-0.flex-col').first()
    const railBox = await rail.boundingBox()
    if (!railBox || Math.round(railBox.width) !== 64) {
      fail(`rail width ${railBox?.width}, want 64`)
    }
    console.log('OK rail width:', railBox.width)
    const chip = page.locator('button[title="New project"]').first()
    const chipBox = await chip.boundingBox()
    if (!chipBox || Math.round(chipBox.height) !== 40) fail(`chip height ${chipBox?.height}, want 40`)
    console.log('OK chip size:', chipBox.width, 'x', chipBox.height)
    await shot(page, '01-workspace.png')

    // 3. Changes pane (needs a running workspace, auto-selected).
    const changesBtn = page.locator('button[title="Review changes"]')
    await changesBtn.waitFor({ timeout: 15000 }).catch(() => {})
    if (await changesBtn.count() === 0) {
      console.log('SKIP changes pane: no running session selected')
    } else {
      await changesBtn.click()
      // Either the empty state or the file list.
      await page.waitForSelector(
        'text=/No changes yet|file(s)? *$|diff truncated/',
        { timeout: 15000 },
      ).catch(async () => {
        const rows = await page.locator('[aria-expanded]').count()
        if (rows === 0) fail('changes pane rendered neither empty state nor file rows')
      })
      console.log('OK changes pane rendered')
      await shot(page, '02-changes-pane.png')
    }

    console.log('PASS')
  } finally {
    await browser.close()
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
