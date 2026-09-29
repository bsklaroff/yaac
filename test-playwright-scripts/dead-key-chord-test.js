/*
 * Verifies that an Option chord on a macOS dead key leaves no accent behind.
 *
 * On a Mac, Option+N (Alt+N, new worktree) is the `˜` dead key and Option+E
 * (Alt+E, file-tree filter) is `´`. Chrome hands the key to the input method
 * before the page sees it, so the accent follows the claimed keydown as a
 * composition — and lands in whatever the command focused. Real dead keys
 * can't be typed on Linux, so this plays Chrome's side over CDP: a keydown
 * with key "Dead", then Input.imeSetComposition with the accent.
 *
 *  1. From a focused terminal, Alt+N + a stray `˜`: the prompt is empty, and
 *     typing afterwards gives exactly what was typed.
 *  2. From a focused terminal, Alt+E + a stray `´`: the filter is empty and
 *     keeps focus. (Here the accent lands in the terminal's textarea, since
 *     the filter focuses a frame after the keydown; a Mac's timing may put
 *     it in either.)
 *  3. With TMUX_SOCK set, neither accent reached the agent's PTY.
 *  4. Option+N typed INSIDE the open dialog is the user's own `ñ` — kept.
 *
 * Needs a running worktree in PROJECT (it selects the first sidebar row).
 * Drives the app the server itself serves (`dist/`), reading the port + lock
 * secret from $YAAC_DATA_DIR/server-local/.server.lock (data dir defaults to
 * ~/.yaac) — so run `pnpm build` + `yaac server restart` first.
 *
 * Run: PROJECT=<slug> [TMUX_SOCK=<worktree tmux socket>] \
 *        node test-playwright-scripts/dead-key-chord-test.js
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

const dataDir = process.env.YAAC_DATA_DIR ?? path.join(os.homedir(), '.yaac')
const lock = JSON.parse(fs.readFileSync(path.join(dataDir, 'server-local', '.server.lock'), 'utf8'))
const origin = `http://127.0.0.1:${lock.port}`
const PROJECT = process.env.PROJECT
if (!PROJECT) throw new Error('set PROJECT=<slug> to a project with a running worktree')

let failures = 0
function check(name, cond, detail = '') {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const res = await fetch(`${origin}/tokens`, {
  method: 'POST',
  headers: { authorization: `Bearer ${lock.secret}`, 'content-type': 'application/json' },
  body: JSON.stringify({ kind: 'one-time' }),
})
const { token } = await res.json()

const pane = () => process.env.TMUX_SOCK
  ? execSync(`tmux -S ${process.env.TMUX_SOCK} capture-pane -p -t yaac`).toString()
  : ''

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 }, bypassCSP: true })).newPage()
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  await page.goto(`${origin}/?project=${PROJECT}&token=${token}`)
  await page.waitForFunction(() => !window.location.search.includes('token='), { timeout: 15_000 })
  // Alt+J steps onto the first sidebar row — once there are rows to step to.
  const term = page.locator('.xterm:visible').first()
  for (let i = 0; i < 30 && !(await term.isVisible()); i++) {
    await page.keyboard.press('Alt+KeyJ')
    await page.waitForTimeout(500)
  }
  await term.waitFor({ state: 'visible', timeout: 30_000 })
  const cdp = await page.context().newCDPSession(page)

  /** What Chrome on a Mac sends for Option+<code> on a dead key. */
  const deadChord = async (code, accent) => {
    await cdp.send('Input.dispatchKeyEvent',
      { type: 'rawKeyDown', key: 'Dead', code, modifiers: 1, windowsVirtualKeyCode: 229 })
    await cdp.send('Input.imeSetComposition', { text: accent, selectionStart: 1, selectionEnd: 1 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Dead', code, modifiers: 1 })
  }
  const focusTerminal = async () => {
    await term.click()
    await page.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'))
  }
  const before = pane()

  // (1) Alt+N from the terminal.
  await focusTerminal()
  await deadChord('KeyN', '˜')
  const prompt = page.getByLabel('Prompt')
  await prompt.waitFor({ state: 'visible' })
  await page.waitForTimeout(100)
  check('Alt+N: no accent in the prompt', (await prompt.inputValue()) === '', JSON.stringify(await prompt.inputValue()))
  check('Alt+N: the prompt keeps focus', await prompt.evaluate((el) => el === document.activeElement))
  await page.keyboard.type('fix')
  check('Alt+N: typing afterwards is exactly what was typed', (await prompt.inputValue()) === 'fix',
    JSON.stringify(await prompt.inputValue()))

  // (4) Option+N inside the open dialog is the user's accent.
  await deadChord('KeyN', '˜')
  await cdp.send('Input.insertText', { text: 'ñ' })
  await page.waitForTimeout(100)
  check('Option+N typed in the open dialog is kept', (await prompt.inputValue()) === 'fixñ',
    JSON.stringify(await prompt.inputValue()))
  await page.keyboard.press('Escape')
  await prompt.waitFor({ state: 'detached' })

  // (2) Alt+E from the terminal.
  await focusTerminal()
  await deadChord('KeyE', '´')
  // The file tree's filter is the input Alt+E focuses.
  const filter = page.locator('input:focus')
  await filter.waitFor({ state: 'visible' })
  await page.waitForTimeout(300)
  check('Alt+E: no accent in the filter', (await filter.inputValue()) === '', JSON.stringify(await filter.inputValue()))
  check('Alt+E: the filter has focus', await filter.evaluate((el) => el === document.activeElement))

  // (3) Nothing reached the agent.
  if (process.env.TMUX_SOCK) {
    const after = pane()
    const leaked = ['˜', '´'].filter((c) => after.split(c).length > before.split(c).length)
    check('no accent reached the PTY', leaked.length === 0, leaked.join(' '))
  }
} finally {
  await browser.close()
}
if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
