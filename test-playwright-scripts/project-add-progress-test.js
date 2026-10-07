/*
 * Verifies, in a real browser, the welcome screen and the background
 * add-project flow:
 *
 *  1. With no projects, the main area shows the welcome, whose button opens
 *     the add-project dialog.
 *  2. Submitting the dialog closes it at once; the rail gets a pending chip
 *     and the main area shows the clone's progress.
 *  3. A failed clone shows its error with Try again, which reopens the
 *     dialog on the same URL.
 *
 * The add request is held and then failed by route interception, so no
 * clone runs; the HTTPS token the dialog stores first is real (and left in
 * the data dir). Needs a running containerless server built from this
 * checkout with NO projects — a fresh instance, e.g.
 *   YAAC_DATA_DIR=$HOME/.yaac-dev YAAC_SERVER_PORT=8890 node dist/cli.js server start
 * Run (same env): node test-playwright-scripts/project-add-progress-test.js
 */
import path from 'node:path'
import { requirePlaywright, origin, check, finish, SHOTS } from './lib.js'

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const errors = []
page.on('pageerror', (err) => errors.push(err.message))
const shot = (name) => page.screenshot({ path: path.join(SHOTS, `project-add-${name}.png`) })

let releaseAdd
await page.route('**/api/project/add', (route) => {
  releaseAdd = () => route.fulfill({
    status: 400,
    contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'VALIDATION', message: 'git authentication failed for github.com' } }),
  })
})

// 1. Welcome.
await page.goto(origin)
await page.getByText('Welcome to yaac').waitFor({ timeout: 20_000 })
check('welcome shows with no projects', true)
await shot('welcome')
await page.getByRole('button', { name: 'Add project' }).click()
await page.getByLabel('Repository URL').fill('https://github.com/acme/widgets.git')

// 2. Submit with a new token; the dialog closes while the add is held. A
// rerun finds the last run's token stored, so "new" is picked explicitly.
const picker = page.getByLabel('Git credential')
if (await picker.isVisible()) await picker.selectOption('new')
await page.getByLabel('Token').fill('ghp_fake')
await page.getByRole('button', { name: 'Add', exact: true }).click()
await page.getByText('Adding widgets').waitFor()
check('dialog closes on submit', !(await page.getByLabel('Repository URL').isVisible()))
check('rail shows a pending chip', await page.getByLabel('Adding project').isVisible())
await shot('progress')

// 3. Fail the add.
releaseAdd()
await page.getByText("Couldn't add widgets").waitFor()
check('error shows', await page.getByText('git authentication failed for github.com').isVisible())
await shot('failed')
await page.getByRole('button', { name: 'Try again' }).click()
check('retry reopens on the URL',
  (await page.getByLabel('Repository URL').inputValue()) === 'https://github.com/acme/widgets.git')
await page.keyboard.press('Escape')
check('welcome returns once dismissed', await page.getByText('Welcome to yaac').isVisible())

check('no page errors', errors.length === 0, errors.join('\n'))
await browser.close()
finish()
