/*
 * End-to-end check of the frontend's typed Hono API client
 * (packages/frontend/src/lib/api.ts + the lib/*Api modules) against the real
 * running stack.
 *
 * Drives the running yaac server's webapp in real Chromium and exercises the
 * request paths through the actual compiled client:
 *   - initial load         → GET /whoami, GET /auth/list, /shortcuts/get
 *   - open Settings        → its batch of GETs
 *   - New worktree → Create→ POST /worktree/create (NDJSON stream)
 *   - Rename worktree      → POST /worktree/:id/title
 *   - Stop worktree        → POST /worktree/stop
 * Every same-origin API response is captured (method, path, status); the run
 * asserts the app identified itself, rendered its main view, produced no
 * page errors, and that each exercised endpoint answered 2xx.
 *
 * Run: PROJECT=<slug> node test-playwright-scripts/rpc-client-e2e-test.js
 * Needs a running server (`yaac server start`) whose project can create a
 * worktree — a git credential it can fetch with, a server git identity, and a
 * claude credential (`yaac auth fake claude-oauth` is enough: the agent never
 * has to answer); reads the port from
 * $YAAC_DATA_DIR/server-local/.server.lock (or ~/.yaac). The worktree it
 * creates is stopped at the end (UI, then API fallback). (playwright is
 * resolved from the global npm root; browsers live under
 * /opt/playwright-browsers)
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)

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
    process.env.YAAC_DATA_DIR && path.join(process.env.YAAC_DATA_DIR, 'server-local', '.server.lock'),
    path.join(os.homedir(), '.yaac', 'server-local', '.server.lock'),
  ].filter(Boolean)
  for (const p of candidates) {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'))
  }
  throw new Error(`no .server.lock found (tried ${candidates.join(', ')}) — is the server running?`)
}

let failures = 0
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
  if (!cond) failures++
}

const isAsset = (p) =>
  p === '/' || p.startsWith('/assets') || /\.(js|css|woff2?|svg|png|ico|map)$/.test(p)

async function main() {
  const { chromium } = requirePlaywright()
  const project = process.env.PROJECT || 'yaac'
  const lock = readServerLock()
  const base = `http://127.0.0.1:${lock.port}`

  // Loopback is local: the app needs no credential to load.
  const appUrl = `${base}/?project=${project}`

  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, bypassCSP: true })

  const pageErrors = []
  page.on('pageerror', (err) => { pageErrors.push(err.message); console.log(`  [page error] ${err.message}`) })

  // Ground truth: every same-origin API response (method, path, status).
  const api = []
  page.on('response', (res) => {
    let p
    try { p = new URL(res.url()).pathname } catch { return }
    if (isAsset(p) || p === '/api/events') return
    api.push({ method: res.request().method(), path: p, status: res.status() })
  })
  // The webapp pre-generates the worktree id and sends it in the create body.
  let createdWorktreeId = null
  page.on('request', (req) => {
    if (req.method() !== 'POST' || new URL(req.url()).pathname !== '/api/worktree/create') return
    try { createdWorktreeId = JSON.parse(req.postData() ?? '{}').worktreeId ?? null } catch { /* asserted below */ }
  })
  const hit = (method, pathRe) => api.filter((c) => c.method === method && pathRe.test(c.path))
  const ok2xx = (calls) => calls.length > 0 && calls.every((c) => c.status >= 200 && c.status < 300)

  try {
    // ---- load + identity probe (GET /whoami) ---------------------------
    await page.goto(appUrl)
    await page.waitForSelector('[title="New worktree"]', { timeout: 20_000 })
    check('app rendered main view (identified + initial loads)', true)

    // ---- Settings: a batch of GETs --------------------------------------
    const beforeSettings = api.length
    await page.click('[title="Settings"]')
    await page.waitForTimeout(2000)
    const settingsCalls = api.slice(beforeSettings).filter((c) => c.method === 'GET')
    check('Settings loaded its data', ok2xx(settingsCalls),
      settingsCalls.map((c) => `${c.path} ${c.status}`).join(', '))
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)

    // ---- create a worktree (New worktree → Create) ----------------------
    await page.getByTitle('New worktree').first().click()
    const create = page.getByRole('button', { name: 'Create', exact: true })
    await create.waitFor({ state: 'visible', timeout: 15_000 })
    await page.waitForFunction(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent === 'Create')
      return b !== undefined && !b.disabled
    }, null, { timeout: 15_000 })
    await create.click()
    console.log('worktree create clicked; waiting for the terminal to mount…')
    await page.waitForFunction(() => (window.__xterms?.size ?? 0) > 0, null, { timeout: 300_000 })
    await page.waitForTimeout(1500)
    check('worktree created and opened', !!createdWorktreeId, `id=${createdWorktreeId}`)

    // ---- rename (POST /worktree/:id/title) ------------------------------
    let renamed = false
    try {
      // The worktree header's rename, not the sidebar row's hover twin.
      await page.locator('[aria-label="Rename worktree"]:not(aside *)').click()
      const field = page.getByLabel('Worktree title')
      await field.fill(`rpc-e2e-${Date.now()}`)
      await field.press('Enter')
      renamed = true
    } catch (e) { console.log(`  [rename] ${e.message}`) }
    await page.waitForTimeout(1000)
    check('rename drove a title write', renamed)

    // ---- stop (POST /worktree/stop) -------------------------------------
    let stopped = false
    try {
      await page.locator('[aria-label="Stop worktree"]').first().click({ force: true })
      await page.locator('text=Stop worktree?').waitFor({ state: 'visible', timeout: 5000 })
      await page.getByRole('button', { name: 'Stop', exact: true }).click()
      stopped = true
    } catch (e) { console.log(`  [stop] ${e.message}`) }
    await page.waitForTimeout(3000)
    check('stop drove a worktree-stop write', stopped)

    // ---- assert the endpoints answered 2xx ------------------------------
    check('GET /whoami → 2xx', ok2xx(hit('GET', /^\/api\/whoami$/)))
    check('GET /auth/list → 2xx', ok2xx(hit('GET', /^\/api\/auth\/list$/)))
    check('GET /shortcuts/get → 2xx', ok2xx(hit('GET', /^\/api\/shortcuts\/get$/)))
    check('POST /worktree/create → 2xx', ok2xx(hit('POST', /^\/api\/worktree\/create$/)))
    if (renamed) check('POST /worktree/:id/title → 2xx', ok2xx(hit('POST', /^\/api\/worktree\/[^/]+\/title$/)))
    if (stopped) check('POST /worktree/stop → 2xx', ok2xx(hit('POST', /^\/api\/worktree\/stop$/)))
    check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))
    check('no API 4xx/5xx (except benign 404 skew probes)',
      api.every((c) => c.status < 400 || c.status === 404),
      api.filter((c) => c.status >= 400).map((c) => `${c.method} ${c.path} ${c.status}`).join(', '))

    console.log('\n--- captured API calls ---')
    for (const c of api) console.log(`  ${c.method.padEnd(6)} ${String(c.status).padEnd(4)} ${c.path}`)
  } finally {
    await browser.close()
    // Cleanup fallback: if the UI stop didn't land, stop it via the API.
    if (createdWorktreeId) {
      await fetch(`${base}/api/worktree/stop`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ worktreeId: createdWorktreeId }),
      }).catch(() => {})
    }
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => { console.error(err); process.exit(1) })
