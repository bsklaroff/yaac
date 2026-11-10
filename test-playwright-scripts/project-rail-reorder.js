/*
 * Verifies drag-to-reorder on the project rail in real Chromium:
 *
 *  1. A real mouse drag of the last project chip to above the first moves
 *     it to the top of the rail, with a drop line shown mid-drag.
 *  2. The server saves that order (`GET /api/project/list` answers it).
 *  3. The order survives a reload.
 *
 * Needs a server whose user has at least three projects (`yaac project
 * create <name>` makes hosted ones). Puts the original order back at the
 * end.
 *
 * Run: SCREENSHOT_DIR=/tmp/rail-shots node test-playwright-scripts/project-rail-reorder.js
 */
import path from 'node:path'
import { SHOTS, api, check, finish, origin, requirePlaywright, until } from './lib.js'

const before = await api('/project/list')
if (before.length < 3) throw new Error('needs at least three projects')
const names = before.map((p) => p.name)

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })

/** The rail's chips, top to bottom, by project name. */
const railOrder = (all) => [...document.querySelectorAll('button[title]')]
  .map((b) => b.title).filter((t) => all.includes(t))

try {
  await page.goto(origin)
  await until(page, (all) => all.every((n) => document.querySelector(`button[title="${n}"]`)), names)
  check('rail starts in server order', JSON.stringify(await page.evaluate(railOrder, names)) === JSON.stringify(names))

  const first = await page.locator(`button[title="${names[0]}"]`).boundingBox()
  const last = await page.locator(`button[title="${names.at(-1)}"]`).boundingBox()
  await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2)
  await page.mouse.down()
  await page.mouse.move(first.x + first.width / 2, first.y + 8, { steps: 10 })
  await page.screenshot({ path: path.join(SHOTS, 'rail-mid-drag.png') })
  check('drop line shows above the first chip', await page.evaluate(
    (n) => document.querySelector(`button[title="${n}"] > .bg-accent`) !== null, names[0]))
  await page.mouse.up()

  const want = [names.at(-1), ...names.slice(0, -1)]
  await until(page, (w) => JSON.stringify([...document.querySelectorAll('button[title]')]
    .map((b) => b.title).filter((t) => w.includes(t))) === JSON.stringify(w), want, 5_000)
  check('dragged chip moves to the top', true)
  const saved = (await api('/project/list')).map((p) => p.name)
  check('server saves the order', JSON.stringify(saved) === JSON.stringify(want), saved.join(','))

  await page.reload()
  await until(page, (all) => all.every((n) => document.querySelector(`button[title="${n}"]`)), names)
  const reloaded = await page.evaluate(railOrder, names)
  check('order survives a reload', JSON.stringify(reloaded) === JSON.stringify(want), reloaded.join(','))
  await page.screenshot({ path: path.join(SHOTS, 'rail-after-reload.png') })
} finally {
  await api('/project/order', { method: 'PUT', body: { projectIds: before.map((p) => p.id) } })
  await browser.close()
}
finish()
