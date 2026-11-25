/*
 * Verifies, in real Chromium, which pane tiles mode treats as focused when a
 * workspace shows two chat sessions side by side:
 *
 *  1. The column holding the focused pane carries the accent outline, and
 *     only one column does.
 *  2. Alt+L and Alt+H move both the outline and keyboard focus between the
 *     two chat composers.
 *  3. Dragging to select text in the other pane's transcript moves the
 *     outline there, keeps the selection, and leaves the composer unfocused.
 *  4. A composer control clicked in the unfocused pane (the settings pill)
 *     opens its popup and keeps it open.
 *
 * Only reads: it sends no message. Needs a live workspace with at least two
 * `acp` sessions; set WORKSPACE_ID, or it takes the first such workspace.
 * If both sessions share a column, it drags the second tab into its own.
 *
 * Run: [COLOR_SCHEME=dark] node test-playwright-scripts/tiles-focus-outline.js
 */
import path from 'node:path'
import { SHOTS, api, check, finish, origin, requirePlaywright, until } from './lib.js'

const { workspaces } = await api('/workspace/list')
const workspace = workspaces.find((w) => (process.env.WORKSPACE_ID ? w.workspaceId.startsWith(process.env.WORKSPACE_ID)
  : w.sessions.filter((s) => s.mode === 'acp' && s.conversationId).length >= 2))
if (!workspace) throw new Error('no live workspace with two acp sessions')
// The color scheme the page is seen in (light or dark), for the screenshots.
const SCHEME = process.env.COLOR_SCHEME ?? 'light'
const url = `${origin}/?project=${workspace.projectId}&workspace=${workspace.workspaceId}`

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: SCHEME })
await page.goto(url)
await page.waitForSelector('textarea')
// Window view, then wait for both composers.
await page.keyboard.press('Alt+Period')
await until(page, () => document.querySelectorAll('main section').length >= 2
  && [...document.querySelectorAll('textarea')].filter((t) => t.getClientRects().length > 0).length >= 2)

/** Where things stand: the outlined column's index, how many outlines there
 *  are, and which composer (by column) holds focus, or -1. */
const state = () => page.evaluate(() => {
  const columns = [...document.querySelectorAll('main section')].map((s) => s.getBoundingClientRect())
  const colOf = (r) => columns.findIndex((c) => r.left >= c.left - 1 && r.right <= c.right + 1)
  const outlines = [...document.querySelectorAll('main .border-accent-outline.pointer-events-none')]
  const active = document.activeElement
  return {
    outlines: outlines.length,
    outlined: outlines[0] ? columns.findIndex((c) => Math.abs(c.left - outlines[0].getBoundingClientRect().left) < 1) : -1,
    focused: active instanceof HTMLTextAreaElement ? colOf(active.getBoundingClientRect()) : -1,
    selection: String(window.getSelection() ?? ''),
  }
})
const composers = page.locator('main textarea:visible')

await composers.nth(0).click()
let s = await state()
check('clicking the first composer outlines its column and focuses it', s.outlines === 1 && s.outlined === 0 && s.focused === 0, JSON.stringify(s))
await page.screenshot({ path: path.join(SHOTS, 'tiles-focus-first.png') })

await page.keyboard.press('Alt+KeyL')
await page.waitForTimeout(200)
s = await state()
check('Alt+L moves the outline and focus to the second composer', s.outlined === 1 && s.focused === 1, JSON.stringify(s))
await page.screenshot({ path: path.join(SHOTS, `tiles-focus-second-${SCHEME}.png`) })

await page.keyboard.press('Alt+KeyH')
await page.waitForTimeout(200)
s = await state()
check('Alt+H moves them back', s.outlined === 0 && s.focused === 0, JSON.stringify(s))

// Drag across a line of text in the second pane's transcript (above its
// composer; an empty conversation's placeholder will do).
const para = await page.evaluate(() => {
  const col = document.querySelectorAll('main section')[1].getBoundingClientRect()
  const composerTop = [...document.querySelectorAll('main textarea')]
    .map((t) => t.getBoundingClientRect()).find((r) => r.left >= col.left && r.right <= col.right)?.top ?? col.bottom
  const walker = document.createTreeWalker(document.querySelector('main'), NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.textContent.trim().length < 8 || n.parentElement.closest('button, textarea')) continue
    const range = document.createRange()
    range.selectNodeContents(n)
    const r = range.getBoundingClientRect()
    if (r.left >= col.left && r.right <= col.right && r.top > col.top + 50 && r.bottom < composerTop - 20) {
      return { x: r.left + 2, y: r.top + r.height / 2, w: Math.min(r.width - 4, 120) }
    }
  }
  return null
})
if (para) {
  await page.mouse.move(para.x, para.y)
  await page.mouse.down()
  await page.mouse.move(para.x + para.w, para.y, { steps: 5 })
  await page.mouse.up()
  await page.waitForTimeout(200)
  s = await state()
  check('selecting transcript text in the second pane outlines it, keeping the selection', s.outlined === 1 && s.selection.length > 0 && s.focused !== 1, JSON.stringify(s))
} else {
  check('the second pane has transcript text to select', false)
}

// Back to the first pane, then open the second pane's settings pill.
await composers.nth(0).click()
const pillButton = await page.evaluateHandle(() => {
  const col = document.querySelectorAll('main section')[1].getBoundingClientRect()
  return [...document.querySelectorAll('main button[aria-haspopup]')].find((b) => {
    const r = b.getBoundingClientRect()
    return r.width > 0 && r.left >= col.left && r.right <= col.right && r.top > 300
  }) ?? null
})
if (await pillButton.evaluate((b) => b !== null)) {
  await pillButton.asElement().click()
  await page.waitForTimeout(400)
  const open = await page.evaluate(() => document.querySelector('[role="menu"], [role="dialog"], [role="listbox"]') !== null)
  check('a popup opened from the unfocused pane stays open', open)
  await page.screenshot({ path: path.join(SHOTS, 'tiles-focus-popup.png') })
} else {
  check('the second pane has a composer control with a popup', false)
}

await browser.close()
finish()
