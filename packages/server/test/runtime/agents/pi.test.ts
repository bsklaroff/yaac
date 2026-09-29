import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { setDataDir, piDir } from '@yaac/shared/project-paths'
import {
  PI_BUSY_MARKERS,
  getPiFirstUserMessage,
} from '#runtime/agents/pi'
import type { SandboxFile } from '#runtime/agents/sandbox-fs'

describe('PI_BUSY_MARKERS', () => {
  it('pins the tmux-ERE busy markers the status format searches for', () => {
    // Encoded into a tmux content-search format by busyStatusFormat
    // (status-watcher.ts) and validated against a live tmux by
    // test-playwright-scripts/verify-tmux-status-format.js. The interrupt
    // hint covers "esc to interrupt" / "esc to cancel" / "esc to stop"; the
    // working hint covers thinking/working/generating/streaming/running.
    expect(PI_BUSY_MARKERS).toEqual([
      'esc\\s+(to\\s+)?(interrupt|cancel|stop)',
      '\\b(thinking|working|generating|streaming|running)\\b',
    ])
  })
})

describe('getPiFirstUserMessage', () => {
  const slug = 'proj'
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-status-test-'))
    setDataDir(tmpDir)
    await fs.mkdir(piDir(slug), { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  async function log(entries: Record<string, unknown>[]): Promise<SandboxFile> {
    await fs.writeFile(path.join(piDir(slug), '100_sess-1.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
    return { slug, dir: piDir(slug), rel: '100_sess-1.jsonl' }
  }

  it('returns the first user message (string content)', async () => {
    expect(await getPiFirstUserMessage(await log([
      { type: 'session', id: 'x' },
      { type: 'message', message: { role: 'user', content: 'fix the login bug' } },
      { type: 'message', message: { role: 'assistant', content: 'on it' } },
    ]))).toBe('fix the login bug')
  })

  it('joins array text content parts', async () => {
    expect(await getPiFirstUserMessage(await log([{
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }] },
    }]))).toBe('hello world')
  })

  it('ignores assistant messages and non-message entries', async () => {
    expect(await getPiFirstUserMessage(await log([
      { type: 'tool', name: 'bash' },
      { type: 'message', message: { role: 'assistant', content: 'thinking' } },
      { type: 'message', message: { role: 'user', content: 'the real prompt' } },
    ]))).toBe('the real prompt')
  })
})
