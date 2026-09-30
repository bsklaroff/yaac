/*
 * Verifies in Chromium (1400x900) that a conversation loaded in the
 * stopped-workspaces overlay stays inside the overlay.
 *
 * The detail pane is a flex item beside the fixed-width list. Transcripts
 * hold very wide unbreakable content (`white-space: pre` tool output, fenced
 * blocks, diffs), and a flex item's default minimum width is its content's.
 * Without an explicit floor, the pane grows to the widest line and pushes
 * the Restart button off the overlay.
 *
 * Checks:
 *  1. The detail pane is no wider than the overlay.
 *  2. The Restart button is inside the overlay and hit-testable at its
 *     center.
 *  3. Wide content scrolls inside its own block instead of widening the pane.
 *
 * Desktop only; mobile-overlay-panes-test.js covers the phone layout.
 *
 * The stopped listing and the transcript routes are stubbed with the ACP
 * events a claude conversation produces, so no agent turn, credentials or
 * stopped workspace is needed. Everything below the fetch is the real app.
 *
 * Drives the app the server serves from `dist/`, reading the port from
 * $YAAC_DATA_DIR/.server.lock, so run `pnpm build` + `yaac server restart`
 * first. Needs a running `yaac server` with at least one project.
 *
 * Run: node test-playwright-scripts/stopped-transcript-overflow-test.js
 * (SCREENSHOT_DIR sets the screenshot dir, default /tmp/yaac-shots; APP_URL
 * points it at another origin).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync('/opt/playwright-browsers')) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/playwright-browsers'
}
const { chromium } = (() => {
  try {
    return require('playwright')
  } catch {
    return require(path.join(execSync('npm root -g').toString().trim(), 'playwright'))
  }
})()

const SHOT_DIR = process.env.SCREENSHOT_DIR ?? '/tmp/yaac-shots'

function readServerLock() {
  const candidates = [
    process.env.YAAC_DATA_DIR && path.join(process.env.YAAC_DATA_DIR, '.server.lock'),
    path.join(os.homedir(), '.yaac', '.server.lock'),
  ].filter(Boolean)
  for (const p of candidates) if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'))
  throw new Error('no .server.lock found — is the server running? try: yaac server start')
}

/** A source line long enough that no pane is as wide as it is. */
const LONG_LINE =
  'const resolved = await coordinator.ensureImage(project, chain, { requirePrebuilt: true, registry: "localhost:5000", tag: contentHash })'
  + ' // a trailing comment of the kind an agent writes, which keeps the line going well past any width a two-pane overlay could give it'

/** ACP events as acpd records them: prose, a fenced block, a read tool call
 *  and an edit diff. Each overflows in a different way. */
const EVENTS = [
  { type: 'user', seq: 0, content: [{ type: 'text', text: 'why is the build cache missing?' }] },
  {
    type: 'agent',
    seq: 1,
    content: [{
      type: 'text',
      text: 'Reading the coordinator. The tag comes from `contentHash()`:\n\n```ts\n'
        + `${LONG_LINE}\n${LONG_LINE}\n`
        + '```\n\nSee https://example.invalid/a/very/long/path/that/will/not/break/anywhere/at/all/because/it/is/one/token',
    }],
  },
  {
    type: 'tool',
    seq: 2,
    call: {
      toolCallId: 't1',
      title: 'packages/server/src/drivers/k8s/images/build-coordinator.ts',
      kind: 'read',
      status: 'completed',
      locations: [{ path: 'packages/server/src/drivers/k8s/images/build-coordinator.ts' }],
      content: [{ type: 'content', content: { type: 'text', text: Array.from({ length: 12 }, () => LONG_LINE).join('\n') } }],
    },
  },
  // An edit is expanded by default, so its diff is visible without a click.
  {
    type: 'tool',
    seq: 3,
    call: {
      toolCallId: 't2',
      title: 'packages/server/src/drivers/k8s/images/build-coordinator.ts',
      kind: 'edit',
      status: 'completed',
      locations: [{ path: 'packages/server/src/drivers/k8s/images/build-coordinator.ts' }],
      content: [{
        type: 'diff',
        path: 'packages/server/src/drivers/k8s/images/build-coordinator.ts',
        oldText: `${LONG_LINE}\nreturn resolved\n`,
        newText: `${LONG_LINE} + '-cached'\nreturn resolved\n`,
      }],
    },
  },
]

