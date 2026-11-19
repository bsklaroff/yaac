/*
 * Verifies that the new-workspace pane's prompt keeps its height across a
 * trip to the Workflow tab. A multi-line prompt is typed on the Agent tab,
 * the pane switches to Workflow (which unmounts the composer) and back; the
 * prompt box must come back as tall as it was, not one line tall.
 *
 * Needs a running `yaac server` with a project. Creates nothing.
 *
 * Run: YAAC_DATA_DIR=... PROJECT=<name or id> node test-playwright-scripts/new-workspace-prompt-refit.js
 */
import path from 'node:path'
import { SHOTS, check, finish, origin, requirePlaywright, resolveProject } from './lib.js'

const { chromium } = requirePlaywright()
const project = await resolveProject(process.env.PROJECT ?? 'yaac')
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  await page.goto(`${origin}/?project=${project.id}`)
  const box = page.getByLabel('Prompt')
  await box.waitFor()
  await box.click()
  for (const line of ['first line', 'second line', 'third line', 'fourth line']) {
    await page.keyboard.type(line)
    await page.keyboard.press('Shift+Enter')
  }
  await page.waitForTimeout(300)
  const before = (await box.boundingBox()).height
  check('the prompt grows to fit four lines', before > 60, `${before}px`)

  const tabs = page.getByRole('tablist', { name: 'What to start' })
  await tabs.getByRole('tab', { name: 'Workflow' }).click()
  await page.waitForTimeout(300)
  await tabs.getByRole('tab', { name: 'Agent' }).click()
  await box.waitFor()
  await page.waitForTimeout(300)
  const after = (await box.boundingBox()).height
  await page.screenshot({ path: path.join(SHOTS, 'new-workspace-prompt-refit.png') })
  check('the prompt keeps its height after the Workflow tab', Math.abs(after - before) < 2, `${before}px → ${after}px`)
  await box.fill('')
} finally {
  await browser.close()
}
finish()
