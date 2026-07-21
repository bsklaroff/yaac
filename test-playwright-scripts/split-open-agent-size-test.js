#!/usr/bin/env node
/*
 * split-open-agent-size-test.js
 *
 * Verifies that a session opening straight into a side-by-side split does NOT
 * leave the agent's tmux window stuck wider than its pane. The webapp view
 * pins its window under `window-size manual` + resize-window (pty-bridge
 * attachArgs); on a fresh session the agent pane first attaches at full width,
 * then the terminals query splits the layout and shrinks the pane. The attach's
 * own resize-window (at the pre-split width) can land AFTER the client's
 * follow-up resize frame, leaving the agent window pinned wide — its output
 * clipped on the right and its bottom prompt wrong — until the next resize
 * ("stays wrong until I act"). SessionTerminal re-sends its grid size when the
 * attach settles, which lands last and re-pins the window to the pane.
 *
 * A regression shows up as the agent (claude) tmux window width != the client
 * xterm cols after the split settles, while a post-split shell window is the
 * correct (narrow) width.
 *
 * Flow: create a fresh session, open the webapp in tiles mode selecting it,
 * split the agent pane during its cold boot (POST a scratch shell), let it
 * settle, then read the pod's tmux window widths via kubectl and compare to
 * the client grid. Screenshot -> /tmp/yaac-shots/split-open-agent-size.png.
 * Prints PASS/FAIL.
 *
 * Run (needs a wired cluster + running server; creates and deletes one session):
 *   node test-playwright-scripts/split-open-agent-size-test.js
 */
import { execSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync('/opt/playwright-browsers')) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/playwright-browsers'
}
const pw = (() => {
  try { return require('playwright') } catch {
    return require(path.join(execSync('npm root -g').toString().trim(), 'playwright'))
  }
})()
function readLock() {
  for (const p of [
    process.env.YAAC_DATA_DIR && path.join(process.env.YAAC_DATA_DIR, '.server.lock'),
    path.join(os.homedir(), '.yaac', '.server.lock'),
  ].filter(Boolean)) if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'))
  throw new Error('no .server.lock — is the server running?')
}
const sh = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim()
const ns = process.env.YAAC_K8S_NAMESPACE || 'yaac'
const lock = readLock()
const origin = `http://127.0.0.1:${lock.port}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function mintToken() {
  const r = await fetch(`${origin}/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${lock.secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'one-time' }),
  })
  if (r.status !== 201) throw new Error(`token mint HTTP ${r.status}`)
  return (await r.json()).token
}

const podsNow = () => sh(`kubectl get pods -n ${ns} -o name`).split('\n').filter((l) => l.includes('yaac-yaac'))

async function main() {
  const before = new Set(podsNow())
  // `session create` attaches to tmux and never returns — run it detached.
  const proj = process.env.PROJECT || 'yaac'
  const child = spawn('yaac', ['session', 'create', proj], { detached: true, stdio: 'ignore' })
  child.unref()
  console.log(`creating a session in project ${proj}…`)
  let pod = null
  for (let i = 0; i < 200 && !pod; i++) {
    pod = podsNow().map((p) => p.replace('pod/', ''))
      .find((p) => !before.has(`pod/${p}`) && sh(`kubectl get pod -n ${ns} ${p} -o jsonpath={.status.phase}`) === 'Running')
    if (!pod) await sleep(2000)
  }
  if (!pod) throw new Error('no new Running pod appeared')
  const sid = pod.replace(/^yaac-yaac-([0-9a-f]{8})-.*/, '$1')
  console.log(`pod=${pod} sid=${sid} — opening webapp and splitting during boot`)

  const browser = await pw.chromium.launch()
  let pass = false
  try {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await ctx.addInitScript(() => { try { localStorage.setItem('yaac.viewmode.v1', 'tiles') } catch {} })
    const page = await ctx.newPage()
    const token = await mintToken()
    await page.goto(`${origin}/?token=${token}&project=${proj}&session=${sid}`)
    await page.waitForFunction(() => !window.location.search.includes('token='), { timeout: 15000 })
    // Split ASAP so the width shrink hits while the agent is still cold-booting.
    await sleep(300)
    await page.evaluate(async (id) => { await fetch(`/session/${id}/terminals`, { method: 'POST' }) }, sid)
    await sleep(8000)
    const cols = await page.evaluate(() => {
      const t = [...(window.__xterms ?? [])][0]
      return t ? t.cols : null
    })
    fs.mkdirSync('/tmp/yaac-shots', { recursive: true })
    await page.screenshot({ path: '/tmp/yaac-shots/split-open-agent-size.png' })
    // Read the pod's tmux window widths WHILE the client is attached.
    const rows = sh(`kubectl exec -n ${ns} ${pod} -- tmux -S /tmp/yaac-tmux/server list-windows -a -F '#{session_name} #{window_name} #{window_width}'`)
      .split('\n').map((l) => l.trim()).filter(Boolean)
    const claude = rows.filter((l) => / claude /.test(` ${l} `) || / claude$/.test(l))
      .map((l) => Number(l.split(' ').pop()))
    const worst = Math.max(...claude)
    console.log(`client agent cols=${cols}; tmux claude window widths=${JSON.stringify(claude)}`)
    // The agent window must match the client grid (allow ±1 for rounding), not
    // remain at the pre-split full width.
    pass = cols != null && claude.length > 0 && worst <= cols + 1
    console.log(pass ? 'PASS: agent window matches the split pane' : `FAIL: agent window stuck wide (${worst} > ${cols})`)
  } finally {
    await browser.close()
    try { sh(`yaac session delete ${sid}`) } catch { /* best effort */ }
  }
  process.exit(pass ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(2) })
