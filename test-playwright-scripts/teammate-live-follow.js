/*
 * Verifies that a teammate follows another user's running claude workspace
 * live in the read-only pane (`/acp/observe`, docs/multi-user.md
 * "Following a teammate's conversation"), in both `acp` and `tui` modes:
 *
 *  1. While the owner's agent waits on a permission ask, the reader's pane
 *     says "Waiting for <owner>'s answer" and offers no buttons.
 *  2. Once the owner answers in their own browser, the reader sees the tool
 *     call running, without reloading.
 *  3. When the turn ends the reader sees the final reply and no working
 *     marker, and the reader made no write the server refused.
 *  4. Once the owner stops the workspace, the reader's pane shows its final
 *     record and keeps no socket open.
 *
 * This drives a REAL claude (haiku; costs a cent or two per mode), so it
 * needs a server in `tailnet` mode whose OWNER has working claude
 * credentials and a project, e.g. inside a yaac workspace (outside one,
 * drop the `env -u YAAC_WORKSPACE_ID`):
 *
 *   export YAAC_DATA_DIR=~/.yaac-dev YAAC_SERVER_PORT=8890
 *   node dist/cli.js server start && node dist/cli.js auth fake claude-oauth github
 *   node dist/cli.js project add <url> <cred>
 *   node dist/cli.js server stop
 *   env -u YAAC_WORKSPACE_ID node dist/cli.js server start \
 *     --tailnet srv.tailnet.ts.net --owner alice@example.com
 *
 * Run:
 *   APP_URL=http://127.0.0.1:8890 PROJECT=<project id> [MODES=acp,tui] \
 *     node test-playwright-scripts/teammate-live-follow.js
 *
 * Screenshots: $SCREENSHOT_DIR/teammate-follow-<mode>-*.png (default
 * /tmp/yaac-shots).
 */
import { SHOTS, check, finish, requirePlaywright, until } from './lib.js'

const ORIGIN = (process.env.APP_URL ?? 'http://127.0.0.1:8890').replace(/\/$/, '')
const PROJECT = process.env.PROJECT
const MODES = (process.env.MODES ?? 'acp,tui').split(',')
const OWNER = { login: process.env.OWNER ?? 'alice@example.com', name: process.env.OWNER_NAME ?? 'Alice' }
const READER = { login: 'bob@example.com', name: 'Bob' }
const RUN = Date.now().toString(36).slice(-4)

const headersFor = (who) => ({
  'Tailscale-User-Login': who.login,
  'Tailscale-User-Name': who.name,
  'X-Forwarded-For': '100.64.0.1',
})

