/*
 * Verifies that a file pane's and the Changes pane's scroll positions come
 * back after the page goes to another origin and returns, as it does when
 * the desktop or iOS shell switches servers and back. The file pane keeps
 * the line at its top (wrapped lines included); the Changes pane its pixel
 * offset, put back once the open diffs have rendered. Then the same for a
 * markdown file shown rendered. Last, that a Changes position the content no
 * longer reaches gives way to the next scroll the app makes, which stays put
 * through the pane's polls and is saved.
 *
 * Writes a long file, a long markdown file and a dozen small ones under
 * `scroll-check/` in
 * WORKSPACE's checkout (a workspace of PROJECT) (they show as untracked changes), then opens them in
 * two columns by seeding the layout before the app loads. Needs a running
 * workspace whose checkout may take those files, and a server serving a
 * `dist/` built from the change under test (`pnpm build`, `yaac server
 * restart`).
 *
 * Run: PROJECT=<name> WORKSPACE=<id> [YAAC_DATA_DIR=...] node test-playwright-scripts/pane-scroll-across-reload.js
 */
import { api, check, finish, origin, requirePlaywright, resolveProject, until } from './lib.js'

const WORKSPACE = process.env.WORKSPACE
if (!WORKSPACE) throw new Error('set WORKSPACE to a running workspace id')
const PROJECT = (await resolveProject(process.env.PROJECT ?? 'yaac')).id
const LONG = 'scroll-check/long.txt'
const FILE = `file:${LONG}`
const LONG_MD = 'scroll-check/long.md'

await api(`/workspace/${WORKSPACE}/file`, {
  method: 'PUT',
  body: { path: LONG, content: Array.from({ length: 1000 }, (_, i) => `line ${i + 1} ${'word '.repeat(30)}\n`).join(''), baseVersion: null },
}).catch(() => { /* already written by an earlier run */ })
await api(`/workspace/${WORKSPACE}/file`, {
  method: 'PUT',
  body: { path: LONG_MD, content: Array.from({ length: 200 }, (_, i) => `## Section ${i + 1}\n\n${'Some prose. '.repeat(40)}\n\n`).join(''), baseVersion: null },
}).catch(() => {})
for (let n = 0; n < 12; n++) {
  await api(`/workspace/${WORKSPACE}/file`, {
    method: 'PUT',
    body: { path: `scroll-check/f${n}.txt`, content: Array.from({ length: 40 }, (_, i) => `file ${n} line ${i}\n`).join(''), baseVersion: null },
  }).catch(() => {})
}

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
// The Changes list, and the line at the top of the editor, read in-page.
await page.addInitScript(() => {
  window.changesList = () => [...document.querySelectorAll('.overflow-y-auto')]
    .find((el) => el.querySelector('[title="scroll-check/f11.txt"]'))
  window.topLine = () => {
    const cm = document.querySelector('.cm-scroller')
    const top = cm.getBoundingClientRect().top
    const line = [...cm.querySelectorAll('.cm-line')].find((l) => l.getBoundingClientRect().bottom > top + 1)
    return line?.textContent.match(/^line (\d+)/)?.[1]
  }
})
await page.goto(origin)
await page.evaluate(({ ws, file }) => {
  localStorage.setItem('yaac.layouts.v2', JSON.stringify({
    [ws]: [{ tabs: [file], active: file }, { tabs: ['changes'], active: 'changes' }],
  }))
  localStorage.removeItem('yaac.paneview.v1')
}, { ws: WORKSPACE, file: FILE })
const app = `${origin}/?project=${PROJECT}&workspace=${WORKSPACE}`
await page.goto(app)
await until(page, () => document.querySelector('.cm-scroller')?.scrollHeight > 5000 && window.changesList())

// Open every diff, so the Changes list is tall.
await page.click('[aria-label="Show all changes"]')
await until(page, () => window.changesList().scrollHeight > 3000)

