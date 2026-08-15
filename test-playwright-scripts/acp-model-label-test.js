/*
 * Verifies that an ACP-mode worktree surfaces the model it is answering as,
 * in both places the label appears — the sidebar row and the chat pane's tab.
 *
 * The tui path is covered by unit tests and is easy to drive by hand; the acp
 * path is the one that needs a real browser, because the conversation only
 * exists as a live JSON-RPC session and its model is read from the transcript
 * the adapter writes underneath it. What this pins:
 *
 *  1. Before the agent has answered, both surfaces read the bare tool name.
 *     An ACP conversation is registered the moment `session/new` returns —
 *     well before any model has spoken — so "registered" must not be mistaken
 *     for "has a model".
 *  2. After one turn, both surfaces read `<Tool> · <Model>` (e.g.
 *     "Claude · Opus 5"). This is the whole point: the model is read from the
 *     transcript, and an ACP conversation is the tool's own SDK writing the
 *     same file its TUI would.
 *
 * The label lands on the next reconcile sweep rather than with the reply, so
 * this waits for it (up to ~2 resync ticks) instead of asserting immediately.
 *
 * Drives the app the server itself serves (`dist/`), reading the port + lock
 * secret from $YAAC_DATA_DIR/.server.lock — so run `pnpm build` +
 * `yaac server restart` first, or you are looking at the frontend as it was.
 *
 * Needs a running `yaac server` with a live ACP-mode worktree of the selected
 * project — `yaac worktree create <project> --tool claude --mode acp` — whose
 * agent has NOT yet answered (check 1 asserts the empty state), and spends one
 * small prompt turn on it.
 *
 * NOTE: a worktree created while the server was already up may be watched by
 * the tui driver instead of the acp one — `StatusWatcherManager.sync` keeps the
 * first watcher it made for a worktree, so a mode learned later never takes
 * effect. `yaac server restart` re-syncs from the recorded marker and attaches
 * the ACP driver. Symptom: no socat process against the worktree's acpd
 * socket, and the pane never leaves "No messages yet".
 *
 * Run: node test-playwright-scripts/acp-model-label-test.js
 * (SCREENSHOT_DIR to capture the surfaces; defaults to /tmp/yaac-shots.
 *  WORKTREE_ID to pick one when the project has several.)
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
  throw new Error(`no .server.lock found (tried ${candidates.join(', ')}) — is the server running?`)
}

/**
 * Poll an in-page predicate until it holds. Not `page.waitForFunction`: the
 * served app sends a script-src CSP with no `unsafe-eval`, and that API
 * compiles its predicate with `new Function` inside the page. `page.evaluate`
 * goes through the debugger instead, which the CSP does not govern.
 */
async function until(page, fn, arg, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await page.evaluate(fn, arg)) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${fn.name || 'condition'}`)
    await page.waitForTimeout(1000)
  }
}

let failures = 0
function check(name, cond, detail = '') {
  const mark = cond ? 'PASS' : 'FAIL'
  if (!cond) failures++
  console.log(`${mark}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const SHOTS = process.env.SCREENSHOT_DIR ?? '/tmp/yaac-shots'
const lock = readServerLock()
const origin = `http://127.0.0.1:${lock.port}`

