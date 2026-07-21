#!/usr/bin/env node
/*
 * verify-tmux-status-format.js
 *
 * WHAT IT VERIFIES
 *   The tmux-side status classification used by the opencode and pi session
 *   status watchers. packages/server/src/features/sessions/status-watcher.ts
 *   builds a content-search format (`busyStatusFormat`) from the per-agent
 *   marker lists (OPENCODE_BUSY_MARKERS / PI_BUSY_MARKERS) and subscribes a
 *   no-output control-mode client to it, so tmux resolves running/waiting
 *   inside the pod and only the word crosses the exec stream. This script
 *   renders a corpus of real pane snapshots and asserts the verdict tmux
 *   pushes back over exactly that path (`refresh-client -B "status:…:<fmt>"`).
 *
 * WHY A SCRIPT (not a unit test)
 *   The formats are POSIX/GNU-ERE strings sent through tmux's own
 *   double-quote parser. Their failure modes — backslash escapes not
 *   surviving the quotes, a `{n,}` interval's `}` closing the `#{…}`, a
 *   PCRE-only `(?:…)` group silently never matching — can only be caught by
 *   running a real tmux. Unit tests pin the marker strings; this proves they
 *   actually classify a live pane.
 *
 * HOW TO RUN
 *   node test-playwright-scripts/verify-tmux-status-format.js
 *   Requires `tmux` on PATH (>=3.1 for `#{C/ri:}`; the session image ships
 *   3.4). Exits 0 when every case matches, 1 otherwise.
 *
 * KEEP IN SYNC
 *   MARKERS below mirrors OPENCODE_BUSY_MARKERS / PI_BUSY_MARKERS and
 *   buildFormat mirrors busyStatusFormat. If you change either in the server,
 *   update this file and re-run.
 */

import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Mirror of the server's OPENCODE_BUSY_MARKERS / PI_BUSY_MARKERS.
const MARKERS = {
  opencode: ['esc\\s+(again\\s+to\\s+)?interrupt', '[■⬝][■⬝][■⬝][■⬝]'],
  pi: ['esc\\s+(to\\s+)?(interrupt|cancel|stop)', '\\b(thinking|working|generating|streaming|running)\\b'],
}

// Mirror of busyStatusFormat(): OR each marker into a case-insensitive
// content search, then resolve to running/waiting.
function buildFormat(markers) {
  const anyBusy = markers
    .map((m) => `#{C/ri:${m}}`)
    .reduceRight((acc, probe) => (acc ? `#{||:${probe},${acc}}` : probe), '')
  return `#{?${anyBusy},running,waiting}`
}

// Corpus: [paneLines, expectedVerdict]. Lifted from the classifier unit tests
// the tmux formats replaced, so the two stay behaviourally equivalent.
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
 * Render `lines` into a fresh tmux pane, subscribe a no-output control-mode
 * client to `format`, and resolve with the first running/waiting value tmux
 * pushes — the exact production path.
 */
async function classify(format, lines) {
  const socket = path.join(os.tmpdir(), `verify-status-${process.pid}-${Math.floor(performance.now())}.sock`)
  const corpusFile = `${socket}.txt`
  fs.writeFileSync(corpusFile, lines.join('\n'))
  try {
    tmux(socket, ['new-session', '-d', '-s', 'yaac', '-x', '120', '-y', '40'])
    // Render the snapshot exactly (cat a file — no shell-quoting of markers).
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
      // Subscribe exactly as the watcher does (single-quoted -B arg so tmux
      // doesn't C-unescape `\b` etc. out of the format).
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
