import { describe, it, expect, afterEach } from 'vitest'
import {
  TERMINATING_TTL_MS,
  _clearTerminatingForTests,
  clearWorkspaceTerminating,
  isWorkspaceTerminating,
  markWorkspaceTerminating,
  pruneTerminating,
} from '#runtime/status/terminating'
import { onWorkspaceListChanged, _resetWorkspaceListChangedForTests } from '#notify'

afterEach(() => {
  _clearTerminatingForTests()
  _resetWorkspaceListChangedForTests()
})

describe('terminating registry', () => {
  afterEach(() => _clearTerminatingForTests())

  it('marks and reports a session as terminating', () => {
    expect(isWorkspaceTerminating('s1')).toBe(false)
    markWorkspaceTerminating('s1')
    expect(isWorkspaceTerminating('s1')).toBe(true)
  })

  it('ignores an empty session id', () => {
    markWorkspaceTerminating('')
    expect(isWorkspaceTerminating('')).toBe(false)
  })

  it('marking is idempotent and preserves the original timestamp for the TTL', () => {
    markWorkspaceTerminating('s1', 1_000)
    markWorkspaceTerminating('s1', 5_000) // ignored — first mark wins
    // Still within TTL of the FIRST mark at t=1_000.
    pruneTerminating(new Set(['s1']), 1_000 + TERMINATING_TTL_MS)
    expect(isWorkspaceTerminating('s1')).toBe(true)
    // Just past the TTL of the first mark → pruned.
    pruneTerminating(new Set(['s1']), 1_000 + TERMINATING_TTL_MS + 1)
    expect(isWorkspaceTerminating('s1')).toBe(false)
  })

  // A mark greys out the row, so it must trigger a snapshot push; otherwise
  // a stop from the CLI or reaper would not show until the pod changed.
  it('pushes a fresh snapshot when a mark lands or is cleared, and not otherwise', () => {
    let pushes = 0
    onWorkspaceListChanged(() => { pushes += 1 })

    markWorkspaceTerminating('s1')
    expect(pushes).toBe(1)
    markWorkspaceTerminating('s1')
    expect(pushes).toBe(1)
    markWorkspaceTerminating('')
    expect(pushes).toBe(1)

    clearWorkspaceTerminating('s1')
    expect(pushes).toBe(2)
    clearWorkspaceTerminating('s1')
    expect(pushes).toBe(2)
  })

  // Pruning happens while building the snapshot, so a push would be redundant.
  it('does not push when pruning', () => {
    markWorkspaceTerminating('s1', 1_000)
    let pushes = 0
    onWorkspaceListChanged(() => { pushes += 1 })
    pruneTerminating(new Set(), 1_000)
    expect(isWorkspaceTerminating('s1')).toBe(false)
    expect(pushes).toBe(0)
  })

  it('clearWorkspaceTerminating drops a mark (id reuse on restart)', () => {
    markWorkspaceTerminating('s1')
    clearWorkspaceTerminating('s1')
    expect(isWorkspaceTerminating('s1')).toBe(false)
  })

  it('pruneTerminating forgets a mark whose pod is gone', () => {
    markWorkspaceTerminating('s1', 1_000)
    markWorkspaceTerminating('s2', 1_000)
    // s1's pod vanished (teardown finished); s2 still present.
    pruneTerminating(new Set(['s2']), 2_000)
    expect(isWorkspaceTerminating('s1')).toBe(false)
    expect(isWorkspaceTerminating('s2')).toBe(true)
  })

  it('pruneTerminating forgets a mark past the TTL even if the pod lingers', () => {
    markWorkspaceTerminating('s1', 1_000)
    // A failed teardown: the pod is still live but the mark has aged out.
    pruneTerminating(new Set(['s1']), 1_000 + TERMINATING_TTL_MS + 1)
    expect(isWorkspaceTerminating('s1')).toBe(false)
  })
})
