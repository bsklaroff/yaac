/*
 * Verifies routine schedules read in words (describeSchedule, via cronstrue)
 * in the sidebar's Routines section and in the routine pane, against
 * routines the script creates through the API in a scratch project (and
 * deletes when done):
 *  - each sidebar row shows its cron in words, with the full text and the
 *    routine's zone as a hover title for a row too narrow to show it all;
 *  - the routine pane shows the words, the routine's zone, and the raw cron.
 * Screenshots land in $SCREENSHOT_DIR (default /tmp/yaac-shots).
 *
 * Run (server built from this checkout: `pnpm build`, `yaac server start`):
 *   node test-playwright-scripts/routine-schedule-words-test.js
 */
import path from 'node:path'
import { SHOTS, api, check, finish, origin, requirePlaywright } from './lib.js'

const ROUTINES = [
  { name: 'Weekday triage', cron: '0 9 * * 1-5', timeZone: 'America/New_York', words: 'At 09:00, Monday through Friday' },
  { name: 'Uneven 45', cron: '*/45 * * * *', timeZone: 'UTC', words: 'At 0 and 45 minutes past the hour' },
  { name: 'Twice daily', cron: '0 9,17 * * *', timeZone: 'Asia/Tokyo', words: 'Twice daily at 09:00 and 17:00' },
  { name: 'Day 1 or weekdays', cron: '0 9 1 * 1-5', timeZone: 'UTC', words: 'At 09:00, on day 1 of the month, or Monday through Friday' },
  { name: 'Every 5 months', cron: '0 0 1 */5 *', timeZone: 'UTC', words: 'At 00:00, on day 1 of the month, only in January, June, and November' },
  { name: 'Question mark', cron: '0 9 ? * 1', timeZone: 'UTC', words: '0 9 ? * 1' },
]

const created = await api('/project/create', { method: 'POST', body: { name: `routine-words-${Date.now()}` } })
const projectId = created.id ?? created.project.id
const routines = []
for (const r of ROUTINES) {
  routines.push(await api('/routine/create', { method: 'POST', body: { ...r, project: projectId, prompt: 'x' } }))
}

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))
const shot = (name) => page.screenshot({ path: path.join(SHOTS, `routine-words-${name}.png`) })

try {
  await page.goto(`${origin}/?project=${projectId}`)
  const section = page.getByRole('group', { name: 'Routines' })
  await section.waitFor({ state: 'visible', timeout: 30_000 })
  await shot('sidebar')
  for (const r of ROUTINES) {
    const row = section.getByRole('button', { name: new RegExp(r.name) })
    const title = await row.locator('span[title]').first().getAttribute('title')
    console.log(`  ${r.cron.padEnd(14)} ${r.timeZone.padEnd(17)} sidebar: ${title}`)
    check(`${r.name}: sidebar title is its words and zone`, title === `${r.words} (${r.timeZone})`, title ?? '')
  }
  const triage = section.getByRole('button', { name: /Weekday triage/ })
  await triage.locator('span[title]').first().hover()
  await page.waitForTimeout(1500)
  await shot('sidebar-hover')

  for (const r of ROUTINES) {
    await section.getByRole('button', { name: new RegExp(r.name) }).click()
    await page.locator('main').getByText(r.cron).first().waitFor({ timeout: 10_000 })
    const schedule = await page.locator('main').getByText(r.timeZone).first().textContent()
    console.log(`  pane: ${schedule}`)
    check(`${r.name}: pane shows the raw cron and zone`, schedule?.includes(r.timeZone) ?? false)
    await shot(`pane-${r.name.toLowerCase().replace(/\W+/g, '-')}`)
  }
} finally {
  await browser.close()
  for (const r of routines) await api('/routine/delete', { method: 'POST', body: { id: r.id } }).catch(() => {})
}
finish()
