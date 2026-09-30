/*
 * Verifies the sidebar's stopped-workspaces list (useStoppedWorkspaces) in real
 * Chromium against a live server: the "Stopped workspaces" entry point and a
 * group's ghost rows must never blink out while the list refetches.
 *
 *  1. Creating a workspace (API) and stopping workspaces (row menu and API)
 *     never empties the entry point or drops a ghost row.
 *  2. Restarting a stopped entry, from the overlay or a ghost row, removes it
 *     from the list on click, and it does not reappear as the restart
 *     finishes.
 *  3. A failed restart hides its entry while the error row is up; dismissing
 *     the row brings the entry straight back, with no refetch.
 *  4. Switching to a project with no stopped workspaces never shows the first
 *     project's list, and switching back shows its own.
 *  5. Opening an unseen death while a refetch is in flight (fetched before
 *     the acknowledgement, so still unseen) keeps it cleared: no dot, no row
 *     highlight, and the server records it seen.
 *
 * Every list-stopped response is held for DELAY_MS so a blink during a
 * refetch is visible; an in-page sampler records the entry point, the death
 * dot and the ghost rows every 10ms. Check 3 makes POST /api/workspace/restart
 * return 500.
 *
 * Workspaces are `pi` in ACP mode with the fake OpenRouter credential and no
 * prompt, so no model is called. If there is no unseen death for check 5, the
 * script kills a workspace's tmux server and waits (up to ~5 min) for the
 * stale reaper to record one. Workspaces it creates are titled "PW …" and
 * left stopped.
 *
 * Needs a running server with two projects, OTHER having no stopped
 * workspaces (e.g. `yaac project add https://github.com/octocat/Hello-World.git
 * <credential>`).
 * Run: YAAC_DATA_DIR=<data dir> node test-playwright-scripts/sidebar-stopped-flash-test.js
 * (PROJECT defaults to yaac, OTHER to hello-world)
 */
import { execSync } from 'node:child_process'
import path from 'node:path'
import { requirePlaywright, origin, api, check, finish, SHOTS, createWorkspace, createWorkspaces } from './lib.js'

