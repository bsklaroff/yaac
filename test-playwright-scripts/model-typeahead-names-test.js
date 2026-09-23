/*
 * Verifies the "+ New worktree" form's model suggestions show each model's
 * human-readable name in full: in the popover's narrow model column, the long
 * model id beside a name must truncate first, never the name itself.
 *
 * For every signed-in agent, opens the form, types into the Model field, and
 * checks that no suggestion row's name is clipped (scrollWidth > clientWidth)
 * while its id still gets whatever room is left. Creates nothing.
 *
 * Drives the app the server itself serves (`dist/`), reading the port + lock
 * secret from $YAAC_DATA_DIR/server-local/.server.lock (data dir defaults to
 * ~/.yaac) — so run `pnpm build` + `yaac server restart` first.
 *
 * Run: PROJECT=<slug> node test-playwright-scripts/model-typeahead-names-test.js
 * (SCREENSHOT_DIR to capture each list; defaults to /tmp/yaac-shots.
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

const dataDir = process.env.YAAC_DATA_DIR ?? path.join(os.homedir(), '.yaac')
const lock = JSON.parse(fs.readFileSync(path.join(dataDir, 'server-local', '.server.lock'), 'utf8'))
const origin = `http://127.0.0.1:${lock.port}`
const auth = { authorization: `Bearer ${lock.secret}` }

let failures = 0
function check(name, cond, detail = '') {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const PROJECT = process.env.PROJECT
if (!PROJECT) throw new Error('set PROJECT=<slug> to the project to open')
const SHOTS = process.env.SCREENSHOT_DIR ?? '/tmp/yaac-shots'

const minted = await fetch(`${origin}/tokens`, {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify({ kind: 'one-time' }),
})
if (minted.status !== 201) throw new Error(`mint failed: HTTP ${minted.status}`)
const token = (await minted.json()).token
const tools = (await (await fetch(`${origin}/auth/list`, { headers: auth })).json()).toolAuth.map((t) => t.tool)
if (tools.length === 0) throw new Error('needs at least one agent credential')

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  await page.goto(`${origin}/?project=${PROJECT}&token=${token}`)
  await page.waitForFunction(() => !window.location.search.includes('token='), { timeout: 15_000 })
  fs.mkdirSync(SHOTS, { recursive: true })

  for (const tool of tools) {
    await page.getByTitle('New worktree').first().click()
    await page.getByLabel('Agent').selectOption(tool)
    // One letter every name/id shares enough of to fill the list.
    await page.getByLabel('Model').fill('a')
    await page.locator('li button').first().waitFor({ state: 'visible' })
    const rows = await page.locator('li button').evaluateAll((buttons) => buttons.map((b) => {
      const [name, id] = [...b.querySelectorAll(':scope > span')]
      return {
        name: name.textContent,
        clipped: name.scrollWidth > name.clientWidth,
        idShown: (id?.textContent ?? '') === '' || id.clientWidth > 0,
      }
    }))
    await page.screenshot({ path: path.join(SHOTS, `model-typeahead-${tool}.png`) })
    const clipped = rows.filter((r) => r.clipped).map((r) => r.name)
    check(`${tool}: every model name is shown in full`, clipped.length === 0, clipped.join(', '))
    check(`${tool}: ids still get the room left over`, rows.every((r) => r.idShown))
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
  }
} finally {
  await browser.close()
}
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
