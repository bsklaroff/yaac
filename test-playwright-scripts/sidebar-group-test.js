/*
 * Verifies a sidebar group's stopped members and restarts against a live
 * server.
 *
 *  1. The header counts active members against all of them: (1/2), (0/1).
 *  2. The header's `…` menu (Group actions) offers Rename, Pin/Unpin, Show
 *     stopped workspaces and Delete group; stopped (ghost) rows stay hidden
 *     until "Show stopped workspaces" is picked, and hide again on "Hide…".
 *  3. In a pinned group whose members have all stopped, the caret and the
 *     menu item are one toggle.
 *  4. A restarting member's "Restarting workspace" row stays inside its
 *     group, in every sampled frame, and never jumps to the top of the
 *     sidebar. Twice: restarted from the ghost row (the client's optimistic
 *     row, then the server's), and restarted over the API (only the server's
 *     snapshot row, which must carry the group itself).
 *
 * Needs a running server with a project. Creates three `pi` ACP workspaces
 * (fake credentials, no prompt, so no model is called) in two groups named
 * for this run, then stops them and deletes the groups.
 * Run: YAAC_DATA_DIR=<data dir> node test-playwright-scripts/sidebar-group-test.js
 * (PROJECT defaults to yaac)
 */
import path from 'node:path'
import { requirePlaywright, origin, api, check, finish, SHOTS, createWorkspaces } from './lib.js'

const PROJECT = process.env.PROJECT ?? 'yaac'
const RUN = Date.now().toString(36).slice(-4)
const MIXED = `Release ${RUN}`
const STOPPED = `Parked ${RUN}`

const pi = (body) => ({ project: PROJECT, tool: 'pi', mode: 'acp', ...body })
const post = (route, body) => api(route, { method: 'POST', body })
const stop = (workspaceId) => post('/workspace/stop', { workspaceId })

/** Rows of the group's section, and of the whole sidebar list, as text. */
function sidebarShape(groupName) {
  const rows = (root) => [...root.querySelectorAll('.group.relative')]
    .map((el) => el.textContent.replace(/\s+/g, ' ').trim().slice(0, 60))
  const section = document.querySelector(`aside [role="group"][aria-label="${groupName}"]`)
  const list = document.querySelector('aside .overflow-y-auto')
  return { section: section ? rows(section) : [], all: list ? rows(list) : [] }
}

