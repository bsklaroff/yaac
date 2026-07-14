import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createSettleGate,
  SETTLE_QUIET_MS,
  SETTLE_CAP_MS,
  SETTLE_FALLBACK_MS,
} from '#lib/attach-settle'

const TIMINGS = { quietMs: 100, capMs: 500, fallbackMs: 3000 }

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createSettleGate', () => {
  it('settles after a quiet gap once data has arrived', () => {
    const onSettle = vi.fn()
    const gate = createSettleGate(onSettle, { timings: TIMINGS })
    gate.onOpen()
    gate.onData()
    expect(gate.settled()).toBe(false)
    vi.advanceTimersByTime(TIMINGS.quietMs - 1)
    expect(onSettle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onSettle).toHaveBeenCalledTimes(1)
    expect(gate.settled()).toBe(true)
  })

  it('re-arms the quiet gap on every data chunk', () => {
    const onSettle = vi.fn()
    const gate = createSettleGate(onSettle, { timings: TIMINGS })
    gate.onOpen()
    gate.onData()
    vi.advanceTimersByTime(TIMINGS.quietMs - 1)
    gate.onData()
    vi.advanceTimersByTime(TIMINGS.quietMs - 1)
    expect(onSettle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onSettle).toHaveBeenCalledTimes(1)
  })

  it('caps a stream that never goes quiet at capMs after the first chunk', () => {
    const onSettle = vi.fn()
    const gate = createSettleGate(onSettle, { timings: TIMINGS })
    gate.onOpen()
    // Emit a chunk every quietMs-1 so the quiet gap never fires.
    let elapsed = 0
    gate.onData()
    while (elapsed < TIMINGS.capMs - 1) {
      const step = Math.min(TIMINGS.quietMs - 1, TIMINGS.capMs - 1 - elapsed)
      vi.advanceTimersByTime(step)
      elapsed += step
      gate.onData()
    }
    expect(onSettle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onSettle).toHaveBeenCalledTimes(1)
  })

  it('settles immediately on close after open (disconnect notice must show)', () => {
    const onSettle = vi.fn()
    const gate = createSettleGate(onSettle, { timings: TIMINGS })
    gate.onOpen()
    gate.onClose()
    expect(onSettle).toHaveBeenCalledTimes(1)
  })

  it('stays hidden on close before open (silent retry loop)', () => {
    const onSettle = vi.fn()
    const gate = createSettleGate(onSettle, { timings: TIMINGS })
    gate.onClose()
    vi.advanceTimersByTime(TIMINGS.fallbackMs)
    expect(onSettle).not.toHaveBeenCalled()
    expect(gate.settled()).toBe(false)
  })

  it('falls back to settling fallbackMs after open with no data', () => {
    const onSettle = vi.fn()
    const gate = createSettleGate(onSettle, { timings: TIMINGS })
    gate.onOpen()
    vi.advanceTimersByTime(TIMINGS.fallbackMs - 1)
    expect(onSettle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onSettle).toHaveBeenCalledTimes(1)
  })

  it('re-arms the fallback on reconnect opens before settle', () => {
    const onSettle = vi.fn()
    const gate = createSettleGate(onSettle, { timings: TIMINGS })
    gate.onOpen()
    vi.advanceTimersByTime(TIMINGS.fallbackMs - 1)
    gate.onOpen()
    vi.advanceTimersByTime(TIMINGS.fallbackMs - 1)
    expect(onSettle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onSettle).toHaveBeenCalledTimes(1)
  })

  it('settles exactly once across overlapping triggers', () => {
    const onSettle = vi.fn()
    const gate = createSettleGate(onSettle, { timings: TIMINGS })
    gate.onOpen()
    gate.onData()
    vi.advanceTimersByTime(TIMINGS.quietMs)
    expect(onSettle).toHaveBeenCalledTimes(1)
    // Later socket events and timers are no-ops.
    gate.onOpen()
    gate.onData()
    gate.onClose()
    vi.advanceTimersByTime(TIMINGS.fallbackMs)
    expect(onSettle).toHaveBeenCalledTimes(1)
  })

  it('dispose cancels pending timers without settling', () => {
    const onSettle = vi.fn()
    const gate = createSettleGate(onSettle, { timings: TIMINGS })
    gate.onOpen()
    gate.onData()
    gate.dispose()
    vi.advanceTimersByTime(TIMINGS.fallbackMs)
    expect(onSettle).not.toHaveBeenCalled()
  })

  it('defers a quiet-gap fire while the screen is blank, settles once content lands', () => {
    const onSettle = vi.fn()
    let content = false
    const gate = createSettleGate(onSettle, { hasContent: () => content, timings: TIMINGS })
    gate.onOpen()
    // Attach preamble only: quiet gap elapses with a blank screen — no reveal.
    gate.onData()
    vi.advanceTimersByTime(TIMINGS.quietMs)
    expect(onSettle).not.toHaveBeenCalled()
    // The agent's first paint arrives: the next quiet gap reveals.
    content = true
    gate.onData()
    vi.advanceTimersByTime(TIMINGS.quietMs)
    expect(onSettle).toHaveBeenCalledTimes(1)
  })

  it('defers the cap while blank but the fallback still reveals unconditionally', () => {
    const onSettle = vi.fn()
    const gate = createSettleGate(onSettle, { hasContent: () => false, timings: TIMINGS })
    gate.onOpen()
    gate.onData()
    vi.advanceTimersByTime(TIMINGS.capMs)
    expect(onSettle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(TIMINGS.fallbackMs - TIMINGS.capMs)
    expect(onSettle).toHaveBeenCalledTimes(1)
  })

  it('close-after-open reveals even with a blank screen (disconnect notice)', () => {
    const onSettle = vi.fn()
    const gate = createSettleGate(onSettle, { hasContent: () => false, timings: TIMINGS })
    gate.onOpen()
    gate.onData()
    gate.onClose()
    expect(onSettle).toHaveBeenCalledTimes(1)
  })

  it('uses the default timings when none are given', () => {
    const onSettle = vi.fn()
    const gate = createSettleGate(onSettle)
    gate.onOpen()
    gate.onData()
    vi.advanceTimersByTime(SETTLE_QUIET_MS)
    expect(onSettle).toHaveBeenCalledTimes(1)
    // Sanity: the exported policy orders quiet < cap < fallback.
    expect(SETTLE_QUIET_MS).toBeLessThan(SETTLE_CAP_MS)
    expect(SETTLE_CAP_MS).toBeLessThan(SETTLE_FALLBACK_MS)
  })
})
