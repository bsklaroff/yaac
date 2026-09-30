/*
 * Verifies Alt+N in a real browser, with real keyboard events:
 *
 *  1. Alt+N opens the create dialog (a centered modal, not a popover) with the
 *     cursor already in the Prompt field and Start on "Now".
 *  2. Shift+Enter in the prompt is a newline, not a submit.
 *  3. Typing a prompt then Enter creates: the dialog closes and a provisioning
 *     row appears in the sidebar, and the workspace the server brings up opens
 *     with that prompt as its founding ask (read back from the snapshot).
 *  4. Esc closes the dialog without creating anything.
 *  5. Keys typed the instant the dialog appears all reach the prompt (20
 *     opens) — none fall between the dialog showing and its focus landing.
 *
 * Creates ONE real workspace in the chosen project (check 3), which it leaves
 * running — stop it afterwards.
 *
 * Drives the app the server itself serves (`dist/`), reading the port + lock
 * secret from $YAAC_DATA_DIR/server-local/.server.lock (data dir defaults to
 * ~/.yaac) — so run `pnpm build` + `yaac server restart` first, or you are
 * looking at the frontend as it was. Needs a credential for the project's
 * last-used agent.
 *
 * Run: PROJECT=<slug> node test-playwright-scripts/alt-n-create-dialog-test.js
 * (SCREENSHOT_DIR to capture the dialog; defaults to /tmp/yaac-shots.
 *  playwright is resolved from the global npm root; browsers live under
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
  const candidates = [
    path.join(dataDir, 'server-local', '.server.lock'),
    path.join(dataDir, '.server.lock'),
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'))
  }
  throw new Error(`no .server.lock found (tried ${candidates.join(', ')}) — is the server running?`)
}

let failures = 0
function check(name, cond, detail = '') {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const PROJECT = process.env.PROJECT
if (!PROJECT) throw new Error('set PROJECT=<slug> to the project to create in')
const SHOTS = process.env.SCREENSHOT_DIR ?? '/tmp/yaac-shots'
const lock = readServerLock()
const origin = `http://127.0.0.1:${lock.port}`
const auth = { authorization: `Bearer ${lock.secret}` }

async function mintToken() {
  const res = await fetch(`${origin}/tokens`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'one-time' }),
  })
  if (res.status !== 201) throw new Error(`mint failed: HTTP ${res.status}`)
  return (await res.json()).token
}

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  await page.goto(`${origin}/?project=${PROJECT}&token=${await mintToken()}`)
  await page.waitForFunction(() => !window.location.search.includes('token='), { timeout: 15_000 })
  await page.getByTitle('New workspace').first().waitFor({ state: 'visible', timeout: 15_000 })
  fs.mkdirSync(SHOTS, { recursive: true })

  // (1) Alt+N: the dialog, prompt focused, Start on Now.
  await page.keyboard.press('Alt+KeyN')
  const prompt = page.getByLabel('Prompt')
  await prompt.waitFor({ state: 'visible' })
  check('Alt+N focuses the prompt', await prompt.evaluate((el) => el === document.activeElement))
  check('Start defaults to Now', await page.getByLabel('Start').inputValue() === '')
  const box = await page.getByRole('dialog').boundingBox()
  check('the dialog is centered', box !== null && Math.abs(box.x + box.width / 2 - 700) < 4,
    box ? `center x ${box.x + box.width / 2}` : 'no box')
  await page.screenshot({ path: path.join(SHOTS, 'create-dialog.png') })

  // (4) Esc closes without creating.
  await page.keyboard.press('Escape')
  await prompt.waitFor({ state: 'detached' })
  check('Esc closes the dialog', true)

  // (5) Typing the instant the dialog shows loses nothing: Alt+N, type is
  // the flow it advertises, and the dialog's own focus handling takes a few
  // frames to land on the prompt.
  let lost = 0
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('Alt+KeyN')
    await prompt.waitFor({ state: 'visible' })
    await page.keyboard.type('abcdefghij')
    if ((await prompt.inputValue()) !== 'abcdefghij') lost++
    await page.keyboard.press('Escape')
    await prompt.waitFor({ state: 'detached' })
  }
  check('keys typed as the dialog appears all reach the prompt', lost === 0, `${lost}/20 opens lost keys`)

  // (2) Shift+Enter is a newline.
  await page.keyboard.press('Alt+KeyN')
  await prompt.waitFor({ state: 'visible' })
  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent === 'Create')
    return b !== undefined && !b.disabled
  }, null, { timeout: 15_000 })
  const ask = `playwright alt-n ${Date.now()}`
  await page.keyboard.type(ask)
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('second line')
  check('Shift+Enter inserts a newline', (await prompt.inputValue()) === `${ask}\nsecond line`)

  // (3) Enter creates, with the prompt.
  await page.keyboard.press('Enter')
  await prompt.waitFor({ state: 'detached' })
  check('Enter closes the dialog', true)
  const row = await page.waitForFunction(() => document.querySelector('aside')?.textContent?.includes('New workspace'),
    null, { timeout: 5_000 }).then(() => true, () => false)
  check('a provisioning row appears', row)
  const founded = await (async () => {
    for (let i = 0; i < 90; i++) {
      const list = await (await fetch(`${origin}/api/workspace/list?project=${PROJECT}`, { headers: auth })).json()
      if (list.workspaces.some((w) => (w.prompt ?? '').startsWith(ask))) return true
      await new Promise((r) => setTimeout(r, 2000))
    }
    return false
  })()
  check('the new workspace carries the prompt as its founding ask', founded)
} finally {
  await browser.close()
}
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
