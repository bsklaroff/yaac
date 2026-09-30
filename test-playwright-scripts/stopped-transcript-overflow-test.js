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
 * Desktop only; mobile-shell-test.js covers the phone layout.
 *
 * The stopped listing and the transcript routes are stubbed with the ACP
 * events a claude conversation produces, so no agent turn, credentials or
 * stopped workspace is needed. Everything below the fetch is the real app.
 *
 * Needs a running `yaac server` with at least one project.
 *
 * Run: YAAC_DATA_DIR=... node test-playwright-scripts/stopped-transcript-overflow-test.js
 */
import path from 'node:path'
import { SHOTS, check, finish, origin, requirePlaywright } from './lib.js'

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

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))

  await page.route('**/api/workspace/list-stopped*', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(STOPPED) }))
  await page.route('**/api/workspace/*/agent-sessions/*/transcript*', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ events: EVENTS }) }))

  await page.goto(`${origin}/`)

  await page.locator('text=Stopped workspaces').first().click({ timeout: 15_000 })
  const popup = page.locator('[role="dialog"]').last()
  await popup.waitFor({ state: 'visible', timeout: 10_000 })
  // The transcript arrives on a separate fetch.
  await popup.locator('text=why is the build cache missing?').first().waitFor({ timeout: 10_000 })
  await popup.locator('text=/build-coordinator/').first().waitFor({ timeout: 10_000 })

  const popupBox = await popup.boundingBox()
  const popupRight = Math.round(popupBox.x + popupBox.width)
  // The detail pane is the overlay column holding Restart.
  const detailBox = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('[role="dialog"] button')]
      .find((b) => b.textContent?.trim() === 'Restart')
    let el = btn?.parentElement
    while (el && !(el.parentElement?.classList.contains('gap-3'))) el = el.parentElement
    return el?.getBoundingClientRect().toJSON() ?? null
  })
  await page.screenshot({ path: path.join(SHOTS, 'stopped-transcript-overflow.png') })

  check('the detail pane stays inside the overlay',
    detailBox !== null && detailBox.right <= popupRight + 1,
    `detail right ${Math.round(detailBox?.right)}px vs overlay right ${popupRight}px`)

  const restartBox = await popup.locator('button', { hasText: 'Restart' }).last().boundingBox()
  check('the Restart button is inside the overlay',
    restartBox !== null && restartBox.x + restartBox.width <= popupRight + 1 && restartBox.x >= popupBox.x - 1,
    `button right ${Math.round(restartBox?.x + restartBox?.width)}px vs overlay right ${popupRight}px`)
  // An overflowing ancestor can cover the button even inside the box.
  const hit = restartBox && await page.evaluate(({ x, y }) =>
    document.elementFromPoint(x, y)?.closest('button')?.textContent?.trim() ?? null,
  { x: restartBox.x + restartBox.width / 2, y: restartBox.y + restartBox.height / 2 })
  check('the Restart button is hit-testable', hit === 'Restart', `found ${JSON.stringify(hit)}`)

  const doc = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth])
  check('the page does not scroll sideways', doc[0] <= doc[1], `${doc[0]} vs ${doc[1]}`)

  const scrollable = await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] *')]
    .some((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible'))
  check('wide transcript content scrolls inside its own block', scrollable)
} finally {
  await browser.close()
}
finish()
