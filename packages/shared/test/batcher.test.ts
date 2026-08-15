/**
 * The output micro-batcher — `createOutputBatcher`.
 *
 * The policy is the whole point of the module, so the tests drive it through
 * real timers' worth of simulated clock: `now` is injected and the timer is
 * vitest's fake, which is what lets a test say "8ms of quiet" precisely.
 *
 * The in-pod mirror (dockerfiles/streamd/batcher.js) is gated by its own
 * tests over Buffers. These cover the host-side copy — the one the PTY
 * bridge and the webapp's keystroke path share — and the two files are what
 * keep the mirrors from drifting apart.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createOutputBatcher, BATCH_MS, MAX_BATCH_CHARS } from '@yaac/shared/batcher'

/** A clock the batcher reads and the tests advance in step with the fake
 *  timers, so `now()` and a fired timeout never disagree. */
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

    // Leading edge: the first chunk after quiet pays zero added latency —
    // this is what keeps keystroke echo (and a lone keypress going the other
    // way) as fast as it was before any batching existed.
    b.push('a')
    expect(writes).toEqual(['a'])

    // Everything inside the window accumulates into one write, in order,
    // instead of one write per event.
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
    // Crossing the cap flushes without waiting out the timer: a big transfer
    // must not sit in memory for a window, and memory stays bounded.
    b.push('90ab12')
    expect(writes).toEqual(['12345', '67890ab12'])

    // A single push larger than the cap passes through whole rather than
    // being split.
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
    // The bridge flushes before closing the socket so no output is stranded
    // behind the close — without this, the tail of a program's output would
    // be lost whenever it exited inside a batch window.
    b.flush()
    expect(writes).toEqual(['first', 'pending'])

    // Flushing an empty batcher writes nothing at all (no empty frames).
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
    // The stream is gone: the queued chunk must never reach a socket that
    // closed, and the pending timer must not outlive it either.
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
