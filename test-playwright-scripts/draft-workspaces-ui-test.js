/*
 * Verifies draft workspaces (docs/draft-workspaces.md) in a real browser, with
 * real pointer and keyboard events, through the new-workspace pane:
 *
 *  1. With no drafts the sidebar has no Drafts section.
 *  2. The pane's Save draft puts the prompt in a collapsible Drafts section at
 *     the top of the sidebar and clears the form; collapsing hides its rows.
 *  3. Leaving the pane with a prompt typed (here, by opening the draft) asks
 *     Save / Discard / Keep editing, with Save focused; Escape on the
 *     question keeps the form and its prompt, and Discard saves nothing and
 *     goes on to the draft.
 *  4. The reopened draft shows its prompt and permission mode; the + leaves
 *     it unchanged for a blank form without asking.
 *  5. An edited draft asks to save its changes on the +; saving updates the
 *     row in place (still one draft).
 *  6. The row's Discard… deletes the draft, and the section disappears.
 *
 * Creates no workspace. Drafts it saves are discarded by the end; if a check
 * fails midway, discard leftovers from the sidebar.
 *
 * Run: YAAC_DATA_DIR=<data dir> PROJECT=<name or id> node test-playwright-scripts/draft-workspaces-ui-test.js
 */
import path from 'node:path'
import { check, finish, origin, requirePlaywright, SHOTS, resolveProject, until } from './lib.js'

if (!process.env.PROJECT) throw new Error('set PROJECT=<name or id>')
const PROJECT = (await resolveProject(process.env.PROJECT)).id
const stamp = Date.now()
const idea = `pw draft ${stamp}`

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  await page.goto(`${origin}/?project=${PROJECT}`)

  const aside = page.locator('aside')
  const drafts = aside.getByRole('group', { name: 'Drafts' })
  const prompt = page.getByLabel('Prompt')
  const question = page.getByRole('alertdialog')
  const plus = aside.getByRole('button', { name: 'New workspace', exact: true })
  const promptIs = (text) => until(page, (t) => document.querySelector('textarea[aria-label="Prompt"]')?.value === t, text)
  const posture = () => page.getByRole('button', { name: 'Permission mode' }).textContent()
  await plus.waitFor({ timeout: 15_000 })
  await plus.click()
  // Settings load with the credential list.
  await page.getByRole('button', { name: 'Permission mode' }).waitFor({ timeout: 15_000 })

  // (1) Nothing to show.
  check('no Drafts section without drafts', await drafts.count() === 0)

  // (2) Save it from the pane.
  await prompt.fill(idea)
  await page.getByRole('button', { name: 'Permission mode' }).click()
  await page.getByRole('menuitemradio').filter({ hasText: 'Plan mode' }).click()
  await page.locator('main').getByRole('button', { name: 'Save draft' }).click()
  await drafts.waitFor({ state: 'visible', timeout: 10_000 })
  await promptIs('')
  check('the draft shows in a Drafts section, and the form clears', (await drafts.textContent())?.includes(idea) === true)
  check('the section leads the list', await drafts.evaluate((el) => el.previousElementSibling === null))
  await page.screenshot({ path: path.join(SHOTS, 'drafts-section.png') })
  await drafts.getByRole('button', { name: /Drafts/ }).click()
  check('collapsing hides the rows', !(await drafts.getByText(idea).isVisible()))
  await drafts.getByRole('button', { name: /Drafts/ }).click()

  // (3) A typed prompt asks before leaving; Escape stays, Discard goes on.
  await prompt.fill(`${idea} throwaway`)
  await drafts.getByText(idea).click()
  await question.waitFor({ state: 'visible' })
  check('a typed prompt asks before leaving', (await question.textContent())?.includes('Save as a draft?') === true)
  // Let the scale-in animation finish.
  await page.waitForTimeout(300)
  check('Save draft has focus',
    await question.getByRole('button', { name: 'Save draft' }).evaluate((el) => el === document.activeElement))
  await page.screenshot({ path: path.join(SHOTS, 'draft-question.png') })
  await page.keyboard.press('Escape')
  await question.waitFor({ state: 'detached' })
  check('Escape on the question keeps the form and its prompt', await prompt.inputValue() === `${idea} throwaway`)
  await drafts.getByText(idea).click()
  await question.getByRole('button', { name: 'Discard' }).click()
  await promptIs(idea)
  await page.waitForTimeout(500)
  check('Discard saves nothing and goes on', await drafts.getByText(`${idea} throwaway`).count() === 0)

  // (4) The reopened draft, left unchanged.
  check('reopens on its prompt', await prompt.inputValue() === idea)
  check('and its permission mode', await posture() === 'Plan mode', String(await posture()))
  await plus.click()
  await promptIs('')
  check('the + leaves an unchanged draft without asking', await question.count() === 0)

  // (5) Edit and save changes on the +.
  await drafts.getByText(idea).click()
  await promptIs(idea)
  await prompt.fill(`${idea} edited`)
  await plus.click()
  await question.waitFor({ state: 'visible' })
  check('an edited draft asks to save changes',
    (await question.textContent())?.includes('Save changes to this draft?') === true)
  await question.getByRole('button', { name: 'Save changes' }).click()
  await promptIs('')
  await drafts.getByText(`${idea} edited`).waitFor({ timeout: 10_000 })
  check('the row updates in place, still one draft', await drafts.getByText(idea).count() === 1)

  // (6) Discard the draft from its row.
  const row = drafts.locator('div.group.relative', { hasText: idea })
  await row.hover()
  await row.getByRole('button', { name: 'Draft actions' }).click()
  await page.getByRole('menuitem', { name: 'Discard…' }).click()
  await question.getByRole('button', { name: 'Discard' }).click()
  const gone = await drafts.waitFor({ state: 'detached', timeout: 10_000 }).then(() => true, () => false)
  check('discarding the last draft removes the section', gone)
} finally {
  await browser.close()
}
finish()
