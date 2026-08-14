// Verifies that a portaled popup wins the sidebar's gutter with a real mouse:
// the new-worktree popover, anchored under the "+" in the sidebar header, is
// wide enough to spill over the resize strip that lives in the gutter, and the
// strip (absolutely positioned at z-10) used to paint and hit-test above it —
// hovering the popup raised the resize hairline and the press never reached the
// form. The `isolate` on the sidebar's wrapper is what confines that z-10, so
// Base UI's portaled layers (which carry no z-index of their own) clear it.
// Checks the overlap is real, that the point hit-tests to the popup, that a
// press there neither resizes nor closes it, that dropping the `isolate` brings
// the bug back, and that the strip still drags once the popup is closed.
//
// Run: node test-playwright-scripts/sidebar-popup-over-resize-handle.js
// Needs: a running yaac server serving a current build (pnpm build +
// yaac server restart, or the pnpm watch loop), with at least one project.
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

  const token = await mintToken(lock)
  await page.goto(`http://127.0.0.1:${lock.port}/?token=${token}`)
  await page.waitForFunction(() => !window.location.search.includes('token='), { timeout: 15_000 })
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 15_000 })
  await page.waitForTimeout(3000) // let the pushed /events snapshot land

  const handle = page.locator('[aria-label="Resize sidebar"]')
  await handle.waitFor({ state: 'visible', timeout: 15_000 })

  // Open the new-worktree popover from the sidebar header.
  await page.locator('aside [title="New worktree"]').first().click()
  const popup = page.locator('[role="dialog"]').filter({ hasText: 'New worktree' }).first()
  await popup.waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(250) // opening transition

  // The whole premise: the popup's left column really does cover the strip.
  const geom = await page.evaluate(() => {
    const strip = document.querySelector('[aria-label="Resize sidebar"]').getBoundingClientRect()
    const pop = document.querySelector('[role="dialog"]').getBoundingClientRect()
    return {
      strip: { x: strip.x, right: strip.right, top: strip.top, bottom: strip.bottom },
      pop: { x: pop.x, right: pop.right, top: pop.top, bottom: pop.bottom },
    }
  })
  const overlapX = Math.min(geom.strip.right, geom.pop.right) - Math.max(geom.strip.x, geom.pop.x)
  const overlapY = Math.min(geom.strip.bottom, geom.pop.bottom) - Math.max(geom.strip.top, geom.pop.top)
  check('the popup overlaps the resize strip', overlapX > 0 && overlapY > 0,
    `${overlapX.toFixed(1)}×${overlapY.toFixed(1)}px`)

  // A point inside that overlap: mid-strip, a little below the popup's top.
  const px = Math.max(geom.strip.x, geom.pop.x) + Math.min(overlapX, 8) / 2
  const py = geom.pop.top + 20

  const topmost = await page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y)
    return {
      inPopup: !!el?.closest('[role="dialog"]'),
      inStrip: !!el?.closest('[aria-label="Resize sidebar"]'),
      isolation: getComputedStyle(document.querySelector('aside')).isolation,
    }
  }, [px, py])
  check('the popup hit-tests above the strip', topmost.inPopup && !topmost.inStrip, JSON.stringify(topmost))
  check('the sidebar wrapper is a stacking context', topmost.isolation === 'isolate')

  // Hovering the overlap must not light the strip's hairline (its only visible
  // state is group-hover / focus-visible on the inner rule).
  await page.mouse.move(px, py)
  await page.waitForTimeout(150)
  const hairlineLit = await handle.evaluate((el) => {
    const bg = getComputedStyle(el.firstElementChild).backgroundColor
    return bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent'
  })
  check('hovering the popup leaves the resize hairline dark', !hairlineLit)
  await page.screenshot({ path: path.join(SHOT_DIR, 'popup-over-handle-1-hover.png') })

  // A press at that point belongs to the popup, so it must not start a drag
  // (which would leave the resizing class on <body>) and must not close it.
  const widthBefore = await page.locator('aside').first().evaluate((el) => el.getBoundingClientRect().width)
  await page.mouse.down()
  await page.mouse.move(px + 60, py, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(200)
  check('a press over the popup does not resize the sidebar',
    await page.locator('aside').first().evaluate((el) => el.getBoundingClientRect().width) === widthBefore)
  check('no resize class left on <body>',
    !(await page.evaluate(() => document.body.classList.contains('col-resizing'))))
  check('the popup is still open', await popup.isVisible())

  // Drop the isolation and the old bug is back — proof this is what fixes it.
  await page.addStyleTag({ content: 'aside { isolation: auto !important }' })
  await page.waitForTimeout(100)
  const withoutIsolation = await page.evaluate(([x, y]) => (
    !!document.elementFromPoint(x, y)?.closest('[aria-label="Resize sidebar"]')
  ), [px, py])
  check('without the isolation the strip takes the point back', withoutIsolation)

  await page.reload()
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 15_000 })
  await page.waitForTimeout(2000)

  // The strip itself still drags with no popup open.
  const box = await handle.boundingBox()
  const before = await page.locator('aside').first().evaluate((el) => el.getBoundingClientRect().width)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(150)
  const after = await page.locator('aside').first().evaluate((el) => el.getBoundingClientRect().width)
  check('the strip still resizes with no popup open', Math.abs(after - (before + 80)) <= 2, `${before} -> ${after}`)
  await page.screenshot({ path: path.join(SHOT_DIR, 'popup-over-handle-2-drag.png') })

  await browser.close()
  console.log(`\nscreenshots -> ${SHOT_DIR}/popup-over-handle-*.png`)
  const failed = results.filter(([, ok]) => !ok)
  if (failed.length) {
    console.error(`\n${failed.length} check(s) failed`)
    process.exit(1)
  }
  console.log(`\nall ${results.length} checks passed`)
}

await main()
