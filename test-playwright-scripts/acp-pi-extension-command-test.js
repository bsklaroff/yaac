/*
 * Verifies that a pi acp turn running one of pi's extension slash commands
 * ends, in real Chromium against a live pi workspace: sending `/status`
 * from the chat composer leaves the pane idle (no "Stop turn") and the
 * workspace back at `waiting`. pi starts no run for an extension command,
 * so pi-acp ends that turn only as dockerfiles/agent-patches/pi-acp.js
 * patches it; unpatched, the pane stays busy forever. No model call.
 *
 * Needs a pi extension registering `/status` in the project's pi agent dir
 * (`<data dir>/global/projects/<project id>/pi/agent/extensions/` under
 * containerless), which seeds each new workspace's own, BEFORE the
 * workspace starts, e.g.:
 *
 *   export default function (pi) {
 *     pi.registerCommand('status', { handler: async () =>
 *       pi.sendMessage({ customType: 'status', content: 'ok', display: true }) })
 *   }
 *
 * Run: WORKSPACE_ID=<live pi acp workspace> \
 *        node test-playwright-scripts/acp-pi-extension-command-test.js
 */
import path from 'node:path'
import { SHOTS, api, check, finish, origin, requirePlaywright } from './lib.js'

const { workspaces } = await api('/workspace/list')
const workspace = workspaces.find((w) => w.workspaceId.startsWith(process.env.WORKSPACE_ID ?? '-'))
if (!workspace) throw new Error(`set WORKSPACE_ID to a live pi acp workspace`)

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
  page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))
  await page.goto(`${origin}/?project=${workspace.projectId}&workspace=${workspace.workspaceId}`)
  const box = page.getByPlaceholder('Message the agent…').filter({ visible: true })
  await box.waitFor({ state: 'visible', timeout: 60_000 })
  const stop = page.getByRole('button', { name: 'Stop turn', exact: true }).filter({ visible: true })

  await box.fill('/status')
  await page.getByRole('button', { name: 'Send', exact: true }).filter({ visible: true }).click()
  // Idle for 3s straight within 30s: the turn ended rather than not yet began.
  let idleSince = 0
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await stop.count() > 0) idleSince = 0
    else if (idleSince === 0) idleSince = Date.now()
    else if (Date.now() - idleSince > 3000) break
    await page.waitForTimeout(200)
  }
  await page.screenshot({ path: path.join(SHOTS, 'pi-extension-command.png') })
  check('the /status turn ends, leaving no Stop', await stop.count() === 0)
  const after = (await api('/workspace/list')).workspaces.find((w) => w.workspaceId === workspace.workspaceId)
  check('the workspace is back at waiting', after?.status === 'waiting', `status ${after?.status}`)
} finally {
  await browser.close()
}
finish()
