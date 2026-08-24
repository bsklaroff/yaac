/**
 * The declaration registry: which ports a worktree is offered at, and the
 * allocator that decides the host half.
 *
 * Nothing binds, so nothing has to be mocked to keep it from binding — the
 * only process boundary in reach is the status-bar exec, and that is
 * stubbed. What a caller can read back out of the registry is the honest
 * assertion throughout.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('#drivers/k8s/substrate/stream-relay', () => ({
  podExec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))

import { podExec } from '#drivers/k8s/substrate/stream-relay'
import {
  MAX_FORWARDS_PER_SESSION,
  addWorktreeForwarder,
  declareWorktreeForwards,
  getWorktreePorts,
  hasWorktreeForwarders,
  stopAllWorktreeForwarders,
  stopWorktreeForwarders,
} from '#drivers/k8s/forwarders/port-forwarders'
import { onWorktreeListChanged, _resetWorktreeListChangedForTests } from '#notify'

const mockExec = vi.mocked(podExec)

// The registry is process-local and outlives a case, so a host port one
// test promised would be walked past by the next.
afterEach(() => {
  stopAllWorktreeForwarders()
  _resetWorktreeListChangedForTests()
})

describe('declareWorktreeForwards', () => {
  it('answers the configured host port and holds it for the worktree', () => {
    const declared = declareWorktreeForwards('sess-1', [
      { containerPort: 3000, hostPortStart: 3000 },
      { containerPort: 5432, hostPortStart: 15432 },
    ])

    expect(declared).toEqual([
      { containerPort: 3000, hostPort: 3000 },
      { containerPort: 5432, hostPort: 15432 },
    ])
    // Read back out of the registry: this is what the worktree listing
    // reports, and what a client forwarder binds.
    expect(getWorktreePorts('sess-1')).toEqual(declared)
  })

  it('walks past a host port another worktree was already promised', () => {
    // Binding used to disambiguate two workspaces of one project both
    // asking for 3000 — whoever bound first won. With nothing bound, the
    // ledger has to do it, or both are told 3000 and only one can ever be
    // reached.
    declareWorktreeForwards('sess-1', [{ containerPort: 3000, hostPortStart: 3000 }])
    declareWorktreeForwards('sess-2', [{ containerPort: 3000, hostPortStart: 3000 }])
    declareWorktreeForwards('sess-3', [{ containerPort: 3000, hostPortStart: 3000 }])

    expect(getWorktreePorts('sess-1')).toEqual([{ containerPort: 3000, hostPort: 3000 }])
    expect(getWorktreePorts('sess-2')).toEqual([{ containerPort: 3000, hostPort: 3001 }])
    expect(getWorktreePorts('sess-3')).toEqual([{ containerPort: 3000, hostPort: 3002 }])
  })

  it('does not hand one config\'s own two entries the same host port', () => {
    const declared = declareWorktreeForwards('sess-1', [
      { containerPort: 3000, hostPortStart: 4000 },
      { containerPort: 3001, hostPortStart: 4000 },
    ])
    expect(declared.map((m) => m.hostPort)).toEqual([4000, 4001])
  })

  it('registers nothing for a worktree that declares no forwards', () => {
    // An empty entry would still read to the listing as "this worktree
    // holds forwards", which is what the restore pass gates on.
    expect(declareWorktreeForwards('sess-1', [])).toEqual([])
    expect(hasWorktreeForwarders('sess-1')).toBe(false)
  })

  it('merges with what the worktree already holds rather than replacing it', () => {
    // The create batch can land after a reactive addWorktreeForwarder made
    // the entry (a forward-port during the create window); dropping either
    // side would lose a live offer.
    declareWorktreeForwards('sess-1', [{ containerPort: 3000, hostPortStart: 19000 }])
    declareWorktreeForwards('sess-1', [{ containerPort: 8080, hostPortStart: 19999 }])

    expect(getWorktreePorts('sess-1')).toEqual([
      { containerPort: 3000, hostPort: 19000 },
      { containerPort: 8080, hostPort: 19999 },
    ])
  })

  // This registry is what the snapshot's `forwardedPorts` reads, so both
  // ends of a forward's life announce themselves here rather than at the
  // route that happened to ask for it.
  it('pushes a fresh snapshot when the offered set changes', () => {
    let pushes = 0
    onWorktreeListChanged(() => { pushes += 1 })

    declareWorktreeForwards('sess-1', [{ containerPort: 3000, hostPortStart: 19000 }])
    expect(pushes).toBe(1)
    declareWorktreeForwards('sess-1', [{ containerPort: 8080, hostPortStart: 19001 }])
    expect(pushes).toBe(2)
    stopWorktreeForwarders('sess-1')
    expect(pushes).toBe(3)
    // Nothing left to drop: no entry, no change, no push.
    stopWorktreeForwarders('sess-1')
    expect(pushes).toBe(3)
  })
})

describe('getWorktreePorts', () => {
  it('returns [] for a worktree nothing was declared for', () => {
    expect(getWorktreePorts('sess-unknown')).toEqual([])
  })
})

describe('stopWorktreeForwarders', () => {
  it('drops the worktree\'s offers, freeing the host ports for the next one', () => {
    declareWorktreeForwards('sess-1', [{ containerPort: 3000, hostPortStart: 3000 }])
    stopWorktreeForwarders('sess-1')

    expect(getWorktreePorts('sess-1')).toEqual([])
    expect(hasWorktreeForwarders('sess-1')).toBe(false)
    // The number is free again — a create whose launch failed must not cost
    // the next one its port.
    expect(declareWorktreeForwards('sess-2', [{ containerPort: 3000, hostPortStart: 3000 }]))
      .toEqual([{ containerPort: 3000, hostPort: 3000 }])
  })
})

describe('stopAllWorktreeForwarders', () => {
  it('is a no-op when nothing is declared', () => {
    expect(() => stopAllWorktreeForwarders()).not.toThrow()
  })

  it('clears every worktree\'s offers', () => {
    declareWorktreeForwards('sess-1', [{ containerPort: 3000, hostPortStart: 3000 }])
    declareWorktreeForwards('sess-2', [{ containerPort: 3000, hostPortStart: 3000 }])

    stopAllWorktreeForwarders()

    expect(hasWorktreeForwarders('sess-1')).toBe(false)
    expect(hasWorktreeForwarders('sess-2')).toBe(false)
  })
})

describe('addWorktreeForwarder', () => {
  beforeEach(() => {
    mockExec.mockClear()
    mockExec.mockResolvedValue({ stdout: '', stderr: '' })
  })

  it('offers the container port itself, creating the entry, and restates the bar', async () => {
    const mapping = await addWorktreeForwarder('proj', 'sess-1', 'yaac-proj-sess-1', 8090)

    expect(mapping).toEqual({ containerPort: 8090, hostPort: 8090 })
    expect(getWorktreePorts('sess-1')).toEqual([{ containerPort: 8090, hostPort: 8090 }])
    expect(mockExec.mock.calls[0]?.[1] ?? '').toContain(':8090->8090')
  })

  it('appends to an existing entry, and both go down together', async () => {
    declareWorktreeForwards('sess-1', [{ containerPort: 3000, hostPortStart: 3000 }])

    await addWorktreeForwarder('proj', 'sess-1', 'yaac-proj-sess-1', 8091)

    expect(getWorktreePorts('sess-1')).toEqual([
      { containerPort: 3000, hostPort: 3000 },
      { containerPort: 8091, hostPort: 8091 },
    ])
    stopWorktreeForwarders('sess-1')
    expect(getWorktreePorts('sess-1')).toEqual([])
  })

  it('walks past a host port another worktree holds', async () => {
    declareWorktreeForwards('sess-1', [{ containerPort: 8090, hostPortStart: 8090 }])

    const mapping = await addWorktreeForwarder('proj', 'sess-2', 'yaac-proj-sess-2', 8090)

    expect(mapping).toEqual({ containerPort: 8090, hostPort: 8091 })
  })

  it('is idempotent per container port', async () => {
    const first = await addWorktreeForwarder('proj', 'sess-1', 'yaac-proj-sess-1', 8090)
    const again = await addWorktreeForwarder('proj', 'sess-1', 'yaac-proj-sess-1', 8090)

    expect(again).toEqual(first)
    expect(getWorktreePorts('sess-1')).toHaveLength(1)
  })

  it('concurrent requests for the same port converge on one offer', async () => {
    // Allocation and record are one synchronous step, so the race the
    // bound-socket version had to unwind afterwards cannot start.
    const [a, b] = await Promise.all([
      addWorktreeForwarder('proj', 'sess-1', 'yaac-proj-sess-1', 8090),
      addWorktreeForwarder('proj', 'sess-1', 'yaac-proj-sess-1', 8090),
    ])

    expect(a).toEqual(b)
    expect(getWorktreePorts('sess-1')).toEqual([{ containerPort: 8090, hostPort: 8090 }])
  })

  it('rejects once the per-session forward cap is reached', async () => {
    declareWorktreeForwards(
      'sess-1',
      Array.from({ length: MAX_FORWARDS_PER_SESSION }, (_, i) => ({
        containerPort: 9000 + i, hostPortStart: 9000 + i,
      })),
    )

    await expect(
      addWorktreeForwarder('proj', 'sess-1', 'yaac-proj-sess-1', 8093),
    ).rejects.toThrow(/already holds/)
  })

  it('keeps the offer when the cosmetic status-bar refresh fails', async () => {
    mockExec.mockRejectedValue(new Error('pod is gone'))

    const mapping = await addWorktreeForwarder('proj', 'sess-1', 'yaac-proj-sess-1', 8090)

    expect(getWorktreePorts('sess-1')).toEqual([mapping])
  })
})
