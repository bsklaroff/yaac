/*
 * Verifies that a workspace is counted once in the sidebar's totals through
 * every state change, against a live server: the group header's
 * `(active/total)` and the Stopped section's count are sampled every ~50 ms
 * while
 *
 *  1. a grouped member stops (running → stopping → stopped),
 *  2. an ungrouped workspace stops,
 *  3. a running member is restarted over the API (its stop is recorded and
 *     it is torn down while the restart's row is up),
 *  4. a stopped member is restarted over the API.
 *
 * Each phase prints every distinct (header, Stopped) pair it saw, so a
 * transient double or zero count shows even when it lasts one snapshot;
 * VERBOSE=1 adds when each appeared and the group's rows.
 *
 * Needs a running server with a project. Creates five `pi` ACP workspaces
 * (fake credentials, no prompt, so no model is called), four in a group
 * named for this run, and stops them all at the end.
 * Run: node test-playwright-scripts/sidebar-stopping-counts.js
 * (PROJECT, a project name or id, defaults to yaac)
 */
import { requirePlaywright, origin, api, check, finish, createWorkspaces, resolveProject } from './lib.js'

const PROJECT = (await resolveProject(process.env.PROJECT ?? 'yaac')).id
const RUN = Date.now().toString(36).slice(-4)
const GROUP = `Counts ${RUN}`

const pi = (body) => ({ project: PROJECT, tool: 'pi', mode: 'acp', ...body })
const post = (route, body) => api(route, { method: 'POST', body })
const stop = (workspaceId) => post('/workspace/stop', { workspaceId })
const restart = (workspaceId) => fetch(`${origin}/api/workspace/restart`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ workspaceId }),
}).then((r) => r.text())

console.log('creating five workspaces…')
const [A, B, C, D, E] = await createWorkspaces([
  pi({ title: `PW count A ${RUN}`, group: GROUP }),
  pi({ title: `PW count B ${RUN}`, group: GROUP }),
  pi({ title: `PW count C ${RUN}`, group: GROUP }),
  pi({ title: `PW count D ${RUN}`, group: GROUP }),
  pi({ title: `PW count E ${RUN}` }),
])
await stop(A)

/** The group header's `(a/t)` and the Stopped section's count. */
function counts(groupName) {
  const section = document.querySelector(`aside [role="group"][aria-label="${groupName}"]`)
  const header = section?.textContent.match(/\((\d+\/\d+)\)/)?.[1] ?? null
  const button = [...document.querySelectorAll('aside button')]
    .find((b) => /^\s*Stopped\s*\d+/.test(b.textContent))
  const stopped = button?.textContent.match(/Stopped\s*(\d+)/)?.[1] ?? null
  const rows = section ? [...section.querySelectorAll('.group.relative')]
    .map((el) => el.textContent.replace(/\s+/g, ' ').trim().slice(0, 30)) : []
  const stopping = document.querySelector('aside')?.textContent.includes('stopping…') ?? false
  return { key: `${header} | ${stopped}`, rows, stopping }
}

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  await page.goto(`${origin}/?project=${PROJECT}`)
  await page.locator(`aside [role="group"][aria-label="${GROUP}"]`).waitFor()

  /** The counts once no row is still stopping and they have held still for
   *  ~2 s, so the previous phase's tail lands before the next phase's
   *  baseline (on k8s a stopped pod lingers a few seconds). */
  const quietCounts = async (timeoutMs = 60_000) => {
    const deadline = Date.now() + timeoutMs
    let last = null
    let quiet = 0
    while (Date.now() < deadline && quiet <= 40) {
      const { key, stopping } = await page.evaluate(counts, GROUP)
      quiet = key === last && !stopping ? quiet + 1 : 0
      last = key
      await page.waitForTimeout(50)
    }
    return last
  }

  /** Sample counts from `act` until it has resolved and `settled` has held
   *  for ~2 s. `settled` gets each sample and the one taken before `act`. */
  const sample = async (label, act, settled, timeoutMs = 120_000) => {
    const seen = [await quietCounts()]
    const t0 = Date.now()
    let finished = false
    const done = act().finally(() => { finished = true })
    const deadline = Date.now() + timeoutMs
    let quiet = 0
    while (Date.now() < deadline) {
      const { key: c, rows } = await page.evaluate(counts, GROUP)
      if (c !== seen.at(-1)) {
        seen.push(c)
        if (process.env.VERBOSE) console.log(`  +${Date.now() - t0}ms ${c}  rows: ${rows.join(' ; ')}`)
      }
      quiet = finished && settled(c, seen[0]) ? quiet + 1 : 0
      if (quiet > 40) break
      await page.waitForTimeout(50)
    }
    await done
    console.log(`${label}: ${seen.join('  →  ')}`)
    return seen
  }

  // Every phase keeps the group at four workspaces, and the Stopped count
  // only ever moves by the phase's own net change.
  const once = (seen, delta) => {
    const total = seen.map((c) => c.split(' | ')[0].split('/')[1])
    const stopped = seen.map((c) => Number(c.split(' | ')[1] ?? 0))
    const lo = Math.min(stopped[0], stopped[0] + delta)
    const hi = Math.max(stopped[0], stopped[0] + delta)
    return total.every((t) => t === '4') && stopped.every((n) => n >= lo && n <= hi)
      && stopped.at(-1) === stopped[0] + delta
  }
  // The header reads `want` and the Stopped count has moved by `delta`. An
  // ungrouped stop leaves the header as it was, so the count is what shows
  // it has landed.
  const settledAt = (want, delta) => (c, first) =>
    c.startsWith(want) && Number(c.split(' | ')[1]) === Number(first.split(' | ')[1]) + delta
  let seen = await sample('B stops', () => stop(B), settledAt('2/4', 1))
  check('a grouped stop is counted once throughout', once(seen, 1), seen.join(', '))
  seen = await sample('E stops (no group)', () => stop(E), settledAt('2/4', 1))
  check('an ungrouped stop is counted once throughout', once(seen, 1), seen.join(', '))
  seen = await sample('C restarts while running', () => restart(C), settledAt('2/4', 0))
  check('a running member\'s restart is counted once throughout', once(seen, 0), seen.join(', '))
  seen = await sample('A restarts from stopped', () => restart(A), settledAt('3/4', -1))
  check('a stopped member\'s restart is counted once throughout', once(seen, -1), seen.join(', '))
} finally {
  await browser.close()
  await Promise.allSettled([A, B, C, D, E].map(stop))
}
finish()
