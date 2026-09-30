/*
 * Verifies the sidebar plan-usage badge (UsageBadge) in Chromium against the
 * running server. With a Claude OAuth (subscription) credential stored:
 *  - the sidebar header shows a pill with the tightest limit's percent;
 *  - clicking it opens a "Plan usage" popover with the plan tier and one row
 *    per limit (5h session, weekly all-models, any per-model weekly), each
 *    with a percent, a progress bar and a reset time (countdown within 24h,
 *    day + time beyond);
 *  - the pill percent equals the max across rows;
 *  - clicking a row pins that metric to the pill, clicking another switches
 *    the pin, clicking again unpins, and a pin survives a reload;
 *  - opening the popover POSTs a refresh nudge (throttled server-side in
 *    packages/server/src/domain/auth/plan-usage.ts).
 *
 * Usage data arrives in the /events snapshot. The server refreshes it from
 * api.anthropic.com at most every 5 min, and only while a webapp client is
 * connected, so the badge may take a few seconds to appear. Requires OAuth,
 * not api-key, Claude credentials.
 *
 * Run: node test-playwright-scripts/usage-badge-test.js
 * (set SCREENSHOT_DIR to capture screenshots there)
 * Needs a running server (`yaac server start`); reads the port from
 * $YAAC_DATA_DIR/.server.lock (or ~/.yaac).
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

async function main() {
  const { chromium } = requirePlaywright()
  const lock = readServerLock()
  const base = `http://127.0.0.1:${lock.port}`

  // Only an OAuth credential produces a badge; api-key auth hides it.
  const dataDir = process.env.YAAC_DATA_DIR || path.join(os.homedir(), '.yaac')
  const credsPath = path.join(dataDir, '.credentials', 'claude.json')
  const credsKind = fs.existsSync(credsPath)
    ? JSON.parse(fs.readFileSync(credsPath, 'utf8')).kind
    : 'missing'
  check('stored Claude credential is OAuth', credsKind === 'oauth', `kind=${credsKind}`)
  if (credsKind !== 'oauth') process.exit(1)

  // The nudge returns 204; the data itself arrives via the snapshot.
  const refreshRes = await fetch(`${base}/api/auth/claude/usage/refresh`, { method: 'POST' })
  check('usage-refresh nudge endpoint answers 204', refreshRes.status === 204, `HTTP ${refreshRes.status}`)

  const codeRes = await fetch(`${base}/api/auth/bootstrap-code`)
  if (!codeRes.ok) throw new Error(`bootstrap-code failed: HTTP ${codeRes.status}`)
  const { code } = await codeRes.json()

  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, bypassCSP: true })
  page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))

  const shotDir = process.env.SCREENSHOT_DIR
  try {
    await page.goto(`${base}/?bootstrap=${code}`)

    const pill = page.getByRole('button', { name: 'Show plan usage' })
    await pill.waitFor({ state: 'visible', timeout: 15_000 })
    const pillText = (await pill.textContent()).trim()
    check('pill shows a utilization percent', /^\d+%$/.test(pillText), pillText)
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'usage-badge-closed.png') })

    await pill.click()
    const popup = page.locator('[role="dialog"], [data-popup]').filter({ hasText: 'Plan usage' }).first()
    await popup.waitFor({ state: 'visible', timeout: 5_000 })

    const popupText = await popup.textContent()
    // No \b anchors: textContent joins spans without whitespace
    // ("Plan usageMax (20x) planCurrent…").
    check('popover names the plan tier', /(Max|Pro|Team|Enterprise)( \(\d+x\))? plan/.test(popupText), popupText.slice(0, 60))
    // The multiplier comes from the org's rate_limit_tier on the OAuth
    // profile endpoint.
    if (/Max/.test(popupText)) {
      check('the Max tier shows its usage multiplier', /Max \(\d+x\) plan/.test(popupText), popupText.slice(0, 60))
    }
    check('popover lists the 5h session window', popupText.includes('Current session (5h)'))
    check('popover lists the weekly all-models window', popupText.includes('Weekly — all models'))

    const rows = popup.locator('li')
    const rowCount = await rows.count()
    check('at least the session and weekly rows are present', rowCount >= 2, `${rowCount} rows`)

    // "resets in 3h 47m" within 24h, "resets Tue 22:00" beyond.
    const resetRe = /resets (in \d|(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{2}:\d{2})/
    const percents = []
    for (let i = 0; i < rowCount; i++) {
      const text = await rows.nth(i).textContent()
      const m = text.match(/(\d+)%/)
      check(`row ${i + 1} shows a percent and a reset time`, m !== null && resetRe.test(text),
        text.slice(0, 60))
      if (m) percents.push(Number(m[1]))
      const bar = rows.nth(i).locator('span[style*="width"]')
      check(`row ${i + 1} renders a progress bar`, (await bar.count()) === 1)
    }
    check('pill percent is the max across rows',
      pillText === `${Math.max(...percents)}%`, `${pillText} vs rows ${percents.join(',')}`)
    // Weekly windows reset in >24h, so one row must use day + time.
    const popupNow = await popup.textContent()
    check('a >24h reset uses the day + time form',
      /(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{2}:\d{2}/.test(popupNow), popupNow.slice(-60))

    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'usage-badge-open.png') })

    // Pinning.
    const sessionPct = percents[0]
    await popup.getByRole('button', { name: 'Pin Current session (5h)' }).click()
    check('pinning the session window retags the pill',
      (await pill.textContent()).trim() === `5h${sessionPct}%`, await pill.textContent())
    check('the pinned row flags itself pressed',
      await popup.getByRole('button', { name: 'Unpin Current session (5h)' })
        .getAttribute('aria-pressed') === 'true')

    await popup.getByRole('button', { name: 'Pin Weekly — all models' }).click()
    check('pinning another metric switches the pill',
      (await pill.textContent()).trim() === `wk${percents[1]}%`, await pill.textContent())
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'usage-badge-pinned.png') })

    await page.reload()
    await pill.waitFor({ state: 'visible', timeout: 15_000 })
    check('the pin survives a reload',
      (await pill.textContent()).trim().startsWith('wk'), await pill.textContent())

    await pill.click()
    await popup.waitFor({ state: 'visible', timeout: 5_000 })
    await popup.getByRole('button', { name: 'Unpin Weekly — all models' }).click()
    check('unpinning restores the tightest-limit readout',
      (await pill.textContent()).trim() === `${Math.max(...percents)}%`, await pill.textContent())
  } finally {
    await browser.close()
  }

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
