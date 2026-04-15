import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { getCodexStatus, getCodexFirstUserMessage } from '@/lib/session/codex-status'

describe('getCodexStatus', () => {
  let tmpDir: string
  let jsonlPath: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-status-test-'))
    jsonlPath = path.join(tmpDir, 'session.jsonl')
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  function writeEntry(entry: Record<string, unknown>): Promise<void> {
    return fs.appendFile(jsonlPath, JSON.stringify(entry) + '\n')
  }

  it('returns waiting for turn.completed', async () => {
    await writeEntry({ type: 'turn.started' })
    await writeEntry({ type: 'item.completed', item: { type: 'agent_message' } })
    await writeEntry({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 50 } })
    expect(await getCodexStatus(jsonlPath)).toBe('waiting')
  })

  it('returns waiting for turn.failed', async () => {
    await writeEntry({ type: 'turn.started' })
    await writeEntry({ type: 'turn.failed', error: 'something went wrong' })
    expect(await getCodexStatus(jsonlPath)).toBe('waiting')
  })

  it('returns running for turn.started', async () => {
    await writeEntry({ type: 'turn.started' })
    expect(await getCodexStatus(jsonlPath)).toBe('running')
  })

  it('returns running for item.started', async () => {
    await writeEntry({ type: 'turn.started' })
    await writeEntry({ type: 'item.started', item: { type: 'command_execution', status: 'in_progress' } })
    expect(await getCodexStatus(jsonlPath)).toBe('running')
  })

  it('returns running for item.updated', async () => {
    await writeEntry({ type: 'turn.started' })
    await writeEntry({ type: 'item.updated', item: { type: 'command_execution', status: 'in_progress' } })
    expect(await getCodexStatus(jsonlPath)).toBe('running')
  })

  it('returns running for event_msg (user input)', async () => {
    await writeEntry({ type: 'turn.completed', usage: {} })
    await writeEntry({ type: 'event_msg', message: 'fix the bug' })
    expect(await getCodexStatus(jsonlPath)).toBe('running')
  })

  it('returns waiting for empty file', async () => {
    await fs.writeFile(jsonlPath, '')
    expect(await getCodexStatus(jsonlPath)).toBe('waiting')
  })

  it('returns waiting when file does not exist', async () => {
    expect(await getCodexStatus(path.join(tmpDir, 'nonexistent.jsonl'))).toBe('waiting')
  })

  it('reads only the last entry when multiple entries exist', async () => {
    await writeEntry({ type: 'turn.started' })
    await writeEntry({ type: 'item.completed', item: { type: 'agent_message' } })
    await writeEntry({ type: 'turn.completed', usage: {} })
    expect(await getCodexStatus(jsonlPath)).toBe('waiting')
  })

  it('returns running when event_msg follows turn.completed', async () => {
    await writeEntry({ type: 'turn.completed', usage: {} })
    await writeEntry({ type: 'event_msg', message: 'next task' })
    expect(await getCodexStatus(jsonlPath)).toBe('running')
  })
})

describe('getCodexFirstUserMessage', () => {
  let tmpDir: string
  let jsonlPath: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-first-msg-test-'))
    jsonlPath = path.join(tmpDir, 'session.jsonl')
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  function writeEntry(entry: Record<string, unknown>): Promise<void> {
    return fs.appendFile(jsonlPath, JSON.stringify(entry) + '\n')
  }

  it('returns message from event_msg entry', async () => {
    await writeEntry({ type: 'session_start', session_id: 'abc', model: 'gpt-4' })
    await writeEntry({ type: 'event_msg', message: 'fix the login bug', images: [] })
    await writeEntry({ type: 'turn.started' })
    expect(await getCodexFirstUserMessage(jsonlPath)).toBe('fix the login bug')
  })

  it('returns undefined when no event_msg exists', async () => {
    await writeEntry({ type: 'session_start', session_id: 'abc' })
    await writeEntry({ type: 'turn.started' })
    expect(await getCodexFirstUserMessage(jsonlPath)).toBeUndefined()
  })

  it('returns undefined when file does not exist', async () => {
    expect(await getCodexFirstUserMessage(path.join(tmpDir, 'nonexistent.jsonl'))).toBeUndefined()
  })

  it('returns undefined for empty file', async () => {
    await fs.writeFile(jsonlPath, '')
    expect(await getCodexFirstUserMessage(jsonlPath)).toBeUndefined()
  })

  it('skips non-event_msg entries', async () => {
    await writeEntry({ type: 'session_start', session_id: 'abc' })
    await writeEntry({ type: 'turn.started' })
    await writeEntry({ type: 'event_msg', message: 'second prompt', images: [] })
    expect(await getCodexFirstUserMessage(jsonlPath)).toBe('second prompt')
  })
})
