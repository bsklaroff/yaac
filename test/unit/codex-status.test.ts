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
    await writeEntry({ type: 'event_msg', payload: { type: 'agent_message', message: 'done', phase: 'final_answer' } })
    await writeEntry({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer' } })
    await writeEntry({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } })
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
    await writeEntry({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } })
    await writeEntry({ type: 'event_msg', payload: { type: 'user_message', message: 'next task' } })
    expect(await getCodexStatus(jsonlPath)).toBe('running')
  })

  it('ignores commentary-only event_msg entries when determining running state', async () => {
    await writeEntry({ type: 'event_msg', payload: { type: 'agent_message', message: 'working on it' } })
    expect(await getCodexStatus(jsonlPath)).toBe('waiting')
  })

  it('returns waiting for a completed turn without pending work', async () => {
    await writeEntry({ type: 'event_msg', payload: { type: 'agent_message', message: 'all set', phase: 'final_answer' } })
    await writeEntry({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer' } })
    await writeEntry({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } })
    expect(await getCodexStatus(jsonlPath)).toBe('waiting')
  })

  it('treats a final assistant response as waiting even before task_complete arrives', async () => {
    await writeEntry({ type: 'event_msg', payload: { type: 'agent_message', message: 'all set', phase: 'final_answer' } })
    await writeEntry({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer' } })
    expect(await getCodexStatus(jsonlPath)).toBe('waiting')
  })

  it('does not treat commentary-only assistant messages as waiting when work is still pending', async () => {
    await writeEntry({ type: 'event_msg', payload: { type: 'agent_message', message: 'still working', phase: 'commentary' } })
    await writeEntry({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'commentary' } })
    await writeEntry({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'call-1' } })
    expect(await getCodexStatus(jsonlPath)).toBe('running')
  })

  it('returns waiting when the prior turn was interrupted', async () => {
    await writeEntry({ type: 'response_item', payload: { type: 'message', role: 'user' } })
    await writeEntry({ type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'turn-1', reason: 'interrupted' } })
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

  it('ignores bootstrap response_item user messages and reads the user_message event', async () => {
    await writeEntry({ type: 'session_meta', payload: { id: 'abc' } })
    await writeEntry({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '# AGENTS.md instructions for /workspace' }],
      },
    })
    await writeEntry({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'fix the login bug' }],
      },
    })
    await writeEntry({ type: 'event_msg', payload: { type: 'user_message', message: 'fix the login bug' } })
    expect(await getCodexFirstUserMessage(jsonlPath)).toBe('fix the login bug')
  })

  it('finds the first user_message beyond the first 8KB of the file', async () => {
    await writeEntry({
      type: 'session_meta',
      payload: {
        id: 'abc',
        base_instructions: { text: 'x'.repeat(12000) },
      },
    })
    await writeEntry({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '# AGENTS.md instructions for /workspace' }],
      },
    })
    await writeEntry({ type: 'event_msg', payload: { type: 'user_message', message: 'fix the login bug' } })

    expect(await getCodexFirstUserMessage(jsonlPath)).toBe('fix the login bug')
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
