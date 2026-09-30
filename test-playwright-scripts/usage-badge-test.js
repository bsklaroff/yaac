/*
 * Verifies the sidebar plan-usage badge (UsageBadge) in Chromium against the
 * live upstream usage feed, which the unit tests stub. With a Claude OAuth
 * (subscription) credential stored:
 *  - the sidebar header shows a pill with the tightest limit's percent;
 *  - clicking it opens a "Plan usage" popover with the plan tier and one row
 *    per limit (5h session, weekly all-models, any per-model weekly), each
 *    with a percent, a progress bar and a reset time (countdown within 24h,
 *    day + time beyond);
 *  - the pill percent equals the max across rows;
 *  - clicking a row pins that metric to the pill, clicking another switches
 *    the pin, clicking again unpins, and a pin survives a reload;
 *  - the refresh nudge the popover sends answers 204.
 *
 * Usage arrives in the /events snapshot. The server refreshes it from
 * api.anthropic.com at most every 5 min, and only while a webapp client is
 * connected, so the badge may take a few seconds to appear. An api-key
 * Claude credential shows no badge.
 *
 * Run: YAAC_DATA_DIR=... node test-playwright-scripts/usage-badge-test.js
 */
import path from 'node:path'
import { SHOTS, check, finish, origin, requirePlaywright } from './lib.js'

const refresh = await fetch(`${origin}/api/auth/claude/usage/refresh`, { method: 'POST' })
check('usage-refresh nudge endpoint answers 204', refresh.status === 204, `HTTP ${refresh.status}`)

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))
const shot = (name) => page.screenshot({ path: path.join(SHOTS, `usage-badge-${name}.png`) })
const text = async (loc) => (await loc.textContent()).trim()

try {
  await page.goto(`${origin}/`)
  const pill = page.getByRole('button', { name: 'Show plan usage' })
  await pill.waitFor({ state: 'visible', timeout: 30_000 })
  const pillText = await text(pill)
  check('pill shows a utilization percent', /^\d+%$/.test(pillText), pillText)

  await pill.click()
  const popup = page.getByRole('dialog').filter({ hasText: 'Plan usage' })
  await popup.waitFor({ state: 'visible', timeout: 5_000 })
  const popupText = await popup.textContent()
  // No \b anchors: textContent joins spans without whitespace.
  check('popover names the plan tier', /(Max|Pro|Team|Enterprise)( \(\d+x\))?/.test(popupText), popupText.slice(0, 60))
  check('popover lists the 5h session window', popupText.includes('Current session (5h)'))
  check('popover lists the weekly all-models window', popupText.includes('Weekly — all models'))

  const rows = popup.locator('li')
  const rowCount = await rows.count()
  const percents = []
  for (let i = 0; i < rowCount; i++) {
    const row = await rows.nth(i).textContent()
    const m = row.match(/(\d+)%/)
    // "resets in 3h 47m" within 24h, "resets Tue 22:00" beyond.
    check(`row ${i + 1} shows a percent and a reset time`,
      m !== null && /resets (in \d|(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{2}:\d{2})/.test(row), row.slice(0, 60))
    if (m) percents.push(Number(m[1]))
    check(`row ${i + 1} renders a progress bar`, await rows.nth(i).locator('span[style*="width"]').count() === 1)
  }
  const max = `${Math.max(...percents)}%`
  check('pill percent is the max across rows', pillText === max, `${pillText} vs rows ${percents.join(',')}`)
  await shot('open')

  await popup.getByRole('button', { name: 'Pin Claude Current session (5h)' }).click()
  check('pinning the session window retags the pill', await text(pill) === `5h${percents[0]}%`, await text(pill))
  check('the pinned row flags itself pressed',
    await popup.getByRole('button', { name: 'Unpin Claude Current session (5h)' }).getAttribute('aria-pressed') === 'true')

  await popup.getByRole('button', { name: 'Pin Claude Weekly — all models' }).click()
  check('pinning another metric switches the pill', await text(pill) === `wk${percents[1]}%`, await text(pill))
  await shot('pinned')

  await page.reload()
  await pill.waitFor({ state: 'visible', timeout: 30_000 })
  check('the pin survives a reload', (await text(pill)).startsWith('wk'), await text(pill))

  await pill.click()
  await popup.getByRole('button', { name: 'Unpin Claude Weekly — all models' }).click()
  check('unpinning restores the tightest-limit readout', await text(pill) === max, await text(pill))
} finally {
  await browser.close()
}
finish()
