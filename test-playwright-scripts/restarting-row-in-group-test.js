/*
 * Verifies that restarting a worktree leaves its "Restarting worktree" row
 * INSIDE the sidebar group the worktree is filed under, rather than lifting it
 * to the top of the sidebar for the duration of the restart.
 *
 * A worktree is out of the snapshot while its container is recreated, so that
 * placeholder is the only thing standing in for it — and where it stands is
 * where the reader takes the worktree to be.
 *
 * Two passes, because the row has two authors and only the second one can be
 * checked in jsdom:
 *
 *   clicked — the real path: the ghost row's restart button, its confirmation,
 *     and the streaming provision. The row starts as the client's optimistic
 *     entry and is replaced mid-restart by the server's snapshot one.
 *   server  — the restart is POSTed from this script instead, so the browser
 *     never makes an optimistic row: every frame on screen comes from the
 *     server's snapshot. This is what proves the SERVER's provisioning entry
 *     carries the group — a groupless one would park the row at the top of
 *     the list, and the clicked pass can hide that behind its own optimistic
 *     copy if the restart is quick.
 *
 * Both passes sample the sidebar for the whole life of the placeholder, so a
 * row that jumps at the handover is caught wherever the handover lands.
 *
 * Needs a running `yaac server` built from the source under test (`pnpm build`
 * + `yaac server restart`), and a project with a sidebar group holding TWO
 * worktrees, so the section keeps a live member while the other restarts:
 *
 *   yaac worktree create <project> --group Reviews    # twice
 *
 * The script stops and restarts the older member itself; it leaves it running.
 *
 * Run: node test-playwright-scripts/restarting-row-in-group-test.js
 * (PROJECT defaults to "yaac", GROUP_NAME to "Reviews", SCREENSHOT_DIR to
 * /tmp/yaac-shots, APP_URL overrides the server origin.)
 * (playwright is resolved from the global npm root; browsers live under
 * /opt/playwright-browsers)
 */
import fs from 'node:fs'
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync('/opt/playwright-browsers')) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/playwright-browsers'
}

function requirePlaywright() {
  try {
    return require('playwright')
  } catch {
    const globalRoot = execSync('npm root -g').toString().trim()
    return require(path.join(globalRoot, 'playwright'))
  }
}

function readServerLock() {
  const candidates = [
    process.env.YAAC_DATA_DIR && path.join(process.env.YAAC_DATA_DIR, '.server.lock'),
    path.join(os.homedir(), '.yaac', '.server.lock'),
  ].filter(Boolean)
  for (const p of candidates) {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'))
  }
  throw new Error(`no .server.lock found (tried ${candidates.join(', ')}) — is the server running?`)
}

const SHOTS = process.env.SCREENSHOT_DIR ?? '/tmp/yaac-shots'
const PROJECT = process.env.PROJECT ?? 'yaac'
const GROUP = process.env.GROUP_NAME ?? 'Reviews'

const lock = readServerLock()
const origin = process.env.APP_URL ?? `http://127.0.0.1:${lock.port}`

/** The loopback API, with the lock secret — the same door `yaac` itself uses. */
async function api(pathname, body) {
  const res = await fetch(`${origin}${pathname}`, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    headers: { authorization: `Bearer ${lock.secret}`, 'content-type': 'application/json' },
  })
  if (!res.ok) throw new Error(`${pathname}: HTTP ${res.status} ${await res.text()}`)
  return res
}
const get = async (p) => (await api(p)).json()

async function mintToken() {
  const res = await api('/tokens', { kind: 'one-time' })
  return (await res.json()).token
}

