/*
 * Verifies the ACP chat composer's completion menu in real Chromium,
 * against a live agent, without sending it a prompt (no model call):
 *
 *  1. `/` lists the agent's slash commands (claude's include skills), in a
 *     menu that sits above the composer and is not clipped.
 *  2. `/mod` ranks `/model` first (substring matches trail); Enter completes to
 *     `/model ` and lists the session's models, one tagged `current`.
 *  3. Picking another model clears the box, and the `current` tag moves to
 *     it once the server's `session/set_config_option` lands.
 *  4. Escape hides the menu over `/co`.
 *
 * Changes the install it runs against, so use a scratch server (see lib.js).
 * With no WORKSPACE_ID it creates a TOOL (default `claude`) acp workspace on
 * PROJECT (default `hello-world`, a registered project with a git
 * credential) and stops it at the end; with one, it uses that live acp
 * workspace of TOOL and leaves it running.
 *
 * Run: YAAC_DATA_DIR=... SCREENSHOT_DIR=/tmp/typeahead-shots \
 *        node test-playwright-scripts/acp-composer-menu-test.js
 */
import path from 'node:path'
import { SHOTS, api, check, createWorkspace, finish, origin, requirePlaywright, until } from './lib.js'

const PROJECT = process.env.PROJECT ?? 'hello-world'
/** The agent, for a created workspace and for its "<Tool> · <model>" labels. */
const TOOL = process.env.TOOL ?? 'claude'
const TOOL_LABEL = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', pi: 'Pi' }[TOOL]
const owned = !process.env.WORKSPACE_ID
const workspaceId = process.env.WORKSPACE_ID
  ?? await createWorkspace({ project: PROJECT, tool: TOOL, mode: 'acp', title: 'PW composer menu' })
const { workspaces } = await api('/workspace/list')
const workspace = workspaces.find((w) => w.workspaceId.startsWith(workspaceId))
if (!workspace) throw new Error(`no live workspace ${workspaceId}`)

/** The menu's rows: label, detail and tag text of each. */
function menuRows() {
  return () => [...document.querySelectorAll('[role=option][aria-selected]')].map((b) => {
    const spans = [...b.querySelectorAll('span')].map((s) => s.textContent.trim())
    return { label: spans[0], detail: spans[1], tag: spans[2] ?? '', active: b.getAttribute('aria-selected') === 'true' }
  })
}

