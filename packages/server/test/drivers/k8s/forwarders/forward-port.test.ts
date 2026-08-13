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

import type * as podsModule from '#drivers/k8s/substrate/pods'
import { listWorktreePods, type PodInfo } from '#drivers/k8s/substrate/pods'
import { addWorktreeForwarder } from '#drivers/k8s/forwarders/port-forwarders'
import { getUnforwardedPorts } from '#drivers/k8s/forwarders/port-detector'
import { forwardWorktreePort } from '#drivers/k8s/forwarders/forward-port'

const mockList = vi.mocked(listWorktreePods)
const mockAdd = vi.mocked(addWorktreeForwarder)
const mockDetected = vi.mocked(getUnforwardedPorts)

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
