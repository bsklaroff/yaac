/*
 * Verifies the explorer/Changes text size (docs/file-editor.md "Text size")
 * in real Chromium on a phone-sized touch viewport:
 *   1. A two-finger pinch over the Changes pane's list, sent as real CDP
 *      touch events, grows the list's `zoom` and leaves the page itself
 *      unzoomed (visualViewport.scale stays 1). Pinching in shrinks it.
 *   2. A one-finger swipe still scrolls the list natively.
 *   3. The "Aa" menu shows on a phone and its Reset returns to 12px.
 *   4. A file opened from the list draws its code at 12px by default, the
 *      list's size, though its editing surface stays 16px (the iOS
 *      focus-zoom floor); a pinch over it scales the editor, not the page,
 *      and a tap still lands the cursor where it was tapped. The find bar
 *      mounts outside that scale, so it keeps its normal size.
 *   5. A pinch over an image preview zooms the page and leaves the editor's
 *      size alone.
 * SCREENSHOT_DIR gets files-pinch-big.png, editor-pinch-big.png and
 * editor-pinch-find.png.
 *
 * Needs a running containerless `yaac server` with one live workspace whose
 * checkout has changes whose diffs, shown together, run past one screen,
 * one of them a new file `pinch-new.ts` of at least 20 lines and one a new
 * image `pinch-shot.png`.
 *
 * Run: node test-playwright-scripts/files-text-size-pinch.js <workspace-id>
 */
import path from 'node:path'
import { requirePlaywright, origin, api, check, finish, SHOTS } from './lib.js'

const { chromium } = requirePlaywright()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const { workspaces } = await api('/workspace/list')
const wt = workspaces.find((w) => w.workspaceId.startsWith(process.argv[2] ?? '\0'))
if (!wt) {
  console.error('usage: node test-playwright-scripts/files-text-size-pinch.js <live-workspace-id>')
  process.exit(1)
}

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
const page = await ctx.newPage()
const cdp = await ctx.newCDPSession(page)
await page.addInitScript(() => {
  localStorage.setItem('yaac.filesfontsize.v1', '12')
  localStorage.setItem('yaac.editorfontsize.v1', '12')
})
const query = new URLSearchParams({ project: wt.projectId, workspace: wt.workspaceId })
await page.goto(`${origin}/?${query}`)
await page.locator('[title="Review changes"]').first().click({ timeout: 20000 })
await page.locator('[aria-label="Filter changed files"]').waitFor({ timeout: 10000 })
const list = page.locator('[style*="zoom"]').first()
await list.waitFor()
const zoom = () => list.evaluate((el) => Number(el.style.zoom))
const scale = () => page.evaluate(() => window.visualViewport.scale)
check('the list starts at zoom 1', await zoom() === 1)

const box = await list.boundingBox()
const cx = box.x + box.width / 2
const cy = box.y + Math.min(box.height / 2, 150)
async function pinch(from, to, x = cx, y = cy) {
  const pts = (d) => [{ x: x - d / 2, y, id: 1 }, { x: x + d / 2, y, id: 2 }]
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(from) })
  for (let i = 1; i <= 10; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(from + (to - from) * i / 10) })
    await sleep(16)
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await sleep(300)
}

await pinch(100, 180)
const grown = await zoom()
check('pinching out grows the list', grown > 1.5, grown)
check('the page itself does not zoom', await scale() === 1, await scale())
await page.screenshot({ path: path.join(SHOTS, 'files-pinch-big.png') })
await pinch(180, 90)
check('pinching in shrinks it again', await zoom() < grown, await zoom())

await page.getByRole('button', { name: 'Show all changes', exact: true }).click()
await sleep(500)
const before = await list.evaluate((el) => el.scrollTop)
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx, y: cy + 100, id: 1 }] })
for (let i = 1; i <= 10; i++) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx, y: cy + 100 - i * 15, id: 1 }] })
  await sleep(16)
}
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
await sleep(500)
check('one finger still scrolls the list', await list.evaluate((el) => el.scrollTop) > before)

await page.locator('[aria-label="Text size"]').click()
await page.getByRole('button', { name: 'Reset', exact: true }).click()
check('Reset returns to 12px', await zoom() === 1, await zoom())
await page.keyboard.press('Escape')

// The rendered size of a line's text, its CSS font size times any scale,
// from the advance of its first characters (0.6em in a monospace face).
const textPx = (sel) => page.locator(sel).first().evaluate((el) => {
  const text = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode()
  const range = document.createRange()
  range.setStart(text, 0)
  range.setEnd(text, 3)
  return Math.round(range.getBoundingClientRect().width / 3 / 0.6 * 10) / 10
})
await page.locator('button[title="Open pinch-new.ts"]').click()
await page.locator('.cm-line').first().waitFor()
await sleep(500)
check('the editor draws code at 12px by default', await textPx('.cm-line') === 12, await textPx('.cm-line'))
check('its editing surface stays 16px', await page.locator('.cm-content').evaluate((el) => getComputedStyle(el).fontSize) === '16px')
const ed = await page.locator('.cm-scroller').boundingBox()
await pinch(100, 200, ed.x + ed.width / 2, ed.y + 200)
check('pinching the editor grows its code', await textPx('.cm-line') === 24, await textPx('.cm-line'))
check('the page itself does not zoom', await scale() === 1, await scale())
await page.screenshot({ path: path.join(SHOTS, 'editor-pinch-big.png') })
const line3 = await page.locator('.cm-line').nth(2).boundingBox()
await page.touchscreen.tap(line3.x + 5, line3.y + line3.height / 2)
await sleep(300)
const cursorLine = await page.evaluate(() => {
  const sel = document.getSelection()
  return sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement).closest('.cm-line')?.textContent
})
check('a tap lands the cursor on the line tapped', cursorLine === 'export const line_3 = 1', cursorLine)

await page.locator('[title^="Find ("]').click()
const panel = page.locator('.cm-panels').first()
await panel.waitFor()
check('the find bar sits outside the scaled editor', await panel.evaluate((el) => !el.closest('[style*="scale"]')))
const drawn = await page.getByRole('textbox', { name: 'Find' })
  .evaluate((el) => [el.getBoundingClientRect().height, el.offsetHeight])
check('its input is drawn at its laid-out size', Math.abs(drawn[0] - drawn[1]) < 0.5, drawn)
await page.screenshot({ path: path.join(SHOTS, 'editor-pinch-find.png') })
await page.keyboard.press('Escape')

await page.getByText('Changes', { exact: true }).click()
await page.locator('button[title="Open pinch-shot.png"]').click()
const img = await page.getByAltText('pinch-shot.png').boundingBox()
await pinch(60, 200, img.x + img.width / 2, img.y + img.height / 2)
check('a pinch over an image zooms the page', await scale() > 1, await scale())
check('… and leaves the editor size alone',
  await page.evaluate(() => localStorage.getItem('yaac.editorfontsize.v1')) === '24')

await browser.close()
finish()
