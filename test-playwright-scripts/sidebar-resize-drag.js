// Verifies the desktop worktree sidebar's resize handle with a real mouse:
// the handle sits in the gutter on the sidebar's right edge, a press-move-
// release drag widens/narrows the card live, the width clamps at both bounds,
// a double-click restores the default, and the width survives a reload
// (localStorage 'yaac.sidebarwidth.v1'). Also checks the pane keeps the space
// the sidebar gives up, since the pane is what the sidebar resizes against.
//
// Run: node test-playwright-scripts/sidebar-resize-drag.js
// Needs: a running yaac server serving a current build (pnpm build +
// yaac server restart, or the pnpm watch loop).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync('/opt/playwright-browsers')) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/playwright-browsers'
}

function requirePlaywright() {
  try {
    return require('playwright')
  } catch {
    return require(path.join(execSync('npm root -g').toString().trim(), 'playwright'))
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

const SHOT_DIR = '/tmp/yaac-shots'
const DEFAULT_WIDTH = 256
const MIN_WIDTH = 180
const MAX_WIDTH = 640

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const lock = readServerLock()
  const { chromium } = requirePlaywright()
  const browser = await chromium.launch()
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))

  const results = []
  const check = (name, ok, detail) => {
    results.push([name, ok])
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  }
  const shot = async (name) => {
    await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) })
  }

  const handle = page.locator('[aria-label="Resize sidebar"]')
  const sidebarWidth = () => page.locator('aside').first().evaluate((el) => el.getBoundingClientRect().width)
  const paneLeft = () => page.locator('aside').first().evaluate(
    (el) => el.nextElementSibling.getBoundingClientRect().left,
  )

  // A real press-move-release across the handle. Moves in steps so the
  // pointermove stream looks like a hand-drag, not a teleport.
  const dragBy = async (dx) => {
    const box = await handle.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2, { steps: 12 })
    await page.mouse.up()
    await page.waitForTimeout(120)
  }

  const token = await mintToken(lock)
  await page.goto(`http://127.0.0.1:${lock.port}/?token=${token}`)
  await page.waitForFunction(() => !window.location.search.includes('token='), { timeout: 15_000 })
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 15_000 })
  await page.waitForTimeout(3000) // let the pushed /events snapshot land

  check('starts at the default width', await sidebarWidth() === DEFAULT_WIDTH, `${await sidebarWidth()}px`)
  await shot('sidebar-resize-1-default')

  // The handle is a full-height strip in the gutter, past the card's edge.
  const geom = await handle.evaluate((el) => {
    const h = el.getBoundingClientRect(), a = el.closest('aside').getBoundingClientRect()
    return { hx: h.x, hw: h.width, hh: h.height, aRight: a.right, aHeight: a.height }
  })
  check(
    'handle sits in the gutter, full height',
    geom.hx >= geom.aRight - 1 && geom.hw >= 6 && Math.abs(geom.hh - geom.aHeight) < 2,
    JSON.stringify(geom),
  )

  const paneBefore = await paneLeft()
  await dragBy(120)
  const wide = await sidebarWidth()
  check('drag right widens the sidebar', Math.abs(wide - (DEFAULT_WIDTH + 120)) <= 2, `${wide}px`)
  check('the pane gives up the same space', (await paneLeft()) - paneBefore >= 118)
  await shot('sidebar-resize-2-wide')

  // Stays clear of the floor — the clamp gets its own check below.
  await dragBy(-100)
  const narrow = await sidebarWidth()
  check('drag left narrows it', Math.abs(narrow - (wide - 100)) <= 2, `${narrow}px`)
  await shot('sidebar-resize-3-narrow')

  await dragBy(-900)
  check('clamps at the floor', await sidebarWidth() === MIN_WIDTH, `${await sidebarWidth()}px`)
  await shot('sidebar-resize-4-min')

  await dragBy(2000)
  check('clamps at the ceiling', await sidebarWidth() === MAX_WIDTH, `${await sidebarWidth()}px`)
  await shot('sidebar-resize-5-max')

  // Persisted: the reloaded app comes back at the dragged width.
  await dragBy(-260)
  const dragged = await sidebarWidth()
  await page.reload()
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 15_000 })
  await page.waitForTimeout(2000)
  check('the width survives a reload', await sidebarWidth() === dragged, `${dragged}px`)

  await handle.dblclick()
  await page.waitForTimeout(120)
  check('double-click restores the default', await sidebarWidth() === DEFAULT_WIDTH, `${await sidebarWidth()}px`)

  // A drag must not leave the document stuck in the resizing state.
  check('no resize class left on <body>', !(await page.evaluate(
    () => document.body.classList.contains('col-resizing'),
  )))

  await browser.close()
  console.log(`\nscreenshots -> ${SHOT_DIR}/sidebar-resize-*.png`)
  const failed = results.filter(([, ok]) => !ok)
  if (failed.length) {
    console.error(`\n${failed.length} check(s) failed`)
    process.exit(1)
  }
  console.log(`\nall ${results.length} checks passed`)
}

await main()
