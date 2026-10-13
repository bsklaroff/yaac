/*
 * Verifies, for PR #432's server-kept unread dot, what a second agent's
 * turn does to a workspace whose waiting spell the user has already seen.
 * Uses an idle claude tui workspace titled RW-two and opens a second claude
 * window (`claude-2`) in its tmux; context A views RW-two the whole time.
 *
 *  1. claude-2 runs a turn with nobody viewing; then A views RW-two, marking
 *     the first agent's spell seen.
 *  2. claude-2 runs another turn while the first agent stays waiting. The
 *     workspace stays `waiting` with the same spell; checks whether the dot
 *     comes back, and whether A (still viewing) clears it again.
 *
 * Two cheap haiku turns. SOCK is RW-two's tmux -S path, WSDIR its checkout.
 *
 * Run: SOCK=/tmp/yaac-.../x.sock WSDIR=<checkout> node test-playwright-scripts/waiting-unread-second-agent.js
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { SHOTS, api, check, finish, origin, requirePlaywright, resolveProject } from './lib.js'

const SOCK = process.env.SOCK
if (!SOCK) throw new Error('set SOCK to RW-two\'s tmux socket')
const project = await resolveProject(process.env.PROJECT ?? 'yaac')
const byTitle = async (title) => (await api('/workspace/list')).workspaces.find((w) => w.title === title)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(what, fn, ms = 60_000) {
  const deadline = Date.now() + ms
  for (;;) {
    if (await fn()) return true
    if (Date.now() > deadline) { console.log(`timed out: ${what}`); return false }
    await sleep(300)
  }
}
const tmux = (...args) => execFileSync('tmux', ['-S', SOCK, ...args]).toString()

const two = await byTitle('RW-two')
const spell = two.waitingSinceMs
async function agentTurn(label) {
  tmux('send-keys', '-t', 'yaac:claude-2', '-l', 'Run the bash command ls, then reply done.')
  tmux('send-keys', '-t', 'yaac:claude-2', 'Enter')
  await sleep(4000)
  const mid = await byTitle('RW-two')
  console.log(`${label}, mid-turn: status=${mid.status} waitingSeen=${mid.waitingSeen} spell unchanged=${mid.waitingSinceMs === spell}`)
  await sleep(15_000)
}

// A second agent, whose first turn (nobody viewing) clears the mark.
tmux('new-window', '-d', '-t', 'yaac', '-n', 'claude-2', '-c', process.env.WSDIR,
  'env -u TMUX CLAUDE_CODE_NO_FLICKER=1 claude --permission-mode bypassPermissions --model haiku')
await sleep(12_000)
await agentTurn('turn 1, nobody viewing')

// A views RW-two and marks this spell.
const { chromium } = requirePlaywright()
const browser = await chromium.launch()
const A = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
await A.goto(`${origin}/?project=${project.id}&workspace=${two.workspaceId}`)
await A.locator('button', { hasText: 'RW-two' }).first().waitFor()
const dot = async () => (await A.locator('button', { hasText: 'RW-two' }).first().locator('span.bg-amber-500').count()) > 0
check('A viewing RW-two: no dot', await waitFor('no dot', async () => !(await dot()), 15_000))
check('server: RW-two seen', await waitFor('seen', async () => (await byTitle('RW-two'))?.waitingSeen === true, 10_000))

// The second agent works again; the first agent's spell, already seen, is unchanged.
await agentTurn('turn 2, A viewing')
const after = await byTitle('RW-two')
console.log(`after: status=${after.status} waitingSeen=${after.waitingSeen} spell unchanged=${after.waitingSinceMs === spell}`)
await A.screenshot({ path: path.join(SHOTS, '5-second-agent-A.png') })
check('A still viewing RW-two: no dot after the second agent\'s turn (fails if the bug is present)', !(await dot()))
check('server: RW-two still seen (fails if the bug is present)', after.waitingSeen === true)

tmux('kill-window', '-t', 'yaac:claude-2')
await browser.close()
finish()
