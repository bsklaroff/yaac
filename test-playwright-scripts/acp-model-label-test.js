/*
 * Verifies that an ACP workspace shows the model it is using in the sidebar
 * row and the chat pane's tab:
 *
 *  1. Before the agent has answered, both show only the tool name (the
 *     conversation exists from `session/new`, before any model has spoken).
 *  2. After one turn, both show `<Tool> · <Model>` (e.g. "Claude · Opus 5"),
 *     read from the transcript the adapter writes.
 *
 * The label updates on the next reconcile sweep, so the script waits for it.
 *
 * Uses the app the server serves from `dist/` (port from
 * $YAAC_DATA_DIR/.server.lock), so run `pnpm build` and `yaac server
 * restart` first.
 *
 * Needs a running `yaac server` with a live ACP workspace in the selected
 * project (`yaac workspace create <project> --tool claude --mode acp`) whose
 * agent has not answered yet, and sends it one small prompt.
 *
 * If the pane stays on "No messages yet", the workspace may be watched as tui:
 * `StatusWatcherManager.sync` keeps a workspace's first watcher. `yaac server
 * restart` fixes it.
 *
 * Run: node test-playwright-scripts/acp-model-label-test.js
 * (SCREENSHOT_DIR to capture the surfaces; defaults to /tmp/yaac-shots.
 *  WORKSPACE_ID to pick one when the project has several.)
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
 * Poll an in-page predicate until it holds. Not `page.waitForFunction`,
 * which needs `unsafe-eval` and the app's CSP forbids it.
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

/** The ACP workspace to drive: WORKSPACE_ID, else the first acp one listed. */
async function pickWorkspace() {
  const res = await fetch(`${origin}/api/workspace/list`)
  if (!res.ok) throw new Error(`workspace list failed: HTTP ${res.status}`)
  const { workspaces } = await res.json()
  const acp = workspaces.filter((w) => w.agentSessions.some((a) => a.mode === 'acp' && a.active))
  const wanted = process.env.WORKSPACE_ID
  const found = wanted
    ? acp.find((w) => w.workspaceId.startsWith(wanted))
    : acp[0]
  if (!found) {
    throw new Error(
      `no live acp workspace found${wanted ? ` matching ${wanted}` : ''} — create one with `
      + '`yaac workspace create <project> --mode acp`',
    )
  }
  return found
}

/**
 * The two rendered labels, found by their text and told apart by whether
 * they are inside the sidebar.
 */
function readLabels() {
  return () => {
    const LABEL = /^(Claude|Codex|OpenCode|Pi)( · .+)?$/
    const aside = document.querySelector('aside')
    const text = (el) => (el.textContent ?? '').trim()
    // The sidebar row's meta line: the last matching span in the sidebar.
    const sidebar = [...(aside?.querySelectorAll('span') ?? [])]
      .map(text).filter((t) => LABEL.test(t)).pop()
    const tab = [...document.querySelectorAll('button')]
      .filter((b) => !aside?.contains(b))
      .map(text).find((t) => LABEL.test(t))
    return { tab: tab ?? null, sidebar: sidebar ?? null }
  }
}

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const workspace = await pickWorkspace()
  console.log(`driving acp workspace ${workspace.workspaceId}`)

  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await ctx.newPage()
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))

  await page.goto(
    `${origin}/?project=${workspace.projectSlug}&workspace=${workspace.workspaceId}`,
  )
  await page.locator('textarea[placeholder]').first().waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(2000)

  fs.mkdirSync(SHOTS, { recursive: true })

  // (1) Nothing has answered yet: the tool name only.
  const before = await page.evaluate(readLabels())
  check('sidebar reads the bare tool name before any reply', before.sidebar === 'Claude',
    JSON.stringify(before.sidebar))
  check('pane tab reads the bare tool name before any reply', before.tab === 'Claude',
    JSON.stringify(before.tab))
  await page.screenshot({ path: path.join(SHOTS, 'acp-model-before.png') })

  const box = page.locator('textarea[placeholder]').first()
  await box.click()
  await box.fill('Reply with exactly the word ok and nothing else.')
  await page.getByRole('button', { name: 'Send' }).click()

  // The label follows the reply on the next reconcile sweep.
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
