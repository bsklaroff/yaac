/*
 * Verifies the caret on a workflow's sidebar row, which shows and hides the
 * runs nested under it:
 *
 *  1. At rest, with its runs hidden, the row shows its icon and no caret.
 *  2. Hovering the row swaps the icon for the caret.
 *  3. With its runs shown, the caret stays in place of the icon, hovered or
 *     not.
 *  4. The caret sits right of the Workflows section's own caret.
 *
 * Creates a workflow named `caret-check`, runs it once (a step that sleeps,
 * so the run stays live), and removes the workflow at the end. Screenshots
 * land in $SCREENSHOT_DIR (default /tmp/yaac-shots).
 *
 * Run: APP_URL=http://127.0.0.1:<port> PROJECT=<name or id> node test-playwright-scripts/sidebar-object-caret.js
 */
import { SHOTS, api, check, finish, origin, requirePlaywright, resolveProject } from './lib.js'

const { chromium } = requirePlaywright()
const project = await resolveProject(process.env.PROJECT ?? 'yaac')
const NAME = 'caret-check'
await api('/workflow/delete', { method: 'POST', body: JSON.stringify({ project: project.id, name: NAME }) }).catch(() => {})
await api('/workflow/create', {
  method: 'POST',
  body: JSON.stringify({ project: project.id, name: NAME, repos: [], steps: { wait: { run: ['sleep 120'] } } }),
})
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })

try {
  await page.goto(`${origin}/?project=${project.id}`)
  const section = page.getByRole('group', { name: 'Workflows' })
  await section.waitFor()
  await section.getByRole('button', { name: `Run now: ${NAME}` }).click({ force: true })
  const toggle = section.getByRole('button', { name: new RegExp(`^(Show|Hide) ${NAME}'s runs$`) })
  await toggle.waitFor({ timeout: 60_000 })
  if (await toggle.getAttribute('aria-expanded') === 'true') await toggle.click()
  await page.mouse.move(1300, 850)
  await page.waitForTimeout(300)

  const shown = () => toggle.evaluate((el) => [...el.querySelectorAll('svg')].map((s) => getComputedStyle(s).display !== 'none'))
  const [iconAtRest, caretAtRest] = await shown()
  check('at rest: icon, no caret', iconAtRest && !caretAtRest, JSON.stringify({ iconAtRest, caretAtRest }))
  await page.screenshot({ path: `${SHOTS}/caret-rest.png` })

  await section.getByRole('button', { name: NAME, exact: true }).hover({ force: true })
  const [iconHover, caretHover] = await shown()
  check('hovered: caret in place of the icon', !iconHover && caretHover, JSON.stringify({ iconHover, caretHover }))
  await page.screenshot({ path: `${SHOTS}/caret-hover.png` })

  await toggle.click()
  await page.mouse.move(1300, 850)
  await page.waitForTimeout(300)
  const [iconOpen, caretOpen] = await shown()
  check('expanded: caret stays', !iconOpen && caretOpen && await toggle.getAttribute('aria-expanded') === 'true',
    JSON.stringify({ iconOpen, caretOpen }))

  const sectionCaret = await section.getByRole('button', { name: 'Workflows' }).locator('svg').boundingBox()
  const rowCaret = await toggle.locator('svg').nth(1).boundingBox()
  check('row caret right of the section caret', rowCaret.x > sectionCaret.x, `row ${rowCaret.x}, section ${sectionCaret.x}`)
  await page.screenshot({ path: `${SHOTS}/caret-expanded.png` })
} finally {
  await browser.close()
  await api('/workflow/delete', { method: 'POST', body: JSON.stringify({ project: project.id, name: NAME }) }).catch(() => {})
}
finish()
