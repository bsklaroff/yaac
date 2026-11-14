/*
 * Verifies in Chromium how the webapp shows a workspace's sessions
 * (docs/sessions.md, "The webapp"):
 *
 *  1. Sidebar: a workspace with several sessions reads "N sessions" and
 *     lists a child row per session; one with none reads "No agent".
 *  2. Session panes: clicking a child row opens the workspace on that
 *     session's pane, a chat for an `acp` session and a terminal for a
 *     `tui` one, and each session has a "Close session" button in the tab bar.
 *  3. A workspace with no session shows the empty-workspace pane.
 *  4. The new-workspace pane: Where lists the running workspaces, and aiming
 *     it at one hides the workspace-only rows (Start, Group, Timeout, Base
 *     branch) and drops Agent's "None"; with Where on "New workspace", Agent
 *     "None" hides Start, UI and the composer's settings pill.
 *
 * Needs a running `yaac server` with project PROJECT (default `yaac`), a
 * running workspace MULTI (id prefix) holding at least one `acp` and one
 * `tui` session, each started with a prompt (`-p`) so its sidebar row has a
 * name to find, and a running workspace EMPTY (id prefix) with none
 * (`yaac workspace create <project> --no-session`). Nothing is created or
 * closed.
 *
 * Titles land while an agent works, so names are read from a fresh listing
 * where they are used, by the rules the sidebar and Where follow.
 *
 * Run: MULTI=<id> EMPTY=<id> node test-playwright-scripts/multi-session-workspace-test.js
 */
import path from 'node:path'
import { SHOTS, api, check, finish, origin, requirePlaywright, resolveProject } from './lib.js'

const { chromium } = requirePlaywright()
const project = await resolveProject(process.env.PROJECT ?? 'yaac')
const find = async (prefix) => {
  const listing = await api(`/workspace/list?project=${project.id}`)
  return (listing.workspaces ?? listing).find((w) => w.workspaceId.startsWith(prefix))
}
const multi = await find(process.env.MULTI ?? '')
const empty = await find(process.env.EMPTY ?? '')
if (!multi || !empty || multi.sessions.length < 2) throw new Error('MULTI must name a running workspace with 2+ sessions, EMPTY one with none')
if (multi.sessions.some((s) => !s.title && !s.prompt)) throw new Error('every MULTI session needs a prompt')
/** Its name now: a session's sidebar row, or a workspace's Where option. */
const sessionName = async (id) => {
  const s = (await find(multi.workspaceId)).sessions.find((x) => x.sessionId === id)
  return s.title ?? s.prompt.split('\n')[0]
}
const workspaceName = async () => {
  const w = await find(multi.workspaceId)
  return w.title || w.prompt || 'New workspace'
}
/** The sidebar row of session `id`, found by its name: the last match, since
 *  child rows follow the workspace's own row, which may share the title. */
const sessionRow = async (id) => page.locator('aside button', { hasText: await sessionName(id) }).last()

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
await page.goto(`${origin}/?project=${project.id}`)
await page.waitForTimeout(3000)


// 1. Sidebar rows.
const label = `${multi.sessions.length} sessions`
check(`multi-session row reads "${label}"`, await page.getByText(label, { exact: true }).count() === 1)
for (const s of multi.sessions) {
  check(`child row for session ${s.sessionId.slice(0, 8)} (${s.tool}/${s.mode})`, await (await sessionRow(s.sessionId)).count() > 0)
}
check('sessionless row reads "No agent"', await page.getByText('No agent').count() > 0)
await page.screenshot({ path: path.join(SHOTS, 'multi-session-sidebar.png') })

// 2. Session panes, opened from the child rows.
for (const mode of ['acp', 'tui']) {
  const s = multi.sessions.find((x) => x.mode === mode && x.exited !== true)
  if (!s) continue
  await (await sessionRow(s.sessionId)).click()
  // The workspace tiles every pane, so a chat is told by its composer and a
  // terminal by xterm, each present once that session's pane is open.
  const pane = mode === 'tui' ? page.locator('.xterm-screen:visible') : page.getByPlaceholder('Message the agent')
  const shown = await pane.first().waitFor({ timeout: 15_000 }).then(() => true, () => false)
  check(`${mode} child row opens a ${mode === 'tui' ? 'terminal' : 'chat'} pane`, shown)
  await page.screenshot({ path: path.join(SHOTS, `multi-session-${mode}-pane.png`) })
}
check('each session has a close button in the tab bar',
  await page.locator('[aria-label^="Close session"]').count() >= multi.sessions.filter((s) => s.exited !== true).length)

// 3. The sessionless workspace.
await page.getByText('No agent').first().click()
await page.waitForTimeout(2500)
await page.screenshot({ path: path.join(SHOTS, 'multi-session-empty-workspace.png') })
check('sessionless workspace shows no terminal pane', await page.locator('.xterm-screen:visible').count() === 0)

// 4. The new-workspace pane.
await page.goto(`${origin}/?project=${project.id}`)
await page.waitForTimeout(3000)
const where = page.getByLabel('Where')
check('Where is shown', await where.count() === 1)
const option = await where.locator(`option[value="${multi.workspaceId}"]`).textContent()
const wsName = await workspaceName()
check(`Where lists "${wsName}"`, option?.includes(wsName.slice(0, 12)) === true, String(option))
const agentOptions = async () => page.getByLabel('Agent', { exact: true }).locator('option').allTextContents()
check('Agent offers None for a new workspace', (await agentOptions()).includes('None'))
await where.selectOption(multi.workspaceId)
await page.waitForTimeout(500)
for (const row of ['Start', 'Group', 'Timeout']) check(`aimed at a workspace, ${row} is hidden`, await page.getByLabel(row, { exact: true }).count() === 0)
check('aimed at a workspace, Base branch is hidden', await page.getByText('Base branch').count() === 0)
check('aimed at a workspace, Agent has no None', !(await agentOptions()).includes('None'))
await page.screenshot({ path: path.join(SHOTS, 'multi-session-create-where.png') })
await where.selectOption('')
await page.getByLabel('Agent', { exact: true }).selectOption('')
await page.waitForTimeout(500)
for (const row of ['Start', 'UI']) check(`Agent None hides ${row}`, await page.getByLabel(row, { exact: true }).count() === 0)
check('Agent None hides the settings pill', await page.getByRole('button', { name: 'Agent settings' }).count() === 0)
await page.screenshot({ path: path.join(SHOTS, 'multi-session-create-none.png') })


await browser.close()
finish()
