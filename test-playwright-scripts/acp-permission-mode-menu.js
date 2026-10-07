/*
 * Verifies the ACP chat composer's permission-mode menu in real Chromium,
 * against a live claude agent, without sending it a prompt (no model call):
 *
 *  1. The composer shows the posture the workspace launched in.
 *  2. Clicking it lists the postures the session offers, the current one
 *     checked.
 *  3. Picking `plan` relabels the composer once the server's
 *     `session/set_mode` lands, and the workspace row follows it.
 *  4. Picking `accept-edits` moves it back.
 *
 * With no WORKSPACE_ID it creates a claude acp workspace in `accept-edits` on
 * PROJECT (default `yaac`) and stops it at the end; with one, it uses that
 * live claude acp workspace and leaves it running.
 *
 * Run: node test-playwright-scripts/acp-permission-mode-menu.js
 */
import path from 'node:path'
import { SHOTS, api, check, createWorkspace, finish, origin, requirePlaywright, until } from './lib.js'

const PROJECT = process.env.PROJECT ?? 'yaac'
const owned = !process.env.WORKSPACE_ID
const workspaceId = process.env.WORKSPACE_ID ?? await createWorkspace({
  project: PROJECT, tool: 'claude', mode: 'acp', permissionMode: 'accept-edits', title: 'PW permission mode',
})
const { workspaces } = await api('/workspace/list')
const workspace = workspaces.find((w) => w.workspaceId.startsWith(workspaceId))
if (!workspace) throw new Error(`no live workspace ${workspaceId}`)

/** The workspace row's recorded posture. */
async function rowPosture() {
  const listed = (await api('/workspace/list')).workspaces.find((w) => w.workspaceId === workspace.workspaceId)
  return listed?.permissionMode
}

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
  page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))
  await page.goto(`${origin}/?project=${workspace.projectId}&workspace=${workspace.workspaceId}`)
  const trigger = page.getByRole('button', { name: 'Permission mode', exact: true })
  await trigger.waitFor({ state: 'visible', timeout: 90_000 })

  // ---- 1. the launch posture ----
  check('the composer shows the launch posture', (await trigger.innerText()).trim() === 'Accept edits',
    await trigger.innerText())
  await page.screenshot({ path: path.join(SHOTS, 'perm-1-label.png') })

  // ---- 2. the menu ----
  await trigger.click()
  const items = page.getByRole('menuitemradio')
  await items.first().waitFor({ state: 'visible' })
  const labels = await items.evaluateAll((els) => els.map((e) => ({
    label: e.querySelector('span.text-text')?.textContent ?? '',
    checked: e.getAttribute('aria-checked') === 'true',
  })))
  console.log(`  offered: ${labels.map((l) => `${l.label}${l.checked ? '*' : ''}`).join(', ')}`)
  check('the menu offers plan and checks the current posture',
    labels.some((l) => l.label === 'Plan mode')
      && labels.filter((l) => l.checked).map((l) => l.label).join() === 'Accept edits')
  await page.screenshot({ path: path.join(SHOTS, 'perm-2-menu.png') })

  // ---- 3. switch to plan ----
  await items.filter({ hasText: 'Plan mode' }).click()
  const relabeled = await until(page, () => document.querySelector('[aria-label="Permission mode"]')
    ?.textContent.trim() === 'Plan mode', undefined, 15_000).then(() => true, () => false)
  check('picking plan relabels the composer', relabeled, await trigger.innerText())
  const deadline = Date.now() + 15_000
  while (await rowPosture() !== 'plan' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500))
  check('the workspace row follows to plan', await rowPosture() === 'plan', String(await rowPosture()))
  await page.screenshot({ path: path.join(SHOTS, 'perm-3-plan.png') })

  // ---- 4. and back ----
  await items.first().waitFor({ state: 'detached' })
  await trigger.click()
  await items.filter({ hasText: 'Accept edits' }).click()
  const back = await until(page, () => document.querySelector('[aria-label="Permission mode"]')
    ?.textContent.trim() === 'Accept edits', undefined, 15_000).then(() => true, () => false)
  check('picking accept-edits moves it back', back, await trigger.innerText())
  const errors = await page.evaluate(() => document.body.innerText.match(/would not switch[^\n]*/g) ?? [])
  check('no refusal was shown', errors.length === 0, errors.join(' | '))

  console.log(`\nscreenshots: ${SHOTS}`)
} finally {
  await browser.close()
  if (owned) await api('/workspace/stop', { method: 'POST', body: { workspaceId: workspace.workspaceId } })
}
finish()
