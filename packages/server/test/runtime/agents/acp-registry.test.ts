import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  _resetAcpRegistryForTests,
  acpConversation,
  acpConversationByHandle,
  dropAcpQueues,
  parkAcpQueue,
  registerAcpConversation,
  takeAcpQueue,
  unregisterAcpConversation,
} from '#runtime/agents/acp-registry'
import type { AcpConversation, QueuedTurn } from '#runtime/agents/acp-client'

/**
 * A stand-in conversation. The registry must find it under both its
 * session id and its handle, and drop both names together.
 */
const fake = (id: string): AcpConversation => ({ id }) as unknown as AcpConversation

beforeEach(() => _resetAcpRegistryForTests())

describe('acpConversation', () => {
  it('finds a conversation by the id a pane addresses it with', () => {
    const c = fake('a')
    registerAcpConversation('demo', 'wt-1', { handle: 'claude', agentSessionId: 'acp-1' }, c)

    expect(acpConversation('demo', 'wt-1', 'acp-1')).toBe(c)
    expect(acpConversationByHandle('demo', 'wt-1', 'claude')).toBe(c)
  })

  it('is scoped per workspace and per project, so ids cannot collide across them', () => {
    registerAcpConversation('demo', 'wt-1', { handle: 'claude', agentSessionId: 'acp-1' }, fake('a'))

    expect(acpConversation('demo', 'wt-2', 'acp-1')).toBeUndefined()
    expect(acpConversation('other', 'wt-1', 'acp-1')).toBeUndefined()
    // Handles repeat across workspaces (each primary window is named for its tool).
    registerAcpConversation('demo', 'wt-2', { handle: 'claude', agentSessionId: 'acp-2' }, fake('b'))
    expect(acpConversationByHandle('demo', 'wt-1', 'claude'))
      .not.toBe(acpConversationByHandle('demo', 'wt-2', 'claude'))
  })

  it('is reachable by handle before the handshake mints an id, and by both after', () => {
    const c = fake('a')
    // No session id until `session/new` answers.
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

describe('dropAcpQueues', () => {
  const turn = (text: string): QueuedTurn =>
    ({ id: text, text, images: 0, blocks: [], resolve: () => {}, reject: vi.fn() })

  it('discards a workspace\'s parked queues, sparing the sessions still live and other workspaces', () => {
    const [live, gone, elsewhere] = [turn('live'), turn('gone'), turn('elsewhere')]
    parkAcpQueue('demo', 'wt-1', 'acp-live', [live])
    parkAcpQueue('demo', 'wt-1', 'acp-gone', [gone])
    parkAcpQueue('demo', 'wt-2', 'acp-gone', [elsewhere])

    dropAcpQueues('demo', 'wt-1', new Set(['acp-live']))

    // A dropped message is rejected, so its sender logs it.
    expect(gone.reject).toHaveBeenCalled()
    expect(takeAcpQueue('demo', 'wt-1', 'acp-gone')).toEqual([])
    expect(takeAcpQueue('demo', 'wt-1', 'acp-live')).toEqual([live])
    expect(takeAcpQueue('demo', 'wt-2', 'acp-gone')).toEqual([elsewhere])
  })
})
