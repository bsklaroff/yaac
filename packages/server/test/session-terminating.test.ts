import { describe, it, expect, afterEach } from 'vitest'
import {
  TERMINATING_TTL_MS,
  markSessionTerminating,
  isSessionTerminating,
  clearSessionTerminating,
  pruneTerminating,
  _clearTerminatingForTests,
} from '#lib/session/terminating'

describe('terminating registry', () => {
  afterEach(() => _clearTerminatingForTests())

  it('marks and reports a session as terminating', () => {
    expect(isSessionTerminating('s1')).toBe(false)
    markSessionTerminating('s1')
    expect(isSessionTerminating('s1')).toBe(true)
  })

  it('ignores an empty session id', () => {
    markSessionTerminating('')
    expect(isSessionTerminating('')).toBe(false)
  })

  it('marking is idempotent and preserves the original timestamp for the TTL', () => {
    markSessionTerminating('s1', 1_000)
    markSessionTerminating('s1', 5_000) // ignored — first mark wins
    // Still within TTL of the FIRST mark at t=1_000.
    pruneTerminating(new Set(['s1']), 1_000 + TERMINATING_TTL_MS)
    expect(isSessionTerminating('s1')).toBe(true)
    // Just past the TTL of the first mark → pruned.
    pruneTerminating(new Set(['s1']), 1_000 + TERMINATING_TTL_MS + 1)
    expect(isSessionTerminating('s1')).toBe(false)
  })

  it('clearSessionTerminating drops a mark (id reuse on restart)', () => {
    markSessionTerminating('s1')
    clearSessionTerminating('s1')
    expect(isSessionTerminating('s1')).toBe(false)
  })

  it('pruneTerminating forgets a mark whose pod is gone', () => {
    markSessionTerminating('s1', 1_000)
    markSessionTerminating('s2', 1_000)
    // s1's pod vanished (teardown finished); s2 still present.
    pruneTerminating(new Set(['s2']), 2_000)
    expect(isSessionTerminating('s1')).toBe(false)
    expect(isSessionTerminating('s2')).toBe(true)
  })

  it('pruneTerminating forgets a mark past the TTL even if the pod lingers', () => {
    markSessionTerminating('s1', 1_000)
    // A failed teardown: the pod is still live but the mark has aged out.
    pruneTerminating(new Set(['s1']), 1_000 + TERMINATING_TTL_MS + 1)
    expect(isSessionTerminating('s1')).toBe(false)
  })
})
