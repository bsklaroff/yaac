/*
 * Verifies the ACP chat pane at phone width, in real Chromium (390x844,
 * touch): the things jsdom cannot answer because it has no layout.
 *
 *  1. Nothing in the conversation is wider than the pane. A long unbroken
 *     token — a sha, a URL, a base64 blob — is exactly what an agent emits,
 *     and with nothing to break it the message list becomes a horizontal
 *     scroller and the pane's content runs off the right of the screen.
 *  2. The input is at least 16px. Mobile Safari zooms the page when a smaller
 *     control takes focus and never zooms back out, which presents as (1) and
 *     (3) at once even when the layout is perfect.
 *  3. The page itself never scrolls. Every scroll in the app belongs to a pane
 *     inside it; if the chat pane can push the document past the viewport, the
 *     whole shell drags around under a swipe.
 *  4. The input box grows with the message. Typing several lines must show all
 *     of them (up to the max-height, after which the box scrolls internally),
 *     rather than leaving the writer looking at one line of five.
 *
 * Drives the app the server itself serves (`dist/`), reading the port + lock
 * secret from $YAAC_DATA_DIR/.server.lock — so run `pnpm build` +
 * `yaac server restart` first, or you are looking at the frontend as it was.
 * Deliberately NOT the Vite dev server: React.StrictMode double-mounts every
 * effect in development, so the chat pane opens two ACP sockets, the second
 * displaces the first, and a prompt sent from the box is never delivered.
 * The geometry is identical either way, but this script sends a message.
 *
 * Needs a running `yaac server` with a live ACP-mode worktree of the selected
 * project — `yaac worktree create <project> --tool claude --mode acp` — and
 * spends one small prompt turn on the agent (the message carries the
 * unbreakable token, which is the point).
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
 * Poll an in-page predicate until it holds. Not `page.waitForFunction`: the
 * served app sends a script-src CSP with no `unsafe-eval`, and that API
 * compiles its predicate with `new Function` inside the page. `page.evaluate`
 * goes through the debugger instead, which the CSP does not govern.
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
 * A token with no break opportunity in it at all — the shape of a commit sha,
 * a base64 blob or a k8s object name. Deliberately not a long *path*: line
 * breaking allows a break after a solidus, so a path wraps on its own and
 * proves nothing about the wrapping rule.
 */
const LONG_TOKEN = `9f3c7ae${'0123456789abcdef'.repeat(6)}b21d`

async function mintToken(lock) {
  const res = await fetch(`http://127.0.0.1:${lock.port}/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${lock.secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'one-time' }),
  })
  if (res.status !== 201) throw new Error(`mint failed: HTTP ${res.status}`)
  return (await res.json()).token
}

/** Every element in the conversation that sticks out past the pane's right
 *  edge, plus the message list's own horizontal scroll. Reported as the
 *  offending elements rather than a bare boolean — which node overflows is the
 *  whole diagnosis.
 *
 *  Content inside a nested horizontal scroller (a fenced code block, a diff
 *  hunk, a wide table) is exempt: it is clipped by that scroller and scrolls
 *  within it, which is the design. Only what the *message list* has to carry
 *  can widen the pane. */
function overflowReport() {
  return () => {
    // The pane from the inside out: its input box is the one textarea with a
    // placeholder (every attached terminal has a hidden one of its own), and
    // the pane is the column that holds it.
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

/** Whether the document itself can scroll — it must not; every scroll in the
 *  app belongs to a pane. */
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

  const token = await mintToken(lock)
  await page.goto(`${APP_URL}/?token=${token}`)
  await until(page, () => !window.location.search.includes('token='))
  await page.waitForTimeout(4000)

  // Walk in: project -> worktree -> pane. The mobile shell's screens are
  // stacked layers, so each query is scoped to the layer that owns it.
  const shell = page.locator('#root > div > div > div')
  const projectsLayer = shell.locator('> div').nth(0)
  const projectRows = projectsLayer.locator('button:has(> span.truncate)')
  await projectRows.first().waitFor({ state: 'visible', timeout: 20_000 })
  await projectRows.first().tap()
  await page.waitForTimeout(1500)

  const worktreesLayer = shell.locator('> div').nth(1)
  const row = worktreesLayer
    .locator('.group.relative.mx-2:has([aria-label="Delete worktree"]) > button')
    .first()
  await row.waitFor({ state: 'visible', timeout: 30_000 })
  await row.tap()
  await page.waitForTimeout(4000)

  const box = page.getByRole('textbox').last()
  await box.waitFor({ state: 'visible', timeout: 30_000 })
  check('the worktree opens on its ACP chat pane',
    await page.getByPlaceholder('Message the agent…').count() === 1)

  // ---- 1. a long unbroken token must not widen the pane ----
  await box.tap()
  await box.fill(`look at ${LONG_TOKEN} and tell me nothing`)
  await page.getByRole('button', { name: 'Send' }).tap()
  // The bubble appears when the server echoes the message back, which is the
  // only evidence the agent has it — the box holds the text until then.
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
  // A control under 16px makes mobile Safari scale the whole page on focus and
  // never scale it back: the pane runs off to the right and the shell pans
  // under a finger. It reads as a layout bug; it is a font size.
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
  // Nothing may move the document, with the caret in the box or otherwise —
  // every scroll in the app belongs to a pane inside it.
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
