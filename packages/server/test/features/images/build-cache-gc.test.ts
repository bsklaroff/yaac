import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type * as runtimeModule from '#platform/container/runtime'

const mockExecFileAsync = vi.hoisted(() => vi.fn())
vi.mock('#platform/container/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof runtimeModule>()),
  execFileAsync: mockExecFileAsync,
}))

const mockEnsureRegistryService = vi.hoisted(() => vi.fn())
vi.mock('#features/cluster', () => ({
  ensureRegistryClusterService: mockEnsureRegistryService,
}))

const mockServerLog = vi.hoisted(() => vi.fn())
vi.mock('#log', () => ({ serverLog: mockServerLog, pipeToServerLog: vi.fn() }))

import { reconcileBuildCacheGc } from '#features/images'
// Setup values and state-reset/settle hooks, not units under test: the pass
// is throttled and detached, and its retention has to be spoken in the same
// numbers the module uses.
import {
  BUILD_CACHE_GC_INTERVAL_MS,
  buildCacheRetainDays,
  _buildCacheGcSettledForTests,
  _resetBuildCacheGcForTests,
} from '#features/images/build-cache-gc'

/** What the in-container sweep prints when two cache tags aged out. */
const RETIRED_OUTPUT = [
  `RETIRED ${'a'.repeat(64)}`,
  `RETIRED ${'b'.repeat(64)}`,
  '',
].join('\n')

type Call = [string, string[]]
const argvs = (): string[][] => (mockExecFileAsync.mock.calls as Call[]).map(([, args]) => args)
/** The argv the pass ran INSIDE the registry container (podman exec …). */
const inRegistry = (): string[][] => argvs()
  .filter((a) => a[0] === 'exec')
  .map((a) => a.slice(2))
const shellScripts = (): string[] => inRegistry().filter((a) => a[0] === 'sh').map((a) => a[2])
const sweepScript = (): string => shellScripts().find((s) => s.includes('yaac-buildcache-*')) ?? ''
const probeScripts = (): string[] => shellScripts().filter((s) => s.includes('_uploads'))
const ran = (word: string): boolean => inRegistry().some((a) => a.includes(word))
const restarted = (): boolean => argvs().some((a) => a[0] === 'restart')
const logged = (needle: string): boolean =>
  mockServerLog.mock.calls.some((call) => String(call[0]).includes(needle))

/**
 * Serve the registry container's exec calls. `sweep` is what the untag
 * script prints; `probe` is what the quiet probe prints ('' = quiet, and
 * an array walks a probe-per-call so a pass can be quiet then busy).
 */
function servingPass(opts: {
  sweep?: string
  probe?: string | string[]
  marked?: boolean
  fail?: (argv: string[]) => Error | undefined
} = {}): void {
  const probes = Array.isArray(opts.probe) ? [...opts.probe] : null
  mockExecFileAsync.mockImplementation((_cmd: string, args: string[]) => {
    const failure = opts.fail?.(args)
    if (failure) return Promise.reject(failure)
    const script = args[0] === 'exec' && args[2] === 'sh' ? args[4] : undefined
    let stdout = ''
    if (script?.includes('yaac-buildcache-*')) stdout = opts.sweep ?? ''
    else if (script?.includes('_uploads')) stdout = probes?.shift() ?? (opts.probe as string ?? '')
    else if (script?.includes('collect-started')) stdout = opts.marked ? 'MARKED\n' : ''
    return Promise.resolve({ stdout, stderr: '' })
  })
}

/** Drive one reconcile and wait out the detached pass it starts. */
async function runPass(nowMs?: number): Promise<void> {
  await reconcileBuildCacheGc(nowMs)
  await _buildCacheGcSettledForTests()
}

beforeEach(() => {
  mockExecFileAsync.mockReset().mockResolvedValue({ stdout: '', stderr: '' })
  mockEnsureRegistryService.mockReset().mockResolvedValue(undefined)
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
    expect(restarted()).toBe(true)
    // The restart can move the container on the kind network, and the
    // builder pods reach it through an EndpointSlice holding that address.
    expect(mockEnsureRegistryService).toHaveBeenCalledOnce()
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
    expect(mockEnsureRegistryService).toHaveBeenCalledOnce()
    expect(logged('collect timed out')).toBe(true)
    expect(logged('collected their blobs')).toBe(false)
  })

  it('leaves the collect marker for the next sweep when the restart fails', async () => {
    servingPass({
      sweep: RETIRED_OUTPUT,
      fail: (argv) => argv[0] === 'restart' ? new Error('podman restart failed') : undefined,
    })

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
    expect(mockEnsureRegistryService).not.toHaveBeenCalled()
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
    const collecting = new Promise<void>((resolve) => { release = resolve })
    servingPass({ sweep: RETIRED_OUTPUT })
    mockExecFileAsync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('garbage-collect')) return collecting.then(() => ({ stdout: '', stderr: '' }))
      const script = args[0] === 'exec' && args[2] === 'sh' ? args[4] : undefined
      return Promise.resolve({
        stdout: script?.includes('yaac-buildcache-*') ? RETIRED_OUTPUT : '',
        stderr: '',
      })
    })

    // Reconcile passes are serialized, so this must return while the
    // collect is still running — and a tick arriving meanwhile must not
    // start a second collect.
    await reconcileBuildCacheGc()
    const before = argvs().length
    await reconcileBuildCacheGc(BUILD_CACHE_GC_INTERVAL_MS * 200)
    expect(argvs()).toHaveLength(before)

    release()
    await _buildCacheGcSettledForTests()
    expect(restarted()).toBe(true)
  })

  it('is a no-op on test-isolated installs and inside a nested yaac', async () => {
    vi.stubEnv('YAAC_K8S_NAMESPACE', 'yaac-test-abc123')
    await runPass()
    expect(mockExecFileAsync).not.toHaveBeenCalled()

    // Nested installs push to the OUTER install's per-project registry:
    // not theirs to collect, and no container of theirs to exec into.
    vi.stubEnv('YAAC_K8S_NAMESPACE', 'yaac')
    vi.stubEnv('YAAC_NESTED', '1')
    _resetBuildCacheGcForTests()
    await runPass()
    expect(mockExecFileAsync).not.toHaveBeenCalled()
  })

  it('logs and moves on when there is no registry container to sweep', async () => {
    mockExecFileAsync.mockRejectedValue(new Error('no such container yaac-registry'))

    await expect(runPass()).resolves.toBeUndefined()

    expect(logged('no such container')).toBe(true)
  })
})
