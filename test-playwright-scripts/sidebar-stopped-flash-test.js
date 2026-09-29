/*
 * Verifies the sidebar's stopped-worktrees list (useStoppedWorktrees) in real
 * Chromium against a live server: the "Stopped worktrees" entry point and a
 * group's ghost rows must never blink out while the list refetches.
 *
 *  1. Creating a worktree (CLI) and stopping worktrees (from the row menu, and
 *     from the CLI) never empties the entry point or drops a ghost row.
 *  2. Restarting a stopped entry — from the overlay and from a ghost row —
 *     takes it off the list on the click, and it never comes back as the
 *     restart finishes.
 *  3. A failed restart hides its entry while the error row is up; dismissing
 *     the row brings the entry straight back, with no refetch.
 *  4. Switching to a project with no stopped worktrees never shows the first
 *     project's list, and switching back shows its own.
 *  5. An unseen death opened while a refetch is in flight (one fetched before
 *     the acknowledgement, so it still says unseen) stays cleared: no dot, no
 *     row highlight, and the server records it seen.
 *
 * Every list-stopped response is fetched from the real server and then held
 * for DELAY_MS, which widens each refetch window enough for a blink to show;
 * a sampler in the page records the entry point, the death dot and the ghost
 * rows every 10ms. Check 3 fails the restart by answering POST
 * /worktree/restart with a 500.
 *
 * Worktrees are `pi` in ACP mode with the fake OpenRouter credential, so no
 * model is ever called — a claude worktree on a containerless host would run
 * on the host's real login. Check 5 needs an unseen death: without one the
 * script makes one by killing a worktree's tmux server and waiting (up to
 * ~4 min) for the stale reaper to record it. Worktrees it creates are titled
 * "PW …" and left stopped at the end.
 *
 * Drives the app the server itself serves (`dist/`), reading the port from
 * $YAAC_DATA_DIR/server-local/.server.lock (data dir defaults to ~/.yaac) —
 * so run `pnpm build` + `yaac server restart` first. OTHER must be a second
 * project with no stopped worktrees.
 *
 * Run: PROJECT=yaac OTHER=hello-world node test-playwright-scripts/sidebar-stopped-flash-test.js
 * (SCREENSHOT_DIR for screenshots; defaults to /tmp/yaac-shots.
 *  playwright is resolved from the global npm root; browsers live under
 *  /opt/playwright-browsers)
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
  const dataDir = process.env.YAAC_DATA_DIR ?? path.join(os.homedir(), '.yaac')
  const p = path.join(dataDir, 'server-local', '.server.lock')
  if (!fs.existsSync(p)) throw new Error(`no ${p} — is the server running?`)
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

let failures = 0
function check(name, cond, detail = '') {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const PROJECT = process.env.PROJECT
const OTHER = process.env.OTHER
if (!PROJECT || !OTHER) throw new Error('set PROJECT=<slug> OTHER=<slug with no stopped worktrees>')
const GROUP = 'PW'
// Titles carry a per-run suffix, so a rerun's rows never share a label with
// the ghosts an earlier run left behind.
const RUN = Date.now().toString(36).slice(-4)
const T = (name) => `PW ${name} ${RUN}`
const DELAY_MS = 2500
const SHOTS = process.env.SCREENSHOT_DIR ?? '/tmp/yaac-shots'
const origin = `http://127.0.0.1:${readServerLock().port}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// Node's fetch can reuse a pooled socket the server just closed; one retry
// covers that race.
const api = async (url, init) => {
  try { return await fetch(url, init) } catch { await sleep(200); return fetch(url, init) }
}

// --- server side: the CLI and the HTTP API ---
const yaac = (args) => execSync(`yaac ${args}`, { input: '', stdio: ['pipe', 'pipe', 'pipe'] }).toString()
const stoppedList = async (project) =>
  (await api(`${origin}/api/worktree/list-stopped?project=${project}`)).json()
const isLive = (id) => yaac('worktree list').includes(id.slice(0, 8))
async function until(what, cond, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await cond()) return
    await sleep(250)
  }
  throw new Error(`timed out waiting for ${what}`)
}
async function create(title) {
  const out = yaac(`worktree create ${PROJECT} -t pi --mode acp -g ${GROUP} -p "${title}"`)
  const id = out.match(/Worktree ([0-9a-f-]{36})/)?.[1]
  if (!id) throw new Error(`create printed no id:\n${out}`)
  await api(`${origin}/api/worktree/${id}/title`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }),
  })
  return id
}
const stop = (id) => yaac(`worktree stop ${id}`)

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
const made = []
try {
  // --- fixtures: a live anchor keeps the group on screen; B and C ghost in it ---
  console.log('setting up worktrees…')
  made.push(await create(T('anchor')))
  const B = await create(T('ghost B'))
  const C = await create(T('ghost C'))
  made.push(B, C)
  stop(B)
  stop(C)
  let death = (await stoppedList(PROJECT)).find((e) => e.deathReason && !e.seen)
  if (!death) {
    console.log('making an unseen death (waiting on the stale reaper)…')
    const D = await create(T('death'))
    made.push(D)
    const tmux = execSync('ps -eo args').toString().split('\n')
      .find((l) => l.includes('new-session') && l.includes(D))?.match(/-S (\S+)/)?.[1]
    if (!tmux) throw new Error(`no tmux server found for ${D}`)
    execSync(`tmux -S ${tmux} kill-server`)
    await until('the reaper to record the death', async () =>
      (await stoppedList(PROJECT)).some((e) => e.worktreeId === D && e.deathReason), 300_000)
    death = (await stoppedList(PROJECT)).find((e) => e.worktreeId === D)
  }
  const deathLabel = death.title || death.prompt || 'New worktree'
  check(`${OTHER} has no stopped worktrees (precondition)`, (await stoppedList(OTHER)).length === 0)

  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  fs.mkdirSync(SHOTS, { recursive: true })

  // Hold every list-stopped response, fetched first so it carries the
  // server's state from before anything the page does in the meantime.
  let inflight = 0
  let served = 0
  await page.route('**/worktree/list-stopped**', async (route) => {
    inflight++
    try {
      const response = await route.fetch()
      await sleep(DELAY_MS)
      await route.fulfill({ response })
    } catch { /* page gone */ }
    inflight--
    served++
  })
  const settle = async () => {
    await until('list-stopped to go quiet', () => inflight === 0, 30_000)
    await sleep(300)
  }

  await page.goto(`${origin}/?project=${PROJECT}`)
  const aside = page.locator('aside')
  const entry = aside.getByRole('button', { name: /^Stopped worktrees/ })
  const ghost = (label) => aside.locator('button[title="Read this worktree\'s conversation"]', { hasText: label })
  const section = aside.getByRole('group', { name: GROUP, exact: true })
  // The group's ghost rows are folded behind a count until it is opened, and
  // fold again whenever the section remounts (a project switch).
  const openGhosts = async () => {
    const toggle = section.getByRole('button', { name: /^\d+ stopped worktrees?\b/ })
    await toggle.waitFor({ timeout: 20_000 })
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
  }
  await entry.waitFor({ timeout: 20_000 })
  await openGhosts()
  await ghost(T('ghost B')).waitFor({ timeout: 20_000 })
  await settle()

  // The sampler: one record per change to what the sidebar shows.
  await page.evaluate(() => {
    const w = window
    w.__samples = []
    w.__mark = (m) => w.__samples.push({ t: performance.now(), mark: m })
    let last = ''
    setInterval(() => {
      const aside = document.querySelector('aside')
      if (!aside) return
      const btn = [...aside.querySelectorAll('button')].find((b) => b.textContent.startsWith('Stopped worktrees'))
      const s = {
        entry: btn ? Number(btn.textContent.replace('Stopped worktrees', '')) : null,
        dot: Boolean(aside.querySelector('[title*="died unexpectedly"]')),
        ghosts: [...aside.querySelectorAll('button[title="Read this worktree\'s conversation"]')]
          .map((b) => b.querySelector('span span')?.textContent ?? '').sort(),
      }
      const key = JSON.stringify(s)
      if (key !== last) { last = key; w.__samples.push({ t: performance.now(), ...s }) }
    }, 10)
  })
  const mark = (m) => page.evaluate((x) => window.__mark(x), m)
  /** Samples recorded after `from` (a mark), up to the next mark or the end. */
  const phase = async (from) => {
    const all = await page.evaluate(() => window.__samples)
    const i = all.findIndex((s) => s.mark === from)
    const rest = all.slice(i + 1)
    const j = rest.findIndex((s) => s.mark)
    return (j === -1 ? rest : rest.slice(0, j)).filter((s) => !s.mark)
  }

  // (1) Start and stop worktrees.
  await mark('p1')
  const E = await create(T('flash E'))
  made.push(E)
  await aside.getByText(T('flash E'), { exact: true }).waitFor({ timeout: 20_000 })
  await settle()
  const eRow = aside.locator('div.group').filter({ hasText: T('flash E') }).last()
  await eRow.hover()
  await eRow.getByRole('button', { name: 'Worktree actions' }).click()
  await page.getByRole('menuitem', { name: 'Stop…' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Stop', exact: true }).click()
  await ghost(T('flash E')).waitFor({ timeout: 30_000 })
  await settle()
  const F = await create(T('flash F'))
  made.push(F)
  await settle()
  stop(F)
  await ghost(T('flash F')).waitFor({ timeout: 30_000 })
  await settle()
  await mark('p1-end')
  const p1 = await phase('p1')
  check('(1) the entry point never blinks out while worktrees start and stop',
    p1.every((s) => s.entry !== null), `${p1.length} samples, entry counts ${[...new Set(p1.map((s) => s.entry))]}`)
  check('(1) ghost rows B and C are on screen in every sample',
    p1.every((s) => s.ghosts.includes(T('ghost B')) && s.ghosts.includes(T('ghost C'))))
  check('(1) both stops land as ghost rows', p1.at(-1).ghosts.includes(T('flash E')) && p1.at(-1).ghosts.includes(T('flash F')))
  await page.screenshot({ path: path.join(SHOTS, 'stopped-flash-1.png') })

  // (2a) Restart from the overlay.
  const before2a = p1.at(-1).entry
  await mark('p2a')
  await entry.click()
  const overlay = page.getByRole('dialog')
  await overlay.getByText(T('ghost B'), { exact: true }).first().click()
  await overlay.getByRole('button', { name: /Restart/ }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Restart' }).click()
  await until('B to be live again', () => isLive(B), 60_000)
  await settle()
  await mark('p2a-end')
  const p2a = await phase('p2a')
  const after2a = p2a.findIndex((s) => s.entry === before2a - 1)
  check('(2) an overlay restart leaves the list on the click', after2a !== -1)
  check('(2) and never comes back while the restart finishes',
    p2a.slice(after2a).every((s) => s.entry === before2a - 1 && !s.ghosts.includes(T('ghost B'))),
    `entry counts after: ${[...new Set(p2a.slice(after2a).map((s) => s.entry))]}`)

  // (2b) Restart from a ghost row.
  const before2b = p2a.at(-1).entry
  await mark('p2b')
  await ghost(T('ghost C')).hover()
  await ghost(T('ghost C')).locator('..').getByRole('button', { name: 'Restart worktree' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Restart' }).click()
  await until('C to be live again', () => isLive(C), 60_000)
  await settle()
  await mark('p2b-end')
  const p2b = await phase('p2b')
  const after2b = p2b.findIndex((s) => !s.ghosts.includes(T('ghost C')))
  check('(2) a ghost-row restart leaves the list on the click', after2b !== -1 && p2b[after2b].entry === before2b - 1)
  check('(2) and never comes back while the restart finishes',
    p2b.slice(after2b).every((s) => s.entry === before2b - 1 && !s.ghosts.includes(T('ghost C'))))

  // (3) A failed restart, then dismissed.
  stop(B)
  await ghost(T('ghost B')).waitFor({ timeout: 30_000 })
  await settle()
  await page.route('**/worktree/restart', (route) => route.fulfill({
    status: 500, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'INTERNAL', message: 'simulated restart failure' } }),
  }))
  await mark('p3')
  await ghost(T('ghost B')).hover()
  await ghost(T('ghost B')).locator('..').getByRole('button', { name: 'Restart worktree' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Restart' }).click()
  const dismiss = section.getByRole('button', { name: 'Dismiss' })
  await dismiss.waitFor({ timeout: 15_000 })
  await sleep(DELAY_MS + 500)
  check('(3) the entry stays hidden while the failed row is up', !(await ghost(T('ghost B')).isVisible()))
  await page.screenshot({ path: path.join(SHOTS, 'stopped-flash-3-failed.png') })
  const servedBefore = served
  await mark('p3-dismiss')
  await dismiss.click()
  await ghost(T('ghost B')).waitFor({ timeout: 2_000 })
  check('(3) dismissing the row brings the entry straight back', await ghost(T('ghost B')).isVisible())
  await sleep(500)
  check('(3) without a refetch', served === servedBefore && inflight === 0, `served ${served - servedBefore}`)
  await page.unroute('**/worktree/restart')

  // (4) Switch projects and back.
  const ownCount = (await phase('p3-dismiss')).at(-1)?.entry
  await mark('p4')
  await page.locator(`[title="${OTHER}"]`).first().click()
  await sleep(DELAY_MS * 2 + 500)
  await mark('p4-back')
  await page.locator(`[title="${PROJECT}"]`).first().click()
  await entry.waitFor({ timeout: 10_000 })
  await openGhosts()
  await settle()
  await mark('p4-end')
  const away = await phase('p4')
  check(`(4) ${PROJECT}'s list never shows under ${OTHER}`,
    away.length > 0 && away.every((s) => s.entry === null && s.ghosts.length === 0),
    `${away.length} samples, entry counts ${[...new Set(away.map((s) => s.entry))]}`)
  const back = await phase('p4-back')
  check(`(4) switching back shows ${PROJECT}'s own list`,
    back.at(-1)?.entry === ownCount && back.at(-1)?.ghosts.includes(T('ghost B')))

  // (5) Open an unseen death while a refetch fetched before the ack is held.
  check('(5) the unseen death shows a dot (precondition)', await aside.locator('[title*="died unexpectedly"]').count() > 0)
  await mark('p5')
  stop(C)
  await until('a refetch to be in flight', () => inflight > 0, 20_000)
  await entry.click()
  await overlay.getByText(deathLabel, { exact: true }).first().click()
  const clickedAt = await page.evaluate(() => performance.now())
  await settle()
  await sleep(1000)
  await overlay.getByText(T('ghost B'), { exact: true }).first().click()
  const deathRow = overlay.locator('li button', { hasText: deathLabel }).first()
  check('(5) its row is not highlighted once the refetch lands',
    !(await deathRow.getAttribute('class')).includes('bg-amber-500/10'))
  await page.screenshot({ path: path.join(SHOTS, 'stopped-flash-5.png') })
  await page.keyboard.press('Escape')
  await mark('p5-end')
  // The sampler records changes only, so the state at a moment is the last
  // sample at or before it.
  const all = (await page.evaluate(() => window.__samples)).filter((s) => !s.mark)
  const settled = clickedAt + 300
  const p5 = [all.findLast((s) => s.t <= settled), ...all.filter((s) => s.t > settled)]
  check('(5) the dot clears and stays cleared through the refetch',
    p5.every((s) => !s.dot), `dot per sample from 300ms after the click: ${p5.map((s) => s.dot)}`)
  check('(5) the server records it seen',
    (await stoppedList(PROJECT)).find((e) => e.worktreeId === death.worktreeId)?.seen === true)
} finally {
  await browser.close()
  for (const id of made) {
    try { if (isLive(id)) stop(id) } catch { /* best-effort */ }
  }
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
