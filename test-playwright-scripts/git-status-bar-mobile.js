/*
 * Checks the second line of a workspace's top bar at phone widths (390 and
 * 320px): the git status is vertically centred in the strip, the chips
 * after it (timeout, containerless, …) end inside the screen without
 * overlapping it, and the page does not scroll sideways. Saves a screenshot
 * per width to SHOTS/git-status-bar-mobile-<width>.png.
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
const projectId = (await resolveProject(PROJECT)).id
for (const width of [390, 320]) {
  const page = await browser.newPage({ viewport: { width, height: 844 }, deviceScaleFactor: 3 })
  await page.goto(`${origin}/?project=${projectId}&workspace=${workspaceId}`)
  const comparison = page.locator('button[title^="Review commits"]')
  await comparison.waitFor({ timeout: 20_000 })
  await until(page, () => /up to date with|ahead|behind|to compare with/.test(document.body.innerText))

  // The button sits in GitStatusBar's wrapper, which sits in the strip;
  // the strip's last child holds the chips.
  const m = await comparison.evaluate((button) => {
    const git = button.parentElement
    const strip = git.parentElement
    const rect = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width } }
    return {
      strip: rect(strip), git: rect(git), text: rect(button), chips: rect(strip.lastElementChild),
      scrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    }
  })
  const above = m.text.top - m.strip.top
  const below = m.strip.bottom - m.text.bottom
  check(`${width}: git status is centred in the strip`, Math.abs(above - below) <= 1.5, `above=${above} below=${below}`)
  check(`${width}: the strip fits the screen`, m.strip.left >= 0 && m.strip.right <= width, JSON.stringify(m.strip))
  check(`${width}: the chips end inside the screen`, m.chips.width === 0 || m.chips.right <= width, JSON.stringify(m.chips))
  check(`${width}: the git status and the chips do not overlap`, m.chips.width === 0 || m.git.right <= m.chips.left,
    `git.right=${m.git.right} chips.left=${m.chips.left}`)
  check(`${width}: no sideways scroll`, !m.scrolls)
  await page.screenshot({ path: path.join(SHOTS, `git-status-bar-mobile-${width}.png`) })
  await page.close()
}
await browser.close()
finish()
