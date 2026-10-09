/*
 * Verifies in Chromium that Cmd/Ctrl-F searches a stopped workspace's whole
 * conversation, shown read-only in the main pane.
 *
 * Checks:
 *  1. The chord opens a find bar with its field focused (the browser's own
 *     find never opens).
 *  2. Matches hidden in collapsed rows (thinking, a shell call's output)
 *     count, and are painted as CSS custom highlights, one of them current.
 *  3. Stepping to a match deep in a long tool output scrolls both the
 *     output's own box and the transcript so the match is on screen.
 *  4. Escape closes the bar and clears the highlights.
 *
 * The stopped listing and the transcript route are stubbed with ACP events,
 * so no agent turn or stopped workspace is needed. Everything below the
 * fetch is the real app.
 *
 * Needs a running `yaac server` with at least one project, serving a
 * `dist/` built from this change (`pnpm build`).
 *
 * Run: YAAC_DATA_DIR=... node test-playwright-scripts/conversation-find-test.js
 */
import path from 'node:path'
import { SHOTS, api, check, finish, origin, requirePlaywright } from './lib.js'

const filler = (seq) => ({
  type: 'agent', seq, content: [{ type: 'text', text: `Paragraph ${seq} of filler that pushes the end of the conversation well below the fold.` }],
})

/** Three needles: one in thinking, one 300 lines into a shell call's output,
 *  and one in the last message, far below the first screen. */
const EVENTS = [
  { type: 'user', seq: 0, content: [{ type: 'text', text: 'where is the bug?' }] },
  { type: 'thought', seq: 1, content: [{ type: 'text', text: 'the needle may be in the router' }] },
  {
    type: 'tool', seq: 2,
    call: { toolCallId: 't1', title: 'grep -rn bug src', kind: 'execute', status: 'completed', shell: true },
  },
  {
    type: 'tool-output', seq: 3, toolCallId: 't1',
    data: `${Array.from({ length: 300 }, (_, i) => `src/file${i}.ts: nothing here`).join('\n')}\nsrc/router.ts: needle found\n`,
  },
  ...Array.from({ length: 60 }, (_, i) => filler(4 + i)),
  { type: 'agent', seq: 64, content: [{ type: 'text', text: 'The needle was in the router.' }] },
]

/** A stopped entry shows only under the project being viewed. */
const [project] = await api('/project/list')
const STOPPED = [{
  workspaceId: 'w-find-probe',
  projectId: project.id,
  tool: 'claude',
  createdAt: '2026-01-01 00:00:00',
  lastActiveAt: '2026-01-01 00:05:00',
  stoppedAt: '2026-01-01 00:06:00',
  prompt: 'where is the bug?',
  title: 'find probe',
  seen: true,
  agentSessions: [{ agentSessionId: 'c1', tool: 'claude', mode: 'acp', ordinal: 0, active: true }],
}]

/** How many ranges each find highlight holds. */
const painted = (page) => page.evaluate(() => ({
  all: CSS.highlights.get('find-match')?.size ?? 0,
  current: CSS.highlights.get('find-current')?.size ?? 0,
}))

/** Whether the current match's box lies inside every scroller around it. */
const currentOnScreen = (page) => page.evaluate(() => {
  const [range] = [...(CSS.highlights.get('find-current') ?? [])]
  if (!range) return { ok: false, text: null }
  const r = range.getBoundingClientRect()
  let ok = r.height > 0
  for (let el = range.startContainer.parentElement; el; el = el.parentElement) {
    const style = getComputedStyle(el)
    if (!/(auto|scroll)/.test(style.overflowY + style.overflowX)) continue
    const box = el.getBoundingClientRect()
    if (r.top < box.top || r.bottom > box.bottom) ok = false
  }
  // The match with a little of the text around it.
  const node = range.startContainer.textContent ?? ''
  return { ok, text: node.slice(Math.max(0, range.startOffset - 20), range.endOffset + 20), match: range.toString() }
})

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  await page.route('**/api/workspace/list-stopped*', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ entries: STOPPED, total: STOPPED.length }) }))
  await page.route('**/api/workspace/*/agent-sessions/*/transcript*', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ events: EVENTS }) }))

  await page.goto(`${origin}/?project=${project.id}&workspace=${STOPPED[0].workspaceId}`)
  const pane = page.locator('main', { has: page.getByRole('button', { name: 'Restart' }) })
  await pane.locator('text=where is the bug?').first().waitFor({ timeout: 15_000 })

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f')
  const field = page.getByRole('textbox', { name: 'Find' })
  await field.waitFor({ timeout: 5000 })
  check('the chord opens the find bar, focused', await field.evaluate((el) => el === document.activeElement))

  await field.fill('needle')
  // The count beside the field; the page has other status regions.
  const status = field.locator('xpath=..').getByRole('status')
  await status.filter({ hasText: 'of 3' }).waitFor({ timeout: 5000 })
  check('hidden matches count', (await status.textContent()) === '1 of 3', await status.textContent())
  const marks = await painted(page)
  check('every match is painted, one as current', marks.all === 2 && marks.current === 1, JSON.stringify(marks))
  const first = await currentOnScreen(page)
  check('the first match is in the thinking, on screen', first.ok && first.match === 'needle' && /may be in/.test(first.text), JSON.stringify(first))

  await field.press('Enter')
  await status.filter({ hasText: '2 of 3' }).waitFor({ timeout: 2000 })
  const deep = await currentOnScreen(page)
  check('a match deep in a tool output scrolls into view', deep.ok && deep.match === 'needle' && /router\.ts/.test(deep.text), JSON.stringify(deep))
  await page.screenshot({ path: path.join(SHOTS, 'conversation-find-output.png') })

  await field.press('Enter')
  await status.filter({ hasText: '3 of 3' }).waitFor({ timeout: 2000 })
  const last = await currentOnScreen(page)
  check('the last message scrolls into view', last.ok && last.match === 'needle' && /was in the router/.test(last.text), JSON.stringify(last))
  await page.screenshot({ path: path.join(SHOTS, 'conversation-find-last.png') })

  await field.press('Escape')
  await field.waitFor({ state: 'detached', timeout: 2000 })
  const cleared = await painted(page)
  check('Escape closes the bar and clears the highlights', cleared.all === 0 && cleared.current === 0, JSON.stringify(cleared))
} finally {
  await browser.close()
}
finish()
