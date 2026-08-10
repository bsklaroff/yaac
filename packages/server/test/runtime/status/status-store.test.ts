import { describe, it, expect, vi, beforeEach } from 'vitest'

import {
  readWorktreeStatus,
  readWorktreeWaitingSince,
  isWorktreeStreamHealthy,
  setAgentStatus,
  setWorktreeStreamHealth,
  evictWorktreeStatus,
  setLiveAgents,
  onLiveAgentsChanged,
  onWorktreeStatusChanged,
  _resetWorktreeStatusStoreForTests,
} from '#runtime/status/status-store'

beforeEach(() => {
  _resetWorktreeStatusStoreForTests()
})

describe('readWorktreeStatus', () => {
  it('returns waiting for a session with no entry', () => {
    expect(readWorktreeStatus('demo', 's1')).toBe('waiting')
  })

  it('returns the stored status after a write', () => {
    setAgentStatus('demo', 's1', '%0', 'running')
    expect(readWorktreeStatus('demo', 's1')).toBe('running')
  })

  it('keys by slug AND session id', () => {
    setAgentStatus('demo', 's1', '%0', 'running')
    expect(readWorktreeStatus('other', 's1')).toBe('waiting')
    expect(readWorktreeStatus('demo', 's2')).toBe('waiting')
  })
})

describe('isWorktreeStreamHealthy', () => {
  it('returns false for a session with no entry', () => {
    expect(isWorktreeStreamHealthy('demo', 's1')).toBe(false)
  })

  it('returns true after a status write (classification implies a live stream)', () => {
    setAgentStatus('demo', 's1', '%0', 'waiting')
    expect(isWorktreeStreamHealthy('demo', 's1')).toBe(true)
  })
})

