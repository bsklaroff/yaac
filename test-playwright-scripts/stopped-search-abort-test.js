/*
 * Verifies in Chromium, against a live server, that the sidebar's stopped
 * search drops superseded requests and keeps paging alive:
 *
 *  1. Retyping a search faster than the server answers aborts each
 *     superseded `list-stopped` request in the browser (net::ERR_ABORTED),
 *     and the server stays responsive (`/api/health` latency while typing).
 *  2. The search box spins until the final query's results land, then
 *     shows only that query's matches.
 *  3. A failing request clears the spinner instead of spinning forever.
 *  4. Clearing the search while its first page is still loading leaves a
 *     list that pages to the end, so no superseded fetch blocks paging.
 *
 * Every request is slowed by LATENCY_MS (default 800) through the DevTools
 * protocol, so a request is in flight when the next query supersedes it.
 *
 * Needs a running server whose project PROJECT has more than one page (50)
 * of stopped workspaces whose prompts or titles mention "parser", "lexer",
 * "router", "cache" and "schema". It changes nothing on the server.
 *
 * Run: PROJECT=<name or id> [LATENCY_MS=800] node test-playwright-scripts/stopped-search-abort-test.js
 */
import path from 'node:path'
import { SHOTS, api, check, finish, origin, requirePlaywright, resolveProject } from './lib.js'

const project = await resolveProject(process.env.PROJECT ?? 'yaac')
const latency = Number(process.env.LATENCY_MS ?? 800)
const { total } = await api(`/workspace/list-stopped?project=${project.id}&limit=1`)
if (total <= 50) throw new Error(`${project.name} has ${total} stopped workspaces; seed more than 50`)

/** Poll /api/health until stopped, returning the slowest answer in ms. */
function probeHealth() {
  let stop = false
  let worst = 0
  const done = (async () => {
    while (!stop) {
      const t = Date.now()
      await fetch(`${origin}/api/health`)
      worst = Math.max(worst, Date.now() - t)
      await new Promise((r) => setTimeout(r, 50))
    }
    return worst
  })()
  return () => { stop = true; return done }
}

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency, downloadThroughput: -1, uploadThroughput: -1,
  })

  const stoppedReqs = new Map()
  const isStopped = (req) => req.url().includes('/api/workspace/list-stopped')
  page.on('request', (req) => { if (isStopped(req)) stoppedReqs.set(req, 'pending') })
  page.on('requestfinished', (req) => { if (isStopped(req)) stoppedReqs.set(req, 'finished') })
  page.on('requestfailed', (req) => {
    if (isStopped(req)) stoppedReqs.set(req, req.failure()?.errorText ?? 'failed')
  })
  const byQuery = (q) => [...stoppedReqs].filter(([r]) => new URL(r.url()).searchParams.get('q') === q)

  await page.goto(`${origin}/?project=${project.id}`)
  const section = page.getByRole('group', { name: 'Stopped workspaces' })
  const header = section.locator('button[aria-expanded]').first()
  await header.waitFor({ timeout: 15_000 })
  if (await header.getAttribute('aria-expanded') === 'false') await header.click()
  const rows = section.locator('button[title="Read this workspace\'s conversation"]')
  await rows.first().waitFor({ timeout: 15_000 })

  const search = page.getByRole('textbox', { name: 'Search workspaces' })
  const spinner = page.getByLabel('Searching')

  // 1-2: each query outlives the debounce but not the latency.
  const words = ['parser', 'lexer', 'router', 'cache', 'schema']
  const health = probeHealth()
  for (const w of [...words, ...words]) {
    await search.fill(w)
    await page.waitForTimeout(350)
  }
  check('the spinner shows while the last query loads', await spinner.isVisible())
  await spinner.waitFor({ state: 'hidden', timeout: 15_000 })
  const worst = await health()
  const last = words.at(-1)
  const texts = await rows.allInnerTexts()
  check('the final rows are the last query\'s matches', texts.length > 0 && texts.every((t) => t.includes(last)),
    `${texts.length} rows`)
  const aborted = [...stoppedReqs.values()].filter((s) => s.includes('ERR_ABORTED')).length
  check('superseded searches were aborted in the browser', aborted >= words.length, `${aborted} aborted`)
  check('the last query finished', byQuery(last).some(([, s]) => s === 'finished'))
  check('the server stayed responsive while typing', worst < latency + 1000, `worst /health ${worst}ms`)
  await page.screenshot({ path: path.join(SHOTS, 'stopped-search-settled.png') })

  // 3: a failing request.
  await page.route('**/api/workspace/list-stopped?*q=boom*', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"code":"INTERNAL","message":"boom"}}' }))
  await search.fill('boom')
  await page.waitForTimeout(300)
  await spinner.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {})
  check('a failed search clears the spinner', !await spinner.isVisible())

  // 4: clear mid-load, then page to the end.
  await search.fill('router')
  await page.waitForTimeout(300)
  check('the router search is in flight when cleared', byQuery('router').some(([, s]) => s === 'pending'))
  await search.fill('')
  for (let i = 0; i < 10 && await rows.count() < total; i++) {
    await rows.last().scrollIntoViewIfNeeded()
    await page.waitForTimeout(latency + 700)
  }
  check('after clearing, scrolling lists every stopped workspace', await rows.count() === total,
    `${await rows.count()} of ${total}`)
  check('no list-stopped request is left pending', ![...stoppedReqs.values()].includes('pending'))
} finally {
  await browser.close()
}
finish()
