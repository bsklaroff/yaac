/*
 * Verifies drag-and-drop between columns in the tiles layout:
 *   1. from a fresh layout every terminal (the agent plus two shells) is its
 *      own equal-width column with one tab;
 *   2. dragging a shell tab onto the agent column's centre makes it a second
 *      tab there (one column fewer);
 *   3. dragging that tab out to the right edge makes it its own column again.
 * A column is a positioned <section>; its tabs are the non-empty button
 * labels in its header.
 *
 * Needs a server with a live workspace; it uses the first one listed, adds
 * two scratch shells to it and closes them at the end. Screenshots go to
 * $SCREENSHOT_DIR/dnd-*.png.
 *
 * Run: YAAC_DATA_DIR=~/.yaac node test-playwright-scripts/column-tabs-dnd-test.js
 */
import path from 'node:path'
import { requirePlaywright, origin, api, check, finish, SHOTS } from './lib.js'

const readColumns = (page) => page.evaluate(() => [...document.querySelectorAll('section[style]')]
  .map((s) => [...s.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean)))

/** Drag with real pointer moves, crossing the 5px drag threshold first. */
async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 12, from.y + 12, { steps: 4 })
  await page.mouse.move(to.x, to.y, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(600)
}
const centre = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })

const ws = (await api('/workspace/list')).workspaces.find((w) => w.status !== 'stopped')
if (!ws) throw new Error('no live workspace — create one with `yaac workspace create <project>`')
const shells = [await api(`/workspace/${ws.workspaceId}/terminals`, { method: 'POST' }),
  await api(`/workspace/${ws.workspaceId}/terminals`, { method: 'POST' })]

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await ctx.addInitScript(() => {
    localStorage.setItem('yaac.viewmode.v1', 'tiles')
    localStorage.removeItem('yaac.layouts.v2')
  })
  const page = await ctx.newPage()
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  await page.goto(`${origin}/?project=${ws.projectId}&workspace=${ws.workspaceId}`)
  await page.locator('section[style]').nth(2).waitFor({ state: 'visible', timeout: 15_000 })
  await page.waitForTimeout(2000)
  const shot = (n) => page.screenshot({ path: path.join(SHOTS, `dnd-${n}.png`) })

  const base = await readColumns(page)
  await shot('1-baseline')
  check('every terminal starts as its own one-tab column', base.length >= 3 && base.every((c) => c.length === 1),
    JSON.stringify(base))

  const agent = base[0][0]
  const shell = base.map((c) => c[0]).find((t) => t.startsWith('shell'))
  const tab = () => page.getByRole('button', { name: shell, exact: true }).first().boundingBox()
  const agentCol = await page.locator('section[style]').first().boundingBox()
  await drag(page, centre(await tab()), centre(agentCol))
  const merged = await readColumns(page)
  await shot('2-tabbed')
  check('dropping on the agent column centre adds a tab there',
    merged.length === base.length - 1 && merged.find((c) => c.includes(agent))?.includes(shell), JSON.stringify(merged))

  const area = await page.locator('.relative.isolate.min-h-0.flex-1').first().boundingBox()
  await drag(page, centre(await tab()), { x: area.x + area.width - 8, y: area.y + area.height / 2 })
  const split = await readColumns(page)
  await shot('3-split')
  check('dragging the tab to the right edge makes a column again',
    split.length === base.length && split.every((c) => c.length === 1), JSON.stringify(split))
} finally {
  await browser.close()
  for (const s of shells) {
    await api(`/workspace/${ws.workspaceId}/terminals/close`, { method: 'POST', body: { target: s.target } })
      .catch((e) => console.log(`  (could not close ${s.name}: ${e.message})`))
  }
}
finish()
