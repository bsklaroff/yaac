/*
 * Verifies, in real Chromium, that a workspace's terminal tabs follow its
 * tmux windows through the snapshot push, with no reload and no request to
 * list them (there is no GET /terminals route to poll):
 *
 *  1. "New shell" opens a `shell` tab, and keys typed into the page next go
 *     to that shell, not the agent: a command only a shell evaluates
 *     (`$((6*7))`) prints its result. Repeated ROUNDS times (default 8),
 *     since the window can reach the page before or after the create's
 *     answer.
 *  2. Killing that window from outside the page (the API, as another client
 *     would) closes the tab within a few seconds.
 *  3. Over the whole run, longer than any old poll interval, the page never
 *     asks the server for the window list.
 *
 * Changes the install it runs against, so use a scratch server (see lib.js).
 * With no WORKSPACE_ID it creates a TOOL (default `claude`) tui workspace on
 * PROJECT (default `yaac`) and stops it at the end; with one, it uses that
 * live workspace and leaves it running.
 *
 * Run: YAAC_DATA_DIR=... node test-playwright-scripts/shell-tab-push-test.js
 */
import path from 'node:path'
import { SHOTS, api, check, createWorkspace, finish, origin, requirePlaywright, until } from './lib.js'

const PROJECT = process.env.PROJECT ?? 'yaac'
const TOOL = process.env.TOOL ?? 'claude'
const ROUNDS = Number(process.env.ROUNDS ?? 8)
const owned = !process.env.WORKSPACE_ID
const workspaceId = process.env.WORKSPACE_ID
  ?? await createWorkspace({ project: PROJECT, tool: TOOL, mode: 'tui', title: 'PW shell tab push' })
const { workspaces } = await api('/workspace/list')
const workspace = workspaces.find((w) => w.workspaceId.startsWith(workspaceId))
if (!workspace) throw new Error(`no live workspace ${workspaceId}`)

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
  page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))
  const listings = []
  page.on('request', (req) => {
    if (req.method() === 'GET' && /\/api\/workspace\/[^/]+\/terminals/.test(req.url())) listings.push(req.url())
  })
  const started = Date.now()

  await page.goto(`${origin}/?project=${workspace.projectSlug}&workspace=${workspace.workspaceId}`)
  await page.locator('[title="New shell"]').waitFor({ state: 'visible', timeout: 120_000 })
  // A reload would drop this; the SPA's own URL updates do not.
  await page.evaluate(() => { window.__noReload = true })
  const shellTab = page.locator('[aria-label="Kill shell"]')
  check('no shell tab before one is opened', await shellTab.count() === 0)
  for (let round = 1; round <= ROUNDS; round++) {
    await page.locator('[title="New shell"]').click()
    await shellTab.first().waitFor({ state: 'attached', timeout: 10_000 })
    check(`round ${round}: "New shell" opens a shell tab`, await shellTab.count() === 1)
    // Give the shell time to draw, as a user would. A fresh workspace HOME
    // makes zsh's first shell ask about a .zshrc; `0` writes an empty one.
    await page.waitForTimeout(2500)
    const menu = await page.evaluate(() => [...(window.__xterms ?? [])].some((t) => {
      for (let y = 0; y < t.buffer.active.length; y++) {
        if (t.buffer.active.getLine(y)?.translateToString(true).includes('Type one of the keys')) return true
      }
      return false
    }))
    if (round === 1 && menu) {
      await page.keyboard.press('0')
      await page.waitForTimeout(500)
    }
    await page.keyboard.type(`echo pw-$((6*7))-${round}`)
    await page.keyboard.press('Enter')
    // Any mounted terminal's buffer holding the evaluated line.
    const evaluated = await until(page, (marker) => {
      const text = [...(window.__xterms ?? [])].map((t) => {
        const lines = []
        for (let y = 0; y < t.buffer.active.length; y++) lines.push(t.buffer.active.getLine(y)?.translateToString(true))
        return lines.join('\n')
      }).join('\n')
      return text.split('\n').some((l) => l.trim() === marker)
    }, `pw-42-${round}`, 15_000).then(() => true, () => false)
    check(`round ${round}: the typed command ran in the new shell`, evaluated)
    if (!evaluated && process.env.DEBUG) console.log(await page.evaluate(() => [...(window.__xterms ?? [])].map((t) => {
      const lines = []
      for (let y = 0; y < t.buffer.active.length; y++) lines.push(t.buffer.active.getLine(y)?.translateToString(true))
      return lines.filter((l) => l.trim()).slice(-8).join('\n')
    }).join('\n-----\n')))
    if (round === 1) await page.screenshot({ path: path.join(SHOTS, 'shell-push-1-opened.png') })

    const { workspaces: listed } = await api('/workspace/list')
    const shell = listed.find((w) => w.workspaceId === workspace.workspaceId)?.terminals
      ?.find((t) => t.name === 'shell')
    check(`round ${round}: the listing carries the shell window`, shell !== undefined)
    if (!shell) break
    await api(`/workspace/${workspace.workspaceId}/terminals/close`, { method: 'POST', body: { target: shell.target } })
    const t0 = Date.now()
    await until(page, () => !document.querySelector('[aria-label="Kill shell"]'), undefined, 10_000)
    check(`round ${round}: a kill from outside the page closes its tab`, true, `${Date.now() - t0}ms`)
  }
  await page.screenshot({ path: path.join(SHOTS, 'shell-push-2-killed.png') })

  // Outlast the old 10s poll interval before counting listings.
  const wait = 12_000 - (Date.now() - started)
  if (wait > 0) await page.waitForTimeout(wait)
  check('the page never reloaded', await page.evaluate(() => window.__noReload === true))
  check('the page never requested the window list', listings.length === 0, listings.join(', '))
  console.log(`\nscreenshots: ${SHOTS}`)
} finally {
  await browser.close()
  if (owned) await api('/workspace/stop', { method: 'POST', body: { workspaceId: workspace.workspaceId } })
}
finish()
