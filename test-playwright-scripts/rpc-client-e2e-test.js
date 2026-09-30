/*
 * Smoke-tests the frontend's typed Hono API client (packages/frontend/src/
 * lib/api.ts and the lib/*Api modules) against a running server, through
 * the webapp in real Chromium. It drives the initial load (GET /whoami),
 * Settings, New workspace → Create (the NDJSON create stream), a header
 * rename and a stop (Alt+D), capturing every same-origin API response, and asserts each
 * exercised endpoint answered 2xx, nothing answered 4xx/5xx and the page
 * threw no errors.
 *
 * Needs a running `yaac server` whose project (PROJECT, default yaac) can
 * create a workspace: a git credential, a git identity and a claude
 * credential (`yaac auth fake claude-oauth` is enough). The workspace it
 * creates is stopped at the end.
 *
 * Run: YAAC_DATA_DIR=... PROJECT=<slug> node test-playwright-scripts/rpc-client-e2e-test.js
 */
import { api, check, finish, origin, requirePlaywright, until } from './lib.js'

const project = process.env.PROJECT || 'yaac'
const isAsset = (p) => !p.startsWith('/api/') || p === '/api/events'

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const pageErrors = []
page.on('pageerror', (err) => { pageErrors.push(err.message); console.log(`  [page error] ${err.message}`) })

const calls = []
page.on('response', (res) => {
  const p = new URL(res.url()).pathname
  if (!isAsset(p)) calls.push({ method: res.request().method(), path: p, status: res.status() })
})
// The webapp pre-generates the workspace id and sends it in the create body.
let createdId = null
page.on('request', (req) => {
  if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/workspace/create') {
    createdId = JSON.parse(req.postData() ?? '{}').workspaceId ?? null
  }
})
const hit = (method, re) => calls.filter((c) => c.method === method && re.test(c.path))
const ok2xx = (cs) => cs.length > 0 && cs.every((c) => c.status >= 200 && c.status < 300)

try {
  await page.goto(`${origin}/?project=${project}`)
  await page.getByTitle('New workspace').first().waitFor({ timeout: 20_000 })

  const beforeSettings = calls.length
  await page.getByTitle('Settings').click()
  await page.waitForTimeout(2000)
  const settingsCalls = calls.slice(beforeSettings)
  check('Settings loaded its data', ok2xx(settingsCalls), settingsCalls.map((c) => `${c.path} ${c.status}`).join(', '))
  await page.keyboard.press('Escape')

  await page.getByTitle('New workspace').first().click()
  const create = page.getByRole('button', { name: 'Create', exact: true })
  await until(page, () => [...document.querySelectorAll('button')]
    .some((b) => b.textContent === 'Create' && !b.disabled))
  await create.click()
  console.log('create clicked; waiting for the workspace to run…')
  await until(page, () => /[?&]workspace=/.test(location.search), null, 60_000)
  for (let i = 0; i < 120; i++) {
    const { workspaces } = await api('/workspace/list')
    if (workspaces.some((w) => w.workspaceId === createdId && w.status !== 'provisioning')) break
    await page.waitForTimeout(1000)
  }
  check('workspace created and opened', createdId !== null, `id=${createdId}`)

  // The workspace header's rename, not the sidebar row's.
  await page.locator('[aria-label="Rename workspace"]:not(aside *)').click()
  const field = page.getByLabel('Workspace title')
  await field.fill(`rpc-e2e-${Date.now()}`)
  await field.press('Enter')
  await page.waitForTimeout(1000)

  await page.locator('body').click({ position: { x: 700, y: 20 } })
  await page.keyboard.press('Alt+d')
  await page.getByRole('button', { name: 'Stop', exact: true }).click({ timeout: 5000 })
  await page.waitForTimeout(3000)

  check('GET /whoami → 2xx', ok2xx(hit('GET', /^\/api\/whoami$/)))
  check('GET /auth/list → 2xx', ok2xx(hit('GET', /^\/api\/auth\/list$/)))
  check('GET /shortcuts/get → 2xx', ok2xx(hit('GET', /^\/api\/shortcuts\/get$/)))
  check('POST /workspace/create → 2xx', ok2xx(hit('POST', /^\/api\/workspace\/create$/)))
  check('POST /workspace/:id/title → 2xx', ok2xx(hit('POST', /^\/api\/workspace\/[^/]+\/title$/)))
  check('POST /workspace/stop → 2xx', ok2xx(hit('POST', /^\/api\/workspace\/stop$/)))
  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))
  check('no API 4xx/5xx', calls.every((c) => c.status < 400),
    calls.filter((c) => c.status >= 400).map((c) => `${c.method} ${c.path} ${c.status}`).join(', '))
  console.log('\n--- captured API calls ---')
  for (const c of calls) console.log(`  ${c.method.padEnd(6)} ${String(c.status).padEnd(4)} ${c.path}`)
} finally {
  await browser.close()
  // Stop it via the API too, in case the UI stop did not land.
  if (createdId) await api('/workspace/stop', { method: 'POST', body: { workspaceId: createdId } }).catch(() => {})
}
finish()
