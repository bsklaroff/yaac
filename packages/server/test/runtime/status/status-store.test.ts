import { describe, it, expect, vi, beforeEach } from 'vitest'

import {
  readWorkspaceStatus,
  readWorkspaceWaitingSince,
  isWorkspaceStreamHealthy,
  setAgentStatus,
  setWorkspaceStreamHealth,
  evictWorkspaceStatus,
  setLiveAgents,
  onLiveAgentsChanged,
  onStreamHealthLost,
  _resetWorkspaceStatusStoreForTests,
} from '#runtime/status/status-store'
import { onWorkspaceListChanged, _resetWorkspaceListChangedForTests } from '#notify'

// The store announces changes on #notify; these tests listen there.
beforeEach(() => {
  _resetWorkspaceStatusStoreForTests()
  _resetWorkspaceListChangedForTests()
})

describe('readWorkspaceStatus', () => {
  it('returns waiting for a session with no entry', () => {
    expect(readWorkspaceStatus('demo', 's1')).toBe('waiting')
  })

  it('returns the stored status after a write', () => {
    setAgentStatus('demo', 's1', '%0', 'running')
    expect(readWorkspaceStatus('demo', 's1')).toBe('running')
  })

  it('keys by slug AND session id', () => {
    setAgentStatus('demo', 's1', '%0', 'running')
    expect(readWorkspaceStatus('other', 's1')).toBe('waiting')
    expect(readWorkspaceStatus('demo', 's2')).toBe('waiting')
  })
})

describe('isWorkspaceStreamHealthy', () => {
  it('returns false for a session with no entry', () => {
    expect(isWorkspaceStreamHealthy('demo', 's1')).toBe(false)
  })

  it('returns true after a status write (classification implies a live stream)', () => {
    setAgentStatus('demo', 's1', '%0', 'waiting')
    expect(isWorkspaceStreamHealthy('demo', 's1')).toBe(true)
  })
})

