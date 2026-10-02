/*
 * Verifies, in a real browser, the SPA paths reworked onto React Query, the
 * shared Modal variants, the store's persisted-field table and the shared
 * reconnecting socket:
 *
 *  1. The app boots through the whoami query and lists the project.
 *  2. Settings loads its server-backed fields (git identity, time zone, the
 *     credential list, a project's env and yaac-config.json) without errors.
 *  3. A preference (Sounds) is saved under its existing localStorage key and
 *     survives a reload.
 *  4. The skills overlay opens as a titled sheet whose Close button works,
 *     and the add-project dialog opens as a form.
 *  5. With the server down long enough for the events socket's backoff to
 *     grow, an `online` event reconnects it at once after the server returns.
 *
 * Needs a running containerless server built from this checkout, with a git
 * identity, a Claude credential (fake is fine) and one project. Restarts that
 * server (step 5) through `node dist/cli.js`.
 * Run: node test-playwright-scripts/frontend-simplify-test.js
 */
import { execSync } from 'node:child_process'
import path from 'node:path'
import { requirePlaywright, origin, check, finish, SHOTS, until } from './lib.js'

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const errors = []
page.on('pageerror', (err) => errors.push(err.message))
// Record each events socket the page opens, so step 5 can see a reconnect.
await page.addInitScript(() => {
  const Real = window.WebSocket
  window.__eventSockets = []
  window.WebSocket = class extends Real {
    constructor(url, ...rest) {
      super(url, ...rest)
      if (String(url).endsWith('/api/events')) window.__eventSockets.push({ at: Date.now(), ws: this })
    }
  }
})
const shot = (name) => page.screenshot({ path: path.join(SHOTS, `frontend-simplify-${name}.png`) })

// 1. Boot.
await page.goto(origin)
const rail = page.getByRole('button', { name: /yaac/ }).first()
await rail.waitFor({ timeout: 20_000 })
check('app boots and lists the project', await rail.isVisible())

// 2. Settings.
await page.getByTitle('Settings').first().click()
const dialog = page.getByRole('dialog')
await dialog.waitFor()
await until(page, () => [...document.querySelectorAll('input')].some((i) => i.value === 'Yaac Test'))
check('git identity loads into its fields', true)
const zone = dialog.getByLabel('Time zone')
await until(page, () => !document.querySelector('select[aria-label="Time zone"]')?.disabled)
check('time zone loads', (await zone.inputValue()) !== undefined)
await shot('general')

await dialog.getByRole('button', { name: 'Credentials' }).click()
await dialog.getByRole('button', { name: 'Sign out' }).first().waitFor({ timeout: 10_000 })
check('the credential list shows the signed-in tool', await dialog.getByText(/claude ·/).first().isVisible())

await dialog.getByRole('button', { name: 'Shortcuts' }).click()
check('shortcuts pane renders', await dialog.getByText('Reset all to defaults').isVisible())

await dialog.getByRole('button', { name: 'Project Config' }).click()
await dialog.getByText('Environment', { exact: true }).waitFor()
await until(page, () => !document.querySelector('[role="dialog"]')?.textContent?.includes('Loading…'), undefined, 15_000)
const text = await dialog.textContent()
check('project env and config load without an error', !/not found|failed|error/i.test(text), text.slice(0, 120))
await shot('project')
await page.keyboard.press('Escape')
await dialog.waitFor({ state: 'detached' })

// 3. A persisted preference.
// Settings reopens on its last section.
await page.getByTitle('Settings').first().click()
await page.getByRole('dialog').getByRole('button', { name: 'General' }).click()
await page.getByRole('switch', { name: 'Sounds' }).click()
const saved = await page.evaluate(() => localStorage.getItem('yaac.sound.v1'))
check('Sounds off is saved under its existing key', saved === '0', String(saved))
await page.reload()
await rail.waitFor()
await page.getByTitle('Settings').first().click()
await page.getByRole('dialog').getByRole('button', { name: 'General' }).click()
check('Sounds stays off after a reload', (await page.getByRole('switch', { name: 'Sounds' }).getAttribute('aria-checked')) === 'false')
await page.getByRole('switch', { name: 'Sounds' }).click()
await page.keyboard.press('Escape')

// 4. Sheet and form dialogs.
await page.getByRole('button', { name: 'Skills' }).click()
const sheet = page.getByRole('dialog')
await sheet.waitFor()
check('skills sheet is titled', await sheet.getByText(/^Skills/).first().isVisible())
await page.waitForTimeout(500)
await shot('skills')
await sheet.getByRole('button', { name: 'Close' }).click()
await sheet.waitFor({ state: 'detached' })
check('its Close button closes it', true)

await page.getByTitle('New project').click()
const form = page.getByRole('dialog')
await form.waitFor()
check('add-project form opens', await form.getByText('Add project').isVisible())
await shot('add-project')
await page.keyboard.press('Escape')
await form.waitFor({ state: 'detached' })

// 5. Wake the events socket.
const cli = (cmd) => execSync(`node dist/cli.js ${cmd}`, { stdio: 'ignore', timeout: 120_000 })
cli('server stop')
// Long enough for the reconnect delay to grow past several seconds.
await page.waitForTimeout(15_000)
cli('server start')
const before = await page.evaluate(() => window.__eventSockets.length)
const woke = Date.now()
await page.evaluate(() => window.dispatchEvent(new Event('online')))
await until(page, (n) => window.__eventSockets.length > n
  && window.__eventSockets.at(-1).ws.readyState === WebSocket.OPEN, before, 10_000)
const took = (await page.evaluate(() => window.__eventSockets.at(-1).at)) - woke
check('an online event reconnects the events socket at once', took < 1000, `${took}ms`)

check('no page errors', errors.length === 0, errors.join(' | '))
await browser.close()
finish()
