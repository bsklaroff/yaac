/*
 * Verifies, for PR #432's server-kept unread dot, a workspace whose seen
 * waiting agent goes away while another agent works. Uses an idle claude
 * tui workspace titled RW-two (read, since A views it) and another titled
 * RW-one to move A to.
 *
 *  1. A views RW-two; a second claude window (`claude-2`) starts a 25s turn
 *     while the first agent stays waiting, so the workspace stays waiting.
 *  2. A moves to RW-one and the first agent's window is closed, so the
 *     workspace's status becomes claude-2's `running`.
 *  3. claude-2 finishes: a spell nobody has seen. Checks that it is unread.
 *
 * One cheap haiku turn. Closes RW-two's first agent window, so use a
 * throwaway workspace. SOCK is RW-two's tmux -S path, WSDIR its checkout.
 *
 * Run: SOCK=/tmp/yaac-.../x.sock WSDIR=<checkout> node test-playwright-scripts/waiting-unread-agent-closed.js
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { SHOTS, api, check, finish, origin, requirePlaywright, resolveProject } from './lib.js'

const SOCK = process.env.SOCK
if (!SOCK || !process.env.WSDIR) throw new Error('set SOCK and WSDIR for RW-two')
const project = await resolveProject(process.env.PROJECT ?? 'yaac')
const byTitle = async (title) => (await api('/workspace/list')).workspaces.find((w) => w.title === title)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(what, fn, ms = 90_000) {
  const deadline = Date.now() + ms
  for (;;) {
    if (await fn()) return true
    if (Date.now() > deadline) { console.log(`timed out: ${what}`); return false }
    await sleep(300)
  }
}
const tmux = (...args) => execFileSync('tmux', ['-S', SOCK, ...args]).toString()

const two = await byTitle('RW-two')
const { chromium } = requirePlaywright()
const browser = await chromium.launch()
const A = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
await A.goto(`${origin}/?project=${project.id}&workspace=${two.workspaceId}`)
await A.locator('button', { hasText: 'RW-two' }).first().waitFor()
const dot = async () => (await A.locator('button', { hasText: 'RW-two' }).first().locator('span.bg-amber-500').count()) > 0
check('server: RW-two seen while A views it', await waitFor('seen', async () => (await byTitle('RW-two'))?.waitingSeen === true, 15_000))

tmux('new-window', '-d', '-t', 'yaac', '-n', 'claude-2', '-c', process.env.WSDIR,
  'env -u TMUX CLAUDE_CODE_NO_FLICKER=1 claude --permission-mode bypassPermissions --model haiku')
await sleep(12_000)
tmux('send-keys', '-t', 'yaac:claude-2', '-l',
  'Run this exact bash command in the foreground: python3 -c "import time; time.sleep(25)" — then reply done.')
tmux('send-keys', '-t', 'yaac:claude-2', 'Enter')
await sleep(6000)
console.log(`claude-2 working: status=${(await byTitle('RW-two')).status}`)

await A.locator('button', { hasText: 'RW-one' }).first().click()
tmux('kill-window', '-t', 'yaac:claude')
check('RW-two running once its waiting agent is gone',
  await waitFor('running', async () => (await byTitle('RW-two')).status === 'running', 15_000))
check('RW-two waiting again after claude-2 finishes',
  await waitFor('waiting', async () => (await byTitle('RW-two')).status === 'waiting'))
await sleep(2000)
const after = await byTitle('RW-two')
await A.screenshot({ path: path.join(SHOTS, '6-agent-closed-A.png') })
check('server: the new spell is unread (fails if the bug is present)', after.waitingSeen !== true)
check('A: dot on RW-two (fails if the bug is present)', await dot())

await browser.close()
finish()
