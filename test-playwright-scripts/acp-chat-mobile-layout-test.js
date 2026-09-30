/*
 * Verifies the ACP chat pane at phone width (390x844, touch) in real
 * Chromium, for layout that jsdom cannot check:
 *
 *  1. Nothing in the conversation is wider than the pane, even a long
 *     unbroken token (a sha, URL or base64 blob).
 *  2. The input font is at least 16px, so mobile Safari does not zoom the
 *     page on focus.
 *  3. The page itself never scrolls; only panes inside it do.
 *  4. The input box grows with a multi-line message, up to its max-height.
 *
 * Uses the app the server serves from `dist/` (port from
 * $YAAC_DATA_DIR/.server.lock), so run `pnpm build` and `yaac server
 * restart` first. Not the Vite dev server: React.StrictMode opens two ACP
 * sockets there and the sent prompt is never delivered.
 *
 * Needs a running `yaac server` with a live ACP workspace in the selected
 * project (`yaac workspace create <project> --tool claude --mode acp`), and
 * sends it one small prompt.
 *
 * Run: node test-playwright-scripts/acp-chat-mobile-layout-test.js
 * (set SCREENSHOT_DIR to capture the pane; defaults to /tmp/yaac-shots,
 * APP_URL to point it elsewhere).
 * (playwright is resolved from the global npm root; browsers live under
 * /opt/playwright-browsers)
 */
import fs from 'node:fs'
import { execSync } from 'node:child_process'
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
  throw new Error(`no .server.lock found (tried ${candidates.join(', ')}) — is the server running?`)
}

/**
 * Poll an in-page predicate until it holds. Not `page.waitForFunction`,
 * which needs `unsafe-eval` and the app's CSP forbids it.
 */
async function until(page, fn, arg, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await page.evaluate(fn, arg)) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${fn.name || 'condition'}`)
    await page.waitForTimeout(500)
  }
}

let failures = 0
function check(name, cond, detail = '') {
  const mark = cond ? 'PASS' : 'FAIL'
  if (!cond) failures++
  console.log(`${mark}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const SHOTS = process.env.SCREENSHOT_DIR ?? '/tmp/yaac-shots'
const PHONE = { width: 390, height: 844 }
/**
 * A token with no line-break opportunity, like a sha or base64 blob. Not a
 * path, since browsers may break after a slash.
 */
const LONG_TOKEN = `9f3c7ae${'0123456789abcdef'.repeat(6)}b21d`

/**
 * Every element in the conversation that sticks out past the pane's right
 * edge, plus the message list's horizontal scroll. Content inside its own
 * horizontal scroller (a code block, diff hunk or table) is exempt.
 */
function overflowReport() {
  return () => {
    // The pane's input is the only textarea with a placeholder (terminals
    // have hidden ones); the pane is the column holding it.
    const box = document.querySelector('textarea[placeholder]')
    const pane = box?.closest('.flex-col')
    if (!pane) return { error: 'no chat pane' }
    const list = pane.firstElementChild
    const right = pane.getBoundingClientRect().right
    const clipped = (el) => {
      for (let p = el.parentElement; p && p !== list; p = p.parentElement) {
        if (getComputedStyle(p).overflowX !== 'visible') return true
      }
      return false
    }
    const wide = []
    for (const el of list.querySelectorAll('*')) {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.right > right + 1 && !clipped(el)) {
        wide.push({
          tag: el.tagName.toLowerCase(),
          cls: el.className?.toString().slice(0, 60) ?? '',
          overhang: Math.round(r.right - right),
          text: (el.textContent ?? '').slice(0, 30).replace(/\s+/g, ' ').trim(),
        })
      }
    }
    return {
      paneWidth: Math.round(pane.getBoundingClientRect().width),
      scrollOverflow: list.scrollWidth - list.clientWidth,
      inputFontPx: parseFloat(getComputedStyle(box).fontSize),
      wide: wide.slice(0, 8),
      wideCount: wide.length,
    }
  }
}

/** Whether the document itself can scroll (it must not). */
function pageScrollReport() {
  return () => {
    const el = document.scrollingElement ?? document.documentElement
    return {
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      scrollY: window.scrollY,
      scrollX: window.scrollX,
      rootHeight: Math.round(document.getElementById('root').getBoundingClientRect().height),
    }
  }
}

