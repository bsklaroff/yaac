/*
 * Verifies that a half-typed ACP message survives leaving the chat pane, in
 * real Chromium against a live ACP worktree:
 *   - typing a draft, switching to another pane (which UNMOUNTS the chat pane —
 *     asserted, since that unmount is the whole reason the draft needs a home
 *     outside component state), and coming back restores the text;
 *   - a full page reload restores it too (the store persists it to
 *     localStorage);
 *   - a message the agent actually received does NOT come back as a draft —
 *     the pane settles a restored in-flight message against the replayed
 *     history on attach;
 *   - but retyping those same words without sending them keeps them, since
 *     nothing was in flight (the trap plain history-matching falls into).
 *
 * Needs a running `yaac server` with a live ACP-mode worktree of the selected
 * project — `yaac worktree create <project> --tool claude --mode acp` — and
 * spends one small prompt turn on the agent. Reads the port + lock secret from
 * $YAAC_DATA_DIR/.server.lock (falling back to ~/.yaac) exactly like
 * .claude/skills/run-yaac/driver.mjs.
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

async function mintToken(lock) {
  const res = await fetch(`http://127.0.0.1:${lock.port}/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${lock.secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'one-time' }),
  })
  if (res.status !== 201) throw new Error(`token mint failed: HTTP ${res.status}`)
  return (await res.json()).token
}

// Either placeholder — the box says "Reconnecting…" until the socket attaches.
const CHAT = 'textarea[placeholder="Message the agent…"], textarea[placeholder="Reconnecting…"]'
// The chat pane's tab in the strip. Scoped to a tab wrapper so it can't match
// the header's own "Changes" chip, which carries the same label.
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

  const token = await mintToken(lock)
  await page.goto(`http://127.0.0.1:${lock.port}/?token=${token}`)
  await page.waitForFunction(() => !window.location.search.includes('token='), { timeout: 15_000 })
  // Wait for the worktree's workspace (the pushed /events snapshot) to arrive.
  await page.waitForTimeout(4000)

  const chat = page.locator(CHAT)
  await chat.waitFor({ state: 'visible', timeout: 20_000 })
  check(true, 'the ACP worktree opens on its chat pane')

  // Tabs view: one pane at a time, so switching panes tears the other down —
  // the same unmount a column close or a worktree switch causes, reached with
  // a single keystroke.
  await page.keyboard.press('Alt+Comma')
  await page.waitForTimeout(500)

  await chat.fill(DRAFT)
  await page.waitForTimeout(200)
  check(await chat.inputValue() === DRAFT, 'the draft is in the box')
  await shot('acp-draft-typed')

  // Alt+C opens the Changes pane; in tabs view it becomes the visible tab and
  // the chat pane is unmounted outright.
  await page.keyboard.press('Alt+c')
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

  // A reload is the harder case: nothing of the pane survives it, so this is
  // the persisted copy coming back. Which tab is *visible* after a reload is a
  // separate question — the active tab is in-memory state, so the workspace
  // comes back showing its first pane — hence the click back to the chat.
  await page.reload()
  await page.waitForTimeout(5000)
  await page.locator(AGENT_TAB).first().click()
  await page.locator(CHAT).waitFor({ state: 'visible', timeout: 20_000 })
  check(
    await page.locator(CHAT).inputValue() === DRAFT,
    'the draft survives a page reload',
    `box holds ${JSON.stringify(await page.locator(CHAT).inputValue().catch(() => null))}`,
  )

  // A message the agent actually received must not come back as a draft when
  // the pane is mounted again — the box is cleared by the server's echo, and
  // the restored-draft reconcile keeps it clear.
  await page.locator(CHAT).fill('reply with just the word pong')
  await page.keyboard.press('Enter')
  // Polled from here rather than with waitForFunction: the app's CSP has no
  // 'unsafe-eval', and that is how Playwright injects a page-side predicate.
  let cleared = false
  for (let i = 0; i < 60 && !cleared; i++) {
    cleared = await page.locator(CHAT).inputValue() === ''
    if (!cleared) await page.waitForTimeout(1000)
  }
  check(cleared, 'sending clears the box once the server echoes the message')
  await shot('acp-draft-sent')

  await page.keyboard.press('Alt+c')
  await page.waitForTimeout(1000)
  await page.locator(AGENT_TAB).first().click()
  await page.waitForTimeout(2000)
  check(
    await page.locator(CHAT).inputValue() === '',
    'a delivered message does not come back as a draft',
    `box holds ${JSON.stringify(await page.locator(CHAT).inputValue().catch(() => null))}`,
  )
  await shot('acp-draft-after-send')

  // Typing the SAME words again, without sending: short replies repeat ("ok",
  // "yes", "retry"), and the conversation's history says the last thing the
  // user said was exactly this — but nothing is in flight, so that says
  // nothing about the text now in the box.
  await page.locator(CHAT).fill('reply with just the word pong')
  await page.waitForTimeout(300)
  await page.keyboard.press('Alt+c')
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
