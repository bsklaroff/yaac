/*
 * Verifies the Settings → Schedules section end-to-end against a running
 * server: opens the settings dialog, switches to the Schedules section,
 * adds a cron schedule through the form (spec + prompt + explicit tool),
 * asserts the row renders (spec, tool label, "Never fired"), then removes
 * it through the ConfirmDialog and asserts the empty state returns. The
 * schedule's spec (midnight Jan 1) is always far enough away that nothing
 * fires during the test; cleanup happens through the UI itself.
 *
 * Run: node test-playwright-scripts/schedule-settings-test.js
 * Needs a running server (`yaac server start`) with at least one project.
 * Reads port/secret from $YAAC_DATA_DIR/.server.lock (or ~/.yaac).
 * Screenshots go to /tmp/yaac-shots/. (playwright resolved from the global
 * npm root; browsers under /opt/playwright-browsers)
 */
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
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
    const globalRoot = execFileSync('npm', ['root', '-g']).toString().trim()
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

async function mintToken(lock) {
  const res = await fetch(`http://127.0.0.1:${lock.port}/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${lock.secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'one-time' }),
  })
  if (res.status !== 201) throw new Error(`token mint failed: HTTP ${res.status} ${await res.text()}`)
  return (await res.json()).token
}

let failures = 0
function check(name, cond, detail = '') {
  const mark = cond ? 'PASS' : 'FAIL'
  if (!cond) failures++
  console.log(`${mark}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const SHOT_DIR = '/tmp/yaac-shots'
fs.mkdirSync(SHOT_DIR, { recursive: true })

// Fires once a year, far enough from any test run to never actually fire.
const CRON = '0 0 1 1 *'
const PROMPT = 'playwright-schedule-test: never fire'

const lock = readServerLock()
const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await ctx.newPage()
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))

  const token = await mintToken(lock)
  await page.goto(`http://127.0.0.1:${lock.port}/?token=${token}`)
  await page.waitForFunction(() => !window.location.search.includes('token='), { timeout: 15_000 })

  await page.locator('[title="Settings"]').first().click({ timeout: 15_000 })
  await page.locator('button', { hasText: 'Schedules' }).first().click({ timeout: 15_000 })
  await page.locator('text=Add a schedule').waitFor({ state: 'visible', timeout: 15_000 })
  check('schedules section renders', true)
  check('empty state shown', await page.locator('text=No schedules yet.').isVisible())
  await page.screenshot({ path: path.join(SHOT_DIR, 'schedules-empty.png') })

  await page.locator('[aria-label="Cron expression"]').fill(CRON)
  await page.locator('[aria-label="Initial prompt"]').fill(PROMPT)
  await page.locator('[aria-label="Agent tool"]').selectOption('codex')
  await page.locator('button', { hasText: 'Add schedule' }).click()

  const row = page.locator('li', { hasText: PROMPT })
  await row.waitFor({ state: 'visible', timeout: 15_000 })
  check('added row shows the cron spec', (await row.textContent()).includes(CRON))
  check('added row shows the tool label', (await row.textContent()).includes('Codex'))
  check('added row shows never-fired', (await row.textContent()).includes('Never fired'))
  await page.screenshot({ path: path.join(SHOT_DIR, 'schedules-row.png') })

  await row.locator('button', { hasText: 'Remove' }).click()
  await page.locator('text=Remove schedule?').waitFor({ state: 'visible', timeout: 15_000 })
  // The ConfirmDialog's confirm button label is "Remove"; scope to the
  // dialog popup so we don't re-click the row button.
  await page.locator('[role="alertdialog"] button', { hasText: 'Remove' }).last().click()
  await page.locator('text=No schedules yet.').waitFor({ state: 'visible', timeout: 15_000 })
  check('row removed back to empty state', true)
  await page.screenshot({ path: path.join(SHOT_DIR, 'schedules-removed.png') })
} finally {
  await browser.close()
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1
