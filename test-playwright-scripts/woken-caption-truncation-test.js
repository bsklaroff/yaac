/*
 * Verifies in Chromium that a run's "Woken by …" caption stays on one line,
 * at desktop (1400x900) and phone (390x844) widths:
 *
 *  1. a caption whose causes are too long to fit is one line high, cuts its
 *     causes short with an ellipsis, and keeps inside the transcript;
 *  2. each cut cause keeps its full name as its tooltip, and its comma and
 *     the "Woken by" prefix are not cut;
 *  3. a caption that fits is shown whole.
 *
 * The stopped listing and the transcript routes are stubbed with the ACP
 * events of two runs a background task, a subagent and a monitor woke, so no
 * agent turn, credentials or stopped workspace is needed. Everything below
 * the fetch is the real app.
 *
 * Needs a running `yaac server` with the project PROJECT (default `yaac`).
 * The page opens with the stubbed workspace selected, which the main pane
 * shows read-only.
 *
 * Run: node test-playwright-scripts/woken-caption-truncation-test.js
 */
import path from 'node:path'
import { SHOTS, check, finish, origin, requirePlaywright, resolveProject } from './lib.js'

const TASK = 'pnpm vitest run --project unit:server packages/server/test/runtime/agents/acp-log.test.ts --reporter verbose'
const SUBAGENT = 'Survey every package in the workspace and summarize what each one exports and imports'

const text = (t) => [{ type: 'text', text: t }]
const EVENTS = [
  { type: 'user', seq: 0, content: text('run the tests in the background and survey the packages') },
  { type: 'task', seq: 1, task: { id: 'b1', name: TASK, kind: 'shell', description: '', state: 'completed', summary: 'tests passed' } },
  { type: 'subagent', seq: 2, subagent: { id: 's1', name: SUBAGENT, task: 'survey', state: 'completed', summary: 'Seven packages.' } },
  { type: 'agent', seq: 3, content: text('Both launched.') },
  { type: 'agent-turn', seq: 4 },
  { type: 'woken', seq: 5, causes: [{ kind: 'task', id: 'b1', name: TASK }, { kind: 'subagent', id: 's1', name: SUBAGENT }] },
  { type: 'agent', seq: 6, content: text('Both finished.') },
  { type: 'agent-turn', seq: 7 },
  { type: 'woken', seq: 8, causes: [{ kind: 'monitor' }] },
  { type: 'agent', seq: 9, content: text('The monitor fired.') },
]

const STOPPED = [{
  workspaceId: 'w-woken-probe',
  projectId: 'probe',
  tool: 'claude',
  createdAt: '2026-01-01 00:00:00',
  lastActiveAt: '2026-01-01 00:05:00',
  stoppedAt: '2026-01-01 00:06:00',
  prompt: 'run the tests in the background and survey the packages',
  title: 'woken caption probe',
  seen: true,
  agentSessions: [{ agentSessionId: 'c1', tool: 'claude', mode: 'acp', ordinal: 0, active: true }],
}]

const project = await resolveProject(process.env.PROJECT ?? 'yaac')
const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  for (const [name, viewport] of [['desktop', { width: 1400, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const page = await browser.newPage({ viewport })
    page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
    await page.route('**/api/workspace/list-stopped*', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ entries: STOPPED, total: STOPPED.length }) }))
    await page.route('**/api/workspace/*/agent-sessions/*/transcript*', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ events: EVENTS }) }))
    await page.goto(`${origin}/?project=${project.id}&workspace=${STOPPED[0].workspaceId}`)
    await page.locator('text=Both finished.').first().waitFor({ timeout: 15_000 })

    const captions = await page.evaluate(() => [...document.querySelectorAll('span')]
      .filter((s) => s.textContent === 'Woken by')
      .map((s) => {
        const caption = s.parentElement
        const box = caption.getBoundingClientRect()
        const scroller = caption.closest('.overflow-y-auto') ?? document.body
        const causes = [...caption.querySelectorAll('.truncate')].map((el) => ({
          title: el.getAttribute('title'),
          cut: el.scrollWidth > el.clientWidth,
          ellipsis: getComputedStyle(el).textOverflow === 'ellipsis',
        }))
        return {
          height: box.height,
          lineHeight: parseFloat(getComputedStyle(s).lineHeight),
          inside: box.right <= scroller.getBoundingClientRect().right + 1,
          prefixCut: s.scrollWidth > s.clientWidth,
          commas: [...caption.querySelectorAll('span')].filter((el) => el.textContent === ',').length,
          causes,
        }
      }))
    await page.screenshot({ path: path.join(SHOTS, `woken-caption-${name}.png`) })

    const [long, short] = captions
    check(`${name}: the long caption is one line`, long !== undefined && long.height <= long.lineHeight * 1.5,
      `height ${long?.height}px, line ${long?.lineHeight}px`)
    check(`${name}: the long caption keeps inside the transcript`, long?.inside === true)
    check(`${name}: its causes are cut short with an ellipsis`,
      long !== undefined && long.causes.length === 2 && long.causes.some((c) => c.cut) && long.causes.every((c) => c.ellipsis),
      JSON.stringify(long?.causes))
    check(`${name}: each cause keeps its full name as its tooltip`,
      long?.causes[0]?.title === `background task ${TASK}` && long?.causes[1]?.title === `subagent ${SUBAGENT}`)
    check(`${name}: the prefix and the comma are not cut`, long?.prefixCut === false && long?.commas === 1)
    check(`${name}: a caption that fits is shown whole`,
      short !== undefined && short.causes.length === 1 && !short.causes[0].cut, JSON.stringify(short))
    await page.close()
  }
} finally {
  await browser.close()
}
finish()
