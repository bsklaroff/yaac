import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createSettleGate,
  SETTLE_QUIET_MS as QUIET,
  SETTLE_CAP_MS as CAP,
  SETTLE_FALLBACK_MS as FALLBACK,
} from '#lib/attach-settle'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

const gateWith = (hasContent: () => boolean = () => true): {
  onSettle: ReturnType<typeof vi.fn>
  gate: ReturnType<typeof createSettleGate>
} => {
  const onSettle = vi.fn()
  return { onSettle, gate: createSettleGate(onSettle, hasContent) }
}

describe('createSettleGate', () => {
  it('settles after a quiet gap once data has arrived', () => {
    const { onSettle, gate } = gateWith()
    gate.onOpen()
    gate.onData()
    vi.advanceTimersByTime(QUIET - 1)
    expect(onSettle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onSettle).toHaveBeenCalledTimes(1)
  })

  it('re-arms the quiet gap on every data chunk', () => {
    const { onSettle, gate } = gateWith()
    gate.onOpen()
    gate.onData()
    vi.advanceTimersByTime(QUIET - 1)
    gate.onData()
    vi.advanceTimersByTime(QUIET - 1)
    expect(onSettle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onSettle).toHaveBeenCalledTimes(1)
  })

  it('caps a stream that never goes quiet at the cap after the first chunk', () => {
    const { onSettle, gate } = gateWith()
    gate.onOpen()
    // Emit a chunk every QUIET-1 so the quiet gap never fires.
    let elapsed = 0
    gate.onData()
    while (elapsed < CAP - 1) {
      const step = Math.min(QUIET - 1, CAP - 1 - elapsed)
      vi.advanceTimersByTime(step)
      elapsed += step
      gate.onData()
    }
    expect(onSettle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onSettle).toHaveBeenCalledTimes(1)
  })

  it('settles immediately on close after open (disconnect notice must show)', () => {
    const { onSettle, gate } = gateWith()
    gate.onOpen()
    gate.onClose()
    expect(onSettle).toHaveBeenCalledTimes(1)
  })

  it('stays hidden on close before open (silent retry loop)', () => {
    const { onSettle, gate } = gateWith()
    gate.onClose()
    vi.advanceTimersByTime(FALLBACK)
    expect(onSettle).not.toHaveBeenCalled()
  })

  it('falls back to settling after open with no data', () => {
    const { onSettle, gate } = gateWith()
    gate.onOpen()
    vi.advanceTimersByTime(FALLBACK - 1)
    expect(onSettle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onSettle).toHaveBeenCalledTimes(1)
  })

  it('re-arms the fallback on reconnect opens before settle', () => {
    const { onSettle, gate } = gateWith()
    gate.onOpen()
    vi.advanceTimersByTime(FALLBACK - 1)
    gate.onOpen()
    vi.advanceTimersByTime(FALLBACK - 1)
    expect(onSettle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onSettle).toHaveBeenCalledTimes(1)
  })

  it('settles exactly once across overlapping triggers', () => {
    const { onSettle, gate } = gateWith()
    gate.onOpen()
    gate.onData()
    vi.advanceTimersByTime(QUIET)
    expect(onSettle).toHaveBeenCalledTimes(1)
    // Later socket events and timers are no-ops.
    gate.onOpen()
    gate.onData()
    gate.onClose()
    vi.advanceTimersByTime(FALLBACK)
    expect(onSettle).toHaveBeenCalledTimes(1)
  })

  it('dispose cancels pending timers without settling', () => {
    const { onSettle, gate } = gateWith()
    gate.onOpen()
    gate.onData()
    gate.dispose()
    vi.advanceTimersByTime(FALLBACK)
    expect(onSettle).not.toHaveBeenCalled()
  })

  it('defers a quiet-gap fire while the screen is blank, settles once content lands', () => {
    let content = false
    const { onSettle, gate } = gateWith(() => content)
    gate.onOpen()
    // Only the attach preamble: the quiet gap passes on a blank screen, so
    // nothing is revealed.
    gate.onData()
    vi.advanceTimersByTime(QUIET)
    expect(onSettle).not.toHaveBeenCalled()
    // After the agent's first paint, the next quiet gap reveals.
    content = true
    gate.onData()
    vi.advanceTimersByTime(QUIET)
    expect(onSettle).toHaveBeenCalledTimes(1)
  })

  it('defers the cap while blank but the fallback still reveals unconditionally', () => {
    const { onSettle, gate } = gateWith(() => false)
    gate.onOpen()
    gate.onData()
    vi.advanceTimersByTime(CAP)
    expect(onSettle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(FALLBACK - CAP)
    expect(onSettle).toHaveBeenCalledTimes(1)
  })

  it('close-after-open reveals even with a blank screen (disconnect notice)', () => {
    const { onSettle, gate } = gateWith(() => false)
    gate.onOpen()
    gate.onData()
    gate.onClose()
    expect(onSettle).toHaveBeenCalledTimes(1)
  })
})
