/*
 * Verifies a group's workspace limit in the sidebar, in real Chromium
 * (docs/workspace-groups.md):
 *
 *  1. The group header shows live workspaces out of the limit, and the
 *     stopped count beside it.
 *  2. Its queued workspaces with no parent show as one "n waiting for room"
 *     set in the section.
 *  3. The `…` menu's "Workspace limit…" opens a dialog holding the current
 *     limit.
 *
 * Reads only: it expects GROUP (default `Workers`) to exist with a limit,
 * live members and waiting entries, as set up by hand through the API. It
 * saves sidebar.png and limit-dialog.png under SCREENSHOT_DIR.
 *
 * Run: GROUP=Workers node test-playwright-scripts/group-workspace-limit.js
 */
import path from 'node:path'
import { SHOTS, api, check, finish, origin, requirePlaywright } from './lib.js'

const GROUP = process.env.GROUP ?? 'Workers'

const { groups } = await api('/workspace/group/list')
const group = groups.find((g) => g.name === GROUP)
if (group?.workspaceLimit === undefined) throw new Error(`no group "${GROUP}" with a workspace limit`)

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
  await page.goto(`${origin}/?project=${group.projectId}`)
  const section = page.getByRole('group', { name: GROUP })
  await section.waitFor({ timeout: 15_000 })
  const header = await section.locator('button').first().textContent()
  check('header shows live out of the limit', new RegExp(`\\(\\d+/${group.workspaceLimit}\\)`).test(header ?? ''), header)
  check('header shows the stopped count', group.stoppedCount === 0 || (header ?? '').includes(`${group.stoppedCount} stopped`), header)

  const waiting = section.getByRole('button', { name: /waiting for room/ })
  check('waiting entries form one set', await waiting.count() === 1)
  await waiting.click()
  await page.screenshot({ path: path.join(SHOTS, 'sidebar.png') })

  await section.getByRole('button', { name: 'Group actions' }).click({ force: true })
  await page.getByRole('menuitem', { name: 'Workspace limit…' }).click()
  const input = page.getByRole('spinbutton', { name: 'Workspace limit' })
  await input.waitFor({ timeout: 5_000 })
  check('dialog holds the current limit', await input.inputValue() === String(group.workspaceLimit))
  // Past the dialog's open transition.
  await page.waitForTimeout(500)
  await page.screenshot({ path: path.join(SHOTS, 'limit-dialog.png') })
} finally {
  await browser.close()
}
finish()
