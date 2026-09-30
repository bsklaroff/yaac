/*
 * Verifies that the mobile shell covers exactly the visible area when a soft
 * keyboard opens. On iOS the keyboard both shrinks and slides the visual
 * viewport (scrolling the focused composer into view), so `#root` is
 * `position: fixed` at `--app-top` with height `--app-height`, both set by
 * useVisualViewportHeight().
 *
 * Chromium has no soft keyboard, so the script installs and drives a fake
 * `window.visualViewport` before the app loads. It checks what the CSS does
 * with those values.
 *
 *  1. At rest the root covers the whole viewport.
 *  2. Keyboard up (shorter viewport, slid down): the root covers exactly the
 *     visible band — nothing of the page below it, nothing cut off above.
 *  3. After the keyboard closes, the root covers the whole viewport again.
 *  4. A pinch-zoom pan must not move the root, or a zoomed page could not be
 *     panned.
 *  5. Above the breakpoint the hook sets nothing.
 *
 * Drives the app the server itself serves (`dist/`), reading the port
 * from $YAAC_DATA_DIR/.server.lock — so run `pnpm build` +
 * `yaac server restart` first, or you are looking at the frontend as it was.
 * Needs no workspace and spends no agent turn.
 *
 * Run: node test-playwright-scripts/mobile-keyboard-slide-test.js
 * (APP_URL points it elsewhere; playwright is resolved from the global npm
 * root, browsers live under /opt/playwright-browsers)
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

const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1200, height: 844 }

/**
 * A drivable fake `window.visualViewport`, installed before app code runs:
 * height, offsetTop, scale, and resize/scroll events.
 */
function fakeVisualViewport() {
  const listeners = { resize: new Set(), scroll: new Set() }
  // Until driven, it reports the window, read lazily: at install time the
  // viewport meta is not parsed yet.
  const state = { height: null, width: null, offsetTop: 0, offsetLeft: 0, scale: 1 }
  const vv = {
    get height() { return state.height ?? window.innerHeight },
    get width() { return state.width ?? window.innerWidth },
    get offsetTop() { return state.offsetTop },
    get offsetLeft() { return state.offsetLeft },
    get pageTop() { return state.offsetTop },
    get pageLeft() { return state.offsetLeft },
    get scale() { return state.scale },
    addEventListener: (type, fn) => { listeners[type]?.add(fn) },
    removeEventListener: (type, fn) => { listeners[type]?.delete(fn) },
  }
  Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true })
  window.__vv = (next) => {
    Object.assign(state, next)
    for (const fn of listeners.resize) fn()
    for (const fn of listeners.scroll) fn()
  }
}

/** Where the shell sits, compared with the visible area. */
function rootReport() {
  return () => {
    const r = document.getElementById('root').getBoundingClientRect()
    const vv = window.visualViewport
    return {
      top: Math.round(r.top),
      height: Math.round(r.height),
      left: Math.round(r.left),
      width: Math.round(r.width),
      position: getComputedStyle(document.getElementById('root')).position,
      appTop: getComputedStyle(document.documentElement).getPropertyValue('--app-top').trim(),
      appHeight: getComputedStyle(document.documentElement).getPropertyValue('--app-height').trim(),
      // The band of the layout viewport the visual one is showing.
      visibleTop: Math.round(vv.offsetTop),
      visibleBottom: Math.round(vv.offsetTop + vv.height),
    }
  }
}

const { chromium } = requirePlaywright()
const lock = readServerLock()
const APP_URL = process.env.APP_URL ?? `http://127.0.0.1:${lock.port}`

const browser = await chromium.launch()
try {
  const ctx = await browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true })
  await ctx.addInitScript(fakeVisualViewport)
  const page = await ctx.newPage()
  page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))

  await page.goto(`${APP_URL}/`)
  await until(page, () => !!document.querySelector('#root > div'))
  await page.waitForTimeout(1000)

  // ---- 1. at rest ----
  let r = await page.evaluate(rootReport())
  console.log('  at rest:', JSON.stringify(r))
  check('the root is fixed to the viewport', r.position === 'fixed', r.position)
  check('at rest the root covers the whole viewport',
    r.top === 0 && r.height === PHONE.height, `top=${r.top} h=${r.height}`)

  // ---- 2. keyboard up: shorter, and slid down over the composer ----
  await page.evaluate(() => window.__vv({ height: 500, offsetTop: 344 }))
  await page.waitForTimeout(300)
  r = await page.evaluate(rootReport())
  console.log('  keyboard up:', JSON.stringify(r))
  check('the root is sized to the space left above the keyboard',
    r.height === 500, `h=${r.height} (${r.appHeight})`)
  check('the root sits over the visible band, not above it',
    r.top === r.visibleTop, `top=${r.top} visibleTop=${r.visibleTop} (${r.appTop})`)
  check('nothing of the page is left below the shell',
    r.top + r.height === r.visibleBottom,
    `rootBottom=${r.top + r.height} visibleBottom=${r.visibleBottom}`)
  check('the root still spans the full width',
    r.left === 0 && r.width === PHONE.width, `left=${r.left} w=${r.width}`)

  // ---- 3. keyboard down ----
  await page.evaluate(() => window.__vv({ height: 844, offsetTop: 0 }))
  await page.waitForTimeout(300)
  r = await page.evaluate(rootReport())
  check('the shell comes back down when the keyboard closes',
    r.top === 0 && r.height === PHONE.height, `top=${r.top} h=${r.height}`)

  // ---- 4. a pinch-zoom pan is the user's own; the shell must not chase it ----
  await page.evaluate(() => window.__vv({ height: 400, offsetTop: 200, scale: 2 }))
  await page.waitForTimeout(300)
  r = await page.evaluate(rootReport())
  console.log('  pinch-zoomed:', JSON.stringify(r))
  check('a zoomed pan does not drag the shell along with it',
    r.top === 0, `top=${r.top} (${r.appTop})`)
  await page.evaluate(() => window.__vv({ height: 844, offsetTop: 0, scale: 1 }))

  // ---- 5. above the breakpoint the hook publishes nothing ----
  const wide = await ctx.newPage()
  await wide.setViewportSize(DESKTOP)
  await wide.goto(`${APP_URL}/`)
  await until(wide, () => !!document.querySelector('#root > div'))
  await wide.evaluate(() => window.__vv({ height: 500, offsetTop: 344 }))
  await wide.waitForTimeout(300)
  r = await wide.evaluate(rootReport())
  console.log('  desktop:', JSON.stringify(r))
  check('the desktop keeps its own sizing, unmoved by the visual viewport',
    r.top === 0 && r.height === DESKTOP.height && r.appTop === '',
    `top=${r.top} h=${r.height} appTop="${r.appTop}"`)

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exitCode = failures === 0 ? 0 : 1
} finally {
  await browser.close()
}
