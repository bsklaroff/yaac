/*
 * Verifies in Chromium a workspace's History pane (docs/sessions.md,
 * "History"):
 *
 *  1. With every conversation held by an open session, the bar offers no
 *     History button.
 *  2. Closing one session brings History in; it opens the closed
 *     conversation read-only, with a Resume button.
 *  3. Resume opens a new session on it, focuses that session's pane, and
 *     History leaves the bar once nothing is closed. A History pane still
 *     open (or restored by a reload) reads "No earlier conversations".
 *  4. Resume clicked again as soon as it re-enables: counts the sessions
 *     the conversation ends up in (more than one is a duplicate resume).
 *  5. With every session closed, the empty-workspace pane's "Earlier
 *     conversations" button opens History.
 *  6. At a phone's width, the ⋯ menu offers "Conversation history".
 *
 * Needs a running `yaac server` and a running workspace WS (id prefix)
 * holding at least two open sessions with conversations (fake-credential
 * agents do: `yaac workspace create <project> -t claude --mode acp -p …`,
 * then `yaac workspace create -w <id> …`). It closes and resumes sessions
 * there, and leaves every session closed.
 *
 * Run: WS=<id> node test-playwright-scripts/history-pane.js
 */
import path from 'node:path'
import { SHOTS, api, check, finish, origin, requirePlaywright } from './lib.js'

const { chromium } = requirePlaywright()
const listing = async () => {
  const l = await api('/workspace/list')
  return (l.workspaces ?? l).find((w) => w.workspaceId.startsWith(process.env.WS ?? '-'))
}
const ws = await listing()
if (!ws || ws.sessions.length < 2) throw new Error('WS must name a running workspace with 2+ open sessions')
const id = ws.workspaceId
const close = (sessionId) => api(`/workspace/${id}/sessions/${sessionId}/close`, { method: 'POST' })
/** Poll the listing until `pred` holds; answers with the workspace. */
const waitFor = async (pred, what, ms = 60_000) => {
  const deadline = Date.now() + ms
  for (;;) {
    const w = await listing()
    if (pred(w)) return w
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 500))
  }
}
const held = (w, conversationId) => w.sessions.filter((s) => s.conversationId === conversationId)

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
// Tabs mode shows only the focused pane, so what is visible is what has focus.
await page.addInitScript(() => localStorage.setItem('yaac.viewmode.v1', 'tabs'))
await page.goto(`${origin}/?project=${ws.projectId}&workspace=${id}`)
await page.waitForTimeout(3000)
// The bar's button, told from the History pane's own tab by its title.
const historyButton = page.getByTitle('Read or resume closed sessions\' conversations')
const resumeButton = page.getByRole('button', { name: /^(Resume|Resuming…)$/ })
const composerShown = async () => await page.getByPlaceholder(/Message the agent|Connecting|Reconnecting/).filter({ visible: true }).count() > 0

// 1. Nothing closed.
check('no History button while every conversation is held', await historyButton.count() === 0)

// 2. Close the second session.
const victim = ws.sessions[1]
const conversationId = victim.conversationId
await close(victim.sessionId)
const t0 = Date.now()
await historyButton.waitFor({ timeout: 60_000 }).catch(() => {})
check('History appears once a session is closed', await historyButton.count() === 1, `${Date.now() - t0} ms`)
await historyButton.click()
await page.waitForTimeout(2000)
const prompt = victim.prompt ?? ''
check('History pane opens on the closed conversation',
  prompt === '' || await page.getByText(prompt.slice(0, 20)).count() > 0)
check('History pane offers Resume', await resumeButton.count() === 1)
await page.screenshot({ path: path.join(SHOTS, 'history-pane-open.png') })

// 3. Resume it.
await resumeButton.click()
const resumed = await waitFor((w) => held(w, conversationId).length > 0, 'the resumed session')
const newSession = held(resumed, conversationId)[0]
await page.waitForTimeout(2000)
check('the resumed session\'s pane takes focus', await composerShown()
  && await page.getByText('No earlier conversations').filter({ visible: true }).count() === 0)
check('History leaves the bar once nothing is closed', await historyButton.count() === 0)
await page.screenshot({ path: path.join(SHOTS, 'history-pane-resumed.png') })
await page.getByText('History', { exact: true }).filter({ visible: true }).first().click().catch(() => {})
await page.waitForTimeout(500)
check('an open History pane with nothing closed reads "No earlier conversations"',
  await page.getByText('No earlier conversations').count() === 1)
await page.reload()
await page.waitForTimeout(3000)
await page.getByText('History', { exact: true }).filter({ visible: true }).first().click().catch(() => {})
await page.waitForTimeout(500)
check('a reload with History in the saved layout degrades to its empty state',
  await page.getByText('No earlier conversations').count() === 1)

// 4. Resume, then click again as soon as it re-enables.
await close(newSession.sessionId)
await historyButton.waitFor({ timeout: 60_000 })
await historyButton.click()
await resumeButton.waitFor()
await resumeButton.click()
const deadline = Date.now() + 8000
let reclicks = 0
while (Date.now() < deadline) {
  if (await resumeButton.count() === 1 && await resumeButton.isEnabled() && /^Resume$/.test(await resumeButton.innerText())) {
    await resumeButton.click().then(() => reclicks++).catch(() => {})
  }
  await page.waitForTimeout(25)
}
await page.waitForTimeout(3000)
const after = held(await listing(), conversationId)
check('a quick second Resume does not open a duplicate session', after.length === 1,
  `${after.length} session(s) hold it after ${reclicks} re-click(s)`)

// 5. Close every session: the empty-workspace pane.
for (const s of (await listing()).sessions) await close(s.sessionId)
await waitFor((w) => w.sessions.length === 0, 'every session to close')
await page.reload()
await page.waitForTimeout(3000)
// Close a restored History pane so the empty-workspace pane shows.
await page.getByRole('button', { name: 'Close History' }).click().catch(() => {})
await page.waitForTimeout(1000)
const earlier = page.getByRole('button', { name: 'Earlier conversations' })
await earlier.waitFor({ timeout: 60_000 }).catch(() => {})
check('the empty workspace offers "Earlier conversations"', await earlier.count() === 1)
await page.screenshot({ path: path.join(SHOTS, 'history-pane-empty-workspace.png') })
await earlier.click().catch(() => {})
await page.waitForTimeout(1500)
check('"Earlier conversations" opens History with Resume', await resumeButton.count() === 1)

// 6. A phone's width.
const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
await phone.goto(`${origin}/?project=${ws.projectId}&workspace=${id}`)
await phone.waitForTimeout(3000)
await phone.getByRole('button', { name: 'More pane actions' }).click()
await phone.waitForTimeout(500)
const item = phone.getByRole('menuitem', { name: 'Conversation history' })
check('the ⋯ menu offers "Conversation history"', await item.count() === 1)
await phone.screenshot({ path: path.join(SHOTS, 'history-pane-mobile-menu.png') })
await item.click().catch(() => {})
await phone.waitForTimeout(1500)
check('it opens History on a phone', await phone.getByRole('button', { name: /^Resume$/ }).count() === 1)
await phone.screenshot({ path: path.join(SHOTS, 'history-pane-mobile.png') })

await browser.close()
finish()
