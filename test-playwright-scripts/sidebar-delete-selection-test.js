/*
 * Verifies where the selection lands when the open workspace goes away.
 *
 *  1. A workspace that disappears from under the open pane (stopped over the
 *     API here, by the stale reaper in practice) hands the pane to the
 *     topmost remaining row: nothing local knew it was going, so there is no
 *     neighbour to pick.
 *  2. Stopping the selected workspace from its row menu selects the row below.
 *  3. Stopping the bottom row falls back to the row above, skipping rows
 *     still shown as greyed "stopping…" placeholders.
 *
 * The selection is read from the URL (?project=…&workspace=<id>).
 *
 * Needs a running server with a project and no other ungrouped live
 * workspaces in it. Creates four `pi` ACP workspaces (fake credentials, no
 * prompt, so no model is called) and stops them all.
 * Run: YAAC_DATA_DIR=<data dir> node test-playwright-scripts/sidebar-delete-selection-test.js
 * (PROJECT defaults to yaac)
 */
import path from 'node:path'
import { requirePlaywright, origin, api, check, finish, SHOTS, createWorkspaces } from './lib.js'

const PROJECT = process.env.PROJECT ?? 'yaac'

const stop = (workspaceId) => api('/workspace/stop', { method: 'POST', body: { workspaceId } })

console.log('creating four workspaces…')
const made = await createWorkspaces([1, 2, 3, 4].map((n) => ({ project: PROJECT, tool: 'pi', mode: 'acp', title: `PW sel ${n}` })))
const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  const selectedId = () => new URL(page.url()).searchParams.get('workspace')
  const list = page.getByRole('group', { name: 'Ungrouped workspaces' })
  const row = (title) => list.locator('div.group.relative', { hasText: title })

  await page.goto(`${origin}/?project=${PROJECT}`)
  await row('PW sel 4').waitFor({ timeout: 15_000 })
  await page.waitForTimeout(1000)

  // Row order as ids, top to bottom, by selecting each row.
  const titles = (await list.locator('div.group.relative').allInnerTexts()).map((t) => t.split('\n')[0])
  if (titles.length !== 4) throw new Error(`expected 4 ungrouped rows, found: ${titles.join(', ')}`)
  const ids = []
  for (const t of titles) {
    await row(t).getByText(t, { exact: true }).click()
    await page.waitForTimeout(250)
    ids.push(selectedId())
  }
  const titleOf = Object.fromEntries(ids.map((id, i) => [id, titles[i]]))
  console.log(`rows, top to bottom: ${titles.join(', ')}`)

  const awaitSelectionChange = async (from) => {
    for (let i = 0; i < 40 && selectedId() === from; i++) await page.waitForTimeout(500)
    return selectedId()
  }
  const stopFromMenu = async (id) => {
    const r = row(titleOf[id])
    await r.getByText(titleOf[id], { exact: true }).click()
    await r.hover()
    await r.getByRole('button', { name: 'Workspace actions' }).click()
    await page.getByRole('menuitem', { name: 'Stop…' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Stop', exact: true }).click()
    await page.waitForTimeout(500)
  }

  // 1. Stopped outside the app while open: the top row takes over.
  await row(titles[1]).getByText(titles[1], { exact: true }).click()
  await page.waitForTimeout(250)
  await stop(ids[1])
  check('vanished workspace -> topmost row', await awaitSelectionChange(ids[1]) === ids[0], selectedId())

  // 2. Stopped in the app: the row below takes over.
  await stopFromMenu(ids[2])
  check('stop the selected row -> row below', selectedId() === ids[3], selectedId())

  // 3. ids[3] is at the bottom, with only a stopping row between it and the
  //    top, so the selection goes up to ids[0].
  await stopFromMenu(ids[3])
  check('stop the bottom row -> row above, skipping stopping ones', selectedId() === ids[0], selectedId())
  await page.screenshot({ path: path.join(SHOTS, 'sidebar-delete-selection.png') })
} finally {
  await browser.close()
  await Promise.allSettled(made.map(stop))
}
finish()
