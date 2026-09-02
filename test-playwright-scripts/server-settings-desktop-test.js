/*
 * Verifies the desktop-only "Server" settings section (ServerSettings.tsx):
 * (1) with no `window.yaacServer` bridge (plain browser) the Server entry is
 * absent from the settings nav; (2) with a bridge injected pre-load (standing
 * in for the Electron preload) the section appears, lists every configured
 * server as an origin with the current one marked Connected — there is no
 * "local server" row, since a server on this machine is registered like any
 * other (docs/server-selection.md) — Connect routes the right selection
 * through `switchTo` and shows "Reconnecting…", a failing switch renders its
 * error inline, and the add form passes url+token to `addRemote`. Drives the
 * running yaac server's webapp in real Chromium.
 *
 * Run: node test-playwright-scripts/server-settings-desktop-test.js
 * Needs a running server (`yaac server start` / `pnpm watch`).
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
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
  throw new Error('no .server.lock found — is the server running?')
}

async function mintToken(lock) {
  const res = await fetch(`http://127.0.0.1:${lock.port}/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${lock.secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'one-time' }),
  })
  if (res.status !== 201) throw new Error(`token mint failed: HTTP ${res.status}`)
  return (await res.json()).token
}

const SHOTS = '/tmp/yaac-shots'

async function openApp(page, lock) {
  const token = await mintToken(lock)
  await page.goto(`http://127.0.0.1:${lock.port}/?token=${token}`)
  await page.waitForFunction(() => !window.location.search.includes('token='), { timeout: 15_000 })
  await page.locator('[title="Settings"]').first().click()
  await page.locator('button', { hasText: 'General' }).first().waitFor()
}

async function main() {
  const { chromium } = requirePlaywright()
  const lock = readServerLock()
  fs.mkdirSync(SHOTS, { recursive: true })
  const browser = await chromium.launch()
  const failures = []
  const check = (ok, label) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}`)
    if (!ok) failures.push(label)
  }

  // --- 1. Plain browser: no bridge → no Server nav entry.
  {
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
    page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
    await openApp(page, lock)
    const navLabels = await page.evaluate(() =>
      [...document.querySelectorAll('[role="dialog"] button')].map((b) => b.textContent.trim()))
    check(!navLabels.includes('Server'), 'browser settings nav has no Server entry')
    await page.close()
  }

  // --- 2. Bridge injected pre-load (what the Electron preload does).
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await context.addInitScript(() => {
    window.__bridgeCalls = []
    window.yaacServer = {
      targets: () => Promise.resolve({
        current: 'https://alpha.ts.net',
        saved: ['https://alpha.ts.net', 'https://beta.ts.net', 'http://127.0.0.1:8787'],
      }),
      switchTo: (sel) => {
        window.__bridgeCalls.push(['switchTo', sel])
        return sel.url === 'http://127.0.0.1:8787'
          ? Promise.resolve({ ok: false, error: 'cannot reach http://127.0.0.1:8787 (scripted failure)' })
          : Promise.resolve({ ok: true })
      },
      addRemote: (url, tok) => {
        window.__bridgeCalls.push(['addRemote', url, tok])
        return Promise.resolve({ ok: true })
      },
    }
  })
  const page = await context.newPage()
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  await openApp(page, lock)

  const serverNav = page.locator('button', { hasText: 'Server' }).first()
  check(await serverNav.isVisible(), 'desktop settings nav shows Server entry')
  await serverNav.click()
  await page.getByText('Add a server').waitFor()

  const alphaRow = page.locator('div', { hasText: 'https://alpha.ts.net' }).last()
  check((await alphaRow.textContent()).includes('Connected'), 'current server marked Connected')
  check(!(await page.getByText('Local server').count()), 'no "Local server" row')
  check(await page.getByText('https://beta.ts.net').isVisible(), 'other saved server listed')
  // A server on this machine is a row like any other, named by its origin.
  check(await page.getByText('http://127.0.0.1:8787').isVisible(), 'loopback server listed as an origin')
  await page.screenshot({ path: path.join(SHOTS, 'server-settings-desktop.png') })

  // A failing switch renders inline, no reconnect.
  await page.locator('div', { hasText: 'http://127.0.0.1:8787' }).last().locator('button').click()
  await page.getByText('cannot reach http://127.0.0.1:8787 (scripted failure)').waitFor()
  check(true, 'failed switch shows inline error')
  await page.screenshot({ path: path.join(SHOTS, 'server-settings-switch-error.png') })

  // A successful switch to the other saved remote → Reconnecting…
  await page.locator('div', { hasText: 'https://beta.ts.net' }).last().locator('button').click()
  await page.getByText('Reconnecting…').waitFor()
  check(true, 'successful switch shows Reconnecting…')

  const calls = await page.evaluate(() => window.__bridgeCalls)
  check(
    JSON.stringify(calls[0]) === JSON.stringify(['switchTo', { url: 'http://127.0.0.1:8787' }])
      && JSON.stringify(calls[1]) === JSON.stringify(['switchTo', { url: 'https://beta.ts.net' }]),
    `switchTo received the clicked selections (got ${JSON.stringify(calls)})`,
  )

  // Add-remote form (fresh page — the last switch left this one "Reconnecting…").
  const page2 = await context.newPage()
  await openApp(page2, lock)
  await page2.locator('button', { hasText: 'Server' }).first().click()
  await page2.getByPlaceholder('https://host.ts.net').fill('https://gamma.ts.net')
  await page2.getByPlaceholder('token').fill('tok-123')
  await page2.getByPlaceholder('token').press('Enter')
  await page2.getByText('Reconnecting…').waitFor()
  const addCalls = await page2.evaluate(() => window.__bridgeCalls.filter((c) => c[0] === 'addRemote'))
  check(
    JSON.stringify(addCalls) === JSON.stringify([['addRemote', 'https://gamma.ts.net', 'tok-123']]),
    `addRemote received the form values (got ${JSON.stringify(addCalls)})`,
  )
  await page2.screenshot({ path: path.join(SHOTS, 'server-settings-add-remote.png') })

  await browser.close()
  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed`)
    process.exit(1)
  }
  console.log('\nAll checks passed')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
