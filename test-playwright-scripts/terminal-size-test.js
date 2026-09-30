/*
 * Verifies that a workspace's tmux window always matches the xterm grid
 * showing it, so tmux never pads the right edge with its `··` overflow dots.
 * Each webapp view follows its client under `window-size latest` (attachArgs
 * in pty-bridge), and hidden panes keep a frozen rect (WorkspaceView).
 *
 *  1. Settle gate (lib/attach-settle.ts): a workspace created from the
 *     sidebar mounts its terminal at opacity 0, shows "Connecting…" while
 *     held, and reveals once, with agent content already drawn.
 *  2. Split during boot: a shell column opened the moment that terminal
 *     mounts shrinks the agent pane; the agent's tmux window must follow the
 *     shrink rather than stay at the first attach's width.
 *  3. Switching between two workspaces never shows overflow dots.
 *  4. Growing and shrinking the viewport never shows overflow dots, and the
 *     agent's tmux window ends each step at the xterm's size.
 *
 * Containerless only: it reads tmux over the workspace's host socket. Needs
 * a server with the `yaac` project (PROJECT picks another); it creates two
 * workspaces and stops them at the end. Screenshots go to
 * $SCREENSHOT_DIR/size-*.png.
 *
 * Run: YAAC_DATA_DIR=~/.yaac node test-playwright-scripts/terminal-size-test.js
 */
import { execSync } from 'node:child_process'
import path from 'node:path'
import { requirePlaywright, origin, api, until, check, finish, SHOTS, createWorkspace } from './lib.js'

const PROJECT = process.env.PROJECT ?? 'yaac'

/** The agent window's size, read over the socket of the tmux server started in the workspace's checkout. */
function tmuxAgentSize(workspaceId) {
  const line = execSync('ps -eo args', { encoding: 'utf8' }).split('\n')
    .find((l) => l.includes('new-session') && l.includes(workspaceId))
  const sock = line?.match(/-S (\S+)/)?.[1]
  if (!sock) throw new Error(`no tmux server found for ${workspaceId}`)
  const sizes = execSync(`tmux -S ${sock} list-windows -a -F '#{window_name} #{window_width}x#{window_height}'`,
    { encoding: 'utf8' }).split('\n').filter((l) => l.startsWith('claude ')).map((l) => l.split(' ')[1])
  return [...new Set(sizes)].join(',')
}

/** The visible agent xterm (the leftmost) and how many of its rows end in overflow dots. */
function probe() {
  const left = (x) => x.element.getBoundingClientRect().left
  const t = [...(window.__xterms ?? [])]
    .filter((x) => x.element?.checkVisibility({ visibilityProperty: true }))
    .sort((a, b) => left(a) - left(b))[0]
  if (!t) return null
  const buf = t.buffer.active
  let dots = 0
  for (let y = 0; y < t.rows; y++) {
    if (/·{2,}\s*$/.test(buf.getLine(buf.baseY + y)?.translateToString(false) ?? '')) dots++
  }
  return { grid: `${t.cols}x${t.rows}`, dots }
}

/** Sample for `ms` after an action; returns the worst frame's dot count. */
async function watchDots(page, ms = 1200) {
  let max = 0
  const t0 = Date.now()
  while (Date.now() - t0 < ms) max = Math.max(max, (await page.evaluate(probe))?.dots ?? 0)
  return max
}

/**
 * Follows the first terminal container mounted after it starts, recording
 * its opacity, buffer text length and the "Connecting…" notice every frame.
 * On mount it opens a shell column, splitting the pane while the agent boots.
 */
function startSampler() {
  const containerOf = (x) => x.parentElement
  const baseline = new Set([...document.querySelectorAll('.xterm')].map(containerOf))
  const samples = []
  let tracked = null
  const t0 = performance.now()
  const tick = () => {
    if (!tracked) {
      tracked = [...document.querySelectorAll('.xterm')].map(containerOf).find((c) => !baseline.has(c)) ?? null
      if (tracked) {
        const id = new URLSearchParams(location.search).get('workspace')
        window.__splitDone = fetch(`/api/workspace/${id}/terminals`, { method: 'POST' }).then((r) => r.ok)
      }
    }
    if (tracked) {
      const notice = tracked.parentElement.querySelector('.animate-fade-in')
      // The WebGL renderer paints a canvas, so read the buffer instead of the DOM.
      const term = [...(window.__xterms ?? [])].find((t) => t.element?.parentElement === tracked)
      let textLen = 0
      for (let y = 0; term && y < term.rows; y++) {
        textLen += term.buffer.active.getLine(term.buffer.active.baseY + y)?.translateToString(true).trim().length ?? 0
      }
      samples.push({
        t: Math.round(performance.now() - t0),
        opacity: getComputedStyle(tracked).opacity,
        textLen,
        notice: notice ? Number(getComputedStyle(notice).opacity) : null,
      })
    }
    if (!window.__samplerDone) requestAnimationFrame(tick)
  }
  window.__samples = samples
  requestAnimationFrame(tick)
}