let failures = 0
function check(name, cond, detail = '') {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

/**
 * The sidebar as the reader sees it: the group's section by aria-label, its
 * rows, and every row in the list. Read in the page because "inside the
 * section" is a DOM containment question — a row at the top of the sidebar and
 * a row in the section read identically by text.
 */
function sidebarShape(groupName) {
  const text = (el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
  // Every row (and every group header) is a `.group.relative` wrapper.
  const rows = (root) => [...root.querySelectorAll('.group.relative')].map(text)
  const section = document.querySelector(`[role="group"][aria-label="${groupName}"]`)
  const list = document.querySelector('aside [class*="overflow-y-auto"]')
  return {
    section: section ? rows(section) : null,
    all: list ? rows(list) : null,
    restartingInSection: section ? rows(section).some((t) => t.startsWith('Restarting worktree')) : false,
  }
}

/** Poll the rendered sidebar until `done` accepts it. */
async function untilShape(page, done, what, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const shape = await page.evaluate(sidebarShape, GROUP)
    if (done(shape)) return shape
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(shape)}`)
    await page.waitForTimeout(200)
  }
}

/** Sample every frame the placeholder is on screen, until it is retired. */
async function sampleWhileRestarting(page, label) {
  const deadline = Date.now() + 120_000
  const samples = []
  for (;;) {
    const shape = await page.evaluate(sidebarShape, GROUP)
    if ((shape.all ?? []).some((t) => t.startsWith('Restarting worktree'))) {
      if (samples.length === 0) {
        fs.mkdirSync(SHOTS, { recursive: true })
        await page.screenshot({ path: path.join(SHOTS, `restart-group-${label}.png`) })
      }
      samples.push(shape)
    } else if (samples.length > 0) {
      return samples
    }
    if (Date.now() > deadline) return samples
    await page.waitForTimeout(100)
  }
}

function report(label, samples) {
  if (samples.length === 0) {
    check(`${label}: the restarting row was on screen at all`, false, 'never appeared')
    return
  }
  console.log(`  ${label}: ${samples.length} frames`)
  console.log(`    first: ${JSON.stringify(samples[0].section)}`)
  console.log(`    last:  ${JSON.stringify(samples[samples.length - 1].section)}`)
  const strayed = samples.filter((s) => !s.restartingInSection)
  check(`${label}: the restarting row is in the group section, every frame`,
    strayed.length === 0, `${strayed.length}/${samples.length} frames outside`)
  const jumped = samples.filter((s) => (s.all ?? [])[0]?.startsWith('Restarting worktree'))
  check(`${label}: it never reaches the top of the sidebar`,
    jumped.length === 0, `${jumped.length}/${samples.length} frames on top`)
  // Rows, not the section's own header — which is a `.group.relative` too, and
  // counting it would let a section holding nothing but the live row pass.
  const rowsOf = (s) => (s.section ?? []).filter((t) => !t.startsWith(GROUP))
  check(`${label}: the group holds both the placeholder and its live member`,
    samples.every((s) => rowsOf(s).length >= 2), JSON.stringify(rowsOf(samples[0])))
}

const { groups } = await get(`/worktree/group/list?project=${PROJECT}`)
const group = groups.find((g) => g.name === GROUP)
if (!group) throw new Error(`project ${PROJECT} has no group named ${GROUP} — see the header comment`)
const { worktrees } = await get(`/worktree/list?project=${PROJECT}`)
const members = worktrees.filter((w) => w.groupId === group.groupId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
if (members.length < 2) throw new Error(`group ${GROUP} needs two live members, has ${members.length}`)
const subject = members[0]
console.log(`subject ${subject.worktreeId.slice(0, 8)} in ${GROUP}, keeping ${members[1].worktreeId.slice(0, 8)} live\n`)

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await ctx.newPage()
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))

  await page.goto(`${origin}/?token=${await mintToken()}`)
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 15_000 })
  const section = page.locator(`[role="group"][aria-label="${GROUP}"]`)
  await section.waitFor({ state: 'visible', timeout: 15_000 })

  // --- pass 1: restarted by clicking the ghost row, as a user does ---
  await api('/worktree/stop', { worktreeId: subject.worktreeId })
  await untilShape(page, (s) => (s.section ?? []).some((t) => t.includes('stopped')), 'the ghost row')
  check('the stopped member is a ghost row in the group', true)

  // The row actions are `pointer-events-none` until the row is hovered, and
  // Playwright hit-tests before it moves the mouse — so hover the row first.
  const ghost = section.locator('.group.relative').filter({ hasText: 'stopped' }).first()
  await ghost.hover()
  await ghost.locator('[aria-label="Restart worktree"]').click()
  await page.locator('text=Restart this worktree?').waitFor({ state: 'visible', timeout: 10_000 })
  await page.locator('button', { hasText: /^Restart$/ }).last().click()
  report('clicked', await sampleWhileRestarting(page, 'clicked'))

  // --- pass 2: restarted from outside the browser, so only the server's
  // snapshot row is ever drawn ---
  await untilShape(page, (s) => !(s.all ?? []).some((t) => t.startsWith('Restarting')), 'the restart to finish')
  await api('/worktree/stop', { worktreeId: subject.worktreeId })
  await untilShape(page, (s) => (s.section ?? []).some((t) => t.includes('stopped')), 'the ghost row again')
  // Exactly what the webapp posts, minus the browser: projectSlug + tool, the
  // pair that makes the route register the row before it resolves anything.
  const streamed = api('/worktree/restart', {
    worktreeId: subject.worktreeId, projectSlug: PROJECT, tool: subject.tool,
  }).then((res) => res.text())
  report('server', await sampleWhileRestarting(page, 'server'))
  await streamed

  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
} catch (err) {
  console.error(`error: ${err instanceof Error ? err.stack : String(err)}`)
  failures++
} finally {
  await browser.close()
}
process.exit(failures === 0 ? 0 : 1)
