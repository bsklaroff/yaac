/*
 * Verifies that copying the workspace header title puts exactly the title on
 * the clipboard, with no stray newlines. The title is a flex item, so
 * Chromium's own copy of a triple-click selection adds line breaks;
 * WorkspaceTitle's copy handler trims them. jsdom cannot select text like a
 * browser, so this triple-clicks and drag-selects the real header in
 * Chromium. It retitles the workspace to "My session title".
 *
 * Needs a running `yaac server` with one live workspace (see lib.js).
 *
 * Run: YAAC_DATA_DIR=... node test-playwright-scripts/header-title-copy-test.js <workspace-id>
 */
import { requirePlaywright, origin, api, check, finish } from './lib.js'

const { chromium } = requirePlaywright()
const TITLE = 'My session title'
const { workspaces } = await api('/workspace/list')
const wt = workspaces.find((w) => w.workspaceId.startsWith(process.argv[2] ?? '\0'))
if (!wt) {
  console.error('usage: node test-playwright-scripts/header-title-copy-test.js <live-workspace-id>')
  process.exit(1)
}
await api(`/workspace/${wt.workspaceId}/title`, { method: 'POST', body: { title: TITLE } })

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1400, height: 800 } })
await context.grantPermissions(['clipboard-read', 'clipboard-write'])
const page = await context.newPage()
await page.goto(`${origin}/?${new URLSearchParams({ project: wt.projectSlug, workspace: wt.workspaceId })}`)
const label = page.locator('span.select-text', { hasText: TITLE }).first()
await label.waitFor({ timeout: 20_000 })
const box = await label.boundingBox()
const y = box.y + box.height / 2

async function copied() {
  await page.keyboard.press('ControlOrMeta+c')
  const text = await page.evaluate(() => navigator.clipboard.readText())
  await page.evaluate(() => window.getSelection().removeAllRanges())
  return text
}

await page.mouse.click(box.x + box.width / 2, y, { clickCount: 3 })
const tripled = await copied()
check('a triple-click copies just the title', tripled === TITLE, JSON.stringify(tripled))
await page.mouse.move(box.x + 1, y)
await page.mouse.down()
await page.mouse.move(box.x + box.width + 40, y, { steps: 8 })
await page.mouse.up()
const dragged = await copied()
check('a drag past the end copies just the title', dragged === TITLE, JSON.stringify(dragged))

await browser.close()
finish()
