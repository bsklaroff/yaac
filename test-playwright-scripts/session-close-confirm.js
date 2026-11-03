/*
 * Verifies in Chromium that closing a session asks first (docs/sessions.md,
 * "The webapp"):
 *
 *  1. An idle session's tab × opens "Close …?" whose text reads "Its agent
 *     stops." (no "mid-turn"); Cancel keeps the session, Close closes it.
 *  2. The same through the close shortcut (Alt+W) on the focused tab.
 *  3. A busy session, by × and by Alt+W: the dialog reads "Its agent stops
 *     mid-turn."; Cancel keeps it, and Close closes it.
 *  4. An exited session closes at once, with no dialog, by its tab × and
 *     by its bar's "Close".
 *
 * A fake-credential dev server can't run a real turn, so the script marks
 * one session `running` by rewriting the `/events` snapshot frames in the
 * page, and titles every session by its id so its tab can be found. Close
 * requests go to the real server, and each check reads the real listing.
 *
 * Needs a running `yaac server` and a running workspace WS (id prefix)
 * holding at least four open `acp` sessions that are not mid-turn, plus two
 * whose agents have exited (kill their tmux panes' processes). Closes six
 * sessions.
 *
 * Run: WS=<id> node test-playwright-scripts/session-close-confirm.js
 */
import path from 'node:path'
import { SHOTS, api, check, finish, origin, requirePlaywright } from './lib.js'

const { chromium } = requirePlaywright()
const listed = async () => {
  const l = await api('/workspace/list')
  return (l.workspaces ?? l).find((w) => w.workspaceId.startsWith(process.env.WS ?? '-'))
}
const ws = await listed()
if (!ws) throw new Error('WS must name a running workspace')
const [exitedX, exitedBar] = ws.sessions.filter((s) => s.exited === true)
const live = ws.sessions.filter((s) => s.exited !== true && s.status !== 'running' && s.asking !== true)
if (!exitedBar || live.length < 4) throw new Error('need four idle sessions and two exited ones')
const [idleX, idleKey, busyX, busyKey] = live
const busy = new Set([busyX.sessionId, busyKey.sessionId])
const title = (s) => `S-${s.sessionId.slice(0, 8)}`

/** Title every session by its id; mark the busy ones `running`. */
function rewrite(node) {
  if (Array.isArray(node)) node.forEach(rewrite)
  else if (node && typeof node === 'object') {
    if (typeof node.sessionId === 'string' && 'mode' in node && 'window' in node) {
      node.title = `S-${node.sessionId.slice(0, 8)}`
      if (busy.has(node.sessionId)) node.status = 'running'
    }
    Object.values(node).forEach(rewrite)
  }
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
await page.routeWebSocket(/\/api\/events/, (client) => {
  const server = client.connectToServer()
  server.onMessage((m) => {
    const frame = JSON.parse(String(m))
    rewrite(frame)
    client.send(JSON.stringify(frame))
  })
  client.onMessage((m) => server.send(m))
})
await page.goto(`${origin}/?project=${ws.projectId}&workspace=${ws.workspaceId}`)
await page.getByRole('button', { name: `Close session ${title(idleX)}` }).waitFor({ timeout: 30_000 })

const dialog = page.getByRole('alertdialog')
const isOpen = async (s) => (await listed()).sessions.some((x) => x.sessionId === s.sessionId)
async function waitClosed(s) {
  for (let i = 0; i < 40 && await isOpen(s); i++) await page.waitForTimeout(250)
  return !await isOpen(s)
}
async function openBy(how, s) {
  if (how === '×') {
    const tab = page.getByRole('button', { name: `Close session ${title(s)}` })
    await tab.hover()
    await tab.click()
  } else {
    await page.getByRole('button', { name: title(s), exact: true }).click()
    await page.keyboard.press('Alt+KeyW')
  }
  await dialog.waitFor({ timeout: 5000 }).catch(() => {})
}

for (const [s, how, midTurn] of [[idleX, '×', false], [idleKey, 'Alt+W', false], [busyX, '×', true], [busyKey, 'Alt+W', true]]) {
  const what = `${midTurn ? 'busy' : 'idle'} session by ${how}`
  await openBy(how, s)
  const text = await dialog.isVisible() ? await dialog.innerText() : ''
  check(`${what}: dialog shows`, text.includes(`Close “${title(s)}”?`), text.split('\n')[0])
  check(`${what}: wording ${midTurn ? 'says' : 'omits'} "mid-turn"`,
    text.includes(midTurn ? 'Its agent stops mid-turn.' : 'Its agent stops. '))
  await page.screenshot({ path: path.join(SHOTS, `session-close-${midTurn ? 'busy' : 'idle'}-${how === '×' ? 'x' : 'key'}.png`) })
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await page.waitForTimeout(1000)
  check(`${what}: Cancel keeps it`, await isOpen(s)
    && await page.getByRole('button', { name: `Close session ${title(s)}` }).count() === 1)
  await openBy(how, s)
  await dialog.getByRole('button', { name: 'Close' }).click()
  check(`${what}: Close closes it`, await waitClosed(s))
}

// An exited session closes at once, by its tab × and by its bar.
await page.getByRole('button', { name: `Close session ${title(exitedX)}` }).hover()
await page.getByRole('button', { name: `Close session ${title(exitedX)}` }).click()
await page.waitForTimeout(300)
check('exited tab ×: no dialog', !await dialog.isVisible())
check('exited tab ×: closes at once', await waitClosed(exitedX))
await page.getByRole('button', { name: title(exitedBar), exact: true }).click()
const bar = page.getByText(/exited\.$/).locator('xpath=..')
await bar.getByRole('button', { name: 'Close' }).click()
await page.waitForTimeout(300)
check('exited bar: no dialog', !await dialog.isVisible())
check('exited bar: closes at once', await waitClosed(exitedBar))

await browser.close()
finish()
