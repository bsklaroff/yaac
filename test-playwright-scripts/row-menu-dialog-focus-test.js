/*
 * Verifies that a dialog opened from a sidebar row's `…` menu does not
 * return focus to that hover-only trigger when opened by pointer, which
 * would leave the `…` visible after the pointer leaves:
 *
 *  1. A draft's `…` > Open… (the same RowMenu -> create-dialog path as a
 *     workspace's "Queue workspace after this…"), closed by Escape and by ×,
 *     leaves the trigger unfocused and hidden once the pointer moves away.
 *  2. Its `…` > Discard… > Cancel (ConfirmDialog) does the same, including
 *     when Discard… is picked by press-drag-release.
 *  3. By keyboard through the row menu, Open… and Discard… return focus to
 *     the `…` trigger on Escape, visibly.
 *  4. A dialog from an ordinary menu item (the project header's Remove
 *     project) returns focus to that menu's trigger, by mouse and keyboard.
 *
 * Saves one draft and discards it at the end, with any "pw focus …" drafts
 * an earlier failed run left behind.
 *
 * Needs a running server with a project.
 * Run: YAAC_DATA_DIR=<data dir> node test-playwright-scripts/row-menu-dialog-focus-test.js
 * (PROJECT defaults to yaac)
 */
import { requirePlaywright, origin, check, finish } from './lib.js'

