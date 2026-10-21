/*
 * Verifies that the sidebar's unread dot and the death dots are per viewer
 * (docs/multi-user.md "Unread dots are the viewer's"), with the owner Alice
 * and her teammate Bob looking at one of Alice's projects:
 *
 *  1. A waiting workspace and two deaths (one ungrouped, one in a group)
 *     show as unread to both users: the row dots, the Stopped header's dot
 *     and the group header's "N died".
 *  2. Bob opening the waiting workspace and the ungrouped death clears his
 *     dots only, and the group header still counts its death. A repeated
 *     mark records him once.
 *  3. Alice still sees every dot, and her "Mark all as read" clears her
 *     deaths without touching Bob's share. The rows list each user once.
 *  4. A restart and a new death empty the list, so both see the dot again.
 *
 * It creates four claude acp workspaces (haiku; one turn, a cent or so) and
 * kills two of their tmux servers to make the deaths, so it needs a
 * containerless server in `tailnet` mode whose OWNER has working claude
 * credentials and a project, set up as in teammate-live-follow.js:
 *
 *   export YAAC_DATA_DIR=~/.yaac-dev YAAC_SERVER_PORT=8890
 *   node dist/cli.js server start && node dist/cli.js auth fake claude-oauth github
 *   node dist/cli.js project add <url> <cred>
 *   node dist/cli.js config git-identity --name Alice --email alice@example.com
 *   node dist/cli.js server stop
 *   env -u YAAC_WORKSPACE_ID node dist/cli.js server start \
 *     --tailnet srv.tailnet.ts.net --owner alice@example.com
 *
 * Run, with the same YAAC_DATA_DIR (the tmux sockets are found from it):
 *   APP_URL=http://127.0.0.1:8890 PROJECT=<project id> \
 *     node test-playwright-scripts/per-viewer-read-marks.js
 *
 * Screenshots: $SCREENSHOT_DIR/read-marks-*.png (default /tmp/yaac-shots).
 */
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { DATA_DIR, SHOTS, check, finish, requirePlaywright } from './lib.js'

const ORIGIN = (process.env.APP_URL ?? 'http://127.0.0.1:8890').replace(/\/$/, '')
const PROJECT = process.env.PROJECT
const ALICE = { login: process.env.OWNER ?? 'alice@example.com', name: process.env.OWNER_NAME ?? 'Alice' }
const BOB = { login: 'bob@example.com', name: 'Bob' }
const RUN = Date.now().toString(36).slice(-4)

const headersFor = (who) => ({
  'Tailscale-User-Login': who.login,
  'Tailscale-User-Name': who.name,
  'X-Forwarded-For': '100.64.0.1',
})

