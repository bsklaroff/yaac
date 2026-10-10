/*
 * Verifies that the sidebar search keeps the open workspace on screen when
 * it doesn't match: its row sits on top of the list under an "Open in pane"
 * header, and the header's Deselect button empties the pane, which then
 * offers a new workspace. Screenshots the pinned row and the emptied pane to
 * $SCREENSHOT_DIR (default /tmp/yaac-shots).
 *
 * Needs a running `yaac server` (see lib.js). Creates two tui workspaces in
 * project $PROJECT (default "yaac") with no prompt, and stops them at the end.
 *
 * Run: node test-playwright-scripts/sidebar-open-workspace-pin.js
 */
import { SHOTS, api, check, createWorkspaces, finish, origin, requirePlaywright } from './lib.js'

const { chromium } = requirePlaywright()
const PROJECT = process.env.PROJECT ?? 'yaac'
const ids = await createWorkspaces(['PW fix the parser', 'PW write docs'].map((title) => ({
  project: PROJECT, tool: 'claude', mode: 'tui', title,
})))
const { workspaces } = await api('/workspace/list')
const docs = workspaces.find((w) => w.workspaceId.startsWith(ids[1]))
if (!docs) throw new Error(`no live workspace ${ids[1]}`)

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 800 } })
  await page.goto(`${origin}/?${new URLSearchParams({ project: docs.projectId, workspace: docs.workspaceId })}`)
  await page.getByRole('textbox', { name: 'Search workspaces' }).fill('parser')
  const pinned = page.getByRole('group', { name: 'Open workspace' })
  await pinned.waitFor({ timeout: 20_000 })
  check('the open, non-matching workspace is pinned', await pinned.getByText('PW write docs').isVisible())
  check('the match is listed below it', await page.getByText('PW fix the parser').isVisible())
  await page.screenshot({ path: `${SHOTS}/sidebar-open-pin.png` })

  await pinned.getByRole('button', { name: 'Deselect' }).click()
  await page.getByText('No workspace open').waitFor({ timeout: 5_000 })
  check('deselecting drops the pin', !(await pinned.isVisible()))
  check('the pane offers a new workspace', await page.getByText('No workspace open').isVisible())
  await page.screenshot({ path: `${SHOTS}/sidebar-open-pin-deselected.png` })
} finally {
  await browser.close()
  await Promise.allSettled(ids.map((workspaceId) => api('/workspace/stop', { method: 'POST', body: { workspaceId } })))
}
finish()
