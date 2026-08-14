import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The fallback listings are one-shot kubectl calls, so the child process is
// the boundary: the session-pod object layer (its selectors, schemas and
// mappers) runs for real behind it.
type ExecResult = { stdout: string; stderr: string }
type ExecCallback = (err: unknown, res?: ExecResult) => void
const execFileMock = vi.fn<(file: string, args: readonly string[]) => Promise<ExecResult>>()
vi.mock('node:child_process', () => ({
  execFile: (file: string, args: readonly string[], opts: unknown, cb?: ExecCallback) => {
    const actualCb = (typeof opts === 'function' ? opts : cb) as ExecCallback
    void execFileMock(file, args).then(
      (res) => actualCb(null, res),
      (err: unknown) => actualCb(err),
    )
    return { stdin: { end: vi.fn() } }
  },
  exec: vi.fn(),
}))

import {
  createTickSnapshot,
  setActiveClusterCache,
  type ClusterCache,
  type PodInfo,
} from '#drivers/k8s/substrate'

const SID = '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9'

/** Raw kubectl payloads, keyed by the resource in the argv. */
const payloads: Record<string, unknown> = {}

function rawPod(name: string): unknown {
  return {
    metadata: {
      name,
      labels: {
        'batch.kubernetes.io/job-name': `yaac-demo-${SID}`,
        'yaac.worktree-id': SID,
        'yaac.project': 'demo',
        'yaac.tool': 'claude',
      },
      creationTimestamp: '2026-06-01T00:00:00Z',
    },
    status: { phase: 'Running' },
  }
}

/** A ClusterCache whose informers are all healthy, as the server publishes. */
function healthyCache(): ClusterCache {
  return {
    healthy: () => true,
    worktreePods: () => [{ podName: 'cached' } as PodInfo],
    worktreeJobs: () => [],
  } as unknown as ClusterCache
}

/** kubectl argv → the resource it lists (`get <kind> -n <ns> …`). */
const kindOf = (args: readonly string[]): string => args[1]

beforeEach(() => {
  vi.stubEnv('YAAC_K8S_NAMESPACE', 'test-ns')
  execFileMock.mockReset()
  execFileMock.mockImplementation((_file, args) =>
    Promise.resolve({ stdout: JSON.stringify(payloads[kindOf(args)] ?? { items: [] }), stderr: '' }))
  payloads['pods'] = { items: [rawPod('yaac-demo-p1')] }
  payloads['jobs'] = { items: [] }
})

afterEach(() => {
  setActiveClusterCache(null)
  vi.unstubAllEnvs()
})

describe('createTickSnapshot', () => {
  it('is lazy — creating a snapshot lists nothing', () => {
    createTickSnapshot()
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('defaults to resync=true for direct invocations', () => {
    expect(createTickSnapshot().resync).toBe(true)
    expect(createTickSnapshot(false).resync).toBe(false)
  })

  it('lists each kind at most once per snapshot and maps the rows', async () => {
    const snap = createTickSnapshot()
    const pods = await snap.pods()
    expect(pods.map((p) => p.podName)).toEqual(['yaac-demo-p1'])
    expect(pods[0].worktreeId).toBe(SID)
    expect(await snap.pods()).toBe(pods)
    await snap.jobs()
    await snap.jobs()
    expect(execFileMock).toHaveBeenCalledTimes(2)
    // Each fallback is scoped the way its own object layer scopes it —
    // install-wide, by data-dir-hash.
    const argv = execFileMock.mock.calls.map(([, args]) => args.join(' '))
    expect(argv.find((c) => c.startsWith('get pods -n test-ns')))
      .toMatch(/-l yaac\.data-dir-hash=[0-9a-f]{16},yaac\.worktree-id/)
  })

  it('separate snapshots list independently', async () => {
    await createTickSnapshot().pods()
    await createTickSnapshot().pods()
    expect(execFileMock).toHaveBeenCalledTimes(2)
  })

  it('reads an absent namespace as empty rather than an error', async () => {
    // A namespace torn down mid-pass: kubectl 404s, the object layer
    // returns no rows, and the step sees empty instead of throwing.
    execFileMock.mockRejectedValue(
      Object.assign(new Error('kubectl failed'), { stderr: 'Error from server (NotFound)' }),
    )
    const snap = createTickSnapshot()
    expect(await snap.pods()).toEqual([])
    expect(await snap.jobs()).toEqual([])
  })

  it('a failed listing stays failed for the whole snapshot (no per-consumer retry)', async () => {
    execFileMock.mockRejectedValue(Object.assign(new Error('kubectl failed'), { stderr: 'forbidden' }))
    const snap = createTickSnapshot()
    await expect(snap.pods()).rejects.toThrow('kubectl failed')
    await expect(snap.pods()).rejects.toThrow('kubectl failed')
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })

  it('answers from a healthy active cluster cache without listing', async () => {
    setActiveClusterCache(healthyCache())
    const snap = createTickSnapshot()
    expect((await snap.pods()).map((p) => p.podName)).toEqual(['cached'])
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('falls back to a live list when the cache source is unhealthy', async () => {
    // The destructive-step safety story: a degraded watch must never be
    // mistaken for "this object no longer exists".
    const cache = healthyCache()
    vi.spyOn(cache, 'healthy').mockReturnValue(false)
    setActiveClusterCache(cache)
    const snap = createTickSnapshot()
    expect((await snap.pods()).map((p) => p.podName)).toEqual(['yaac-demo-p1'])
    await snap.jobs()
    expect(execFileMock).toHaveBeenCalledTimes(2)
  })
})
