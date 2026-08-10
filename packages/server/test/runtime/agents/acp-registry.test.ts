import { describe, it, expect, beforeEach } from 'vitest'
import {
  _resetAcpRegistryForTests,
  acpConversation,
  acpConversationByHandle,
  registerAcpConversation,
  unregisterAcpConversation,
} from '#runtime/agents/acp-registry'
import type { AcpConversation } from '#runtime/agents/acp-client'

/**
 * The registry is a lookup table, so a stand-in object is enough — what it has
 * to get right is that a conversation is reachable under BOTH names, and that
 * neither name outlives it.
 */
const fake = (id: string): AcpConversation => ({ id }) as unknown as AcpConversation

beforeEach(() => _resetAcpRegistryForTests())

describe('acpConversation', () => {
  it('finds a conversation by the id a pane addresses it with', () => {
    const c = fake('a')
    registerAcpConversation('demo', 'wt-1', { handle: 'claude', agentSessionId: 'acp-1' }, c)

    expect(acpConversation('demo', 'wt-1', 'acp-1')).toBe(c)
    // The driver's own name for it resolves to the same object.
    expect(acpConversationByHandle('demo', 'wt-1', 'claude')).toBe(c)
  })

  it('is scoped per worktree and per project, so ids cannot collide across them', () => {
    registerAcpConversation('demo', 'wt-1', { handle: 'claude', agentSessionId: 'acp-1' }, fake('a'))

    expect(acpConversation('demo', 'wt-2', 'acp-1')).toBeUndefined()
    expect(acpConversation('other', 'wt-1', 'acp-1')).toBeUndefined()
    // Handles are reused across worktrees by construction — every worktree's
    // primary window is named for its tool.
    registerAcpConversation('demo', 'wt-2', { handle: 'claude', agentSessionId: 'acp-2' }, fake('b'))
    expect(acpConversationByHandle('demo', 'wt-1', 'claude'))
      .not.toBe(acpConversationByHandle('demo', 'wt-2', 'claude'))
  })

  it('is reachable by handle before the handshake mints an id, and by both after', () => {
    const c = fake('a')
    // A fresh conversation has no id yet — `session/new` has not answered.
    registerAcpConversation('demo', 'wt-1', { handle: 'claude' }, c)
    expect(acpConversationByHandle('demo', 'wt-1', 'claude')).toBe(c)

    registerAcpConversation('demo', 'wt-1', { handle: 'claude', agentSessionId: 'acp-1' }, c)
    expect(acpConversation('demo', 'wt-1', 'acp-1')).toBe(c)
    expect(acpConversationByHandle('demo', 'wt-1', 'claude')).toBe(c)
  })

  it('drops both names on unregister, so a dead conversation is never handed out', () => {
    registerAcpConversation('demo', 'wt-1', { handle: 'claude', agentSessionId: 'acp-1' }, fake('a'))
    unregisterAcpConversation('demo', 'wt-1', { handle: 'claude', agentSessionId: 'acp-1' })

    expect(acpConversation('demo', 'wt-1', 'acp-1')).toBeUndefined()
    expect(acpConversationByHandle('demo', 'wt-1', 'claude')).toBeUndefined()
  })
})
