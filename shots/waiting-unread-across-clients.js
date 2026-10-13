/*
 * Verifies the server-kept unread dot for waiting workspaces (PR #432)
 * across two browser contexts on one server, against two idle claude tui
 * workspaces titled RW-one and RW-two (create them, then
 * `yaac workspace rename <id> RW-one` etc.):
 *
 *  1. viewing RW-one in context A clears its dot in B;
 *  2. a turn on RW-one while nobody views it brings the dot back in both;
 *  3. a server restart while it is idle and read keeps it read;
 *  4. the race: A views RW-one with its mark POST delayed, leaves, a turn
 *     starts and finishes, then the POST lands and marks the new spell seen.
 *
 * Each turn is a few cheap haiku calls. Starts turns by typing into the
 * workspace's tmux socket (SOCK, the containerless workspace's tmux -S path).
 * Restarts the server with `yaac server restart`.
 *
 * Run: SOCK=/tmp/yaac-.../x.sock node test-playwright-scripts/waiting-unread-across-clients.js
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { SHOTS, api, check, finish, origin, requirePlaywright, resolveProject } from './lib.js'

const SOCK = process.env.SOCK
if (!SOCK) throw new Error('set SOCK to RW-one\'s tmux socket')
const project = await resolveProject(process.env.PROJECT ?? 'yaac')
const list = async () => (await api('/workspace/list')).workspaces
const byTitle = async (title) => (await list()).find((w) => w.title === title)
const one = await byTitle('RW-one')
const two = await byTitle('RW-two')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(what, fn, ms = 120_000) {
  const deadline = Date.now() + ms
  for (;;) {
    if (await fn()) return true
    if (Date.now() > deadline) { console.log(`timed out: ${what}`); return false }
    await sleep(300)
  }
}
const status = async (title) => (await byTitle(title))?.status
const serverSeen = async (title) => (await byTitle(title))?.waitingSeen === true

function sendTurn(prompt) {
  execFileSync('tmux', ['-S', SOCK, 'send-keys', '-t', 'yaac:claude', '-l', prompt])
  execFileSync('tmux', ['-S', SOCK, 'send-keys', '-t', 'yaac:claude', 'Enter'])
}
async function runTurn(prompt) {
  sendTurn(prompt)
  await waitFor('RW-one running', async () => (await status('RW-one')) === 'running', 60_000)
  const t0 = Date.now()
  await waitFor('RW-one waiting again', async () => (await status('RW-one')) === 'waiting', 300_000)
  return Date.now() - t0
}

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
const open = async () => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await ctx.newPage()
  await page.goto(`${origin}/?project=${project.id}&workspace=${two.workspaceId}`)
  await page.locator('button', { hasText: 'RW-one' }).first().waitFor()
  return page
}
const dot = async (page, title) => (await page.locator('button', { hasText: title }).first()
  .locator('span.bg-amber-500').count()) > 0
const waitDot = (page, want, ms = 20_000) =>
  waitFor(`dot=${want}`, async () => (await dot(page, 'RW-one')) === want, ms)
const select = (page, title) => page.locator('button', { hasText: title }).first().click()
const shot = async (a, b, name) => {
  await a.screenshot({ path: path.join(SHOTS, `${name}-A.png`) })
  await b.screenshot({ path: path.join(SHOTS, `${name}-B.png`) })
}

const A = await open()
const B = await open()

// 1. Viewing in A clears the dot in B.
check('precondition: RW-one waiting and unread on the server',
  (await status('RW-one')) === 'waiting' && !(await serverSeen('RW-one')))
check('B shows the dot before anyone views it', await waitDot(B, true))
await shot(A, B, '1-before-view')
await select(A, 'RW-one')
check('A: no dot once viewed', await waitDot(A, false))
check('B: dot clears after A views', await waitDot(B, false))
check('server: waitingSeen set', await waitFor('seen', () => serverSeen('RW-one'), 10_000))
await shot(A, B, '1-after-view')

// 2. A turn while nobody views it brings the dot back in both.
await select(A, 'RW-two')
const ms = await runTurn('Run these bash commands one at a time, each as its own tool call: sleep 15, then sleep 15, then sleep 15, then ls. Then reply done.')
console.log(`turn took ${ms}ms`)
check('A: dot back after the turn', await waitDot(A, true))
check('B: dot back after the turn', await waitDot(B, true))
await shot(A, B, '2-after-turn')
await select(A, 'RW-one')
check('B: clears again on a second view', await waitDot(B, false))
await select(A, 'RW-two')

// 3. A restart while idle and read keeps it read.
execFileSync('yaac', ['server', 'restart'], { stdio: 'inherit' })
await waitFor('health', async () => { try { return (await api('/health')).ready } catch { return false } }, 60_000)
await waitFor('RW-one classified', async () => (await status('RW-one')) === 'waiting', 60_000)
await sleep(5000)
await A.reload(); await B.reload()
await A.locator('button', { hasText: 'RW-one' }).first().waitFor()
await B.locator('button', { hasText: 'RW-one' }).first().waitFor()
await sleep(3000)
check('server: still seen after restart', await serverSeen('RW-one'))
check('A: no dot after restart', !(await dot(A, 'RW-one')))
check('B: no dot after restart', !(await dot(B, 'RW-one')))
await shot(A, B, '3-after-restart')

// 4. The race: a delayed mark lands after a new turn and hides its spell.
await runTurn('Reply with the single word: ready')
check('race setup: RW-one unread', await waitDot(B, true))
let landed = false
await A.route('**/api/workspace/mark-waiting-seen', async (route) => {
  await sleep(45_000)
  await route.continue()
  landed = true
})
await select(A, 'RW-one')
await sleep(1000)
await select(A, 'RW-two')
await runTurn('Run the bash command sleep 10, then reply done.')
check('race: B shows the new spell unread while the mark is in flight', await waitDot(B, true, 5000))
await shot(A, B, '4-race-before-landing')
await waitFor('mark landed', () => landed, 90_000)
await sleep(2000)
const hidden = !(await dot(B, 'RW-one')) && await serverSeen('RW-one')
check('race: the late mark leaves the new spell unread (fails if the bug is present)', !hidden)
await shot(A, B, '4-race-after-landing')

await browser.close()
finish()
