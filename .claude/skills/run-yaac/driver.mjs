#!/usr/bin/env node
/*
 * run-yaac web-app driver.
 *
 * Drives the yaac web app (the React SPA the `yaac` server serves) in a real
 * headless Chromium via Playwright, doing the one-time-token -> session-cookie
 * auth handshake `yaac open` does for you. Use it to screenshot the app or to
 * evaluate arbitrary JS against the live DOM — the same handle the committed
 * test-playwright-scripts/*.js use, generalized into a reusable CLI.
 *
 * It talks to whatever `yaac server` is already running: it reads the port and
 * lock secret from $YAAC_DATA_DIR/.server.lock (falling back to ~/.yaac), mints
 * a one-time token over the loopback API, and points the browser at the server
 * origin (default http://127.0.0.1:<port>) which exchanges the token for the
 * HttpOnly cookie and drops the ?token= from the URL.
 *
 * Playwright is resolved from the global npm root (with a bare require
 * fallback); Chromium binaries live under /opt/playwright-browsers.
 *
 * Usage:
 *   node driver.mjs shot [name]           screenshot -> /tmp/yaac-shots/<name>.png (default: app)
 *   node driver.mjs eval '<js-expr>'      evaluate an expression against the page, print JSON
 *   node driver.mjs open                  just load the app and report the resolved URL/title
 *
 * Flags (any command):
 *   --goto <path>       route to load after auth (default "/")
 *   --click <selector>  click this element after load (e.g. an aria-label match)
 *   --wait <selector>   extra selector to wait for before acting
 *   --url <origin>      server origin (default http://127.0.0.1:<lock.port>)
 *   --settle <ms>       pause after load for pushed /events to populate (default 3000)
 *   --full              full-page screenshot (shot only)
 *
 * Playwright selector tips: text via `text=New session`, aria via
 * `[aria-label="Skills"]`, or any CSS. Combine --click + shot to reach and
 * capture an interior view in one browser session.
 *
 * Run: node .claude/skills/run-yaac/driver.mjs shot
 * Needs a running server (`yaac server start`, or the `pnpm watch` dev loop).
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)

// Chromium binaries live under /opt/playwright-browsers in this image; the base
// env normally sets this, but default it so the driver works from any shell.
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
  throw new Error(`no .server.lock found (tried ${candidates.join(', ')}) — is the server running? try: yaac server start`)
}

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--full') flags.full = true
    else if (a.startsWith('--')) flags[a.slice(2)] = argv[++i]
    else positional.push(a)
  }
  return { positional, flags }
}

async function mintToken(lock) {
  const res = await fetch(`http://127.0.0.1:${lock.port}/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${lock.secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'one-time' }),
  })
  if (res.status !== 201) throw new Error(`token mint failed: HTTP ${res.status} ${await res.text()}`)
  return (await res.json()).token
}

const { positional, flags } = parseArgs(process.argv.slice(2))
const cmd = positional[0] ?? 'open'
const lock = readServerLock()
const origin = flags.url ?? `http://127.0.0.1:${lock.port}`
const gotoPath = flags.goto ?? '/'
const settleMs = flags.settle !== undefined ? Number(flags.settle) : 3000

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
let exitCode = 0
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await ctx.newPage()
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))

  const token = await mintToken(lock)
  const sep = gotoPath.includes('?') ? '&' : '?'
  await page.goto(`${origin}${gotoPath}${sep}token=${token}`)
  // The server strips ?token= after setting the cookie.
  await page.waitForFunction(() => !window.location.search.includes('token='), { timeout: 15_000 })
  // The seeded env has a single project -> auto-selected; wait for the sidebar.
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {})
  if (flags.click) await page.locator(flags.click).first().click({ timeout: 15_000 })
  if (flags.wait) await page.locator(flags.wait).first().waitFor({ state: 'visible', timeout: 15_000 })
  if (settleMs > 0) await page.waitForTimeout(settleMs)

  const url = page.url()
  const title = await page.title()

  if (cmd === 'shot') {
    const name = positional[1] ?? 'app'
    const dir = '/tmp/yaac-shots'
    fs.mkdirSync(dir, { recursive: true })
    const out = path.join(dir, `${name}.png`)
    await page.screenshot({ path: out, fullPage: !!flags.full })
    console.log(`screenshot -> ${out}  (url=${url} title=${JSON.stringify(title)})`)
  } else if (cmd === 'eval') {
    const expr = positional[1]
    if (!expr) throw new Error('eval needs a JS expression argument')
    const result = await page.evaluate((e) => (0, eval)(e), expr)
    console.log(JSON.stringify(result, null, 2))
  } else if (cmd === 'open') {
    console.log(`loaded ${url}  title=${JSON.stringify(title)}`)
  } else {
    throw new Error(`unknown command "${cmd}" (want: shot | eval | open)`)
  }
} catch (err) {
  console.error(`driver error: ${err instanceof Error ? err.message : String(err)}`)
  exitCode = 1
} finally {
  await browser.close()
}
process.exit(exitCode)
