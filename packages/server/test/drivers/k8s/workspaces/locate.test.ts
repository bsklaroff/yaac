import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Only the substrate is mocked, so the mapping from pods to workspaces runs
// for real.
vi.mock('#drivers/k8s/substrate/pods', async (importOriginal) => ({
  ...(await importOriginal<typeof podsModule>()),
  listWorkspaceJobs: vi.fn(),
  listWorkspacePods: vi.fn(),
}))

import { LABEL_PREWARMED, listWorkspaceJobs, listWorkspacePods, type PodInfo } from '#drivers/k8s/substrate/pods'
import type * as podsModule from '#drivers/k8s/substrate/pods'
import { setActiveClusterCache, type ClusterCache } from '#drivers/k8s/substrate/cluster-cache'
import {
  countWorkspaces,
  findWorkspace,
  findWorkspaceForTeardown,
  listWorkspaces,
} from '#drivers/k8s/workspaces/locate'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

const mockList = vi.mocked(listWorkspacePods)
const mockJobs = vi.mocked(listWorkspaceJobs)

function pod(over: Partial<PodInfo> = {}): PodInfo {
  return {
    podName: 'yaac-proj-abc123-xyz',
    jobName: 'yaac-proj-abc123',
    workspaceId: 'abc123def456',
    projectId: 'proj',
    tool: 'claude',
    phase: 'Running',
    running: true,
    terminating: false,
    createdAtMs: 1_700_000_000_000,
    labels: {},
    ...over,
  }
}

/** A cluster cache whose workspace-pods informer is connected and seeded. */
function healthyCache(pods: PodInfo[]): ClusterCache {
  return {
    healthy: (source: string) => source === 'workspace-pods',
    workspacePods: () => pods,
  } as unknown as ClusterCache
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  mockList.mockReset().mockResolvedValue([])
  setActiveClusterCache(null)
  mockJobs.mockReset().mockResolvedValue([])
})

afterEach(async () => {
  await cleanupTempDir(tmpDir)
})

describe('findWorkspace', () => {
  it('describes a match in the server’s vocabulary, not the substrate’s', async () => {
    mockList.mockResolvedValue([pod({ tool: 'Claude', labels: { 'yaac.nested': 'true' } })])
    expect(await findWorkspace('abc123def456')).toEqual({
      workspaceId: 'abc123def456',
      projectId: 'proj',
      jobName: 'yaac-proj-abc123',
      // 'Claude' is not a known tool name, so it runs as claude but sets no
      // `declaredTool` for spawned workspaces to inherit.
      tool: 'claude',
      mode: 'tui',
      running: true,
      state: 'running',
      labels: { 'yaac.nested': 'true' },
      createdAtMs: 1_700_000_000_000,
      prewarmed: false,
      terminating: false,
      deathCause: { reason: 'pod-stopped' },
    })
  })

  it('answers undefined for no match', async () => {
    expect(await findWorkspace('nope')).toBeUndefined()
  })

  // Prefix matching happens in domain; unclaimed spares are not workspaces.
  it('matches the exact workspace id only, and never a spare', async () => {
    mockList.mockResolvedValue([pod()])
    for (const input of ['abc123', '', 'yaac-proj-abc123', 'yaac-proj-abc123-xyz']) {
      expect(await findWorkspace(input), input).toBeUndefined()
    }
    mockList.mockResolvedValue([pod({ labels: { [LABEL_PREWARMED]: 'true' } })])
    expect(await findWorkspace('abc123def456')).toBeUndefined()
  })

  it('reports a non-running pod with its lowercased phase', async () => {
    mockList.mockResolvedValue([pod({ phase: 'Pending', running: false })])
    expect(await findWorkspace('abc123def456')).toMatchObject({
      running: false, state: 'pending',
    })
  })

  // Polled endpoints resolve without a live listing.
  it('answers from the informer cache without listing, when asked to', async () => {
    setActiveClusterCache(healthyCache([pod()]))
    const found = await findWorkspace('abc123def456', { preferCache: true })
    expect(found?.jobName).toBe('yaac-proj-abc123')
    expect(mockList).not.toHaveBeenCalled()
  })

  // A just-created pod may not be cached yet, and the terminal attach
  // right after create must still find it.
  it('falls back to a live listing when the cache does not have it yet', async () => {
    setActiveClusterCache(healthyCache([]))
    mockList.mockResolvedValue([pod()])
    const found = await findWorkspace('abc123def456', { preferCache: true })
    expect(found?.jobName).toBe('yaac-proj-abc123')
    expect(mockList).toHaveBeenCalledTimes(1)
  })

  it('ignores an unhealthy cache and lists live', async () => {
    setActiveClusterCache({
      healthy: () => false,
      workspacePods: () => { throw new Error('must not read an unhealthy cache') },
    } as unknown as ClusterCache)
    mockList.mockResolvedValue([pod()])
    const found = await findWorkspace('abc123def456', { preferCache: true })
    expect(found?.jobName).toBe('yaac-proj-abc123')
  })

  // Restart and detail views must not read a slightly stale tool label.
  it('does not consult the cache unless asked', async () => {
    setActiveClusterCache(healthyCache([pod()]))
    mockList.mockResolvedValue([pod({ jobName: 'yaac-proj-live' })])
    const found = await findWorkspace('abc123def456')
    expect(found?.jobName).toBe('yaac-proj-live')
  })

  // Distinct from "no match", so callers with a DB row can fall back.
  it('surfaces a listing failure as RUNTIME_UNAVAILABLE', async () => {
    mockList.mockRejectedValue(new Error('connection refused'))
    await expect(findWorkspace('abc123def456')).rejects.toMatchObject({
      code: 'RUNTIME_UNAVAILABLE',
    })
  })
})

