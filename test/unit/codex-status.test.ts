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

  it('returns running for event_msg (user input)', async () => {
    await writeEntry({ type: 'event_msg', payload: { type: 'user_message', message: 'fix the bug' } })
    expect(await getCodexStatus(jsonlPath)).toBe('running')
  })

  it('returns running for a pending exec_command function call', async () => {
    await writeEntry({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } })
    await writeEntry({ type: 'event_msg', payload: { type: 'user_message', message: 'inspect the repo' } })
    await writeEntry({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'call-1' } })
    expect(await getCodexStatus(jsonlPath)).toBe('running')
  })

  it('returns waiting for a pending request_user_input function call', async () => {
    await writeEntry({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } })
    await writeEntry({ type: 'event_msg', payload: { type: 'agent_message', message: 'choose an option', phase: 'commentary' } })
    await writeEntry({ type: 'response_item', payload: { type: 'message', role: 'assistant' } })
    await writeEntry({ type: 'response_item', payload: { type: 'function_call', name: 'request_user_input', call_id: 'call-1' } })
    expect(await getCodexStatus(jsonlPath)).toBe('waiting')
  })

  it('returns waiting after a completed tool call followed by an assistant message', async () => {
    await writeEntry({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } })
    await writeEntry({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'call-1' } })
    await writeEntry({ type: 'event_msg', payload: { type: 'exec_command_end', call_id: 'call-1', turn_id: 'turn-1' } })
    await writeEntry({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1' } })
    await writeEntry({ type: 'event_msg', payload: { type: 'agent_message', message: 'done', phase: 'commentary' } })
    await writeEntry({ type: 'response_item', payload: { type: 'message', role: 'assistant' } })
    expect(await getCodexStatus(jsonlPath)).toBe('waiting')
  })

  it('returns waiting for empty file', async () => {
    await fs.writeFile(jsonlPath, '')
    expect(await getCodexStatus(jsonlPath)).toBe('waiting')
  })

  it('returns waiting when file does not exist', async () => {
    expect(await getCodexStatus(path.join(tmpDir, 'nonexistent.jsonl'))).toBe('waiting')
  })

  it('returns running when a user message follows earlier waiting-state events', async () => {
    await writeEntry({ type: 'event_msg', payload: { type: 'agent_message', message: 'done', phase: 'commentary' } })
    await writeEntry({ type: 'response_item', payload: { type: 'message', role: 'assistant' } })
    await writeEntry({ type: 'event_msg', payload: { type: 'user_message', message: 'next task' } })
    expect(await getCodexStatus(jsonlPath)).toBe('running')
  })

  it('ignores non-user event_msg entries when determining running state', async () => {
    await writeEntry({ type: 'event_msg', payload: { type: 'agent_message', message: 'working on it' } })
    expect(await getCodexStatus(jsonlPath)).toBe('waiting')
  })

  it('returns waiting for an assistant message without pending work', async () => {
    await writeEntry({ type: 'event_msg', payload: { type: 'agent_message', message: 'all set', phase: 'commentary' } })
    await writeEntry({ type: 'response_item', payload: { type: 'message', role: 'assistant' } })
    expect(await getCodexStatus(jsonlPath)).toBe('waiting')
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
    await writeEntry({ type: 'event_msg', payload: { type: 'user_message', message: 'fix the login bug' } })
    expect(await getCodexFirstUserMessage(jsonlPath)).toBe('fix the login bug')
  })

  it('returns undefined when no event_msg exists', async () => {
    await writeEntry({ type: 'session_start', session_id: 'abc' })
    await writeEntry({ type: 'response_item', payload: { type: 'message', role: 'assistant' } })
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
    await writeEntry({ type: 'response_item', payload: { type: 'message', role: 'assistant' } })
    await writeEntry({ type: 'event_msg', payload: { type: 'user_message', message: 'second prompt' } })
    expect(await getCodexFirstUserMessage(jsonlPath)).toBe('second prompt')
  })

  it('ignores the legacy top-level event_msg message shape', async () => {
    await writeEntry({ type: 'event_msg', message: 'legacy prompt', images: [] })
    expect(await getCodexFirstUserMessage(jsonlPath)).toBeUndefined()
  })

  it('ignores non-user event_msg payloads', async () => {
    await writeEntry({ type: 'event_msg', payload: { type: 'agent_message', message: 'internal note' } })
    expect(await getCodexFirstUserMessage(jsonlPath)).toBeUndefined()
  })
})
