/*
 * Verifies the create-workspace dialog in a real browser, with real mouse,
 * keyboard and touch events, for what jsdom cannot show (layout, focus rings,
 * keystroke timing, touch):
 *
 *  1. Alt+N opens a centered dialog with the prompt focused and Start on
 *     "Now"; Esc closes it.
 *  2. Keys typed the instant the dialog appears all reach the prompt (20
 *     opens).
 *  3. Closing a dialog opened from the sidebar's + (by click or keyboard;
 *     closed by Esc, the ×, or the backdrop) leaves no focus or focus ring on
 *     the +.
 *  4. The heading's pencil opens a title editor whose Enter commits the title
 *     without submitting; "+ New group" swaps in a focused name box whose Esc
 *     returns to the dropdown and leaves the dialog open.
 *  5. For every signed-in agent, no model suggestion's name is clipped.
 *  6. On a phone viewport, tapping a branch suggestion picks it.
 *  7. Keyboard only: Shift+Enter is a newline, Enter in the Model search
 *     picks the highlighted model, Enter again creates. The sidebar's
 *     provisioning row names the model from its first frame, and the new
 *     workspace carries the prompt.
 *
 * Needs a claude credential (`yaac auth fake claude-oauth` will do). Creates
 * one workspace (check 7) and stops it at the end.
 *
 * Run: YAAC_DATA_DIR=<data dir> PROJECT=<slug> node test-playwright-scripts/create-dialog-test.js
 */
import { execSync } from 'node:child_process'
import path from 'node:path'
import { api, check, finish, origin, requirePlaywright, SHOTS, until } from './lib.js'

