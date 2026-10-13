/*
 * Verifies Cmd/Ctrl-F over the Changes pane's diffs in Chromium, against a
 * fake running workspace whose changes are stubbed:
 *
 *  1. The chord (with focus in the pane) opens the find bar, focused.
 *  2. The count covers every shown diff, folded ones, ones inside a collapsed
 *     folder, and the far chunks of a long diff that have not mounted.
 *  3. Enter steps through the matches in the order the files are shown,
 *     unfolding the diff and opening the folder each match sits in, mounting
 *     its chunk, and scrolling the current mark on screen; Shift+Enter from
 *     the first wraps to the last.
 *  4. Match case narrows the count; Escape closes the bar, clears the marks
 *     and returns focus to the pane.
 *
 * The workspace is injected into the `/api/events` snapshot frames and its
 * `/changes` route answered by the script, so no workspace is needed.
 * Everything else is the real app.
 *
 * Needs a running `yaac server` with at least one project (or APP_URL set to
 * a vite dev server proxying to one).
 * Run: APP_URL=http://127.0.0.1:1537 node test-playwright-scripts/changes-find-test.js
 */
import path from 'node:path'
import { SHOTS, api, check, finish, origin, requirePlaywright } from './lib.js'

const WS = 'w-changes-find'
const [project] = await api('/project/list')

/** A diff adding `lines` to `file`. */
const added = (file, lines) => [
  `diff --git a/${file} b/${file}`, '--- /dev/null', `+++ b/${file}`, `@@ -0,0 +1,${lines.length} @@`,
  ...lines.map((l) => `+${l}`),
]
/** 600 lines with a needle near the top and one in the third 200-line chunk. */
const BIG = Array.from({ length: 600 }, (_, i) => (i === 4 || i === 549 ? `const needle${i} = ${i}` : `const x${i} = ${i}`))
const FILES = {
  'docs/readme.md': ['# Title', 'a needle in the docs'],
  'src/big.ts': BIG,
  'src/util/deep.ts': ['export const deep = "needle"'],
  'zed.txt': ['A Needle with a capital'],
}
const CHANGES = {
  base: 'abc1234def',
  baseResolved: true,
  branch: 'main',
  comparison: null,
  files: Object.entries(FILES).map(([p, lines]) => ({
    path: p, status: 'added', additions: lines.length, deletions: 0, binary: false,
    stages: { untracked: { additions: lines.length, deletions: 0 } },
  })),
  diff: Object.entries(FILES).flatMap(([p, lines]) => added(p, lines)).join('\n'),
  listing: {
    version: 'v1', root: '/workspace', paths: Object.keys(FILES), symlinks: {}, ignored: [], emptyDirs: [],
    conflicted: [], truncated: false,
  },
}
const WORKSPACE = {
  workspaceId: WS, projectId: project.id, tool: 'claude', status: 'running', createdAt: '2026-08-10 00:00:00',
  agentSessions: [], blockedHosts: [], forwardedPorts: [], unforwardedPorts: [],
}

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 800 } })
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  await page.routeWebSocket(/\/api\/events$/, (route) => {
    const server = route.connectToServer()
    server.onMessage((message) => {
      const parsed = typeof message === 'string' ? JSON.parse(message) : null
      if (parsed?.type === 'snapshot') {
        parsed.data.workspaces = [...parsed.data.workspaces, WORKSPACE]
        route.send(JSON.stringify(parsed))
      } else {
        route.send(message)
      }
    })
  })
  await page.route(`**/api/workspace/${WS}/changes*`, (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(CHANGES) }))

  await page.goto(`${origin}/?project=${project.id}&workspace=${WS}`)
  await page.locator('button[title="Review changes"]').first().click({ timeout: 15_000 })
  // A tree, with the deep folder collapsed and every diff folded.
  await page.getByRole('button', { name: 'Show as a tree' }).click()
  await page.getByTitle('src/util', { exact: true }).click()
  const deepRow = page.locator('[title$="deep.ts"]')
  check('the deep folder starts collapsed', await deepRow.count() === 0)

  await page.getByTitle('src', { exact: true }).focus()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f')
  const field = page.getByRole('textbox', { name: 'Find', exact: true })
  await field.waitFor({ timeout: 5000 })
  check('the chord opens the find bar, focused', await field.evaluate((el) => el === document.activeElement))

  await field.fill('needle')
  const status = field.locator('xpath=..').getByRole('status')
  await status.filter({ hasText: /of 5$/ }).waitFor({ timeout: 5000 })
  check('every diff is counted, folded or not', (await status.textContent()) === '1 of 5', await status.textContent())

  /** The current mark's line, and whether it lies inside the list's box. */
  const currentMark = () => page.evaluate(() => {
    const mark = document.querySelector('[data-find-current]')
    if (!mark) return null
    const r = mark.getBoundingClientRect()
    let list = mark.parentElement
    while (list && getComputedStyle(list).overflowY !== 'auto') list = list.parentElement
    const box = list.getBoundingClientRect()
    return { line: mark.closest('.flex')?.textContent, onScreen: r.top >= box.top && r.bottom <= box.bottom }
  })

  const seen = []
  for (let i = 1; i <= 5; i++) {
    if (i > 1) await field.press('Enter')
    await status.filter({ hasText: `${i} of 5` }).waitFor({ timeout: 2000 })
    await page.waitForTimeout(150)
    const mark = await currentMark()
    seen.push(mark?.line)
    check(`match ${i} is marked and on screen`, mark?.onScreen === true, JSON.stringify(mark))
  }
  check('the far chunk of the long diff mounted to show its match', seen.some((l) => /needle549/.test(l ?? '')), JSON.stringify(seen))
  check('the collapsed folder opened for its match', await deepRow.count() > 0)
  await page.screenshot({ path: path.join(SHOTS, 'changes-find.png') })

  await field.press('Enter')
  await status.filter({ hasText: '1 of 5' }).waitFor({ timeout: 2000 })
  check('Enter on the last match wraps to the first', true)
  await field.press('Shift+Enter')
  await status.filter({ hasText: '5 of 5' }).waitFor({ timeout: 2000 })
  check('Shift+Enter on the first wraps to the last', true)

  await page.getByRole('button', { name: 'Match case' }).click()
  await status.filter({ hasText: /of 4$/ }).waitFor({ timeout: 2000 })
  check('Match case drops the capitalized match', (await status.textContent()) === '1 of 4', await status.textContent())

  await field.press('Escape')
  await field.waitFor({ state: 'detached', timeout: 2000 })
  check('Escape clears the marks', await page.locator('[data-find-current]').count() === 0)
  check('Escape returns focus to the pane', await page.evaluate(() => document.activeElement?.tabIndex === -1))
} finally {
  await browser.close()
}
finish()
