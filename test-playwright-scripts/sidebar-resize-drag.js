/*
 * Verifies the desktop sidebar's resize handle with a real mouse.
 *
 *  1. The handle sits in the gutter on the sidebar's right edge, full height.
 *  2. Dragging resizes the sidebar live and the pane gives up the same space;
 *     the width clamps at both bounds, survives a reload, and double-click
 *     restores the default.
 *  3. A portaled popup that spills over the handle (the plan-usage popover)
 *     stays on top of it: the overlap hit-tests to the popup, hovering there
 *     leaves the handle's hairline dark, and a press there neither resizes
 *     the sidebar nor closes the popup. The handle's z-10 is confined by two
 *     stacking contexts, the sidebar's `isolate` and the fixed `#root`; with
 *     both removed the handle takes the point back, which shows the hit test
 *     can fail.
 *
 * Needs a running server with a project whose sidebar shows the plan-usage
 * chit (any Claude credential, fake ones included).
 * Run: YAAC_DATA_DIR=<data dir> node test-playwright-scripts/sidebar-resize-drag.js
 */
import path from 'node:path'
import { requirePlaywright, origin, check, finish, SHOTS } from './lib.js'

// DEFAULT_SIDEBAR_WIDTH in packages/frontend/src/lib/store.ts.
const DEFAULT_WIDTH = 256

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))

const aside = page.locator('aside').first()
const handle = page.getByRole('separator', { name: 'Resize sidebar' })
const sidebarWidth = () => aside.evaluate((el) => el.getBoundingClientRect().width)
const paneLeft = () => aside.evaluate((el) => el.nextElementSibling.getBoundingClientRect().left)
const shot = (name) => page.screenshot({ path: path.join(SHOTS, `sidebar-resize-${name}.png`) })
const load = async () => {
  await aside.waitFor({ state: 'visible', timeout: 15_000 })
  await page.waitForTimeout(2000)
}
/** Press at (x, y) and move by dx in steps, so it reads as a real drag. */
const pressDrag = async (x, y, dx) => {
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(150)
}
const dragBy = async (dx) => {
  const box = await handle.boundingBox()
  await pressDrag(box.x + box.width / 2, box.y + box.height / 2, dx)
}

await page.goto(`${origin}/`)
await load()
const [min, max] = await handle.evaluate((el) => [Number(el.ariaValueMin), Number(el.ariaValueMax)])

// 1. Placement.
check('starts at the default width', await sidebarWidth() === DEFAULT_WIDTH, `${await sidebarWidth()}px`)
const geom = await handle.evaluate((el) => {
  const h = el.getBoundingClientRect(), a = el.closest('aside').getBoundingClientRect()
  return { hx: h.x, hw: h.width, hh: h.height, aRight: a.right, aHeight: a.height }
})
check('handle sits in the gutter, full height',
  geom.hx >= geom.aRight - 1 && geom.hw >= 6 && Math.abs(geom.hh - geom.aHeight) < 2, JSON.stringify(geom))

// 2. Dragging.
const paneBefore = await paneLeft()
await dragBy(120)
const wide = await sidebarWidth()
check('drag right widens the sidebar', Math.abs(wide - (DEFAULT_WIDTH + 120)) <= 2, `${wide}px`)
check('the pane gives up the same space', (await paneLeft()) - paneBefore >= 118)
await shot('wide')
await dragBy(-100)
check('drag left narrows it', Math.abs(await sidebarWidth() - (wide - 100)) <= 2, `${await sidebarWidth()}px`)
await dragBy(-900)
check('clamps at the floor', await sidebarWidth() === min, `${await sidebarWidth()}px`)
await dragBy(2000)
check('clamps at the ceiling', await sidebarWidth() === max, `${await sidebarWidth()}px`)
await dragBy(-260)
const dragged = await sidebarWidth()
await page.reload()
await load()
check('the width survives a reload', await sidebarWidth() === dragged, `${dragged}px`)
await handle.dblclick()
await page.waitForTimeout(150)
check('double-click restores the default', await sidebarWidth() === DEFAULT_WIDTH, `${await sidebarWidth()}px`)
check('no resize class left on <body>', !(await page.evaluate(() => document.body.classList.contains('col-resizing'))))

// 3. A popup over the handle.
await page.getByLabel('Show plan usage').click()
const popup = page.getByRole('dialog').first()
await popup.waitFor({ state: 'visible', timeout: 10_000 })
await page.waitForTimeout(250)
const strip = await handle.boundingBox()
const pop = await popup.boundingBox()
const overlapX = Math.min(strip.x + strip.width, pop.x + pop.width) - Math.max(strip.x, pop.x)
const overlapY = Math.min(strip.y + strip.height, pop.y + pop.height) - Math.max(strip.y, pop.y)
check('the popup overlaps the handle', overlapX > 0 && overlapY > 0, `${overlapX}x${overlapY}px`)
const px = Math.max(strip.x, pop.x) + Math.min(overlapX, 8) / 2
const py = pop.y + 20
const hit = ([x, y]) => {
  const el = document.elementFromPoint(x, y)
  return { inPopup: !!el?.closest('[role="dialog"]'), inHandle: !!el?.closest('[aria-label="Resize sidebar"]') }
}
const topmost = await page.evaluate(hit, [px, py])
check('the popup hit-tests above the handle', topmost.inPopup && !topmost.inHandle, JSON.stringify(topmost))
check('the sidebar wrapper is a stacking context',
  await aside.evaluate((el) => getComputedStyle(el).isolation) === 'isolate')
// The hairline is the handle's only hover feedback.
await page.mouse.move(px, py)
await page.waitForTimeout(150)
const hairline = await handle.evaluate((el) => getComputedStyle(el.firstElementChild).backgroundColor)
check('hovering the popup leaves the handle hairline dark',
  hairline === 'rgba(0, 0, 0, 0)' || hairline === 'transparent', hairline)
await shot('popup')
await pressDrag(px, py, 60)
check('a press over the popup does not resize the sidebar', await sidebarWidth() === DEFAULT_WIDTH)
check('the popup is still open', await popup.isVisible())
await page.addStyleTag({ content: 'aside { isolation: auto !important } #root { position: relative !important }' })
await page.waitForTimeout(100)
const unconfined = await page.evaluate(hit, [px, py])
check('without either stacking context the handle takes the point back', unconfined.inHandle,
  JSON.stringify(unconfined))

await browser.close()
finish()
