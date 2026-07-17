import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type * as runtimeModule from '#lib/container/runtime'

const mockExecFileAsync = vi.hoisted(() => vi.fn())
vi.mock('#lib/container/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof runtimeModule>()),
  execFileAsync: mockExecFileAsync,
}))

const mockServerLog = vi.hoisted(() => vi.fn())
vi.mock('#log', () => ({ serverLog: mockServerLog, pipeToServerLog: vi.fn() }))

import {
  gcHostImages,
  HOST_GENERATIONS_KEPT,
  HOST_IMAGE_GC_INTERVAL_MS,
  HOST_PRUNE_UNTIL,
  parseImageLsRows,
  reconcileHostImageGc,
  resetHostImageGcState,
  selectStaleGenerationTags,
} from '#lib/container/image-gc'

// Newest-first, as `podman image ls --sort created` emits.
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

beforeEach(() => {
  mockExecFileAsync.mockReset().mockResolvedValue({ stdout: '', stderr: '' })
  mockServerLog.mockReset()
  resetHostImageGcState()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('parseImageLsRows', () => {
  it('parses repo|ref lines, dropping dangling and malformed rows', () => {
    expect(parseImageLsRows(LS_OUTPUT)).toEqual([
      { repo: 'localhost/yaac-base', ref: 'localhost/yaac-base:new1' },
      { repo: 'localhost/yaac-base', ref: 'localhost/yaac-base:new2' },
      { repo: 'localhost/yaac-base', ref: 'localhost/yaac-base:old1' },
      { repo: 'localhost/yaac-base', ref: 'localhost/yaac-base:old2' },
      { repo: 'localhost:5001/yaac-user-demo', ref: 'localhost:5001/yaac-user-demo:a' },
      { repo: 'docker.io/library/ubuntu', ref: 'docker.io/library/ubuntu:26.04' },
      { repo: 'docker.io/library/ubuntu', ref: 'docker.io/library/ubuntu:24.04' },
      { repo: 'docker.io/library/ubuntu', ref: 'docker.io/library/ubuntu:22.04' },
    ])
  })

  it('returns empty for empty output', () => {
    expect(parseImageLsRows('')).toEqual([])
  })
})

describe('selectStaleGenerationTags', () => {
  it('keeps the newest N per yaac repo and never touches non-yaac repos', () => {
    const rows = parseImageLsRows(LS_OUTPUT)
    // yaac-base has 4 generations → the 2 oldest are stale; ubuntu has 3
    // tags but is not a yaac-built repo; the registry-staged yaac ref is
    // in scope but within budget.
    expect(selectStaleGenerationTags(rows)).toEqual([
      'localhost/yaac-base:old1',
      'localhost/yaac-base:old2',
    ])
  })

  it('honors a custom keep budget', () => {
    const rows = parseImageLsRows(LS_OUTPUT)
    expect(selectStaleGenerationTags(rows, 1)).toEqual([
      'localhost/yaac-base:new2',
      'localhost/yaac-base:old1',
      'localhost/yaac-base:old2',
    ])
    expect(selectStaleGenerationTags(rows, 4)).toEqual([])
  })

  it('defaults to keeping HOST_GENERATIONS_KEPT generations', () => {
    expect(HOST_GENERATIONS_KEPT).toBe(2)
  })
})

describe('gcHostImages', () => {
  it('retires stale tags then prunes dangling images past the age floor', async () => {
    mockExecFileAsync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'image' && args[1] === 'ls') {
        return Promise.resolve({ stdout: LS_OUTPUT, stderr: '' })
      }
      if (args[0] === 'image' && args[1] === 'prune') {
        return Promise.resolve({ stdout: `${'a'.repeat(64)}\n${'b'.repeat(64)}\n`, stderr: '' })
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    })

    const result = await gcHostImages()
    expect(result.retired).toEqual(['localhost/yaac-base:old1', 'localhost/yaac-base:old2'])
    expect(result.pruned).toBe(2)

    const calls = mockExecFileAsync.mock.calls as Array<[string, string[]]>
    const rmis = calls.filter(([, args]) => args[0] === 'rmi')
    // No -f: an in-use tag must fail its rmi and wait for the next sweep.
    expect(rmis.map(([, args]) => args)).toEqual([
      ['rmi', 'localhost/yaac-base:old1'],
      ['rmi', 'localhost/yaac-base:old2'],
    ])
    const prune = calls.find(([, args]) => args[1] === 'prune')
    expect(prune![1]).toEqual(['image', 'prune', '-f', '--filter', `until=${HOST_PRUNE_UNTIL}`])
  })

  it('tolerates an rmi failure and still prunes', async () => {
    mockExecFileAsync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'image' && args[1] === 'ls') {
        return Promise.resolve({ stdout: LS_OUTPUT, stderr: '' })
      }
      if (args[0] === 'rmi' && args[1] === 'localhost/yaac-base:old1') {
        return Promise.reject(new Error('image is in use by a container'))
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    })

    const result = await gcHostImages()
    expect(result.retired).toEqual(['localhost/yaac-base:old2'])
    expect(result.pruned).toBe(0)
    const calls = mockExecFileAsync.mock.calls as Array<[string, string[]]>
    expect(calls.some(([, args]) => args[1] === 'prune')).toBe(true)
  })
})

