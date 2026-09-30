/*
 * Verifies the sidebar "Background" pinned-workspace flow against a running
 * yaac server with at least one running workspace:
 *   1. pinning a row moves it into a "Background" section below Running;
 *   2. unpinning returns it to its status group and removes the section;
 *   3. pinned again and stopped, the row stays in Background while
 *      terminating, then shows as a "deleted" placeholder with a restart
 *      action (and is listed under "Deleted sessions");
 *   4. restarting from the sidebar shows a provisioning row, and the
 *      workspace comes back in Background.
 * Screenshots land in /tmp/yaac-shots/bg-*.png.
 *
 * Run: node test-playwright-scripts/background-pin-flow.js
 * Needs a running server (`pnpm watch` or `yaac server start`) and one
 * running workspace (`yaac workspace create <project>`). The script stops
 * and restarts it, leaving it running and pinned.
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

const SHOT_DIR = '/tmp/yaac-shots'

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const lock = readServerLock()
  const { chromium } = requirePlaywright()
  const browser = await chromium.launch()
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))

  const shot = async (name) => {
    await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) })
    console.log(`  screenshot -> ${SHOT_DIR}/${name}.png`)
  }
  const sidebar = () => page.locator('aside')
  const sectionHeader = (label) => sidebar().locator('button', { hasText: label }).first()
  // A section's rows, found by walking up from its trigger to the
  // Collapsible.Root.
  const sectionRows = (label) =>
    sidebar().locator(`xpath=//button[.//span[text()="${label}"]]/following-sibling::div`)

  await page.goto(`http://127.0.0.1:${lock.port}/`)
  await sidebar().waitFor({ state: 'visible', timeout: 15_000 })
  await page.waitForTimeout(3000) // let the pushed /events snapshot land

  // --- 1. pin ---------------------------------------------------------------
  const pinButton = page.locator('[aria-label="Move to background"]').first()
  const row = page.locator('div.group', { has: pinButton })
  await row.waitFor({ state: 'attached', timeout: 15_000 })
  await row.hover()
  await shot('bg-1-before-pin')
  if (await sectionHeader('Background').count() > 0 && await sectionHeader('Background').isVisible()) {
    throw new Error('Background section already visible before pinning')
  }
  await pinButton.click()
  await sectionHeader('Background').waitFor({ state: 'visible', timeout: 10_000 })
  await sectionRows('Background').locator('div.group').first().waitFor({ state: 'visible', timeout: 10_000 })
  await shot('bg-2-pinned')
  console.log('PIN: session moved to a Background section')

  // --- 2. unpin -------------------------------------------------------------
  const unpinButton = page.locator('[aria-label="Remove from background"]').first()
  await sectionRows('Background').locator('div.group').first().hover()
  await unpinButton.click()
  await sectionHeader('Background').waitFor({ state: 'hidden', timeout: 10_000 })
  await shot('bg-3-unpinned')
  console.log('UNPIN: Background section gone, row back in its status group')

  // --- 3. pin again, delete -------------------------------------------------
  await row.hover()
  await page.locator('[aria-label="Move to background"]').first().click()
  await sectionHeader('Background').waitFor({ state: 'visible', timeout: 10_000 })
  await sectionRows('Background').locator('div.group').first().hover()
  await page.locator('[aria-label="Delete session"]').first().click()
  await page.locator('button', { hasText: 'Delete' }).last().click()
  // The terminating row stays in Background.
  await sectionRows('Background').locator('text=terminating…').waitFor({ state: 'visible', timeout: 15_000 })
  await shot('bg-4-terminating')
  console.log('DELETE: terminating placeholder stays in Background')

  // Once teardown finishes (can be slow) the row gets a restart action.
  const restartButton = page.locator('[aria-label="Restart session"]').first()
  await restartButton.waitFor({ state: 'attached', timeout: 120_000 })
  await sectionRows('Background').locator('text=deleted').first().waitFor({ state: 'visible', timeout: 15_000 })
  await sectionRows('Background').locator('div.group').first().hover()
  await shot('bg-5-deleted-pinned')
  if (!await page.locator('text=Deleted sessions').first().isVisible()) {
    throw new Error('deleted pinned session missing from the "Deleted sessions" entry point')
  }
  console.log('DELETED: pinned session kept a Background row (and lists under Deleted sessions)')

  // --- 4. restart from the sidebar -------------------------------------------
  await restartButton.click()
  await page.locator('button', { hasText: 'Restart' }).last().click()
  await page.locator('text=Restarting session').first().waitFor({ state: 'visible', timeout: 15_000 })
  await shot('bg-6-restarting')
  // The pin survives the restart, which can take minutes.
  await sectionRows('Background').locator('div.group', { hasText: 'ago' }).first()
    .waitFor({ state: 'visible', timeout: 300_000 })
  await shot('bg-7-restarted-still-pinned')
  console.log('RESTART: session revived from the sidebar and still pinned in Background')

  await browser.close()
  console.log('background-pin-flow: ALL STEPS PASSED')
}

main().catch((err) => {
  console.error(`background-pin-flow FAILED: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