async function apiAs(who, route, body) {
  const res = await fetch(`${ORIGIN}/api${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...headersFor(who) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`/api${route}: HTTP ${res.status} ${text}`)
  return text ? JSON.parse(text.trim().split('\n').at(-1)) : null
}

/** The reader's main pane text. */
const paneText = (page) => page.evaluate(() => document.querySelector('main')?.innerText ?? document.body.innerText)

async function waitText(page, re, timeoutMs) {
  await until(page, (src) => new RegExp(src).test(document.querySelector('main')?.innerText ?? document.body.innerText),
    re.source, timeoutMs)
}

async function follow(browser, mode) {
  const marker = `FOLLOWED-${mode}-${RUN}`
  // claude allows a plain `sleep` without asking but refuses it in the
  // foreground, so the wait is a `tail` cut off by `timeout`, and the `rm`
  // outside the checkout is what makes it ask.
  const prompt = `Use the Bash tool, in the foreground, to run exactly this one command:`
    + ` timeout 25 tail -f /dev/null || true; rm -rf /tmp/${marker}`
    + ` . After it finishes, reply with just the word DONE-${RUN}.`
  const created = await apiAs(OWNER, '/workspace/create', {
    project: PROJECT, tool: 'claude', mode, model: 'haiku', permissionMode: 'accept-edits', prompt,
    title: `follow ${mode} ${RUN}`,
  })
  if (created?.type !== 'result') throw new Error(`create failed: ${JSON.stringify(created)}`)
  const workspaceId = created.result.workspaceId
  console.log(`[${mode}] workspace ${workspaceId}`)
  /** How often the agent's reply shows, past the prompt that names it. */
  const replies = (text) => text.split(`DONE-${RUN}`).length - 2
  const shot = (page, name) => page.screenshot({ path: `${SHOTS}/teammate-follow-${mode}-${name}.png` })

  const ctx = (who) => browser.newContext({ extraHTTPHeaders: headersFor(who), viewport: { width: 1400, height: 900 } })
  const owner = await (await ctx(OWNER)).newPage()
  const readerCtx = await ctx(READER)
  const reader = await readerCtx.newPage()
  const refused = []
  reader.on('response', (r) => { if (r.status() === 403) refused.push(r.url()) })
  const sockets = []
  reader.on('websocket', (ws) => {
    const entry = { url: ws.url(), closed: false, frames: [] }
    ws.on('framereceived', (f) => entry.frames.push(String(f.payload).slice(0, 200)))
    ws.on('close', () => { entry.closed = true })
    sockets.push(entry)
  })
  const deep = `${ORIGIN}/?project=${PROJECT}&workspace=${workspaceId}`
  await owner.goto(deep)
  await reader.goto(deep)

  // 1. The ask, as the reader sees it. A tui history records the call but
  // not the ask, so there the words come from the snapshot's `asking`.
  const waiting = new RegExp(`Waiting for ${OWNER.name}'s answer`)
  if (mode === 'acp') await waitText(reader, waiting, 180_000)
  else {
    await waitText(reader, /1 tool call|timeout 25 tail/, 180_000)
    await reader.waitForTimeout(5000)
    check(`[${mode}] the reader is told the agent waits on ${OWNER.name}`, waiting.test(await paneText(reader)))
  }
  const observe = sockets.filter((s) => s.url.includes('/api/acp/observe'))
  check(`[${mode}] the reader follows over /acp/observe, never /acp/attach`,
    observe.length > 0 && !sockets.some((s) => s.url.includes('/api/acp/attach')),
    sockets.map((s) => s.url.replace(ORIGIN, '')).join(', '))
  if (mode === 'acp') {
    await waitText(reader, /timeout 25 tail/, 30_000)
    const buttons = await reader.locator('main button', { hasText: /^(Yes|No|Allow|Always|Reject|Deny)\b/ }).count()
    check(`[${mode}] the reader's ask card has no answer buttons`, buttons === 0, `${buttons} buttons`)
  }
  await shot(reader, '1-ask')

  // 2. The owner answers; the reader sees the call run.
  if (mode === 'acp') {
    const allow = owner.locator('main button', { hasText: /^(Yes|Allow)$/ }).first()
    await allow.waitFor({ timeout: 60_000 })
    await allow.click()
  } else {
    const term = owner.locator('.xterm').first()
    await term.waitFor({ timeout: 60_000 })
    await term.click()
    await owner.keyboard.press('Enter')
  }
  await until(reader, (src) => !new RegExp(src).test(document.querySelector('main')?.innerText ?? ''),
    waiting.source, 60_000)
  await reader.waitForTimeout(mode === 'tui' ? 8000 : 3000)
  const during = await paneText(reader)
  check(`[${mode}] the reader sees the call run once answered, without reloading`,
    /timeout 25 tail/.test(during) && replies(during) === 0 && !/interrupted|never answered/i.test(during))
  await shot(reader, '2-running')

  // 3. The finished turn.
  await until(reader, (src) => (document.querySelector('main')?.innerText ?? '').split(src).length > 2,
    `DONE-${RUN}`, 180_000)
  await reader.waitForTimeout(1500)
  const after = await paneText(reader)
  check(`[${mode}] the reader sees the final reply`, replies(after) === 1)
  check(`[${mode}] the ask no longer shows as waiting`, !waiting.test(after))
  check(`[${mode}] the reader made no refused write`, refused.length === 0, refused.join(', '))
  await shot(reader, '3-done')

  // 4. The owner stops it; the reader's stream closes and the record shows.
  await apiAs(OWNER, '/workspace/stop', { workspaceId })
  await reader.waitForTimeout(8000)
  const open = sockets.filter((s) => s.url.includes('/api/acp/observe') && !s.closed)
  check(`[${mode}] no observe socket stays open after the stop`, open.length === 0, `${open.length} open`)
  const stopped = await paneText(reader)
  check(`[${mode}] the stopped pane still shows the reply`, replies(stopped) === 1)
  await shot(reader, '4-stopped')
  await owner.context().close()
  await readerCtx.close()
}

async function main() {
  if (!PROJECT) throw new Error('set PROJECT to a project id the OWNER owns')
  await apiAs(READER, '/whoami')
  const { chromium } = requirePlaywright()
  const browser = await chromium.launch()
  try {
    for (const mode of MODES) await follow(browser, mode)
  } finally {
    await browser.close()
  }
  finish()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
