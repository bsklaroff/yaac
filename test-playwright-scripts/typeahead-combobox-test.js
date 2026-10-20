/*
 * Verifies, in a real browser, the typeaheads built on Base UI's Combobox
 * (`Typeahead` in packages/frontend/src/components/ui/Typeahead.tsx):
 *
 *  1. New-workspace pane, Base branch: typing opens the list with the
 *     first match highlighted; ↑/↓ move the highlight; Escape closes only
 *     the list and reverts the text; Enter picks; a hovered row takes the
 *     highlight and a click picks it; text matching nothing says "No
 *     matches" and Enter neither picks nor creates; Tab moves on to the
 *     next field and closes the list; aria-expanded follows the list.
 *  2. Model: typing a name and Enter picks that model.
 *  3. Settings → Credentials, opencode's provider picker (opencode is
 *     shown signed out by rewriting /auth/list): a capped list with a
 *     "+N more" hint; ↓ keeps the highlighted row scrolled into view;
 *     typing filters and ↓ Enter picks, which retitles the key box and tags
 *     the row "selected"; a click picks too.
 *
 * Nothing is created or saved: create and auth writes are answered locally.
 *
 * Run: APP_URL=<server or vite dev origin> PROJECT=<name or id> \
 *        node test-playwright-scripts/typeahead-combobox-test.js
 */
import path from 'node:path'
import { api, check, finish, origin, requirePlaywright, SHOTS, resolveProject, until } from './lib.js'