const PROJECT = process.env.PROJECT
if (!PROJECT) throw new Error('set PROJECT=<slug>')
const tools = (await api('/auth/list')).toolAuth.map((t) => t.tool)
if (!tools.includes('claude')) throw new Error('needs a claude credential')

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
let createdId = null
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  await page.goto(`${origin}/?project=${PROJECT}`)
  const plus = page.locator('aside').getByRole('button', { name: 'New workspace', exact: true })
  const dialog = page.getByRole('dialog')
  const prompt = page.getByLabel('Prompt')
  const create = page.getByRole('button', { name: 'Create', exact: true })
  await plus.waitFor({ timeout: 15_000 })
  const isFocused = (loc) => loc.evaluate((el) => el === document.activeElement)
  const openByKey = async () => {
    await page.keyboard.press('Alt+KeyN')
    await prompt.waitFor({ state: 'visible' })
  }
  // Esc, discarding whatever was typed rather than saving a draft.
  const escape = async () => {
    await page.keyboard.press('Escape')
    const ask = page.getByRole('alertdialog')
    if (await ask.waitFor({ timeout: 500 }).then(() => true, () => false)) {
      await ask.getByRole('button', { name: 'Discard' }).click()
    }
    await prompt.waitFor({ state: 'detached' })
  }

  // (1) Alt+N.
  await openByKey()
  check('Alt+N focuses the prompt', await isFocused(prompt))
  check('Start defaults to Now', await page.getByLabel('Start').inputValue() === '')
  const box = await dialog.boundingBox()
  check('the dialog is centered', box !== null && Math.abs(box.x + box.width / 2 - 700) < 4,
    box ? `center x ${box.x + box.width / 2}` : 'no box')
  await page.screenshot({ path: path.join(SHOTS, 'create-dialog.png') })
  await escape()
  check('Esc closes the dialog', true)

  // (2) Keys typed before focus has visibly landed.
  let lost = 0
  for (let i = 0; i < 20; i++) {
    await openByKey()
    await page.keyboard.type('abcdefghij')
    if ((await prompt.inputValue()) !== 'abcdefghij') lost++
    await escape()
  }
  check('keys typed as the dialog appears all reach the prompt', lost === 0, `${lost}/20 opens lost keys`)

  // (3) No focus ring left on the +.
  const openers = {
    click: () => plus.click(),
    keyboard: async () => { await plus.focus(); await page.keyboard.press('Enter') },
  }
  const closers = {
    Escape: () => page.keyboard.press('Escape'),
    '×': () => dialog.getByRole('button', { name: 'Close' }).click(),
    backdrop: () => page.mouse.click(10, 450),
  }
  for (const [how, openIt] of Object.entries(openers)) {
    for (const [by, closeIt] of Object.entries(closers)) {
      await openIt()
      await prompt.waitFor({ state: 'visible' })
      await page.waitForTimeout(250)
      await closeIt()
      await dialog.waitFor({ state: 'detached' })
      await page.waitForTimeout(250)
      const s = await plus.evaluate((el) => ({
        focused: document.activeElement === el, ring: el.matches(':focus-visible'),
      }))
      check(`opened by ${how}, closed by ${by}: no focus or ring on the +`, !s.focused && !s.ring, JSON.stringify(s))
    }
  }

  // (4) Title and group.
  await openByKey()
  const heading = dialog.getByRole('heading')
  check('heading starts as "New workspace"', await heading.textContent() === 'New workspace')
  await dialog.getByRole('button', { name: 'Rename workspace' }).click()
  check('the pencil focuses the title editor', await isFocused(dialog.getByLabel('Workspace title')))
  await page.keyboard.type('Fix the build')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(200)
  check('Enter commits the title to the heading', await heading.textContent() === 'Fix the build')
  check('…and leaves the dialog open', await dialog.isVisible())
  await dialog.getByLabel('Group').selectOption({ label: '+ New group' })
  const nameBox = dialog.getByLabel('New group name')
  // Typing before the box has focus would lose the name, and Esc would close the dialog.
  await until(page, () => document.activeElement?.getAttribute('aria-label') === 'New group name', null, 2000)
  check('"+ New group" focuses a name box', await nameBox.isVisible())
  await page.keyboard.type('Release prep')
  await page.keyboard.press('Escape')
  check('Esc in the name box goes back to the dropdown',
    await dialog.locator('select[aria-label="Group"]').waitFor({ timeout: 2000 }).then(() => true, () => false))
  check('…and leaves the dialog open', await dialog.isVisible())
  await escape()

  // (5) Model names in full.
  for (const tool of tools) {
    await plus.click()
    await page.getByLabel('Agent').selectOption(tool)
    // A letter common enough to fill the list.
    await page.getByLabel('Model').fill('a')
    const rows = dialog.locator('li button')
    await rows.first().waitFor({ state: 'visible' })
    const clipped = await rows.evaluateAll((buttons) => buttons
      .map((b) => b.querySelector(':scope > span'))
      .filter((name) => name.scrollWidth > name.clientWidth || name.getBoundingClientRect().height > 20)
      .map((name) => name.textContent))
    await page.screenshot({ path: path.join(SHOTS, `model-typeahead-${tool}.png`) })
    check(`${tool}: every model name shows in full on one line`, clipped.length === 0, clipped.join(', '))
    // The first Escape closes only the suggestion list.
    await page.keyboard.press('Escape')
    await escape()
  }

  // (6) Phone: tap a branch suggestion.
  const { defaultBranch } = await api(`/project/${PROJECT}/branches`)
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  const mpage = await phone.newPage()
  await mpage.goto(`${origin}/?project=${PROJECT}`)
  await mpage.getByTitle('New workspace').first().tap({ timeout: 15_000 })
  const mbranch = mpage.getByLabel('Base branch', { exact: true })
  await mpage.getByRole('button', { name: 'Create', exact: true }).and(mpage.locator(':enabled')).waitFor({ timeout: 15_000 })
  await mbranch.tap()
  await mbranch.fill(defaultBranch.slice(0, 3))
  await mpage.locator('ul li', { hasText: defaultBranch }).first().tap()
  check('phone: a tapped branch suggestion is picked', (await mbranch.inputValue()) === defaultBranch,
    await mbranch.inputValue())
  await mpage.screenshot({ path: path.join(SHOTS, 'branch-typeahead-phone.png') })
  await phone.close()

  // (7) Keyboard-only create.
  const known = new Set((await api(`/workspace/list?project=${PROJECT}`)).workspaces.map((w) => w.workspaceId))
  await openByKey()
  await page.getByLabel('Agent').selectOption('claude')
  await create.and(page.locator(':enabled')).waitFor({ timeout: 15_000 })
  await prompt.focus()
  const ask = `playwright create ${Date.now()}`
  await page.keyboard.type(ask)
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('second line')
  check('Shift+Enter inserts a newline', (await prompt.inputValue()) === `${ask}\nsecond line`)
  await page.getByLabel('Model').click()
  await page.keyboard.press('Control+a')
  await page.keyboard.type('sonnet 5')
  await page.keyboard.press('Enter')
  check('Enter picks the highlighted model', await page.getByLabel('Model').inputValue() === 'Sonnet 5',
    await page.getByLabel('Model').inputValue())
  await page.keyboard.press('Enter')
  await prompt.waitFor({ state: 'detached' })
  const named = await until(page, () => [...document.querySelectorAll('aside span')]
    .some((s) => s.textContent.trim() === 'Claude · Sonnet 5'), null, 3000).then(() => true, () => false)
  check('the provisioning row names the model from its first frame', named)
  await page.screenshot({ path: path.join(SHOTS, 'create-dialog-provisioning.png') })
  for (let i = 0; i < 60 && createdId === null; i++) {
    const fresh = (await api(`/workspace/list?project=${PROJECT}`)).workspaces.find((w) => !known.has(w.workspaceId))
    if (fresh) createdId = fresh.workspaceId
    else await page.waitForTimeout(1000)
  }
  // Stopping mid-provision would fail the create; wait for its row to settle.
  await until(page, () => ![...document.querySelectorAll('aside span')].some((s) => s.textContent === 'New workspace'),
    null, 120_000)
  const created = (await api(`/workspace/list?project=${PROJECT}`)).workspaces.find((w) => w.workspaceId === createdId)
  check('the new workspace carries the prompt', created?.prompt === `${ask}\nsecond line`, created?.prompt ?? 'none')
} finally {
  await browser.close()
  if (createdId !== null) execSync(`yaac workspace stop ${createdId}`, { stdio: 'ignore' })
}
finish()
