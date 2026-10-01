/*
 * Verifies theming and the app shell's layout in Chromium:
 *  1. First visit on a dark-preferring browser: html[data-theme=system], the
 *     dark shell color on <body>, the lifted --color-surface, and the
 *     sidebar drawn as a floating card.
 *  2. The project rail is 64px wide with 40px project chips.
 *  3. Settings → General → Theme → Light switches html[data-theme] live,
 *     recolors the shell and persists yaac.theme.v1; a reload comes back
 *     light before first paint (the inline script in index.html).
 *  4. Hide sidebar removes it, and "Show sidebar" renders only while hidden.
 *  5. The workspace header's Changes button opens the review pane ("No
 *     changes yet" on a clean checkout, a file list otherwise).
 *
 * Run: node test-playwright-scripts/theme-and-shell-test.js
 * Needs a running server (see lib.js); step 5 opens its first workspace and
 * is skipped when there is none.
 * Screenshots: $SCREENSHOT_DIR/theme-*.png.
 */
import path from 'node:path'
import { api, check, finish, origin, requirePlaywright, SHOTS } from './lib.js'

// --color-shell and --color-surface in packages/frontend/src/index.css.
const DARK_SHELL = 'rgb(15, 15, 18)'
const LIGHT_SHELL = 'rgb(211, 210, 204)'
const DARK_SURFACE = '#1b1b21'

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme)
  const bodyBg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor)

  // 1. Dark by default.
  await page.goto(`${origin}/`)
  await page.locator('aside').waitFor({ timeout: 15_000 })
  check('first visit has data-theme=system', await theme() === 'system', await theme())
  check('dark shell background', await bodyBg() === DARK_SHELL, await bodyBg())
  const surface = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--color-surface').trim())
  check('lifted dark --color-surface', surface === DARK_SURFACE, surface)
  const card = await page.locator('aside > div').first().getAttribute('class')
  check('sidebar is a floating card', card.includes('rounded-lg') && card.includes('border-hairline'), card)

  // 2. Rail geometry, measured from its New project chip.
  const rail = await page.getByTitle('New project').first().evaluate((el) => {
    const col = el.closest('.w-16')
    return { rail: col?.getBoundingClientRect().width, chip: el.getBoundingClientRect().height }
  })
  check('project rail is 64px wide', Math.round(rail.rail) === 64, `${rail.rail}`)
  check('rail chips are 40px', Math.round(rail.chip) === 40, `${rail.chip}`)
  await page.screenshot({ path: path.join(SHOTS, 'theme-dark.png') })

  // 3. Light theme, live and across a reload.
  await page.getByTitle('Settings').first().click()
  await page.getByRole('dialog').getByText('Light', { exact: true }).click()
  check('picking Light sets data-theme=light', await theme() === 'light', await theme())
  check('and persists yaac.theme.v1',
    await page.evaluate(() => localStorage.getItem('yaac.theme.v1')) === 'light')
  await page.keyboard.press('Escape')
  check('light shell background', await bodyBg() === LIGHT_SHELL, await bodyBg())
  await page.screenshot({ path: path.join(SHOTS, 'theme-light.png') })
  await page.reload({ waitUntil: 'commit' })
  await page.locator('html').waitFor({ state: 'attached' })
  check('light survives a reload', await theme() === 'light', await theme())

  // 4. Sidebar hide/show.
  await page.locator('aside').waitFor({ timeout: 15_000 })
  check('no Show-sidebar button while the sidebar is open', await page.getByTitle('Show sidebar').count() === 0)
  await page.getByTitle('Hide sidebar').click()
  check('Hide removes the sidebar', await page.locator('aside').count() === 0)
  await page.getByTitle('Show sidebar').click()
  check('Show brings it back', await page.locator('aside').waitFor({ timeout: 5_000 }).then(() => true, () => false))

  // 5. Changes pane.
  const [ws] = (await api('/workspace/list')).workspaces
  if (ws) {
    await page.goto(`${origin}/?project=${ws.projectSlug}&workspace=${ws.workspaceId}`)
    await page.getByRole('button', { name: 'Review changes' }).click()
    const shown = await page.getByText(/^(No changes yet|Nothing uncommitted)$/).or(page.locator('.group\\/row'))
      .first().waitFor({ timeout: 15_000 }).then(() => true, () => false)
    check('Changes opens the review pane', shown)
    await page.screenshot({ path: path.join(SHOTS, 'theme-changes-pane.png') })
  } else {
    console.log('SKIP  changes pane: no workspace')
  }
} finally {
  await browser.close()
}
finish()
