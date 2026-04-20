import { describe, it, expect, vi } from 'vitest'
import { startBackgroundLoop } from '@/daemon/background-loop'

const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

describe('startBackgroundLoop', () => {
  it('runs an initial tick before any sleep', async () => {
    const step = vi.fn().mockResolvedValue(undefined)
    const abortCtrl = new AbortController()
    const sleep = vi.fn().mockImplementation((_ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
    )

    const done = startBackgroundLoop({
      signal: abortCtrl.signal,
      intervalMs: 1000,
      sleep,
      tickSteps: [step],
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(step).toHaveBeenCalledTimes(1)

    abortCtrl.abort()
    await done
  })

  it('ticks once per sleep cycle until the signal aborts', async () => {
    const step = vi.fn().mockResolvedValue(undefined)
    const abortCtrl = new AbortController()

    let sleepCount = 0
    const sleep = vi.fn().mockImplementation(() => {
      sleepCount++
      if (sleepCount >= 3) abortCtrl.abort()
      return Promise.resolve()
    })

    await startBackgroundLoop({
      signal: abortCtrl.signal,
      intervalMs: 1000,
      sleep,
      tickSteps: [step],
    })

    // Initial tick + 2 post-sleep ticks (sleep #3 aborts, loop breaks
    // before running a 4th tick).
    expect(step).toHaveBeenCalledTimes(3)
  })

  it('exits promptly when the signal aborts during sleep', async () => {
    const step = vi.fn().mockResolvedValue(undefined)
    const abortCtrl = new AbortController()
    const sleep = vi.fn().mockImplementation((_ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
    )

    const done = startBackgroundLoop({
      signal: abortCtrl.signal,
      intervalMs: 1000,
      sleep,
      tickSteps: [step],
    })

    await Promise.resolve()
    await Promise.resolve()
    abortCtrl.abort()
    await done

    expect(step).toHaveBeenCalledTimes(1)
  })

  it('isolates per-step failures — a throwing step does not skip later steps or halt the loop', async () => {
    const stepA = vi.fn().mockRejectedValue(new Error('boom'))
    const stepB = vi.fn().mockResolvedValue(undefined)
    const abortCtrl = new AbortController()
    consoleErrorSpy.mockClear()

    const sleep = vi.fn().mockImplementation(() => {
      abortCtrl.abort()
      return Promise.resolve()
    })

    await startBackgroundLoop({
      signal: abortCtrl.signal,
      intervalMs: 1000,
      sleep,
      tickSteps: [stepA, stepB],
    })

    expect(stepA).toHaveBeenCalledTimes(1)
    expect(stepB).toHaveBeenCalledTimes(1)
    expect(consoleErrorSpy).toHaveBeenCalled()
  })
})
