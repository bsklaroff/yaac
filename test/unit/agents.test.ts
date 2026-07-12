import { describe, it, expect } from 'vitest'
import { parseClaudeAgents, readClaudeAgents, claudeTranscriptPath } from '@/lib/session/agents'

const j = (o: unknown): string => JSON.stringify(o)
const spawn = (id: string, type: string, task: string, ts?: string): string =>
  j({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', name: 'Agent', id, input: { subagent_type: type, description: task, prompt: 'go' } }] } })
const result = (id: string, text: string, ts?: string): string =>
  j({ type: 'user', timestamp: ts, message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] } })
const bash = (id: string): string =>
  j({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id, input: { command: 'ls' } }] } })
const bashResult = (id: string): string =>
  j({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'files' }] } })

describe('parseClaudeAgents', () => {
  const lines = [
    spawn('toolu_1', 'Explore', 'Map networking', '2026-07-11T10:00:00Z'),
    bash('toolu_b'),
    bashResult('toolu_b'),
    result('toolu_1', 'architectural map done', '2026-07-11T10:00:30Z'),
    spawn('toolu_2', 'general-purpose', 'Batch synth 2', '2026-07-11T10:01:00Z'),
  ]

  it('builds sub-agents in spawn order with status + result', () => {
    const agents = parseClaudeAgents(lines)
    expect(agents.map((a) => a.id)).toEqual(['toolu_1', 'toolu_2'])

    expect(agents[0]).toMatchObject({
      id: 'toolu_1', type: 'Explore', task: 'Map networking', status: 'done',
      result: 'architectural map done',
    })
    expect(agents[0].spawnedAt).toBe(Date.parse('2026-07-11T10:00:00Z'))
    expect(agents[0].completedAt).toBe(Date.parse('2026-07-11T10:00:30Z'))

    // No tool_result yet → running, no result.
    expect(agents[1]).toMatchObject({ id: 'toolu_2', type: 'general-purpose', task: 'Batch synth 2', status: 'running' })
    expect(agents[1].result).toBeUndefined()
  })

  it('ignores non-Agent tool results (Bash etc.)', () => {
    const agents = parseClaudeAgents(lines)
    expect(agents.some((a) => a.id === 'toolu_b')).toBe(false)
  })

  it('skips blank and malformed lines', () => {
    const agents = parseClaudeAgents(['', '   ', 'not json', spawn('toolu_x', 'Explore', 'x')])
    expect(agents.map((a) => a.id)).toEqual(['toolu_x'])
  })

  it('caps very large results', () => {
    const big = 'x'.repeat(10_000)
    const agents = parseClaudeAgents([spawn('toolu_9', 'a', 't'), result('toolu_9', big)])
    expect(agents[0].result?.length).toBe(6000)
  })

  it('returns [] for no input', () => {
    expect(parseClaudeAgents([])).toEqual([])
  })
})

describe('readClaudeAgents', () => {
  it('returns [] when the transcript file is missing', async () => {
    expect(await readClaudeAgents('/nonexistent/path/session.jsonl')).toEqual([])
  })
})

describe('claudeTranscriptPath', () => {
  it('points at the host-side per-workspace transcript', () => {
    const p = claudeTranscriptPath('demo', 'abc-123')
    expect(p.endsWith('/claude/projects/-workspace/abc-123.jsonl')).toBe(true)
  })
})
