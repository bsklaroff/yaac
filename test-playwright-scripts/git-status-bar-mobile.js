/*
 * Checks the workspace's git status at phone width (390x844), where the top
 * bar has no git summary and the status lives in the Details pane's Git
 * card: the comparison row shows with its text vertically centered in the
 * row, and the row and its Commits button fit inside the screen. Saves a
 * screenshot of the pane to SHOTS/git-status-bar-mobile.png.
 *
 * Creates a terminal-mode workspace in PROJECT (default yaac) unless
 * WORKSPACE_ID is set, and leaves it running. Serves the SPA from the
 * server's `dist/`, so rebuild and restart the server after frontend changes.
 *
 * Run: PROJECT=<name or id> [WORKSPACE_ID=<id in PROJECT>] node test-playwright-scripts/git-status-bar-mobile.js
 */
import path from 'node:path'
import { requirePlaywright, origin, until, check, finish, SHOTS, createWorkspace, resolveProject } from './lib.js'

const PROJECT = process.env.PROJECT ?? 'yaac'
const workspaceId = process.env.WORKSPACE_ID
  ?? await createWorkspace({ project: PROJECT, tool: 'claude', title: 'PW git status bar' })

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 })
const projectId = (await resolveProject(PROJECT)).id
await page.goto(`${origin}/?project=${projectId}&workspace=${workspaceId}`)
await page.getByRole('button', { name: 'Details', exact: true }).click({ timeout: 20_000 })
await until(page, () => /Up to date with|ahead of|behind|No branch named/.test(document.body.innerText))

const m = await page.evaluate(() => {
  const text = [...document.querySelectorAll('main span')]
    .find((el) => /^(Up to date with|No branch named|\d+ commits? (ahead|behind))/.test(el.textContent))
  const row = text.parentElement
  const commits = [...row.querySelectorAll('button')].find((b) => b.textContent === 'Commits')
  const rr = row.getBoundingClientRect()
  const tr = text.getBoundingClientRect()
  return {
    rowTop: rr.top, rowBottom: rr.bottom, rowLeft: rr.left, rowRight: rr.right,
    textTop: tr.top, textBottom: tr.bottom, commitsRight: commits?.getBoundingClientRect().right ?? null,
  }
})
const above = m.textTop - m.rowTop
const below = m.rowBottom - m.textBottom
check('text is vertically centered in its row', Math.abs(above - below) <= 1, `above=${above} below=${below}`)
check('row fits the screen', m.rowLeft >= 0 && m.rowRight <= 390, JSON.stringify(m))
check('Commits button shows inside the screen', m.commitsRight !== null && m.commitsRight <= 390, `right=${m.commitsRight}`)

await page.screenshot({ path: path.join(SHOTS, 'git-status-bar-mobile.png') })
await browser.close()
finish()
