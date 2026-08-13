/*
 * Verifies the full-screen overlays (Skills, Stopped worktrees) on a phone.
 *
 * All of them are desktop master/detail: a 20rem list beside a detail pane.
 * At 390px that leaves the detail a few dozen pixels, so below the breakpoint
 * MasterDetail turns the two panes into one screen deep — the list owns the
 * width until a row is tapped, then the detail takes over with a back chevron.
 * Only real layout can prove that; jsdom has none.
 *
 * Structural checks against the real rendered DOM at 390x844 (iPhone-ish):
 *  1. The sidebar's "Stopped worktrees" entry is a finger-sized row, about as
 *     tall as a worktree row above it (it is the same kind of list item on
 *     touch, not the thin desktop group header).
 *  2. In each overlay: the list is full-bleed and the detail pane is hidden
 *     until a row is tapped; then they swap, and the back chevron swaps them
 *     back. Both panes stay mounted throughout, and the list comes back at the
 *     scroll offset it was left at — that offset surviving `display: none` is
 *     an engine behavior, and it is the point of keeping them mounted.
 *  3. Nothing in an overlay overflows the viewport horizontally, and every
 *     header control (Close, agent picker, branch picker) is a >=32px target.
 *  4. Settings — the other full-screen dialog reachable from a phone — keeps
 *     its add-git-credential row (two inputs + a button) inside the viewport.
 *
 * Stopped worktrees are stubbed over the network (`/worktree/list-stopped`):
 * this is a layout check, and standing up a real worktree just to delete it
 * costs an image build and a k8s Job. Skills come from the real project.
 *
 * Drives the Vite dev server (`pnpm frontend:dev`, port 1420), which serves
 * live source and proxies /auth,/project,/events,... to the running yaac
 * server, so no rebuild is needed between edits. A one-time token is minted
 * over the server's API using the lock secret and exchanged for the cookie.
 *
 * Run: node test-playwright-scripts/mobile-overlay-panes-test.js
 * (set SCREENSHOT_DIR to capture each overlay; defaults to /tmp/yaac-shots).
 * Needs a running server (`yaac server start`) with at least one project, and
 * the dev server on :1420. (playwright is resolved from the global npm root;
 * browsers live under /opt/playwright-browsers)
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
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const APP_URL = process.env.APP_URL ?? 'http://localhost:1420'
const SHOTS = process.env.SCREENSHOT_DIR ?? '/tmp/yaac-shots'
const PHONE = { width: 390, height: 844 }

const STOPPED = [
  {
    worktreeId: 'stub-1',
    projectSlug: 'yaac',
    tool: 'claude',
    title: 'Rework the mobile overlays so both panes fit',
    prompt: 'Make the stopped worktrees and skills panes readable on a phone.',
    createdAt: '2026-08-10 09:00:00',
    lastActiveAt: '2026-08-10 11:00:00',
    stoppedAt: '2026-08-10 12:00:00',
    deathReason: 'oom',
    deathDetail: 'exit code 137',
    seen: false,
    agentSessions: [],
  },
  {
    worktreeId: 'stub-2',
    projectSlug: 'yaac',
    tool: 'codex',
    title: 'Add a changes pane filter',
    createdAt: '2026-08-09 09:00:00',
    stoppedAt: '2026-08-09 18:00:00',
    seen: true,
    agentSessions: [],
  },
  // Filler: the list has to overflow for the scroll-survival check below to
  // mean anything.
  ...Array.from({ length: 24 }, (_, i) => ({
    worktreeId: `stub-fill-${i}`,
    projectSlug: 'yaac',
    tool: 'claude',
    title: `Older worktree ${i + 1}`,
    createdAt: '2026-08-01 09:00:00',
    stoppedAt: '2026-08-01 18:00:00',
    seen: true,
    agentSessions: [],
  })),
]

async function mintToken(lock) {
  const res = await fetch(`http://127.0.0.1:${lock.port}/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${lock.secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'one-time' }),
  })
  if (res.status !== 201) throw new Error(`mint failed: HTTP ${res.status}`)
  return (await res.json()).token
}

/** The two MasterDetail panes of the open dialog: which is displayed, and how
 *  wide. Exactly one may be displayed on a phone, and it must be full-bleed. */
function panesReport() {
  return () => {
    const popup = document.querySelector('[role="dialog"]')
    if (!popup) return { error: 'no dialog' }
    // The master/detail body is the flex row holding the two panes.
    const body = Array.from(popup.querySelectorAll('div')).find(
      (el) => el.children.length === 2
        && getComputedStyle(el).display === 'flex'
        && el.className.includes('min-h-0') && el.className.includes('flex-1'),
    )
    if (!body) return { error: 'no master/detail body' }
    const panes = Array.from(body.children).map((el) => {
      const r = el.getBoundingClientRect()
      return {
        display: getComputedStyle(el).display,
        w: Math.round(r.width),
        h: Math.round(r.height),
        text: (el.textContent ?? '').slice(0, 30).replace(/\s+/g, ' ').trim(),
      }
    })
    const pr = popup.getBoundingClientRect()
    return { panes, popupWidth: Math.round(pr.width), scrollWidth: popup.scrollWidth }
  }
}

