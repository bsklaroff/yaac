/*
 * Walks the phone-width shell (390x844) and checks its real layout:
 *
 *  1. Below the breakpoint the rail / sidebar / pane columns become three
 *     stacked screens (projects, workspaces, pane). All stay mounted at full
 *     size, hidden with `visibility` and `inert`, since WorkspaceView sizes
 *     terminals from measured pixels. Back chevrons and the browser's own
 *     back/forward walk between them.
 *  2. The pane is in tabs mode with the key bar below it; row actions show
 *     without a hover and are finger-sized.
 *  3. The Skills and Stopped overlays show one MasterDetail pane at a time,
 *     at full width, with no sideways scroll and >=32px header targets; the
 *     list keeps its scroll offset across a drill-down. Stopped workspaces
 *     are stubbed so the list is long enough to scroll.
 *  4. No text control reached on the walk is under 16px (a smaller one makes
 *     iOS Safari zoom in for good), spills off screen, or is crushed narrow.
 *     A control the walk could not open is listed, not passed.
 *  5. Widening to desktop restores the sidebar with the same pane element
 *     mounted, and the overlays go back to side by side.
 *  6. With a faked `window.visualViewport` (Chromium has no soft keyboard),
 *     `#root` tracks the band above the keyboard via `--app-top` /
 *     `--app-height`, ignores a pinch-zoom pan, and is left alone on desktop.
 *
 * Needs a server with a live terminal-mode (tui) workspace, in PROJECT when
 * set, whose sidebar row its title and tool tell apart from the project's
 * other live rows. It changes nothing on the server. Serves the SPA from the server's `dist/`, so rebuild and restart the
 * server after frontend changes.
 *
 * Run: YAAC_DATA_DIR=<data dir> [PROJECT=<slug>] node test-playwright-scripts/mobile-shell-test.js
 */
import path from 'node:path'
import { requirePlaywright, origin, api, until, check, finish, SHOTS } from './lib.js'

/*
 * The workspace driven: its key bar is step 4's subject, so it must be tui.
 * Its row is found by the text it shows (title, else prompt) and its tool.
 */
const live = (await api('/workspace/list')).workspaces
const rowText = (w) => w.title || w.prompt || 'New workspace'
const target = live.find((w) => (!process.env.PROJECT || w.projectSlug === process.env.PROJECT)
  && w.agentSessions?.[0]?.mode === 'tui'
  && !live.some((o) => o !== w && o.projectSlug === w.projectSlug && o.tool === w.tool && rowText(o) === rowText(w)))
if (!target) throw new Error('no live tui workspace with a distinguishable row — create or retitle one')

const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1400, height: 900 }
/** Below this a focused control zooms mobile Safari. */
const FONT_FLOOR = 16
/** Below this a control is too narrow to type into. */
const USABLE = 48

const stopped = (id, title, extra = {}) => ({
  workspaceId: id, projectSlug: 'yaac', tool: 'claude', title,
  createdAt: '2026-08-01 09:00:00', stoppedAt: '2026-08-01 18:00:00', seen: true, agentSessions: [], ...extra,
})
const STOPPED = [
  stopped('stub-1', 'Rework the mobile overlays so both panes fit', {
    prompt: 'Make the overlays readable on a phone.', deathReason: 'oom', deathDetail: 'exit code 137', seen: false,
  }),
  ...Array.from({ length: 24 }, (_, i) => stopped(`stub-fill-${i}`, `Older workspace ${i + 1}`)),
]

/** Each stacked screen layer: visibility, inertness and size. */
function layerReport() {
  const shell = document.querySelector('#root > div > div > div')
  return [...(shell?.children ?? [])].map((el) => {
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return { visibility: cs.visibility, display: cs.display, inert: el.hasAttribute('inert'), w: r.width, h: r.height }
  })
}

