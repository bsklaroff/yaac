/*
 * Verifies in Chromium (1400x900) that a stopped workspace's conversation,
 * shown read-only in the main pane, stays inside the pane, and that the
 * bottom bar's view toggles (full width, condensed) work there as they do
 * in the live chat pane.
 *
 * The pane is a flex item beside the sidebar. Transcripts hold very wide
 * unbreakable content (`white-space: pre` tool output, fenced blocks,
 * diffs), and a flex item's default minimum width is its content's. Without
 * an explicit floor, the pane grows to the widest line and pushes the
 * Restart button off the window.
 *
 * Checks:
 *  1. The pane is no wider than the window.
 *  2. The Restart button is inside the window and hit-testable at its
 *     center.
 *  3. Wide content scrolls inside its own block instead of widening the pane.
 *  4. "Show every step" unfolds the tool calls, and "Full-width chat"
 *     widens the conversation's column (checked at 1800px).
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
import { SHOTS, api, check, finish, origin, requirePlaywright } from './lib.js'

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
  // A selection is looked up in the active project only, so use a real one.
  projectId: (await api('/project/list'))[0].id,
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
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ entries: STOPPED, total: STOPPED.length }) }))
  await page.route('**/api/workspace/*/agent-sessions/*/transcript*', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ events: EVENTS }) }))

  // Selected by the URL; the stopped workspace opens in the main pane.
  await page.goto(`${origin}/?project=${STOPPED[0].projectId}&workspace=${STOPPED[0].workspaceId}`)
  const pane = page.locator('main', { has: page.getByRole('button', { name: 'Restart' }) })
  await pane.waitFor({ state: 'visible', timeout: 15_000 })
  // The transcript arrives on a separate fetch.
  await pane.locator('text=why is the build cache missing?').first().waitFor({ timeout: 10_000 })
  // Condensed is the saved default, which folds the tool calls away.
  await page.evaluate(() => localStorage.setItem('yaac.chatcondensed.v1', '1'))
  await page.reload()
  await pane.locator('text=why is the build cache missing?').first().waitFor({ timeout: 10_000 })
  check('condensed folds the tool calls', await pane.locator('text=/build-coordinator/').count() === 0)
  await pane.getByRole('button', { name: 'Show every step' }).click()
  await pane.locator('text=/build-coordinator/').first().waitFor({ timeout: 10_000 })
  check('"Show every step" unfolds them', true)

  const columnWidth = () => pane.locator('text=why is the build cache missing?').first()
    .evaluate((el) => el.closest('.mx-auto, .w-full').getBoundingClientRect().width)
  // At 1400px the pane is barely wider than the centered column.
  await page.setViewportSize({ width: 1800, height: 900 })
  const centered = await columnWidth()
  await pane.getByRole('button', { name: 'Full-width chat' }).click()
  const full = await columnWidth()
  check('"Full-width chat" widens the column', full > centered + 20, `${Math.round(centered)}px -> ${Math.round(full)}px`)
  await page.screenshot({ path: path.join(SHOTS, 'stopped-transcript-full-width.png') })
  await pane.getByRole('button', { name: 'Center chat' }).click()
  await page.setViewportSize({ width: 1400, height: 900 })
  const windowRight = 1400
  const paneBox = await pane.boundingBox()
  await page.screenshot({ path: path.join(SHOTS, 'stopped-transcript-overflow.png') })

  check('the pane stays inside the window',
    paneBox !== null && paneBox.x + paneBox.width <= windowRight + 1,
    `pane right ${Math.round(paneBox?.x + paneBox?.width)}px`)

  const restartBox = await pane.getByRole('button', { name: 'Restart' }).boundingBox()
  check('the Restart button is inside the window',
    restartBox !== null && restartBox.x + restartBox.width <= windowRight + 1,
    `button right ${Math.round(restartBox?.x + restartBox?.width)}px`)
  // An overflowing ancestor can cover the button even inside the box.
  const hit = restartBox && await page.evaluate(({ x, y }) =>
    document.elementFromPoint(x, y)?.closest('button')?.textContent?.trim() ?? null,
  { x: restartBox.x + restartBox.width / 2, y: restartBox.y + restartBox.height / 2 })
  check('the Restart button is hit-testable', hit === 'Restart', `found ${JSON.stringify(hit)}`)

  const doc = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth])
  check('the page does not scroll sideways', doc[0] <= doc[1], `${doc[0]} vs ${doc[1]}`)

  const scrollable = await page.evaluate(() => [...document.querySelectorAll('main *')]
    .some((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible'))
  check('wide transcript content scrolls inside its own block', scrollable)
} finally {
  await browser.close()
}
finish()