describe('setAgentStatus', () => {
  it('fires the change listener when the status flips', () => {
    const listener = vi.fn()
    onWorkspaceListChanged(listener)
    setAgentStatus('demo', 's1', '%0', 'running')
    expect(listener).toHaveBeenCalledTimes(1)
    setAgentStatus('demo', 's1', '%0', 'waiting')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('does not fire when the same status is re-set on a healthy entry', () => {
    setAgentStatus('demo', 's1', '%0', 'running')
    const listener = vi.fn()
    onWorkspaceListChanged(listener)
    setAgentStatus('demo', 's1', '%0', 'running')
    expect(listener).not.toHaveBeenCalled()
  })

  // Per-agent status is in the snapshot too, so a change must push even
  // when the workspace's overall status is unchanged.
  it('fires when a sibling flips but the workspace aggregate does not', () => {
    setAgentStatus('demo', 's1', '%0', 'waiting')
    setAgentStatus('demo', 's1', '%1', 'running')
    const listener = vi.fn()
    onWorkspaceListChanged(listener)

    // %1 running→waiting: overall stays `waiting`.
    setAgentStatus('demo', 's1', '%1', 'waiting')
    expect(readWorkspaceStatus('demo', 's1')).toBe('waiting')
    expect(listener).toHaveBeenCalledTimes(1)

    // %0 waiting→running: still `waiting` overall because of %1.
    setAgentStatus('demo', 's1', '%0', 'running')
    expect(readWorkspaceStatus('demo', 's1')).toBe('waiting')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('fires when re-classifying an unhealthy entry (health became visible)', () => {
    setAgentStatus('demo', 's1', '%0', 'running')
    setWorkspaceStreamHealth('demo', 's1', false)
    const listener = vi.fn()
    onWorkspaceListChanged(listener)
    setAgentStatus('demo', 's1', '%0', 'running')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(isWorkspaceStreamHealthy('demo', 's1')).toBe(true)
  })
})

describe('setWorkspaceStreamHealth', () => {
  it('creates a waiting entry when marking an absent session healthy', () => {
    const listener = vi.fn()
    onWorkspaceListChanged(listener)
    setWorkspaceStreamHealth('demo', 's1', true)
    expect(readWorkspaceStatus('demo', 's1')).toBe('waiting')
    expect(isWorkspaceStreamHealthy('demo', 's1')).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when marking an absent session unhealthy', () => {
    const listener = vi.fn()
    onWorkspaceListChanged(listener)
    setWorkspaceStreamHealth('demo', 's1', false)
    expect(isWorkspaceStreamHealthy('demo', 's1')).toBe(false)
    expect(listener).not.toHaveBeenCalled()
  })

  it('keeps the sticky status across a health drop', () => {
    setAgentStatus('demo', 's1', '%0', 'running')
    setWorkspaceStreamHealth('demo', 's1', false)
    expect(readWorkspaceStatus('demo', 's1')).toBe('running')
    expect(isWorkspaceStreamHealthy('demo', 's1')).toBe(false)
  })

  it('fires only when the health bit actually flips', () => {
    setAgentStatus('demo', 's1', '%0', 'running')
    const listener = vi.fn()
    onWorkspaceListChanged(listener)
    setWorkspaceStreamHealth('demo', 's1', true)
    expect(listener).not.toHaveBeenCalled()
    setWorkspaceStreamHealth('demo', 's1', false)
    expect(listener).toHaveBeenCalledTimes(1)
    setWorkspaceStreamHealth('demo', 's1', false)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('readWorkspaceWaitingSince (waiting spells)', () => {
  it('returns undefined for an absent entry (booting — no spell yet)', () => {
    expect(readWorkspaceWaitingSince('demo', 's1')).toBeUndefined()
  })

  it('stamps a spell on entering waiting and keeps it while waiting persists', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      setAgentStatus('demo', 's1', '%0', 'waiting')
      expect(readWorkspaceWaitingSince('demo', 's1')).toBe(1_000)
      vi.setSystemTime(5_000)
      setAgentStatus('demo', 's1', '%0', 'waiting')
      expect(readWorkspaceWaitingSince('demo', 's1')).toBe(1_000)
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
      expect(readWorkspaceWaitingSince('demo', 's1')).toBeUndefined()
      vi.setSystemTime(2_000)
      setAgentStatus('demo', 's1', '%0', 'waiting')
      expect(readWorkspaceWaitingSince('demo', 's1')).toBe(2_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stamps the waiting entry created by a healthy-attach on an absent session', () => {
    setWorkspaceStreamHealth('demo', 's1', true)
    expect(readWorkspaceWaitingSince('demo', 's1')).toBeGreaterThan(0)
  })

  it('keeps the spell across a stream-health drop (sticky, like status)', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      setAgentStatus('demo', 's1', '%0', 'waiting')
      vi.setSystemTime(9_000)
      setWorkspaceStreamHealth('demo', 's1', false)
      setWorkspaceStreamHealth('demo', 's1', true)
      expect(readWorkspaceWaitingSince('demo', 's1')).toBe(1_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('is gone after eviction', () => {
    setAgentStatus('demo', 's1', '%0', 'waiting')
    evictWorkspaceStatus('demo', 's1')
    expect(readWorkspaceWaitingSince('demo', 's1')).toBeUndefined()
  })
})

describe('evictWorkspaceStatus', () => {
  it('removes the entry and fires the listener', () => {
    setAgentStatus('demo', 's1', '%0', 'running')
    const listener = vi.fn()
    onWorkspaceListChanged(listener)
    evictWorkspaceStatus('demo', 's1')
    expect(readWorkspaceStatus('demo', 's1')).toBe('waiting')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('does not fire for an absent entry', () => {
    const listener = vi.fn()
    onWorkspaceListChanged(listener)
    evictWorkspaceStatus('demo', 's1')
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('onStreamHealthLost', () => {
  // Triggers the stale reaper: while the stream is healthy tmux is assumed
  // alive, so losing it is when probes must run again.
  it('fires when a healthy stream goes unhealthy', () => {
    setAgentStatus('demo', 's1', '%0', 'running')
    const listener = vi.fn()
    onStreamHealthLost(listener)
    setWorkspaceStreamHealth('demo', 's1', false)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  // Only the transition fires, since each firing triggers a reconcile pass.
  it('does not fire on attach, on a status flip, or on a repeat drop', () => {
    const listener = vi.fn()
    onStreamHealthLost(listener)
    setWorkspaceStreamHealth('demo', 's1', true)
    setAgentStatus('demo', 's1', '%0', 'running')
    setAgentStatus('demo', 's1', '%0', 'waiting')
    expect(listener).not.toHaveBeenCalled()
    setWorkspaceStreamHealth('demo', 's1', false)
    expect(listener).toHaveBeenCalledTimes(1)
    setWorkspaceStreamHealth('demo', 's1', false)
    expect(listener).toHaveBeenCalledTimes(1)
    // Reattaching does not fire; the next drop does.
    setWorkspaceStreamHealth('demo', 's1', true)
    expect(listener).toHaveBeenCalledTimes(1)
    setWorkspaceStreamHealth('demo', 's1', false)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('replaces the previous listener (last registration wins)', () => {
    const first = vi.fn()
    const second = vi.fn()
    onStreamHealthLost(first)
    onStreamHealthLost(second)
    setAgentStatus('demo', 's1', '%0', 'running')
    setWorkspaceStreamHealth('demo', 's1', false)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})

describe('onLiveAgentsChanged', () => {
  // Marks the reconciler dirty, so an `acp` conversation's id (which no
  // cluster watch sees) is recorded without waiting for the 60s resync.
  it('fires when a conversation appears, goes, or learns its id', () => {
    const listener = vi.fn()
    onLiveAgentsChanged(listener)
    setLiveAgents('demo', 's1', [{ handle: 'claude-1', tool: 'claude' }])
    expect(listener).toHaveBeenCalledTimes(1)
    // Same handle, now with its session id.
    setLiveAgents('demo', 's1', [{ handle: 'claude-1', tool: 'claude', agentSessionId: 'conv-a' }])
    expect(listener).toHaveBeenCalledTimes(2)
    setLiveAgents('demo', 's1', [])
    expect(listener).toHaveBeenCalledTimes(3)
  })

  // Drivers republish the same set on every sweep; that must not fire.
  it('does not fire for a re-publish of the same set, or for a status flip', () => {
    setLiveAgents('demo', 's1', [{ handle: 'claude-1', tool: 'claude', agentSessionId: 'conv-a' }])
    const listener = vi.fn()
    onLiveAgentsChanged(listener)
    // Fresh objects, as drivers publish, so reference equality would fail.
    setLiveAgents('demo', 's1', [{ handle: 'claude-1', tool: 'claude', agentSessionId: 'conv-a' }])
    setAgentStatus('demo', 's1', 'claude-1', 'running')
    setAgentStatus('demo', 's1', 'claude-1', 'waiting')
    expect(listener).not.toHaveBeenCalled()
  })
})
