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
 *     "None" hides Start, Model and UI.
 *
 * Needs a running `yaac server` with project PROJECT (default `yaac`), a
 * running workspace MULTI (id prefix) holding at least one `acp` and one
 * `tui` session, and a running workspace EMPTY (id prefix) with none
 * (`yaac workspace create <project> --no-session`). Nothing is created or
 * closed.
 *
 * Run: MULTI=<id> EMPTY=<id> node test-playwright-scripts/multi-session-workspace-test.js
 */
import path from 'node:path'
import { SHOTS, api, check, finish, origin, requirePlaywright, resolveProject } from './lib.js'

const { chromium } = requirePlaywright()
const project = await resolveProject(process.env.PROJECT ?? 'yaac')
const listing = await api(`/workspace/list?project=${project.id}`)
const all = listing.workspaces ?? listing
const find = (prefix) => all.find((w) => w.workspaceId.startsWith(prefix))
const multi = find(process.env.MULTI ?? '')
const empty = find(process.env.EMPTY ?? '')
if (!multi || !empty || multi.sessions.length < 2) throw new Error('MULTI must name a running workspace with 2+ sessions, EMPTY one with none')
const nameOf = (w) => w.title ?? w.generatedTitle ?? w.prompt?.split('\n')[0] ?? w.workspaceId.slice(0, 8)

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
await page.goto(`${origin}/?project=${project.id}`)
await page.waitForTimeout(3000)


// 1. Sidebar rows.
const label = `${multi.sessions.length} sessions`
check(`multi-session row reads "${label}"`, await page.getByText(label, { exact: true }).count() === 1)
for (const s of multi.sessions) {
  const name = (s.title ?? s.prompt?.split('\n')[0] ?? '').slice(0, 8)
  check(`child row for session ${s.sessionId.slice(0, 8)} (${s.tool}/${s.mode})`, await page.getByText(name).count() > 0)
}
check('sessionless row reads "No agent"', await page.getByText('No agent').count() > 0)
await page.screenshot({ path: path.join(SHOTS, 'multi-session-sidebar.png') })

// 2. Session panes, opened from the child rows.
for (const mode of ['acp', 'tui']) {
  const s = multi.sessions.find((x) => x.mode === mode && x.exited !== true)
  if (!s) continue
  const name = (s.title ?? s.prompt?.split('\n')[0] ?? '').slice(0, 8)
  await page.getByText(name).first().click()
  await page.waitForTimeout(3000)
  // The workspace tiles every pane, so a chat is told by its composer and a
  // terminal by xterm, each present once that session's pane is open.
  const shown = mode === 'tui'
    ? await page.locator('.xterm-screen:visible').count()
    : await page.getByPlaceholder('Message the agent').count()
  check(`${mode} child row opens a ${mode === 'tui' ? 'terminal' : 'chat'} pane`, shown > 0)
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
const options = await where.locator('option').allTextContents()
check(`Where lists "${nameOf(multi)}"`, options.some((o) => o.includes(nameOf(multi).slice(0, 12))))
const agentOptions = async () => page.getByLabel('Agent').locator('option').allTextContents()
check('Agent offers None for a new workspace', (await agentOptions()).includes('None'))
await where.selectOption(multi.workspaceId)
await page.waitForTimeout(500)
for (const row of ['Start', 'Group', 'Timeout']) check(`aimed at a workspace, ${row} is hidden`, await page.getByLabel(row, { exact: true }).count() === 0)
check('aimed at a workspace, Base branch is hidden', await page.getByText('Base branch').count() === 0)
check('aimed at a workspace, Agent has no None', !(await agentOptions()).includes('None'))
await page.screenshot({ path: path.join(SHOTS, 'multi-session-create-where.png') })
await where.selectOption('')
await page.getByLabel('Agent').selectOption('')
await page.waitForTimeout(500)
for (const row of ['Start', 'UI']) check(`Agent None hides ${row}`, await page.getByLabel(row, { exact: true }).count() === 0)
check('Agent None hides Model', await page.getByText('Model', { exact: true }).count() === 0)
await page.screenshot({ path: path.join(SHOTS, 'multi-session-create-none.png') })


await browser.close()
finish()