if (!process.env.PROJECT) throw new Error('set PROJECT=<name or id>')
const PROJECT = (await resolveProject(process.env.PROJECT)).id
const { branches } = await api(`/project/${PROJECT}/branches`)

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  let creates = 0
  await page.route('**/api/workspace/create', (r) => { creates++; return r.fulfill({ status: 500, body: '{}' }) })
  await page.route('**/api/auth/opencode', (r) => r.fulfill({ status: 500, body: '{}' }))
  await page.route('**/api/auth/list', async (r) => {
    const res = await r.fetch()
    const body = await res.json()
    body.toolAuth = body.toolAuth.filter((t) => t.tool !== 'opencode')
    return r.fulfill({ response: res, json: body })
  })
  await page.goto(`${origin}/?project=${PROJECT}`)

  const pane = page.locator('main')
  await page.locator('aside').getByRole('button', { name: 'New workspace', exact: true }).click()
  // Ready once the branch list has filled the field.
  await until(page, () => document.querySelector('input[aria-label="Base branch"]')?.value !== '', undefined, 15_000)

  // (1) Base branch.
  const branch = pane.getByLabel('Base branch', { exact: true })
  const chosen = await branch.inputValue()
  const list = page.getByRole('listbox')
  const highlighted = () => list.locator('[role="option"][data-highlighted]').innerText().catch(() => null)
  const label = (text) => text?.split('\n')[0] ?? null
  await branch.click()
  await branch.press('Control+a')
  const prefix = 're'
  await page.keyboard.type(prefix)
  await list.waitFor({ timeout: 3000 })
  const rows = await list.getByRole('option').allInnerTexts()
  const firstMatch = label(rows[0])
  check('typing opens the list with the first match highlighted', label(await highlighted()) === firstMatch,
    `${label(await highlighted())} vs ${firstMatch}`)
  check('aria-expanded is true while the list shows', await branch.getAttribute('aria-expanded') === 'true')
  if (rows.length > 1) {
    await page.keyboard.press('ArrowDown')
    check('↓ moves the highlight', label(await highlighted()) === label(rows[1]), String(await highlighted()))
    await page.keyboard.press('ArrowUp')
    check('↑ moves it back', label(await highlighted()) === firstMatch, String(await highlighted()))
  }
  await page.screenshot({ path: path.join(SHOTS, 'typeahead-branch-open.png') })
  await page.keyboard.press('Escape')
  check('Escape closes the list', await list.count() === 0)
  check('…keeps the pane\'s form', await branch.isVisible())
  check('…and reverts the text to the chosen branch', await branch.inputValue() === chosen, await branch.inputValue())
  check('aria-expanded is false with the list closed', await branch.getAttribute('aria-expanded') === 'false')

  await branch.press('Control+a')
  await page.keyboard.type(prefix)
  await page.keyboard.press('Enter')
  check('Enter picks the highlighted branch', await branch.inputValue() === firstMatch, await branch.inputValue())
  check('…closes the list and the form stays', await list.count() === 0 && await branch.isVisible())

  await branch.press('Control+a')
  await page.keyboard.type(prefix)
  const second = list.getByRole('option').nth(1)
  if (await second.count()) {
    const want = label(await second.innerText())
    await second.hover()
    check('hovering a row highlights it', label(await highlighted()) === want, String(await highlighted()))
    await second.click()
    check('clicking a row picks it', await branch.inputValue() === want, await branch.inputValue())
    check('…and focus stays in the input', await branch.evaluate((el) => el === document.activeElement))
  }

  await branch.press('Control+a')
  await page.keyboard.type('zz-no-such-branch')
  check('text matching nothing says "No matches"', await page.getByText('No matches').isVisible())
  const before = await branch.inputValue()
  await page.keyboard.press('Enter')
  await page.waitForTimeout(300)
  check('…and Enter neither picks nor creates', creates === 0 && await branch.inputValue() === before,
    `creates ${creates}, value ${await branch.inputValue()}`)

  await page.keyboard.press('Escape')
  await page.keyboard.type(prefix)
  await page.keyboard.press('Tab')
  const next = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))
  check('Tab moves on to the next field and closes the list', next !== 'Base branch' && await list.count() === 0,
    String(next))

  // (2) Model.
  const model = pane.getByLabel('Model', { exact: true })
  if (await model.count()) {
    await model.click()
    await model.press('Control+a')
    await page.keyboard.type('sonnet')
    const want = label(await page.getByRole('listbox').getByRole('option').first().innerText())
    await page.keyboard.press('Enter')
    check('Model: typing and Enter picks the top match', await model.inputValue() === want,
      `${await model.inputValue()} vs ${want}`)
  }

  // (3) Provider picker.
  await page.getByTitle('Settings').first().click()
  await page.getByRole('button', { name: 'Credentials' }).click()
  const row = page.locator('div.rounded-md', { has: page.getByText(/^opencode/) }).first()
  await row.getByRole('button', { name: 'Sign in' }).click()
  const search = page.getByPlaceholder('Search providers…')
  const plist = page.getByRole('listbox')
  await plist.waitFor({ timeout: 3000 })
  const shown = await plist.getByRole('option').count()
  check('the provider list is capped with a "+N more" hint', shown === 50 && await page.getByText(/more — keep typing/).isVisible(),
    `${shown} rows`)
  await search.click()
  for (let i = 0; i < 25; i++) await page.keyboard.press('ArrowDown')
  const inView = await plist.evaluate((ul) => {
    const hl = ul.querySelector('[data-highlighted]')
    if (!hl) return false
    const a = ul.getBoundingClientRect()
    const b = hl.getBoundingClientRect()
    return b.top >= a.top - 1 && b.bottom <= a.bottom + 1
  })
  check('↓ keeps the highlighted provider scrolled into view', inView)
  await page.screenshot({ path: path.join(SHOTS, 'typeahead-provider-scrolled.png') })

  await search.press('Control+a')
  await page.keyboard.type('anthropic')
  const top = label(await plist.getByRole('option').first().innerText())
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  check('typing filters, and ↓ Enter picks the provider', await page.getByPlaceholder(`${top} API key`).isVisible(), top)
  const tagged = await plist.getByRole('option').filter({ hasText: 'selected' }).allInnerTexts()
  check('…and its row is tagged "selected"', tagged.length === 1 && label(tagged[0]) === top, tagged.join(' | '))

  await search.press('Control+a')
  await page.keyboard.type('open')
  const opt = plist.getByRole('option').first()
  const clicked = label(await opt.innerText())
  await opt.click()
  check('clicking a provider picks it', await page.getByPlaceholder(`${clicked} API key`).isVisible(), clicked)
  await page.screenshot({ path: path.join(SHOTS, 'typeahead-provider-picked.png') })
} finally {
  await browser.close()
}
finish()
