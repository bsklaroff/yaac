import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { installFakeWorkspaceDriver } from '#test/support/fake-driver'
import { startUsageSampler, stopUsageSampler, usageHistory } from '#runtime/usage'
// State-reset hook and setup values.
import { MAX_POINTS, SAMPLE_MS, _resetUsageHistoryForTests } from '#runtime/usage/history'
import type { SubstrateUsage } from '#drivers/contract'
import type * as logModule from '#lib/log'

const mockLog = vi.hoisted(() => vi.fn())
vi.mock('#lib/log', async (importOriginal) => ({
  ...(await importOriginal<typeof logModule>()),
  serverLog: mockLog,
}))

const MINUTE = SAMPLE_MS
const ZERO = { cpuCores: 0, memoryBytes: 0, swapBytes: 0 }

/** A sample: `n` as every figure, so points can be told apart. */
function usage(n: number, opts: { workspaces?: string[]; nodeError?: boolean } = {}): SubstrateUsage {
  const use = { cpuCores: n, memoryBytes: n, swapBytes: n }
  return {
    totals: { ...use, cpuCapacityCores: 8, memoryCapacityBytes: 8, swapCapacityBytes: 0, disks: [] },
    nodes: [
      { name: 'node-a', role: 'both', ...use, cpuCapacityCores: 8, memoryCapacityBytes: 8, conditions: [], sampledAt: n },
      {
        name: 'node-b', role: 'workspaces', ...ZERO, cpuCapacityCores: 8, memoryCapacityBytes: 8,
        conditions: [], sampledAt: null, ...(opts.nodeError ? { error: 'forbidden' } : {}),
      },
    ],
    components: [{ key: 'server', label: 'yaac server', ...use, volumes: [] }],
    workspaces: Object.fromEntries((opts.workspaces ?? []).map((id) =>
      [id, { ...use, memoryLimitBytes: null, ephemeralStorageBytes: null }])),
  }
}

/** Install a driver answering each sample with the next of `samples`
 *  (the last repeats), and return its spy. */
function driverAnswering(samples: Array<SubstrateUsage | Error>) {
  let i = 0
  const resourceUsage = vi.fn(() => {
    const next = samples[Math.min(i++, samples.length - 1)]
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
  })
  installFakeWorkspaceDriver({ resourceUsage })
  return resourceUsage
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  _resetUsageHistoryForTests()
  mockLog.mockReset()
})

afterEach(() => {
  stopUsageSampler()
  vi.useRealTimers()
})

describe('startUsageSampler', () => {
  it('samples the cheap read at once and then every minute', async () => {
    const resourceUsage = driverAnswering([usage(1), usage(2), usage(3)])
    startUsageSampler()
    // A second start does not stack a second timer.
    startUsageSampler()
    await vi.waitFor(() => expect(usageHistory().totals).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(2 * MINUTE)
    expect(resourceUsage).toHaveBeenCalledTimes(3)
    expect(resourceUsage).toHaveBeenCalledWith({ full: false })
    expect(usageHistory().totals.map((p) => p.memoryBytes)).toEqual([1, 2, 3])
    expect(usageHistory().components.get('server')?.map((p) => p.cpuCores)).toEqual([1, 2, 3])
  })

  it('skips a tick while the previous sample is still running, rather than stacking reads', async () => {
    let finish = (): void => {}
    const resourceUsage = vi.fn()
      .mockImplementationOnce(() => new Promise<SubstrateUsage>((resolve) => { finish = () => resolve(usage(1)) }))
      .mockResolvedValue(usage(2))
    installFakeWorkspaceDriver({ resourceUsage })
    startUsageSampler()
    // A cluster too slow to answer within three ticks.
    await vi.advanceTimersByTimeAsync(3 * MINUTE)
    expect(resourceUsage).toHaveBeenCalledTimes(1)
    finish()
    await vi.waitFor(() => expect(usageHistory().totals).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(resourceUsage).toHaveBeenCalledTimes(2)
  })

  it('logs a failing read once, and again only when the failure changes', async () => {
    driverAnswering([new Error('apiserver down'), new Error('apiserver down'), new Error('forbidden'), usage(1)])
    startUsageSampler()
    await vi.advanceTimersByTimeAsync(3 * MINUTE)
    expect(mockLog.mock.calls.map(([line]) => String(line))).toEqual([
      expect.stringContaining('apiserver down'),
      expect.stringContaining('forbidden'),
    ])
    // The sampler kept going and recorded the read that worked.
    expect(usageHistory().totals).toHaveLength(1)
  })
})

describe('stopUsageSampler', () => {
  it('takes no more samples', async () => {
    const resourceUsage = driverAnswering([usage(1)])
    startUsageSampler()
    await vi.waitFor(() => expect(resourceUsage).toHaveBeenCalledTimes(1))
    stopUsageSampler()
    await vi.advanceTimersByTimeAsync(5 * MINUTE)
    expect(resourceUsage).toHaveBeenCalledTimes(1)
  })
})

describe('usageHistory', () => {
  it('keeps an hour per series, a stopped workspace\'s until its last point is an hour old', async () => {
    // `gone` runs for the first two samples, then stops.
    driverAnswering([
      usage(0, { workspaces: ['kept', 'gone'] }),
      usage(1, { workspaces: ['kept', 'gone'] }),
      usage(2, { workspaces: ['kept'] }),
    ])
    startUsageSampler()
    await vi.waitFor(() => expect(usageHistory().totals).toHaveLength(1))

    await vi.advanceTimersByTimeAsync(MAX_POINTS * MINUTE)
    // An hour on, the stopped workspace still shows what it did.
    expect(usageHistory().workspaces.get('gone')?.map((p) => p.memoryBytes)).toEqual([0, 1])
    expect(usageHistory().totals).toHaveLength(MAX_POINTS)
    expect(usageHistory().totals[0].memoryBytes).toBe(1)

    // Its newest point is now more than an hour old.
    await vi.advanceTimersByTimeAsync(2 * MINUTE)
    expect(usageHistory().workspaces.has('gone')).toBe(false)
    expect(usageHistory().workspaces.get('kept')).toHaveLength(MAX_POINTS)
  })

  it('records no point for what was not measured: a missing node, and the totals and components it would skew', async () => {
    const resourceUsage = driverAnswering([
      usage(1, { workspaces: ['ws'], nodeError: true }),
      usage(2, { workspaces: ['ws'] }),
    ])
    startUsageSampler()
    await vi.waitFor(() => expect(resourceUsage).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(usageHistory().nodes.get('node-a')).toHaveLength(1))
    expect(usageHistory().nodes.has('node-b')).toBe(false)
    expect(usageHistory().totals).toEqual([])
    expect(usageHistory().components.size).toBe(0)
    expect(usageHistory().workspaces.get('ws')).toHaveLength(1)

    // Once every node answers, everything is recorded again.
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(usageHistory().totals.map((p) => p.memoryBytes)).toEqual([2])
    expect(usageHistory().components.get('server')).toHaveLength(1)
  })
})