const PROJECT = process.env.PROJECT ?? 'yaac'
const idea = `pw focus ${Date.now()}`

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  await page.goto(`${origin}/?project=${PROJECT}`)

  const aside = page.locator('aside')
  const prompt = page.getByLabel('Prompt')
  const question = page.getByRole('alertdialog')
  const newButton = aside.getByRole('button', { name: 'New workspace', exact: true })
  await newButton.waitFor({ timeout: 15_000 })

  // Save a draft to hang the row menu off.
  await newButton.click()
  await prompt.waitFor({ state: 'visible' })
  await page.keyboard.type(idea)
  await page.keyboard.press('Escape')
  await question.getByRole('button', { name: 'Save draft' }).click()
  await prompt.waitFor({ state: 'detached' })

  const row = aside.getByRole('group', { name: 'Drafts' }).locator('div.group.relative', { hasText: idea })
  await row.waitFor({ timeout: 10_000 })
  const trigger = row.getByRole('button', { name: 'Draft actions' })
  const pick = async (item) => {
    await row.hover()
    await trigger.click()
    await page.getByRole('menuitem', { name: item }).click()
  }
  const settle = async () => {
    await page.mouse.move(1000, 450)
    await page.waitForTimeout(400)
  }
  const triggerState = () => trigger.evaluate((el) => ({
    focused: el === document.activeElement,
    opacity: getComputedStyle(el).opacity,
  }))
  const expectHidden = async (name) => {
    const s = await triggerState()
    check(name, !s.focused && s.opacity === '0', JSON.stringify(s))
  }

  // A reopened draft may ask to save on close (the form fills in
  // asynchronously); answer it if so.
  const dismiss = async (close) => {
    await close()
    const asked = await Promise.race([
      prompt.waitFor({ state: 'detached' }).then(() => false),
      question.waitFor({ state: 'visible' }).then(() => true),
    ])
    if (asked) {
      // By keyboard, to keep :focus-visible behavior consistent.
      await question.getByRole('button', { name: 'Discard changes' }).focus()
      await page.keyboard.press('Enter')
      await prompt.waitFor({ state: 'detached' })
    }
  }

  // (1) Open… then Escape, and Open… then ×.
  await pick('Open…')
  await prompt.waitFor({ state: 'visible' })
  await page.waitForTimeout(300)
  await dismiss(() => page.keyboard.press('Escape'))
  await settle()
  await expectHidden('Open… + Escape leaves the … trigger unfocused and hidden')

  await pick('Open…')
  await prompt.waitFor({ state: 'visible' })
  await page.waitForTimeout(300)
  await dismiss(() => page.getByRole('button', { name: 'Close' }).click())
  await settle()
  await expectHidden('Open… + × leaves the … trigger unfocused and hidden')

  // (2) Discard… then Cancel.
  await pick('Discard…')
  await question.waitFor({ state: 'visible' })
  await page.waitForTimeout(300)
  await question.getByRole('button', { name: 'Cancel' }).click()
  await question.waitFor({ state: 'detached' })
  await settle()
  await expectHidden('Discard… + Cancel leaves the … trigger unfocused and hidden')

  await row.hover()
  const box = await trigger.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  const discard = page.getByRole('menuitem', { name: 'Discard…' })
  await discard.waitFor({ state: 'visible' })
  await page.waitForTimeout(300)
  const itemBox = await discard.boundingBox()
  await page.mouse.move(itemBox.x + itemBox.width / 2, itemBox.y + itemBox.height / 2, { steps: 5 })
  await page.mouse.up()
  await question.waitFor({ state: 'visible' })
  await page.waitForTimeout(300)
  await page.keyboard.press('Escape')
  await question.waitFor({ state: 'detached' })
  await settle()
  await expectHidden('drag-release Discard… + Escape leaves the … trigger unfocused and hidden')

  // (3) Keyboard through the row menu.
  const byKey = async (item) => {
    await trigger.focus()
    await page.keyboard.press('Enter')
    const target = page.getByRole('menuitem', { name: item })
    await target.waitFor({ state: 'visible' })
    for (let i = 0; i < 5 && !(await target.evaluate((el) => el.hasAttribute('data-highlighted'))); i++) {
      await page.keyboard.press('ArrowDown')
    }
    await page.keyboard.press('Enter')
  }
  const expectFocusedVisible = async (name) => {
    await page.waitForTimeout(400)
    const s = await triggerState()
    check(name, s.focused && Number(s.opacity) > 0.5, JSON.stringify(s))
  }
  await byKey('Open…')
  await prompt.waitFor({ state: 'visible' })
  await page.waitForTimeout(300)
  await dismiss(() => page.keyboard.press('Escape'))
  await expectFocusedVisible('keyboard Open… + Escape returns focus to the … trigger')

  await byKey('Discard…')
  await question.waitFor({ state: 'visible' })
  await page.waitForTimeout(300)
  await page.keyboard.press('Escape')
  await question.waitFor({ state: 'detached' })
  await expectFocusedVisible('keyboard Discard… + Escape returns focus to the … trigger')

  // (4) An ordinary menu: the project header's Remove project.
  const projectMenu = aside.getByRole('button', { name: PROJECT, exact: true })
  const removeDialog = page.getByRole('alertdialog', { name: 'Remove project?' })
  const escapeRemove = async (name) => {
    await removeDialog.waitFor({ state: 'visible' })
    await page.waitForTimeout(300)
    await page.keyboard.press('Escape')
    await removeDialog.waitFor({ state: 'detached' })
    await page.waitForTimeout(400)
    check(name, await projectMenu.evaluate((el) => el === document.activeElement))
  }
  await projectMenu.click()
  await page.getByRole('menuitem', { name: 'Remove project' }).click()
  await escapeRemove('Remove project by mouse returns focus to the project menu')
  await projectMenu.focus()
  await page.keyboard.press('Enter')
  await page.getByRole('menuitem', { name: 'Remove project' }).waitFor({ state: 'visible' })
  await page.keyboard.press('Enter')
  await escapeRemove('Remove project by keyboard returns focus to the project menu')

  // Clean up: this run's draft, and any a failed run left behind.
  const leftovers = aside.getByRole('group', { name: 'Drafts' })
    .locator('div.group.relative', { hasText: 'pw focus ' })
  while (await leftovers.count() > 0) {
    const left = leftovers.first()
    await left.hover()
    await left.getByRole('button', { name: 'Draft actions' }).click()
    await page.getByRole('menuitem', { name: 'Discard…' }).click()
    await question.getByRole('button', { name: 'Discard' }).click()
    await question.waitFor({ state: 'detached' })
    await page.waitForTimeout(500)
  }
} finally {
  await browser.close()
}
finish()
