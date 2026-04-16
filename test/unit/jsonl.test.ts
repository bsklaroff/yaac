import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { scanJsonlForward } from '@/lib/session/jsonl'

describe('scanJsonlForward', () => {
  let tmpDir: string
  let jsonlPath: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonl-scan-test-'))
    jsonlPath = path.join(tmpDir, 'session.jsonl')
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

    const result = await scanJsonlForward(jsonlPath, (entry) => {
      const parsed = entry as { type?: string; text?: string }
      return parsed.type === 'user' ? parsed.text : undefined
    })

    expect(result).toBe('hello world')
  })

  it('finds values beyond the first chunk', async () => {
    await writeLine(JSON.stringify({ type: 'system', text: 'x'.repeat(12000) }))
    await writeLine(JSON.stringify({ type: 'user', text: 'hello world' }))

    const result = await scanJsonlForward(jsonlPath, (entry) => {
      const parsed = entry as { type?: string; text?: string }
      return parsed.type === 'user' ? parsed.text : undefined
    })

    expect(result).toBe('hello world')
  })

  it('skips invalid json lines', async () => {
    await writeLine('{not-json')
    await writeLine(JSON.stringify({ type: 'user', text: 'hello world' }))

    const result = await scanJsonlForward(jsonlPath, (entry) => {
      const parsed = entry as { type?: string; text?: string }
      return parsed.type === 'user' ? parsed.text : undefined
    })

    expect(result).toBe('hello world')
  })

  it('returns undefined for missing files', async () => {
    const result = await scanJsonlForward(path.join(tmpDir, 'missing.jsonl'), () => 'value')
    expect(result).toBeUndefined()
  })
})
