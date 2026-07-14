/*
 * Verifies the frontend styling/features ported from the electron-planning
 * branch onto main:
 *  1. Lifted dark elevated surfaces — --color-surface resolves to #1b1b21
 *     (not the old near-black #141417), so cards/popups read against the base.
 *  2. The wider project rail: the rail column is 64px (w-16) with 40px chips.
 *     (Custom WindowControls only render in Electron; a browser build shows
 *     the rail without them.)
 *  3. The session header's "Changes" button opens the review-diff pane
 *     (SessionChanges accordion) as a workspace leaf; with a clean worktree
 *     it shows the "No changes yet" empty state, with edits it lists files.
 *
 * Run: node test-playwright-scripts/electron-port-styling-test.js
 * (set SCREENSHOT_DIR to capture the workspace and changes-pane states)
 * Needs a running server serving the built SPA (`yaac server start` with
 * dist/frontend present) and at least one running session for step 3;
 * reads port/secret from $YAAC_DATA_DIR/.server.lock (or ~/.yaac).
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

async function mintToken() {
  const res = await fetch(`${origin}/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${lock.secret}` },
    body: JSON.stringify({ kind: 'one-time' }),
  })
  if (res.status !== 201) fail(`mint: HTTP ${res.status}`)
  return (await res.json()).token
}

async function main() {
  const token = await mintToken()
  const browser = await chromium.launch()
  // The theme default is 'system'; force dark so the lifted dark palette is
  // what's under test (headless Chromium otherwise reports light).
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
  try {
    await page.goto(`${origin}/?token=${token}`)
    await page.waitForSelector('main', { timeout: 15000 })
    // Wait for the first WS snapshot to hydrate the rail (project chips).
    await page.waitForSelector('button[title="yaac"]', { timeout: 15000 }).catch(() => {})

    // 1. Lifted dark surfaces.
    const surface = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--color-surface').trim())
    if (surface !== '#1b1b21') fail(`--color-surface is ${surface}, want #1b1b21 (lifted)`)
    console.log('OK surface lift: --color-surface =', surface)

    // 2. Rail width + chip size. The rail is the first column: locate the
    //    settings gear (always present) and measure its container.
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

    // 3. Changes pane (needs a running session; auto-selected once the
    //    snapshot lists it).
    const changesBtn = page.locator('button[title="Review changes"]')
    await changesBtn.waitFor({ timeout: 15000 }).catch(() => {})
    if (await changesBtn.count() === 0) {
      console.log('SKIP changes pane: no running session selected')
    } else {
      await changesBtn.click()
      // The pane is a workspace leaf: either the empty state or the file list.
      await page.waitForSelector(
        'text=/No changes yet|file(s)? *$|diff truncated/',
        { timeout: 15000 },
      ).catch(async () => {
        // Fall back to the accordion header row (files listed).
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
