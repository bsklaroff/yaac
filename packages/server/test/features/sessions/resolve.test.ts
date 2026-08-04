import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// No cluster in unit tests — resolveSessionContainer's pod listing is
// mocked to an empty cluster so the NOT_FOUND paths are exercised.
vi.mock('#platform/k8s/pods', async () => {
  const actual = await vi.importActual<typeof podsModule>('#platform/k8s/pods')
  return { ...actual, listSessionPods: vi.fn().mockResolvedValue([]) }
})
vi.mock('#platform/k8s/cluster-cache', () => ({ getActiveClusterCache: vi.fn(() => null) }))

import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { resolveSessionContainer } from '#features/sessions/resolve'
import { listSessionPods } from '#platform/k8s/pods'
import { getActiveClusterCache } from '#platform/k8s/cluster-cache'
import { ServerError } from '@yaac/shared/errors'
import type * as podsModule from '#platform/k8s/pods'
import type { SessionPod } from '#platform/k8s/pods'

const mockList = vi.mocked(listSessionPods)
const mockCache = vi.mocked(getActiveClusterCache)

function pod(over: Partial<SessionPod> = {}): SessionPod {
  return {
    podName: 'yaac-proj-abc123-xyz',
    jobName: 'yaac-proj-abc123',
    sessionId: 'abc123def456',
    projectSlug: 'proj',
    phase: 'Running',
    running: true,
    labels: {},
    ...over,
  } as SessionPod
}

/** A cluster cache whose session-pods informer is connected and seeded. */
function healthyCache(pods: SessionPod[]): ReturnType<typeof getActiveClusterCache> {
  return {
    healthy: (source: string) => source === 'session-pods',
    sessionPods: () => pods,
  } as unknown as ReturnType<typeof getActiveClusterCache>
}

describe('resolveSessionContainer', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    mockList.mockReset().mockResolvedValue([])
    mockCache.mockReset().mockReturnValue(null)
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('throws NOT_FOUND when no container matches the id', async () => {
    await expect(resolveSessionContainer('nope')).rejects.toBeInstanceOf(ServerError)
    await expect(resolveSessionContainer('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('throws NOT_FOUND for any id in a fresh data dir, regardless of requireRunning', async () => {
    await expect(
      resolveSessionContainer('nope', { requireRunning: true }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  // The whole point of the cache: a session endpoint resolves without paying
  // for a `kubectl get pods` subprocess.
  it('resolves from the informer cache without listing the cluster', async () => {
    mockCache.mockReturnValue(healthyCache([pod()]))
    const out = await resolveSessionContainer('abc123', { requireRunning: true })
    expect(out).toMatchObject({
      jobName: 'yaac-proj-abc123', sessionId: 'abc123def456', projectSlug: 'proj', state: 'running',
    })
    expect(mockList).not.toHaveBeenCalled()
  })

  // A pod reaches the cache via a watch event, so a just-created session can be
  // missing from it for a moment. Concluding NOT_FOUND there would break the
  // PTY attach that runs immediately after create.
  it('falls back to a live list when the cache does not have the session yet', async () => {
    mockCache.mockReturnValue(healthyCache([]))
    mockList.mockResolvedValue([pod()])
    const out = await resolveSessionContainer('abc123')
    expect(out.jobName).toBe('yaac-proj-abc123')
    expect(mockList).toHaveBeenCalledTimes(1)
  })

  // An unseeded or disconnected informer cannot be trusted for presence
  // either, so it is bypassed entirely rather than consulted.
  it('ignores an unhealthy cache and lists live', async () => {
    const unhealthy = {
      healthy: () => false,
      sessionPods: () => { throw new Error('must not read an unhealthy cache') },
    } as unknown as ReturnType<typeof getActiveClusterCache>
    mockCache.mockReturnValue(unhealthy)
    mockList.mockResolvedValue([pod()])
    const out = await resolveSessionContainer('abc123')
    expect(out.jobName).toBe('yaac-proj-abc123')
    expect(mockList).toHaveBeenCalledTimes(1)
  })

  it('reports a non-running pod as CONFLICT only when the caller requires running', async () => {
    mockCache.mockReturnValue(healthyCache([pod({ phase: 'Pending', running: false })]))
    await expect(
      resolveSessionContainer('abc123', { requireRunning: true }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    // Without the flag the same pod resolves, carrying its phase as state.
    expect(await resolveSessionContainer('abc123')).toMatchObject({ state: 'pending' })
  })

  it('surfaces a cluster listing failure as RUNTIME_UNAVAILABLE', async () => {
    mockList.mockRejectedValue(new Error('connection refused'))
    await expect(resolveSessionContainer('abc123')).rejects.toMatchObject({
      code: 'RUNTIME_UNAVAILABLE',
    })
  })
})
