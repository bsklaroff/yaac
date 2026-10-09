/*
 * Verifies the sidebar's status filter against a live server: the filter
 * button beside the search box opens a menu of Waiting / Running /
 * Monitoring / Stopped checkboxes; checking Stopped hides the live rows and
 * opens the Stopped section, checking Waiting as well brings back the idle
 * workspace, and "Show all" clears the filter. Saves screenshots of the
 * open menu and the filtered list to SHOTS.
 *
 * Needs a running server with a project. Creates two `pi` ACP workspaces
 * (fake credentials, no prompt, so no model is called and each sits
 * waiting), stops one, and stops the other at the end.
 * Run: YAAC_DATA_DIR=<data dir> node test-playwright-scripts/sidebar-status-filter-test.js
 * (PROJECT, a project name or id, defaults to yaac)
 */
import path from 'node:path'
import { requirePlaywright, origin, api, check, finish, SHOTS, createWorkspaces, resolveProject, until } from './lib.js'

const PROJECT = (await resolveProject(process.env.PROJECT ?? 'yaac')).id
const RUN = Date.now().toString(36).slice(-4)
const LIVE = `PW live ${RUN}`
const GONE = `PW stopped ${RUN}`
const stop = (workspaceId) => api('/workspace/stop', { method: 'POST', body: { workspaceId } })

console.log('creating two workspaces…')
const [live, gone] = await createWorkspaces([
  { project: PROJECT, tool: 'pi', mode: 'acp', title: LIVE },
  { project: PROJECT, tool: 'pi', mode: 'acp', title: GONE },
])
await stop(gone)

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  const list = page.locator('aside .overflow-y-auto')
  const shows = (text) => list.getByText(text, { exact: true }).count().then((n) => n > 0)
  const item = (name) => page.getByRole('menuitemcheckbox', { name })
  const filter = page.getByRole('button', { name: 'Filter by status' })

  await page.goto(`${origin}/?project=${PROJECT}`)
  await until(page, (t) => document.body.innerText.includes(t), LIVE)
  // Wait out the agent's launch, so the row has settled on waiting.
  await until(page, () => !document.querySelector('aside .braille-spinner'))
  check('unfiltered: the live row shows', await shows(LIVE))

  await filter.click()
  await item('Stopped').click()
  await page.screenshot({ path: path.join(SHOTS, 'status-filter-menu.png') })
  check('stopped only: the live row is hidden', !(await shows(LIVE)))
  await until(page, (t) => document.querySelector('aside .overflow-y-auto').innerText.includes(t), GONE)
  check('stopped only: the Stopped section opens on its rows', await shows(GONE))
  check('the trigger counts one status', (await filter.innerText()).trim() === '1')

  await item('Waiting').click()
  check('waiting + stopped: the idle workspace is back', await shows(LIVE))
  await page.keyboard.press('Escape')
  await page.screenshot({ path: path.join(SHOTS, 'status-filter-list.png') })

  await filter.click()
  await page.getByRole('menuitem', { name: 'Show all' }).click()
  check('show all clears the filter', (await filter.innerText()).trim() === '')
} finally {
  await browser.close()
  await stop(live)
}
finish()