async function mintToken() {
  const res = await fetch(`${origin}/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${lock.secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'one-time' }),
  })
  if (res.status !== 201) throw new Error(`mint failed: HTTP ${res.status}`)
  return (await res.json()).token
}

/** The live ACP worktree to drive: the one named, else the first the server
 *  reports whose primary conversation is acp-mode. */
async function pickWorktree() {
  const res = await fetch(`${origin}/worktree/list`, {
    headers: { authorization: `Bearer ${lock.secret}` },
  })
  if (!res.ok) throw new Error(`worktree list failed: HTTP ${res.status}`)
  const { worktrees } = await res.json()
  const acp = worktrees.filter((w) => w.agentSessions.some((a) => a.mode === 'acp' && a.active))
  const wanted = process.env.WORKTREE_ID
  const found = wanted
    ? acp.find((w) => w.worktreeId.startsWith(wanted))
    : acp[0]
  if (!found) {
    throw new Error(
      `no live acp worktree found${wanted ? ` matching ${wanted}` : ''} — create one with `
      + '`yaac worktree create <project> --mode acp`',
    )
  }
  return found
}

/**
 * The two places the label is rendered, read out of the DOM.
 *
 * Neither is marked with anything, so both are found by shape — the label's
 * own text — and told apart by which side of the sidebar they sit on. That is
 * the point: a test that queried a test id would pass even if the label were
 * rendered somewhere the user never looks.
 */
function readLabels() {
  return () => {
    const LABEL = /^(Claude|Codex|OpenCode|Pi)( · .+)?$/
    const aside = document.querySelector('aside')
    const text = (el) => (el.textContent ?? '').trim()
    // The sidebar row's meta line: the last matching span inside the sidebar,
    // which is where the row puts it (the title runs full-width above it).
    const sidebar = [...(aside?.querySelectorAll('span') ?? [])]
      .map(text).filter((t) => LABEL.test(t)).pop()
    // The pane's tab strip: the same shape, outside the sidebar.
    const tab = [...document.querySelectorAll('button')]
      .filter((b) => !aside?.contains(b))
      .map(text).find((t) => LABEL.test(t))
    return { tab: tab ?? null, sidebar: sidebar ?? null }
  }
}

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const worktree = await pickWorktree()
  console.log(`driving acp worktree ${worktree.worktreeId}`)

  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await ctx.newPage()
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))

  const token = await mintToken()
  await page.goto(
    `${origin}/?project=${worktree.projectSlug}&worktree=${worktree.worktreeId}&token=${token}`,
  )
  await page.waitForFunction(() => !window.location.search.includes('token='), { timeout: 15_000 })
  await page.locator('textarea[placeholder]').first().waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(2000)

  fs.mkdirSync(SHOTS, { recursive: true })

  // (1) Registered, but nothing has answered yet — the bare tool name.
  const before = await page.evaluate(readLabels())
  check('sidebar reads the bare tool name before any reply', before.sidebar === 'Claude',
    JSON.stringify(before.sidebar))
  check('pane tab reads the bare tool name before any reply', before.tab === 'Claude',
    JSON.stringify(before.tab))
  await page.screenshot({ path: path.join(SHOTS, 'acp-model-before.png') })

  // One small turn, sent through the pane the user would use.
  const box = page.locator('textarea[placeholder]').first()
  await box.click()
  await box.fill('Reply with exactly the word ok and nothing else.')
  await page.getByRole('button', { name: 'Send' }).click()

  // The reply lands in the pane first; the label follows on the next reconcile
  // sweep, which is why this waits rather than asserting straight after.
  await until(page, () => {
    const t = document.body.textContent ?? ''
    return /\bok\b/i.test(t)
  }, null, 120_000)
  console.log('  agent replied')

  await until(page, () => {
    const ok = (s) => typeof s === 'string' && / · /.test(s)
    const tab = [...document.querySelectorAll('button')]
      .map((b) => (b.textContent ?? '').trim())
      .find((t) => /^(Claude|Codex|OpenCode|Pi) · .+$/.test(t))
    return ok(tab)
  }, null, 180_000)

  // (2) Both surfaces now name the model.
  const after = await page.evaluate(readLabels())
  const shaped = (s) => typeof s === 'string' && /^Claude · \S/.test(s)
  check('sidebar names the model after a reply', shaped(after.sidebar), JSON.stringify(after.sidebar))
  check('pane tab names the model after a reply', shaped(after.tab), JSON.stringify(after.tab))
  check('both surfaces agree', after.sidebar === after.tab,
    `${after.sidebar} vs ${after.tab}`)
  await page.screenshot({ path: path.join(SHOTS, 'acp-model-after.png') })
  console.log(`  labels: sidebar=${JSON.stringify(after.sidebar)} tab=${JSON.stringify(after.tab)}`)
  console.log(`  screenshots in ${SHOTS}`)
} catch (err) {
  failures++
  console.error(`FAIL  ${err.message}`)
} finally {
  await browser.close()
}

process.exit(failures === 0 ? 0 : 1)
