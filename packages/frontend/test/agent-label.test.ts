import { describe, it, expect } from 'vitest'
import { agentLabel, formatModel, workspaceAgentLabel } from '#lib/agentLabel'
import { sessionEntry } from './harness'

/**
 * Shortening a raw model id for display. Conservative, since a wrong short
 * name is worse than a long correct one.
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
    // A date after the major version is not a minor version.
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
    // Other tools' ids are shown verbatim.
    expect(formatModel('gpt-5.6-sol')).toBe('gpt-5.6-sol')
    expect(formatModel('zai-glm-4.7')).toBe('zai-glm-4.7')
  })
})

describe('agentLabel', () => {
  it('names the tool and the model it is answering as, by the catalog\'s name first', () => {
    expect(agentLabel('codex', { model: 'gpt-6-sol', modelName: 'GPT-6 Sol' })).toBe('Codex · GPT-6 Sol')
    // An id the catalog does not name is shortened here instead.
    expect(agentLabel('claude', { model: 'claude-opus-5' })).toBe('Claude · Opus 5')
    expect(agentLabel('codex', { model: 'gpt-5.6-sol' })).toBe('Codex · gpt-5.6-sol')
  })

  it('falls back to the bare tool name when no model is known', () => {
    // A conversation launched without one, before its first reply.
    expect(agentLabel('claude', undefined)).toBe('Claude')
    expect(agentLabel('opencode', {})).toBe('OpenCode')
  })
})

describe('workspaceAgentLabel', () => {
  it('names a workspace by its first session\'s agent', () => {
    expect(workspaceAgentLabel({
      sessions: [
        sessionEntry({ sessionId: 'a', model: 'claude-opus-5' }),
        sessionEntry({ sessionId: 'b', tool: 'codex', model: 'gpt-6-sol' }),
      ],
    })).toBe('Claude · Opus 5')
  })

  it('says a workspace with no session runs no agent', () => {
    expect(workspaceAgentLabel({ sessions: [] })).toBe('No agent')
    expect(agentLabel(undefined, undefined)).toBe('No agent')
  })
})
