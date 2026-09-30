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

  // A mark greys the row, so it is a snapshot input and has to announce
  // itself — otherwise a CLI- or reaper-issued stop showed nothing until the
  // pod's deletionTimestamp delta landed, which is the gap the mark exists
  // to cover in the first place.
  it('pushes a fresh snapshot when a mark lands or is cleared, and not otherwise', () => {
    let pushes = 0
    onWorkspaceListChanged(() => { pushes += 1 })

    markWorkspaceTerminating('s1')
    expect(pushes).toBe(1)
    // Idempotent: a re-mark changes nothing visible.
    markWorkspaceTerminating('s1')
    expect(pushes).toBe(1)
    markWorkspaceTerminating('')
    expect(pushes).toBe(1)

    clearWorkspaceTerminating('s1')
    expect(pushes).toBe(2)
    // Nothing left to clear.
    clearWorkspaceTerminating('s1')
    expect(pushes).toBe(2)
  })

  // Pruning runs inside the display-list build, so the build that prunes a
  // mark already renders the un-greyed row; notifying would only re-enter it.
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
