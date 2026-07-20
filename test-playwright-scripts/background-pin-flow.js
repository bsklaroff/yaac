/*
 * Verifies the sidebar "Background" pinned-session flow end-to-end against a
 * running yaac server with at least one active session:
 *   1. pin the session via the row's pin button -> a "Background" section
 *      appears below Running holding the row;
 *   2. unpin via the same toggle -> the row returns to its status group and
 *      the Background section disappears;
 *   3. pin again, delete the session -> the row stays in Background through
 *      terminating and then renders as a deleted placeholder with a restart
 *      action (and the "Deleted sessions" entry point still lists it);
 *   4. restart from the sidebar -> a provisioning row replaces it and the
 *      revived session lands back in Background (the pin survived).
 * Screenshots land in /tmp/yaac-shots/bg-*.png.
 *
 * Run: node test-playwright-scripts/background-pin-flow.js
 * Needs a running server (pnpm watch / yaac server start) and one active
 * session (yaac session create yaac). The session is deleted and restarted
 * by the script; it is left running (pinned) at the end.
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
  // The Collapsible.Panel following a section's trigger — resolves rows by
  // walking up from the trigger to the Collapsible.Root.
  const sectionRows = (label) =>
    sidebar().locator(`xpath=//button[.//span[text()="${label}"]]/following-sibling::div`)

  const token = await mintToken(lock)
  await page.goto(`http://127.0.0.1:${lock.port}/?token=${token}`)
  await page.waitForFunction(() => !window.location.search.includes('token='), { timeout: 15_000 })
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
  // Terminating placeholder stays inside Background.
  await sectionRows('Background').locator('text=terminating…').waitFor({ state: 'visible', timeout: 15_000 })
  await shot('bg-4-terminating')
  console.log('DELETE: terminating placeholder stays in Background')

  // Once the container is gone the row becomes a deleted placeholder with a
  // restart action. Teardown can take a while.
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
  // The revived session must land back in Background (the pin survived the
  // delete + restart). Provisioning + container boot can take minutes.
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
