import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type * as runtimeModule from '#drivers/k8s/container/runtime'

const mockExecFileAsync = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/container/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof runtimeModule>()),
  execFileAsync: mockExecFileAsync,
}))

const mockServerLog = vi.hoisted(() => vi.fn())
vi.mock('#log', () => ({ serverLog: mockServerLog, pipeToServerLog: vi.fn() }))

import { reconcileHostImageGc } from '#drivers/k8s/image-engine'
// Setup values, not units under test: the sweep is throttled and the prune
// carries an age floor, so a test that drives the reconcile has to speak in
// the same numbers the module does.
import { HOST_IMAGE_GC_INTERVAL_MS, HOST_PRUNE_UNTIL } from '#drivers/k8s/image-engine/image-gc'

// Newest-first, as `podman image ls --sort created` emits. Four yaac-base
// generations (2 stale at the default budget), one in-budget registry-staged
// yaac ref, three non-yaac tags, plus a dangling and a blank row.
const LS_OUTPUT = [
  'localhost/yaac-base|localhost/yaac-base:new1',
  'localhost/yaac-base|localhost/yaac-base:new2',
  'localhost/yaac-base|localhost/yaac-base:old1',
  'localhost/yaac-base|localhost/yaac-base:old2',
  'localhost:5001/yaac-user-demo|localhost:5001/yaac-user-demo:a',
  'docker.io/library/ubuntu|docker.io/library/ubuntu:26.04',
  'docker.io/library/ubuntu|docker.io/library/ubuntu:24.04',
  'docker.io/library/ubuntu|docker.io/library/ubuntu:22.04',
  '<none>|<none>:<none>',
  '',
].join('\n')

// The throttle is module state with no reset hook, so every sweep in this
// file gets its own tick, one full interval past the last.
let clock = HOST_IMAGE_GC_INTERVAL_MS * 100
const nextSweep = (): number => (clock += HOST_IMAGE_GC_INTERVAL_MS)

type Call = [string, string[]]
const callsMatching = (pred: (args: string[]) => boolean): string[][] =>
  (mockExecFileAsync.mock.calls as Call[]).map(([, args]) => args).filter(pred)
const rmiRefs = (): string[] => callsMatching((a) => a[0] === 'rmi').map((a) => a[1])

/** Serve `image ls` from LS_OUTPUT; everything else succeeds empty. */
function servingLs(overrides: (args: string[]) => Promise<unknown> | undefined = () => undefined) {
  mockExecFileAsync.mockImplementation((_cmd: string, args: string[]) => {
    const override = overrides(args)
    if (override) return override
    if (args[0] === 'image' && args[1] === 'ls') {
      return Promise.resolve({ stdout: LS_OUTPUT, stderr: '' })
    }
    return Promise.resolve({ stdout: '', stderr: '' })
  })
}

beforeEach(() => {
  mockExecFileAsync.mockReset().mockResolvedValue({ stdout: '', stderr: '' })
  mockServerLog.mockReset()
  // The shared test setup isolates YAAC_K8S_NAMESPACE; the reconcile is
  // gated to the default install, so opt in unless a test says otherwise.
  vi.stubEnv('YAAC_K8S_NAMESPACE', 'yaac')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('reconcileHostImageGc', () => {
  it('retires stale generation tags, then prunes dangling images past the age floor', async () => {
    servingLs((args) => args[1] === 'prune'
      ? Promise.resolve({ stdout: `${'a'.repeat(64)}\n${'b'.repeat(64)}\n`, stderr: '' })
      : undefined)

    await reconcileHostImageGc(nextSweep())

    // No -f on rmi: a tag in use by a container, or mid-build as a FROM,
    // must fail its rmi and wait for the next sweep.
    expect(callsMatching((a) => a[0] === 'rmi')).toEqual([
      ['rmi', 'localhost/yaac-base:old1'],
      ['rmi', 'localhost/yaac-base:old2'],
    ])
    expect(callsMatching((a) => a[1] === 'prune')).toEqual([
      ['image', 'prune', '-f', '--filter', `until=${HOST_PRUNE_UNTIL}`],
    ])
    expect(mockServerLog.mock.calls[0][0]).toContain('pruned 2 dangling image(s)')
  })

  it('keeps the newest generations per yaac repo and never touches non-yaac repos', async () => {
    servingLs()
    await reconcileHostImageGc(nextSweep())
    // yaac-base has 4 generations → the 2 oldest go. The registry-staged
    // yaac ref is in scope but within budget; ubuntu has 3 tags and is not
    // a yaac-built repo, so neither is a candidate.
    expect(rmiRefs()).toEqual(['localhost/yaac-base:old1', 'localhost/yaac-base:old2'])
  })

  it('ignores dangling and malformed rows in the listing', async () => {
    servingLs()
    await reconcileHostImageGc(nextSweep())
    expect(rmiRefs().some((ref) => ref.includes('<none>'))).toBe(false)
  })

  it('retires nothing when the engine has no images', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' })
    await reconcileHostImageGc(nextSweep())
    expect(rmiRefs()).toEqual([])
  })

  it('tolerates an rmi failure and still prunes', async () => {
    servingLs((args) => args[0] === 'rmi' && args[1] === 'localhost/yaac-base:old1'
      ? Promise.reject(new Error('image is in use by a container'))
      : undefined)

    await reconcileHostImageGc(nextSweep())

    expect(callsMatching((a) => a[1] === 'prune')).toHaveLength(1)
    // The failed tag stays for the next sweep; only the other is reported.
    expect(mockServerLog.mock.calls[0][0]).toContain('retired 1 stale image tag(s)')
    expect(mockServerLog.mock.calls[0][0]).toContain('localhost/yaac-base:old2')
  })

  it('sweeps immediately, then throttles to the interval', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' })
    const t0 = nextSweep()
    await reconcileHostImageGc(t0)
    await reconcileHostImageGc(t0 + HOST_IMAGE_GC_INTERVAL_MS - 1)
    expect(callsMatching((a) => a[1] === 'ls')).toHaveLength(1)

    await reconcileHostImageGc(t0 + HOST_IMAGE_GC_INTERVAL_MS)
    expect(callsMatching((a) => a[1] === 'ls')).toHaveLength(2)
    clock = t0 + HOST_IMAGE_GC_INTERVAL_MS
  })

  it('is a no-op on test-isolated installs (per-run namespaces)', async () => {
    vi.stubEnv('YAAC_K8S_NAMESPACE', 'yaac-test-abc123')
    await reconcileHostImageGc(nextSweep())
    expect(mockExecFileAsync).not.toHaveBeenCalled()
  })

  it('logs a summary only when something was reclaimed', async () => {
    servingLs()
    await reconcileHostImageGc(nextSweep())
    expect(mockServerLog).toHaveBeenCalledOnce()
    expect(mockServerLog.mock.calls[0][0]).toContain('retired 2 stale image tag(s)')

    mockServerLog.mockReset()
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' })
    await reconcileHostImageGc(nextSweep())
    expect(mockServerLog).not.toHaveBeenCalled()
  })
})
