/*
 * Verifies the workspace bar's containerless badge: it shows on a workspace
 * of a containerless server, and clicking it opens the popover explaining
 * that the workspace is not sandboxed. Screenshots the bar and the popover,
 * desktop and mobile, to $SCREENSHOT_DIR (default /tmp/yaac-shots).
 *
 * Needs a running containerless `yaac server` (see lib.js). Creates a
 * workspace in project $PROJECT (default "yaac") and stops it at the end,
 * unless one is named.
 *
 * Run: node test-playwright-scripts/containerless-badge.js [workspace-id]
 */
import { SHOTS, api, check, createWorkspace, finish, origin, requirePlaywright } from './lib.js'

const { chromium } = requirePlaywright()
const PROJECT = process.env.PROJECT ?? 'yaac'
const named = process.argv[2]
const workspaceId = named
  ?? await createWorkspace({ project: PROJECT, tool: 'claude', mode: 'tui', title: 'PW containerless badge' })
const { workspaces } = await api('/workspace/list')
const workspace = workspaces.find((w) => w.workspaceId.startsWith(workspaceId))
if (!workspace) throw new Error(`no live workspace ${workspaceId}`)
const url = `${origin}/?${new URLSearchParams({ project: workspace.projectId, workspace: workspace.workspaceId })}`

const browser = await chromium.launch()
try {
  for (const [name, viewport] of [['desktop', { width: 1400, height: 800 }], ['mobile', { width: 390, height: 800 }]]) {
    const page = await browser.newPage({ viewport })
    await page.goto(url)
    if (name === 'mobile') await page.getByText('PW containerless badge').first().click().catch(() => {})
    const badge = page.getByRole('button', { name: /Containerless workspace/ })
    await badge.waitFor({ timeout: 20_000 })
    check(`${name}: badge shows`, await badge.isVisible())
    await page.screenshot({ path: `${SHOTS}/containerless-badge-${name}.png` })
    await badge.click()
    const popup = page.getByText('Not sandboxed', { exact: true })
    await popup.waitFor({ timeout: 5_000 })
    check(`${name}: popover explains`, await page.getByText('yaac cluster install', { exact: true }).isVisible())
    // Let the popup's fade-in finish before the screenshot.
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${SHOTS}/containerless-badge-${name}-open.png` })
    await page.keyboard.press('Escape')
    await page.close()
  }
} finally {
  await browser.close()
  if (!named) await api('/workspace/stop', { method: 'POST', body: { workspaceId: workspace.workspaceId } })
}
finish()
