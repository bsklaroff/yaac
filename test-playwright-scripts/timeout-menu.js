/*
 * Verifies a workspace's timeout controls with real keys in Chromium:
 *   1. With no timeout the bar has no chip; ⋯ → Set a timeout → Stop after…
 *      opens a focused duration box in the bar.
 *   2. Typing a duration and pressing Enter sets it, shows the chip, hands
 *      focus to ⋯ (the chip arrives with the next snapshot), and opens no
 *      menu: the Enter must not also press the button focus moved to.
 *   3. With a timeout set, chip → Stop after…, a duration and Enter leaves
 *      focus on the chip with no menu open; Escape in the box does too.
 *   4. Chip → No timeout by keyboard clears it and leaves focus on ⋯.
 *
 * Creates a workspace with no session in PROJECT (default yaac) unless
 * WORKSPACE_ID is set, clears its timeout, and stops a created one at the end.
 * Serves the SPA from the server's `dist/`, so rebuild and restart the
 * server after frontend changes.
 *
 * Run: PROJECT=<name or id> [WORKSPACE_ID=<id in PROJECT>] node test-playwright-scripts/timeout-menu.js
 */
import { api, check, createWorkspace, finish, origin, requirePlaywright, resolveProject } from './lib.js'

const PROJECT = process.env.PROJECT ?? 'yaac'
const named = process.env.WORKSPACE_ID
const workspaceId = named ?? await createWorkspace({ project: PROJECT, noSession: true, title: 'PW timeout menu' })
const projectId = (await resolveProject(PROJECT)).id
const setTimeout = (timeout) => api('/workspace/timeout', { method: 'POST', body: { workspaceId, timeout } })
await setTimeout(null)

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 700 } })
  await page.goto(`${origin}/?project=${projectId}&workspace=${workspaceId}`)
  const more = page.getByRole('button', { name: 'More pane actions' })
  const chip = page.getByRole('button', { name: /^Stops in / })
  const box = page.getByLabel('Stop after')
  const menus = page.getByRole('menu')
  const focused = (locator) => locator.evaluate((el) => el === document.activeElement)
  await page.locator('button[title^="Review commits"]').or(page.getByText('No repos')).first().waitFor({ timeout: 30_000 })

  // 1–2. From the ⋯ menu.
  check('no chip without a timeout', await chip.count() === 0)
  await more.click()
  await page.getByRole('menuitem', { name: 'Set a timeout' }).click()
  await page.getByRole('menuitem', { name: 'Stop after…' }).click()
  await box.waitFor({ timeout: 5_000 })
  check('menu: the box is focused', await focused(box))
  await box.pressSequentially('1h')
  await page.keyboard.press('Enter')
  await chip.waitFor({ timeout: 10_000 })
  await page.waitForTimeout(300)
  check('menu: Enter opens no menu', await menus.count() === 0, `${await menus.count()} open`)
  check('menu: focus is on ⋯', await focused(more))

  // 3. From the chip.
  await chip.click()
  await page.getByRole('menuitem', { name: 'Stop after…' }).click()
  await box.waitFor({ timeout: 5_000 })
  await box.pressSequentially('2h')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(300)
  check('chip: Enter opens no menu', await menus.count() === 0, `${await menus.count()} open`)
  check('chip: focus is on the chip', await focused(chip))
  await chip.click()
  await page.getByRole('menuitem', { name: 'Stop after…' }).click()
  await box.waitFor({ timeout: 5_000 })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  check('chip: Escape opens no menu and focuses the chip', await menus.count() === 0 && await focused(chip))

  // 4. No timeout by keyboard.
  await chip.focus()
  await page.keyboard.press('Enter')
  await page.getByRole('menuitem', { name: 'No timeout' }).waitFor({ timeout: 5_000 })
  // No timeout is the menu's last item.
  await page.keyboard.press('End')
  check('No timeout is highlighted', await page.getByRole('menuitem', { name: 'No timeout' }).evaluate((el) => el === document.activeElement))
  await page.keyboard.press('Enter')
  await chip.waitFor({ state: 'detached', timeout: 10_000 })
  check('No timeout: focus is on ⋯', await focused(more))
} finally {
  await browser.close()
  if (!named) await api('/workspace/stop', { method: 'POST', body: { workspaceId } })
}
finish()
