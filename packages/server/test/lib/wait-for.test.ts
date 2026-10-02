import { describe, it, expect, vi, afterEach } from 'vitest'
import { waitFor } from '#lib/wait-for'

describe('waitFor', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves the first truthy result, probing once per interval', async () => {
    vi.useFakeTimers()
    const probe = vi.fn<() => Promise<string | undefined>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue('ready')
    const done = waitFor(probe, { timeoutMs: 10_000, intervalMs: 100 })
    await vi.advanceTimersByTimeAsync(200)
    await expect(done).resolves.toBe('ready')
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('resolves the falsy result at the deadline, having probed at least once', async () => {
    vi.useFakeTimers()
    const probe = vi.fn(() => Promise.resolve(false))
    const done = waitFor(probe, { timeoutMs: 250, intervalMs: 100 })
    await vi.advanceTimersByTimeAsync(300)
    await expect(done).resolves.toBe(false)
    expect(probe).toHaveBeenCalledTimes(4)

    probe.mockClear()
    await expect(waitFor(probe, { timeoutMs: 0, intervalMs: 100 })).resolves.toBe(false)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('ends the wait with a probe\'s error', async () => {
    await expect(waitFor(() => Promise.reject(new Error('gone')), { timeoutMs: 1_000, intervalMs: 10 }))
      .rejects.toThrow('gone')
  })
})