/** The open dialog's two MasterDetail panes and whether it scrolls sideways. */
function panesReport() {
  const popup = document.querySelector('[role="dialog"]')
  if (!popup) return { error: 'no dialog' }
  const body = [...popup.querySelectorAll('div')].find((el) => el.children.length === 2
    && getComputedStyle(el).display === 'flex' && el.className.includes('min-h-0') && el.className.includes('flex-1'))
  if (!body) return { error: 'no master/detail body' }
  const panes = [...body.children].map((el) => ({
    display: getComputedStyle(el).display,
    w: Math.round(el.getBoundingClientRect().width),
    text: (el.textContent ?? '').slice(0, 30),
  }))
  return { panes, shown: panes.filter((p) => p.display !== 'none'), scrollWidth: popup.scrollWidth }
}

/** Buttons in the open dialog under 32px in either axis. */
function smallTargets() {
  return [...document.querySelectorAll('[role="dialog"] button')]
    .filter((el) => el.offsetParent !== null)
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 0 && (r.width < 32 || r.height < 32))
    .map(({ el, r }) => `${el.getAttribute('aria-label') ?? el.textContent.trim().slice(0, 20)} ${Math.round(r.width)}x${Math.round(r.height)}`)
}

/**
 * Every visible text control with its computed size. xterm's helper
 * textarea is skipped (no finger lands in it), as are checkboxes and radios.
 */
function controlsOnScreen() {
  const out = []
  for (const el of document.querySelectorAll('input, textarea, select, .cm-content')) {
    if (el.classList.contains('xterm-helper-textarea') || ['checkbox', 'radio'].includes(el.type)) continue
    if (el.getClientRects().length === 0 || getComputedStyle(el).visibility === 'hidden') continue
    const r = el.getBoundingClientRect()
    out.push({
      tag: el.tagName.toLowerCase() + (el.type ? `[${el.type}]` : ''),
      label: (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.className?.toString().split(' ')[0] || '').slice(0, 34),
      px: parseFloat(getComputedStyle(el).fontSize),
      overhang: Math.round(r.right - document.documentElement.clientWidth),
      width: Math.round(r.width),
    })
  }
  return out
}

/** A drivable fake `window.visualViewport`, installed before app code runs. */
function fakeVisualViewport() {
  const listeners = { resize: new Set(), scroll: new Set() }
  // Read lazily until driven: at install time the viewport meta isn't parsed.
  const s = { height: null, width: null, offsetTop: 0, offsetLeft: 0, scale: 1 }
  const vv = {
    get height() { return s.height ?? window.innerHeight },
    get width() { return s.width ?? window.innerWidth },
    get offsetTop() { return s.offsetTop },
    get offsetLeft() { return s.offsetLeft },
    get pageTop() { return s.offsetTop },
    get pageLeft() { return s.offsetLeft },
    get scale() { return s.scale },
    addEventListener: (type, fn) => { listeners[type]?.add(fn) },
    removeEventListener: (type, fn) => { listeners[type]?.delete(fn) },
  }
  Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true })
  window.__vv = (next) => {
    Object.assign(s, next)
    for (const fn of [...listeners.resize, ...listeners.scroll]) fn()
  }
}

