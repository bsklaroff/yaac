/*
 * Verifies that the Changes pane's unmounted diff chunks hold close to the
 * height they render at, so scrolling back over them does not jump, when
 * lines wrap (docs/file-editor.md "Changes"):
 *   1. at a fixed width, a chunk scrolled past holds exactly its measured
 *      height;
 *   2. after the pane is resized, it holds an estimate for the new width,
 *      not the height measured at the old one;
 *   3. after the diff changes, it holds an estimate for the new lines, not
 *      the height measured for the old ones;
 *   4. a chunk mounts a little before it scrolls into sight, so a wrong
 *      estimate is corrected off screen.
 * Prints each step's worst placeholder error. SCREENSHOT_DIR gets
 * changes-wrap-heights.png.
 *
 * Creates a workspace of PROJECT (default `yaac`), writes a 2,500-line file
 * of long lines into its checkout, and stops it at the end.
 *
 * Run: node test-playwright-scripts/changes-wrap-heights.js
 */
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR, SHOTS, api, check, createWorkspace, finish, origin, requirePlaywright, resolveProject, until } from './lib.js'

const { chromium } = requirePlaywright()
const project = await resolveProject(process.env.PROJECT ?? 'yaac')
const workspaceId = await createWorkspace({ project: project.id, tool: 'claude', mode: 'tui', title: 'PW wrap heights' })
const file = path.join(DATA_DIR, 'global/projects', project.id, 'workspaces', workspaceId, 'wrap-heights.txt')

/** 2,500 lines, every third a long one of 30 to 150 words. */
function longLines() {
  return Array.from({ length: 2500 }, (_, i) => i % 3
    ? `short line ${i}`
    : Array.from({ length: 30 + (i * 7) % 120 }, (_, w) => `word-${i}-${w}`).join(' ')).join('\n') + '\n'
}
fs.writeFileSync(file, longLines())

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
/* The diff's chunks, in order; an unmounted one has no child. An init
 * script, since the app's CSP forbids the `eval` a string argument needs. */
await page.addInitScript(() => {
  window.chunks = () => [...document.querySelector('.diff-hl').parentElement.parentElement.children]
})
try {
  await page.goto(`${origin}/?${new URLSearchParams({ project: project.id, workspace: workspaceId })}`)
  const totals = page.locator('button[title="Review changes"]')
  await totals.waitFor({ timeout: 30000 })
  await totals.click()
  await page.locator('.diff-hl').first().waitFor({ timeout: 15000 })

  /** Scroll to each chunk in turn and wait for it to mount; returns their
   *  rendered heights. */
  async function visitAll() {
    const n = await page.evaluate(() => window.chunks().length)
    const heights = []
    for (let i = 0; i < n; i++) {
      await page.evaluate((i) => window.chunks()[i].scrollIntoView(), i)
      await until(page, (i) => window.chunks()[i].firstChild !== null, i, 5000)
      heights.push(await page.evaluate((i) => window.chunks()[i].offsetHeight, i))
    }
    return heights
  }

  /** From the bottom of the diff, the placeholder heights of the chunks
   *  scrolled out of view, then the worst gap to what each renders at. */
  async function worstGap() {
    await page.evaluate(() => window.chunks().at(-1).scrollIntoView())
    await page.waitForTimeout(500)
    const held = await page.evaluate(() => window.chunks().map((el) => (el.firstChild ? null : el.offsetHeight)))
    const rendered = await visitAll()
    const gaps = held.flatMap((h, i) => (h === null ? [] : [{ abs: Math.abs(h - rendered[i]), rel: Math.abs(h - rendered[i]) / rendered[i] }]))
    return {
      unmounted: gaps.length,
      abs: Math.max(0, ...gaps.map((g) => g.abs)),
      rel: Math.max(0, ...gaps.map((g) => g.rel)),
    }
  }

  await page.waitForTimeout(500)
  await page.evaluate(() => {
    const cs = window.chunks()
    let list = cs[0].parentElement
    while (getComputedStyle(list).overflowY !== 'auto') list = list.parentElement
    cs[1].scrollIntoView()
    list.scrollTop -= list.clientHeight + 300
    return null
  })
  await page.waitForTimeout(500)
  const early = await page.evaluate(() => {
    const c = window.chunks()[1]
    let list = c.parentElement
    while (getComputedStyle(list).overflowY !== 'auto') list = list.parentElement
    return { below: Math.round(c.getBoundingClientRect().top - list.getBoundingClientRect().bottom), mounted: c.firstChild !== null }
  })
  check('a chunk just below the list mounts before it is in sight', early.below > 0 && early.mounted, JSON.stringify(early))

  await visitAll()
  const fixed = await worstGap()
  check('at a fixed width, held heights match rendered ones', fixed.unmounted > 3 && fixed.abs <= 1, JSON.stringify(fixed))

  await page.setViewportSize({ width: 1100, height: 900 })
  await page.waitForTimeout(500)
  const resized = await worstGap()
  check('after a resize, held heights are estimates for the new width', resized.unmounted > 3 && resized.rel < 0.25, JSON.stringify(resized))

  fs.writeFileSync(file, Array.from({ length: 1500 }, (_, i) => `short line ${i}`).join('\n') + '\n')
  await until(page, () => !document.querySelector('.diff-hl')?.textContent.includes('word-'), undefined, 30000)
  const changed = await worstGap()
  check('after the diff changes, held heights are estimates for the new lines', changed.unmounted > 3 && changed.rel < 0.25, JSON.stringify(changed))
  await page.screenshot({ path: path.join(SHOTS, 'changes-wrap-heights.png') })
} finally {
  await browser.close()
  await api('/workspace/stop', { method: 'POST', body: { workspaceId } })
}
finish()
