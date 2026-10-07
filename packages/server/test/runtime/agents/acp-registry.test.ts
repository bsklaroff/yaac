import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  _resetAcpRegistryForTests,
  acpConversation,
  dropAcpQueues,
  parkAcpQueue,
  registerAcpConversation,
  takeAcpQueue,
  unregisterAcpConversation,
  whenAcpConversation,
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
  })

  it('is scoped per workspace and per project, so ids cannot collide across them', () => {
    registerAcpConversation('demo', 'wt-1', { handle: 'claude', agentSessionId: 'acp-1' }, fake('a'))

    expect(acpConversation('demo', 'wt-2', 'acp-1')).toBeUndefined()
    expect(acpConversation('other', 'wt-1', 'acp-1')).toBeUndefined()
  })

  it('drops both names on unregister, so a dead conversation is never handed out', async () => {
    registerAcpConversation('demo', 'wt-1', { handle: 'claude', agentSessionId: 'acp-1' }, fake('a'))
    unregisterAcpConversation('demo', 'wt-1', { handle: 'claude', agentSessionId: 'acp-1' })

    expect(acpConversation('demo', 'wt-1', 'acp-1')).toBeUndefined()
    await expect(whenAcpConversation('demo', 'wt-1', 'claude', 0)).resolves.toBeUndefined()
  })
})

describe('whenAcpConversation', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  // A fresh conversation is registered by handle at attach, then again with
  // the id `session/new` mints; only the second is a conversation a pane
  // and a prompt can use.
  it('waits for the handshake to name the conversation on a handle', async () => {
    const c = fake('a')
    const waited = whenAcpConversation('demo', 'wt-1', 'claude', 60_000)
    registerAcpConversation('demo', 'wt-1', { handle: 'claude' }, c)
    let settled = false
    void waited.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    registerAcpConversation('demo', 'wt-1', { handle: 'claude', agentSessionId: 'acp-1' }, c)
    await expect(waited).resolves.toBe(c)
    // Already named: answered at once, and scoped per workspace.
    await expect(whenAcpConversation('demo', 'wt-1', 'claude', 0)).resolves.toBe(c)
    await expect(whenAcpConversation('demo', 'wt-2', 'claude', 0)).resolves.toBeUndefined()
  })

  // A respawned agent's old conversation stays named until its stream is
  // seen closing; a hand-over must reach the one on the current process.
  it('waits for a conversation on the given pane process, past one a respawn replaced', async () => {
    registerAcpConversation('demo', 'wt-1', { handle: 'claude', agentSessionId: 'acp-old', panePid: '10' }, fake('old'))
    const waited = whenAcpConversation('demo', 'wt-1', 'claude', 60_000, '11')
    // Named before its old pid is gone, as a late close allows.
    const next = fake('next')
    registerAcpConversation('demo', 'wt-1', { handle: 'claude', panePid: '11' }, next)
    registerAcpConversation('demo', 'wt-1', { handle: 'claude', agentSessionId: 'acp-new', panePid: '11' }, next)
    await expect(waited).resolves.toBe(next)
    await expect(whenAcpConversation('demo', 'wt-1', 'claude', 0, '10')).resolves.toBeUndefined()
  })

  it('gives up after the timeout', async () => {
    vi.useFakeTimers()
    const waited = whenAcpConversation('demo', 'wt-1', 'claude', 5_000)
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(waited).resolves.toBeUndefined()
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
