import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { getClaudeStatus } from '@/lib/claude-status'

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

  it('skips system metadata entry (treated as metadata)', async () => {
    await writeEntry({ type: 'system' })
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
})
