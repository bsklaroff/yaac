/*
 * Verifies the mobile shell: below the 767px breakpoint the desktop's
 * rail / sidebar / pane columns become three full-screen views the user walks
 * through, and back walks out again.
 *
 * Structural checks against the real rendered DOM at 390x844 (iPhone-ish):
 *  1. The desktop rail and sidebar are gone; a projects list is the root view.
 *  2. Tapping a project shows its worktree list; tapping a worktree shows the
 *     pane. Both back chevrons (and the browser's own back button) unwind it.
 *  3. All three screens stay MOUNTED the whole time — only one is visible.
 *     This is the load-bearing one: WorktreeView positions its terminals by
 *     measured pixels, so an unmounted or display:none pane would collapse
 *     every rect to zero and cost a resize round-trip to the pod on return.
 *     Asserted by measuring the hidden pane layer's box (non-zero, full
 *     viewport) while another screen is showing.
 *  4. The pane is in tabs mode with the accessory key bar (esc/tab/^C/arrows)
 *     under it, and the worktree-row actions (pin, delete) are visible without
 *     a hover, which touch cannot produce.
 *  5. Widening back to 1400px restores the desktop three-column layout with
 *     the same pane element still mounted (a phone rotating into landscape
 *     must not tear down its terminals).
 *
 * jsdom can't answer any of this — it has no layout — so this script is the
 * only real check on the mobile shell's geometry.
 *
 * Drives the Vite dev server (`pnpm frontend:dev`, port 1420), which serves
 * live source and proxies /auth,/project,/events,... to the running yaac
 * server. A one-time token is minted over the server's API using the lock
 * secret and exchanged for the session cookie.
 *
 * Run: node test-playwright-scripts/mobile-three-screens-test.js
 * (set SCREENSHOT_DIR to capture each screen; defaults to /tmp/yaac-shots).
 * Needs a running server (`yaac server start`) with at least one project and
 * one active worktree, and the dev server on :1420. (playwright is resolved
 * from the global npm root; browsers live under /opt/playwright-browsers)
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
  throw new Error(`no .server.lock found (tried ${candidates.join(', ')}) — is the server running?`)
}

let failures = 0
function check(name, cond, detail = '') {
  const mark = cond ? 'PASS' : 'FAIL'
  if (!cond) failures++
  console.log(`${mark}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const APP_URL = process.env.APP_URL ?? 'http://localhost:1420'
const SHOTS = process.env.SCREENSHOT_DIR ?? '/tmp/yaac-shots'
const PHONE = { width: 390, height: 844 }

async function mintToken(lock) {
  const res = await fetch(`http://127.0.0.1:${lock.port}/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${lock.secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'one-time' }),
  })
  if (res.status !== 201) throw new Error(`mint failed: HTTP ${res.status}`)
  return (await res.json()).token
}

/** Measure every stacked screen layer: which is visible, and how big its box
 *  is (a hidden-but-mounted layer must still measure full-viewport). */
function layerReport() {
  return () => {
    const shell = document.querySelector('#root > div > div > div')
    if (!shell) return { error: 'no shell' }
    const layers = Array.from(shell.children).map((el) => {
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      return {
        visibility: cs.visibility,
        display: cs.display,
        inert: el.hasAttribute('inert'),
        w: Math.round(r.width),
        h: Math.round(r.height),
        text: (el.textContent ?? '').slice(0, 40).replace(/\s+/g, ' ').trim(),
      }
    })
    return { count: layers.length, layers }
  }
}