describe('reconcileHostImageGc', () => {
  it('sweeps immediately, then throttles to the interval', async () => {
    // The shared test setup isolates YAAC_K8S_NAMESPACE; simulate the
    // default install the reconcile is gated to.
    vi.stubEnv('YAAC_K8S_NAMESPACE', 'yaac')
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' })
    // A wall-clock-like base: the fresh throttle (lastSweepMs = 0) must
    // read as "long overdue" so the first server tick sweeps.
    const t0 = HOST_IMAGE_GC_INTERVAL_MS * 100
    await reconcileHostImageGc(t0)
    await reconcileHostImageGc(t0 + HOST_IMAGE_GC_INTERVAL_MS - 1)
    const lsCalls = (mockExecFileAsync.mock.calls as Array<[string, string[]]>)
      .filter(([, args]) => args[1] === 'ls')
    expect(lsCalls).toHaveLength(1)

    await reconcileHostImageGc(t0 + HOST_IMAGE_GC_INTERVAL_MS)
    const after = (mockExecFileAsync.mock.calls as Array<[string, string[]]>)
      .filter(([, args]) => args[1] === 'ls')
    expect(after).toHaveLength(2)
  })

  it('is a no-op on test-isolated installs (per-run namespaces)', async () => {
    vi.stubEnv('YAAC_K8S_NAMESPACE', 'yaac-test-abc123')
    // Long-overdue timestamp: only the namespace gate may skip here.
    await reconcileHostImageGc(HOST_IMAGE_GC_INTERVAL_MS * 100)
    expect(mockExecFileAsync).not.toHaveBeenCalled()
  })

  it('logs a summary only when something was reclaimed', async () => {
    vi.stubEnv('YAAC_K8S_NAMESPACE', 'yaac')
    mockExecFileAsync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'image' && args[1] === 'ls') {
        return Promise.resolve({ stdout: LS_OUTPUT, stderr: '' })
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    })
    const t0 = HOST_IMAGE_GC_INTERVAL_MS * 100
    await reconcileHostImageGc(t0)
    expect(mockServerLog).toHaveBeenCalledOnce()
    expect(mockServerLog.mock.calls[0][0]).toContain('retired 2 stale image tag(s)')

    mockServerLog.mockReset()
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' })
    await reconcileHostImageGc(t0 + HOST_IMAGE_GC_INTERVAL_MS)
    expect(mockServerLog).not.toHaveBeenCalled()
  })
})
