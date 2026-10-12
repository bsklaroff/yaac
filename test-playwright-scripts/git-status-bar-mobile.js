/*
 * Checks the git status strip's spacing at phone width (390x844): the strip
 * sits below the workspace bar's bottom border with its text vertically
 * centered, not pressed against the border. Saves a screenshot of the top of
 * the pane screen to SHOTS/git-status-bar-mobile.png.
 *
 * Creates a terminal-mode workspace in PROJECT unless WORKSPACE_ID is set,
 * and leaves it running. Serves the SPA from the server's `dist/`, so
 * rebuild and restart the server after frontend changes.
 *
 * Run: PROJECT=<name or id> [WORKSPACE_ID=<id in PROJECT>] node test-playwright-scripts/git-status-bar-mobile.js
 */
import path from 'node:path'
import { requirePlaywright, origin, until, check, finish, SHOTS, createWorkspace, resolveProject } from './lib.js'

const workspaceId = process.env.WORKSPACE_ID
  ?? await createWorkspace({ project: process.env.PROJECT, tool: 'claude', title: 'PW git status bar' })

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 })
const projectId = (await resolveProject(process.env.PROJECT)).id
await page.goto(`${origin}/?project=${projectId}&workspace=${workspaceId}`)
await until(page, () => /Up to date with|ahead of|behind|No branch named/.test(document.body.innerText))

const m = await page.evaluate(() => {
  const text = [...document.querySelectorAll('main span')]
    .find((el) => /^(Up to date with|No branch named|\d+ commits? (ahead|behind))/.test(el.textContent))
  const bar = text.parentElement
  const header = bar.previousElementSibling
  const hr = header.getBoundingClientRect()
  const br = bar.getBoundingClientRect()
  const tr = text.getBoundingClientRect()
  return { headerBottom: hr.bottom, barTop: br.top, barBottom: br.bottom, textTop: tr.top, textBottom: tr.bottom }
})
const above = m.textTop - m.barTop
const below = m.barBottom - m.textBottom
check('strip starts at the header border', Math.abs(m.barTop - m.headerBottom) < 1, JSON.stringify(m))
check('text has room above it', above >= 4, `above=${above}`)
check('text is vertically centered', Math.abs(above - below) <= 1, `above=${above} below=${below}`)

await page.screenshot({ path: path.join(SHOTS, 'git-status-bar-mobile.png'), clip: { x: 0, y: 0, width: 390, height: 130 } })
await browser.close()
finish()
