import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('#drivers/k8s/substrate/pods', async (importOriginal) => ({
  ...(await importOriginal<typeof podsModule>()),
  listWorktreePods: vi.fn(),
}))

vi.mock('#drivers/k8s/forwarders/port-forwarders', () => ({
  addWorktreeForwarder: vi.fn(),
}))

vi.mock('#drivers/k8s/forwarders/port-detector', () => ({
  getUnforwardedPorts: vi.fn().mockReturnValue([]),
}))

vi.mock('#log', () => ({ serverLog: vi.fn() }))

// The relay is the process boundary: a `tcp` stream through the pod's
// streamd. What matters here is that a dial asks for exactly that.
vi.mock('#drivers/k8s/substrate/stream-relay', () => ({
  relayDial: vi.fn(),
}))

import type * as podsModule from '#drivers/k8s/substrate/pods'
import { listWorktreePods, type PodInfo } from '#drivers/k8s/substrate/pods'
import { addWorktreeForwarder } from '#drivers/k8s/forwarders/port-forwarders'
import { getUnforwardedPorts } from '#drivers/k8s/forwarders/port-detector'
import { relayDial } from '#drivers/k8s/substrate/stream-relay'
import { dialWorkspacePort, forwardWorktreePort } from '#drivers/k8s/forwarders/forward-port'

const mockList = vi.mocked(listWorktreePods)
const mockAdd = vi.mocked(addWorktreeForwarder)
const mockDetected = vi.mocked(getUnforwardedPorts)
const mockRelayDial = vi.mocked(relayDial)

const target = { workspaceId: 'sess-1', projectSlug: 'proj', jobName: 'yaac-proj-sess-1' }

function pod(worktreeId: string, over: Partial<PodInfo> = {}): PodInfo {
  return {
    jobName: `yaac-proj-${worktreeId}`,
    podName: `yaac-proj-${worktreeId}-abc`,
    worktreeId,
    projectSlug: 'proj',
    tool: 'claude',
    phase: 'Running',
    running: true,
    terminating: false,
    createdAtMs: 0,
    labels: {},
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDetected.mockReturnValue([8090])
  mockAdd.mockResolvedValue({ containerPort: 8090, hostPort: 8090 })
  mockList.mockResolvedValue([])
})

describe('forwardWorktreePort', () => {
  it('rejects a port that is not in the surfaced unforwarded set', async () => {
    mockDetected.mockReturnValue([3000])
    await expect(forwardWorktreePort(target, 8090, { fanOutToProject: false }))
      .rejects.toThrow(/not an unforwarded listener/)
    expect(mockAdd).not.toHaveBeenCalled()
  })

  it('forwards only the target session when no fan-out is asked for', async () => {
    const mapping = await forwardWorktreePort(target, 8090, { fanOutToProject: false })
    expect(mapping).toEqual({ containerPort: 8090, hostPort: 8090 })
    expect(mockAdd).toHaveBeenCalledExactlyOnceWith('proj', 'sess-1', 'yaac-proj-sess-1', 8090)
    expect(mockList).not.toHaveBeenCalled()
  })

  it('fans out to running, non-prewarmed siblings', async () => {
    mockList.mockResolvedValue([
      pod('sess-1'),
      pod('sess-2'),
      pod('sess-3', { running: false }),
      pod('sess-4', { labels: { 'yaac.prewarmed': 'true' } }),
    ])

    await forwardWorktreePort(target, 8090, { fanOutToProject: true })

    expect(mockList).toHaveBeenCalledWith('proj')
    // Target plus the one running, non-prewarmed sibling.
    expect(mockAdd.mock.calls.map((c) => c[1]).sort()).toEqual(['sess-1', 'sess-2'])
  })

  it('tolerates a sibling forward failure', async () => {
    mockList.mockResolvedValue([pod('sess-1'), pod('sess-2')])
    mockAdd.mockImplementation((_slug, worktreeId) => {
      if (worktreeId === 'sess-2') return Promise.reject(new Error('sibling down'))
      return Promise.resolve({ containerPort: 8090, hostPort: 8090 })
    })
    const mapping = await forwardWorktreePort(target, 8090, { fanOutToProject: true })
    expect(mapping).toEqual({ containerPort: 8090, hostPort: 8090 })
  })

  it('surfaces a failure on the directly-targeted session', async () => {
    mockAdd.mockRejectedValue(new Error('no ports available'))
    await expect(forwardWorktreePort(target, 8090, { fanOutToProject: false }))
      .rejects.toThrow('no ports available')
  })
})

describe('dialWorkspacePort', () => {
  it('opens a tcp stream on the named port, and hands the caller the stream itself', async () => {
    // One dial per forwarded TCP connection — the kubectl shape — so there
    // is nothing to register and nothing to hand back but the stream: the
    // caller destroying it is what ends the pair.
    const stream = { destroy: vi.fn() }
    mockRelayDial.mockResolvedValue(stream as never)

    await expect(dialWorkspacePort('sess-1', 5173)).resolves.toBe(stream)
    expect(mockRelayDial).toHaveBeenCalledWith('sess-1', { kind: 'tcp', port: 5173 })
  })

  it('names a port nothing surfaced as an unforwarded listener', async () => {
    // Deliberately unlike `forwardWorktreePort`: by the time a client
    // dials, the decision that this port is forwarded has been made and
    // recorded, and re-deciding it would break a live forward the moment
    // its dev server restarted.
    mockDetected.mockReturnValue([])
    mockRelayDial.mockResolvedValue({ destroy: vi.fn() } as never)

    await expect(dialWorkspacePort('sess-1', 3000)).resolves.toBeDefined()
  })
})
