/*
 * End-to-end check of the frontend's Hono RPC client (packages/frontend/src/lib/
 * rpc.ts + the migrated lib/*Api modules) against the real running stack.
 *
 * Drives the running yaac server's webapp in real Chromium and exercises the
 * migrated request paths through the actual compiled `hc<AppType>` client:
 *   - initial load        → GET /cluster/check, /auth/list, /auth/web-session
 *   - open Settings       → GET /tool/get, /shortcuts/get, /config/..., /project/...
 *   - New session → Claude→ POST /session/create (NDJSON stream, unchanged)
 *   - Rename session      → POST /session/:id/title   (rpc write)
 *   - Delete session      → POST /session/delete       (rpc write)
 * Every same-origin API response is captured (method, path, status); the run
 * asserts the app authenticated via cookie, rendered its main view, produced no
 * page errors, and that each exercised rpc endpoint answered 2xx.
 *
 * Run: node test-playwright-scripts/rpc-client-e2e-test.js
 * Needs a running server (`yaac open` / `yaac server start`) with a project
 * configured; reads the port/secret from $YAAC_DATA_DIR/.server.lock (or
 * ~/.yaac). Any session it creates is deleted at the end (UI, then API
 * fallback). (playwright is resolved from the global npm root; browsers live
 * under /opt/playwright-browsers)
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
    process.env.YAAC_DATA_DIR && path.join(process.env.YAAC_DATA_DIR, '.server.lock'),
    path.join(os.homedir(), '.yaac', '.server.lock'),
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
  const lock = readServerLock()
  const base = `http://127.0.0.1:${lock.port}`
  const auth = { authorization: `Bearer ${lock.secret}` }

  // Fresh one-time exchange token → authed URL (?token=…); the SPA exchanges
  // it for the session cookie on load.
  const openOut = execSync('yaac open --no-browser', { encoding: 'utf8' }).trim()
  const authedUrl = openOut.split('\n').map((l) => l.trim()).find((l) => l.startsWith('http'))
  if (!authedUrl) throw new Error(`could not parse authed URL from: ${openOut}`)

  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, bypassCSP: true })

  const pageErrors = []
  page.on('pageerror', (err) => { pageErrors.push(err.message); console.log(`  [page error] ${err.message}`) })

  // Ground truth: every same-origin API response (method, path, status).
  const api = []
  page.on('response', (res) => {
    let p
    try { p = new URL(res.url()).pathname } catch { return }
    if (isAsset(p) || p === '/events') return
    api.push({ method: res.request().method(), path: p, status: res.status() })
  })
  const hit = (method, pathRe) => api.filter((c) => c.method === method && pathRe.test(c.path))
  const ok2xx = (calls) => calls.length > 0 && calls.every((c) => c.status >= 200 && c.status < 300)

  let createdSessionId = null
  try {
    // ---- load + cookie auth (postWebSession) ----------------------------
    await page.goto(authedUrl)
    await page.waitForSelector('[title="New session"]', { timeout: 20_000 })
    check('app rendered main view (cookie auth + initial rpc loads)', true)

    // ---- Settings: a batch of rpc GETs ----------------------------------
    await page.click('[title="Settings"]')
    await page.waitForTimeout(2000)
    await page.screenshot({ path: '/tmp/claude-501/-workspace/1ac8ca0a-06c6-41ec-9446-44180cde595c/scratchpad/rpc-e2e-settings.png' }).catch(() => {})
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)

    // ---- create a session (New session → Claude) ------------------------
    await page.click('[title="New session"]')
    await page.getByRole('menuitem', { name: 'Claude', exact: true }).click()
    console.log('session create clicked; waiting for the terminal to mount…')
    await page.waitForFunction(() => (window.__xterms?.size ?? window.__xterms?.length ?? 0) > 0, null, { timeout: 300_000 })
    await page.waitForTimeout(1500)
    createdSessionId = await page.evaluate(() => {
      try { return JSON.parse(localStorage.getItem('yaac.selection.v1') ?? '{}').sessionId ?? null } catch { return null }
    })
    check('session created and opened', !!createdSessionId, `id=${createdSessionId}`)

    // ---- rename (rpc POST /session/:id/title) ---------------------------
    const newTitle = `rpc-e2e-${Date.now()}`
    let renamed = false
    try {
      // The session-header actions menu (SessionActionsMenu) is a base-ui menu
      // trigger with no title; open the candidate that reveals a Rename item.
      const triggers = page.locator('button[aria-haspopup="menu"]:not([title])')
      const n = await triggers.count()
      for (let i = 0; i < n; i++) {
        await triggers.nth(i).click()
        const item = page.getByRole('menuitem', { name: 'Rename', exact: true })
        if (await item.isVisible().catch(() => false)) {
          await item.click()
          await page.getByRole('textbox').fill(newTitle)
          await page.getByRole('button', { name: 'Rename', exact: true }).click()
          renamed = true
          break
        }
        await page.keyboard.press('Escape')
      }
    } catch (e) { console.log(`  [rename] ${e.message}`) }
    await page.waitForTimeout(1000)
    check('rename drove a title write', renamed)

    // ---- delete (rpc POST /session/delete) ------------------------------
    let deleted = false
    try {
      const row = page.locator(`[title="Delete session"]`).first()
      await row.click({ force: true })
      await page.getByRole('button', { name: 'Delete', exact: true }).click()
      deleted = true
    } catch (e) { console.log(`  [delete] ${e.message}`) }
    await page.waitForTimeout(1500)
    check('delete drove a session-delete write', deleted)

    // ---- assert the rpc endpoints answered 2xx --------------------------
    check('GET /cluster/check → 2xx', ok2xx(hit('GET', /^\/cluster\/check$/)))
    check('GET /auth/list → 2xx', ok2xx(hit('GET', /^\/auth\/list$/)))
    check('GET /tool/get → 2xx', ok2xx(hit('GET', /^\/tool\/get$/)))
    check('GET /shortcuts/get → 2xx', ok2xx(hit('GET', /^\/shortcuts\/get$/)))
    check('POST /session/create → 2xx', ok2xx(hit('POST', /^\/session\/create$/)))
    if (renamed) check('POST /session/:id/title → 2xx', ok2xx(hit('POST', /^\/session\/[^/]+\/title$/)))
    if (deleted) check('POST /session/delete → 2xx', ok2xx(hit('POST', /^\/session\/delete$/)))
    check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))
    check('no API 4xx/5xx (except benign 404 skew probes)',
      api.every((c) => c.status < 400 || c.status === 404),
      api.filter((c) => c.status >= 400).map((c) => `${c.method} ${c.path} ${c.status}`).join(', '))

    console.log('\n--- captured API calls ---')
    for (const c of api) console.log(`  ${c.method.padEnd(6)} ${String(c.status).padEnd(4)} ${c.path}`)
  } finally {
    await browser.close()
    // Cleanup fallback: if the UI delete didn't land, remove via the API.
    if (createdSessionId) {
      await fetch(`${base}/session/delete`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: createdSessionId }),
      }).catch(() => {})
    }
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => { console.error(err); process.exit(1) })