const read = () => page.evaluate(() => ({ line: window.topLine(), changes: Math.round(window.changesList().scrollTop) }))
const centre = async (sel) => {
  const r = await page.evaluate(sel)
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2)
}
await centre(() => document.querySelector('.cm-scroller').getBoundingClientRect().toJSON())
for (let i = 0; i < 20; i++) await page.mouse.wheel(0, 600)
await centre(() => window.changesList().getBoundingClientRect().toJSON())
for (let i = 0; i < 4; i++) await page.mouse.wheel(0, 600)
await page.waitForTimeout(300)
const before = await read()
check('scrolled the file pane down', Number(before.line) > 50, before.line)
check('scrolled the Changes pane down', before.changes > 1000, String(before.changes))

// Leave for another origin straight away (pagehide saves), then come back.
await page.goto('about:blank')
await page.goto(app)
await until(page, () => document.querySelector('.cm-scroller')?.scrollTop > 0 && window.changesList()?.scrollTop > 0)
await page.waitForTimeout(1500)
const after = await read()
check('the file pane opens at the same top line', after.line === before.line, `${before.line} -> ${after.line}`)
check('the Changes pane opens at the same offset', Math.abs(after.changes - before.changes) <= 2, `${before.changes} -> ${after.changes}`)

// A markdown file shown rendered keeps its own offset.
await page.evaluate(({ ws, file }) => {
  localStorage.setItem('yaac.layouts.v2', JSON.stringify({ [ws]: [{ tabs: [file], active: file }] }))
  localStorage.setItem('yaac.filepreview.v1', '1')
}, { ws: WORKSPACE, file: `file:${LONG_MD}` })
await page.goto(app)
await until(page, () => document.querySelector('[data-markdown-document]')?.parentElement.scrollHeight > 5000)
await centre(() => document.querySelector('[data-markdown-document]').parentElement.getBoundingClientRect().toJSON())
for (let i = 0; i < 10; i++) await page.mouse.wheel(0, 700)
await page.waitForTimeout(300)
const mdBefore = await page.evaluate(() => Math.round(document.querySelector('[data-markdown-document]').parentElement.scrollTop))
check('scrolled the rendered markdown down', mdBefore > 2000, String(mdBefore))
await page.goto('about:blank')
await page.goto(app)
await until(page, () => document.querySelector('[data-markdown-document]')?.parentElement.scrollTop > 0)
await page.waitForTimeout(1000)
const mdAfter = await page.evaluate(() => Math.round(document.querySelector('[data-markdown-document]').parentElement.scrollTop))
check('the rendered markdown opens at the same offset', Math.abs(mdAfter - mdBefore) <= 2, `${mdBefore} -> ${mdAfter}`)

await page.evaluate(({ ws }) => {
  localStorage.setItem('yaac.layouts.v2', JSON.stringify({ [ws]: [{ tabs: ['changes'], active: 'changes' }] }))
  const views = JSON.parse(localStorage.getItem('yaac.paneview.v1'))
  views[`${ws}|changes`].scroll = 10_000_000
  localStorage.setItem('yaac.paneview.v1', JSON.stringify(views))
}, { ws: WORKSPACE })
await page.goto(app)
await until(page, () => window.changesList()?.scrollHeight > 3000)
await page.waitForTimeout(1000)
await page.evaluate(() => { window.changesList().scrollTop = 500 })
await page.waitForTimeout(4000)
const unreachable = await page.evaluate((ws) => ({
  top: Math.round(window.changesList().scrollTop),
  saved: JSON.parse(localStorage.getItem('yaac.paneview.v1'))[`${ws}|changes`].scroll,
}), WORKSPACE)
check('an out-of-reach position gives way to the app’s scroll', unreachable.top === 500, String(unreachable.top))
check('and that scroll is saved', unreachable.saved === 500, String(unreachable.saved))

await browser.close()
finish()