async function apiAs(who, route, body) {
  const res = await fetch(`${ORIGIN}/api${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...headersFor(who) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`/api${route}: HTTP ${res.status} ${text}`)
  return text ? JSON.parse(text.trim().split('\n').at(-1)) : null
}

async function create(title, prompt) {
  const created = await apiAs(ALICE, '/workspace/create', {
    project: PROJECT, tool: 'claude', mode: 'acp', model: 'haiku', permissionMode: 'accept-edits', title,
    ...(prompt !== undefined ? { prompt } : {}),
  })
  if (created?.type !== 'result') throw new Error(`create failed: ${JSON.stringify(created)}`)
  return created.result.workspaceId
}

async function poll(what, fn, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 1000))
  }
}

const active = async (id) => (await apiAs(ALICE, `/workspace/list?project=${PROJECT}`)).workspaces
  .find((w) => w.workspaceId === id)
const stoppedEntry = async (id) => (await apiAs(ALICE, `/workspace/list-stopped?project=${PROJECT}&workspace=${id}`))
  .entries?.find((e) => e.workspaceId === id)
const projectSummary = async () => (await apiAs(ALICE, '/project/list')).find((p) => p.id === PROJECT)

/** Kill a containerless workspace's tmux server, which the server records
 *  as a death (`agent-exited`) on its next reaper pass. */
function kill(workspaceId) {
  const dir = path.join(os.tmpdir(), `yaac-${crypto.createHash('sha256').update(DATA_DIR).digest('hex').slice(0, 8)}`)
  const sock = path.join(dir, `${crypto.createHash('sha256').update(workspaceId).digest('hex').slice(0, 12)}.sock`)
  execFileSync('tmux', ['-S', sock, 'kill-server'])
}

/** Kill a workspace once its agent is up (a create still finishing would
 *  fail instead), and wait for the server to record the death. */
async function die(id) {
  await poll(`${id}'s agent to be up`, async () => (await active(id))?.status === 'waiting')
  kill(id)
  return poll(`${id} to be recorded dead`, async () => {
    const e = await stoppedEntry(id)
    return e?.deathReason ? e : undefined
  }, 240_000)
}

/** What a page's sidebar shows for this run: which of its rows carry a
 *  dot, the Stopped header's dot, and the group header's "N died". */
function sidebarState(page) {
  return page.evaluate((run) => {
    const rows = {}
    for (const b of document.querySelectorAll('button')) {
      const m = (b.textContent ?? '').match(new RegExp(`read-marks \\w+ ${run}`))
      if (m && !(m[0] in rows)) rows[m[0]] = b.querySelector('span.rounded-full.bg-amber-500') !== null
    }
    const stoppedHeader = [...document.querySelectorAll('button')].find((b) => /^Stopped\d*$/.test((b.textContent ?? '').trim()))
    const stoppedDot = stoppedHeader?.querySelector('span[title$="died unexpectedly"]')?.getAttribute('title') ?? null
    const group = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').startsWith(`read-marks ${run}`))
    const died = group?.querySelector('span.text-danger')?.textContent ?? null
    return { rows, stoppedDot, died }
  }, RUN)
}

/** Load the project with `workspaceId` open, waiting for the mark it sends
 *  when `mark` names one, and expand the Stopped section. */
async function open(page, workspaceId, mark) {
  const sent = mark ? page.waitForResponse((r) => r.url().endsWith(`/api/workspace/${mark}`), { timeout: 30_000 }) : null
  await page.goto(`${ORIGIN}/?project=${PROJECT}&workspace=${workspaceId}`)
  if (sent) await sent
  await page.locator('button', { hasText: /^Stopped\d*$/ }).first().waitFor({ timeout: 30_000 })
  if (await page.locator('button', { hasText: `read-marks dead ${RUN}` }).count() === 0) {
    await page.locator('button', { hasText: /^Stopped\d*$/ }).first().click()
  }
  await page.locator('button', { hasText: `read-marks dead ${RUN}` }).first().waitFor({ timeout: 30_000 })
  await page.waitForTimeout(1500)
}

async function main() {
  if (!PROJECT) throw new Error('set PROJECT to a project id the OWNER owns')
  const bobId = (await apiAs(BOB, '/whoami')).userId
  const aliceId = (await apiAs(ALICE, '/whoami')).userId
  const title = (kind) => `read-marks ${kind} ${RUN}`

  const [waiting, dead, grouped, anchor] = await Promise.all([
    create(title('waiting'), `Reply with just the word READY-${RUN}.`),
    create(title('dead')),
    create(title('grouped')),
    create(title('anchor')),
  ])
  // Pinned, so its header stays once its only member has died.
  const { groupId } = await apiAs(ALICE, '/workspace/group/create', { projectId: PROJECT, workspaceId: grouped, name: `read-marks ${RUN}` })
  await apiAs(ALICE, '/workspace/group/set-pinned', { projectId: PROJECT, groupId, pinned: true })
  await poll('the waiting workspace to finish its turn', async () => (await active(waiting))?.status === 'waiting')
  await Promise.all([die(dead), die(grouped)])

  const { chromium } = requirePlaywright()
  const browser = await chromium.launch()
  const ctx = async (who) => browser.newContext({ extraHTTPHeaders: headersFor(who), viewport: { width: 1400, height: 900 } })
  try {
    // 1. Bob first sees everything unread. He lands on the anchor, so
    // nothing he checks is open yet.
    const bob = await (await ctx(BOB)).newPage()
    await open(bob, anchor)
    let s = await sidebarState(bob)
    check('Bob sees the waiting workspace unread', s.rows[title('waiting')] === true, JSON.stringify(s))
    check('Bob sees the ungrouped death unread', s.rows[title('dead')] === true, JSON.stringify(s.rows))
    check('Bob sees the Stopped header dot', s.stoppedDot !== null)
    check('Bob sees the group header count', s.died === '· 1 died', String(s.died))
    await bob.screenshot({ path: `${SHOTS}/read-marks-1-bob-before.png` })

    // 2. Bob opens the waiting workspace and the death. A repeated mark
    // (which a reopen does not send, the death being read) changes nothing.
    await open(bob, waiting, 'mark-waiting-seen')
    await open(bob, dead, 'mark-death-seen')
    await apiAs(BOB, '/workspace/mark-death-seen', { projectId: PROJECT, workspaceId: dead })
    await open(bob, anchor)
    s = await sidebarState(bob)
    check('Bob\'s waiting dot clears once he opened it', s.rows[title('waiting')] === false, JSON.stringify(s.rows))
    check('Bob\'s death dot clears once he opened it', s.rows[title('dead')] === false, JSON.stringify(s.rows))
    check('Bob\'s group header still counts the grouped death', s.died === '· 1 died', String(s.died))
    await bob.screenshot({ path: `${SHOTS}/read-marks-2-bob-after.png` })
    const w = await active(waiting)
    check('the waiting row lists Bob only', JSON.stringify(w?.waitingSeenBy) === JSON.stringify([bobId]), JSON.stringify(w?.waitingSeenBy))
    let d = await stoppedEntry(dead)
    check('the death lists Bob once, after a repeated mark', JSON.stringify(d?.deathSeenBy) === JSON.stringify([bobId]), JSON.stringify(d?.deathSeenBy))

    // 3. Alice still sees all of it, then marks all her deaths read.
    const alice = await (await ctx(ALICE)).newPage()
    await open(alice, anchor)
    s = await sidebarState(alice)
    check('Alice still sees the waiting workspace unread', s.rows[title('waiting')] === true, JSON.stringify(s.rows))
    check('Alice still sees the death unread', s.rows[title('dead')] === true, JSON.stringify(s.rows))
    check('Alice still sees the Stopped header dot', s.stoppedDot !== null)
    check('Alice still sees the group header count', s.died === '· 1 died', String(s.died))
    await alice.screenshot({ path: `${SHOTS}/read-marks-3-alice-before.png` })
    const summary = await projectSummary()
    check('the project counts Bob\'s share separately',
      summary !== undefined && summary.deathsSeenBy[bobId] >= 1 && (summary.deathsSeenBy[aliceId] ?? 0) < summary.deaths,
      JSON.stringify({ deaths: summary?.deaths, deathsSeenBy: summary?.deathsSeenBy }))

    const header = alice.locator('div[role="group"][aria-label="Stopped workspaces"] > div.group').first()
    await header.hover()
    await header.getByRole('button', { name: 'Stopped workspaces actions' }).click()
    await alice.getByRole('menuitem', { name: 'Mark all as read' }).click()
    await alice.waitForTimeout(3000)
    s = await sidebarState(alice)
    check('Alice\'s death dots clear after Mark all as read', s.rows[title('dead')] === false && s.stoppedDot === null
      && s.died === null, JSON.stringify(s))
    check('Alice\'s waiting dot is untouched by it', s.rows[title('waiting')] === true)
    d = await stoppedEntry(dead)
    const g = await stoppedEntry(grouped)
    check('the death lists each user once', [...d.deathSeenBy].sort().join() === [aliceId, bobId].sort().join(), JSON.stringify(d.deathSeenBy))
    check('the grouped death lists Alice only', JSON.stringify(g.deathSeenBy) === JSON.stringify([aliceId]), JSON.stringify(g.deathSeenBy))
    await alice.screenshot({ path: `${SHOTS}/read-marks-4-alice-after.png` })

    // 4. A restart and a new death are unseen by everyone.
    await apiAs(ALICE, '/workspace/restart', { workspaceId: dead })
    d = await die(dead)
    // A restart whose agent died before its handshake leaves a failed
    // provisioning row standing in for the workspace; clear it.
    await apiAs(ALICE, `/workspace/provisioning/${dead}/dismiss`, {})
    check('a new death starts with nobody having seen it', d.deathSeenBy.length === 0, JSON.stringify(d.deathSeenBy))
    await open(alice, anchor)
    await open(bob, anchor)
    const sa = await sidebarState(alice)
    const sb = await sidebarState(bob)
    check('both users see the new death', sa.rows[title('dead')] === true && sb.rows[title('dead')] === true,
      JSON.stringify({ alice: sa.rows, bob: sb.rows }))
  } finally {
    await browser.close()
    for (const id of [waiting, anchor]) await apiAs(ALICE, '/workspace/stop', { workspaceId: id }).catch(() => {})
  }
  finish()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
