/*
 * Screenshots the component catalog (`/?catalog`) in both themes, one shot
 * per screenful, so each #ui component can be compared against the design's
 * component catalog. Also fails if the page logs an error.
 *
 * Needs a running server built from this checkout (`pnpm build`, then
 * `yaac server restart`).
 * Run: node test-playwright-scripts/catalog-screens.js
 * Shots: $SCREENSHOT_DIR (default /tmp/yaac-shots)/catalog-<theme>-<n>.png
 */
import path from 'node:path'
import { requirePlaywright, origin, check, finish, SHOTS } from './lib.js'

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.goto(`${origin}/?catalog`)
await page.getByRole('heading', { name: 'yaac components' }).waitFor()

for (const theme of ['Dark', 'Light']) {
  await page.getByRole('button', { name: theme, exact: true }).click()
  const scroller = page.locator('#root [data-theme]').first()
  const height = await scroller.evaluate((el) => el.scrollHeight)
  let n = 0
  for (let y = 0; y < height; y += 900, n++) {
    await scroller.evaluate((el, top) => { el.scrollTop = top }, y)
    await page.waitForTimeout(250)
    await page.screenshot({ path: path.join(SHOTS, `catalog-${theme.toLowerCase()}-${n}.png`) })
  }
  check(`${theme}: shot ${n} screens`, n > 0)
}
check('no page errors', errors.length === 0, errors.join('; '))
await browser.close()
finish()
