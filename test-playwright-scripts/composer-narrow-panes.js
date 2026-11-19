/*
 * Verifies that the chat composer's bottom row never overlaps at any pane
 * width, in real Chromium:
 *
 *  1. In tiles mode at 1440px with one to six columns (the chat pane down
 *     to ~190px), and at 1024px with six (~130px), while a turn runs (so
 *     Stop and the context meter are showing too): no two of the row's
 *     controls overlap, each stays inside the composer card, and Send is
 *     the element under its own centre, so a click lands on it.
 *  2. Below 22rem the attach and condensed buttons fold into a ⋯ menu that
 *     holds both; at 22rem and up they are inline and there is no ⋯.
 *  3. The same holds in tabs mode at desktop width, in the phone layout at
 *     390px and 320px, and for the create screen's bottom bar at phone
 *     widths.
 *
 * Costs a cent or so. With no WORKSPACE_ID it creates a claude acp
 * workspace on PROJECT (default `yaac`) with a prompt that keeps a turn
 * running for about two minutes, and stops it at the end; with one, it uses that
 * workspace (Stop is then checked only if a turn is running).
 *
 * Run: YAAC_DATA_DIR=... node test-playwright-scripts/composer-narrow-panes.js
 */
import path from 'node:path'
import { SHOTS, api, check, createWorkspace, finish, origin, requirePlaywright, resolveProject, until } from './lib.js'

const project = await resolveProject(process.env.PROJECT ?? 'yaac')
const created = process.env.WORKSPACE_ID === undefined
const workspaceId = process.env.WORKSPACE_ID ?? await createWorkspace({
  project: project.id, tool: 'claude', model: 'haiku', mode: 'acp', permissionMode: 'bypass',
  prompt: 'Run the shell command `sleep 100` with your Bash tool, then reply "done".',
})
const { workspaces } = await api('/workspace/list')
const workspace = workspaces.find((w) => w.workspaceId.startsWith(workspaceId))
if (!workspace) throw new Error(`no live workspace ${workspaceId}`)
const session = workspace.sessions.find((s) => s.mode === 'acp')
if (!session) throw new Error('the workspace has no acp session')
const url = `${origin}/?project=${workspace.projectId}&workspace=${workspace.workspaceId}`
const OTHER_PANES = ['files', 'changes', 'details', 'history', 'file:README.md']

/**
 * The controls in the row under the composer text box `textarea`: their
 * names, how many lines they take, which pairs overlap or leave the card,
 * and whether the send button (the row's last) is the topmost element at
 * its centre.
 */
function rowReport(textarea) {
  const card = textarea.parentElement
  const row = textarea.nextElementSibling
  const send = [...row.querySelectorAll('button')].at(-1)
  const cardBox = card.getBoundingClientRect()
  const controls = [...row.querySelectorAll('button, [role="meter"]')]
    .filter((b) => b.getClientRects().length > 0 && getComputedStyle(b).visibility !== 'hidden')
    .map((b) => {
      const r = b.getBoundingClientRect()
      return { name: b.getAttribute('aria-label') ?? b.textContent, left: r.left, right: r.right, top: r.top, bottom: r.bottom }
    })
  const overlaps = []
  for (let i = 0; i < controls.length; i++) {
    for (let j = i + 1; j < controls.length; j++) {
      const a = controls[i]
      const b = controls[j]
      const x = Math.min(a.right, b.right) - Math.max(a.left, b.left)
      const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
      if (x > 0.5 && y > 0.5) overlaps.push(`${a.name} × ${b.name}`)
    }
  }
  const outside = controls.filter((c) => c.left < cardBox.left - 0.5 || c.right > cardBox.right + 0.5).map((c) => c.name)
  const s = send.getBoundingClientRect()
  const hit = document.elementFromPoint(s.left + s.width / 2, s.top + s.height / 2)
  return {
    paneWidth: Math.round(textarea.closest('.\\@container').getBoundingClientRect().width),
    names: controls.map((c) => c.name),
    lines: new Set(controls.map((c) => Math.round((c.top + c.bottom) / 2))).size,
    overlaps,
    outside,
    sendHit: send.contains(hit),
  }
}

