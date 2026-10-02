/*
 * Verifies a chat pane's subagent and background-task views against a live
 * claude acp workspace, and that ordinary tool calls still render as they
 * did before yaac asked for those reports:
 *
 *  1. a read still expands to the file's text;
 *  2. shell output that looks like Markdown is shown verbatim (no heading,
 *     no bold);
 *  3. a running background shell has a chip in the strip over the composer;
 *     opening it shows its output (read from its file) and no Stop, since
 *     claude stops a task only for an AIR client; Esc returns;
 *  4. the subagent's card opens its own transcript, with a Back header, and
 *     not the launch metadata its Agent call returns.
 *
 * The prompt makes one model call per step, so it costs a few cents. With no
 * WORKSPACE_ID it creates a claude acp workspace on PROJECT (default `yaac`)
 * and stops it at the end; with one, it uses that workspace, which must have
 * been given PROMPT below.
 *
 * Run: node test-playwright-scripts/acp-activity-views.js
 */
import path from 'node:path'
import { SHOTS, api, check, createWorkspace, finish, origin, requirePlaywright, until } from './lib.js'

const PROJECT = process.env.PROJECT ?? 'yaac'
const PROMPT = [
  'Do these in order, then reply "done" without waiting for the background shell:',
  '1) Read the first 5 lines of README.md.',
  "2) In the foreground run: printf '# not a heading\\n__init__ value_1\\n'",
  '3) With run_in_background=true run: for i in $(seq 1 300); do echo tick $i; sleep 1; done',
  '4) With the Agent tool (run_in_background=true, description "survey docs") have a subagent list the files in docs/.',
].join('\n')

const owned = !process.env.WORKSPACE_ID
const workspaceId = process.env.WORKSPACE_ID ?? await createWorkspace({
  project: PROJECT, tool: 'claude', mode: 'acp', permissionMode: 'bypass', title: 'PW activity views', prompt: PROMPT,
})
const { workspaces } = await api('/workspace/list')
const workspace = workspaces.find((w) => w.workspaceId.startsWith(workspaceId))
if (!workspace) throw new Error(`no live workspace ${workspaceId}`)

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
  page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))
  await page.goto(`${origin}/?project=${workspace.projectSlug}&workspace=${workspace.workspaceId}`)
  await page.getByPlaceholder('Message the agent…').waitFor({ state: 'visible', timeout: 60_000 })
  const strip = page.getByRole('group', { name: 'Running in the background' })
  // By kind: a running subagent is listed before the shell.
  const chip = strip.getByRole('button', { name: /^shell: / }).first()
  await chip.waitFor({ state: 'visible', timeout: 180_000 })
  await until(page, () => document.body.innerText.includes('survey docs'), undefined, 180_000)
  await page.screenshot({ path: path.join(SHOTS, 'activity-main.png') })

  // ---- 1. a read expands to its text ----
  const read = page.getByRole('button', { name: /README\.md/ }).first()
  await read.click()
  check('a read expands to the file it read', await read.getAttribute('aria-expanded') === 'true'
    && await page.locator('.diff-hl').filter({ hasText: 'Agent Container' }).count() > 0)

  // ---- 2. Markdown-looking shell output stays text ----
  await page.getByRole('button', { name: /not a heading/ }).first().click()
  const heading = await page.evaluate(() => [...document.querySelectorAll('h1, h2, strong, b')]
    .some((h) => /not a heading|init/.test(h.textContent ?? '')))
  check('shell output is not rendered as Markdown', !heading)

  // ---- 3. the background shell ----
  await chip.click()
  await page.getByRole('button', { name: /^Back/ }).waitFor({ timeout: 10_000 })
  await until(page, () => /tick \d+/.test(document.body.innerText), undefined, 30_000)
  check('the shell view shows its output', true)
  check('claude offers no Stop', await page.getByRole('button', { name: 'Stop', exact: true }).count() === 0)
  await page.screenshot({ path: path.join(SHOTS, 'activity-task.png') })
  await page.keyboard.press('Escape')
  check('Esc returns to the conversation',
    await page.getByPlaceholder('Message the agent…').isVisible({ timeout: 5_000 }).catch(() => false))

  // ---- 4. the subagent ----
  await page.getByRole('button', { name: /^Agent\s*survey docs/ }).first().click()
  await page.getByRole('button', { name: /^Back/ }).waitFor({ timeout: 10_000 })
  check('the subagent view has no composer', await page.getByPlaceholder('Message the agent…').count() === 0)
  check('the subagent view does not show its launch metadata as a report',
    !(await page.evaluate(() => document.body.innerText.includes('Async agent launched'))))
  // Its tool rows: disclosure buttons, expandable or not.
  await until(page, () => [...document.querySelectorAll('button[aria-expanded], button:disabled')]
    .some((b) => /docs/.test(b.textContent ?? '')), undefined, 120_000)
    .then(() => check('the subagent view lists its own calls', true), () => check('the subagent view lists its own calls', false))
  await page.screenshot({ path: path.join(SHOTS, 'activity-agent.png') })
} finally {
  await browser.close()
  if (owned) await api('/workspace/stop', { method: 'POST', body: { workspaceId } }).catch(() => {})
}
finish()
