import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// The substrate is the boundary this file mocks, and the only one: every
// function under test runs for real against it, which is the point — this is
// where the server's vocabulary meets Kubernetes', and a translation that
// drifts is invisible to any test that stubs the lookup itself.
vi.mock('#platform/k8s/pods', async (importOriginal) => ({
  ...(await importOriginal<typeof podsModule>()),
  listWorktreePods: vi.fn(),
}))
vi.mock('#platform/k8s/cluster-cache', () => ({ getActiveClusterCache: vi.fn(() => null) }))

import { LABEL_PREWARMED, listWorktreePods, type PodInfo } from '#platform/k8s/pods'
import type * as podsModule from '#platform/k8s/pods'
import { getActiveClusterCache } from '#platform/k8s/cluster-cache'
import {
  _resetDeferredClusterBootForTests,
  armDeferredClusterBoot,
  awaitDeferredClusterBoot,
} from '#platform/k8s/deferred-boot'
import {
  countProjectWorkspaces,
  countWorkspaces,
  findWorkspace,
  listWorkspaces,
} from '#runtime/k8s/worktrees/locate'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

const mockList = vi.mocked(listWorktreePods)
const mockCache = vi.mocked(getActiveClusterCache)

function pod(over: Partial<PodInfo> = {}): PodInfo {
  return {
    podName: 'yaac-proj-abc123-xyz',
    jobName: 'yaac-proj-abc123',
    worktreeId: 'abc123def456',
    projectSlug: 'proj',
    tool: 'claude',
    phase: 'Running',
    running: true,
    terminating: false,
    createdAtMs: 1_700_000_000_000,
    labels: {},
    ...over,
  } as PodInfo
}

/** A cluster cache whose worktree-pods informer is connected and seeded. */
function healthyCache(pods: PodInfo[]): ReturnType<typeof getActiveClusterCache> {
  return {
    healthy: (source: string) => source === 'worktree-pods',
    worktreePods: () => pods,
  } as unknown as ReturnType<typeof getActiveClusterCache>
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  _resetDeferredClusterBootForTests()
  mockList.mockReset().mockResolvedValue([])
  mockCache.mockReset().mockReturnValue(null)
})

afterEach(async () => {
  _resetDeferredClusterBootForTests()
  await cleanupTempDir(tmpDir)
})

