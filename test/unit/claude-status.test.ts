import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { getClaudeStatus, getFirstUserMessage } from '@/lib/session/claude-status'

describe('getClaudeStatus', () => {
  let tmpDir: string
  let jsonlPath: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-status-test-'))
    jsonlPath = path.join(tmpDir, 'session.jsonl')
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  function writeEntry(entry: Record<string, unknown>): Promise<void> {
    return fs.appendFile(jsonlPath, JSON.stringify(entry) + '\n')
  }

  it('returns waiting for assistant with end_turn', async () => {
    await writeEntry({ type: 'assistant', message: { stop_reason: 'end_turn' } })
    expect(await getClaudeStatus(jsonlPath)).toBe('waiting')
  })

  it('returns waiting for assistant with refusal', async () => {
    await writeEntry({ type: 'assistant', message: { stop_reason: 'refusal' } })
    expect(await getClaudeStatus(jsonlPath)).toBe('waiting')
  })

  it('returns waiting for assistant with stop_sequence', async () => {
    await writeEntry({ type: 'assistant', message: { stop_reason: 'stop_sequence' } })
    expect(await getClaudeStatus(jsonlPath)).toBe('waiting')
  })

  it('returns running for assistant with tool_use', async () => {
    await writeEntry({ type: 'assistant', message: { stop_reason: 'tool_use' } })
    expect(await getClaudeStatus(jsonlPath)).toBe('running')
  })

  it('returns running for assistant with max_tokens', async () => {
    await writeEntry({ type: 'assistant', message: { stop_reason: 'max_tokens' } })
    expect(await getClaudeStatus(jsonlPath)).toBe('running')
  })

  it('returns running for assistant with null stop_reason', async () => {
    await writeEntry({ type: 'assistant', message: { stop_reason: null } })
    expect(await getClaudeStatus(jsonlPath)).toBe('running')
  })

  it('returns running for assistant with no message field', async () => {
    await writeEntry({ type: 'assistant' })
    expect(await getClaudeStatus(jsonlPath)).toBe('running')
  })

  it('returns running for user message', async () => {
    await writeEntry({ type: 'user', message: { role: 'user', content: 'hello' } })
    expect(await getClaudeStatus(jsonlPath)).toBe('running')
  })

  it('returns waiting when user tool_result references ExitPlanMode', async () => {
    await writeEntry({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_abc',
            content: [{ type: 'tool_reference', tool_name: 'ExitPlanMode' }],
          },
        ],
      },
    })
    expect(await getClaudeStatus(jsonlPath)).toBe('waiting')
  })

  it('returns waiting when assistant writes to a plan file', async () => {
    await writeEntry({
      type: 'assistant',
      message: {
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_abc',
            name: 'Write',
            input: { file_path: '/home/user/.claude/plans/my-plan.md', content: '# Plan' },
          },
        ],
      },
    })
    expect(await getClaudeStatus(jsonlPath)).toBe('waiting')
  })

  it('returns waiting when user tool_result is for a plan file Write', async () => {
    await writeEntry({
      type: 'assistant',
      message: {
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_abc',
            name: 'Write',
            input: { file_path: '/home/user/.claude/plans/my-plan.md', content: '# Plan' },
          },
        ],
      },
    })
    await writeEntry({
      type: 'user',
      toolUseResult: { type: 'update', filePath: '/home/user/.claude/plans/my-plan.md' },
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_abc' }],
      },
    })
    expect(await getClaudeStatus(jsonlPath)).toBe('waiting')
  })

  it('returns waiting when plan Write result is followed by attachment metadata', async () => {
    await writeEntry({
      type: 'assistant',
      message: {
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_abc',
            name: 'Write',
            input: { file_path: '/home/user/.claude/plans/my-plan.md', content: '# Plan' },
          },
        ],
      },
    })
    await writeEntry({
      type: 'user',
      toolUseResult: { type: 'update', filePath: '/home/user/.claude/plans/my-plan.md' },
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_abc' }],
      },
    })
    await writeEntry({ type: 'attachment', attachment: { type: 'task_reminder', content: [] } })
    expect(await getClaudeStatus(jsonlPath)).toBe('waiting')
  })

  it('returns running for Write to a non-plan file', async () => {
    await writeEntry({
      type: 'assistant',
      message: {
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_abc',
            name: 'Write',
            input: { file_path: '/workspace/src/index.ts', content: 'code' },
          },
        ],
      },
    })
    expect(await getClaudeStatus(jsonlPath)).toBe('running')
  })

  it('skips non-conversation entry types', async () => {
    await writeEntry({ type: 'system' })
    expect(await getClaudeStatus(jsonlPath)).toBe('waiting')
  })

  it('skips unknown entry types as non-conversation metadata', async () => {
    await writeEntry({ type: 'assistant', message: { stop_reason: 'end_turn' } })
    await writeEntry({ type: 'some-future-metadata-type', data: {} })
    expect(await getClaudeStatus(jsonlPath)).toBe('waiting')
  })

  it('returns waiting when file does not exist', async () => {
    const missing = path.join(tmpDir, 'nonexistent.jsonl')
    expect(await getClaudeStatus(missing)).toBe('waiting')
  })

  it('returns waiting for empty file', async () => {
    await fs.writeFile(jsonlPath, '')
    expect(await getClaudeStatus(jsonlPath)).toBe('waiting')
  })

  it('reads only the last entry when multiple entries exist', async () => {
    await writeEntry({ type: 'user', message: { role: 'user', content: 'hello' } })
    await writeEntry({ type: 'assistant', message: { stop_reason: 'end_turn' } })
    expect(await getClaudeStatus(jsonlPath)).toBe('waiting')
  })

  it('returns running when last entry follows a waiting entry', async () => {
    await writeEntry({ type: 'assistant', message: { stop_reason: 'end_turn' } })
    await writeEntry({ type: 'user', message: { role: 'user', content: 'do something' } })
    expect(await getClaudeStatus(jsonlPath)).toBe('running')
  })

  it('handles trailing newlines', async () => {
    await fs.writeFile(jsonlPath, JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn' } }) + '\n\n\n')
    expect(await getClaudeStatus(jsonlPath)).toBe('waiting')
  })

  it('skips system turn_duration metadata after end_turn', async () => {
    await writeEntry({ type: 'assistant', message: { stop_reason: 'end_turn' } })
    await writeEntry({ type: 'system', subtype: 'turn_duration', durationMs: 5000 })
    expect(await getClaudeStatus(jsonlPath)).toBe('waiting')
  })

  it('skips last-prompt metadata after end_turn', async () => {
    await writeEntry({ type: 'assistant', message: { stop_reason: 'end_turn' } })
    await writeEntry({ type: 'last-prompt', lastPrompt: 'hello', sessionId: 'abc' })
    expect(await getClaudeStatus(jsonlPath)).toBe('waiting')
  })

  it('skips permission-mode metadata after end_turn', async () => {
    await writeEntry({ type: 'assistant', message: { stop_reason: 'end_turn' } })
    await writeEntry({ type: 'permission-mode', permissionMode: 'default', sessionId: 'abc' })
    expect(await getClaudeStatus(jsonlPath)).toBe('waiting')
  })

  it('skips file-history-snapshot metadata after end_turn', async () => {
    await writeEntry({ type: 'assistant', message: { stop_reason: 'end_turn' } })
    await writeEntry({ type: 'file-history-snapshot', messageId: 'abc', snapshot: {} })
    expect(await getClaudeStatus(jsonlPath)).toBe('waiting')
  })

  it('skips multiple trailing metadata entries', async () => {
    await writeEntry({ type: 'assistant', message: { stop_reason: 'end_turn' } })
    await writeEntry({ type: 'system', subtype: 'turn_duration', durationMs: 5000 })
    await writeEntry({ type: 'file-history-snapshot', messageId: 'abc', snapshot: {} })
    await writeEntry({ type: 'last-prompt', lastPrompt: 'hello', sessionId: 'abc' })
    await writeEntry({ type: 'permission-mode', permissionMode: 'default', sessionId: 'abc' })
    expect(await getClaudeStatus(jsonlPath)).toBe('waiting')
  })

  it('returns running when user message follows metadata after end_turn', async () => {
    await writeEntry({ type: 'assistant', message: { stop_reason: 'end_turn' } })
    await writeEntry({ type: 'system', subtype: 'turn_duration', durationMs: 5000 })
    await writeEntry({ type: 'user', message: { role: 'user', content: 'next question' } })
    expect(await getClaudeStatus(jsonlPath)).toBe('running')
  })

  it('returns running for tool_use even with trailing metadata', async () => {
    await writeEntry({ type: 'assistant', message: { stop_reason: 'tool_use' } })
    await writeEntry({ type: 'system', subtype: 'turn_duration', durationMs: 5000 })
    expect(await getClaudeStatus(jsonlPath)).toBe('running')
  })

  it('returns waiting when only metadata entries exist', async () => {
    await writeEntry({ type: 'permission-mode', permissionMode: 'default', sessionId: 'abc' })
    expect(await getClaudeStatus(jsonlPath)).toBe('waiting')
  })

  it('skips agent-name metadata', async () => {
    await writeEntry({ type: 'assistant', message: { stop_reason: 'end_turn' } })
    await writeEntry({ type: 'agent-name' })
    expect(await getClaudeStatus(jsonlPath)).toBe('waiting')
  })

  it('skips custom-title metadata', async () => {
    await writeEntry({ type: 'assistant', message: { stop_reason: 'end_turn' } })
    await writeEntry({ type: 'custom-title' })
    expect(await getClaudeStatus(jsonlPath)).toBe('waiting')
  })

  it('skips queue-operation metadata', async () => {
    await writeEntry({ type: 'assistant', message: { stop_reason: 'end_turn' } })
    await writeEntry({ type: 'queue-operation' })
    expect(await getClaudeStatus(jsonlPath)).toBe('waiting')
  })

  it('returns waiting when assistant calls AskUserQuestion', async () => {
    await writeEntry({
      type: 'assistant',
      message: {
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_abc',
            name: 'AskUserQuestion',
            input: { questions: [{ question: 'Which approach?' }] },
          },
        ],
      },
    })
    expect(await getClaudeStatus(jsonlPath)).toBe('waiting')
  })

  it('returns waiting when AskUserQuestion follows metadata', async () => {
    await writeEntry({
      type: 'assistant',
      message: {
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_abc',
            name: 'AskUserQuestion',
            input: { questions: [{ question: 'Which approach?' }] },
          },
        ],
      },
    })
    await writeEntry({ type: 'system', subtype: 'turn_duration', durationMs: 5000 })
    expect(await getClaudeStatus(jsonlPath)).toBe('waiting')
  })

  it('returns waiting when assistant calls ExitPlanMode', async () => {
    await writeEntry({
      type: 'assistant',
      message: {
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_abc',
            name: 'ExitPlanMode',
            input: {},
          },
        ],
      },
    })
    expect(await getClaudeStatus(jsonlPath)).toBe('waiting')
  })

  it('returns waiting when ExitPlanMode follows metadata', async () => {
    await writeEntry({
      type: 'assistant',
      message: {
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_abc',
            name: 'ExitPlanMode',
            input: {},
          },
        ],
      },
    })
    await writeEntry({ type: 'system', subtype: 'turn_duration', durationMs: 5000 })
    expect(await getClaudeStatus(jsonlPath)).toBe('waiting')
  })

  it('returns waiting when user interrupted the request', async () => {
    await writeEntry({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }],
      },
    })
    expect(await getClaudeStatus(jsonlPath)).toBe('waiting')
  })

  it('returns waiting when user interrupted after assistant tool_use', async () => {
    await writeEntry({ type: 'assistant', message: { stop_reason: 'tool_use' } })
    await writeEntry({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }],
      },
    })
    expect(await getClaudeStatus(jsonlPath)).toBe('waiting')
  })

  it('skips unparseable lines instead of returning waiting', async () => {
    await writeEntry({ type: 'assistant', message: { stop_reason: 'tool_use' } })
    // Simulate a corrupted/partial line
    await fs.appendFile(jsonlPath, '{"type":"assistant","message":{"stop_re\n')
    expect(await getClaudeStatus(jsonlPath)).toBe('running')
  })

  it('scans across chunk boundaries for large files', async () => {
    await writeEntry({ type: 'assistant', message: { stop_reason: 'tool_use' } })
    // Write enough metadata to push the tool_use entry beyond a 4KB window
    for (let i = 0; i < 80; i++) {
      await writeEntry({ type: 'system', subtype: 'turn_duration', durationMs: 5000, padding: 'x'.repeat(20) })
    }
    expect(await getClaudeStatus(jsonlPath)).toBe('running')
  })
})

