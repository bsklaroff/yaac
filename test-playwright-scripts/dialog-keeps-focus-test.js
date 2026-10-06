/*
 * Verifies, in a real browser with real keyboard events, how a workspace
 * coming up under the New-workspace dialog treats the dialog's focus, and
 * where focus lands once a create from the dialog finishes:
 *
 *  1. Chat under the dialog: create a Chat workspace, reopen the dialog at
 *     once and type into its prompt while the new workspace provisions and
 *     its chat pane appears. Every key stays in the dialog's prompt.
 *  2. Composer after create: create a Chat workspace from the dialog and wait
 *     for its pane. The composer holds focus.
 *  3. Terminal under the dialog: as 1, with a Terminal workspace.
 *
 * Needs a claude credential and a project on a containerless server. Creates
 * three workspaces and stops them at the end.
 *
 * Run: YAAC_DATA_DIR=<data dir> PROJECT=<name or id> node test-playwright-scripts/dialog-keeps-focus-test.js
 */
import { api, check, finish, origin, requirePlaywright, resolveProject } from './lib.js'

if (!process.env.PROJECT) throw new Error('set PROJECT=<name or id>')
const PROJECT = (await resolveProject(process.env.PROJECT)).id

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
const known = new Set((await api(`/workspace/list?project=${PROJECT}`)).workspaces.map((w) => w.workspaceId))
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  await page.goto(`${origin}/?project=${PROJECT}`)
  await page.locator('aside').getByRole('button', { name: 'New workspace', exact: true }).waitFor({ timeout: 15_000 })
  const prompt = page.getByLabel('Prompt')
  const create = page.getByRole('button', { name: 'Create', exact: true })
  const composer = page.getByPlaceholder(/Message the agent|Reconnecting/)
  const where = () => page.evaluate(() => {
    const a = document.activeElement
    return a ? `${a.tagName}${a.getAttribute('aria-label') ? `[${a.getAttribute('aria-label')}]` : ''}`
      + `${a.className && typeof a.className === 'string' && a.className.includes('xterm') ? '.xterm' : ''}` : 'none'
  })
  const panes = () => page.evaluate(() => ({
    chats: [...document.querySelectorAll('textarea[placeholder]')]
      .filter((t) => /Message the agent|Reconnecting/.test(t.placeholder) && t.checkVisibility()).length,
    terms: [...document.querySelectorAll('.xterm')].filter((t) => t.checkVisibility()).length,
  }))

  const openDialog = async () => {
    await page.keyboard.press('Alt+n')
    await prompt.waitFor({ state: 'visible' })
    await page.waitForTimeout(300)
  }
  const createFromDialog = async (ui) => {
    await openDialog()
    await page.getByLabel('Agent').selectOption('claude')
    await page.getByLabel('UI').selectOption({ label: ui })
    await create.and(page.locator(':enabled')).waitFor({ timeout: 15_000 })
    await create.click()
    await prompt.waitFor({ state: 'detached' })
  }
  const closeDiscarding = async () => {
    await prompt.focus()
    await page.keyboard.press('Escape')
    const ask = page.getByRole('alertdialog')
    if (await ask.isVisible().catch(() => false)) await ask.getByRole('button', { name: 'Discard' }).click()
    else await ask.waitFor({ timeout: 1000 }).then(() => ask.getByRole('button', { name: 'Discard' }).click(), () => {})
    await prompt.waitFor({ state: 'detached' })
  }

  /*
   * Type one key every 150ms into the reopened dialog until a pane of the
   * given kind is visible, then 3s more; report what reached the prompt.
   */
  const typeWhileProvisioning = async (kind) => {
    await openDialog()
    await prompt.click()
    let typed = ''
    let seenAt = null
    const start = Date.now()
    while (Date.now() - start < 120_000) {
      const ch = String.fromCharCode(97 + (typed.length % 26))
      await page.keyboard.type(ch)
      typed += ch
      await page.waitForTimeout(150)
      const p = await panes()
      if (seenAt === null && p[kind] > 0) seenAt = Date.now()
      if (seenAt !== null && Date.now() - seenAt > 3000) break
    }
    const got = await prompt.inputValue()
    return { typed, got, seen: seenAt !== null, focus: await where() }
  }

  // (1) Chat under the dialog.
  await createFromDialog('Chat')
  const r1 = await typeWhileProvisioning('chats')
  check('1. a chat pane came up under the dialog', r1.seen)
  check('1. every key typed reached the dialog prompt', r1.got === r1.typed, `typed ${r1.typed.length}, got ${r1.got.length}`)
  check('1. the prompt still holds focus', r1.focus === 'TEXTAREA[Prompt]', r1.focus)
  await closeDiscarding()
  console.log(`  after closing: focus on ${await where()}`)

  // (2) Composer after create.
  await createFromDialog('Chat')
  const t0 = Date.now()
  let landed = false
  while (Date.now() - t0 < 120_000) {
    if (await composer.and(page.locator(':visible')).count() > 0) break
    await page.waitForTimeout(200)
  }
  await page.waitForTimeout(1000)
  landed = await composer.and(page.locator(':visible')).evaluate((el) => el === document.activeElement).catch(() => false)
  check('2. the new chat workspace\'s composer holds focus', landed, await where())

  // (3) Terminal under the dialog.
  await createFromDialog('Terminal')
  const r3 = await typeWhileProvisioning('terms')
  check('3. a terminal pane came up under the dialog', r3.seen)
  check('3. every key typed reached the dialog prompt', r3.got === r3.typed, `typed ${r3.typed.length}, got ${r3.got.length}`)
  check('3. the prompt still holds focus', r3.focus === 'TEXTAREA[Prompt]', r3.focus)
  await closeDiscarding()
} finally {
  await browser.close()
  for (const w of (await api(`/workspace/list?project=${PROJECT}`)).workspaces) {
    if (!known.has(w.workspaceId)) {
      await api('/workspace/stop', { method: 'POST', body: { workspaceId: w.workspaceId } }).catch(() => {})
    }
  }
}
finish()
