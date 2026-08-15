import { describe, it, expect } from 'vitest'
import { agentLabel, formatModel, worktreeModel } from '#lib/agentLabel'
import type { AgentSessionEntry, WorktreeListEntry } from '@yaac/shared/types'

const session = (over: Partial<AgentSessionEntry> = {}): AgentSessionEntry => ({
  agentSessionId: 'conv-a',
  tool: 'claude',
  ordinal: 0,
  active: true,
  ...over,
})

const worktree = (agentSessions: AgentSessionEntry[]): WorktreeListEntry => ({
  worktreeId: 's1',
  projectSlug: 'proj',
  tool: 'claude',
  status: 'running',
  createdAt: '2026-08-10 00:00:00',
  agentSessions,
  blockedHosts: [],
  forwardedPorts: [],
  unforwardedPorts: [],
})

/**
 * The model arrives in the tool's own spelling, which is what belongs in the
 * row and not what belongs beside a tool name. Shortening it is presentational
 * only — and deliberately conservative, since a wrong short name is worse than
 * a long right one.
 */
describe('formatModel', () => {
  it('says an anthropic id the way a person would', () => {
    expect(formatModel('claude-opus-5')).toBe('Opus 5')
    expect(formatModel('claude-fable-5')).toBe('Fable 5')
    expect(formatModel('claude-opus-4-8')).toBe('Opus 4.8')
  })

  it('drops the date and context suffixes an id may carry', () => {
    expect(formatModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(formatModel('claude-opus-5[1m]')).toBe('Opus 5')
  })

  it('does not read a date as a minor version on a major-only id', () => {
    // The optional minor group will happily match an 8-digit date unless it is
    // bounded — which would render a real, still-selectable id as
    // "Sonnet 4.20250514". Recognizing an id and then mangling it is worse
    // than not recognizing it.
    expect(formatModel('claude-sonnet-4-20250514')).toBe('Sonnet 4')
    expect(formatModel('claude-opus-4-20250514')).toBe('Opus 4')
    expect(formatModel('claude-opus-4-1-20250805')).toBe('Opus 4.1')
  })

  it('keeps only the model half of a provider-qualified id', () => {
    // The provider is already implied by the tool name beside it.
    expect(formatModel('anthropic/claude-opus-4-8')).toBe('Opus 4.8')
    expect(formatModel('openai/gpt-5.6-sol')).toBe('gpt-5.6-sol')
  })

  it('passes an unrecognized id through rather than mangling it', () => {
    // Every tool but claude names models in its own grammar, and new ones
    // appear without this file changing — showing the id verbatim is always
    // truthful, where a guess at its shape is not.
    expect(formatModel('gpt-5.6-sol')).toBe('gpt-5.6-sol')
    expect(formatModel('zai-glm-4.7')).toBe('zai-glm-4.7')
  })
})

describe('agentLabel', () => {
  it('names the tool and the model it is answering as', () => {
    expect(agentLabel('claude', 'claude-opus-5')).toBe('Claude · Opus 5')
    expect(agentLabel('codex', 'gpt-5.6-sol')).toBe('Codex · gpt-5.6-sol')
  })

  it('falls back to the bare tool name when no model is known', () => {
    // Before the first reply, and forever for opencode — which leaves no
    // transcript to read one from.
    expect(agentLabel('claude', undefined)).toBe('Claude')
    expect(agentLabel('opencode', undefined)).toBe('OpenCode')
  })
})

describe('worktreeModel', () => {
  it('prefers a live conversation over the worktree\'s history', () => {
    // A `/clear`ed conversation is still linked and still names a model; what
    // the worktree is running now is what the live one says.
    expect(worktreeModel(worktree([
      session({ agentSessionId: 'old', ordinal: 0, active: false, model: 'claude-opus-4-8' }),
      session({ agentSessionId: 'live', ordinal: 1, active: true, model: 'claude-opus-5' }),
    ]))).toBe('claude-opus-5')
  })

  it('takes the primary agent when several are live', () => {
    // Ordinal 0 is the window a restart brings up first — the worktree's own
    // agent rather than a second one opened beside it.
    expect(worktreeModel(worktree([
      session({ agentSessionId: 'second', ordinal: 1, model: 'claude-fable-5' }),
      session({ agentSessionId: 'primary', ordinal: 0, model: 'claude-opus-5' }),
    ]))).toBe('claude-opus-5')
  })

  it('falls back to history when no live conversation has reported one', () => {
    // The live agent is appending to the same transcript the recorded one came
    // from, so its model is the better guess than nothing at all.
    expect(worktreeModel(worktree([
      session({ agentSessionId: 'old', ordinal: 0, active: false, model: 'claude-opus-5' }),
      session({ agentSessionId: 'live', ordinal: 1, active: true }),
    ]))).toBe('claude-opus-5')
  })

  it('reports none for a worktree whose agents have not answered yet', () => {
    expect(worktreeModel(worktree([session()]))).toBeUndefined()
    expect(worktreeModel(worktree([]))).toBeUndefined()
  })
})
