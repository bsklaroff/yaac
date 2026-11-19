import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { workspaceBinDir } from '#domain/workspaces/workspace-bin'

/**
 * Runs the shipped `yaac-log-writer` the way a window's pipe does, with
 * the environment a workspace given run secrets has, and reads the log it
 * wrote (docs/workspace-steps.md "Logs"): each value is blanked as written,
 * including one split across two writes, so the log never holds it.
 */
const WRITER = path.join(workspaceBinDir(), 'yaac-log-writer')

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-log-mask-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

/** Pipe `chunks` into the writer, `pauseMs` apart, and answer the log. */
let logs = 0
async function logged(chunks: string[], env: Record<string, string>, pauseMs = 20): Promise<string> {
  const file = path.join(dir, `step-${String(++logs)}.log`)
  const child = spawn(WRITER, [file], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['pipe', 'ignore', 'inherit'] })
  const exited = new Promise((resolve) => child.on('exit', resolve))
  for (const chunk of chunks) {
    child.stdin.write(chunk)
    await new Promise((resolve) => setTimeout(resolve, pauseMs))
  }
  child.stdin.end()
  await exited
  return await fs.readFile(file, 'utf8')
}

describe('yaac-log-writer with run secrets', () => {
  it('blanks each value of 8 characters or more, and each such line of a multi-line one, as it writes', async () => {
    const env = { YAAC_MASK_NAMES: 'KEY SHORT PEM', KEY: 'sk-live-0123456789', SHORT: 'abc', PEM: 'line-one-xyz\nline-two-xyz' }
    const out = await logged(['token=sk-live-', '0123456789 ok\n', 'short abc stays\n', 'pem line-two-xyz\n'], env)
    expect(out).toBe('token=*** ok\nshort abc stays\npem ***\n')
  })

  it('finds a value through the escapes and control characters a reader strips, even split across reads', async () => {
    const env = { YAAC_MASK_NAMES: 'KEY', KEY: 'sk-live-0123456789' }
    expect(await logged(['a sk-live-\x1b[31m0123456789\x1b[0m b\n'], env)).toBe('a ***\x1b[0m b\n')
    expect(await logged(['a sk-live-0123\r456789 b\n'], env)).toBe('a *** b\n')
    // A read cut inside an escape, and inside the value, still matches.
    expect(await logged(['a sk-live-01\x1b[', '1m23456789 b\n'], env)).toBe('a *** b\n')
    // Escapes outside a value are left as they are.
    expect(await logged(['\x1b[1mbold\x1b[0m\n'], env)).toBe('\x1b[1mbold\x1b[0m\n')
  })

  it('shows a prompt with no newline once input pauses, and passes everything through with no secrets named', async () => {
    expect(await logged(['password: ', 'typed\n'], { YAAC_MASK_NAMES: 'KEY', KEY: 'sk-live-0123456789' }, 250)).toBe('password: typed\n')
    expect(await logged(['plain sk-live-0123456789\n'], { KEY: 'sk-live-0123456789' })).toBe('plain sk-live-0123456789\n')
  })
})
