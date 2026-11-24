/*
 * Verifies in Chromium the "N stopped conversations" entry to a running
 * workspace's History pane (docs/sessions.md, "History"):
 *
 *  1. The ⋯ menu leads with "N stopped conversations", N being the
 *     conversations no running agent holds, on one line at desktop and
 *     phone widths, inside the viewport.
 *  2. It opens History with one tab per counted conversation, a closed
 *     agent's tab named for that agent's title.
 *  3. With no agent left, the empty-workspace pane's buttons, the same
 *     label among them, stay inside a phone's width.
 *
 * Needs a running `yaac server` and a running workspace WS (id prefix) with
 * one open agent and at least one stopped one, the stopped agent TITLED
 * renamed to TITLED_NAME (fake-credential claude agents opened with
 * `yaac workspace create --workspace <id> -t claude --mode tui`, renamed with
 * POST /api/workspace/<id>/sessions/<sid>/title, then all but one stopped
 * with `yaac workspace stop --agent <sid>`). Step 3 stops the last agent.
 *
 * Run: WS=<id> TITLED_NAME="Parser fix" node test-playwright-scripts/stopped-conversations-label.js
 */
import path from 'node:path'
import { SHOTS, api, check, finish, origin, requirePlaywright } from './lib.js'

const { chromium } = requirePlaywright()
const listing = async () => {
  const l = await api('/workspace/list')
  return (l.workspaces ?? l).find((w) => w.workspaceId.startsWith(process.env.WS ?? '-'))
}
const ws = await listing()
if (!ws || ws.sessions.length !== 1) throw new Error('WS must name a running workspace with exactly one open agent')
const id = ws.workspaceId
const titled = process.env.TITLED_NAME ?? 'Parser fix'
const stopped = ws.conversations.filter((c) => !c.active && !ws.sessions.some((s) => s.conversationId === c.conversationId))
const label = `${stopped.length} stopped ${stopped.length === 1 ? 'conversation' : 'conversations'}`
const url = `${origin}/?project=${ws.projectId}&workspace=${id}`

/** Whether menu item `el` sits inside the viewport and is no taller than
 *  the one-line "New agent" item, so its label has not wrapped. */
const fits = async (page, el) => {
  const ref = (await page.getByRole('menuitem', { name: 'New agent' }).boundingBox())?.height ?? 0
  return el.evaluate((node, height) => {
    const r = node.getBoundingClientRect()
    return r.left >= 0 && r.right <= window.innerWidth && r.height <= height + 1
  }, ref)
}

const browser = await chromium.launch()
for (const [name, opts] of [
  ['desktop', { viewport: { width: 1400, height: 900 } }],
  ['phone', { viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true }],
]) {
  const page = await browser.newPage(opts)
  await page.addInitScript(() => localStorage.setItem('yaac.viewmode.v1', 'tabs'))
  await page.goto(url)
  await page.waitForTimeout(3000)
  await page.getByRole('button', { name: 'More pane actions' }).click()
  await page.waitForTimeout(400)
  const items = await page.getByRole('menuitem').allTextContents()
  const item = page.getByRole('menuitem', { name: label })
  check(`${name}: the menu leads with "${label}"`, items[0] === label, JSON.stringify(items.slice(0, 3)))
  check(`${name}: it fits on one line in the viewport`, await item.count() === 1 && await fits(page, item))
  await page.screenshot({ path: path.join(SHOTS, `stopped-conversations-menu-${name}.png`) })
  await item.click()
  await page.waitForTimeout(1500)
  const tabs = await page.getByRole('tab').allTextContents()
  check(`${name}: History has one tab per counted conversation`,
    stopped.length === 1 ? await page.getByRole('button', { name: /^Resume$/ }).count() === 1 : tabs.length === stopped.length,
    JSON.stringify(tabs))
  if (stopped.length > 1) check(`${name}: a closed agent's tab is named "${titled}"`, tabs.some((t) => t.includes(titled)))
  await page.screenshot({ path: path.join(SHOTS, `stopped-conversations-history-${name}.png`) })
  await page.close()
}

// 3. Stop the last agent: the empty-workspace pane offers the same label.
await api(`/workspace/${id}/sessions/${ws.sessions[0].sessionId}/close`, { method: 'POST' })
const emptyLabel = `${stopped.length + 1} stopped conversations`
const phone = await browser.newPage({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true })
await phone.addInitScript(() => localStorage.setItem('yaac.viewmode.v1', 'tabs'))
await phone.goto(url)
// The closed conversation counts once the server sees its agent gone.
const button = phone.getByRole('button', { name: emptyLabel })
await button.waitFor({ timeout: 60_000 }).catch(() => {})
check(`phone: the empty workspace offers "${emptyLabel}"`, await button.count() === 1)
const buttons = phone.locator('button', { hasText: /^(New agent|New shell|\d+ stopped conversations?)$/ })
const inside = await buttons.evaluateAll((els) => els.every((el) => {
  const r = el.getBoundingClientRect()
  return r.left >= 0 && r.right <= window.innerWidth
}))
check('phone: the empty workspace\'s buttons stay inside the viewport', await buttons.count() === 3 && inside)
await phone.screenshot({ path: path.join(SHOTS, 'stopped-conversations-empty-phone.png') })

await browser.close()
finish()
