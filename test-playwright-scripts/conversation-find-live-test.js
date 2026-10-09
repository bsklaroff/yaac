/*
 * Verifies in Chromium that Cmd/Ctrl-F searches a RUNNING workspace's
 * conversation: the live acp chat pane, and the transcript overlay a running
 * tui pane lays over its terminal. (conversation-find-test.js covers the
 * stopped, read-only pane with stubbed events.)
 *
 * Checks, acp chat pane:
 *  1. The chord opens the find bar focused and types nothing in the composer.
 *  2. A match inside a shell call's output, behind the condensed view's
 *     folded run and the collapsed tool row, is counted and painted on screen.
 *  3. Escape clears the highlights and returns focus to the composer.
 *  4. Rows the reader opened before searching stay open after the bar closes.
 *  5. While a turn streams, the current match's index stays put, and the
 *     rendered-text pass is reported (how many Worker counts it posted).
 * Checks, tui pane:
 *  6. The chord opens the overlay without the key reaching xterm.
 *  7. A hidden match in the tool's own transcript is counted and painted.
 *  8. The overlay refreshes the transcript route while open, and stops once
 *     Escape closes it; Escape returns focus to the terminal.
 *  9. The overlay stops refreshing once its pane is hidden (another
 *     workspace selected with the bar left open).
 * 10. Tiles with the explorer beside the terminal: the chord in the
 *     explorer goes to its filter, and only the terminal's pane opens a bar.
 *
 * Needs a running `yaac server` serving this change's `dist/`, and one
 * running workspace of each mode whose first turn ran a shell call printing
 * `zebra-needle-42`, e.g. for each mode:
 *
 *   yaac workspace create <project> --tool claude --model haiku \
 *     --permission-mode bypass --mode acp|tui \
 *     -p 'Run the shell command `seq 1 300; echo zebra-needle-42` exactly
 *         once, then reply in one short sentence that mentions the word
 *         zebra. Do nothing else.'
 *
 * Step 5 sends the acp agent one more message, so the agent must be able to
 * answer (a working claude credential).
 *
 * Run: node test-playwright-scripts/conversation-find-live-test.js
 */
import path from 'node:path'
import { SHOTS, api, check, finish, origin, requirePlaywright } from './lib.js'

const CHORD = process.platform === 'darwin' ? 'Meta+f' : 'Control+f'
const { workspaces } = await api('/workspace/list')
const byMode = (mode) => workspaces.find((w) => w.agentSessions?.some((s) => s.mode === mode))
const acp = byMode('acp')
const tui = byMode('tui')
if (!acp || !tui) throw new Error('needs one running acp and one running tui workspace (see header)')
// Titled so the sidebar tells them apart: step 9 switches without a reload.
await api(`/workspace/${acp.workspaceId}/title`, { method: 'POST', body: { title: 'find probe acp' } })
await api(`/workspace/${tui.workspaceId}/title`, { method: 'POST', body: { title: 'find probe tui' } })

const painted = (page) => page.evaluate(() => ({
  all: CSS.highlights.get('find-match')?.size ?? 0,
  current: CSS.highlights.get('find-current')?.size ?? 0,
}))