const created = []
const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  created.push(await createWorkspace({ project: PROJECT, tool: 'claude', mode: 'tui', title: 'size-A' }))
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await ctx.addInitScript(() => {
    localStorage.setItem('yaac.viewmode.v1', 'tiles')
    localStorage.removeItem('yaac.layouts.v2')
  })
  const page = await ctx.newPage()
  page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))
  const shot = (n) => page.screenshot({ path: path.join(SHOTS, `size-${n}.png`) })
  await page.goto(`${origin}/?project=${PROJECT}&workspace=${created[0]}`)
  await until(page, () => [...(window.__xterms ?? [])].some((t) => t.element?.checkVisibility({ visibilityProperty: true })))
  await page.waitForTimeout(1500)

  // ---- 1. the settle gate on a fresh create ----
  await page.evaluate(startSampler)
  await page.locator('aside').getByTitle('New workspace').first().click()
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await until(page, () => window.__samples.some((s) => s.opacity === '1'), undefined, 120_000)
  await page.waitForTimeout(500)
  const samples = await page.evaluate(() => { window.__samplerDone = true; return window.__samples })
  created.push(new URL(page.url()).searchParams.get('workspace'))
  await api(`/workspace/${created[1]}/title`, { method: 'POST', body: { title: 'size-B' } })
  const at = samples.findIndex((s) => s.opacity === '1')
  const held = samples.slice(0, at)
  const shown = samples.slice(at)
  const holdMs = samples[at].t - samples[0].t
  check('the terminal mounts hidden and stays hidden until the reveal',
    held.length > 0 && held.every((s) => s.opacity === '0'), `${held.length} frames over ${holdMs}ms`)
  check('it reveals with agent content already drawn', samples[at].textLen > 0, `text=${samples[at].textLen}`)
  check('the reveal is one-way', shown.every((s) => s.opacity === '1'))
  check('it reveals within 4s of mount', holdMs < 4000, `${holdMs}ms`)
  if (holdMs > 300) check('"Connecting…" shows during the hold', held.some((s) => s.notice > 0))
  check('"Connecting…" is gone after the reveal', shown.every((s) => s.notice === null))

  // ---- 2. the split during boot ----
  check('the shell column opened during boot', await page.evaluate(() => window.__splitDone))
  await page.waitForTimeout(8000)
  await shot('1-split')
  let p = await page.evaluate(probe)
  let tmux = tmuxAgentSize(created[1])
  check('the agent window follows the split instead of staying wide', p?.grid === tmux, `xterm ${p?.grid} tmux ${tmux}`)

  // ---- 3. switching workspaces ----
  const row = (title) => page.locator('aside').getByText(title, { exact: true }).first()
  for (const title of ['size-A', 'size-B', 'size-A', 'size-B']) {
    await row(title).click()
    const dots = await watchDots(page)
    check(`switching to ${title} shows no overflow dots`, dots === 0, `worst frame ${dots} rows`)
  }
  await shot('2-switched')

  // ---- 4. growing and shrinking the viewport ----
  for (const [w, h] of [[1680, 1050], [1100, 700], [1900, 1150], [1000, 650], [1680, 1050]]) {
    await page.setViewportSize({ width: w, height: h })
    const dots = await watchDots(page)
    p = await page.evaluate(probe)
    tmux = tmuxAgentSize(created[1])
    check(`resize to ${w}x${h}: no dots, tmux matches xterm`, dots === 0 && p?.grid === tmux,
      `xterm ${p?.grid} tmux ${tmux}, worst frame ${dots} dot rows`)
  }
  await shot('3-resized')
} finally {
  await browser.close()
  for (const id of created) await api('/workspace/stop', { method: 'POST', body: { workspaceId: id } }).catch(() => {})
}
finish()
