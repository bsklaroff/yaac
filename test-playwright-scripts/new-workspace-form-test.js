/*
 * Verifies the "+ New workspace" form end to end in a real browser, with real
 * keyboard events:
 *
 *  1. The fields sit in order — Prompt, Start, the branch picker, Agent,
 *     Model, Permissions, UI — with a Create button below them.
 *  2. The model field shows a model by its name ("Opus 5.5"), and typing part
 *     of a name or an id filters the suggestions.
 *  3. Changing the agent reloads the other three fields from that agent's own
 *     memory and options (pi's permissions offer only Bypass).
 *  4. Keyboard only: type "sonnet", Enter picks the highlighted suggestion,
 *     Enter again creates — and the sidebar's provisioning row names the
 *     model ("Claude · Sonnet 5") from its first frame, before any agent has
 *     answered.
 *
 * Creates ONE real workspace in the chosen project (check 4), which it leaves
 * running — stop it afterwards.
 *
 * Uses the app the server serves from `dist/` (port from
 * $YAAC_DATA_DIR/server-local/.server.lock, data dir default ~/.yaac), so
 * run `pnpm build` and `yaac server restart` first.
 * Needs a claude credential; pi's check is skipped without one.
 *
 * Run: PROJECT=<slug> node test-playwright-scripts/new-workspace-form-test.js
 * (SCREENSHOT_DIR to capture the form; defaults to /tmp/yaac-shots.
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

const signedIn = new Set(
  (await (await fetch(`${origin}/api/auth/list`)).json()).toolAuth.map((t) => t.tool),
)
if (!signedIn.has('claude')) throw new Error('needs a claude credential')

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  await page.goto(`${origin}/?project=${PROJECT}`)
  fs.mkdirSync(SHOTS, { recursive: true })

  const open = async () => {
    await page.getByTitle('New workspace').first().click()
    await page.getByLabel('Agent').waitFor({ state: 'visible' })
    await page.waitForFunction(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent === 'Create')
      return b !== undefined && !b.disabled
    }, null, { timeout: 15_000 }).catch(() => { /* asserted below */ })
  }

  // (1) Field order.
  await open()
  const order = await page.evaluate(() => {
    const at = (label) => document.querySelector(`[aria-label="${label}"]`)
    const labels = ['Prompt', 'Start', 'Base branch', 'Agent', 'Model', 'Permissions', 'UI']
    const els = labels.map(at)
    const create = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Create')
    const all = [...els, create]
    return all.every(Boolean)
      && all.every((el, i) => i === 0 || (all[i - 1].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING))
  })
  check('prompt, start, branch, agent, model, permissions, UI, then Create', order)
  await page.screenshot({ path: path.join(SHOTS, 'new-workspace-form.png') })

  // (2) Shown by name; searched by name or id.
  await page.getByLabel('Agent').selectOption('claude')
  const shown = await page.getByLabel('Model').inputValue()
  check('the model field shows a name, not an id', !shown.startsWith('claude-'), shown)
  await page.getByLabel('Model').fill('claude-sonn')
  check('an id fragment finds the model by name', await page.getByText('Sonnet 5', { exact: true }).isVisible())
  // The first Escape closes only the suggestion list; the second, the dialog.
  await page.keyboard.press('Escape')
  await page.getByText('Sonnet 5', { exact: true }).waitFor({ state: 'detached' })
  await page.keyboard.press('Escape')
  await page.getByLabel('Prompt').waitFor({ state: 'detached' })

  // (3) Another agent brings its own options.
  if (signedIn.has('pi')) {
    await open()
    await page.getByLabel('Agent').selectOption('pi')
    const postures = await page.getByLabel('Permissions').evaluate((s) => [...s.options].map((o) => o.value))
    check('pi offers only bypass', JSON.stringify(postures) === '["bypass"]', JSON.stringify(postures))
    await page.keyboard.press('Escape')
  } else {
    console.log('SKIP  pi offers only bypass  [no pi credential]')
  }

  // (4) Keyboard only: search, Enter picks, Enter creates.
  await open()
  await page.getByLabel('Agent').selectOption('claude')
  await page.getByLabel('Model').click()
  await page.getByLabel('Model').fill('sonnet')
  await page.keyboard.press('Enter')
  check('Enter picks the highlighted model', await page.getByLabel('Model').inputValue() === 'Sonnet 5')
  await page.keyboard.press('Enter')
  const label = await page.waitForFunction(() => {
    const aside = document.querySelector('aside')
    return [...(aside?.querySelectorAll('span') ?? [])]
      .map((s) => (s.textContent ?? '').trim())
      .find((t) => t === 'Claude · Sonnet 5') ?? false
  }, null, { timeout: 3_000 }).then(() => true, () => false)
  check('the provisioning row names the model from its first frame', label)
  await page.screenshot({ path: path.join(SHOTS, 'new-workspace-provisioning.png') })
} finally {
  await browser.close()
}
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
