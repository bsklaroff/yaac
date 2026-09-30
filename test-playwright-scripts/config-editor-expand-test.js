/*
 * Verifies the expand button on the settings file editors (FileEditor),
 * using Settings → Project Config's yaac-config.json. Expanding opens a
 * near-fullscreen overlay (inset 16px) where the editor fills the height with
 * Save below; Escape closes only the overlay, keeping the settings dialog and
 * the unsaved edit. Nothing is saved. SCREENSHOT_DIR gets
 * config-editor-expanded.png.
 *
 * Needs a running `yaac server` with a project added (see lib.js).
 *
 * Run: YAAC_DATA_DIR=... node test-playwright-scripts/config-editor-expand-test.js
 */
import path from 'node:path'
import { requirePlaywright, origin, until, check, finish, SHOTS } from './lib.js'

const { chromium } = requirePlaywright()
const viewport = { width: 1400, height: 900 }
const browser = await chromium.launch()
const page = await browser.newPage({ viewport })
page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))
await page.goto(`${origin}/`)
await page.getByRole('button', { name: 'Settings' }).click()
await page.getByRole('button', { name: 'Project Config' }).click()
await page.locator('.cm-editor').first().waitFor()

await page.getByLabel('Expand editor').first().click()
const pop = page.getByRole('dialog').filter({ has: page.getByLabel('Collapse editor') })
await pop.waitFor()
// Wait out the open transition, which starts from scale-95.
await until(page, function openTransitionDone() {
  const el = document.querySelector('[role="dialog"]:has([aria-label="Collapse editor"])')
  return el && !el.hasAttribute('data-starting-style') && el.getAnimations().length === 0
})
const box = await pop.boundingBox()
check('the overlay is near-fullscreen',
  Math.abs(box.x - 16) <= 2 && Math.abs(box.y - 16) <= 2
  && Math.abs(box.width - (viewport.width - 32)) <= 4 && Math.abs(box.height - (viewport.height - 32)) <= 4,
  `${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)}`)
const editorBox = await pop.locator('.cm-editor').boundingBox()
check('the editor fills most of the overlay height', editorBox.height > box.height * 0.7,
  `${Math.round(editorBox.height)}px of ${Math.round(box.height)}px`)
const save = pop.getByRole('button', { name: /^(Save|Saving…)$/ })
const saveBox = await save.boundingBox()
check('Save sits below the editor', saveBox !== null && saveBox.y > editorBox.y + editorBox.height)
check('the overlay is titled with the config file', await pop.getByText('yaac-config.json').count() === 1)
check('Save starts disabled', await save.isDisabled())

await pop.locator('.cm-content').click()
await page.keyboard.press('End')
await page.keyboard.type(' ')
check('an edit in the overlay enables Save', await save.isEnabled())
await page.screenshot({ path: path.join(SHOTS, 'config-editor-expanded.png') })

await page.keyboard.press('Escape')
await pop.waitFor({ state: 'hidden' })
check('the settings dialog stays open', await page.getByRole('button', { name: 'Project Config' }).isVisible())
check('the edit survives collapsing', await page.getByRole('button', { name: 'Save' }).first().isEnabled())

await browser.close()
finish()
