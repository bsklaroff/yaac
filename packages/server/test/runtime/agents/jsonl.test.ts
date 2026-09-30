import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { scanJsonlForward } from '#runtime/agents/jsonl'
import type { SandboxFile } from '#runtime/agents/sandbox-fs'

describe('scanJsonlForward', () => {
  let tmpDir: string
  let jsonlPath: string
  let file: SandboxFile

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonl-scan-test-'))
    jsonlPath = path.join(tmpDir, 'session.jsonl')
    file = { slug: 'demo', dir: tmpDir, rel: 'session.jsonl' }
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  function writeLine(value: string): Promise<void> {
    return fs.appendFile(jsonlPath, value + '\n')
  }

  it('returns the first mapped value', async () => {
    await writeLine(JSON.stringify({ type: 'system' }))
    await writeLine(JSON.stringify({ type: 'user', text: 'hello world' }))

    const result = await scanJsonlForward(file, (entry) => {
      const parsed = entry as { type?: string; text?: string }
      return parsed.type === 'user' ? parsed.text : undefined
    })

    expect(result).toBe('hello world')
  })

  it('finds values beyond the first chunk', async () => {
    await writeLine(JSON.stringify({ type: 'system', text: 'x'.repeat(12000) }))
    await writeLine(JSON.stringify({ type: 'user', text: 'hello world' }))

    const result = await scanJsonlForward(file, (entry) => {
      const parsed = entry as { type?: string; text?: string }
      return parsed.type === 'user' ? parsed.text : undefined
    })

    expect(result).toBe('hello world')
  })

  it('skips invalid json lines', async () => {
    await writeLine('{not-json')
    await writeLine(JSON.stringify({ type: 'user', text: 'hello world' }))

    const result = await scanJsonlForward(file, (entry) => {
      const parsed = entry as { type?: string; text?: string }
      return parsed.type === 'user' ? parsed.text : undefined
    })

    expect(result).toBe('hello world')
  })

  it('scans a line that never ends in time linear in its length', async () => {
    // A huge line must not take quadratic time to scan.
    await fs.writeFile(jsonlPath, 'x'.repeat(16 * 1024 * 1024) + '\n' + JSON.stringify({ type: 'user', text: 'after' }) + '\n')
    const started = Date.now()
    const result = await scanJsonlForward(file, (entry) => (entry as { text?: string }).text)
    expect(result).toBe('after')
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('returns undefined for missing files', async () => {
    const result = await scanJsonlForward({ ...file, rel: 'missing.jsonl' }, () => 'value')
    expect(result).toBeUndefined()
  })
})
