/*
 * Verifies Settings → Credentials → Tokens (docs/remote-hosting.md "Token
 * access"): the section shows the token listener's key fingerprint, "New
 * token" shows the made token once and lists it, a "New identity" for
 * GitHub Actions asks for the repository and owner ids, and Delete removes a
 * token after a confirm. SCREENSHOT_DIR gets tokens-settings.png.
 *
 * Needs a running `yaac server start --token-listen 127.0.0.1:<port>`.
 *
 * Run: YAAC_DATA_DIR=... node test-playwright-scripts/tokens-settings.js
 */
import path from 'node:path'
import { requirePlaywright, origin, check, finish, SHOTS } from './lib.js'

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))
await page.goto(`${origin}/`)
await page.getByRole('button', { name: 'yaac menu' }).click()
await page.getByRole('menuitem', { name: 'Settings' }).click()
await page.getByRole('button', { name: 'Credentials' }).click()
const section = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Tokens' }) })
await section.waitFor()
const fingerprint = section.locator('code', { hasText: /^sha256\/\// })
await fingerprint.waitFor({ timeout: 10_000 }).catch(() => undefined)
check('the section shows the listener\'s key fingerprint', await fingerprint.count() === 1)

const label = `pw-${Date.now()}`
const form = section.locator('form').first()
await form.getByLabel('Label').fill(label)
await form.getByLabel('Expires after').fill('30d')
await form.getByRole('button', { name: 'Create' }).click()
await section.getByText(/it is not shown again/).waitFor()
check('the new token is shown once', await section.getByText(/yaac_pat_/).count() === 1)
check('the token is listed', await section.getByText(label, { exact: true }).count() >= 1)

const identity = section.locator('form').nth(1)
await identity.getByLabel('Issuer').fill('https://token.actions.githubusercontent.com')
check('a GitHub issuer asks for the repository and owner ids',
  await identity.getByLabel('Repository id').isVisible() && await identity.getByLabel('Repository owner id').isVisible())
check('a GitHub issuer explains its subject', await section.getByText(/environment with required reviewers/).count() === 1)
await section.scrollIntoViewIfNeeded()
await page.screenshot({ path: path.join(SHOTS, 'tokens-settings.png'), fullPage: true })

await section.locator('div').filter({ hasText: label }).getByRole('button', { name: 'Delete' }).first().click()
await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click()
await page.getByRole('alertdialog').waitFor({ state: 'hidden' })
check('the deleted token is gone', await section.getByText(label, { exact: true }).count() === 0)

await browser.close()
finish()
