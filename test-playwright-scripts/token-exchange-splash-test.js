/*
 * Verifies the webapp's token→cookie auth flow after the bootstrap-code
 * machinery was replaced by token-store exchange tokens:
 *  1. Opening `/?token=<one-time token>` (as printed by `yaac open`)
 *     silently exchanges the token for the yaac_session cookie, strips
 *     the param from the address bar, and lands in the workspace.
 *  2. A reload with no token stays authed via the cookie alone.
 *  3. A fresh browser context (no cookie, no token) gets the connect
 *     splash; pasting a durable token (`yaac auth token create`) into
 *     the form authenticates; pasting garbage shows the error message.
 *
 * Drives the Vite dev server (`pnpm frontend:dev`, port 1420), which
 * proxies /auth to the live yaac server. One-time and durable tokens
 * are minted over the server's own API using the lock secret.
 *
 * Run: node test-playwright-scripts/token-exchange-splash-test.js
 * (set SCREENSHOT_DIR to capture the workspace and splash states)
 * Needs a running server (`yaac server start`) and the frontend dev
 * server on :1420; reads port/secret from $YAAC_DATA_DIR/.server.lock
 * (or ~/.yaac). (playwright is resolved from the global npm root;
 * browsers live under /opt/playwright-browsers)
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
  const mark = cond ? 'PASS' : 'FAIL'
  if (!cond) failures++
  console.log(`${mark}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const APP_URL = process.env.APP_URL ?? 'http://localhost:1420'
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR

async function mintToken(lock, body) {
  const res = await fetch(`http://127.0.0.1:${lock.port}/tokens`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${lock.secret}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (res.status !== 201) throw new Error(`mint failed: HTTP ${res.status}`)
  return (await res.json()).token
}

async function shot(page, name) {
  if (!SCREENSHOT_DIR) return
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true })
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, name) })
}

const splashHeading = (page) => page.getByRole('heading', { name: 'Connect to yaac' })

const { chromium } = requirePlaywright()
const lock = readServerLock()
const browser = await chromium.launch()
try {
  // 1. ?token= exchange: lands authed, param stripped, cookie set.
  const ctx1 = await browser.newContext()
  const page1 = await ctx1.newPage()
  const oneTime = await mintToken(lock, { kind: 'one-time' })
  await page1.goto(`${APP_URL}/?token=${oneTime}`)
  await page1.waitForFunction(() => !window.location.search.includes('token='))
  check('?token= is stripped from the URL', !page1.url().includes('token='), page1.url())
  await splashHeading(page1).waitFor({ state: 'hidden' })
  check('workspace shown, not the splash', !(await splashHeading(page1).isVisible()))
  const cookies = await ctx1.cookies(APP_URL)
  const session = cookies.find((c) => c.name === 'yaac_session')
  check('yaac_session cookie set (HttpOnly)', !!session && session.httpOnly)
  await shot(page1, 'workspace-after-token-exchange.png')

  // 2. Cookie alone keeps the session across a reload.
  await page1.goto(APP_URL)
  await page1.waitForLoadState('networkidle')
  check('reload without token stays authed', !(await splashHeading(page1).isVisible()))
  await ctx1.close()

  // 3. Fresh context: splash; garbage token errors; durable token connects.
  const ctx2 = await browser.newContext()
  const page2 = await ctx2.newPage()
  await page2.goto(APP_URL)
  await splashHeading(page2).waitFor()
  check('fresh context gets the connect splash', true)
  await shot(page2, 'connect-splash.png')

  await page2.getByPlaceholder('token').fill('not-a-real-token')
  await page2.getByRole('button', { name: 'Connect' }).click()
  const error = page2.getByText('Invalid or expired token', { exact: false })
  await error.waitFor()
  check('garbage token shows the invalid-token error', await error.isVisible())
  await shot(page2, 'connect-splash-error.png')

  const durable = await mintToken(lock, { name: `pw-${Date.now().toString(36)}` })
  await page2.getByPlaceholder('token').fill(durable)
  await page2.getByRole('button', { name: 'Connect' }).click()
  await splashHeading(page2).waitFor({ state: 'hidden' })
  check('pasted durable token authenticates', !(await splashHeading(page2).isVisible()))
  await ctx2.close()
} finally {
  await browser.close()
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
