/*
 * Verifies that a half-typed ACP message survives leaving the chat pane, in
 * real Chromium against a live ACP workspace:
 *   - a draft survives switching to another pane (which unmounts the chat
 *     pane, as asserted) and back;
 *   - it survives a page reload (persisted to localStorage);
 *   - a message the agent received does not come back as a draft;
 *   - but the same words retyped and not sent do stay, since nothing was in
 *     flight.
 *
 * Needs a running `yaac server` with a live ACP workspace in the selected
 * project (`yaac workspace create <project> --tool claude --mode acp`), and
 * sends it one small prompt. Reads the port from $YAAC_DATA_DIR/.server.lock
 * (default ~/.yaac), like .claude/skills/run-yaac/driver.mjs.
 *
 * Run: node test-playwright-scripts/acp-draft-persistence-test.js
 * (set SCREENSHOT_DIR to also drop PNGs of the restored states.)
 * (playwright is resolved from the global npm root; browsers live under
 * /opt/playwright-browsers)
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
  const candidates = [
    process.env.YAAC_DATA_DIR && path.join(process.env.YAAC_DATA_DIR, '.server.lock'),
    path.join(os.homedir(), '.yaac', '.server.lock'),
  ].filter(Boolean)
  for (const p of candidates) {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'))
  }
  throw new Error('no .server.lock found — is the server running?')
}

// Either placeholder: the box says "Reconnecting…" until the socket attaches.
const CHAT = 'textarea[placeholder="Message the agent…"], textarea[placeholder="Reconnecting…"]'
// The chat pane's tab, scoped to a tab wrapper so it cannot match the
// header's chip with the same label.
const AGENT_TAB = '.group\\/tab button:text-is("Agent")'
const DRAFT = 'a message I was halfway through typing'

const failures = []
function check(ok, label, detail = '') {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

async function main() {
  const { chromium } = requirePlaywright()
  const lock = readServerLock()
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  const shotDir = process.env.SCREENSHOT_DIR
  const shot = async (name) => {
    if (!shotDir) return
    const out = path.join(shotDir, `${name}.png`)
    await page.screenshot({ path: out })
    console.log(`  screenshot → ${out}`)
  }

  await page.goto(`http://127.0.0.1:${lock.port}/`)
  // Wait for the workspace to arrive in the /events snapshot.
  await page.waitForTimeout(4000)

  const chat = page.locator(CHAT)
  await chat.waitFor({ state: 'visible', timeout: 20_000 })
  check(true, 'the ACP workspace opens on its chat pane')

  // Tabs view shows one pane at a time, so switching unmounts the other.
  await page.keyboard.press('Alt+Comma')
  await page.waitForTimeout(500)

  await chat.fill(DRAFT)
  await page.waitForTimeout(200)
  check(await chat.inputValue() === DRAFT, 'the draft is in the box')
  await shot('acp-draft-typed')

  // Alt+G opens the Changes pane, unmounting the chat pane.
  await page.keyboard.press('Alt+g')
  await page.waitForTimeout(1500)
  check(await page.locator(CHAT).count() === 0, 'leaving the pane unmounts the chat pane')

  await page.locator(AGENT_TAB).first().click()
  await page.waitForTimeout(1500)
  check(
    await page.locator(CHAT).inputValue() === DRAFT,
    'the draft is still there on return',
    `box holds ${JSON.stringify(await page.locator(CHAT).inputValue().catch(() => null))}`,
  )
  await shot('acp-draft-restored')

  // After a reload the draft comes from localStorage. The active tab is not
  // persisted, so click back to the chat.
  await page.reload()
  await page.waitForTimeout(5000)
  await page.locator(AGENT_TAB).first().click()
  await page.locator(CHAT).waitFor({ state: 'visible', timeout: 20_000 })
  check(
    await page.locator(CHAT).inputValue() === DRAFT,
    'the draft survives a page reload',
    `box holds ${JSON.stringify(await page.locator(CHAT).inputValue().catch(() => null))}`,
  )

  // A received message must not come back as a draft.
  await page.locator(CHAT).fill('reply with just the word pong')
  await page.keyboard.press('Enter')
  // Polled here: waitForFunction needs 'unsafe-eval', which the CSP forbids.
  let cleared = false
  for (let i = 0; i < 60 && !cleared; i++) {
    cleared = await page.locator(CHAT).inputValue() === ''
    if (!cleared) await page.waitForTimeout(1000)
  }
  check(cleared, 'sending clears the box once the server echoes the message')
  await shot('acp-draft-sent')

  await page.keyboard.press('Alt+g')
  await page.waitForTimeout(1000)
  await page.locator(AGENT_TAB).first().click()
  await page.waitForTimeout(2000)
  check(
    await page.locator(CHAT).inputValue() === '',
    'a delivered message does not come back as a draft',
    `box holds ${JSON.stringify(await page.locator(CHAT).inputValue().catch(() => null))}`,
  )
  await shot('acp-draft-after-send')

  // The same words retyped and not sent must stay: short replies repeat,
  // and matching history alone would wrongly clear them.
  await page.locator(CHAT).fill('reply with just the word pong')
  await page.waitForTimeout(300)
  await page.keyboard.press('Alt+g')
  await page.waitForTimeout(1000)
  await page.locator(AGENT_TAB).first().click()
  await page.waitForTimeout(2000)
  check(
    await page.locator(CHAT).inputValue() === 'reply with just the word pong',
    'retyping an already-sent message keeps it — it was never handed to the socket',
    `box holds ${JSON.stringify(await page.locator(CHAT).inputValue().catch(() => null))}`,
  )
  await shot('acp-draft-retyped')

  await browser.close()
  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed: ${failures.join('; ')}`)
    process.exit(1)
  }
  console.log('\nACP chat drafts survive leaving the pane.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
