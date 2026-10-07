/*
 * Verifies that a claude subagent's own thread (its tool calls and its
 * reply) shows when its card is opened, in all three places a chat pane can
 * show it:
 *
 *  1. live, where the thread comes from the record as it happened;
 *  2. stopped, where the served transcript fills the thread in from the
 *     subagent's own claude transcript;
 *  3. restarted, where `session/load` replays the conversation without the
 *     thread and the pane reads it over its socket (`subagent-transcript`);
 *  4. stopped again, where the served transcript of that replayed record
 *     fills the thread in.
 *
 * In each, the view must list the subagent's two shell calls and end on its
 * report once, and the main conversation must show no shell call. The two
 * calls are made in parallel, which claude files as sibling entries that a
 * rebuilt thread must not drop.
 *
 * Costs a few cents. With no WORKSPACE_ID it creates a claude acp
 * workspace on PROJECT (default `yaac`); with one, it uses that workspace,
 * which must have been given PROMPT below. Either way the workspace is
 * stopped, restarted and left stopped.
 *
 * Run: node test-playwright-scripts/acp-replayed-subagent-thread.js
 */
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { SHOTS, api, check, createWorkspace, finish, origin, requirePlaywright, until } from './lib.js'

const PROJECT = process.env.PROJECT ?? 'yaac'
const PROMPT = 'Use the Agent tool (foreground) with subagent_type general-purpose, description "Survey packages", '
  + 'prompt: "In one message, make two Bash tool calls in parallel: ls packages, and wc -l package.json. Then reply '
  + 'with one sentence summarizing what you saw." When it returns, reply just "done".'

const owned = !process.env.WORKSPACE_ID
const workspaceId = process.env.WORKSPACE_ID ?? await createWorkspace({
  project: PROJECT, tool: 'claude', mode: 'acp', permissionMode: 'bypass', title: 'PW subagent thread', prompt: PROMPT,
})
const { workspaces } = await api('/workspace/list')
const workspace = workspaces.find((w) => w.workspaceId.startsWith(workspaceId))
if (!workspace) throw new Error(`no live workspace ${workspaceId}`)
const url = `${origin}/?project=${workspace.projectId}&workspace=${workspace.workspaceId}`

const { chromium } = requirePlaywright()
const browser = await chromium.launch()

/** How many shell-call rows are shown. Only the subagent runs commands,
 *  and a row shows the agent's description of its command, so rows are
 *  counted rather than matched by text. */
const shellRows = () => document.querySelectorAll('button[aria-expanded]:has(svg.lucide-square-terminal)').length

/** Open the subagent's card on a fresh page, check its view, screenshot it. */
async function checkThread(stage, ready) {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
  page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))
  await page.goto(url)
  await ready(page)
  // The agent's own reply; the prompt mentions "done" too.
  await until(page, () => document.body.innerText.split('\n').some((l) => l.trim() === 'done'), undefined, 180_000)
  // The condensed view folds the card away; unfold it.
  const folded = page.getByRole('button', { name: /^\s*1 subagent/ })
  if (await folded.count() > 0) await folded.first().click()
  check(`${stage}: the main conversation keeps the subagent's calls out`, await page.evaluate(shellRows) === 0)
  await page.getByRole('button', { name: /^Agent\s*Survey packages/ }).first().click()
  await page.getByRole('button', { name: /^Back/ }).waitFor({ timeout: 10_000 })
  const listed = await until(page, () => document.querySelectorAll('button[aria-expanded]:has(svg.lucide-square-terminal)').length >= 2, undefined, 30_000)
    .then(() => true, () => false)
  check(`${stage}: the subagent view lists its own calls`, listed)
  // The report is the view's last line of prose: not its task, and not a
  // command row.
  const report = await page.evaluate(() => {
    const lines = document.body.innerText.split('\n').map((l) => l.trim())
    const prose = lines.filter((l) => l.length > 40 && !l.includes('/') && !l.startsWith('Run the Bash'))
    const last = prose.at(-1) ?? ''
    return { last, count: lines.filter((l) => l === last).length }
  })
  check(`${stage}: the subagent view ends on its report, once`, report.last !== '' && report.count === 1, JSON.stringify(report))
  await page.screenshot({ path: path.join(SHOTS, `subagent-thread-${stage}.png`) })
  await page.context().close()
}

const composer = (page) => page.getByPlaceholder('Message the agent…').waitFor({ state: 'visible', timeout: 120_000 })
/** The stopped conversation, in the sidebar's Stopped workspaces dialog. */
const stoppedDialog = async (page) => {
  await page.locator('aside button:has-text("Stopped workspaces")').first().click()
  await page.getByRole('button', { name: /^Agent\s*Survey packages/ }).first().waitFor({ state: 'visible', timeout: 60_000 })
}
const stop = () => api('/workspace/stop', { method: 'POST', body: { workspaceId: workspace.workspaceId } })

try {
  await checkThread('live', composer)
  await stop()
  await checkThread('stopped', stoppedDialog)
  execFileSync('yaac', ['workspace', 'restart', workspace.workspaceId], { stdio: 'ignore', timeout: 300_000 })
  await checkThread('restarted', composer)
  await stop()
  await checkThread('restopped', stoppedDialog)
} finally {
  await browser.close()
  if (owned) await stop().catch(() => {})
}
finish()