function rootReport() {
  const root = document.getElementById('root')
  const r = root.getBoundingClientRect()
  const vv = window.visualViewport
  return {
    top: Math.round(r.top), height: Math.round(r.height), width: Math.round(r.width),
    position: getComputedStyle(root).position,
    appTop: getComputedStyle(document.documentElement).getPropertyValue('--app-top').trim(),
    visibleTop: Math.round(vv.offsetTop), visibleBottom: Math.round(vv.offsetTop + vv.height),
  }
}

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const ctx = await browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true })
  await ctx.addInitScript(fakeVisualViewport)
  await ctx.addInitScript(() => { try { localStorage.removeItem('yaac.mobilescreen.v1') } catch {} })
  const page = await ctx.newPage()
  page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))
  await page.route('**/api/workspace/list-stopped*', (r) =>
    r.fulfill({ contentType: 'application/json', body: JSON.stringify(STOPPED) }))
  await page.route('**/api/workspace/mark-death-seen*', (r) => r.fulfill({ contentType: 'application/json', body: '{}' }))

  const shell = page.locator('#root > div > div > div')
  const projectsLayer = shell.locator('> div').nth(0)
  const workspacesLayer = shell.locator('> div').nth(1)
  const paneLayer = shell.locator('> div').nth(2)
  const shot = (name) => page.screenshot({ path: path.join(SHOTS, `mobile-${name}.png`) })
  // Twice: one press only closes a nested menu.
  const escape = async () => {
    for (const _ of [0, 1]) { await page.keyboard.press('Escape'); await page.waitForTimeout(350) }
  }
  const tapIfPresent = async (locator, timeout = 5000) => {
    try {
      await locator.first().waitFor({ state: 'visible', timeout })
      await locator.first().tap()
      return true
    } catch { return false }
  }
  /** Control inventory by stop, and the stops the walk could not open. */
  const seen = new Map()
  const unreached = []
  const sweep = async (where) => {
    await page.waitForTimeout(600)
    seen.set(where, await page.evaluate(controlsOnScreen))
    await shot(`inputs-${where}`)
  }
  const stop = async (where, locator, timeout) => {
    if (!await tapIfPresent(locator, timeout)) { unreached.push(where); return false }
    await sweep(where)
    return true
  }

  // ---- 1. a cold load lands on the project list ----
  await page.goto(`${origin}/`)
  const addProject = projectsLayer.getByText('Add project', { exact: true })
  await addProject.waitFor({ state: 'visible', timeout: 15_000 })
  const projectRow = projectsLayer.locator('button:has(> span.truncate)', { hasText: target.projectSlug }).first()
  await projectRow.waitFor({ state: 'visible', timeout: 15_000 })
  check('no desktop sidebar at phone width', await page.locator('aside').count() === 0)
  const layers = await page.evaluate(layerReport)
  check('three screen layers, exactly one visible', layers.length === 3
    && layers.filter((l) => l.visibility === 'visible').length === 1, JSON.stringify(layers))
  check('hidden layers are inert, full size, and never display:none',
    layers.filter((l) => l.inert).length === 2
      && layers.every((l) => l.display !== 'none' && l.w === PHONE.width && l.h > 0))
  await shot('1-projects')

  // Projects-screen controls: new project and the settings sections. Server
  // is desktop-only and User Dockerfile needs image builds (k8s).
  if (await stop('new-project', addProject)) await escape()
  const SECTIONS = ['General', 'Shortcuts', 'Credentials', 'Project Config', 'User Dockerfile']
  if (await tapIfPresent(projectsLayer.getByText('Settings', { exact: true }))) {
    for (const tab of SECTIONS) {
      if (!await stop(`settings-${tab}`, page.getByRole('button', { name: tab, exact: true }), 2000)) continue
      if (tab !== 'Credentials') continue
      const save = await page.locator('[role="dialog"] button', { hasText: /^Save$/ }).last().boundingBox()
      check('the add-credential Save button is on screen',
        save && save.x + save.width <= PHONE.width, save ? `right=${Math.round(save.x + save.width)}` : 'no box')
    }
    await escape()
  } else unreached.push('settings')

  // ---- 2. the workspace list ----
  await projectRow.tap()
  await until(page, () => !!document.querySelector('[aria-label="Back to projects"]')?.checkVisibility())
  const liveRow = workspacesLayer.locator('.group.relative.mx-2:has([aria-label="Workspace actions"]) > button')
    .filter({ hasText: rowText(target) })
    // The row's agent label ("Claude · Opus 5.5") is its own span.
    .filter({ has: page.locator('span', { hasText: new RegExp(`^${target.tool}( ·|$)`, 'i') }) }).first()
  await liveRow.waitFor({ state: 'visible', timeout: 20_000 })
  const menu = await workspacesLayer.getByLabel('Workspace actions').first().boundingBox()
  check('row actions show without a hover and are finger-sized (>=24px)',
    menu && menu.width >= 24 && menu.height >= 24, menu ? `${menu.width}x${menu.height}` : 'hidden')
  await sweep('workspaces')
  await shot('2-workspaces')

  if (await tapIfPresent(workspacesLayer.locator('button:has-text("yaac")'))) {
    await stop('remove-project', page.getByText('Remove project', { exact: true }))
    await escape()
  } else unreached.push('remove-project')
  if (await stop('new-workspace', workspacesLayer.getByTitle('New workspace'))) await escape()

  // ---- 3. the overlays ----
  const phonePanes = async (what) => {
    const r = await page.evaluate(panesReport)
    check(`${what}: one pane shown, full width`, r.shown?.length === 1 && r.shown[0].w >= PHONE.width - 40,
      JSON.stringify(r.panes?.map((p) => `${p.display} ${p.w}`) ?? r.error))
    check(`${what}: no sideways scroll`, r.scrollWidth <= PHONE.width, `scrollWidth=${r.scrollWidth}`)
    return r
  }

  const entry = workspacesLayer.locator('button', { hasText: 'Stopped workspaces' }).first()
  await entry.waitFor({ state: 'visible', timeout: 15_000 })
  const entryBox = await entry.boundingBox()
  const rowBox = await liveRow.boundingBox()
  check('the stopped-workspaces entry is a finger-sized row, about a workspace row tall',
    entryBox.height >= 44 && Math.abs(entryBox.height - rowBox.height) <= 16,
    `entry=${entryBox.height} row=${rowBox.height}`)
  await entry.tap()
  await page.waitForTimeout(800)
  await phonePanes('stopped list')
  const small = await page.evaluate(smallTargets)
  check('stopped overlay targets are >=32px', small.length === 0, small.join(', '))
  await sweep('stopped')
  await page.getByText(STOPPED[0].title).first().tap()
  await page.waitForTimeout(600)
  const detail = await phonePanes('stopped detail')
  check('the detail swaps in with the list still mounted',
    detail.panes?.length === 2 && detail.shown?.[0]?.text.includes('Rework'))
  await page.getByLabel('Back to stopped workspaces').tap()
  // Click in page context: Playwright's tap would scroll the row into view.
  const before = await page.evaluate(() => {
    const list = document.querySelector('[role="dialog"] ul')
    list.scrollTop = 220
    ;[...list.querySelectorAll('button')].find((b) => b.offsetTop >= list.scrollTop)?.click()
    return list.scrollTop
  })
  await page.waitForTimeout(500)
  await page.getByLabel('Back to stopped workspaces').tap()
  await page.waitForTimeout(500)
  const after = await page.evaluate(() => document.querySelector('[role="dialog"] ul').scrollTop)
  check('the list keeps its scroll offset across a drill-down', before > 0 && after === before, `${before} -> ${after}`)
  await escape()

  await workspacesLayer.getByLabel('Skills').tap()
  await page.locator('[role="dialog"] li button').first().waitFor({ state: 'visible', timeout: 15_000 })
  await phonePanes('skills list')
  const smallSkills = await page.evaluate(smallTargets)
  check('skills overlay targets are >=32px', smallSkills.length === 0, smallSkills.join(', '))
  await sweep('skills')
  await page.locator('[role="dialog"] li button').first().tap()
  await page.waitForTimeout(1500)
  await phonePanes('skills detail')
  await shot('3-skills-detail')
  await page.getByLabel('Back to skills').tap()
  await escape()

  // ---- 4. the pane ----
  await liveRow.tap()
  await until(page, () => !!document.querySelector('[aria-label="Back to workspaces"]')?.checkVisibility())
  await page.waitForTimeout(3000)
  const cards = paneLayer.locator('section.absolute.inset-0')
  check('the pane is in tabs mode (one full-bleed card)', await cards.count() === 1, `cards=${await cards.count()}`)
  const bar = await page.getByLabel('Escape').boundingBox()
  const card = await cards.first().boundingBox()
  check('the key bar (esc, ^C, arrows) sits below the pane',
    await page.getByLabel('Control C').isVisible() && await page.getByLabel('Up arrow').isVisible()
      && bar && card && bar.y >= card.y + card.height - 1)
  await sweep('pane')
  await shot('4-pane')
  await stop('pane-rename', paneLayer.getByLabel('Rename workspace'))
  await escape()
  if (await tapIfPresent(paneLayer.getByLabel('More pane actions'))
    && await tapIfPresent(page.getByText('Review changes', { exact: true }))) {
    await page.waitForTimeout(3000)
    await sweep('changes')
    await escape()
  } else unreached.push('changes')

  // ---- 5. back and forward ----
  await page.getByLabel('Back to workspaces').tap()
  await page.waitForTimeout(800)
  check('the pane’s back chevron returns to the workspace list', await page.getByLabel('Back to projects').isVisible())
  await page.goForward()
  await page.waitForTimeout(800)
  check('browser forward re-enters the pane', await page.getByLabel('Back to workspaces').isVisible())
  await page.goBack()
  await page.goBack()
  await page.waitForTimeout(800)
  check('browser back walks out to the project list', await addProject.isVisible())

  // ---- 6. a soft keyboard (the fake visual viewport) ----
  const root = async (vv) => {
    await page.evaluate((v) => window.__vv(v), vv)
    await page.waitForTimeout(300)
    return page.evaluate(rootReport)
  }
  let r = await root({ height: 844, offsetTop: 0 })
  check('at rest the fixed root covers the viewport', r.position === 'fixed' && r.top === 0 && r.height === PHONE.height,
    JSON.stringify(r))
  r = await root({ height: 500, offsetTop: 344 })
  check('keyboard up: the root covers exactly the visible band',
    r.top === r.visibleTop && r.top + r.height === r.visibleBottom && r.width === PHONE.width, JSON.stringify(r))
  r = await root({ height: 844, offsetTop: 0 })
  check('keyboard down: the root covers the viewport again', r.top === 0 && r.height === PHONE.height, JSON.stringify(r))
  r = await root({ height: 400, offsetTop: 200, scale: 2 })
  check('a pinch-zoom pan does not drag the root along', r.top === 0, JSON.stringify(r))
  await root({ height: 844, offsetTop: 0, scale: 1 })

  // ---- 7. widen to desktop ----
  await projectRow.tap()
  await liveRow.tap()
  await page.waitForTimeout(1500)
  await page.evaluate(() => document.querySelector('#root > div > div > div').lastElementChild.setAttribute('data-probe', '1'))
  await page.setViewportSize(DESKTOP)
  await page.waitForTimeout(1500)
  check('widening restores the desktop sidebar', await page.locator('aside').count() === 1)
  check('the pane element survived the switch (rotation keeps terminals)', await page.locator('[data-probe="1"]').count() === 1)
  await page.locator('aside').getByLabel('Skills').click()
  await page.locator('[role="dialog"] li button').first().waitFor({ state: 'visible', timeout: 15_000 })
  const wide = await page.evaluate(panesReport)
  check('desktop overlays show list and detail side by side', wide.shown?.length === 2,
    JSON.stringify(wide.panes?.map((p) => `${p.display} ${p.w}`)))
  await shot('5-desktop')
  await escape()
  r = await root({ height: 500, offsetTop: 344 })
  check('desktop ignores the visual viewport', r.top === 0 && r.height === DESKTOP.height && r.appTop === '',
    JSON.stringify(r))

  // ---- the control verdict ----
  const all = [...seen].flatMap(([where, list]) => list.map((c) => ({ ...c, where })))
  console.log('\n  controls found:')
  for (const c of all) console.log(`    ${String(c.px).padStart(4)}px ${String(c.width).padStart(4)}w  ${c.where} — ${c.tag} ${c.label}`)
  const bad = (f) => all.filter(f).map((c) => `${c.where}/${c.label}`).join(' ')
  check(`every text control is at least ${FONT_FLOOR}px`, !bad((c) => c.px < FONT_FLOOR), bad((c) => c.px < FONT_FLOOR))
  check('no control spills off the right of the screen', !bad((c) => c.overhang > 0), bad((c) => c.overhang > 0))
  check(`no control is under ${USABLE}px wide`, !bad((c) => c.width < USABLE), bad((c) => c.width < USABLE))
  check('the walk opened enough controls to mean something', all.length >= 15, `${all.length} found`)
  if (unreached.length > 0) console.log(`  (never opened: ${unreached.join(', ')})`)
  console.log('  (not walked: the BranchPicker popup, the badge popovers, the expanded file editor)')
  console.log(`\nscreenshots: ${SHOTS}`)
} finally {
  await browser.close()
}
finish()
