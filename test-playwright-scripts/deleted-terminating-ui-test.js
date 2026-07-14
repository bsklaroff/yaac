/*
 * Verifies the deleted / terminating-sessions UI in real Chromium:
 *   - a session marked `terminating` renders as a greyed, non-interactive
 *     "terminating…" row in the sidebar (SessionRow's terminating branch),
 *     distinct from a live running row;
 *   - the sidebar-header trash button opens the full-screen deleted-sessions
 *     overlay (DeletedSessionsButton): a search box + a newest-deleted-first
 *     master list, and a detail pane showing Created / Last active / Deleted
 *     times, the prompt, and a Restart action;
 *   - the search box filters the list, and a no-match query shows "No matches."
 *
 * Unlike the other scripts here, this one does NOT need a running server: it
 * serves the built SPA (packages/frontend/dist) from a throwaway static server and
 * MOCKS the backend — the /events WebSocket delivers a snapshot carrying a
 * terminating session, and /session/list-deleted returns ordered entries. That
 * isolates the changed frontend code from the live cluster/session stack (handy
 * when no project is seeded). The server-side ordering/classification logic is
 * covered by the vitest suites in packages/server.
 *
 * Run: pnpm frontend:build && node test-playwright-scripts/deleted-terminating-ui-test.js
 * (set SCREENSHOT_DIR to capture screenshots there; playwright is resolved from
 * the global npm root, browsers live under /opt/playwright-browsers)
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
function requirePlaywright() {
  try { return require('playwright') } catch {
    return require(path.join(execSync('npm root -g').toString().trim(), 'playwright'))
  }
}
const { chromium } = requirePlaywright()

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(REPO, 'packages/frontend/dist')
const SHOTS = process.env.SCREENSHOT_DIR
if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error('packages/frontend/dist not found — run `pnpm frontend:build` first.')
  process.exit(1)
}
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
const shot = (name) => SHOTS ? path.join(SHOTS, name) : undefined

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' }
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0])
  let file = path.join(DIST, urlPath)
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html')
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' })
  res.end(fs.readFileSync(file))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

const SNAPSHOT = {
  sessions: [
    { sessionId: 'run-1', projectSlug: 'demo', tool: 'claude', status: 'running',
      createdAt: '2026-07-13 12:00:00', prompt: 'Refactor the parser', title: 'Refactor the parser',
      blockedHosts: [], forwardedPorts: [] },
    { sessionId: 'term-1', projectSlug: 'demo', tool: 'codex', status: 'running', terminating: true,
      createdAt: '2026-07-13 12:30:00', prompt: 'Add tests', title: 'Add tests for the lexer',
      blockedHosts: [], forwardedPorts: [] },
  ],
  stale: [],
  projects: [{ slug: 'demo', remoteUrl: 'https://example.com/demo', addedAt: '2026-07-01T00:00:00Z', sessionCount: 2 }],
  provisioning: [], gitAuthFailures: {}, imageBuilds: [], planUsage: null,
}
// Already newest-deleted-first, as listDeletedSessions now returns.
const DELETED = [
  { sessionId: 'd1', projectSlug: 'demo', tool: 'claude', title: 'Fix the auth bug',
    prompt: 'Fix the auth bug in the login flow', createdAt: '2026-07-13 09:00:00',
    lastActiveAt: '2026-07-13 10:30:00', deletedAt: '2026-07-13 11:00:00' },
  { sessionId: 'd2', projectSlug: 'demo', tool: 'codex', title: 'Port the lexer to Rust',
    createdAt: '2026-07-12 08:00:00', lastActiveAt: '2026-07-12 09:00:00', deletedAt: '2026-07-13 08:00:00' },
  { sessionId: 'd3', projectSlug: 'demo', tool: 'opencode', title: 'Docs pass',
    createdAt: '2026-07-10 08:00:00', lastActiveAt: '2026-07-10 08:30:00', deletedAt: '2026-07-11 08:00:00' },
]

let failures = 0
const check = (label, cond) => { console.log(`${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++ }

const browser = await chromium.launch({ executablePath: process.env.PW_CHROME })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })

await page.route('**/auth/web-session', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
await page.route('**/cluster/check', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, results: [] }) }))
await page.route('**/session/list-deleted**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DELETED) }))
await page.routeWebSocket('**/events', (ws) => { ws.onMessage(() => {}); ws.send(JSON.stringify({ type: 'snapshot', data: SNAPSHOT })) })

await page.goto(base)
await page.getByText('Refactor the parser').first().waitFor({ timeout: 10000 })

// Behavior 1: terminating row is a greyed, non-interactive placeholder.
check('terminating row shows "terminating…"', await page.getByText('terminating…').count() > 0)
const term = page.locator('div', { hasText: 'Add tests for the lexer' }).filter({ hasText: 'terminating…' }).last()
const opacity = await term.evaluate((el) => getComputedStyle(el.closest('[aria-disabled]') || el).opacity).catch(() => '1')
check('terminating row is greyed (opacity < 1)', parseFloat(opacity) < 1)
if (shot('1-sidebar-terminating.png')) await page.screenshot({ path: shot('1-sidebar-terminating.png') })

// Behavior 2: full-screen deleted overlay.
await page.getByRole('button', { name: 'Deleted sessions' }).click()
await page.getByText('Fix the auth bug').first().waitFor({ timeout: 5000 })
await page.waitForTimeout(400)
check('overlay title present', await page.getByText('Deleted sessions', { exact: true }).count() > 0)
check('search box present', await page.getByPlaceholder('Search…').count() > 0)
check('detail shows the prompt', await page.getByText('Fix the auth bug in the login flow').count() > 0)
check('detail shows Created/Last active/Deleted labels',
  (await page.getByText('Created', { exact: true }).count()) > 0 &&
  (await page.getByText('Last active', { exact: true }).count()) > 0 &&
  (await page.getByText('Deleted', { exact: true }).count()) > 0)
check('Restart action present', await page.getByRole('button', { name: /Restart/ }).count() > 0)
const listText = await page.locator('ul').filter({ hasText: 'Fix the auth bug' }).innerText()
const [a, l, d] = ['Fix the auth bug', 'Port the lexer to Rust', 'Docs pass'].map((t) => listText.indexOf(t))
check('rows ordered newest-deleted-first', a >= 0 && a < l && l < d)
check('list row shows relative "deleted … ago"', /deleted .* ago/.test(listText))
if (shot('2-deleted-overlay.png')) await page.screenshot({ path: shot('2-deleted-overlay.png') })

// Search filter + no-match probe.
await page.getByPlaceholder('Search…').fill('lexer')
await page.waitForTimeout(300)
check('search filters to the matching row', await page.getByText('Fix the auth bug').count() === 0)
check('search keeps the match', await page.getByText('Port the lexer to Rust').count() > 0)
if (shot('3-deleted-search.png')) await page.screenshot({ path: shot('3-deleted-search.png') })
await page.getByPlaceholder('Search…').fill('zzzznomatch')
await page.waitForTimeout(200)
check('no-match search shows "No matches."', await page.getByText('No matches.').count() > 0)

await browser.close()
server.close()
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
