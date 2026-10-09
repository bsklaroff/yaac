/*
 * Verifies the Preview control for a workspace forwarding several ports, in
 * Chromium posing as the desktop app (an "Electron" user agent, which is all
 * the SPA checks; the webview itself does not load):
 *
 *  1. The header's Preview button is a menu listing each forwarded port, and
 *     picking one opens the preview pane on that port.
 *  2. From a focused terminal, Alt+P opens the same menu with its first port
 *     highlighted, so Enter switches the open pane to that port.
 *  3. Alt+P then Escape, or Alt+P pressed twice, hands focus back to the
 *     terminal.
 *
 * Needs a running tui workspace in PROJECT whose config forwards at least two
 * ports, e.g. `"portForward": [{ "containerPort": 5173, "hostPortStart":
 * 15173 }, { "containerPort": 3000, "hostPortStart": 13000 }]` set with
 * `yaac config edit <project>` before `yaac workspace create <project> --mode
 * tui`. The first such workspace is used; set WORKSPACE=<id> to pick another.
 *
 * Run: YAAC_DATA_DIR=<data dir> PROJECT=<name or id> node test-playwright-scripts/preview-port-menu.js
 */
import { SHOTS, api, check, finish, origin, requirePlaywright, resolveProject } from './lib.js'

if (!process.env.PROJECT) throw new Error('set PROJECT=<name or id>')
const PROJECT = (await resolveProject(process.env.PROJECT)).id
const { workspaces } = await api(`/workspace/list?project=${PROJECT}`)
const ws = workspaces.find((w) => process.env.WORKSPACE
  ? w.workspaceId.startsWith(process.env.WORKSPACE)
  : w.forwardedPorts.length > 1 && w.agentSessions?.[0]?.mode === 'tui')
if (!ws) throw new Error(`no running tui workspace in ${PROJECT} forwarding two or more ports`)
const [first, second] = ws.forwardedPorts.map((p) => p.containerPort)

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Electron/33.0.0',
  })
  const page = await ctx.newPage()
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  await page.goto(`${origin}/?project=${PROJECT}&workspace=${ws.workspaceId}`)
  const xterm = page.locator('.xterm-helper-textarea').first()
  await xterm.waitFor({ state: 'attached', timeout: 20_000 })
  const items = page.getByRole('menuitem')
  const tab = (port) => page.getByText(`Preview :${port}`, { exact: true }).first()

  // (1) The button's menu.
  await page.getByRole('button', { name: 'Open preview' }).click()
  await items.first().waitFor({ state: 'visible' })
  const labels = await items.allTextContents()
  check('the Preview button lists every forwarded port',
    labels.length === ws.forwardedPorts.length && labels.includes(`:${second}`), labels.join(' '))
  await items.filter({ hasText: `:${second}` }).click()
  await tab(second).waitFor({ state: 'visible', timeout: 5000 })
  check(`picking :${second} opens the preview on it`, await tab(second).isVisible())

  // (2) Alt+P from the terminal, keyboard pick.
  await page.locator('.xterm-screen').first().click()
  check('the terminal takes focus', await xterm.evaluate((el) => el === document.activeElement))
  await page.keyboard.press('Alt+p')
  await items.first().waitFor({ state: 'visible' })
  check('Alt+P opens the port menu', await items.count() === ws.forwardedPorts.length)
  const highlight = page.locator('[role=menuitem][data-highlighted]')
  check('its first port is highlighted', await highlight.textContent() === `:${first}`)
  await page.waitForTimeout(200)
  await page.screenshot({ path: `${SHOTS}/preview-port-menu.png`, clip: { x: 1000, y: 0, width: 400, height: 140 } })
  await page.keyboard.press('Enter')
  await tab(first).waitFor({ state: 'visible', timeout: 5000 })
  check(`Enter switches the open pane to :${first}`, await tab(first).isVisible())
  check('the pane did not duplicate', await page.getByText(/^Preview :\d+$/).count() === 1)

  // (3) Escape returns focus to the terminal.
  await page.locator('.xterm-screen').first().click()
  await page.keyboard.press('Alt+p')
  await items.first().waitFor({ state: 'visible' })
  await page.keyboard.press('Escape')
  await items.first().waitFor({ state: 'detached' })
  await page.waitForTimeout(300)
  check('Escape returns focus to the terminal', await xterm.evaluate((el) => el === document.activeElement))
  await page.keyboard.press('Alt+p')
  await items.first().waitFor({ state: 'visible' })
  await page.keyboard.press('Alt+p')
  await items.first().waitFor({ state: 'detached' })
  await page.waitForTimeout(300)
  check('a second Alt+P closes the menu, focus back on the terminal',
    await xterm.evaluate((el) => el === document.activeElement))
} finally {
  await browser.close()
}
finish()
