/**
 * Fills a bundled adapter's compile cache during the image build, so its
 * first start in a pod reads the cache (`bundle-entry.mjs`).
 *
 *   node bake-compile-cache.mjs <adapter command>
 *
 * Starts the adapter with a throwaway home, sends ACP's `initialize`, and
 * closes its input once it answers. The adapter then exits, and Node writes
 * the cache as it does: everything a start compiles up to its first reply.
 * An adapter that exits without answering, or leaves no cache, fails the
 * build rather than shipping an image that quietly compiles on every start.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const INITIALIZE = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } }

/** How long an adapter may take to answer before the build gives up. */
const ANSWER_TIMEOUT_MS = 120_000

/**
 * Run `command` to its `initialize` reply and its exit. Resolves with the
 * number of cache files it left beside its entry; rejects if it never
 * answered or left none.
 */
export async function bakeCompileCache(command, { timeoutMs = ANSWER_TIMEOUT_MS } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-bake-'))
  try {
    const child = spawn(command, [], { env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'inherit'] })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    let answered = false
    let buffered = ''
    child.stdout.on('data', (chunk) => {
      buffered += chunk
      if (answered || !/"id":\s*1\b[^\n]*"result"|"result"[^\n]*"id":\s*1\b/.test(buffered)) return
      answered = true
      child.stdin.end()
    })
    child.stdin.on('error', () => { /* it exited first; the close below says so */ })
    child.stdin.write(`${JSON.stringify(INITIALIZE)}\n`)
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('close', resolve)
    }).finally(() => clearTimeout(timer))
    if (!answered) throw new Error(`${command} exited (${String(code)}) without answering initialize`)
    const cache = path.join(path.dirname(fs.realpathSync(command)), 'yaac-compile-cache')
    const files = fs.existsSync(cache)
      ? fs.readdirSync(cache, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length
      : 0
    if (files === 0) throw new Error(`${command} left no compile cache in ${cache}`)
    return files
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2]
  if (command === undefined) {
    console.error(`usage: node ${process.argv[1]} <adapter command>`)
    process.exit(2)
  }
  bakeCompileCache(command).then(
    (files) => { console.log(`${command}: ${String(files)} compile cache files`) },
    (err) => {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    },
  )
}
