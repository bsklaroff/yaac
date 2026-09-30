/*
 * Verifies that a freshly attached agent terminal starts with the agent's
 * bottom line visible, and that a keypress reveals nothing new.
 *
 * The bug: if the view session is created already attached, the shared
 * tmux window resizes twice (rows-1 with the status bar, then rows after
 * `status off`). The shrink drops the row below the agent's cursor (Claude's
 * hint line) and the grow restores a history line at the top instead, so the
 * screen sits one row low until the agent repaints. attachArgs in
 * packages/server/src/runtime/terminals/pty-bridge.ts avoids this: create
 * detached, turn status off, then attach.
 *
 * xterm itself can't cause this: the tmux client keeps the alternate buffer
 * for the whole attach, so viewportY === baseY (also checked). Terminal
 * objects are read through the window.__xterms test hook, since xterm does
 * not mirror scroll state into the DOM.
 *
 * Each trial first resizes the workspace's tmux window to 500x200 through
 * its host socket (containerless driver) so the attach replays a large
 * shrink, then opens the webapp on the workspace, samples viewportY/baseY
 * every animation frame once the terminal is revealed, and compares the
 * bottom rows before and after an ArrowRight (a no-op in an idle prompt).
 *
 * Needs a running containerless server with a claude TUI workspace whose
 * agent is idle (`yaac workspace create yaac --tool claude`); defaults to
 * the first one listed. Leaves the workspace running.
 * Run: [YAAC_DATA_DIR=<dir>] node test-playwright-scripts/xterm-attach-scroll-pin-test.js [workspaceId] [trials] [dpr] [WxH]
 */
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { api, check, DATA_DIR, finish, origin, requirePlaywright, SHOTS, until } from './lib.js'

const [idArg, trialsArg = '3', dprArg = '2', sizeArg = '900x520'] = process.argv.slice(2)
const trials = Number(trialsArg)
const dpr = Number(dprArg)
const [vw, vh] = sizeArg.split('x').map(Number)

const { workspaces } = await api('/workspace/list')
const ws = idArg
  ? workspaces.find((w) => w.workspaceId.startsWith(idArg))
  : workspaces.find((w) => w.tool === 'claude' && w.status !== 'stopped')
if (!ws) throw new Error('no claude workspace found; create one with `yaac workspace create yaac --tool claude`')

/** The workspace's tmux socket, as the containerless driver derives it (paths.ts). */
const hash = (s, n) => crypto.createHash('sha256').update(s).digest('hex').slice(0, n)
const sock = path.join(os.tmpdir(), `yaac-${hash(path.resolve(DATA_DIR), 8)}`, `${hash(ws.workspaceId, 12)}.sock`)
const tmux = (...args) => execFileSync('tmux', ['-S', sock, ...args], { encoding: 'utf8' }).trim()

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
for (let i = 1; i <= trials; i++) {
  tmux('resize-window', '-t', 'yaac:^', '-x', '500', '-y', '200')
  tmux('set-option', '-w', '-t', 'yaac:^', 'window-size', 'latest')
  await new Promise((r) => setTimeout(r, 3000)) // let the agent repaint at the big size
  console.log(`\n=== trial ${i}/${trials}: window ${tmux('display', '-p', '-t', 'yaac:^', '#{window_width}x#{window_height}')} ===`)

  const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: dpr })
  page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))
  await page.addInitScript(() => {
    // Sample the first terminal every frame once it is revealed.
    window.__samples = []
    const tick = () => {
      const term = window.__xterms && [...window.__xterms][0]
      if (term?.element && getComputedStyle(term.element.parentElement).opacity === '1') {
        const buf = term.buffer.active
        window.__samples.push({ t: performance.now(), vy: buf.viewportY, by: buf.baseY })
      }
      if (!window.__done) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await page.goto(`${origin}/?project=${ws.projectSlug}&workspace=${ws.workspaceId}`)
  await until(page, () => window.__samples.length > 0, undefined, 60_000)
  await page.waitForTimeout(2500)

  const bottomRows = () => page.evaluate(() => {
    const t = [...window.__xterms][0]
    const buf = t.buffer.active
    return [t.rows - 3, t.rows - 2, t.rows - 1].map((y) => buf.getLine(buf.baseY + y)?.translateToString(true) ?? '')
  })
  const pre = await bottomRows()
  await page.screenshot({ path: `${SHOTS}/scroll-pin-${i}-pre-key.png` })
  await page.click('.xterm-screen')
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(500)
  const post = await bottomRows()
  const samples = await page.evaluate(() => { window.__done = true; return window.__samples })
  await page.close()

  console.log(`bottom rows: ${JSON.stringify(pre.map((r) => r.slice(0, 50)))}`)
  const drift = samples.filter((s) => s.vy !== s.by)
  check(`trial ${i}: viewport stays pinned to the bottom`, drift.length === 0, `${drift.length}/${samples.length} frames off`)
  check(`trial ${i}: bottom row is not blank under content`,
    !(pre[2].trim() === '' && pre.some((r) => r.trim() !== '')))
  check(`trial ${i}: keypress reveals nothing new`, pre.join('\n') === post.join('\n'),
    `post=${JSON.stringify(post.map((r) => r.slice(0, 50)))}`)
}
await browser.close()
console.log(`screenshots: ${SHOTS}/scroll-pin-*.png`)
finish()
