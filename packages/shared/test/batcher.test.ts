/**
 * `createOutputBatcher`, the host-side copy used by the PTY bridge and the
 * webapp's keystroke path. `now` is injected and timers are faked, so a test
 * can state "8ms of quiet" exactly.
 *
 * The in-pod copy (dockerfiles/streamd/batcher.js) has its own tests over
 * Buffers; the two test files keep the copies from drifting apart.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createOutputBatcher, BATCH_MS, MAX_BATCH_CHARS } from '@yaac/shared/batcher'

/** A clock advanced in step with the fake timers, so `now()` and a fired
 *  timeout always agree. */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000
  return {
    now: () => t,
    advance: (ms) => {
      t += ms
      vi.advanceTimersByTime(ms)
    },
  }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('createOutputBatcher', () => {
  it('writes a chunk arriving after quiet immediately, then throttles the burst behind it', () => {
    const c = clock()
    const writes: string[] = []
    const b = createOutputBatcher((s) => writes.push(s), { now: c.now })

    // The first chunk after quiet goes out immediately, so keystroke echo
    // gets no added latency.
    b.push('a')
    expect(writes).toEqual(['a'])

    // Chunks inside the window become one write, in order.
    b.push('b')
    b.push('c')
    expect(writes).toEqual(['a'])
    c.advance(BATCH_MS)
    expect(writes).toEqual(['a', 'bc'])

    // A sustained burst settles into one write per window, not one per push.
    b.push('d')
    c.advance(1)
    b.push('e')
    expect(writes).toEqual(['a', 'bc'])
    c.advance(BATCH_MS)
    expect(writes).toEqual(['a', 'bc', 'de'])

    // …and once it goes quiet again, the next chunk is immediate once more.
    c.advance(BATCH_MS)
    b.push('f')
    expect(writes).toEqual(['a', 'bc', 'de', 'f'])
  })

  it('flushes at once when an accumulation reaches the size cap', () => {
    const c = clock()
    const writes: string[] = []
    const b = createOutputBatcher((s) => writes.push(s), { now: c.now, maxChars: 8 })

    b.push('12345') // leading edge, immediate
    expect(writes).toEqual(['12345'])
    b.push('678') // 3 of 8 accumulated
    expect(writes).toHaveLength(1)
    // Crossing the cap flushes immediately, bounding memory.
    b.push('90ab12')
    expect(writes).toEqual(['12345', '67890ab12'])

    // A single push larger than the cap passes through unsplit.
    c.advance(BATCH_MS)
    const big = 'x'.repeat(MAX_BATCH_CHARS + 5)
    b.push(big)
    expect(writes[2]).toBe(big)
  })

  it('flushes on demand as an ordering barrier', () => {
    const c = clock()
    const writes: string[] = []
    const b = createOutputBatcher((s) => writes.push(s), { now: c.now })

    b.push('first') // immediate
    b.push('pending')
    // The bridge flushes before closing the socket, so output from a program
    // that exits inside a batch window isn't lost.
    b.flush()
    expect(writes).toEqual(['first', 'pending'])

    // No empty frames.
    b.flush()
    expect(writes).toEqual(['first', 'pending'])
  })

  it('drops pending output and stops accepting more once disposed', () => {
    const c = clock()
    const writes: string[] = []
    const b = createOutputBatcher((s) => writes.push(s), { now: c.now })

    b.push('out') // immediate
    b.push('stranded')
    b.dispose()
    // Nothing may reach a closed socket, and the pending timer must not
    // outlive it.
    c.advance(BATCH_MS * 4)
    expect(writes).toEqual(['out'])

    b.push('after')
    c.advance(BATCH_MS * 4)
    expect(writes).toEqual(['out'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores empty chunks so they cannot start a window or write a frame', () => {
    const c = clock()
    const writes: string[] = []
    const b = createOutputBatcher((s) => writes.push(s), { now: c.now })

    b.push('')
    expect(writes).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    // Still counts as quiet, so the next real chunk is a leading edge.
    b.push('a')
    expect(writes).toEqual(['a'])
  })
})