fs.mkdirSync(SHOTS, { recursive: true })
const { chromium } = requirePlaywright()
const lock = readServerLock()
const browser = await chromium.launch()
try {
  const ctx = await browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true })
  const page = await ctx.newPage()
  page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))

  const token = await mintToken(lock)
  await page.goto(`${APP_URL}/?token=${token}`)
  await page.waitForFunction(() => !window.location.search.includes('token='))
  // Model a genuine cold load: no persisted screen *and* a bare URL. Both
  // matter — persistSelection mirrors the selection into the query string on
  // every change, and with nothing persisted a `?worktree=` reads as a shared
  // link and correctly opens the pane. Reloading in place would race that
  // mirror and make the next check flap.
  await page.evaluate(() => localStorage.removeItem('yaac.mobilescreen.v1'))
  await page.goto(`${APP_URL}/`)
  await page.waitForTimeout(4000)

  // ---- 1. projects screen is the root, and the desktop chrome is gone ----
  check('no desktop sidebar at phone width', await page.locator('aside').count() === 0)
  // The projects screen is layer 0; scope every query to it so the two hidden
  // layers behind it can't answer for it.
  const shell = page.locator('#root > div > div > div')
  const projectsLayer = shell.locator('> div').nth(0)
  const addProject = projectsLayer.getByText('Add project', { exact: true })
  await addProject.waitFor({ state: 'visible', timeout: 15_000 })
  const projectRows = projectsLayer.locator('button:has(> span.truncate)')
  check('a cold load lands on the project list, not one screen in',
    await addProject.isVisible()
      && await projectsLayer.getByText('Settings', { exact: true }).isVisible())
  check('the project list has rows to tap', await projectRows.count() > 0,
    `rows=${await projectRows.count()}`)
  await page.screenshot({ path: path.join(SHOTS, 'mobile-1-projects.png') })

  let report = await page.evaluate(layerReport())
  console.log('  layers on projects:', JSON.stringify(report, null, 2))
  check('three screen layers are mounted', report.count === 3, `count=${report.count}`)
  check('exactly one layer is visible',
    report.layers.filter((l) => l.visibility === 'visible').length === 1)
  check('hidden layers use visibility, never display:none',
    report.layers.every((l) => l.display !== 'none'))
  check('the hidden pane layer still measures the full viewport',
    report.layers.every((l) => l.w === PHONE.width && l.h > 0),
    report.layers.map((l) => `${l.w}x${l.h}`).join(' '))
  check('hidden layers are inert',
    report.layers.filter((l) => l.inert).length === 2)

  // ---- 2. tap a project -> worktree list ----
  const firstProject = projectRows.first()
  const projectName = (await firstProject.textContent()).trim()
  await firstProject.tap()
  await page.waitForTimeout(1500)
  check('tapping a project shows its worktree list',
    await page.getByLabel('Back to projects').isVisible(), projectName)
  await page.screenshot({ path: path.join(SHOTS, 'mobile-2-worktrees.png') })

  // Row actions must be reachable with no hover.
  const worktreesLayer = shell.locator('> div').nth(1)
  const pin = worktreesLayer.getByLabel('Move to background').first()
  const del = worktreesLayer.getByLabel('Delete worktree').first()
  // Wait for the list to actually settle before deciding whether this env has
  // worktrees — the snapshot arrives over the events socket, and a fixed sleep
  // silently downgrades the whole pane section to "skipped" when it's slow.
  await Promise.race([
    del.waitFor({ state: 'visible', timeout: 20_000 }),
    worktreesLayer.getByText('No worktrees yet').waitFor({ state: 'visible', timeout: 20_000 }),
  ]).catch(() => { /* fall through to the count below */ })
  const hasRows = await del.count() > 0
  if (hasRows) {
    check('row pin/delete are visible without a hover',
      await pin.isVisible() && await del.isVisible())
    const box = await del.boundingBox()
    check('the delete target is finger-sized (>=24px)',
      box && box.width >= 24 && box.height >= 24,
      box ? `${Math.round(box.width)}x${Math.round(box.height)}` : 'no box')
  } else {
    console.log('  (no worktrees in this env — skipping row-action checks)')
  }

  // ---- 3. tap a worktree -> the pane ----
  if (hasRows) {
    // A *live* worktree row — the one carrying a delete action. Provisioning
    // rows render above the sections and would open the placeholder overlay
    // instead of the pane.
    await worktreesLayer
      .locator('.group.relative.mx-2:has([aria-label="Delete worktree"]) > button')
      .first().tap()
    await page.waitForTimeout(4000)
    check('tapping a worktree shows the pane',
      await page.getByLabel('Back to worktrees').isVisible())
    const paneCards = page.locator('section.absolute.inset-0')
    check('the pane is in tabs mode (one full-bleed card, no tiled columns)',
      await paneCards.count() === 1, `cards=${await paneCards.count()}`)
    check('the accessory key bar is under the terminal',
      await page.getByLabel('Escape').isVisible()
        && await page.getByLabel('Control C').isVisible()
        && await page.getByLabel('Up arrow').isVisible())

    const keyBar = await page.getByLabel('Escape').boundingBox()
    const paneCard = await paneCards.first().boundingBox()
    check('the key bar sits below the pane, not over it',
      keyBar && paneCard && keyBar.y >= paneCard.y + paneCard.height - 1,
      keyBar && paneCard ? `bar.y=${Math.round(keyBar.y)} pane.bottom=${Math.round(paneCard.y + paneCard.height)}` : '')
    await page.screenshot({ path: path.join(SHOTS, 'mobile-3-pane.png') })

    report = await page.evaluate(layerReport())
    check('all three layers are still mounted on the pane screen', report.count === 3)

    // ---- 4. back unwinds, including the browser's own back button ----
    await page.getByLabel('Back to worktrees').tap()
    await page.waitForTimeout(1000)
    check('the pane’s back chevron returns to the worktree list',
      await page.getByLabel('Back to projects').isVisible())

    await page.goForward()
    await page.waitForTimeout(1000)
    check('browser forward re-enters the pane',
      await page.getByLabel('Back to worktrees').isVisible())

    await page.goBack()
    await page.goBack()
    await page.waitForTimeout(1000)
    check('browser back walks out to the project list',
      await page.getByText('Add project', { exact: true }).isVisible())
  }

  // ---- 5. widen: the desktop layout returns, pane still mounted ----
  await page.evaluate(() => {
    const pane = document.querySelector('#root > div > div > div')?.lastElementChild
    if (pane) pane.setAttribute('data-rotation-probe', '1')
  })
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.waitForTimeout(2000)
  check('widening past the breakpoint restores the desktop sidebar',
    await page.locator('aside').count() === 1)
  check('the pane element survived the switch (a rotation must not drop terminals)',
    await page.locator('[data-rotation-probe="1"]').count() === 1)
  await page.screenshot({ path: path.join(SHOTS, 'mobile-4-widened.png') })

  console.log(`\nscreenshots: ${SHOTS}`)
  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
} finally {
  await browser.close()
}
process.exit(failures === 0 ? 0 : 1)
