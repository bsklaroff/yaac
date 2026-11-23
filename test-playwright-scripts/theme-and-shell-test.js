/*
 * Verifies theming and the app shell's layout in Chromium:
 *  1. First visit on a dark-preferring browser: html[data-theme=system], the
 *     dark shell color on <body>, the dark surface color, and the sidebar
 *     sitting flush against the rail with square corners.
 *  2. The project rail is 45px wide (44px items and a 1px line) with 44px
 *     items.
 *  3. Settings → General → Theme → Light switches html[data-theme] live,
 *     recolors the shell and persists yaac.theme.v1; a reload comes back
 *     light before first paint (the inline script in index.html).
 *  4. Hide sidebar removes it, and "Show sidebar" renders only while hidden.
 *  5. The top bar's ⋯ → Review changes opens the Changes pane ("No changes
 *     yet" on a clean checkout, a changed-file count otherwise).
 *
 * Run: node test-playwright-scripts/theme-and-shell-test.js
 * Needs a running server (see lib.js); step 5 opens its first workspace and
 * is skipped when there is none.
 * Screenshots: $SCREENSHOT_DIR/theme-*.png.
 */
import path from 'node:path'
import { api, check, finish, openMenuItem, origin, requirePlaywright, SHOTS } from './lib.js'

// --bg-shell and --bg-surface in packages/frontend/src/styles/tokens.css.
const DARK_SHELL = 'rgb(24, 24, 27)'
const LIGHT_SHELL = 'rgb(246, 246, 245)'
const DARK_SURFACE = 'rgb(32, 32, 35)'

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
  const surface = await page.evaluate(() => {
    const probe = document.body.appendChild(document.createElement('div'))
    probe.className = 'bg-surface'
    const bg = getComputedStyle(probe).backgroundColor
    probe.remove()
    return bg
  })
  check('dark surface color', surface === DARK_SURFACE, surface)
  const flush = await page.evaluate(() => {
    const rail = document.querySelector('nav[aria-label="Projects"]').getBoundingClientRect()
    const aside = document.querySelector('aside')
    return { gap: aside.getBoundingClientRect().left - rail.right, radius: getComputedStyle(aside).borderTopLeftRadius }
  })
  check('sidebar sits flush against the rail, square', flush.gap === 0 && flush.radius === '0px', JSON.stringify(flush))

  // 2. Rail geometry, measured from its Home item.
  const rail = await page.getByRole('navigation', { name: 'Projects' }).getByRole('button', { name: 'Home' }).evaluate((el) => (
    { rail: el.closest('nav').getBoundingClientRect().width, item: el.getBoundingClientRect().height }))
  check('project rail is 45px wide', Math.round(rail.rail) === 45, `${rail.rail}`)
  check('rail items are 44px', Math.round(rail.item) === 44, `${rail.item}`)
  await page.screenshot({ path: path.join(SHOTS, 'theme-dark.png') })

  // 3. Light theme, live and across a reload.
  await openMenuItem(page, 'Settings')
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

  // 5. The Changes pane.
  const [ws] = (await api('/workspace/list')).workspaces
  if (ws) {
    await page.goto(`${origin}/?project=${ws.projectId}&workspace=${ws.workspaceId}`)
    // Until the workspace bar replaces the new-workspace pane, ⋯ is that
    // pane's menu, which goes away with it.
    await page.locator('button[title^="Review commits"]').waitFor({ timeout: 30_000 })
    await page.getByRole('button', { name: 'More pane actions' }).click()
    await page.getByRole('menuitem', { name: 'Review changes' }).click()
    const shown = await page.getByText(/^(No changes yet|Nothing uncommitted|\d+ changed)$/)
      .first().waitFor({ timeout: 15_000 }).then(() => true, () => false)
    check('the top bar opens the Changes pane', shown)
    await page.screenshot({ path: path.join(SHOTS, 'theme-changes-view.png') })
  } else {
    console.log('SKIP  Changes pane: no workspace')
  }
} finally {
  await browser.close()
}
finish()
