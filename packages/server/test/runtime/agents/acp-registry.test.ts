import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  _resetAcpRegistryForTests,
  acpHandshakeHold,
  dropAcpQueues,
  holdAcpHandshakes,
  parkAcpQueue,
  registerAcpConversation,
  takeAcpQueue,
  unregisterAcpConversation,
  whenAcpConversation,
} from '#runtime/agents/acp-registry'
import type { AcpConversation, QueuedTurn } from '#runtime/agents/acp-client'

/** A stand-in conversation; the registry only stores and hands it out. */
const fake = (id: string): AcpConversation => ({ id }) as unknown as AcpConversation

beforeEach(() => _resetAcpRegistryForTests())

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

    registerAcpConversation('demo', 'wt-1', { handle: 'claude', conversationId: 'acp-1' }, c)
    await expect(waited).resolves.toBe(c)
    // Already named: answered at once, and scoped per workspace.
    await expect(whenAcpConversation('demo', 'wt-1', 'claude', 0)).resolves.toBe(c)
    await expect(whenAcpConversation('demo', 'wt-2', 'claude', 0)).resolves.toBeUndefined()
  })

  // A respawned agent's old conversation stays named until its stream is
  // seen closing; a hand-over must reach the one on the current process.
  it('waits for a conversation on the given pane process, past one a respawn replaced', async () => {
    registerAcpConversation('demo', 'wt-1', { handle: 'claude', conversationId: 'acp-old', panePid: '10' }, fake('old'))
    const waited = whenAcpConversation('demo', 'wt-1', 'claude', 60_000, '11')
    // Named before its old pid is gone, as a late close allows.
    const next = fake('next')
    registerAcpConversation('demo', 'wt-1', { handle: 'claude', panePid: '11' }, next)
    registerAcpConversation('demo', 'wt-1', { handle: 'claude', conversationId: 'acp-new', panePid: '11' }, next)
    await expect(waited).resolves.toBe(next)
    await expect(whenAcpConversation('demo', 'wt-1', 'claude', 0, '10')).resolves.toBeUndefined()
  })

  it('is scoped per project, and hands out no conversation once it is unregistered', async () => {
    registerAcpConversation('demo', 'wt-1', { handle: 'claude', conversationId: 'acp-1' }, fake('a'))
    await expect(whenAcpConversation('other', 'wt-1', 'claude', 0)).resolves.toBeUndefined()

    unregisterAcpConversation('demo', 'wt-1', { handle: 'claude', conversationId: 'acp-1' })
    await expect(whenAcpConversation('demo', 'wt-1', 'claude', 0)).resolves.toBeUndefined()
  })

  it('gives up after the timeout', async () => {
    vi.useFakeTimers()
    const waited = whenAcpConversation('demo', 'wt-1', 'claude', 5_000)
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(waited).resolves.toBeUndefined()
  })
})

describe('holdAcpHandshakes', () => {
  // A start opens its agents' windows before the checkouts are final; the
  // conversations wait on the hold before their handshake reads them.
  it('holds one workspace\'s handshakes until let go, and a second start\'s hold replaces the first', async () => {
    expect(acpHandshakeHold('demo', 'wt-1')).toBeUndefined()
    const release = holdAcpHandshakes('demo', 'wt-1')
    const held = acpHandshakeHold('demo', 'wt-1')
    expect(held).toBeDefined()
    expect(acpHandshakeHold('demo', 'wt-2')).toBeUndefined()
    let settled = false
    void held!.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    release()
    await held
    expect(acpHandshakeHold('demo', 'wt-1')).toBeUndefined()
    // Letting go twice is harmless.
    release()

    // A failed start's late release cannot end its successor's hold.
    const first = holdAcpHandshakes('demo', 'wt-1')
    const second = holdAcpHandshakes('demo', 'wt-1')
    first()
    expect(acpHandshakeHold('demo', 'wt-1')).toBeDefined()
    second()
    expect(acpHandshakeHold('demo', 'wt-1')).toBeUndefined()
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
