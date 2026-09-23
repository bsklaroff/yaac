import { describe, it, expect, beforeEach } from 'vitest'
import { parkAcpLaunchModel } from '#runtime/agents'
// What the first attach does with a parked model, and the state-reset hook —
// read here to see what was parked, not tested in their own right.
import { _resetAcpRegistryForTests, takeAcpLaunchModel } from '#runtime/agents/acp-registry'

describe('parkAcpLaunchModel', () => {
  beforeEach(() => _resetAcpRegistryForTests())

  it('parks the model for the adapters told it over the protocol, once', () => {
    parkAcpLaunchModel('pi', 'spare1', 'openrouter/moonshotai/kimi-k2.6')
    parkAcpLaunchModel('opencode', 'spare2', 'anthropic/claude-opus-5-5')
    expect(takeAcpLaunchModel('spare1')).toBe('openrouter/moonshotai/kimi-k2.6')
    expect(takeAcpLaunchModel('spare2')).toBe('anthropic/claude-opus-5-5')
    // Taken once: a reattach must not re-assert it over the user's own switch.
    expect(takeAcpLaunchModel('spare1')).toBeUndefined()
  })

  // claude and codex took the model on their command line or environment, so
  // nothing would ever take a parked one — it would only leak.
  it('parks nothing for an adapter launched with its model, or with no model', () => {
    parkAcpLaunchModel('claude', 'a', 'claude-opus-5-5')
    parkAcpLaunchModel('codex', 'b', 'gpt-6-sol')
    parkAcpLaunchModel('pi', 'c', undefined)
    expect(takeAcpLaunchModel('a')).toBeUndefined()
    expect(takeAcpLaunchModel('b')).toBeUndefined()
    expect(takeAcpLaunchModel('c')).toBeUndefined()
  })
})
