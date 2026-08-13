import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The registry is an in-cluster Deployment: every step of a pass is either
// a `kubectl exec` into its pod or a rollout of it, and `#drivers/k8s/cluster`
// is where both live.
const mockRegistryExec = vi.hoisted(() => vi.fn())
const mockRestartRegistry = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/cluster', () => ({
  mainRegistryExec: mockRegistryExec,
  restartMainRegistry: mockRestartRegistry,
}))

const mockServerLog = vi.hoisted(() => vi.fn())
vi.mock('#log', () => ({ serverLog: mockServerLog, pipeToServerLog: vi.fn() }))

import { reconcileBuildCacheGc } from '#drivers/k8s/images'
// Setup values and state-reset/settle hooks, not units under test: the pass
// is throttled and detached, and its retention has to be spoken in the same
// numbers the module uses.
import {
  BUILD_CACHE_GC_INTERVAL_MS,
  buildCacheRetainDays,
  _buildCacheGcSettledForTests,
  _resetBuildCacheGcForTests,
} from '#drivers/k8s/images/build-cache-gc'

/** What the in-container sweep prints when two cache tags aged out. */
const RETIRED_OUTPUT = [
  `RETIRED ${'a'.repeat(64)}`,
  `RETIRED ${'b'.repeat(64)}`,
  '',
].join('\n')

type Call = [string[], number]
/** The argv the pass ran INSIDE the registry pod. */
const inRegistry = (): string[][] => (mockRegistryExec.mock.calls as Call[]).map(([argv]) => argv)
const shellScripts = (): string[] => inRegistry().filter((a) => a[0] === 'sh').map((a) => a[2])
const sweepScript = (): string => shellScripts().find((s) => s.includes('yaac-buildcache-*')) ?? ''
const probeScripts = (): string[] => shellScripts().filter((s) => s.includes('_uploads'))
const ran = (word: string): boolean => inRegistry().some((a) => a.includes(word))
const restarted = (): boolean => mockRestartRegistry.mock.calls.length > 0
const logged = (needle: string): boolean =>
  mockServerLog.mock.calls.some((call) => String(call[0]).includes(needle))

/**
 * Serve the registry pod's exec calls. `sweep` is what the untag script
 * prints; `probe` is what the quiet probe prints ('' = quiet, and an array
 * walks a probe-per-call so a pass can be quiet then busy).
 */
function servingPass(opts: {
  sweep?: string
  probe?: string | string[]
  marked?: boolean
  fail?: (argv: string[]) => Error | undefined
} = {}): void {
  const probes = Array.isArray(opts.probe) ? [...opts.probe] : null
  mockRegistryExec.mockImplementation((argv: string[]) => {
    const failure = opts.fail?.(argv)
    if (failure) return Promise.reject(failure)
    const script = argv[0] === 'sh' ? argv[2] : undefined
    let stdout = ''
    if (script?.includes('yaac-buildcache-*')) stdout = opts.sweep ?? ''
    else if (script?.includes('_uploads')) stdout = probes?.shift() ?? (opts.probe as string ?? '')
    else if (script?.includes('collect-started')) stdout = opts.marked ? 'MARKED\n' : ''
    return Promise.resolve(stdout)
  })
}

/** Drive one reconcile and wait out the detached pass it starts. */
async function runPass(nowMs?: number): Promise<void> {
  await reconcileBuildCacheGc(nowMs)
  await _buildCacheGcSettledForTests()
}