/** Run the overlap checks on the composer whose text box `box` locates. */
async function checkRow(page, label, box, { expectStop = false } = {}) {
  const r = await box.evaluate(rowReport)
  console.log(`  ${label}: ${r.paneWidth}px, ${r.lines} line(s): ${r.names.join(', ')}`)
  check(`${label}: no controls overlap`, r.overlaps.length === 0, r.overlaps.join('; '))
  check(`${label}: every control is inside the card`, r.outside.length === 0, r.outside.join(', '))
  check(`${label}: Send is clickable`, r.sendHit)
  if (expectStop) check(`${label}: Stop shows`, r.names.includes('Stop turn'))
  return r
}

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  // ---- 1 & 2. tiles ----
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))
  await page.goto(origin)
  const sessionPane = `session:${session.sessionId}`
  // The chat's box: not the create screen's (labelled Prompt), which shows
  // while a just-created workspace is still reaching the snapshot, nor a
  // chat kept mounted out of sight.
  const chatBox = (p) => p.locator('textarea:not([aria-label="Prompt"]):visible')
  const chat = chatBox(page)
  const busy = page.getByRole('button', { name: 'Stop turn' })

  if (created) {
    await page.goto(url)
    await busy.waitFor({ timeout: 60_000 })
  }
  // Narrowest first, so the tightest rows are measured while the turn runs.
  const layouts = [{ width: 1024, n: 6 }, ...[6, 5, 4, 3, 2, 1].map((n) => ({ width: 1440, n }))]
  for (const { width, n } of layouts) {
    await page.setViewportSize({ width, height: 900 })
    await page.evaluate(({ ws, panes }) => {
      localStorage.setItem('yaac.viewmode.v1', 'tiles')
      localStorage.setItem('yaac.layouts.v2', JSON.stringify({ [ws]: panes.map((t) => ({ tabs: [t], active: t })) }))
    }, { ws: workspace.workspaceId, panes: [sessionPane, ...OTHER_PANES.slice(0, n - 1)] })
    await page.goto(url)
    await chat.waitFor({ timeout: 30_000 })
    await page.getByRole('button', { name: 'Permission mode' }).waitFor({ timeout: 30_000 })
    const running = await busy.count() > 0
    const r = await checkRow(page, `${width}px, ${n} tile(s)`, chat, { expectStop: created && running })
    await page.screenshot({ path: path.join(SHOTS, `composer-tiles-${width}-${n}.png`) })

    const narrow = r.paneWidth < 22 * 16
    const more = chat.locator('xpath=..').getByRole('button', { name: 'More actions' })
    check(`${width}px, ${n} tile(s): ⋯ shows only below 22rem`, (await more.isVisible()) === narrow)
    check(`${width}px, ${n} tile(s): Attach is inline only from 22rem`, r.names.includes('Attach image') === !narrow)
    if (narrow && n === 6 && width === 1440) {
      await more.click()
      const menu = page.getByRole('menu')
      await menu.waitFor()
      const items = await menu.getByRole('menuitem').allTextContents()
      await page.screenshot({ path: path.join(SHOTS, 'composer-tiles-menu.png') })
      check('the ⋯ menu holds Attach image and the condensed toggle',
        items.includes('Attach image') && items.some((t) => /Show (every step|key messages only)/.test(t)), items.join(' | '))
      await page.keyboard.press('Escape')
    }
  }

  // ---- 3. tabs at desktop width ----
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.evaluate(() => localStorage.setItem('yaac.viewmode.v1', 'tabs'))
  await page.goto(url)
  await chat.waitFor({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Permission mode' }).waitFor({ timeout: 30_000 })
  await checkRow(page, 'desktop tabs', chat)
  await page.screenshot({ path: path.join(SHOTS, 'composer-desktop.png') })
  await ctx.close()

  // ---- 3. phone widths, the chat and the create screen ----
  for (const width of [390, 320]) {
    const phone = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: true, isMobile: true })
    const p = await phone.newPage()
    await p.addInitScript(() => localStorage.setItem('yaac.mobilescreen.v1', 'pane'))
    await p.goto(url)
    const box = chatBox(p)
    await box.waitFor({ timeout: 30_000 })
    await p.getByRole('button', { name: 'Permission mode' }).waitFor({ timeout: 30_000 })
    await checkRow(p, `phone ${width}px chat`, box)
    await p.screenshot({ path: path.join(SHOTS, `composer-phone-${width}.png`) })
    await phone.close()

    // The create screen, from a context that opens on the workspace list.
    const create = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: true, isMobile: true })
    const c = await create.newPage()
    await c.addInitScript(() => localStorage.setItem('yaac.mobilescreen.v1', 'workspaces'))
    await c.goto(`${origin}/?project=${workspace.projectId}`)
    await c.getByRole('button', { name: 'New workspace', exact: true }).click()
    const prompt = c.getByRole('textbox', { name: 'Prompt' })
    await prompt.waitFor({ timeout: 15_000 })
    await until(c, () => document.querySelector('[aria-label="Agent settings"]') !== null)
    await checkRow(c, `phone ${width}px create`, prompt)
    await c.screenshot({ path: path.join(SHOTS, `composer-create-phone-${width}.png`) })
    await create.close()
  }
} finally {
  await browser.close()
  if (created) await api('/workspace/stop', { method: 'POST', body: { workspaceId: workspace.workspaceId } }).catch(() => {})
}
finish()
