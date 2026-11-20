/*
 * Verifies that memoized sidebar workspace rows still update, in real
 * Chromium, when what they show changes:
 *
 *  1. A title changed through the API shows on its row.
 *  2. Selecting a row marks it and unmarks the one selected before.
 *  3. Renaming from the row's menu shows the new title.
 *  4. A dragged row dims while dragged, and only that row; releasing it
 *     restores it.
 *  5. An open "Move to group…" dialog follows the groups on screen: one
 *     created, renamed or deleted while it is open.
 *  6. Stopping the open workspace from its row menu selects the row below,
 *     using the row order at the moment of the stop.
 *
 * It needs PROJECT (default `perf`) with at least three running workspaces.
 * It titles three or four of them, creates a group (deleted at the end) and one
 * extra workspace, which step 6 stops; the original titles are restored.
 *
 * Run: PROJECT=perf node test-playwright-scripts/sidebar-row-updates.js
 * (APP_URL points it at a vite dev server.)
 */
import { api, check, createWorkspace, finish, origin, requirePlaywright, resolveProject, until } from './lib.js'

const PROJECT = (await resolveProject(process.env.PROJECT ?? 'perf')).id
const listed = () => api('/workspace/list').then((r) => r.workspaces.filter((w) => w.projectId === PROJECT))
const live = await listed()
if (live.length < 3) throw new Error(`project ${PROJECT} needs three running workspaces`)
const [a, b, c] = live
// The newest workspace other than c (which goes into a group) is the row
// below the one step 6 creates.
const below = live.filter((w) => w !== c).sort((x, y) => y.createdAt.localeCompare(x.createdAt))[0]
const titled = below === a || below === b ? [a, b, c] : [a, b, c, below]
const originals = titled.map((w) => [w.workspaceId, w.title ?? ''])
const setTitle = (w, title) => api(`/workspace/${w.workspaceId}/title`, { method: 'POST', body: { title } })

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
let groupId
let extra
try {
  await setTitle(a, 'row A')
  await setTitle(b, 'row B')
  await setTitle(c, 'row C')
  if (titled.length === 4) await setTitle(below, 'row below')
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  await page.goto(`${origin}/?project=${PROJECT}`)
  const sidebar = page.locator('aside')
  const select = (title) => sidebar.getByRole('button', { name: title, exact: true })
  const row = (title) => select(title).locator('..')
  await select('row C').waitFor({ timeout: 15_000 })

  await setTitle(b, 'row B2')
  await select('row B2').waitFor({ timeout: 10_000 }).catch(() => {})
  check('an API rename shows on the row', await select('row B2').count() === 1)

  await select('row A').click()
  await until(page, () => document.querySelector('aside [aria-current="true"]')?.getAttribute('aria-label') === 'row A')
  await select('row C').click()
  await until(page, () => document.querySelector('aside [aria-current="true"]')?.getAttribute('aria-label') === 'row C')
  check('selecting a row moves the mark', await sidebar.locator('[aria-current="true"]').count() === 1)

  await row('row B2').hover()
  await row('row B2').getByRole('button', { name: 'Workspace actions' }).click()
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  const input = sidebar.getByRole('textbox', { name: 'Workspace row title' })
  await input.fill('row B3')
  await input.press('Enter')
  await select('row B3').waitFor({ timeout: 10_000 }).catch(() => {})
  check('a menu rename shows on the row', await select('row B3').count() === 1)

  const box = await select('row A').boundingBox()
  await page.mouse.move(box.x + 40, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 40, box.y + box.height / 2 + 20, { steps: 4 })
  const dimmed = async () => (await sidebar.locator('.opacity-60').all()).length
  const aDims = await row('row A').evaluate((el) => el.classList.contains('opacity-60'))
  check('the dragged row dims, and only it', aDims && await dimmed() === 1)
  await page.mouse.up()
  check('releasing the drag restores the row', !await row('row A').evaluate((el) => el.classList.contains('opacity-60')))

  await row('row B3').hover()
  await row('row B3').getByRole('button', { name: 'Workspace actions' }).click()
  await page.getByRole('menuitem', { name: 'Move to group…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add to group' })
  await dialog.waitFor()
  const offers = async (name) => dialog.getByRole('button', { name, exact: true }).waitFor({ timeout: 10_000 })
    .then(() => true, () => false)
  groupId = (await api('/workspace/group/create', {
    method: 'POST', body: { projectId: PROJECT, workspaceId: c.workspaceId, name: 'late group' },
  })).groupId
  check('the open group dialog offers a group made meanwhile', await offers('late group'))
  await api('/workspace/group/rename', { method: 'POST', body: { projectId: PROJECT, groupId, name: 'renamed group' } })
  check('the open group dialog shows a rename', await offers('renamed group'))
  await api('/workspace/group/delete', { method: 'POST', body: { projectId: PROJECT, groupId } })
  groupId = undefined
  const gone = await dialog.getByRole('button', { name: 'renamed group', exact: true })
    .waitFor({ state: 'detached', timeout: 10_000 }).then(() => true, () => false)
  check('the open group dialog drops a deleted group', gone)
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })

  const belowTitle = below === a ? 'row A' : below === b ? 'row B3' : 'row below'
  extra = await createWorkspace({ project: PROJECT, noSession: true, title: 'row to stop' })
  await select('row to stop').waitFor({ timeout: 30_000 })
  await select('row to stop').click()
  await row('row to stop').hover()
  await row('row to stop').getByRole('button', { name: 'Workspace actions' }).click()
  await page.getByRole('menuitem', { name: 'Stop…' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Stop', exact: true }).click()
  await until(page, () => document.querySelector('aside [aria-current="true"]')?.getAttribute('aria-label') !== 'row to stop')
  const now = await sidebar.locator('[aria-current="true"]').getAttribute('aria-label')
  check('stopping the open row selects the row below', now === belowTitle, `${now} vs ${belowTitle}`)
  extra = undefined
} finally {
  if (extra) await api('/workspace/stop', { method: 'POST', body: { workspaceId: extra } }).catch(() => {})
  if (groupId) await api('/workspace/group/delete', { method: 'POST', body: { projectId: PROJECT, groupId } }).catch(() => {})
  for (const [workspaceId, title] of originals) {
    await api(`/workspace/${workspaceId}/title`, { method: 'POST', body: { title } }).catch(() => {})
  }
  await browser.close()
}
finish()