const PROJECT = process.env.PROJECT ?? 'yaac'
const OTHER = process.env.OTHER ?? 'hello-world'
const GROUP = 'PW'
// Per-run suffix so titles never collide with ghosts from an earlier run.
const RUN = Date.now().toString(36).slice(-4)
const T = (name) => `PW ${name} ${RUN}`
/** A pi ACP workspace in GROUP. */
const spec = (title) => ({ project: PROJECT, tool: 'pi', mode: 'acp', group: GROUP, title })
const DELAY_MS = 2500
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const stoppedList = (project) => api(`/workspace/list-stopped?project=${project}`)
const isLive = async (id) => (await api('/workspace/list')).workspaces.some((w) => w.workspaceId === id)
const stop = (workspaceId) => api('/workspace/stop', { method: 'POST', body: { workspaceId } })
async function waitFor(what, cond, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await cond()) return
    await sleep(250)
  }
  throw new Error(`timed out waiting for ${what}`)
}

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
const made = []
try {
  // A live anchor keeps the group on screen; B and C are its ghost rows.
  console.log('setting up workspaces…')
  let death = (await stoppedList(PROJECT)).find((e) => e.deathReason && !e.seen)
  const [anchor, B, C, D] = await createWorkspaces(
    ['anchor', 'ghost B', 'ghost C', ...(death ? [] : ['death'])].map((n) => spec(T(n))))
  made.push(anchor, B, C, ...(D ? [D] : []))
  await Promise.all([stop(B), stop(C)])
  if (!death) {
    console.log('making an unseen death (waiting on the stale reaper)…')
    const tmux = execSync('ps -eo args').toString().split('\n')
      .find((l) => l.includes('new-session') && l.includes(D))?.match(/-S (\S+)/)?.[1]
    if (!tmux) throw new Error(`no tmux server found for ${D}`)
    execSync(`tmux -S ${tmux} kill-server`)
    await waitFor('the reaper to record the death', async () =>
      (await stoppedList(PROJECT)).some((e) => e.workspaceId === D && e.deathReason), 300_000)
    death = (await stoppedList(PROJECT)).find((e) => e.workspaceId === D)
  }
  const deathLabel = death.title || death.prompt || 'New workspace'
  check(`${OTHER} has no stopped workspaces (precondition)`, (await stoppedList(OTHER)).length === 0)

  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))

  // Fetch first, then hold, so each response reflects the server's state
  // from before whatever the page does in the meantime.
  let inflight = 0
  let served = 0
  await page.route('**/workspace/list-stopped**', async (route) => {
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
    await waitFor('list-stopped to go quiet', () => inflight === 0, 30_000)
    await sleep(300)
  }

  await page.goto(`${origin}/?project=${PROJECT}`)
  const aside = page.locator('aside')
  const entry = aside.getByRole('button', { name: /^Stopped workspaces/ })
  const ghost = (label) => aside.locator('button[title="Read this workspace\'s conversation"]', { hasText: label })
  const section = aside.getByRole('group', { name: GROUP, exact: true })
  // Ghost rows stay hidden until the group menu shows them, and hide again
  // when the section remounts (a project switch).
  const openGhosts = async () => {
    const trigger = section.getByRole('button', { name: 'Group actions' }).first()
    await trigger.waitFor({ state: 'attached', timeout: 20_000 })
    // Hover the header, not the section: the `…` ignores the pointer until
    // the header is hovered, and the section's centre is over a row.
    await section.locator('button[aria-expanded]').first().hover()
    await trigger.click()
    const show = page.getByRole('menuitem', { name: 'Show stopped workspaces' })
    const hide = page.getByRole('menuitem', { name: 'Hide stopped workspaces' })
    await show.or(hide).waitFor({ timeout: 20_000 })
    if (await show.count()) await show.click()
    else await page.keyboard.press('Escape')
  }
  await entry.waitFor({ timeout: 20_000 })
  await openGhosts()
  await ghost(T('ghost B')).waitFor({ timeout: 20_000 })
  await settle()

  // Records one sample per change to what the sidebar shows.
  await page.evaluate(() => {
    const w = window
    w.__samples = []
    w.__mark = (m) => w.__samples.push({ t: performance.now(), mark: m })
    let last = ''
    setInterval(() => {
      const aside = document.querySelector('aside')
      if (!aside) return
      const btn = [...aside.querySelectorAll('button')].find((b) => b.textContent.startsWith('Stopped workspaces'))
      const s = {
        entry: btn ? Number(btn.textContent.replace('Stopped workspaces', '')) : null,
        dot: Boolean(aside.querySelector('[title*="died unexpectedly"]')),
        ghosts: [...aside.querySelectorAll('button[title="Read this workspace\'s conversation"]')]
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

  // (1) Start and stop workspaces.
  await mark('p1')
  const E = await createWorkspace(spec(T('flash E')))
  made.push(E)
  await aside.getByText(T('flash E'), { exact: true }).waitFor({ timeout: 20_000 })
  await settle()
  const eRow = aside.locator('div.group').filter({ hasText: T('flash E') }).last()
  await eRow.hover()
  await eRow.getByRole('button', { name: 'Workspace actions' }).click()
  await page.getByRole('menuitem', { name: 'Stop…' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Stop', exact: true }).click()
  await ghost(T('flash E')).waitFor({ timeout: 30_000 })
  await settle()
  const F = await createWorkspace(spec(T('flash F')))
  made.push(F)
  await settle()
  await stop(F)
  await ghost(T('flash F')).waitFor({ timeout: 30_000 })
  await settle()
  await mark('p1-end')
  const p1 = await phase('p1')
  check('(1) the entry point never blinks out while workspaces start and stop',
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
  await waitFor('B to be live again', () => isLive(B), 60_000)
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
  await ghost(T('ghost C')).locator('..').getByRole('button', { name: 'Restart workspace' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Restart' }).click()
  await waitFor('C to be live again', () => isLive(C), 60_000)
  await settle()
  await mark('p2b-end')
  const p2b = await phase('p2b')
  const after2b = p2b.findIndex((s) => !s.ghosts.includes(T('ghost C')))
  check('(2) a ghost-row restart leaves the list on the click', after2b !== -1 && p2b[after2b].entry === before2b - 1)
  check('(2) and never comes back while the restart finishes',
    p2b.slice(after2b).every((s) => s.entry === before2b - 1 && !s.ghosts.includes(T('ghost C'))))

  // (3) A failed restart, then dismissed.
  await stop(B)
  await ghost(T('ghost B')).waitFor({ timeout: 30_000 })
  await settle()
  await page.route('**/workspace/restart', (route) => route.fulfill({
    status: 500, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'INTERNAL', message: 'simulated restart failure' } }),
  }))
  await mark('p3')
  await ghost(T('ghost B')).hover()
  await ghost(T('ghost B')).locator('..').getByRole('button', { name: 'Restart workspace' }).click()
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
  await page.unroute('**/workspace/restart')

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
  await stop(C)
  await waitFor('a refetch to be in flight', () => inflight > 0, 20_000)
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
  // Samples are recorded on change, so the state at a moment is the last
  // sample at or before it.
  const all = (await page.evaluate(() => window.__samples)).filter((s) => !s.mark)
  const settled = clickedAt + 300
  const p5 = [all.findLast((s) => s.t <= settled), ...all.filter((s) => s.t > settled)]
  check('(5) the dot clears and stays cleared through the refetch',
    p5.every((s) => !s.dot), `dot per sample from 300ms after the click: ${p5.map((s) => s.dot)}`)
  check('(5) the server records it seen',
    (await stoppedList(PROJECT)).find((e) => e.workspaceId === death.workspaceId)?.seen === true)
} finally {
  await browser.close()
  for (const id of made) {
    try { if (await isLive(id)) await stop(id) } catch { /* best-effort */ }
  }
}

finish()
