/*
 * Verifies, in real Chromium, that a shell opened beside an ACP chat pane
 * lands to the RIGHT of it when the workspace has no stored layout yet (a
 * fresh browser profile, so nothing in localStorage). The window sync must
 * hand the chat pane the `agent` fallback's column rather than re-append it.
 *
 *  1. The workspace opens on its chat pane alone.
 *  2. "New shell" adds a terminal column; the chat composer sits left of it,
 *     and the stored layout's first column is the chat pane.
 *
 * Changes the install it runs against, so use a scratch server (see lib.js).
 * With no WORKSPACE_ID it creates a TOOL (default `claude`) acp workspace on
 * PROJECT (default `yaac`) and stops it at the end; with one, it uses that
 * live acp workspace and leaves it running (killing the shell it opened).
 *
 * Run: YAAC_DATA_DIR=... node test-playwright-scripts/acp-new-shell-column-test.js
 */
import path from 'node:path'
import { SHOTS, api, check, createWorkspace, finish, origin, requirePlaywright, until } from './lib.js'

const PROJECT = process.env.PROJECT ?? 'yaac'
const TOOL = process.env.TOOL ?? 'claude'
const owned = !process.env.WORKSPACE_ID
const workspaceId = process.env.WORKSPACE_ID
  ?? await createWorkspace({ project: PROJECT, tool: TOOL, mode: 'acp', title: 'PW new shell column' })
const { workspaces } = await api('/workspace/list')
const workspace = workspaces.find((w) => w.workspaceId.startsWith(workspaceId))
if (!workspace) throw new Error(`no live workspace ${workspaceId}`)

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
  page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))
  await page.goto(`${origin}/?project=${workspace.projectSlug}&workspace=${workspace.workspaceId}`)
  const box = page.getByPlaceholder('Message the agent…')
  await box.waitFor({ state: 'visible', timeout: 120_000 })
  // Let the first terminals poll land, so the window sync has run.
  await page.waitForTimeout(3000)
  const visibleXterms = () => [...document.querySelectorAll('.xterm')]
    .filter((e) => e.getBoundingClientRect().width > 0).length
  check('the workspace opens on its chat pane alone', await page.evaluate(visibleXterms) === 0)
  await page.screenshot({ path: path.join(SHOTS, 'new-shell-1-before.png') })

  await page.locator('[title="New shell"]').click()
  await until(page, visibleXterms, undefined, 30_000)
  await page.waitForTimeout(1500)
  const geo = await page.evaluate(() => {
    const term = [...document.querySelectorAll('.xterm')].find((e) => e.getBoundingClientRect().width > 0)
    return {
      composerX: document.querySelector('textarea[placeholder]')?.getBoundingClientRect().x,
      terminalX: term?.getBoundingClientRect().x,
    }
  })
  console.log('  geometry:', JSON.stringify(geo))
  check('the new shell sits right of the chat pane', geo.composerX < geo.terminalX)
  const stored = await page.evaluate((id) => JSON.parse(localStorage.getItem('yaac.layouts.v2') ?? '{}')[id],
    workspace.workspaceId)
  console.log('  stored layout:', JSON.stringify(stored))
  check('the stored layout starts with the chat pane', stored?.[0]?.tabs[0]?.startsWith('acp:'))
  await page.screenshot({ path: path.join(SHOTS, 'new-shell-2-after.png') })

  if (!owned) {
    const shell = stored?.flatMap((g) => g.tabs).find((t) => !t.startsWith('acp:'))
    if (shell) await api(`/workspace/${workspace.workspaceId}/terminals/close`, { method: 'POST', body: { target: shell } })
  }
  console.log(`\nscreenshots: ${SHOTS}`)
} finally {
  await browser.close()
  if (owned) await api('/workspace/stop', { method: 'POST', body: { workspaceId: workspace.workspaceId } })
}
finish()