describe('findWorkspaceForTeardown', () => {
  // A failed prewarm tears down its own spare; a stop must never reach one,
  // even through its Job.
  it('reaches a spare by its exact id only when asked for spares', async () => {
    mockList.mockResolvedValue([pod({ labels: { [LABEL_PREWARMED]: 'true' } })])
    mockJobs.mockResolvedValue([
      { jobName: 'yaac-proj-abc123', workspaceId: 'abc123def456', projectId: 'proj', createdAtMs: 0 },
    ])
    expect(await findWorkspaceForTeardown('abc123def456', { spares: true })).toEqual({
      projectId: 'proj', workspaceId: 'abc123def456', unitName: 'yaac-proj-abc123',
    })
    expect(await findWorkspaceForTeardown('abc123def456')).toBeUndefined()
    expect(await findWorkspaceForTeardown('abc123', { spares: true })).toBeUndefined()
  })

  // A pod deleted out-of-band leaves its Job, which still needs deleting.
  it('falls through to the Job when the pod is gone, matching it exactly', async () => {
    mockJobs.mockResolvedValue([
      { jobName: 'yaac-proj-orphan', workspaceId: 'orphan-1', projectId: 'proj', createdAtMs: 0 },
    ])
    expect(await findWorkspaceForTeardown('orphan-1')).toEqual({
      projectId: 'proj', workspaceId: 'orphan-1', unitName: 'yaac-proj-orphan',
    })
    expect(await findWorkspaceForTeardown('orphan')).toBeUndefined()
    expect(await findWorkspaceForTeardown('yaac-proj-orphan')).toBeUndefined()
  })

  it('surfaces a failed Job listing as RUNTIME_UNAVAILABLE', async () => {
    mockJobs.mockRejectedValue(new Error('connection refused'))
    await expect(findWorkspaceForTeardown('orphan-1')).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
  })
})

describe('listWorkspaces', () => {
  it('scopes to one project and maps each pod', async () => {
    mockList.mockResolvedValue([pod(), pod({ workspaceId: 'other', jobName: 'yaac-proj-other' })])
    const listed = await listWorkspaces('proj')
    expect(mockList).toHaveBeenCalledWith('proj')
    expect(listed.map((w) => w.workspaceId)).toEqual(['abc123def456', 'other'])
  })

  it('surfaces a listing failure as RUNTIME_UNAVAILABLE', async () => {
    mockList.mockRejectedValue(new Error('connection refused'))
    await expect(listWorkspaces()).rejects.toMatchObject({
      code: 'RUNTIME_UNAVAILABLE',
    })
  })
})

describe('countWorkspaces', () => {
  it('counts per project, ignoring spares and unlabelled pods', async () => {
    mockList.mockResolvedValue([
      pod({ projectId: 'foo' }),
      pod({ projectId: 'foo' }),
      pod({ projectId: 'bar' }),
      pod({ projectId: 'bar', labels: { [LABEL_PREWARMED]: 'true' } }),
      pod({ projectId: '' }),
    ])
    expect(await countWorkspaces()).toEqual({ foo: 2, bar: 1 })
  })

  // A count is display-only, so an unreachable substrate reports zero.
  it('reports nothing when the substrate is unavailable', async () => {
    mockList.mockRejectedValue(new Error('connection refused'))
    expect(await countWorkspaces()).toEqual({})
  })

})