const STOPPED = [{
  workspaceId: 'w-overflow-probe',
  projectSlug: 'probe',
  tool: 'claude',
  createdAt: '2026-01-01 00:00:00',
  lastActiveAt: '2026-01-01 00:05:00',
  stoppedAt: '2026-01-01 00:06:00',
  prompt: 'why is the build cache missing?',
  title: 'build cache probe',
  seen: true,
  agentSessions: [{ agentSessionId: 'c1', tool: 'claude', mode: 'acp', ordinal: 0, active: true }],
}]

const failures = []
let where = ''
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`)
  if (!ok) failures.push(`${where}: ${what}`)
}

const lock = readServerLock()
const origin = process.env.APP_URL ?? `http://127.0.0.1:${lock.port}`
const browser = await chromium.launch()
try {
  await run({ name: 'desktop', viewport: { width: 1400, height: 900 } })
} finally {
  await browser.close()
}

async function run({ name, viewport }) {
  where = name
  console.log(`\n${name} (${viewport.width}x${viewport.height})`)
  const ctx = await browser.newContext({ viewport })
  const page = await ctx.newPage()
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))

  await page.route('**/workspace/list-stopped*', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(STOPPED) }))
  await page.route('**/workspace/*/agent-sessions/*/transcript*', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ events: EVENTS }) }))

  await page.goto(`${origin}/`)

  await page.locator('text=Stopped workspaces').first().click({ timeout: 15_000 })
  const popup = page.locator('[role="dialog"]').last()
  await popup.waitFor({ state: 'visible', timeout: 10_000 })
  // The transcript arrives on a separate fetch.
  await popup.locator('text=why is the build cache missing?').first().waitFor({ timeout: 10_000 })
  await popup.locator('text=/build-coordinator/').first().waitFor({ timeout: 10_000 })

  const restart = popup.locator('button', { hasText: 'Restart' }).last()
  const box = async (loc) => await loc.boundingBox()
  const popupBox = await box(popup)
  // The detail pane is the overlay column holding Restart.
  const detailBox = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('[role="dialog"] button')]
      .find((b) => b.textContent?.trim() === 'Restart')
    if (!btn) return null
    let el = btn.parentElement
    while (el && !(el.parentElement?.classList.contains('gap-3'))) el = el.parentElement
    const r = el?.getBoundingClientRect()
    return r ? { x: r.x, y: r.y, width: r.width, right: r.right } : null
  })

  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const shot = path.join(SHOT_DIR, `stopped-transcript-overflow-${name}.png`)
  await page.screenshot({ path: shot })

  check(detailBox !== null, 'the detail pane was found')
  if (detailBox && popupBox) {
    check(
      detailBox.right <= popupBox.x + popupBox.width + 1,
      `the detail pane stays inside the overlay (detail right ${Math.round(detailBox.right)}px vs overlay right ${Math.round(popupBox.x + popupBox.width)}px)`,
    )
  }

  const restartBox = await box(restart)
  check(restartBox !== null, 'the Restart button is laid out')
  if (restartBox && popupBox) {
    check(
      restartBox.x + restartBox.width <= popupBox.x + popupBox.width + 1
        && restartBox.x >= popupBox.x - 1,
      `the Restart button is inside the overlay (button right ${Math.round(restartBox.x + restartBox.width)}px vs overlay right ${Math.round(popupBox.x + popupBox.width)}px)`,
    )
    // An overflowing ancestor can cover the button even inside the box.
    const hit = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y)
      return el?.closest('button')?.textContent?.trim() ?? null
    }, { x: restartBox.x + restartBox.width / 2, y: restartBox.y + restartBox.height / 2 })
    check(hit === 'Restart', `the Restart button is hit-testable (found ${JSON.stringify(hit)})`)
  }

  const doc = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    inner: window.innerWidth,
  }))
  check(doc.scrollWidth <= doc.inner, `the page does not scroll sideways (${doc.scrollWidth} <= ${doc.inner})`)

  const scrollable = await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] *')]
    .some((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible'))
  check(scrollable, 'wide transcript content scrolls inside its own block')

  console.log(`screenshot -> ${shot}`)
  await ctx.close()
}

console.log(failures.length === 0 ? '\nAll checks passed.' : `\n${failures.length} check(s) failed.`)
process.exit(failures.length === 0 ? 0 : 1)