/** The current match's text and whether it is inside every scroller around it. */
const currentOnScreen = (page) => page.evaluate(() => {
  const [range] = [...(CSS.highlights.get('find-current') ?? [])]
  if (!range) return { ok: false }
  const r = range.getBoundingClientRect()
  let ok = r.height > 0
  for (let el = range.startContainer.parentElement; el; el = el.parentElement) {
    const style = getComputedStyle(el)
    if (!/(auto|scroll)/.test(style.overflowY + style.overflowX)) continue
    const box = el.getBoundingClientRect()
    if (r.top < box.top || r.bottom > box.bottom) ok = false
  }
  return { ok, match: range.toString(), inPre: range.startContainer.parentElement?.closest('pre') !== null }
})

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  // Every MatchCounter count is one Worker postMessage.
  await page.addInitScript(() => {
    window.__posts = []
    const post = Worker.prototype.postMessage
    Worker.prototype.postMessage = function (...args) {
      window.__posts.push(performance.now())
      return post.apply(this, args)
    }
  })
  const transcriptHits = []
  page.on('request', (req) => {
    if (/\/transcript/.test(req.url())) transcriptHits.push({ url: req.url(), at: Date.now() })
  })
  const hitsFor = (id, since) => transcriptHits.filter((h) => h.url.includes(id) && h.at >= since).length
  const field = page.getByRole('textbox', { name: 'Find' })
  const status = field.locator('xpath=..').getByRole('status')
  const composer = page.getByPlaceholder('Message the agent…')
  const open = (id) => page.goto(`${origin}/?project=${acp.projectId}&workspace=${id}`)

  // --- acp chat pane ---
  await open(acp.workspaceId)
  await composer.waitFor({ timeout: 20_000 })
  await page.getByRole('button', { name: /tool call/ }).waitFor({ timeout: 20_000 })
  await composer.click()
  await page.keyboard.press(CHORD)
  await field.waitFor({ timeout: 5000 })
  check('acp: the chord opens the bar, focused', await field.evaluate((el) => el === document.activeElement))
  check('acp: the chord types nothing in the composer', (await composer.inputValue()) === '', await composer.inputValue())

  await field.fill('zebra-needle-42')
  await status.filter({ hasText: /\d of / }).waitFor({ timeout: 5000 })
  const acpStatus = await status.textContent()
  let marks = await painted(page)
  const out = await currentOnScreen(page)
  check('acp: matches behind the fold and the collapsed row count', marks.current === 1, `${acpStatus} ${JSON.stringify(marks)}`)
  // Step to the one inside the output.
  for (let i = 0; i < 4 && !(await currentOnScreen(page)).inPre; i++) await field.press('Enter')
  const inOut = await currentOnScreen(page)
  check('acp: a match inside the shell output is painted on screen', inOut.ok && inOut.inPre, JSON.stringify({ out, inOut }))
  await page.screenshot({ path: path.join(SHOTS, 'conversation-find-acp.png') })

  await field.press('Escape')
  await field.waitFor({ state: 'detached', timeout: 2000 })
  marks = await painted(page)
  check('acp: Escape clears the highlights', marks.all === 0 && marks.current === 0, JSON.stringify(marks))
  check('acp: Escape returns focus to the composer', await composer.evaluate((el) => el === document.activeElement))
  check('acp: the current match\'s row stays open', await page.locator('pre', { hasText: 'zebra-needle-42' }).count() > 0)

  // Rows the reader opened before searching.
  await open(acp.workspaceId)
  await composer.waitFor({ timeout: 20_000 })
  await page.getByRole('button', { name: /tool call/ }).click()
  const toolRow = page.locator('[data-seq] button[aria-expanded]', { hasText: /seq|zebra|Run|Print|Generate|Execute/ }).first()
  await toolRow.click()
  const outputShown = () => page.locator('pre', { hasText: '300' }).count()
  check('setup: the reader opened the tool row', await outputShown() > 0)
  await composer.click()
  await page.keyboard.press(CHORD)
  // Matches the prompt (current, on screen) and the opened row's output.
  await field.fill('zebra')
  await status.filter({ hasText: /\d of / }).waitFor({ timeout: 5000 })
  const before = await currentOnScreen(page)
  await field.press('Escape')
  await field.waitFor({ state: 'detached', timeout: 2000 })
  check('acp: a row the reader opened stays open after the bar closes', await outputShown() > 0,
    `current was ${JSON.stringify(before)}`)

  // Folded run's toggle while a match holds it open.
  await open(acp.workspaceId)
  await composer.waitFor({ timeout: 20_000 })
  await composer.click()
  await page.keyboard.press(CHORD)
  await field.fill('zebra-needle-42')
  await status.filter({ hasText: /\d of / }).waitFor({ timeout: 5000 })
  const fold = page.getByRole('button', { name: /tool call/ })
  await fold.click()
  await page.waitForTimeout(300)
  check('acp: the folded run can be closed while a match is in it', (await fold.getAttribute('aria-expanded')) === 'false',
    `aria-expanded=${await fold.getAttribute('aria-expanded')}`)
  await field.press('Escape').catch(() => {})

  // Streaming: hold the current match while a turn appends matches below it.
  await open(acp.workspaceId)
  await composer.waitFor({ timeout: 20_000 })
  await composer.click()
  await page.keyboard.press(CHORD)
  await field.fill('zebra')
  await status.filter({ hasText: /\d of / }).waitFor({ timeout: 5000 })
  await field.press('Enter')
  const held = (await status.textContent()).split(' of ')[0]
  await composer.click()
  await composer.fill('Write a numbered list of 30 short lines, each a different sentence that contains the word zebra. No tools.')
  await composer.press('Enter')
  const t0 = await page.evaluate(() => performance.now())
  const samples = []
  let last = ''
  let quietSince = Date.now()
  const started = Date.now()
  while (Date.now() - started < 90_000) {
    const s = await status.textContent()
    if (s !== last) {
      samples.push(s)
      last = s
      quietSince = Date.now()
    }
    if (samples.length > 2 && Date.now() - quietSince > 8000) break
    await page.waitForTimeout(100)
  }
  const posts = await page.evaluate((from) => window.__posts.filter((t) => t >= from).length, t0)
  const indices = new Set(samples.map((s) => s.split(' of ')[0]))
  check('acp: the count grows while the turn streams', samples.length > 1, samples.join(' | '))
  check('acp: the current index holds while it streams', indices.size === 1 && indices.has(held), `held ${held}: ${samples.join(' | ')}`)
  console.log(`  info: ${posts} Worker counts over ${samples.length} distinct statuses while streaming`)
  await page.screenshot({ path: path.join(SHOTS, 'conversation-find-acp-stream.png') })
  await field.press('Escape')

  // --- tui pane ---
  await open(tui.workspaceId)
  const xterm = page.locator('.xterm-helper-textarea').first()
  await xterm.waitFor({ state: 'attached', timeout: 20_000 })
  await page.waitForTimeout(1500)
  await page.locator('.xterm-screen').first().click()
  await xterm.evaluate((el) => {
    window.__xtermKeys = 0
    el.addEventListener('keydown', (e) => { if (e.code === 'KeyF') window.__xtermKeys++ })
  })
  await page.keyboard.press(CHORD)
  await field.waitFor({ timeout: 5000 })
  check('tui: the chord opens the overlay, focused', await field.evaluate((el) => el === document.activeElement))
  check('tui: the chord never reaches xterm', (await page.evaluate(() => window.__xtermKeys)) === 0)

  await field.fill('zebra-needle-42')
  await status.filter({ hasText: /\d of / }).waitFor({ timeout: 10_000 })
  const tuiStatus = await status.textContent()
  for (let i = 0; i < 4 && !(await currentOnScreen(page)).inPre; i++) await field.press('Enter')
  const tuiHit = await currentOnScreen(page)
  check('tui: a match in the shell output is painted on screen', tuiHit.ok && tuiHit.inPre, `${tuiStatus} ${JSON.stringify(tuiHit)}`)
  await page.screenshot({ path: path.join(SHOTS, 'conversation-find-tui.png') })

  let since = Date.now()
  await page.waitForTimeout(11_000)
  const whileOpen = hitsFor(tui.workspaceId, since)
  check('tui: the overlay refreshes while open', whileOpen >= 2, `${whileOpen} transcript fetches in 11s`)

  await field.press('Escape')
  await field.waitFor({ state: 'detached', timeout: 2000 })
  check('tui: Escape returns focus to the terminal', await xterm.evaluate((el) => el === document.activeElement))
  marks = await painted(page)
  check('tui: Escape clears the highlights', marks.all === 0 && marks.current === 0, JSON.stringify(marks))
  since = Date.now()
  await page.waitForTimeout(11_000)
  const afterClose = hitsFor(tui.workspaceId, since)
  check('tui: closing stops the refresh', afterClose === 0, `${afterClose} transcript fetches in 11s`)

  // Leave the overlay open and select the other workspace.
  await page.locator('.xterm-screen').first().click()
  await page.keyboard.press(CHORD)
  await field.waitFor({ timeout: 5000 })
  await page.getByText('find probe acp').first().click()
  await composer.waitFor({ timeout: 20_000 })
  since = Date.now()
  await page.waitForTimeout(11_000)
  const hidden = hitsFor(tui.workspaceId, since)
  check('tui: a hidden pane\'s overlay stops refreshing', hidden === 0, `${hidden} transcript fetches in 11s`)

  // Split layout: explorer and terminal side by side.
  await open(tui.workspaceId)
  await xterm.waitFor({ state: 'attached', timeout: 20_000 })
  await page.getByRole('button', { name: 'Browse files' }).click()
  const filter = page.getByPlaceholder(/Go to file/)
  await filter.waitFor({ timeout: 10_000 })
  await page.locator('[role="tree"], [role="treeitem"]').first().click().catch(() => filter.click())
  await page.keyboard.press(CHORD)
  await page.waitForTimeout(500)
  check('split: the chord in the explorer reaches its filter, not the conversation',
    (await field.count()) === 0 && (await filter.evaluate((el) => el === document.activeElement)),
    `find bars=${await field.count()}`)
  await page.locator('.xterm-screen').first().click()
  await page.keyboard.press(CHORD)
  await field.first().waitFor({ timeout: 5000 })
  check('split: the terminal\'s pane opens exactly one bar', (await field.count()) === 1, `find bars=${await field.count()}`)
  await page.screenshot({ path: path.join(SHOTS, 'conversation-find-split.png') })
  await field.press('Escape')
} finally {
  await browser.close()
}
finish()
