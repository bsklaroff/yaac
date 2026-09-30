/*
 * Verifies that closing the create dialog opened from the sidebar's + ("New
 * workspace") never hands focus back to the + — so no focus ring is left
 * drawn around it — whichever way it closes: Escape, the ×, a click on the
 * backdrop, or Enter (a submit: it creates a real workspace with the empty
 * prompt — stop them afterwards with `yaac workspace stop` — or, with no agent
 * credential, hands off to Settings, which is then dismissed). Each is tried after a
 * mouse click on the + and after keyboard activation (focus it, press Enter),
 * the latter being the path where the browser would draw :focus-visible.
 *
 * Run against the server's own `dist/` (`pnpm build` + `yaac server restart`):
 *   PROJECT=<slug> node test-playwright-scripts/new-workspace-button-focus-test.js
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
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'server-local', '.server.lock'), 'utf8'))
}

let failures = 0
function check(name, cond, detail = '') {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const PROJECT = process.env.PROJECT
if (!PROJECT) throw new Error('set PROJECT=<slug>')
const origin = `http://127.0.0.1:${readServerLock().port}`

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  await page.goto(`${origin}/?project=${PROJECT}`)
  const plus = page.locator('aside').getByRole('button', { name: 'New workspace', exact: true })
  const prompt = page.getByLabel('Prompt')
  await plus.waitFor({ timeout: 15_000 })

  const openers = {
    click: () => plus.click(),
    keyboard: async () => { await plus.focus(); await page.keyboard.press('Enter') },
  }
  const closers = {
    Escape: () => page.keyboard.press('Escape'),
    '×': () => page.getByRole('dialog').getByRole('button', { name: 'Close' }).click(),
    backdrop: () => page.mouse.click(10, 450),
    Enter: async () => {
      await page.keyboard.press('Enter')
      // With no agent credential the submit hands off to Settings instead.
      await page.waitForTimeout(400)
      if (await page.getByRole('dialog').count() > 0) await page.keyboard.press('Escape')
    },
  }
  for (const [how, openIt] of Object.entries(openers)) {
    for (const [by, closeIt] of Object.entries(closers)) {
      await openIt()
      await prompt.waitFor({ state: 'visible' })
      await page.waitForTimeout(250)
      await closeIt()
      await page.getByRole('dialog').waitFor({ state: 'detached' })
      await page.waitForTimeout(250)
      const state = await plus.evaluate((el) => ({
        focused: document.activeElement === el,
        ring: el.matches(':focus-visible'),
        active: document.activeElement?.tagName ?? null,
      }))
      check(`opened by ${how}, closed by ${by}: + not focused, no ring`,
        !state.focused && !state.ring, `activeElement=${state.active}`)
      // A created workspace's terminal takes focus a few seconds on; let it,
      // or it lands mid-way through the next case and passes it falsely.
      if (by === 'Enter') {
        // Polled with evaluate: the app's CSP refuses waitForFunction's eval.
        // No terminal ever comes on the Settings hand-off, hence the cap.
        for (let i = 0; i < 40; i++) {
          if (await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea'))) break
          await page.waitForTimeout(250)
        }
      }
    }
  }
} finally {
  await browser.close()
}
if (failures > 0) { console.log(`\n${failures} check(s) failed`); process.exit(1) }
console.log('\nall checks passed')