/** Where the menu sits relative to the composer and the viewport. */
function menuGeometry() {
  return () => {
    const ul = document.querySelector('[role=listbox]')
    const box = document.querySelector('textarea[placeholder]')
    if (!ul || !box) return null
    const m = ul.parentElement.getBoundingClientRect()
    const b = box.getBoundingClientRect()
    return { menuTop: m.top, menuBottom: m.bottom, boxTop: b.top, vh: window.innerHeight,
      scrollable: ul.scrollHeight > ul.clientHeight }
  }
}

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
  page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))
  await page.goto(`${origin}/?project=${workspace.projectId}&workspace=${workspace.workspaceId}`)
  const box = page.getByPlaceholder('Message the agent…')
  await box.waitFor({ state: 'visible', timeout: 60_000 })
  const rows = () => page.evaluate(menuRows())

  // ---- 1. `/` lists the commands ----
  await box.click()
  await box.fill('/')
  const anyRows = await until(page, () => document.querySelectorAll('[role=option][aria-selected]').length > 0,
    undefined, 60_000).then(() => true, () => false)
  check('`/` opens the command menu', anyRows)
  const slash = await rows()
  console.log(`  ${slash.length} rows: ${slash.slice(0, 12).map((r) => r.label).join(' ')}`)
  const geo = await page.evaluate(menuGeometry())
  console.log('  geometry:', JSON.stringify(geo))
  check('the menu sits above the composer, inside the viewport',
    geo !== null && geo.menuBottom <= geo.boxTop + 1 && geo.menuTop >= 0)
  await page.screenshot({ path: path.join(SHOTS, '1-slash.png') })

  // ---- 2. `/mod` then Enter ----
  await box.fill('/mod')
  await page.waitForTimeout(300)
  const mod = await rows()
  // Filtering is substring, prefix matches first, so `/auto-mode-setup` may
  // trail; `/model` must be the only prefix match and highlighted.
  check('`/mod` ranks `/model` first and alone among prefix matches',
    mod[0]?.label === '/model' && mod[0].active && mod.filter((r) => r.label.startsWith('/mod')).length === 1,
    mod.map((r) => r.label).join(' '))
  await box.press('Enter')
  await page.waitForTimeout(300)
  check('Enter completes the box to `/model `', (await box.inputValue()) === '/model ', JSON.stringify(await box.inputValue()))
  const models = await rows()
  console.log(`  models: ${models.map((r) => `${r.label}${r.tag ? `(${r.tag})` : ''}`).join(', ')}`)
  const current = models.filter((r) => r.tag === 'current')
  check('one model row is tagged current', current.length === 1, current.map((r) => r.label).join(' '))
  await page.screenshot({ path: path.join(SHOTS, '2-models.png') })

  // ---- 3. pick another model ----
  const target = models.find((r) => r.tag !== 'current' && /sonnet/i.test(r.label))
    ?? models.find((r) => r.tag !== 'current')
  const before = await page.evaluate(() => document.body.innerText)
  await page.locator('[role=option][aria-selected]', { hasText: target.label }).first().click()
  await page.waitForTimeout(300)
  check('picking a model clears the box', (await box.inputValue()) === '', JSON.stringify(await box.inputValue()))
  await page.waitForTimeout(4000)
  await box.fill('/model ')
  await page.waitForTimeout(300)
  const after = (await rows()).filter((r) => r.tag === 'current')
  check(`the current tag moved to ${target.label}`, after.length === 1 && after[0].label === target.label,
    after.map((r) => r.label).join(' '))
  await page.screenshot({ path: path.join(SHOTS, '3-models-after.png') })
  const errors = await page.evaluate(() => [...document.querySelectorAll('[role="alert"], .text-red-400, .text-danger')]
    .map((e) => e.textContent.trim()).filter(Boolean))
  if (errors.length > 0) console.log('  errors shown:', errors.join(' | '))
  // The agent tab and the sidebar row both read "<Tool> · <model>", with the
  // catalog name: pi's and opencode's picker names carry a `provider/`
  // prefix the labels drop.
  const shown = (label) => `${TOOL_LABEL} · ${label?.replace(/^[^/]*\//, '')}`
  const text = await page.evaluate(() => document.body.innerText)
  check(`the tab and sidebar labels moved to ${target.label}`,
    before.includes(shown(current[0]?.label)) && text.split(shown(target.label)).length >= 3
      && !text.includes(shown(current[0]?.label)))
  const listed = (await api('/workspace/list')).workspaces.find((w) => w.workspaceId === workspace.workspaceId)
  console.log('  workspace model fields:', JSON.stringify({ model: listed?.model, sessions: listed?.agentSessions?.map((a) => a.model) }))

  // ---- 4. Escape hides the menu ----
  await box.fill('/co')
  await page.waitForTimeout(300)
  const coRows = await rows()
  console.log(`  /co rows: ${coRows.map((r) => r.label).join(' ')}`)
  await box.press('Escape')
  await page.waitForTimeout(300)
  check('Escape hides the menu', (await rows()).length === 0)
  await page.screenshot({ path: path.join(SHOTS, '4-escaped.png') })
  await box.fill('')

  console.log(`\nscreenshots: ${SHOTS}`)
} finally {
  await browser.close()
  if (owned) await api('/workspace/stop', { method: 'POST', body: { workspaceId: workspace.workspaceId } })
}
finish()
