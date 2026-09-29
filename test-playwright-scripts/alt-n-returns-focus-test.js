/*
 * Verifies that dismissing the create dialog hands focus back to the pane it
 * was opened from, in a real browser with real keyboard events:
 *
 *  1. Terminal: focus a tui worktree's terminal (xterm's textarea), Alt+N,
 *     Escape. Focus is back on that textarea, and keys typed next reach the
 *     agent's pane (read back from the worktree's tmux with capture-pane).
 *  2. Composer: the same from an acp worktree's chat composer; typed keys land
 *     in the composer.
 *
 * Needs one running tui worktree and one running acp worktree in the project
 * (`yaac worktree create <project> --mode tui|acp`), on a containerless
 * server: check 1 finds the tui worktree's tmux socket from `ps`. It types a
 * marker into the agent's input line and the composer without sending it,
 * then clears both.
 *
 * Drives the app the server itself serves (`dist/`) over loopback, reading
 * the port from $YAAC_DATA_DIR/server-local/.server.lock (data dir defaults
 * to ~/.yaac) — so run `pnpm build` + `yaac server restart` first.
 *
 * Run: PROJECT=<slug> TUI=<worktree-id> ACP=<worktree-id> \
 *        node test-playwright-scripts/alt-n-returns-focus-test.js
 * (playwright is resolved from the global npm root; browsers live under
 *  /opt/playwright-browsers)
 */
import fs from 'node:fs'
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync('/opt/playwright-browsers')) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/playwright-browsers'
}

function requirePlaywright() {
  try {
    return require('playwright')
  } catch {
    const globalRoot = execSync('npm root -g').toString().trim()
    return require(path.join(globalRoot, 'playwright'))
  }
}

function readServerLock() {
  const dataDir = process.env.YAAC_DATA_DIR ?? path.join(os.homedir(), '.yaac')
  const p = path.join(dataDir, 'server-local', '.server.lock')
  if (!fs.existsSync(p)) throw new Error(`no ${p} — is the server running?`)
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

/** The tmux socket of a containerless worktree: its session was started in
 *  the worktree's checkout, whose path ends in the worktree id. */
function tmuxSocket(worktreeId) {
  const line = execSync('ps -eo args').toString().split('\n')
    .find((l) => l.includes('tmux -S') && l.includes('new-session') && l.includes(worktreeId))
  if (!line) throw new Error(`no tmux session found for ${worktreeId} — is it a running containerless worktree?`)
  return line.match(/tmux -S (\S+)/)[1]
}

let failures = 0
function check(name, cond, detail = '') {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const { PROJECT, TUI, ACP } = process.env
if (!PROJECT || !TUI || !ACP) throw new Error('set PROJECT, TUI and ACP (worktree ids)')
const lock = readServerLock()
const origin = `http://127.0.0.1:${lock.port}`
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
  await page.goto(`${origin}/?project=${PROJECT}&worktree=${TUI}`)
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
  await page.goto(`${origin}/?project=${PROJECT}&worktree=${ACP}`)
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
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