describe('findWorkspace', () => {
  it('describes a match in the server’s vocabulary, not the substrate’s', async () => {
    mockList.mockResolvedValue([pod({ tool: 'Claude', labels: { [LABEL_PREWARMED]: 'true' } })])
    expect(await findWorkspace('abc123')).toEqual({
      workspaceId: 'abc123def456',
      projectSlug: 'proj',
      jobName: 'yaac-proj-abc123',
      // Normalized here so nothing above has to know that a pod carries a
      // raw label string. No `declaredTool`: 'Claude' is not one of the tool
      // names yaac knows, so it resolves to something runnable without
      // counting as a declaration a spawn could inherit.
      tool: 'claude',
      mode: 'tui',
      running: true,
      state: 'running',
      labels: { [LABEL_PREWARMED]: 'true' },
      createdAtMs: 1_700_000_000_000,
      prewarmed: true,
      terminating: false,
      deathCause: { reason: 'pod-stopped' },
    })
  })

  it('answers undefined for no match', async () => {
    expect(await findWorkspace('nope')).toBeUndefined()
  })

  it('reports a non-running pod with its lowercased phase', async () => {
    mockList.mockResolvedValue([pod({ phase: 'Pending', running: false })])
    expect(await findWorkspace('abc123')).toMatchObject({
      running: false, state: 'pending',
    })
  })

  // The whole point of the cache: a polled endpoint resolves without paying
  // for a `kubectl get pods` subprocess.
  it('answers from the informer cache without listing, when asked to', async () => {
    mockCache.mockReturnValue(healthyCache([pod()]))
    const found = await findWorkspace('abc123', { preferCache: true })
    expect(found?.jobName).toBe('yaac-proj-abc123')
    expect(mockList).not.toHaveBeenCalled()
  })

  // A pod reaches the cache via a watch event, so a just-created workspace
  // can be missing from it for a moment. Concluding "not found" there would
  // break the PTY attach that runs immediately after a create.
  it('falls back to a live listing when the cache does not have it yet', async () => {
    mockCache.mockReturnValue(healthyCache([]))
    mockList.mockResolvedValue([pod()])
    const found = await findWorkspace('abc123', { preferCache: true })
    expect(found?.jobName).toBe('yaac-proj-abc123')
    expect(mockList).toHaveBeenCalledTimes(1)
  })

  // An unseeded or disconnected informer cannot be trusted for presence
  // either, so it is bypassed entirely rather than consulted.
  it('ignores an unhealthy cache and lists live', async () => {
    mockCache.mockReturnValue({
      healthy: () => false,
      worktreePods: () => { throw new Error('must not read an unhealthy cache') },
    } as unknown as ReturnType<typeof getActiveClusterCache>)
    mockList.mockResolvedValue([pod()])
    const found = await findWorkspace('abc123', { preferCache: true })
    expect(found?.jobName).toBe('yaac-proj-abc123')
  })

  // Without the flag the cache is not consulted at all: a restart and a
  // detail render must not read a sub-second-stale tool label.
  it('does not consult the cache unless asked', async () => {
    mockCache.mockReturnValue(healthyCache([pod()]))
    mockList.mockResolvedValue([pod({ jobName: 'yaac-proj-live' })])
    const found = await findWorkspace('abc123')
    expect(found?.jobName).toBe('yaac-proj-live')
  })

  // Distinct from "no match": a caller with a recorded row to fall back on
  // catches this, and one without lets it through to the client.
  it('surfaces a listing failure as RUNTIME_UNAVAILABLE', async () => {
    mockList.mockRejectedValue(new Error('connection refused'))
    await expect(findWorkspace('abc123')).rejects.toMatchObject({
      code: 'RUNTIME_UNAVAILABLE',
    })
  })
})

describe('listWorkspaces', () => {
  it('scopes to one project and maps each pod', async () => {
    mockList.mockResolvedValue([pod(), pod({ worktreeId: 'other', jobName: 'yaac-proj-other' })])
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
      pod({ projectSlug: 'foo' }),
      pod({ projectSlug: 'foo' }),
      pod({ projectSlug: 'bar' }),
      pod({ projectSlug: 'bar', labels: { [LABEL_PREWARMED]: 'true' } }),
      pod({ projectSlug: '' }),
    ])
    expect(await countWorkspaces()).toEqual({ foo: 2, bar: 1 })
  })

  // Unlike `listWorkspaces`, a count is a display detail: an unreachable
  // substrate reports zero rather than failing the listing that wanted it.
  it('reports nothing when the substrate is unavailable', async () => {
    mockList.mockRejectedValue(new Error('connection refused'))
    expect(await countWorkspaces()).toEqual({})
  })

  // A nested server whose deferred attach hasn't finished has no pods by
  // construction, so holding the first snapshot on a call to a still-waking
  // vcluster would be pure latency.
  it('answers empty without a substrate call while a deferred attach is pending', async () => {
    const boot = vi.fn().mockResolvedValue(undefined)
    armDeferredClusterBoot(boot)

    expect(await countWorkspaces()).toEqual({})
    expect(mockList).not.toHaveBeenCalled()

    // The short-circuit still fires the attach — it just doesn't wait.
    await awaitDeferredClusterBoot()
    expect(boot).toHaveBeenCalledTimes(1)
  })
})

describe('countProjectWorkspaces', () => {
  // Spares included, unlike `countWorkspaces`: a project's own detail page
  // reports what the substrate is running for it, warmed or not.
  it('counts one project’s pods, and zero when the substrate is unavailable', async () => {
    mockList.mockResolvedValue([pod(), pod({ labels: { [LABEL_PREWARMED]: 'true' } })])
    expect(await countProjectWorkspaces('proj')).toBe(2)
    expect(mockList).toHaveBeenCalledWith('proj')

    mockList.mockRejectedValue(new Error('connection refused'))
    expect(await countProjectWorkspaces('proj')).toBe(0)
  })
})
