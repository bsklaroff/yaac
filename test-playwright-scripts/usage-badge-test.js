/*
 * Verifies the sidebar plan-usage readout (UsageBadge): with a Claude OAuth
 * (subscription) credential stored, the sidebar header shows a small pill
 * with the tightest limit's utilization percent; clicking it opens a popover
 * titled "Plan usage" with the plan tier and one row per limit — the 5h
 * session window, the weekly all-models window, and any per-model weekly
 * window — each with a percent, a progress bar, and a reset line (countdown
 * inside 24h, local day + time beyond it). The pill percent must equal the
 * max percent across rows. Clicking a row pins that metric to the pill
 * (compact tag + its percent, aria-pressed on the row), clicking another
 * switches the pin, re-clicking unpins, and a pin survives a page reload.
 * Opening the popover also POSTs a background refresh nudge, which the
 * daemon throttles to at most one upstream refresh per minute.
 *
 * Drives the running yaac daemon's webapp in real Chromium. The usage data
 * rides the daemon-pushed /events snapshot: the daemon refreshes it from
 * api.anthropic.com (at most every 5min, only while a webapp client is
 * connected) and the badge just renders the pushed value — so this needs
 * OAuth (not api-key) Claude credentials, and the badge can take a few
 * seconds after page load (first refresh + next 5s snapshot tick).
 *
 * Run: node test-playwright-scripts/usage-badge-test.js
 * (set SCREENSHOT_DIR to capture closed/open screenshots there)
 * Needs a running daemon (`yaac daemon start`); reads the port/secret from
 * $YAAC_DATA_DIR/.daemon.lock (or ~/.yaac). (playwright is resolved from
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

function readDaemonLock() {
  const candidates = [
    process.env.YAAC_DATA_DIR && path.join(process.env.YAAC_DATA_DIR, '.daemon.lock'),
    path.join(os.homedir(), '.yaac', '.daemon.lock'),
  ].filter(Boolean)
  for (const p of candidates) {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'))
  }
  throw new Error(`no .daemon.lock found (tried ${candidates.join(', ')}) — is the daemon running?`)
}

let failures = 0
function check(name, cond, detail = '') {
  const mark = cond ? 'PASS' : 'FAIL'
  if (!cond) failures++
  console.log(`${mark}  ${name}${detail ? `  [${detail}]` : ''}`)
}

async function main() {
  const { chromium } = requirePlaywright()
  const lock = readDaemonLock()
  const base = `http://127.0.0.1:${lock.port}`
  const auth = { authorization: `Bearer ${lock.secret}` }

  // Precondition: only an OAuth (subscription) credential produces a badge —
  // with api-key auth it is correctly hidden and there is nothing to drive.
  const dataDir = process.env.YAAC_DATA_DIR || path.join(os.homedir(), '.yaac')
  const credsPath = path.join(dataDir, '.credentials', 'claude.json')
  const credsKind = fs.existsSync(credsPath)
    ? JSON.parse(fs.readFileSync(credsPath, 'utf8')).kind
    : 'missing'
  check('stored Claude credential is OAuth', credsKind === 'oauth', `kind=${credsKind}`)
  if (credsKind !== 'oauth') process.exit(1)

  // The popover-open nudge endpoint (fire-and-forget on the client; data
  // arrives via the snapshot, so a 204 is all there is to see here).
  const refreshRes = await fetch(`${base}/auth/claude/usage/refresh`, { method: 'POST', headers: auth })
  check('usage-refresh nudge endpoint answers 204', refreshRes.status === 204, `HTTP ${refreshRes.status}`)

  const codeRes = await fetch(`${base}/auth/bootstrap-code`, { headers: auth })
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
    // No \b anchors: textContent concatenates the spans with no whitespace,
    // so the tier rides between other words ("Plan usageMax (20x) planCurrent…").
    check('popover names the plan tier', /(Max|Pro|Team|Enterprise)( \(\d+x\))? plan/.test(popupText), popupText.slice(0, 60))
    // A Max account must show its usage multiplier (from the org's
    // rate_limit_tier on the OAuth profile endpoint).
    if (/Max/.test(popupText)) {
      check('the Max tier shows its usage multiplier', /Max \(\d+x\) plan/.test(popupText), popupText.slice(0, 60))
    }
    check('popover lists the 5h session window', popupText.includes('Current session (5h)'))
    check('popover lists the weekly all-models window', popupText.includes('Weekly — all models'))

    // At minimum the session and weekly-all windows; per-model rows vary.
    const rows = popup.locator('li')
    const rowCount = await rows.count()
    check('at least the session and weekly rows are present', rowCount >= 2, `${rowCount} rows`)

    // Countdown inside 24h ("resets in 3h 47m"), day + time beyond it
    // ("resets Tue 22:00").
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
    // Weekly windows reset in >24h, so at least one row must use the
    // absolute day + time form.
    const popupNow = await popup.textContent()
    check('a >24h reset uses the day + time form',
      /(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{2}:\d{2}/.test(popupNow), popupNow.slice(-60))

    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'usage-badge-open.png') })

    // ── Pinning ────────────────────────────────────────────────────────
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

    // The pin persists across a reload (localStorage).
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
