import { describe, it, expect, vi, beforeEach } from 'vitest'

import {
  readSessionStatus,
  readSessionWaitingSince,
  isSessionStreamHealthy,
  setPaneStatus,
  setSessionStreamHealth,
  evictSessionStatus,
  onSessionStatusChanged,
  _resetSessionStatusStoreForTests,
} from '#features/status/status-store'

beforeEach(() => {
  _resetSessionStatusStoreForTests()
})

describe('readSessionStatus', () => {
  it('returns waiting for a session with no entry', () => {
    expect(readSessionStatus('demo', 's1')).toBe('waiting')
  })

  it('returns the stored status after a write', () => {
    setPaneStatus('demo', 's1', '%0', 'running')
    expect(readSessionStatus('demo', 's1')).toBe('running')
  })

  it('keys by slug AND session id', () => {
    setPaneStatus('demo', 's1', '%0', 'running')
    expect(readSessionStatus('other', 's1')).toBe('waiting')
    expect(readSessionStatus('demo', 's2')).toBe('waiting')
  })
})

describe('isSessionStreamHealthy', () => {
  it('returns false for a session with no entry', () => {
    expect(isSessionStreamHealthy('demo', 's1')).toBe(false)
  })

  it('returns true after a status write (classification implies a live stream)', () => {
    setPaneStatus('demo', 's1', '%0', 'waiting')
    expect(isSessionStreamHealthy('demo', 's1')).toBe(true)
  })
})

describe('setPaneStatus', () => {
  it('fires the change listener when the status flips', () => {
    const listener = vi.fn()
    onSessionStatusChanged(listener)
    setPaneStatus('demo', 's1', '%0', 'running')
    expect(listener).toHaveBeenCalledTimes(1)
    setPaneStatus('demo', 's1', '%0', 'waiting')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('does not fire when the same status is re-set on a healthy entry', () => {
    setPaneStatus('demo', 's1', '%0', 'running')
    const listener = vi.fn()
    onSessionStatusChanged(listener)
    setPaneStatus('demo', 's1', '%0', 'running')
    expect(listener).not.toHaveBeenCalled()
  })

  it('fires when re-classifying an unhealthy entry (health became visible)', () => {
    setPaneStatus('demo', 's1', '%0', 'running')
    setSessionStreamHealth('demo', 's1', false)
    const listener = vi.fn()
    onSessionStatusChanged(listener)
    setPaneStatus('demo', 's1', '%0', 'running')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(isSessionStreamHealthy('demo', 's1')).toBe(true)
  })
})

describe('setSessionStreamHealth', () => {
  it('creates a waiting entry when marking an absent session healthy', () => {
    const listener = vi.fn()
    onSessionStatusChanged(listener)
    setSessionStreamHealth('demo', 's1', true)
    expect(readSessionStatus('demo', 's1')).toBe('waiting')
    expect(isSessionStreamHealthy('demo', 's1')).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when marking an absent session unhealthy', () => {
    const listener = vi.fn()
    onSessionStatusChanged(listener)
    setSessionStreamHealth('demo', 's1', false)
    expect(isSessionStreamHealthy('demo', 's1')).toBe(false)
    expect(listener).not.toHaveBeenCalled()
  })

  it('keeps the sticky status across a health drop', () => {
    setPaneStatus('demo', 's1', '%0', 'running')
    setSessionStreamHealth('demo', 's1', false)
    expect(readSessionStatus('demo', 's1')).toBe('running')
    expect(isSessionStreamHealthy('demo', 's1')).toBe(false)
  })

  it('fires only when the health bit actually flips', () => {
    setPaneStatus('demo', 's1', '%0', 'running')
    const listener = vi.fn()
    onSessionStatusChanged(listener)
    setSessionStreamHealth('demo', 's1', true)
    expect(listener).not.toHaveBeenCalled()
    setSessionStreamHealth('demo', 's1', false)
    expect(listener).toHaveBeenCalledTimes(1)
    setSessionStreamHealth('demo', 's1', false)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('readSessionWaitingSince (waiting spells)', () => {
  it('returns undefined for an absent entry (booting — no spell yet)', () => {
    expect(readSessionWaitingSince('demo', 's1')).toBeUndefined()
  })

  it('stamps a spell on entering waiting and keeps it while waiting persists', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      setPaneStatus('demo', 's1', '%0', 'waiting')
      expect(readSessionWaitingSince('demo', 's1')).toBe(1_000)
      vi.setSystemTime(5_000)
      setPaneStatus('demo', 's1', '%0', 'waiting')
      expect(readSessionWaitingSince('demo', 's1')).toBe(1_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the spell on running and restamps on the next wait', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      setPaneStatus('demo', 's1', '%0', 'waiting')
      setPaneStatus('demo', 's1', '%0', 'running')
      expect(readSessionWaitingSince('demo', 's1')).toBeUndefined()
      vi.setSystemTime(2_000)
      setPaneStatus('demo', 's1', '%0', 'waiting')
      expect(readSessionWaitingSince('demo', 's1')).toBe(2_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stamps the waiting entry created by a healthy-attach on an absent session', () => {
    setSessionStreamHealth('demo', 's1', true)
    expect(readSessionWaitingSince('demo', 's1')).toBeGreaterThan(0)
  })

  it('keeps the spell across a stream-health drop (sticky, like status)', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      setPaneStatus('demo', 's1', '%0', 'waiting')
      vi.setSystemTime(9_000)
      setSessionStreamHealth('demo', 's1', false)
      setSessionStreamHealth('demo', 's1', true)
      expect(readSessionWaitingSince('demo', 's1')).toBe(1_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('is gone after eviction', () => {
    setPaneStatus('demo', 's1', '%0', 'waiting')
    evictSessionStatus('demo', 's1')
    expect(readSessionWaitingSince('demo', 's1')).toBeUndefined()
  })
})

describe('evictSessionStatus', () => {
  it('removes the entry and fires the listener', () => {
    setPaneStatus('demo', 's1', '%0', 'running')
    const listener = vi.fn()
    onSessionStatusChanged(listener)
    evictSessionStatus('demo', 's1')
    expect(readSessionStatus('demo', 's1')).toBe('waiting')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('does not fire for an absent entry', () => {
    const listener = vi.fn()
    onSessionStatusChanged(listener)
    evictSessionStatus('demo', 's1')
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('onSessionStatusChanged', () => {
  it('replaces the previous listener (last registration wins)', () => {
    const first = vi.fn()
    const second = vi.fn()
    onSessionStatusChanged(first)
    onSessionStatusChanged(second)
    setPaneStatus('demo', 's1', '%0', 'running')
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})
