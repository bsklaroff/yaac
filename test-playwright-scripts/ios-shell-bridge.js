/*
 * Verifies the webapp's side of the iPhone app (ios/README.md) at a 390px
 * phone viewport: with the bridge the app injects (`window.yaacWindow`
 * holding only `showServers` and `openExternal`), the projects screen's
 * Servers row appears and calls `showServers`, and no window controls do.
 * Without the bridge, as in Safari, neither the Servers row nor the server
 * badge appears. Also checks that the page declares an apple-touch-icon
 * that loads, and that Settings → General shows no phone QR code on an http
 * origin. Screenshots go to $SCREENSHOT_DIR (default /tmp/yaac-shots).
 *
 * Needs a running server (see lib.js). Against `pnpm --filter @yaac/frontend
 * dev`, which serves the current source, run:
 *   APP_URL=http://localhost:1420 node test-playwright-scripts/ios-shell-bridge.js
 */
import { SHOTS, check, finish, origin, requirePlaywright } from './lib.js'

const { chromium } = requirePlaywright()
const viewport = { width: 390, height: 844 }

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport })
  await page.addInitScript(() => {
    window.bridgeCalls = []
    window.yaacWindow = {
      showServers: () => window.bridgeCalls.push('showServers'),
      openExternal: (url) => window.bridgeCalls.push(`openExternal ${url}`),
    }
  })
  await page.goto(origin)
  const servers = page.getByRole('button', { name: 'Servers', exact: true })
  await servers.waitFor({ timeout: 20_000 })
  check('bridge: Servers button shows', await servers.isVisible())
  check('bridge: no window controls', await page.getByRole('button', { name: 'Close window' }).count() === 0)
  await page.screenshot({ path: `${SHOTS}/ios-shell-projects.png` })
  await servers.click()
  check('bridge: Servers button calls showServers', (await page.evaluate(() => window.bridgeCalls)).includes('showServers'))

  const icon = await page.evaluate(async () => {
    const href = document.querySelector('link[rel="apple-touch-icon"]')?.href
    if (!href) return null
    const res = await fetch(href)
    return { ok: res.ok, type: res.headers.get('content-type') }
  })
  check('apple-touch-icon loads as a png', icon?.ok === true && icon.type?.startsWith('image/png'))
  check('home-screen web app meta', await page.locator('meta[name="apple-mobile-web-app-capable"]').count() === 1)

  await page.getByRole('button', { name: 'Settings' }).first().click()
  await page.getByText('Time zone', { exact: true }).waitFor({ timeout: 5_000 })
  check('http origin: no phone QR code', await page.getByText('Open on your phone').count() === 0)
  await page.screenshot({ path: `${SHOTS}/ios-shell-settings.png` })
  await page.close()

  const plain = await browser.newPage({ viewport })
  await plain.goto(origin)
  await plain.getByRole('button', { name: 'Settings' }).first().waitFor({ timeout: 20_000 })
  check('no bridge: no Servers button', await plain.getByRole('button', { name: 'Servers', exact: true }).count() === 0)
  check('no bridge: no server badge', await plain.getByRole('button', { name: 'Choose a server' }).count() === 0)
  await plain.close()
} finally {
  await browser.close()
}
finish()
