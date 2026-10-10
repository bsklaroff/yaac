/*
 * Verifies that a chat pane's bottom bar, where the live composer sits, also
 * carries what used to be pinned to the top:
 *
 *  1. live, a subagent's view shows its title bar (Back, name, state) at the
 *     bottom of the pane in the composer's place;
 *  2. stopped, the width/condensed toggles and Restart sit in a bar at the
 *     bottom, not in the title bar, and the facts line ("Agent …") starts
 *     flush with the title;
 *  3. stopped, a subagent's view puts its title bar in that bar's place,
 *     with the view toggles beneath Back, and labels the subagent's
 *     instructions, drawn like a user prompt.
 *
 * Costs a cent or so. With no WORKSPACE_ID it creates a claude acp workspace
 * on PROJECT (default `yaac`); with one, it uses that workspace, which must
 * have been given PROMPT below and be running. Either way the workspace is
 * left stopped.
 *
 * Run: node test-playwright-scripts/chat-bottom-bars.js
 */
import path from 'node:path'
import { SHOTS, api, check, createWorkspace, finish, origin, requirePlaywright, until } from './lib.js'

const PROJECT = process.env.PROJECT ?? 'yaac'
const PROMPT = 'Use the Agent tool (description "list docs") to have a subagent list the files in docs/ (just ls). '
  + 'Then reply "done".'

const workspaceId = process.env.WORKSPACE_ID ?? await createWorkspace({
  project: PROJECT, tool: 'claude', model: 'haiku', mode: 'acp', permissionMode: 'bypass', prompt: PROMPT,
})
const { workspaces } = await api('/workspace/list')
const workspace = workspaces.find((w) => w.workspaceId.startsWith(workspaceId))
if (!workspace) throw new Error(`no live workspace ${workspaceId}`)
const url = `${origin}/?project=${workspace.projectId}&workspace=${workspace.workspaceId}`

const { chromium } = requirePlaywright()
const browser = await chromium.launch()

/** Whether `locator`'s box sits in the bottom quarter of the viewport. */
const atBottom = async (locator) => {
  const box = await locator.boundingBox()
  return box !== null && box.y > 900 * 0.75
}

async function openPage() {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
  page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))
  await page.goto(url)
  return page
}

/** Open the subagent's card, unfolding a condensed view first. */
async function openSubagent(page) {
  const folded = page.getByRole('button', { name: /^\s*1 subagent/ })
  if (await folded.count() > 0) await folded.first().click()
  await page.getByRole('button', { name: /^Agent\s*list docs/ }).first().click()
  return page.getByRole('button', { name: /^Back/ })
}

try {
  const live = await openPage()
  await live.getByPlaceholder('Message the agent…').waitFor({ state: 'visible', timeout: 120_000 })
  // The turn is over once nothing says "working" and the card is in.
  await until(live, () => /subagent/.test(document.body.innerText) && !/\bworking\b/.test(document.body.innerText),
    undefined, 180_000)
  const liveBack = await openSubagent(live)
  await liveBack.waitFor({ timeout: 10_000 })
  check('live: the subagent title bar sits at the bottom', await atBottom(liveBack))
  check('live: the composer gives way to it', await live.getByPlaceholder('Message the agent…').count() === 0)
  await live.screenshot({ path: path.join(SHOTS, 'bottom-bars-live-subagent.png') })
  await live.context().close()

  await api('/workspace/stop', { method: 'POST', body: { workspaceId: workspace.workspaceId } })

  const stopped = await openPage()
  const restart = stopped.getByRole('button', { name: 'Restart', exact: true })
  await restart.waitFor({ timeout: 60_000 })
  check('stopped: Restart sits at the bottom', await atBottom(restart))
  check('stopped: the toggles sit at the bottom',
    await atBottom(stopped.getByRole('button', { name: /Show (every step|key messages only)/ })))
  const title = await stopped.locator('main header span.font-medium').boundingBox()
  const agent = await stopped.locator('main dl dt').first().boundingBox()
  check('stopped: the facts line starts flush with the title',
    title !== null && agent !== null && Math.abs(title.x - agent.x) < 1, JSON.stringify({ title, agent }))
  await stopped.screenshot({ path: path.join(SHOTS, 'bottom-bars-stopped.png') })
  const stoppedBack = await openSubagent(stopped)
  await stoppedBack.waitFor({ timeout: 10_000 })
  check('stopped: the subagent title bar sits at the bottom', await atBottom(stoppedBack))
  check('stopped: it takes the Restart bar\'s place', await restart.count() === 0)
  const toggle = stopped.getByRole('button', { name: /Show (every step|key messages only)/ })
  const toggleBox = await toggle.boundingBox()
  const backBox = await stoppedBack.boundingBox()
  check('stopped: the subagent view keeps the toggles, beneath Back',
    toggleBox !== null && backBox !== null && toggleBox.y > backBox.y)
  check('stopped: the subagent\'s instructions are labeled',
    await stopped.getByText('Subagent instructions:').count() === 1)
  await stopped.screenshot({ path: path.join(SHOTS, 'bottom-bars-stopped-subagent.png') })
} finally {
  await browser.close()
}
finish()
