/**
 * Output micro-batcher for `pty` streams: coalesces the child's many small
 * write bursts into fewer, larger data frames.
 *
 * A tmux redraw reaches node-pty as many small data events. Sending each as
 * its own frame makes the browser paint partial redraws, which splits the
 * hide-cursor/show-cursor pair and makes the cursor flash while scrolling.
 *
 * Policy:
 *  - a push after at least batchMs of quiet flushes immediately, so
 *    keystroke echo has no added latency;
 *  - pushes within batchMs of the last flush accumulate and flush when the
 *    window closes;
 *  - reaching maxBytes flushes at once.
 *
 * `packages/shared/src/batcher.ts` mirrors this module over strings for the
 * server and webapp. The image cannot import it, so change both together.
 */

/** One flush window: well under a 60Hz frame, but long enough to span one
 *  tmux redraw. */
const BATCH_MS = 8
/** Flush-at-once threshold. A flush can exceed it by one push, still far
 *  under the codec's 1MB frame cap. */
const MAX_BATCH_BYTES = 64 * 1024

export function createOutputBatcher(write, { batchMs = BATCH_MS, maxBytes = MAX_BATCH_BYTES, now = Date.now } = {}) {
  let pending = []
  let pendingBytes = 0
  let timer = null
  let lastFlushAt = -Infinity
  let disposed = false

  const flushNow = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (pendingBytes === 0) return
    const buf = pending.length === 1 ? pending[0] : Buffer.concat(pending)
    pending = []
    pendingBytes = 0
    lastFlushAt = now()
    write(buf)
  }

  return {
    push(buf) {
      // Drop empty pushes, matching the host-side mirror.
      if (disposed || buf.length === 0) return
      pending.push(buf)
      pendingBytes += buf.length
      if (pendingBytes >= maxBytes) {
        flushNow()
        return
      }
      if (timer !== null) return
      const sinceFlush = now() - lastFlushAt
      if (sinceFlush >= batchMs) {
        flushNow()
        return
      }
      timer = setTimeout(flushNow, batchMs - sinceFlush)
      if (typeof timer.unref === 'function') timer.unref()
    },
    /** Drain everything now (ordering barrier — e.g. before an exit frame). */
    flush: flushNow,
    /** Stop for good: drop pending output and any timer (stream closed). */
    dispose() {
      disposed = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      pending = []
      pendingBytes = 0
    },
  }
}
