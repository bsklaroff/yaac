/*
 * Verifies that dismissing the create dialog hands focus back to the pane it
 * was opened from, in a real browser with real keyboard events:
 *
 *  1. Terminal: focus a tui workspace's terminal (xterm's textarea), Alt+N,
 *     Escape. Focus is back on that textarea, and keys typed next reach the
 *     agent's pane (read back from the workspace's tmux with capture-pane).
 *  2. Composer: the same from an acp workspace's chat composer; typed keys land
 *     in the composer.
 *
 * Needs a running claude workspace of each UI in PROJECT on a containerless
 * server (`yaac workspace create <slug> --mode tui|acp`): check 1 finds the
 * tui workspace's tmux socket from `ps`. The first of each listed is used;
 * set TUI=<id> / ACP=<id> to pick others. It types a marker into the agent's
 * input line and the composer without sending it, then clears both.
 *
 * Run: YAAC_DATA_DIR=<data dir> PROJECT=<slug> node test-playwright-scripts/alt-n-returns-focus-test.js
 */
import { execSync } from 'node:child_process'
import { api, check, finish, origin, requirePlaywright } from './lib.js'

/**
 * The tmux socket of a containerless workspace, found via `ps`: its tmux
 * server was started in the checkout, whose path ends in the workspace id.
 */
function tmuxSocket(workspaceId) {
  const line = execSync('ps -eo args').toString().split('\n')
    .find((l) => l.includes('tmux -S') && l.includes('new-session') && l.includes(workspaceId))
  if (!line) throw new Error(`no tmux session found for ${workspaceId} — is it a running containerless workspace?`)
  return line.match(/tmux -S (\S+)/)[1]
}

const PROJECT = process.env.PROJECT
if (!PROJECT) throw new Error('set PROJECT=<slug>')
const { workspaces } = await api(`/workspace/list?project=${PROJECT}`)
const pickId = (mode, want) => {
  const w = workspaces.find((x) => want ? x.workspaceId.startsWith(want)
    : x.tool === 'claude' && x.agentSessions?.[0]?.mode === mode)
  if (!w) throw new Error(`no running claude ${mode} workspace in ${PROJECT}`)
  return w.workspaceId
}
const TUI = pickId('tui', process.env.TUI)
const ACP = pickId('acp', process.env.ACP)
const marker = `focusmark${Date.now() % 100000}`
const sock = tmuxSocket(TUI)
const pane = () => execSync(`tmux -S ${sock} capture-pane -p -t yaac:claude`).toString()

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  const prompt = page.getByLabel('Prompt')
  const altNEscape = async () => {
    await page.keyboard.press('Alt+n')
    await prompt.waitFor({ state: 'visible' })
    await page.waitForTimeout(300)
    check('  Alt+N focuses the dialog prompt', await prompt.evaluate((el) => el === document.activeElement))
    await page.keyboard.press('Escape')
    await prompt.waitFor({ state: 'detached' })
    await page.waitForTimeout(300)
  }

  // (1) Terminal.
  await page.goto(`${origin}/?project=${PROJECT}&workspace=${TUI}`)
  const xterm = page.locator('.xterm-helper-textarea').first()
  await xterm.waitFor({ state: 'attached', timeout: 20_000 })
  await page.locator('.xterm-screen').first().click()
  check('the terminal takes focus', await xterm.evaluate((el) => el === document.activeElement))
  await altNEscape()
  check('Escape returns focus to the terminal', await xterm.evaluate((el) => el === document.activeElement))
  await page.keyboard.type(marker)
  await page.waitForTimeout(1000)
  check('keys typed next reach the agent pane', pane().includes(marker))
  for (let i = 0; i < marker.length; i++) await page.keyboard.press('Backspace')

  // (2) Composer.
  await page.goto(`${origin}/?project=${PROJECT}&workspace=${ACP}`)
  const composer = page.getByPlaceholder('Message the agent…')
  await composer.waitFor({ state: 'visible', timeout: 30_000 })
  await composer.click()
  check('the composer takes focus', await composer.evaluate((el) => el === document.activeElement))
  await altNEscape()
  check('Escape returns focus to the composer', await composer.evaluate((el) => el === document.activeElement))
  await page.keyboard.type(marker)
  check('keys typed next land in the composer', await composer.inputValue() === marker)
  await composer.fill('')
} finally {
  await browser.close()
}
finish()
