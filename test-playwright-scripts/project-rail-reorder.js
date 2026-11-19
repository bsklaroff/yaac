/*
 * Verifies drag-to-reorder on the project rail in real Chromium:
 *
 *  1. A real mouse drag of the last project tile to above the first moves
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

/* A rail tile is a button in the Projects nav, named by its project. */
const TILE = 'nav[aria-label="Projects"] button[aria-label]'
const tile = (name) => page.locator(`nav[aria-label="Projects"] button[aria-label="${name}"]`)

/** The rail's tiles, top to bottom, by project name. */
const railOrder = ({ all, sel }) => [...document.querySelectorAll(sel)]
  .map((b) => b.getAttribute('aria-label')).filter((t) => all.includes(t))
const allShown = ({ all, sel }) => all.every((n) => [...document.querySelectorAll(sel)].some((b) => b.getAttribute('aria-label') === n))

try {
  await page.goto(origin)
  await until(page, allShown, { all: names, sel: TILE })
  check('rail starts in server order', JSON.stringify(await page.evaluate(railOrder, { all: names, sel: TILE })) === JSON.stringify(names))

  const first = await tile(names[0]).boundingBox()
  const last = await tile(names.at(-1)).boundingBox()
  await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2)
  await page.mouse.down()
  await page.mouse.move(first.x + first.width / 2, first.y + 8, { steps: 10 })
  await page.screenshot({ path: path.join(SHOTS, 'rail-mid-drag.png') })
  check('drop line shows above the first tile', await page.evaluate(
    ({ n, sel }) => [...document.querySelectorAll(sel)].find((b) => b.getAttribute('aria-label') === n)
      ?.querySelector(':scope > .bg-accent') != null, { n: names[0], sel: TILE }))
  await page.mouse.up()

  const want = [names.at(-1), ...names.slice(0, -1)]
  await until(page, ({ w, sel }) => JSON.stringify([...document.querySelectorAll(sel)]
    .map((b) => b.getAttribute('aria-label')).filter((t) => w.includes(t))) === JSON.stringify(w), { w: want, sel: TILE }, 5_000)
  check('dragged tile moves to the top', true)
  const saved = (await api('/project/list')).map((p) => p.name)
  check('server saves the order', JSON.stringify(saved) === JSON.stringify(want), saved.join(','))

  await page.reload()
  await until(page, allShown, { all: names, sel: TILE })
  const reloaded = await page.evaluate(railOrder, { all: names, sel: TILE })
  check('order survives a reload', JSON.stringify(reloaded) === JSON.stringify(want), reloaded.join(','))
  await page.screenshot({ path: path.join(SHOTS, 'rail-after-reload.png') })
} finally {
  await api('/project/order', { method: 'PUT', body: { projectIds: before.map((p) => p.id) } })
  await browser.close()
}
finish()
