/**
 * The forward registry: which host ports a workspace's ports are offered at,
 * and the allocator that picks them. Nothing binds a socket; only the
 * status-bar exec is stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('#drivers/k8s/substrate/stream-relay', () => ({
  podExec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))

import { podExec } from '#drivers/k8s/substrate/stream-relay'
import {
  MAX_FORWARDS_PER_SESSION,
  addWorkspaceForwarder,
  declareWorkspaceForwards,
  getWorkspacePorts,
  stopAllWorkspaceForwarders,
  stopWorkspaceForwarders,
} from '#drivers/k8s/forwarders/port-forwarders'
import { onWorkspaceListChanged, _resetWorkspaceListChangedForTests } from '#notify'

const mockExec = vi.mocked(podExec)

// The registry is module state, so clear it between cases.
afterEach(() => {
  stopAllWorkspaceForwarders()
  _resetWorkspaceListChangedForTests()
})

describe('declareWorkspaceForwards', () => {
  it('answers the configured host port and holds it for the workspace', () => {
    const declared = declareWorkspaceForwards('sess-1', [
      { containerPort: 3000, hostPortStart: 3000 },
      { containerPort: 5432, hostPortStart: 15432 },
    ])

    expect(declared).toEqual([
      { containerPort: 3000, hostPort: 3000 },
      { containerPort: 5432, hostPort: 15432 },
    ])
    // What the workspace listing reports and a client forwarder binds.
    expect(getWorkspacePorts('sess-1')).toEqual(declared)
  })

  it('walks past a host port another workspace was already promised', () => {
    // Nothing binds, so the registry must keep two workspaces from both
    // being given host port 3000.
    declareWorkspaceForwards('sess-1', [{ containerPort: 3000, hostPortStart: 3000 }])
    declareWorkspaceForwards('sess-2', [{ containerPort: 3000, hostPortStart: 3000 }])
    declareWorkspaceForwards('sess-3', [{ containerPort: 3000, hostPortStart: 3000 }])

    expect(getWorkspacePorts('sess-1')).toEqual([{ containerPort: 3000, hostPort: 3000 }])
    expect(getWorkspacePorts('sess-2')).toEqual([{ containerPort: 3000, hostPort: 3001 }])
    expect(getWorkspacePorts('sess-3')).toEqual([{ containerPort: 3000, hostPort: 3002 }])
  })

  it('does not hand one config\'s own two entries the same host port', () => {
    const declared = declareWorkspaceForwards('sess-1', [
      { containerPort: 3000, hostPortStart: 4000 },
      { containerPort: 3001, hostPortStart: 4000 },
    ])
    expect(declared.map((m) => m.hostPort)).toEqual([4000, 4001])
  })

  it('registers nothing for a workspace that declares no forwards', () => {
    expect(declareWorkspaceForwards('sess-1', [])).toEqual([])
    expect(getWorkspacePorts('sess-1')).toEqual([])
  })

  it('merges with what the workspace already holds rather than replacing it', () => {
    // A forward-port during create can add an entry before the create's
    // batch lands; both must be kept.
    declareWorkspaceForwards('sess-1', [{ containerPort: 3000, hostPortStart: 19000 }])
    declareWorkspaceForwards('sess-1', [{ containerPort: 8080, hostPortStart: 19999 }])

    expect(getWorkspacePorts('sess-1')).toEqual([
      { containerPort: 3000, hostPort: 19000 },
      { containerPort: 8080, hostPort: 19999 },
    ])
  })

  // The snapshot's `forwardedPorts` reads this registry, so changes are
  // announced here rather than by the route that caused them.
  it('pushes a fresh snapshot when the offered set changes', () => {
    let pushes = 0
    onWorkspaceListChanged(() => { pushes += 1 })

    declareWorkspaceForwards('sess-1', [{ containerPort: 3000, hostPortStart: 19000 }])
    expect(pushes).toBe(1)
    declareWorkspaceForwards('sess-1', [{ containerPort: 8080, hostPortStart: 19001 }])
    expect(pushes).toBe(2)
    stopWorkspaceForwarders('sess-1')
    expect(pushes).toBe(3)
    // Nothing left to drop, so no push.
    stopWorkspaceForwarders('sess-1')
    expect(pushes).toBe(3)
  })
})

describe('getWorkspacePorts', () => {
  it('returns [] for a workspace nothing was declared for', () => {
    expect(getWorkspacePorts('sess-unknown')).toEqual([])
  })
})

describe('stopWorkspaceForwarders', () => {
  it('drops the workspace\'s offers, freeing the host ports for the next one', () => {
    declareWorkspaceForwards('sess-1', [{ containerPort: 3000, hostPortStart: 3000 }])
    stopWorkspaceForwarders('sess-1')

    expect(getWorkspacePorts('sess-1')).toEqual([])
    // The port is free again after a failed launch.
    expect(declareWorkspaceForwards('sess-2', [{ containerPort: 3000, hostPortStart: 3000 }]))
      .toEqual([{ containerPort: 3000, hostPort: 3000 }])
  })
})

describe('stopAllWorkspaceForwarders', () => {
  it('is a no-op when nothing is declared', () => {
    expect(() => stopAllWorkspaceForwarders()).not.toThrow()
  })

  it('clears every workspace\'s offers', () => {
    declareWorkspaceForwards('sess-1', [{ containerPort: 3000, hostPortStart: 3000 }])
    declareWorkspaceForwards('sess-2', [{ containerPort: 3000, hostPortStart: 3000 }])

    stopAllWorkspaceForwarders()

    expect(getWorkspacePorts('sess-1')).toEqual([])
    expect(getWorkspacePorts('sess-2')).toEqual([])
  })
})

describe('addWorkspaceForwarder', () => {
  beforeEach(() => {
    mockExec.mockClear()
    mockExec.mockResolvedValue({ stdout: '', stderr: '' })
  })

  it('offers the container port itself, creating the entry, and restates the bar', async () => {
    const mapping = await addWorkspaceForwarder('sess-1', 'yaac-proj-sess-1', 8090)

    expect(mapping).toEqual({ containerPort: 8090, hostPort: 8090 })
    expect(getWorkspacePorts('sess-1')).toEqual([{ containerPort: 8090, hostPort: 8090 }])
    expect(mockExec.mock.calls[0]?.[1] ?? '').toContain(':8090->8090')
  })

  it('appends to an existing entry, and both go down together', async () => {
    declareWorkspaceForwards('sess-1', [{ containerPort: 3000, hostPortStart: 3000 }])

    await addWorkspaceForwarder('sess-1', 'yaac-proj-sess-1', 8091)

    expect(getWorkspacePorts('sess-1')).toEqual([
      { containerPort: 3000, hostPort: 3000 },
      { containerPort: 8091, hostPort: 8091 },
    ])
    stopWorkspaceForwarders('sess-1')
    expect(getWorkspacePorts('sess-1')).toEqual([])
  })

  it('walks past a host port another workspace holds', async () => {
    declareWorkspaceForwards('sess-1', [{ containerPort: 8090, hostPortStart: 8090 }])

    const mapping = await addWorkspaceForwarder('sess-2', 'yaac-proj-sess-2', 8090)

    expect(mapping).toEqual({ containerPort: 8090, hostPort: 8091 })
  })

  it('is idempotent per container port', async () => {
    const first = await addWorkspaceForwarder('sess-1', 'yaac-proj-sess-1', 8090)
    const again = await addWorkspaceForwarder('sess-1', 'yaac-proj-sess-1', 8090)

    expect(again).toEqual(first)
    expect(getWorkspacePorts('sess-1')).toHaveLength(1)
  })

  it('concurrent requests for the same port converge on one offer', async () => {
    // Allocating and recording is one synchronous step, so concurrent
    // declares cannot race.
    const [a, b] = await Promise.all([
      addWorkspaceForwarder('sess-1', 'yaac-proj-sess-1', 8090),
      addWorkspaceForwarder('sess-1', 'yaac-proj-sess-1', 8090),
    ])

    expect(a).toEqual(b)
    expect(getWorkspacePorts('sess-1')).toEqual([{ containerPort: 8090, hostPort: 8090 }])
  })

  it('rejects once the per-session forward cap is reached', async () => {
    declareWorkspaceForwards(
      'sess-1',
      Array.from({ length: MAX_FORWARDS_PER_SESSION }, (_, i) => ({
        containerPort: 9000 + i, hostPortStart: 9000 + i,
      })),
    )

    await expect(
      addWorkspaceForwarder('sess-1', 'yaac-proj-sess-1', 8093),
    ).rejects.toThrow(/already holds/)
  })

  it('keeps the offer when the cosmetic status-bar refresh fails', async () => {
    mockExec.mockRejectedValue(new Error('pod is gone'))

    const mapping = await addWorkspaceForwarder('sess-1', 'yaac-proj-sess-1', 8090)

    expect(getWorkspacePorts('sess-1')).toEqual([mapping])
  })
})
