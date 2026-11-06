/*
 * Verifies the file pane's rendered view of markdown and HTML files in real
 * Chromium (docs/file-editor.md, "Previews"):
 *   1. docs/guide.md opens as text; "Show rendered" renders it, its PNG and
 *      SVG images inlined from the checkout and a remote image left a link.
 *   2. A heading link scrolls the preview; a link to a checkout file opens
 *      that file's pane.
 *   3. site/index.html renders with its linked stylesheet and images, its
 *      scripts never run (its <noscript> shows instead), and a heading link
 *      scrolls within the iframe.
 *   4. SCREENSHOT_DIR gets preview-md-dark.png, preview-md-light.png and
 *      preview-html.png for a look.
 *
 * Needs a running `yaac server` with one live workspace whose checkout holds
 * docs/guide.md (with images under docs/img/, a link to ../src/main.ts and a
 * `#setting-up` heading link) and site/index.html (linking style.css, an
 * `#end` heading link, a <noscript> and an inline script).
 *
 * Run: node test-playwright-scripts/file-preview.js <workspace-id>
 */
import path from 'node:path'
import { requirePlaywright, origin, api, check, finish, SHOTS } from './lib.js'

const { chromium } = requirePlaywright()

const { workspaces } = await api('/workspace/list')
const wt = workspaces.find((w) => w.workspaceId.startsWith(process.argv[2] ?? '\0'))
if (!wt) {
  console.error('usage: node test-playwright-scripts/file-preview.js <live-workspace-id>')
  process.exit(1)
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1300, height: 850 } })
const query = new URLSearchParams({ project: wt.projectId, workspace: wt.workspaceId })
await page.goto(`${origin}/?${query}`)
await page.waitForSelector('[aria-label="Browse files"]', { timeout: 20000 })

async function open(file) {
  await page.locator('[aria-label="Browse files"]').click()
  const filter = page.locator('[aria-label="Filter files"]')
  await filter.fill(file)
  await page.keyboard.press('Enter')
  await page.locator(`span.font-mono[title="${file}"]`).waitFor({ timeout: 10000 })
}

await open('docs/guide.md')
await page.getByLabel('Show rendered').click()
const doc = page.locator('[data-markdown-document]')
await doc.getByRole('heading', { name: 'Project guide' }).waitFor()
await page.waitForFunction(() => [...document.querySelectorAll('[data-markdown-document] img')].every((i) => i.naturalWidth > 0)
  && document.querySelectorAll('[data-markdown-document] img').length === 2, null, { timeout: 10000 })
check('png and svg images are inlined', await doc.locator('img').evaluateAll((imgs) => imgs.every((i) => i.src.startsWith('data:'))))
check('a remote image stays a link', await doc.getByRole('link', { name: 'remote badge' }).getAttribute('href') === 'https://img.shields.io/badge/x-y-green')
for (const theme of ['dark', 'light']) {
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
  await page.screenshot({ path: path.join(SHOTS, `preview-md-${theme}.png`) })
}

await doc.getByText('heading link').click()
await page.waitForTimeout(300)
check('a heading link scrolls to the heading', await doc.getByRole('heading', { name: 'Setting up' }).evaluate((el) => {
  const r = el.getBoundingClientRect()
  return r.top >= 0 && r.top < innerHeight
}))
await doc.getByText('link to the code').click()
await page.locator('span.font-mono[title="src/main.ts"]').waitFor({ timeout: 10000 })
check('a checkout link opens that file', true)

await open('site/index.html')
const frame = page.frameLocator('iframe[title="site/index.html"]')
await frame.getByRole('heading', { name: 'Generated report' }).waitFor({ timeout: 10000 })
check('the linked stylesheet applies', await frame.locator('h1').evaluate((el) => getComputedStyle(el).color) === 'rgb(163, 70, 26)')
check('its images are inlined', await frame.locator('img').evaluateAll((imgs) => imgs.length === 2 && imgs.every((i) => i.naturalWidth > 0)))
check('no script ran', await frame.getByText('SCRIPT RAN').count() === 0)
// getByText skips <noscript>, so measure its paragraph directly.
check('<noscript> shows', await frame.locator('body').evaluate(() => document.querySelector('noscript p')?.getBoundingClientRect().height > 0))
await page.screenshot({ path: path.join(SHOTS, 'preview-html.png') })
await frame.getByText('jump to end').click()
await page.waitForTimeout(300)
check('a heading link scrolls within the iframe', await frame.getByRole('heading', { name: 'The end' }).evaluate((el) => {
  const r = el.getBoundingClientRect()
  return r.top >= 0 && r.top < innerHeight
}))

await browser.close()
finish()