/** Every interactive control in the open dialog that is smaller than 32px in
 *  either axis — the touch-target floor for a header affordance. */
function smallTargets() {
  return () => {
    const popup = document.querySelector('[role="dialog"]')
    if (!popup) return ['no dialog']
    return Array.from(popup.querySelectorAll('button'))
      .filter((el) => getComputedStyle(el).display !== 'none' && el.offsetParent !== null)
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && (r.width < 32 || r.height < 32))
      .map(({ el, r }) =>
        `${el.getAttribute('aria-label') ?? (el.textContent ?? '').trim().slice(0, 20)}` +
        ` ${Math.round(r.width)}x${Math.round(r.height)}`)
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

  // Stub the deleted-worktree list so the entry point and its overlay have
  // rows to lay out in an environment with no worktrees.
  await page.route('**/worktree/list-stopped*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(STOPPED) }))
  await page.route('**/worktree/*/death-seen*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))

  const token = await mintToken(lock)
  await page.goto(`${APP_URL}/?token=${token}`)
  await page.waitForFunction(() => !window.location.search.includes('token='))
  await page.evaluate(() => localStorage.removeItem('yaac.mobilescreen.v1'))
  await page.goto(`${APP_URL}/`)
  await page.waitForTimeout(4000)

  const shell = page.locator('#root > div > div > div')
  const projectsLayer = shell.locator('> div').nth(0)
  const worktreesLayer = shell.locator('> div').nth(1)
  await projectsLayer.getByText('Add project', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
  await projectsLayer.locator('button:has(> span.truncate)').first().tap()
  await page.waitForTimeout(1500)

  // ---- 1. the stopped-worktrees entry is a list row, not a header ----
  const entry = worktreesLayer.locator('button', { hasText: 'Stopped worktrees' }).first()
  await entry.waitFor({ state: 'visible', timeout: 15_000 })
  const entryBox = await entry.boundingBox()
  check('the stopped-worktrees entry is finger-sized', entryBox && entryBox.height >= 44,
    entryBox ? `${Math.round(entryBox.width)}x${Math.round(entryBox.height)}` : 'no box')
  const rowBox = await worktreesLayer
    .locator('.group.relative.mx-2 > button').first().boundingBox()
    .catch(() => null)
  if (rowBox) {
    check('it is about as tall as a worktree row',
      Math.abs(entryBox.height - rowBox.height) <= 16,
      `entry=${Math.round(entryBox.height)} row=${Math.round(rowBox.height)}`)
  } else {
    console.log('  (no worktree rows in this env — skipping the height comparison)')
  }
  await page.screenshot({ path: path.join(SHOTS, 'mobile-overlay-0-entry.png') })

  // ---- 2. the stopped-worktrees overlay: list -> detail -> back ----
  await entry.tap()
  await page.waitForTimeout(800)
  let report = await page.evaluate(panesReport())
  console.log('  stopped panes (list):', JSON.stringify(report))
  check('the stopped list gets the full width',
    report.panes?.filter((p) => p.display !== 'none').length === 1
      && report.panes.find((p) => p.display !== 'none').w >= PHONE.width - 40,
    JSON.stringify(report.panes?.map((p) => `${p.display} ${p.w}`)))
  check('the overlay does not scroll sideways', report.scrollWidth <= PHONE.width,
    `scrollWidth=${report.scrollWidth}`)
  let small = await page.evaluate(smallTargets())
  check('every stopped-overlay control is a >=32px target', small.length === 0, small.join(', '))
  await page.screenshot({ path: path.join(SHOTS, 'mobile-overlay-1-stopped-list.png') })

  await page.getByText('Rework the mobile overlays so both panes fit').first().tap()
  await page.waitForTimeout(600)
  report = await page.evaluate(panesReport())
  console.log('  stopped panes (detail):', JSON.stringify(report))
  check('tapping a row swaps in the detail, full width',
    report.panes?.filter((p) => p.display !== 'none').length === 1
      && report.panes.find((p) => p.display !== 'none').text.includes('Rework'),
    JSON.stringify(report.panes?.map((p) => `${p.display} ${p.w}`)))
  check('the detail keeps the list mounted behind it', report.panes?.length === 2)
  await page.screenshot({ path: path.join(SHOTS, 'mobile-overlay-2-stopped-detail.png') })

  await page.getByLabel('Back to stopped worktrees').tap()
  await page.waitForTimeout(500)
  report = await page.evaluate(panesReport())
  check('back returns to the list',
    report.panes?.filter((p) => p.display !== 'none').length === 1
      && report.panes[0].display !== 'none',
    JSON.stringify(report.panes?.map((p) => `${p.display} ${p.w}`)))

  // Keeping both panes mounted is only worth anything if the browser really
  // restores the list's scroll offset across a display:none round trip — an
  // engine behavior, so assert it rather than assume it. The row is clicked in
  // page context on purpose: Playwright's tap would scroll it into view first
  // and move the very offset under test.
  const scroll = await page.evaluate(() => {
    const list = document.querySelector('[role="dialog"] ul')
    list.scrollTop = 220
    const before = list.scrollTop
    const rows = Array.from(list.querySelectorAll('button'))
    const inView = rows.find((b) => b.offsetTop >= list.scrollTop)
    const label = (inView?.textContent ?? '').slice(0, 24)
    inView?.click()
    return { before, label, overflowed: list.scrollHeight > list.clientHeight }
  })
  check('the stopped list is long enough to scroll', scroll.overflowed && scroll.before > 0,
    `scrollTop=${scroll.before}`)
  await page.waitForTimeout(500)
  await page.getByLabel('Back to stopped worktrees').tap()
  await page.waitForTimeout(500)
  const after = await page.evaluate(() => document.querySelector('[role="dialog"] ul').scrollTop)
  check('the list keeps its scroll position across a drill-down and back',
    after === scroll.before, `before=${scroll.before} after=${after} (row "${scroll.label}")`)

  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)

  // ---- 3. the skills overlay: same drill-down, wrapped header ----
  await worktreesLayer.getByLabel('Skills').tap()
  await page.waitForTimeout(2500)
  report = await page.evaluate(panesReport())
  console.log('  skills panes (list):', JSON.stringify(report))
  check('the skills list gets the full width',
    report.panes?.filter((p) => p.display !== 'none').length === 1
      && report.panes.find((p) => p.display !== 'none').w >= PHONE.width - 40,
    JSON.stringify(report.panes?.map((p) => `${p.display} ${p.w}`)))
  check('the skills overlay does not scroll sideways', report.scrollWidth <= PHONE.width,
    `scrollWidth=${report.scrollWidth}`)
  small = await page.evaluate(smallTargets())
  check('every skills-overlay control is a >=32px target', small.length === 0, small.join(', '))
  await page.screenshot({ path: path.join(SHOTS, 'mobile-overlay-3-skills-list.png') })

  const firstSkill = page.locator('[role="dialog"] li button').first()
  if (await firstSkill.count() > 0) {
    const skillName = (await firstSkill.textContent()).trim().split('\n')[0]
    await firstSkill.tap()
    await page.waitForTimeout(1500)
    report = await page.evaluate(panesReport())
    console.log('  skills panes (detail):', JSON.stringify(report))
    check('tapping a skill swaps in its SKILL.md, full width',
      report.panes?.filter((p) => p.display !== 'none').length === 1
        && report.panes.find((p) => p.display !== 'none').w >= PHONE.width - 40,
      `${skillName} ${JSON.stringify(report.panes?.map((p) => `${p.display} ${p.w}`))}`)
    check('the skill body does not scroll the overlay sideways',
      report.scrollWidth <= PHONE.width, `scrollWidth=${report.scrollWidth}`)
    await page.screenshot({ path: path.join(SHOTS, 'mobile-overlay-4-skills-detail.png') })

    await page.getByLabel('Back to skills').tap()
    await page.waitForTimeout(500)
    report = await page.evaluate(panesReport())
    check('back returns to the skills list',
      report.panes?.filter((p) => p.display !== 'none').length === 1)
  } else {
    console.log('  (no skills in this project — skipping the drill-down)')
  }

  // ---- 4. settings: the add-credential row fits the width ----
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  // Settings lives on the projects screen; the worktrees screen we are on is a
  // separate (inert) layer, so walk back before reaching for it.
  await worktreesLayer.getByLabel('Back to projects').tap()
  await page.waitForTimeout(1000)
  await projectsLayer.getByText('Settings', { exact: true }).tap()
  await page.waitForTimeout(1200)
  await page.locator('[role="dialog"] button', { hasText: 'Credentials' }).first().tap()
  await page.waitForTimeout(1000)
  const addBtn = page.locator('[role="dialog"] form button[type="submit"]').first()
  const addBox = await addBtn.boundingBox()
  check('the add-credential button is fully on screen',
    addBox && addBox.x + addBox.width <= PHONE.width,
    addBox ? `right=${Math.round(addBox.x + addBox.width)}` : 'no box')
  check('the add-credential row is a >=32px target', addBox && addBox.height >= 32,
    addBox ? `${Math.round(addBox.height)}px` : 'no box')
  await page.screenshot({ path: path.join(SHOTS, 'mobile-overlay-5-settings-credentials.png') })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)

  // ---- 5. the same overlays still show both panes on a desktop width ----
  await projectsLayer.locator('button:has(> span.truncate)').first().tap()
  await page.waitForTimeout(1200)
  await worktreesLayer.getByLabel('Skills').tap()
  await page.waitForTimeout(2500)
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.waitForTimeout(800)
  report = await page.evaluate(panesReport())
  console.log('  skills panes (desktop):', JSON.stringify(report))
  check('widening restores the side-by-side master/detail',
    report.panes?.filter((p) => p.display !== 'none').length === 2,
    JSON.stringify(report.panes?.map((p) => `${p.display} ${p.w}`)))

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
  process.exitCode = failures === 0 ? 0 : 1
} finally {
  await browser.close()
}
