#!/usr/bin/env node
/*
 * verify-tmux-status-format.js
 *
 * Verifies the tmux-side status classification for opencode and pi.
 * `busyStatusFormat` in packages/server/src/runtime/agents/agent-tools.ts
 * builds a content-search format from OPENCODE_BUSY_MARKERS /
 * PI_BUSY_MARKERS, and the status watcher subscribes a no-output
 * control-mode client to it, so tmux decides running/waiting and only that
 * word is sent back. This script renders sample pane contents and checks
 * the verdict tmux pushes over the same path (`refresh-client -B`).
 *
 * This is a script rather than a unit test because the formats are ERE
 * strings passed through tmux's own quote parsing. Their failure modes
 * (escapes lost in quoting, a `{n,}` interval's `}` closing the `#{…}`, a
 * PCRE-only `(?:…)` that never matches) only show up in a real tmux.
 *
 * Run: node test-playwright-scripts/verify-tmux-status-format.js
 * Requires `tmux` on PATH (>= 3.1 for `#{C/ri:}`). Exits 0 when every case
 * matches, 1 otherwise.
 *
 * MARKERS and buildFormat below are copies of the server's markers and
 * busyStatusFormat; update them here when those change.
 */

import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Copy of OPENCODE_BUSY_MARKERS (opencode.ts) and PI_BUSY_MARKERS (pi.ts).
const MARKERS = {
  opencode: ['esc\\s+(again\\s+to\\s+)?interrupt', '[■⬝][■⬝][■⬝][■⬝]'],
  pi: ['esc\\s+(to\\s+)?(interrupt|cancel|stop)', '\\b(thinking|working|generating|streaming|running)\\b'],
}

// Copy of busyStatusFormat().
function buildFormat(markers) {
  const anyBusy = markers
    .map((m) => `#{C/ri:${m}}`)
    .reduceRight((acc, probe) => (acc ? `#{||:${probe},${acc}}` : probe), '')
  return `#{?${anyBusy},running,waiting}`
}

// [paneLines, expectedVerdict] per tool.
const CORPUS = {
  opencode: [
    [['Some output here', '  esc interrupt'], 'running'],
    [['  esc again to interrupt'], 'running'],
    [['   ■■■■■⬝⬝⬝  esc interrupt'], 'running'],
    [['   ⬝⬝⬝⬝⬝⬝⬝⬝'], 'running'],
    [['   ■■■■'], 'running'],
    [['   ■⬝■⬝'], 'running'],
    [['ESC INTERRUPT'], 'running'],
    [['■ item one', '■ item two'], 'waiting'],
    [['■■■ almost'], 'waiting'],
    [['> _', 'Ready'], 'waiting'],
    [['△ Permission required', '  ⚙ Call tool bash', '  enter allow'], 'waiting'],
    [['Pick one:', '  > A', '    B', '  enter submit  esc dismiss'], 'waiting'],
  ],
  pi: [
    [['… esc to interrupt'], 'running'],
    [['press esc to cancel'], 'running'],
    [['Thinking…'], 'running'],
    [['Generating response'], 'running'],
    [['> '], 'waiting'],
    [['Ready. Type a message.'], 'waiting'],
    [[''], 'waiting'],
  ],
}

function tmux(socket, args) {
  return execFileSync('tmux', ['-S', socket, ...args], { encoding: 'utf8' }).trim()
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Renders `lines` into a fresh tmux pane, subscribes a no-output
 * control-mode client to `format` as the server does, and resolves with the
 * first value tmux pushes.
 */
async function classify(format, lines) {
  const socket = path.join(os.tmpdir(), `verify-status-${process.pid}-${Math.floor(performance.now())}.sock`)
  const corpusFile = `${socket}.txt`
  fs.writeFileSync(corpusFile, lines.join('\n'))
  try {
    tmux(socket, ['new-session', '-d', '-s', 'yaac', '-x', '120', '-y', '40'])
    // cat a file so the text needs no shell quoting.
    tmux(socket, ['send-keys', '-t', 'yaac', `clear; cat '${corpusFile}'`, 'Enter'])
    await sleep(300)
    const paneId = tmux(socket, ['display-message', '-p', '-t', 'yaac', '#{pane_id}'])

    return await new Promise((resolve, reject) => {
      const cm = spawn('tmux', ['-S', socket, '-C', 'attach-session', '-t', 'yaac',
        '-f', 'read-only,ignore-size,no-output'])
      let buf = ''
      const timer = setTimeout(() => { cm.kill('SIGTERM'); reject(new Error('no subscription push within 4s')) }, 4000)
      cm.stdout.on('data', (chunk) => {
        buf += chunk.toString()
        let nl
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          const m = line.match(/^%subscription-changed status \S+ \S+ \S+ (%\d+) : (.*)$/)
          if (m && m[1] === paneId) {
            clearTimeout(timer)
            cm.kill('SIGTERM')
            resolve(m[2].trim())
            return
          }
        }
      })
      cm.on('error', (err) => { clearTimeout(timer); reject(err) })
      // Single-quote the -B arg so tmux doesn't unescape `\b` in the format.
      cm.stdin.write(`refresh-client -B 'status:${paneId}:${format}'\n`)
    })
  } finally {
    try { tmux(socket, ['kill-server']) } catch { /* already gone */ }
    try { fs.unlinkSync(corpusFile) } catch { /* ignore */ }
  }
}

async function main() {
  let pass = 0
  let fail = 0
  for (const tool of Object.keys(CORPUS)) {
    const format = buildFormat(MARKERS[tool])
    console.log(`\n# ${tool}\n  format: ${format}`)
    for (const [lines, expected] of CORPUS[tool]) {
      const got = await classify(format, lines)
      const ok = got === expected
      if (ok) pass++
      else fail++
      const label = JSON.stringify(lines.join(' ⏎ ')).slice(0, 60)
      console.log(`  ${ok ? '✓' : '✗'} ${label} → ${got}${ok ? '' : ` (expected ${expected})`}`)
    }
  }
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => { console.error(err); process.exit(1) })