describe('getFirstUserMessage', () => {
  let tmpDir: string
  let jsonlPath: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'first-user-msg-test-'))
    jsonlPath = path.join(tmpDir, 'session.jsonl')
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  function writeEntry(entry: Record<string, unknown>): Promise<void> {
    return fs.appendFile(jsonlPath, JSON.stringify(entry) + '\n')
  }

  it('returns string content from first user message', async () => {
    await writeEntry({ type: 'permission-mode', permissionMode: 'default' })
    await writeEntry({ type: 'user', message: { role: 'user', content: 'fix the login bug' } })
    await writeEntry({ type: 'assistant', message: { stop_reason: 'end_turn' } })
    expect(await getFirstUserMessage(jsonlPath)).toBe('fix the login bug')
  })

  it('returns text from content block array', async () => {
    await writeEntry({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'refactor the API' }] },
    })
    expect(await getFirstUserMessage(jsonlPath)).toBe('refactor the API')
  })

  it('returns undefined when no user messages exist', async () => {
    await writeEntry({ type: 'permission-mode', permissionMode: 'default' })
    await writeEntry({ type: 'assistant', message: { stop_reason: 'end_turn' } })
    expect(await getFirstUserMessage(jsonlPath)).toBeUndefined()
  })

  it('returns undefined for empty file', async () => {
    await fs.writeFile(jsonlPath, '')
    expect(await getFirstUserMessage(jsonlPath)).toBeUndefined()
  })

  it('returns undefined for missing file', async () => {
    expect(await getFirstUserMessage(path.join(tmpDir, 'nope.jsonl'))).toBeUndefined()
  })

  it('skips metadata and returns first user message', async () => {
    await writeEntry({ type: 'system' })
    await writeEntry({ type: 'permission-mode', permissionMode: 'default' })
    await writeEntry({ type: 'user', message: { role: 'user', content: 'hello world' } })
    await writeEntry({ type: 'user', message: { role: 'user', content: 'second message' } })
    expect(await getFirstUserMessage(jsonlPath)).toBe('hello world')
  })
})
