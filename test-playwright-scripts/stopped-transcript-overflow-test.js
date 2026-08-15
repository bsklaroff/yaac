/*
 * Verifies the stopped-worktrees overlay in real Chromium (1400x900): a
 * loaded conversation must stay inside the overlay.
 *
 * The detail pane is a flex item beside the fixed-width list, and a
 * conversation is full of things whose min-content width is enormous — a
 * read tool call is source lines with `white-space: pre`, a fenced block is
 * the same, a diff is wider still. A flex item's automatic minimum size is
 * its content's, so without an explicit floor the detail column sizes itself
 * to the widest line in the transcript: the pane runs off the right of the
 * overlay and takes the Restart button with it, which is the one control the
 * view exists for.
 *
 * What it asserts:
 *  1. The detail pane is no wider than the overlay it sits in.
 *  2. The Restart button is inside the overlay's box, and hit-testable at its
 *     own center (nothing has pushed it out from under the pointer).
 *  3. Wide transcript content scrolls inside its own block rather than
 *     widening the pane — the code the tool call read is still reachable.
 *
 * Desktop widths only; the same pane on a phone (where it owns the whole
 * screen) is `mobile-overlay-panes-test.js`.
 *
 * The conversation is stubbed at the two routes the pane reads — the stopped
 * listing and one conversation's transcript — so the script needs no agent
 * turn, no credentials and no stopped worktree of its own: the events are
 * exactly the ACP events a claude conversation produces, and everything from
 * the fetch down is the real app.
 *
 * Drives the app the server itself serves (`dist/`), reading the port + lock
 * secret from $YAAC_DATA_DIR/.server.lock — so run `pnpm build` +
 * `yaac server restart` first, or you are looking at the frontend as it was.
 *
 * Needs a running `yaac server` with at least one project.
 *
 * Run: node test-playwright-scripts/stopped-transcript-overflow-test.js
 * (set SCREENSHOT_DIR to capture the overlay; defaults to /tmp/yaac-shots,
 * APP_URL to point it elsewhere).
 * (playwright is resolved from the global npm root; browsers live under
 * /opt/playwright-browsers)
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

async function mintToken(lock) {
  const res = await fetch(`http://127.0.0.1:${lock.port}/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${lock.secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'one-time' }),
  })
  if (res.status !== 201) throw new Error(`token mint failed: HTTP ${res.status}`)
  return (await res.json()).token
}

/** A source line long enough that no pane is as wide as it is. */
const LONG_LINE =
  'const resolved = await coordinator.ensureImage(project, chain, { requirePrebuilt: true, registry: "localhost:5000", tag: contentHash })'
  + ' // a trailing comment of the kind an agent writes, which keeps the line going well past any width a two-pane overlay could give it'

/** The conversation, as the ACP events acpd would have recorded: prose, a
 *  fenced block, and a read tool call whose body is a file. Each carries
 *  unbreakable width of its own kind, because they overflow differently. */
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
  // An edit opens by default, so its diff is on screen without a click —
  // which makes it the widest thing the pane renders unprompted.
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
  worktreeId: 'w-overflow-probe',
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
  // Desktop only: below the breakpoint the same column takes the whole
  // screen, and its geometry there is what `mobile-overlay-panes-test.js`
  // measures.
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

  await page.route('**/worktree/list-stopped*', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(STOPPED) }))
  await page.route('**/worktree/*/agent-sessions/*/transcript*', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ events: EVENTS }) }))

  const token = await mintToken(lock)
  await page.goto(`${origin}/?token=${token}`)
  await page.waitForFunction(() => !window.location.search.includes('token='), { timeout: 15_000 })

  await page.locator('text=Stopped worktrees').first().click({ timeout: 15_000 })
  const popup = page.locator('[role="dialog"]').last()
  await popup.waitFor({ state: 'visible', timeout: 10_000 })
  // The transcript arrives on its own fetch; wait for the conversation itself.
  await popup.locator('text=why is the build cache missing?').first().waitFor({ timeout: 10_000 })
  await popup.locator('text=/build-coordinator/').first().waitFor({ timeout: 10_000 })

  const restart = popup.locator('button', { hasText: 'Restart' }).last()
  const box = async (loc) => await loc.boundingBox()
  const popupBox = await box(popup)
  // The detail pane is the overlay's second column — the one holding Restart.
  const detailBox = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('[role="dialog"] button')]
      .find((b) => b.textContent?.trim() === 'Restart')
    if (!btn) return null
    // Walk up to the flex column the master/detail row lays out.
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
    // Inside the box is not the same as reachable: an ancestor that overflows
    // can leave the button under something else.
    const hit = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y)
      return el?.closest('button')?.textContent?.trim() ?? null
    }, { x: restartBox.x + restartBox.width / 2, y: restartBox.y + restartBox.height / 2 })
    check(hit === 'Restart', `the Restart button is hit-testable (found ${JSON.stringify(hit)})`)
  }

  // The page itself must not have grown a horizontal scrollbar.
  const doc = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    inner: window.innerWidth,
  }))
  check(doc.scrollWidth <= doc.inner, `the page does not scroll sideways (${doc.scrollWidth} <= ${doc.inner})`)

  // Wide content is still readable: its own block scrolls.
  const scrollable = await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] *')]
    .some((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible'))
  check(scrollable, 'wide transcript content scrolls inside its own block')

  console.log(`screenshot -> ${shot}`)
  await ctx.close()
}

console.log(failures.length === 0 ? '\nAll checks passed.' : `\n${failures.length} check(s) failed.`)
process.exit(failures.length === 0 ? 0 : 1)