// Empty groups are created pinned, which keeps STOPPED listed once its only
// member stops. MIXED is created by the workspace create, unpinned.
const parked = await post('/workspace/group/create', { projectSlug: PROJECT, name: STOPPED })
console.log('creating three workspaces…')
const [A, B, C] = await createWorkspaces([
  pi({ title: `PW member A ${RUN}`, group: MIXED }),
  pi({ title: `PW member B ${RUN}`, group: MIXED }),
  pi({ title: `PW parked ${RUN}`, group: parked.groupId }),
])
await Promise.all([stop(A), stop(C)])

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  const section = (name) => page.locator(`aside [role="group"][aria-label="${name}"]`)
  const ghostButton = 'button[title="Read this workspace\'s conversation"]'
  const ghosts = (name) => section(name).locator(ghostButton)
  const caret = (name) => section(name).locator('button[aria-expanded]').first()
  /** Open the group menu; the `…` ignores the pointer until the header is hovered. */
  const openMenu = async (name) => {
    await caret(name).hover()
    await section(name).getByRole('button', { name: 'Group actions' }).first().click()
  }
  const pick = async (name, item) => {
    await openMenu(name)
    await page.getByRole('menuitem', { name: item }).click()
    await page.getByRole('menu').waitFor({ state: 'detached' })
  }
  /** Show the group's ghost rows, whichever state the toggle is in. */
  const showGhosts = async (name) => {
    await openMenu(name)
    const show = page.getByRole('menuitem', { name: 'Show stopped workspaces' })
    await show.or(page.getByRole('menuitem', { name: 'Hide stopped workspaces' })).waitFor()
    if (await show.count()) await show.click()
    else await page.keyboard.press('Escape')
  }
  const untilShape = async (done, what) => {
    const deadline = Date.now() + 60_000
    for (;;) {
      const shape = await page.evaluate(sidebarShape, MIXED)
      if (done(shape)) return
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(shape)}`)
      await page.waitForTimeout(200)
    }
  }
  /** Sample every frame the restarting row is on screen, until it is retired. */
  const sampleWhileRestarting = async (label) => {
    const restarting = (t) => t.startsWith('Restarting workspace')
    const deadline = Date.now() + 120_000
    const samples = []
    while (Date.now() < deadline) {
      const shape = await page.evaluate(sidebarShape, MIXED)
      if (shape.all.some(restarting)) {
        if (samples.length === 0) await page.screenshot({ path: path.join(SHOTS, `group-restart-${label}.png`) })
        samples.push(shape)
      } else if (samples.length > 0) break
      await page.waitForTimeout(100)
    }
    check(`${label}: the restarting row appeared`, samples.length > 0)
    if (samples.length === 0) return
    const strayed = samples.filter((s) => !s.section.some(restarting)).length
    check(`${label}: it stays in the group section`, strayed === 0, `${strayed}/${samples.length} frames outside`)
    const jumped = samples.filter((s) => restarting(s.all[0])).length
    check(`${label}: it never reaches the top of the sidebar`, jumped === 0, `${jumped}/${samples.length} frames`)
    // The section's first `.group.relative` is its header.
    check(`${label}: the group holds the placeholder and its live member`,
      samples.every((s) => s.section.length >= 3), JSON.stringify(samples[0].section))
  }

  await page.goto(`${origin}/?project=${PROJECT}`)
  await section(MIXED).waitFor({ timeout: 20_000 })
  await page.waitForTimeout(1500)

  // 1. Counts.
  check(`${MIXED} header reads (1/2)`, (await caret(MIXED).innerText()).includes('(1/2)'))
  check(`${STOPPED} header reads (0/1)`, (await caret(STOPPED).innerText()).includes('(0/1)'))

  // 2. The mixed group's menu.
  check('stopped rows start hidden', await ghosts(MIXED).count() === 0)
  await openMenu(MIXED)
  const items = await page.getByRole('menuitem').allInnerTexts()
  const want = ['Rename', items.includes('Pin') ? 'Pin' : 'Unpin', 'Show stopped workspaces', 'Delete group']
  check('menu items', want.every((i) => items.includes(i)), items.join(', '))
  await page.screenshot({ path: path.join(SHOTS, 'group-menu.png') })
  await page.getByRole('menuitem', { name: 'Show stopped workspaces' }).click()
  await page.getByRole('menu').waitFor({ state: 'detached' })
  check('Show reveals the stopped rows', await ghosts(MIXED).count() === 1)
  await pick(MIXED, 'Hide stopped workspaces')
  check('Hide hides them again', await ghosts(MIXED).count() === 0)

  // 3. The all-stopped group: caret and menu are one toggle.
  check(`${STOPPED} starts collapsed`, await caret(STOPPED).getAttribute('aria-expanded') === 'false')
  await caret(STOPPED).click()
  check('the caret shows the stopped rows', await ghosts(STOPPED).count() === 1)
  await pick(STOPPED, 'Hide stopped workspaces')
  check('menu Hide hides them', await ghosts(STOPPED).count() === 0)
  check('...and collapses the caret', await caret(STOPPED).getAttribute('aria-expanded') === 'false')
  await pick(STOPPED, 'Show stopped workspaces')
  check('menu Show expands the caret', await caret(STOPPED).getAttribute('aria-expanded') === 'true')
  await caret(STOPPED).click()
  check('the caret hides them again', await ghosts(STOPPED).count() === 0)

  // 4a. Restart A from its ghost row, as a user does.
  await showGhosts(MIXED)
  const ghost = section(MIXED).locator('div.group.relative', { has: page.locator(ghostButton) }).first()
  await ghost.hover()
  await ghost.getByRole('button', { name: 'Restart workspace' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Restart', exact: true }).click()
  await sampleWhileRestarting('clicked')

  // 4b. Restart A over the API, so only the server's snapshot row is drawn.
  await untilShape((s) => !s.all.some((t) => t.startsWith('Restarting')), 'the restart to finish')
  await stop(A)
  await showGhosts(MIXED)
  await untilShape((s) => s.section.some((t) => t.includes('stopped')), 'the ghost row again')
  const streamed = fetch(`${origin}/api/workspace/restart`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: A }),
  }).then((res) => res.text())
  await sampleWhileRestarting('server')
  await streamed
} finally {
  await browser.close()
  await Promise.allSettled([A, B].map(stop))
  const { groups } = await api(`/workspace/group/list?project=${PROJECT}`)
  for (const g of groups.filter((x) => x.name === MIXED || x.name === STOPPED)) {
    await post('/workspace/group/delete', { projectSlug: PROJECT, groupId: g.groupId })
  }
}
finish()
