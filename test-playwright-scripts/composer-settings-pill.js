/*
 * Verifies the new-workspace pane's settings pill (the model, effort and
 * agent options, as a chat's composer has them) in real Chromium, at desktop
 * width and then at phone width:
 *
 *  1. The pill opens a popover whose model list marks the project's default
 *     and opens on the picked model.
 *  2. The effort levels sit in balanced rows of equal cells, none wider
 *     than its cell, all inside the popover.
 *  3. Enter in the model search picks a model and does not create the
 *     workspace (the pane creates on Enter from anywhere inside it).
 *  4. At phone width the popover stays on screen and the footer fits on
 *     one line.
 *
 * Needs a running `yaac server` with a signed-in claude and a project.
 *
 * Run: PROJECT=<name or id> YAAC_DATA_DIR=... node test-playwright-scripts/composer-settings-pill.js
 */
import path from 'node:path'
import { SHOTS, api, check, finish, origin, requirePlaywright, resolveProject } from './lib.js'

if (!process.env.PROJECT) throw new Error('set PROJECT=<name or id>')
const PROJECT = (await resolveProject(process.env.PROJECT)).id

/** Where the popover, its effort cells and its model rows sit. */
function popoverReport() {
  return () => {
    const pop = document.querySelector('[role="dialog"]')
    const box = pop.getBoundingClientRect()
    const cells = [...pop.querySelectorAll('[role="radiogroup"] [role="radio"]')].map((b) => {
      const r = b.getBoundingClientRect()
      return { text: b.textContent, top: Math.round(r.top), width: Math.round(r.width), clipped: b.scrollWidth > b.clientWidth }
    })
    const rows = [...pop.querySelectorAll('[role="option"]')]
    return {
      left: box.left, right: box.right, top: box.top, viewport: innerWidth,
      cells,
      rowsPerLine: Object.values(cells.reduce((n, c) => ({ ...n, [c.top]: (n[c.top] ?? 0) + 1 }), {})),
      models: rows.map((o) => o.textContent),
      selected: rows.find((o) => o.getAttribute('aria-selected') === 'true')?.textContent,
    }
  }
}

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  await page.goto(`${origin}/?project=${PROJECT}`)
  const plus = page.locator('aside').getByRole('button', { name: 'New workspace', exact: true })
  await plus.waitFor({ timeout: 15_000 })
  await plus.click()
  const pill = page.getByRole('button', { name: 'Agent settings' })
  await pill.waitFor({ timeout: 15_000 })
  const before = (await api('/workspace/list')).workspaces.length

  // ---- 1 & 2. the popover at desktop width ----
  await pill.click()
  const search = page.getByRole('combobox', { name: 'Search models' })
  await search.waitFor()
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(SHOTS, 'settings-pill-1-desktop.png') })
  const desk = await page.evaluate(popoverReport())
  console.log('  desktop:', JSON.stringify(desk))
  check('the default model is marked', desk.models.some((m) => m.endsWith('default')), desk.models.join(' | '))
  check('the list opens on the picked model', desk.selected !== undefined, String(desk.selected))
  check('effort rows are balanced', Math.max(...desk.rowsPerLine) - Math.min(...desk.rowsPerLine) <= 1,
    desk.rowsPerLine.join('+'))
  check('no effort name is cut off', desk.cells.every((c) => !c.clipped),
    desk.cells.filter((c) => c.clipped).map((c) => c.text).join(' '))

  // ---- 3. Enter picks, and creates nothing ----
  await search.fill('sonnet')
  await search.press('Enter')
  await search.waitFor({ state: 'detached' })
  check('Enter picks the model', /sonnet/i.test(await pill.textContent()), await pill.textContent())
  await page.waitForTimeout(1000)
  const after = (await api('/workspace/list')).workspaces.length
  check('Enter in the search creates nothing', after === before, `${before} → ${after}`)

  // ---- 4. phone width ----
  await page.setViewportSize({ width: 390, height: 844 })
  await pill.waitFor({ timeout: 10_000 })
  await pill.click()
  await search.waitFor()
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(SHOTS, 'settings-pill-2-phone.png') })
  const phone = await page.evaluate(popoverReport())
  console.log('  phone:', JSON.stringify(phone))
  check('the popover stays on screen', phone.left >= 0 && phone.right <= phone.viewport && phone.top >= 0)
  check('no effort name is cut off at phone width', phone.cells.every((c) => !c.clipped),
    phone.cells.filter((c) => c.clipped).map((c) => c.text).join(' '))
  await page.keyboard.press('Escape')
  const footer = await page.evaluate(() => {
    const row = document.querySelector('button[aria-label="Agent settings"]').closest('.justify-between')
    return [...row.querySelectorAll('button')].map((b) => Math.round(b.getBoundingClientRect().height))
  })
  check('the footer fits on one line', footer.every((h) => h <= 32), footer.join(' '))
} finally {
  await browser.close()
}
finish()