fs.mkdirSync(SHOTS, { recursive: true })
const { chromium } = requirePlaywright()
const lock = readServerLock()
const APP_URL = process.env.APP_URL ?? `http://127.0.0.1:${lock.port}`
const browser = await chromium.launch()
try {
  const ctx = await browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true })
  const page = await ctx.newPage()
  page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))

  await page.goto(`${APP_URL}/`)
  await page.waitForTimeout(4000)

  // Project, then workspace, then pane. The mobile screens are stacked
  // layers, so each query is scoped to its layer.
  const shell = page.locator('#root > div > div > div')
  const projectsLayer = shell.locator('> div').nth(0)
  const projectRows = projectsLayer.locator('button:has(> span.truncate)')
  await projectRows.first().waitFor({ state: 'visible', timeout: 20_000 })
  await projectRows.first().tap()
  await page.waitForTimeout(1500)

  const workspacesLayer = shell.locator('> div').nth(1)
  const row = workspacesLayer
    .locator('.group.relative.mx-2:has([aria-label="Stop workspace"]) > button')
    .first()
  await row.waitFor({ state: 'visible', timeout: 30_000 })
  await row.tap()
  await page.waitForTimeout(4000)

  const box = page.getByRole('textbox').last()
  await box.waitFor({ state: 'visible', timeout: 30_000 })
  check('the workspace opens on its ACP chat pane',
    await page.getByPlaceholder('Message the agent…').count() === 1)

  // ---- 1. a long unbroken token must not widen the pane ----
  await box.tap()
  await box.fill(`look at ${LONG_TOKEN} and tell me nothing`)
  await page.getByRole('button', { name: 'Send' }).tap()
  // The bubble appears once the server echoes the message back.
  await until(page, (t) => {
    const pane = document.querySelector('textarea[placeholder]')?.closest('.flex-col')
    return pane?.firstElementChild.textContent.includes(t) ?? false
  }, LONG_TOKEN)
  await page.waitForTimeout(1000)
  await page.screenshot({ path: path.join(SHOTS, 'acp-mobile-1-long-token.png') })

  const overflow = await page.evaluate(overflowReport())
  console.log('  overflow:', JSON.stringify(overflow, null, 2))
  check('nothing in the conversation sticks out past the pane',
    overflow.wideCount === 0,
    overflow.wide.map((w) => `${w.tag}.${w.cls.split(' ')[0]}+${w.overhang}px`).join(' '))
  check('the message list has no horizontal scroll',
    overflow.scrollOverflow === 0, `overflow=${overflow.scrollOverflow}px`)

  // ---- 2. the input is big enough that iOS won't zoom the page ----
  check('the input is at least 16px at phone width, so a focus cannot zoom the page',
    overflow.inputFontPx >= 16, `${overflow.inputFontPx}px`)

  // ---- 3. the page itself never scrolls ----
  const scroll = await page.evaluate(pageScrollReport())
  console.log('  page scroll:', JSON.stringify(scroll))
  check('the document is no taller than the viewport',
    scroll.scrollHeight <= scroll.clientHeight,
    `${scroll.scrollHeight} vs ${scroll.clientHeight}`)
  check('the document is no wider than the viewport',
    scroll.scrollWidth <= scroll.clientWidth,
    `${scroll.scrollWidth} vs ${scroll.clientWidth}`)
  // Nothing may scroll the document, with the caret in the box or not.
  await box.tap()
  const afterPush = await page.evaluate(() => {
    window.scrollBy(0, 400)
    return { y: window.scrollY, x: window.scrollX }
  })
  check('the document does not scroll when pushed',
    afterPush.y === 0 && afterPush.x === 0, `y=${afterPush.y} x=${afterPush.x}`)

  // ---- 4. the input box grows with the message ----
  const heightOf = async () => (await box.boundingBox()).height
  await box.fill('')
  const oneLine = await heightOf()
  await box.fill('one\ntwo\nthree')
  await page.waitForTimeout(300)
  const threeLines = await heightOf()
  await box.fill(Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n'))
  await page.waitForTimeout(300)
  const thirtyLines = await heightOf()
  await page.screenshot({ path: path.join(SHOTS, 'acp-mobile-2-tall-input.png') })
  console.log(`  input heights: 1=${oneLine} 3=${threeLines} 30=${thirtyLines}`)
  check('the input box grows to show a multi-line message',
    threeLines > oneLine + 20, `1 line=${oneLine}px, 3 lines=${threeLines}px`)
  check('the grown box still shows all three lines',
    threeLines >= oneLine + 2 * 16, `${threeLines}px`)
  check('growth stops at the max height (the box scrolls past that)',
    thirtyLines <= 200, `30 lines=${thirtyLines}px`)
  const listHeight = await page.evaluate(() => {
    const pane = document.querySelector('textarea[placeholder]')?.closest('.flex-col')
    return Math.round(pane.firstElementChild.getBoundingClientRect().height)
  })
  check('a grown input never squeezes the conversation out', listHeight > 100, `${listHeight}px`)
  await box.fill('')

  console.log(`\nscreenshots: ${SHOTS}`)
  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
} finally {
  await browser.close()
}
process.exit(failures === 0 ? 0 : 1)
