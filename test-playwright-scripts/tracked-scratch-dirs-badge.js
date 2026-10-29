/*
 * Verifies the scratch-directory UI in real Chromium:
 *   1. A workspace whose project treats a git-tracked dir as a scratch dir shows
 *      the "Tracked in git" badge on its workspace bar, naming the dir, and
 *      its popover offers "Keep in the checkout and restart" and "Don't show
 *      again for this project".
 *   2. "Don't show again" hides the badge; Settings → Project Config then
 *      lists the dir under "Not warned about", and "Warn again" brings the
 *      badge back.
 *   3. Settings → Project Config's scratch directories section adds a dir,
 *      refuses one outside the checkout with the server's message, and
 *      removes it.
 *   4. The yaac-config.json editor opens a stored file the server's parser
 *      refuses (an unknown key) verbatim, not as `{}`.
 *   5. "Keep in the checkout and restart" takes the dir off the project's
 *      list and the badge goes once the workspace is back.
 * SCREENSHOT_DIR gets tracked-badge-popover.png and scratch-settings.png.
 *
 * Needs a server with a project whose repo tracks `target/` and a running
 * workspace in it, and a second project whose stored yaac-config.json holds
 * an unknown key. Run:
 *   TRACKED_PROJECT=<id> TRACKED_WORKSPACE=<id> CONFIG_PROJECT=<id> \
 *     APP_URL=http://127.0.0.1:<port> node test-playwright-scripts/tracked-scratch-dirs-badge.js
 */
import path from 'node:path'
import { requirePlaywright, origin, api, check, finish, SHOTS } from './lib.js'

const { chromium } = requirePlaywright()
const { TRACKED_PROJECT, TRACKED_WORKSPACE, CONFIG_PROJECT } = process.env

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
const shown = (loc, timeout = 15_000) => loc.waitFor({ timeout }).then(() => true, () => false)
const gone = (loc, timeout = 15_000) => loc.waitFor({ state: 'hidden', timeout }).then(() => true, () => false)
const badge = page.getByRole('button', { name: 'Scratch directories tracked in git' })
const openSettings = async () => {
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Project Config' }).click()
  await page.getByText('Scratch directories', { exact: true }).waitFor()
}
const closeSettings = async () => {
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {})
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Project Config' }).waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {})
}

// 1. The badge and its popover.
await page.goto(`${origin}/?project=${TRACKED_PROJECT}&workspace=${TRACKED_WORKSPACE}`)
check('the badge shows on the workspace bar', await shown(badge))
check('the badge names the dir', (await badge.textContent())?.includes('target') === true)
await badge.click()
check('the popover lists target/', await shown(page.getByText('target/', { exact: true })))
check('the popover offers a restart with the dir kept in the checkout',
  await shown(page.getByRole('button', { name: 'Keep in the checkout and restart' })))
await page.screenshot({ path: path.join(SHOTS, 'tracked-badge-popover.png') })

// 2. Don't show again, then Warn again from Settings.
await page.getByLabel("Don't show again for this project").click()
check('"Don\'t show again" hides the badge', await gone(badge))
await openSettings()
check('Settings lists the ignored dir', await shown(page.getByText('Not warned about when tracked in git:')))
await page.getByRole('button', { name: 'Warn again' }).click()
check('"Warn again" clears the ignored list', await gone(page.getByText('Not warned about when tracked in git:')))
await closeSettings()
check('the badge is back', await shown(badge))
await page.screenshot({ path: path.join(SHOTS, 'after-warn-again.png') })

// 3. Add, refuse, remove.
await openSettings()
const input = page.getByPlaceholder('packages/web/node_modules')
await input.fill('web/node_modules')
await page.getByRole('button', { name: 'Add scratch directory' }).click()
check('an added dir is listed', await shown(page.getByText('web/node_modules/', { exact: true })))
await input.fill('../escape')
await page.getByRole('button', { name: 'Add scratch directory' }).click()
check('a dir outside the checkout is refused with the reason', await shown(page.getByText(/must not contain/)))
await page.getByRole('button', { name: 'Remove web/node_modules' }).click()
check('a removed dir goes', await gone(page.getByText('web/node_modules/', { exact: true })))
await page.screenshot({ path: path.join(SHOTS, 'scratch-settings.png') })
await closeSettings()

// 4. The raw editor opens an unparseable stored config as written.
await page.goto(`${origin}/?project=${CONFIG_PROJECT}`)
await openSettings()
await page.locator('.cm-editor').first().waitFor()
const text = await page.locator('.cm-content').first().innerText()
check('the editor shows the stored file verbatim', text.includes('ephemeralModulesPaths') && text.includes('npmCache'), text)
await closeSettings()

// 5. Keep in the checkout and restart.
await page.goto(`${origin}/?project=${TRACKED_PROJECT}&workspace=${TRACKED_WORKSPACE}`)
await badge.click()
await page.getByRole('button', { name: 'Keep in the checkout and restart' }).click()
check('the badge goes after the restart', await gone(badge, 60_000))
const row = (await api('/project/list')).find((p) => p.id === TRACKED_PROJECT)
check('target is off the project list', !row.scratchDirs.dirs.some((d) => d.path === 'target'), JSON.stringify(row.scratchDirs))

await browser.close()
finish()
