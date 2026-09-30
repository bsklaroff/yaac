#!/usr/bin/env node
/*
 * run-yaac web-app driver.
 *
 * Drives the yaac web app (the React SPA the `yaac` server serves) in a real
 * headless Chromium via Playwright. Use it to screenshot the app or to
 * evaluate arbitrary JS against the live DOM — the same handle the committed
 * test-playwright-scripts/*.js use, generalized into a reusable CLI.
 *
 * It talks to whatever server this install's clients are registered with: it
 * reads the selected origin from `server.json` (`<data dir>-client/`, either
 * substrate) and loads it. No credential is needed: the server trusts loopback
 * callers and identifies tailnet callers by their tailnet user. Set
 * YAAC_DATA_DIR to drive a different install.
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
 *   --goto <path>       route to load (default "/")
 *   --click <selector>  click this element after load (e.g. an aria-label match)
 *   --wait <selector>   extra selector to wait for before acting
 *   --settle <ms>       pause after load for pushed /events to populate (default 3000)
 *   --full              full-page screenshot (shot only)
 *
 * Playwright selector tips: text via `text=New session`, aria via
 * `[aria-label="Skills"]`, or any CSS. Combine --click + shot to reach and
 * capture an interior view in one browser session.
 *
 * Run: node .claude/skills/run-yaac/driver.mjs shot
 * Needs a running server (`yaac server start` or `yaac cluster install`).
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)

// The base env normally sets this; default it so any shell works.
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

/** The server this install's clients dial: `server.json`'s selected entry. */
function readSelectedServer() {
  const dataDir = process.env.YAAC_DATA_DIR || path.join(os.homedir(), '.yaac')
  const file = `${dataDir}-client/server.json`
  let cfg
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    throw new Error(`no ${file} — is a server registered? try: yaac server start`)
  }
  if (!cfg.enabled) throw new Error(`no server selected in ${file} — try: yaac remote on`)
  return cfg
}

const { positional, flags } = parseArgs(process.argv.slice(2))
const cmd = positional[0] ?? 'open'
const server = readSelectedServer()
const target = new URL(flags.goto ?? '/', server.url)
const settleMs = flags.settle !== undefined ? Number(flags.settle) : 3000

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
let exitCode = 0
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await ctx.newPage()
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))

  await page.goto(target.href)
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
