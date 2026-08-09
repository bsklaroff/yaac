import { describe, it, expect, afterEach } from 'vitest'
import {
  TERMINATING_TTL_MS,
  _clearTerminatingForTests,
  clearWorktreeTerminating,
  isWorktreeTerminating,
  markWorktreeTerminating,
  pruneTerminating,
} from '#features/status/terminating'

afterEach(() => {
  _clearTerminatingForTests()
})

describe('terminating registry', () => {
  afterEach(() => _clearTerminatingForTests())

  it('marks and reports a session as terminating', () => {
    expect(isWorktreeTerminating('s1')).toBe(false)
    markWorktreeTerminating('s1')
    expect(isWorktreeTerminating('s1')).toBe(true)
  })

  it('ignores an empty session id', () => {
    markWorktreeTerminating('')
    expect(isWorktreeTerminating('')).toBe(false)
  })

  it('marking is idempotent and preserves the original timestamp for the TTL', () => {
    markWorktreeTerminating('s1', 1_000)
    markWorktreeTerminating('s1', 5_000) // ignored — first mark wins
    // Still within TTL of the FIRST mark at t=1_000.
    pruneTerminating(new Set(['s1']), 1_000 + TERMINATING_TTL_MS)
    expect(isWorktreeTerminating('s1')).toBe(true)
    // Just past the TTL of the first mark → pruned.
    pruneTerminating(new Set(['s1']), 1_000 + TERMINATING_TTL_MS + 1)
    expect(isWorktreeTerminating('s1')).toBe(false)
  })

  it('clearWorktreeTerminating drops a mark (id reuse on restart)', () => {
    markWorktreeTerminating('s1')
    clearWorktreeTerminating('s1')
    expect(isWorktreeTerminating('s1')).toBe(false)
  })

  it('pruneTerminating forgets a mark whose pod is gone', () => {
    markWorktreeTerminating('s1', 1_000)
    markWorktreeTerminating('s2', 1_000)
    // s1's pod vanished (teardown finished); s2 still present.
    pruneTerminating(new Set(['s2']), 2_000)
    expect(isWorktreeTerminating('s1')).toBe(false)
    expect(isWorktreeTerminating('s2')).toBe(true)
  })

  it('pruneTerminating forgets a mark past the TTL even if the pod lingers', () => {
    markWorktreeTerminating('s1', 1_000)
    // A failed teardown: the pod is still live but the mark has aged out.
    pruneTerminating(new Set(['s1']), 1_000 + TERMINATING_TTL_MS + 1)
    expect(isWorktreeTerminating('s1')).toBe(false)
  })
})
