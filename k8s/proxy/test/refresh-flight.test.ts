import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { REFRESH_REUSE_MS, REFRESH_WAIT_MS, RefreshFlights } from 'yaac-proxy-sidecar/refresh-flight'

/** A rotation to `rotatedTo`, or a failure (null); `n` counts the spends. */
type Reply = { rotatedTo: string | null; n: number }
const TIMED_OUT: Reply = { rotatedTo: null, n: -1 }

/** A flight set whose upstream answers after `latencyMs`, counting spends.
 *  Each spend rotates to `rt<n>` unless told to fail. */
function setup(latencyMs = 10): {
  flights: RefreshFlights<Reply>
  spend: (opts?: { fail?: boolean }) => () => Promise<Reply>
  spent: () => number
} {
  let spent = 0
  const flights = new RefreshFlights<Reply>((r) => r.rotatedTo, () => TIMED_OUT)
  return {
    flights,
    spend: ({ fail = false } = {}) => () => {
      spent += 1
      const n = spent
      return new Promise((resolve) => setTimeout(() => { resolve({ rotatedTo: fail ? null : `rt${n}`, n }) }, latencyMs))
    },
    spent: () => spent,
  }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('RefreshFlights', () => {
  it('spends a credential once for a burst, reusing the rotation only while it is what is held', async () => {
    const { flights, spend, spent } = setup()
    // Two refreshes arriving together share the one in flight.
    const burst = Promise.all([flights.run('claude', 'rt0', spend()), flights.run('claude', 'rt0', spend())])
    await vi.advanceTimersByTimeAsync(10)
    const [a, b] = await burst
    expect(spent()).toBe(1)
    expect(b).toBe(a)
    // One arriving just after, holding what it rotated to, gets it back.
    await vi.advanceTimersByTimeAsync(REFRESH_REUSE_MS - 20)
    expect(await flights.run('claude', 'rt1', spend())).toBe(a)
    expect(spent()).toBe(1)
    // A different credential held — a sign-in to another account — spends.
    const relogin = flights.run('claude', 'other-account', spend())
    await vi.advanceTimersByTimeAsync(10)
    expect((await relogin).n).toBe(2)
    // A different tool is its own flight.
    const codex = flights.run('codex', 'rt0', spend())
    await vi.advanceTimersByTimeAsync(10)
    expect((await codex).n).toBe(3)
    // Past the window, a refresh reaches upstream again.
    await vi.advanceTimersByTimeAsync(REFRESH_REUSE_MS)
    const later = flights.run('claude', 'rt2', spend())
    await vi.advanceTimersByTimeAsync(10)
    expect((await later).n).toBe(4)
  })

  it('shares a failure with whoever joined it but never reuses it, and survives a rejected start', async () => {
    const { flights, spend, spent } = setup()
    const burst = Promise.all([
      flights.run('claude', 'rt0', spend({ fail: true })),
      flights.run('claude', 'rt0', spend()),
    ])
    await vi.advanceTimersByTimeAsync(10)
    const [a, b] = await burst
    expect(a.rotatedTo).toBeNull()
    expect(b).toBe(a)
    const retry = flights.run('claude', 'rt0', spend())
    await vi.advanceTimersByTimeAsync(10)
    expect((await retry).rotatedTo).toBe('rt2')
    expect(spent()).toBe(2)

    const rejected = flights.run('codex', 'rt0', () => Promise.reject(new Error('boom')))
    await expect(rejected).rejects.toThrow('boom')
    const after = flights.run('codex', 'rt0', spend())
    await vi.advanceTimersByTimeAsync(10)
    expect((await after).rotatedTo).toBe('rt3')
  })

  it('answers a slow flight\'s callers with the timeout reply but keeps it in flight until upstream settles', async () => {
    const { flights, spend, spent } = setup(REFRESH_WAIT_MS * 1.5)
    const first = flights.run('claude', 'rt0', spend())
    await vi.advanceTimersByTimeAsync(REFRESH_WAIT_MS)
    expect(await first).toBe(TIMED_OUT)
    // Still in flight: a refresh in the gap joins it rather than spending the
    // token upstream may already have rotated.
    const gap = flights.run('claude', 'rt0', spend())
    await vi.advanceTimersByTimeAsync(REFRESH_WAIT_MS / 2)
    expect(spent()).toBe(1)
    // Upstream answered while it waited: the late rotation is what it gets…
    expect((await gap).rotatedTo).toBe('rt1')
    // …and what the next one reuses.
    expect((await flights.run('claude', 'rt1', spend())).rotatedTo).toBe('rt1')
    expect(spent()).toBe(1)
  })
})