beforeEach(() => {
  mockRegistryExec.mockReset().mockResolvedValue('')
  mockRestartRegistry.mockReset().mockResolvedValue(undefined)
  mockServerLog.mockReset()
  _resetBuildCacheGcForTests()
  // The shared test setup isolates YAAC_K8S_NAMESPACE; the reconcile is
  // gated to the default install, so opt in unless a test says otherwise.
  vi.stubEnv('YAAC_K8S_NAMESPACE', 'yaac')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('reconcileBuildCacheGc', () => {
  it('untags aged-out cache tags, collects their blobs, and restarts the registry', async () => {
    servingPass({ sweep: RETIRED_OUTPUT })

    await runPass()

    // Retention is the read-side --cache-ttl, applied to the tag link's
    // mtime (a cache hit re-pushes the entry, so the link tracks last use).
    expect(sweepScript()).toContain(`-name link -mtime +${buildCacheRetainDays()}`)
    expect(sweepScript()).toContain('"$ROOT"/yaac-buildcache-*/_manifests/tags')
    // Untagging alone frees no disk: the registry only drops blobs when the
    // collect runs, and only the restart clears the in-memory blob
    // descriptors that would otherwise make a re-push of a collected digest
    // write a link with no blob behind it.
    expect(ran('garbage-collect')).toBe(true)
    // The restart rolls the Deployment (and drops this process's stale
    // port-forward) — nothing about the cluster's route to it changes.
    expect(restarted()).toBe(true)
    // The collect is bounded inside the container too — killing the exec
    // client would leave it deleting blobs under the restart.
    expect(inRegistry().find((a) => a.includes('garbage-collect'))?.[0]).toBe('timeout')
    expect(logged('retired 2 stale step-cache tag(s)')).toBe(true)
  })

  it('restarts the registry even when the collect fails part-way through', async () => {
    servingPass({
      sweep: RETIRED_OUTPUT,
      fail: (argv) => argv.includes('garbage-collect') ? new Error('collect timed out') : undefined,
    })

    await runPass()

    // A collect that threw may have deleted blobs already, so this is the
    // case the restart matters most for — and nothing else would retry it,
    // since the tags it retired are gone and a later sweep finds none.
    expect(restarted()).toBe(true)
    expect(logged('collect timed out')).toBe(true)
    expect(logged('collected their blobs')).toBe(false)
  })

  it('leaves the collect marker for the next sweep when the restart fails', async () => {
    servingPass({
      sweep: RETIRED_OUTPUT,
    })
    mockRestartRegistry.mockRejectedValue(new Error('rollout failed'))

    await runPass()

    // Marker cleared only after a restart succeeds, so the registry cannot
    // be left serving stale descriptors with nothing scheduled to fix it.
    expect(inRegistry().some((a) => a[0] === 'rm')).toBe(false)
    expect(logged('could not be restarted')).toBe(true)
    expect(logged('collected their blobs')).toBe(false)
  })

  it('finishes an unfinished collect before doing anything else', async () => {
    servingPass({ marked: true, probe: 'BUSY\n' })

    await runPass()

    // The marker outlives the process that wrote it, so a server killed
    // mid-collect still gets its restart on the next pass — even one that
    // then stands down for a live push.
    expect(restarted()).toBe(true)
    expect(inRegistry().some((a) => a[0] === 'rm')).toBe(true)
    expect(logged('previous collect went unfinished')).toBe(true)
    expect(ran('garbage-collect')).toBe(false)
  })

  it('stands down while a push is in flight rather than collecting under it', async () => {
    servingPass({ probe: 'BUSY\n' })

    await runPass()

    // The probe owns the decision registry-side, so it covers every pusher
    // — e2e servers and builder pods included, not just this process.
    expect(probeScripts()[0]).toContain("-path '*/_uploads/*'")
    // An upload dir is missing for a committed-but-unreferenced blob and
    // for a cross-repo mount; a freshly written link is not.
    expect(probeScripts()[0]).toContain('-name link -type f -mmin')
    expect(sweepScript()).toBe('')
    expect(ran('garbage-collect')).toBe(false)
    expect(restarted()).toBe(false)
    expect(logged('pushes in flight')).toBe(true)
  })

  it('re-checks for pushes after the untag and skips only the collect', async () => {
    servingPass({ sweep: RETIRED_OUTPUT, probe: ['', 'BUSY\n'] })

    await runPass()

    // The first read is only as good as its instant, and the untag takes
    // time. Standing down here is free: the tags are untagged either way,
    // and nothing was deleted, so no restart is owed.
    expect(probeScripts()).toHaveLength(2)
    expect(sweepScript()).not.toBe('')
    expect(ran('garbage-collect')).toBe(false)
    expect(restarted()).toBe(false)
  })

  it('leaves the registry alone when nothing aged out', async () => {
    servingPass({ sweep: '' })

    await runPass()

    // Nothing was untagged, so there is nothing to collect — and a pass
    // that found no work must never bounce the registry.
    expect(ran('garbage-collect')).toBe(false)
    expect(restarted()).toBe(false)
    expect(mockServerLog).not.toHaveBeenCalled()
  })

  it('sweeps immediately, then throttles to the interval', async () => {
    servingPass({ sweep: '' })
    const t0 = BUILD_CACHE_GC_INTERVAL_MS * 100

    await runPass(t0)
    await runPass(t0 + BUILD_CACHE_GC_INTERVAL_MS - 1)
    expect(probeScripts()).toHaveLength(1)

    await runPass(t0 + BUILD_CACHE_GC_INTERVAL_MS)
    expect(probeScripts()).toHaveLength(2)
  })

  it('detaches the pass so a collect cannot stall the reconcile tick', async () => {
    let release = (): void => {}
    let collectStarted = (): void => {}
    const collecting = new Promise<void>((resolve) => { release = resolve })
    const reachedCollect = new Promise<void>((resolve) => { collectStarted = resolve })
    servingPass({ sweep: RETIRED_OUTPUT })
    mockRegistryExec.mockImplementation((argv: string[]) => {
      if (argv.includes('garbage-collect')) {
        collectStarted()
        return collecting.then(() => '')
      }
      const script = argv[0] === 'sh' ? argv[2] : undefined
      return Promise.resolve(script?.includes('yaac-buildcache-*') ? RETIRED_OUTPUT : '')
    })

    // Reconcile passes are serialized, so this must return while the
    // collect is still running — and a tick arriving meanwhile must not
    // start a second collect.
    await reconcileBuildCacheGc()
    await reachedCollect
    const before = inRegistry().length
    await reconcileBuildCacheGc(BUILD_CACHE_GC_INTERVAL_MS * 200)
    expect(inRegistry()).toHaveLength(before)

    release()
    await _buildCacheGcSettledForTests()
    expect(restarted()).toBe(true)
  })

  it('is a no-op on test-isolated installs and inside a nested yaac', async () => {
    vi.stubEnv('YAAC_K8S_NAMESPACE', 'yaac-test-abc123')
    await runPass()
    expect(mockRegistryExec).not.toHaveBeenCalled()

    // Nested installs push to the OUTER install's per-project registry:
    // not theirs to collect, and no Deployment of theirs to exec into.
    vi.stubEnv('YAAC_K8S_NAMESPACE', 'yaac')
    vi.stubEnv('YAAC_NESTED', '1')
    _resetBuildCacheGcForTests()
    await runPass()
    expect(mockRegistryExec).not.toHaveBeenCalled()
  })

  it('logs and moves on when there is no registry to sweep', async () => {
    mockRegistryExec.mockRejectedValue(new Error('deployments.apps "yaac-registry" not found'))

    await expect(runPass()).resolves.toBeUndefined()

    expect(logged('not found')).toBe(true)
  })
})