describe('setAgentStatus', () => {
  it('fires the change listener when the status flips', () => {
    const listener = vi.fn()
    onWorktreeStatusChanged(listener)
    setAgentStatus('demo', 's1', '%0', 'running')
    expect(listener).toHaveBeenCalledTimes(1)
    setAgentStatus('demo', 's1', '%0', 'waiting')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('does not fire when the same status is re-set on a healthy entry', () => {
    setAgentStatus('demo', 's1', '%0', 'running')
    const listener = vi.fn()
    onWorktreeStatusChanged(listener)
    setAgentStatus('demo', 's1', '%0', 'running')
    expect(listener).not.toHaveBeenCalled()
  })

  it('fires when re-classifying an unhealthy entry (health became visible)', () => {
    setAgentStatus('demo', 's1', '%0', 'running')
    setWorktreeStreamHealth('demo', 's1', false)
    const listener = vi.fn()
    onWorktreeStatusChanged(listener)
    setAgentStatus('demo', 's1', '%0', 'running')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(isWorktreeStreamHealthy('demo', 's1')).toBe(true)
  })
})

describe('setWorktreeStreamHealth', () => {
  it('creates a waiting entry when marking an absent session healthy', () => {
    const listener = vi.fn()
    onWorktreeStatusChanged(listener)
    setWorktreeStreamHealth('demo', 's1', true)
    expect(readWorktreeStatus('demo', 's1')).toBe('waiting')
    expect(isWorktreeStreamHealthy('demo', 's1')).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when marking an absent session unhealthy', () => {
    const listener = vi.fn()
    onWorktreeStatusChanged(listener)
    setWorktreeStreamHealth('demo', 's1', false)
    expect(isWorktreeStreamHealthy('demo', 's1')).toBe(false)
    expect(listener).not.toHaveBeenCalled()
  })

  it('keeps the sticky status across a health drop', () => {
    setAgentStatus('demo', 's1', '%0', 'running')
    setWorktreeStreamHealth('demo', 's1', false)
    expect(readWorktreeStatus('demo', 's1')).toBe('running')
    expect(isWorktreeStreamHealthy('demo', 's1')).toBe(false)
  })

  it('fires only when the health bit actually flips', () => {
    setAgentStatus('demo', 's1', '%0', 'running')
    const listener = vi.fn()
    onWorktreeStatusChanged(listener)
    setWorktreeStreamHealth('demo', 's1', true)
    expect(listener).not.toHaveBeenCalled()
    setWorktreeStreamHealth('demo', 's1', false)
    expect(listener).toHaveBeenCalledTimes(1)
    setWorktreeStreamHealth('demo', 's1', false)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('readWorktreeWaitingSince (waiting spells)', () => {
  it('returns undefined for an absent entry (booting — no spell yet)', () => {
    expect(readWorktreeWaitingSince('demo', 's1')).toBeUndefined()
  })

  it('stamps a spell on entering waiting and keeps it while waiting persists', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      setAgentStatus('demo', 's1', '%0', 'waiting')
      expect(readWorktreeWaitingSince('demo', 's1')).toBe(1_000)
      vi.setSystemTime(5_000)
      setAgentStatus('demo', 's1', '%0', 'waiting')
      expect(readWorktreeWaitingSince('demo', 's1')).toBe(1_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the spell on running and restamps on the next wait', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      setAgentStatus('demo', 's1', '%0', 'waiting')
      setAgentStatus('demo', 's1', '%0', 'running')
      expect(readWorktreeWaitingSince('demo', 's1')).toBeUndefined()
      vi.setSystemTime(2_000)
      setAgentStatus('demo', 's1', '%0', 'waiting')
      expect(readWorktreeWaitingSince('demo', 's1')).toBe(2_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stamps the waiting entry created by a healthy-attach on an absent session', () => {
    setWorktreeStreamHealth('demo', 's1', true)
    expect(readWorktreeWaitingSince('demo', 's1')).toBeGreaterThan(0)
  })

  it('keeps the spell across a stream-health drop (sticky, like status)', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      setAgentStatus('demo', 's1', '%0', 'waiting')
      vi.setSystemTime(9_000)
      setWorktreeStreamHealth('demo', 's1', false)
      setWorktreeStreamHealth('demo', 's1', true)
      expect(readWorktreeWaitingSince('demo', 's1')).toBe(1_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('is gone after eviction', () => {
    setAgentStatus('demo', 's1', '%0', 'waiting')
    evictWorktreeStatus('demo', 's1')
    expect(readWorktreeWaitingSince('demo', 's1')).toBeUndefined()
  })
})

describe('evictWorktreeStatus', () => {
  it('removes the entry and fires the listener', () => {
    setAgentStatus('demo', 's1', '%0', 'running')
    const listener = vi.fn()
    onWorktreeStatusChanged(listener)
    evictWorktreeStatus('demo', 's1')
    expect(readWorktreeStatus('demo', 's1')).toBe('waiting')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('does not fire for an absent entry', () => {
    const listener = vi.fn()
    onWorktreeStatusChanged(listener)
    evictWorktreeStatus('demo', 's1')
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('onWorktreeStatusChanged', () => {
  it('replaces the previous listener (last registration wins)', () => {
    const first = vi.fn()
    const second = vi.fn()
    onWorktreeStatusChanged(first)
    onWorktreeStatusChanged(second)
    setAgentStatus('demo', 's1', '%0', 'running')
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})

describe('onLiveAgentsChanged', () => {
  // This is what marks the reconciler dirty, and the whole reason an `acp`
  // conversation's row does not wait out the 60s resync: its id arrives from
  // the in-pod handshake, which no cluster watch can see.
  it('fires when a conversation appears, goes, or learns its id', () => {
    const listener = vi.fn()
    onLiveAgentsChanged(listener)
    setLiveAgents('demo', 's1', [{ handle: 'claude-1', tool: 'claude' }])
    expect(listener).toHaveBeenCalledTimes(1)
    // The handshake answering: same handle, now addressable.
    setLiveAgents('demo', 's1', [{ handle: 'claude-1', tool: 'claude', agentSessionId: 'conv-a' }])
    expect(listener).toHaveBeenCalledTimes(2)
    setLiveAgents('demo', 's1', [])
    expect(listener).toHaveBeenCalledTimes(3)
  })

  // A driver republishes the same set on every sweep, and every turn boundary
  // writes a status — neither is a reason to sweep the pods again.
  it('does not fire for a re-publish of the same set, or for a status flip', () => {
    setLiveAgents('demo', 's1', [{ handle: 'claude-1', tool: 'claude', agentSessionId: 'conv-a' }])
    const listener = vi.fn()
    onLiveAgentsChanged(listener)
    // Fresh literals, not a copy of the array: both drivers rebuild their
    // agent objects on every publish, so a `changed` computed by reference
    // equality would pass a copied-array test and then fire once per sweep
    // per worktree in production.
    setLiveAgents('demo', 's1', [{ handle: 'claude-1', tool: 'claude', agentSessionId: 'conv-a' }])
    setAgentStatus('demo', 's1', 'claude-1', 'running')
    setAgentStatus('demo', 's1', 'claude-1', 'waiting')
    expect(listener).not.toHaveBeenCalled()
  })
})
